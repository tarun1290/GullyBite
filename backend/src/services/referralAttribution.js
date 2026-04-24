// src/services/referralAttribution.js
// Referral Attribution Service — centralized conflict resolution, commission tracking, reporting.
// Policy: LATEST VALID REFERRAL WINS. Expired/superseded referrals are clearly marked.
// Commission states: pending → confirmed → reversed.

'use strict';

const { col, newId, mapId, mapIds } = require('../config/database');
const { calculateAttributionWindow } = require('../utils/referralWindow');
const log = require('../utils/logger').child({ component: 'Referral' });

const COMMISSION_PCT = 7.5;

// ─── REFERRAL STATUSES ──────────────────────────────────────
// active:      within attribution window, not yet converted
// converted:   order placed and attributed
// expired:     attribution window passed without conversion
// superseded:  replaced by a newer referral for same customer+restaurant
// reversed:    order was cancelled/refunded after conversion

// ─── COMMISSION STATUSES ────────────────────────────────────
// pending:     order attributed, awaiting payment confirmation
// confirmed:   payment confirmed, commission valid
// reversed:    order cancelled/refunded, commission reversed
// settled:     included in a settlement payout

// ─── CREATE REFERRAL (unified) ──────────────────────────────
/**
 * Create or refresh a referral attribution record.
 * Supersedes any existing active referrals for the same customer+restaurant.
 *
 * @param {object} params
 * @returns {object} - The created/updated referral document
 */
async function createReferral({ restaurantId, customerPhone, customerBsuid, customerName, source, referralCode, referralLinkId, notes }) {
  const now = new Date();
  const { windowHours, expiresAt, isLateNight } = calculateAttributionWindow(now);

  // Supersede ALL existing active referrals for this customer+restaurant (regardless of source)
  const superseded = await col('referrals').updateMany(
    { restaurant_id: restaurantId, customer_wa_phone: customerPhone, status: 'active' },
    { $set: { status: 'superseded', superseded_at: now, superseded_by_source: source, updated_at: now } }
  );
  if (superseded.modifiedCount > 0) {
    log.info({ superseded: superseded.modifiedCount, phone: customerPhone?.slice(-4), restaurantId }, 'Superseded active referrals');
  }

  const referral = {
    _id: newId(),
    restaurant_id: restaurantId,
    customer_wa_phone: customerPhone,
    customer_bsuid: customerBsuid || null,
    customer_name: customerName || null,
    source, // 'gbref' | 'directory' | 'admin'
    referral_code: referralCode || null,
    referral_link_id: referralLinkId || null,
    status: 'active',
    referral_link_sent_at: now,
    attribution_window_hours: windowHours,
    is_late_night_referral: isLateNight,
    commission_percent: COMMISSION_PCT,
    expires_at: expiresAt,
    // Attribution tracking
    attributed_order_id: null,
    attributed_order_subtotal: null,
    commission_amount: null,
    commission_status: null, // null until converted, then 'pending' → 'confirmed' → 'reversed'/'settled'
    // Aggregates (for multi-order within window)
    orders_count: 0,
    total_order_value_rs: 0,
    referral_fee_rs: 0,
    // Metadata
    notes: notes || null,
    superseded_by_source: null,
    superseded_at: null,
    reversal_reason: null,
    settled_at: null,
    created_at: now,
    updated_at: now,
  };

  await col('referrals').insertOne(referral);
  log.info({ source, phone: customerPhone?.slice(-4), restaurantId, windowHours, expiresAt: expiresAt.toISOString() }, 'Referral created');
  return referral;
}

// ─── REFRESH REFERRAL (GBREF re-click) ──────────────────────
/**
 * Refresh an existing active referral window, or create new if none exists.
 * Used when GBREF code is detected in a message.
 */
async function refreshOrCreateReferral(params) {
  const { restaurantId, customerPhone } = params;
  const now = new Date();
  const { windowHours, expiresAt, isLateNight } = calculateAttributionWindow(now);

  // Try to refresh existing active referral
  const existing = await col('referrals').findOneAndUpdate(
    { customer_wa_phone: customerPhone, restaurant_id: restaurantId, status: 'active', expires_at: { $gt: now } },
    { $set: {
      expires_at: expiresAt,
      attribution_window_hours: windowHours,
      is_late_night_referral: isLateNight,
      referral_code: params.referralCode,
      updated_at: now,
    }},
    { returnDocument: 'after' }
  );

  if (existing) {
    log.info({ phone: customerPhone?.slice(-4), restaurantId, windowHours }, 'Refreshed referral window');
    return existing;
  }

  // No active referral — create new (with supersession)
  return createReferral(params);
}

// ─── ATTRIBUTE ORDER ────────────────────────────────────────
/**
 * Called after order creation to attribute commission.
 * Records commission as 'pending' until payment is confirmed.
 */
async function attributeOrder(orderId, orderSubtotal, referralId) {
  const commissionAmount = parseFloat((orderSubtotal * COMMISSION_PCT / 100).toFixed(2));

  await col('referrals').updateOne(
    { _id: referralId },
    {
      $set: {
        status: 'converted',
        attributed_order_id: orderId,
        attributed_order_subtotal: orderSubtotal,
        commission_amount: commissionAmount,
        commission_status: 'pending',
        updated_at: new Date(),
      },
      $inc: {
        orders_count: 1,
        total_order_value_rs: orderSubtotal,
        referral_fee_rs: commissionAmount,
      },
    }
  );
  log.info({ orderId, subtotalRs: orderSubtotal, commissionRs: commissionAmount }, 'Order attributed');
}

// ─── CONFIRM COMMISSION (after payment) ─────────────────────
// Flips the referral row pending → confirmed AND writes two ledger debits
// (commission + 18% GST on commission) so the merchant's payable balance
// reflects what the platform is owed for the GBREF. The debits are
// idempotent via refId '<order_id>:referral' and '<order_id>:referral:gst'
// — duplicate confirmations are no-ops at the unique index.
async function confirmCommission(orderId) {
  // Read the referral first so we have commission_amount + restaurant_id
  // for the ledger writes. updateMany is preserved for safety in case
  // multiple pending rows ever exist for one order, but findOne is
  // sufficient for the ledger debit: there should be exactly one
  // commission per attributed order.
  const referral = await col('referrals').findOne({
    attributed_order_id: orderId,
    commission_status: 'pending',
  });

  await col('referrals').updateMany(
    { attributed_order_id: orderId, commission_status: 'pending' },
    { $set: { commission_status: 'confirmed', updated_at: new Date() } }
  );

  // No referral on this order = non-GBREF order. Correct behaviour: no debit.
  if (!referral || !referral.restaurant_id) return;

  const { FINANCE_CONFIG } = require('../config/financeConfig');
  const ledger = require('./ledger.service');
  const commissionPaise = Math.round((referral.commission_amount || 0) * 100);
  const gstPaise = Math.round(commissionPaise * (FINANCE_CONFIG.gstReferralFeePct / 100));

  if (commissionPaise <= 0) return; // 0% commission or missing amount → nothing to debit

  // Fire-and-forget — commission confirmation must NEVER fail because of a
  // ledger write blip. Errors are logged for ops reconciliation.
  Promise.all([
    ledger.debit({
      restaurantId: referral.restaurant_id,
      amountPaise: commissionPaise,
      refType: 'referral',
      refId: `${orderId}:referral`,
      status: 'completed',
      notes: `GBREF commission ${COMMISSION_PCT}% on order ${orderId}`,
    }),
    gstPaise > 0 ? ledger.debit({
      restaurantId: referral.restaurant_id,
      amountPaise: gstPaise,
      refType: 'referral_fee_gst',
      refId: `${orderId}:referral:gst`,
      status: 'completed',
      notes: `GST ${FINANCE_CONFIG.gstReferralFeePct}% on GBREF commission`,
    }) : Promise.resolve(),
  ]).catch(err => log.error({ err, orderId }, 'confirmCommission.ledger_debit_failed'));
}

// ─── REVERSE COMMISSION (cancellation/refund) ───────────────
// Symmetric to confirmCommission: flips the referral row to reversed AND,
// if the commission had already been confirmed (i.e. ledger debits were
// written), posts compensating credits to restore the merchant's balance.
// Uses ':reversal' refId suffix so the unique index makes replays safe.
async function reverseCommission(orderId, reason = 'order_cancelled') {
  const referral = await col('referrals').findOne({ attributed_order_id: orderId, status: 'converted' });
  if (!referral) return;

  const reverseAmount = referral.commission_amount || 0;
  // Snapshot the commission_status BEFORE the updateOne flips it — we need
  // to know whether ledger debits were ever written for this referral.
  const wasConfirmed = referral.commission_status === 'confirmed';

  await col('referrals').updateOne(
    { _id: referral._id },
    {
      $set: {
        commission_status: 'reversed',
        reversal_reason: reason,
        updated_at: new Date(),
      },
      $inc: {
        referral_fee_rs: -reverseAmount,
        total_order_value_rs: -(referral.attributed_order_subtotal || 0),
        orders_count: -1,
      },
    }
  );
  log.info({ orderId, reversedRs: reverseAmount, reason }, 'Commission reversed');

  // Also update the order's referral_fee_rs to 0
  await col('orders').updateOne(
    { _id: orderId },
    { $set: { referral_fee_rs: 0, referral_reversed: true, referral_reversal_reason: reason } }
  );

  // Only write reversal credits if the original confirmation actually wrote
  // ledger debits. A 'pending' commission was never debited (debits are
  // written by confirmCommission), so no compensating credit is needed.
  if (!wasConfirmed || !referral.restaurant_id) return;

  const { FINANCE_CONFIG } = require('../config/financeConfig');
  const ledger = require('./ledger.service');
  const commissionPaise = Math.round(reverseAmount * 100);
  const gstPaise = Math.round(commissionPaise * (FINANCE_CONFIG.gstReferralFeePct / 100));

  if (commissionPaise <= 0) return;

  Promise.all([
    ledger.credit({
      restaurantId: referral.restaurant_id,
      amountPaise: commissionPaise,
      refType: 'referral',
      refId: `${orderId}:referral:reversal`,
      status: 'completed',
      notes: `GBREF commission reversal — ${reason}`,
    }),
    gstPaise > 0 ? ledger.credit({
      restaurantId: referral.restaurant_id,
      amountPaise: gstPaise,
      refType: 'referral_fee_gst',
      refId: `${orderId}:referral:gst:reversal`,
      status: 'completed',
      notes: `GST reversal on GBREF commission — ${reason}`,
    }) : Promise.resolve(),
  ]).catch(err => log.error({ err, orderId }, 'reverseCommission.ledger_credit_failed'));
}

// ─── PAYOUT REPORTING ───────────────────────────────────────
/**
 * Commission summary for a date range, optionally filtered by restaurant.
 */
async function getCommissionReport({ from, to, restaurantId } = {}) {
  const match = {};
  if (from || to) {
    match.created_at = {};
    if (from) match.created_at.$gte = new Date(from);
    if (to) match.created_at.$lte = new Date(to);
  }
  if (restaurantId) match.restaurant_id = restaurantId;

  const all = await col('referrals').find(match).toArray();

  const byStatus = { active: 0, converted: 0, expired: 0, superseded: 0, reversed: 0 };
  const commission = { pending: 0, confirmed: 0, reversed: 0, settled: 0, total: 0 };
  let totalSubtotal = 0;
  let totalOrders = 0;

  for (const r of all) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    if (r.commission_status) commission[r.commission_status] = (commission[r.commission_status] || 0) + (r.commission_amount || 0);
    if (r.status === 'converted') {
      totalSubtotal += r.attributed_order_subtotal || 0;
      totalOrders += r.orders_count || 0;
      commission.total += r.commission_amount || 0;
    }
  }

  return {
    total_referrals: all.length,
    by_status: byStatus,
    total_attributed_orders: totalOrders,
    total_attributed_subtotal: Math.round(totalSubtotal * 100) / 100,
    commission: {
      pending: Math.round(commission.pending * 100) / 100,
      confirmed: Math.round(commission.confirmed * 100) / 100,
      reversed: Math.round(commission.reversed * 100) / 100,
      settled: Math.round(commission.settled * 100) / 100,
      net_total: Math.round((commission.confirmed + commission.pending) * 100) / 100,
    },
    commission_percent: COMMISSION_PCT,
  };
}

/**
 * Conflict audit — show overlapping/superseded referrals for a customer.
 */
async function getConflictAudit(customerPhone, restaurantId) {
  const referrals = await col('referrals').find({
    customer_wa_phone: customerPhone,
    ...(restaurantId ? { restaurant_id: restaurantId } : {}),
  }).sort({ created_at: -1 }).toArray();

  return mapIds(referrals).map(r => ({
    id: r.id,
    status: r.status,
    source: r.source,
    created_at: r.created_at,
    expires_at: r.expires_at,
    attribution_window_hours: r.attribution_window_hours,
    commission_status: r.commission_status,
    commission_amount: r.commission_amount,
    superseded_at: r.superseded_at,
    superseded_by_source: r.superseded_by_source,
    attributed_order_id: r.attributed_order_id,
  }));
}

module.exports = {
  createReferral,
  refreshOrCreateReferral,
  attributeOrder,
  confirmCommission,
  reverseCommission,
  getCommissionReport,
  getConflictAudit,
  COMMISSION_PCT,
};
