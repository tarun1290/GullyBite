// src/services/payoutEngine.js
// ════════════════════════════════════════════════════════════════
// DEPRECATED: use settlement.service.js. This file is retained
// until order_settlements collection is confirmed empty in
// production. Do not add new callers.
//
// Current live callers (as of 2026-04-15) — migrate before removal:
//   • queue/postPaymentJobs.js  — createSettlementForOrder + processSettlement
//   • webhooks/razorpay.js      — handlePayoutWebhook
//   • routes/admin.js           — retryFailedSettlement / retryAllFailedSettlements / processSettlement
//   • routes/cron.js            — retryAllFailedSettlements (payout-retry cron)
//   • jobs/recovery.js          — calls payoutEngine.retryPayout (broken — not exported)
//
// Authoritative settlement engine: src/services/settlement.service.js
// (balance-based, writes to `settlements` collection).
// ════════════════════════════════════════════════════════════════
// PER-ORDER SETTLEMENT + PAYOUT ENGINE (v2)
// ════════════════════════════════════════════════════════════════
// Production-grade, multi-tenant safe, idempotent payout pipeline.
//
// LIFECYCLE:
//   ORDER DELIVERED
//      → createSettlementForOrder()  → order_settlements (status: 'eligible')
//      → processSettlement()         → payouts (Razorpay payout created)
//      → webhook payout.processed    → settlement: 'paid', payout: 'processed'
//      → webhook payout.failed       → settlement: 'failed', payout: 'failed' (retryable)
//      → webhook payout.reversed     → settlement: 'reversed', payout: 'reversed'
//
// SAFETY GUARANTEES:
//   1. UNIQUE constraint on order_settlements.order_id → no duplicate settlements
//   2. UNIQUE constraint on payouts.razorpay_payout_id → no duplicate payout records
//   3. UNIQUE constraint on payouts.idempotency_key → no duplicate Razorpay calls
//   4. Webhook event dedup via razorpay_webhook_events.event_id
//   5. Payout always derived from order.restaurant_id (NEVER session/admin context)
//   6. Restaurant must have payout_enabled=true and razorpay_fund_acct_id

'use strict';

const crypto = require('crypto');
const { col, newId } = require('../config/database');
const { computeSettlement, round2 } = require('../core/financialEngine');
const paymentSvc = require('./payment');
const { logActivity } = require('./activityLog');
const log = require('../utils/logger').child({ component: 'payoutEngine' });

// ─── SETTLEMENT STATES ────────────────────────────────────────
const SETTLEMENT_STATES = {
  PENDING:    'pending',     // Created but not yet eligible (e.g., order not delivered)
  ELIGIBLE:   'eligible',    // Ready for payout
  PROCESSING: 'processing',  // Razorpay payout API call in progress
  PAID:       'paid',        // Webhook confirmed payout success
  FAILED:     'failed',      // Payout attempt failed (retryable)
  REVERSED:   'reversed',    // Razorpay reversed the payout
};

const PAYOUT_STATES = {
  INITIATED:  'initiated',   // Payout record created, Razorpay call about to fire
  PROCESSING: 'processing',  // Razorpay accepted, awaiting webhook
  PROCESSED:  'processed',   // Webhook confirmed success
  FAILED:     'failed',      // Razorpay or webhook reported failure
  REVERSED:   'reversed',    // Razorpay reversed (post-success)
};

// ════════════════════════════════════════════════════════════════
// 1. CREATE SETTLEMENT FOR ORDER
// ════════════════════════════════════════════════════════════════
// Called when an order transitions to DELIVERED.
// Idempotent — relies on unique constraint on order_id.

const createSettlementForOrder = async (orderId) => {
  const order = await col('orders').findOne({ _id: orderId });
  if (!order) throw new Error(`Order ${orderId} not found`);

  // CRITICAL: derive restaurant_id from ORDER, not session/admin
  const restaurantId = order.restaurant_id;
  if (!restaurantId) {
    log.error({ orderId }, 'Order has no restaurant_id — cannot create settlement');
    throw new Error('Order missing restaurant_id');
  }

  // Order must be DELIVERED and PAID
  if (order.status !== 'DELIVERED') {
    log.warn({ orderId, status: order.status }, 'Order not DELIVERED — skipping settlement');
    return null;
  }

  // Check payment was actually received
  const payment = await col('payments').findOne({ order_id: orderId, status: 'paid' });
  if (!payment && order.payment_type !== 'cod') {
    log.warn({ orderId }, 'No paid payment record for order — skipping settlement');
    return null;
  }

  const restaurant = await col('restaurants').findOne({ _id: restaurantId });
  if (!restaurant) throw new Error(`Restaurant ${restaurantId} not found`);

  // Compute deterministic settlement amounts
  const calc = computeSettlement(order, restaurant);

  const settlementId = newId();
  const now = new Date();
  const settlement = {
    _id: settlementId,
    order_id: orderId,                      // UNIQUE INDEX → idempotency
    order_number: order.order_number,
    restaurant_id: restaurantId,            // ALWAYS from order
    branch_id: order.branch_id,
    // Computation results
    gross_amount: calc.grossAmount,
    platform_fee: calc.platformFee,
    platform_fee_gst: calc.platformFeeGst,
    gateway_fee: calc.gatewayFee,
    gateway_fee_pct: calc.gatewayFeePct,
    rest_delivery_rs: calc.restDeliveryRs,
    rest_delivery_gst: calc.restDeliveryGst,
    referral_fee: calc.referralFee,
    referral_fee_gst: calc.referralFeeGst,
    net_amount: calc.netAmount,
    commission_rate_pct: calc.commissionRatePct,
    is_first_billing_month: calc.isFirstBillingMonth,
    // Status
    status: SETTLEMENT_STATES.ELIGIBLE,
    payout_id: null,
    failure_reason: null,
    retry_count: 0,
    // Audit
    created_at: now,
    updated_at: now,
  };

  try {
    await col('order_settlements').insertOne(settlement);
  } catch (err) {
    if (err.code === 11000) {
      // Duplicate key — settlement already exists for this order. Idempotent success.
      log.info({ orderId }, 'Settlement already exists for order — idempotent skip');
      return await col('order_settlements').findOne({ order_id: orderId });
    }
    throw err;
  }

  log.info({ settlementId, orderId, restaurantId, netAmount: calc.netAmount }, 'Settlement created');

  logActivity({
    actorType: 'system', actorId: null, actorName: 'Payout Engine',
    action: 'order_settlement.created', category: 'billing',
    description: `Settlement for order ${order.order_number}: net ₹${calc.netAmount.toFixed(2)}`,
    restaurantId, resourceType: 'order_settlement', resourceId: settlementId, severity: 'info',
    metadata: { order_id: orderId, gross: calc.grossAmount, net: calc.netAmount },
  });

  return settlement;
};

// ════════════════════════════════════════════════════════════════
// 2. PROCESS SETTLEMENT (initiate Razorpay payout)
// ════════════════════════════════════════════════════════════════
// Idempotent. Multiple calls for the same settlement are safe.

const processSettlement = async (settlementId) => {
  // 1. Fetch settlement
  const settlement = await col('order_settlements').findOne({ _id: settlementId });
  if (!settlement) throw new Error(`Settlement ${settlementId} not found`);

  // 2. Validate state
  if (settlement.status !== SETTLEMENT_STATES.ELIGIBLE && settlement.status !== SETTLEMENT_STATES.FAILED) {
    log.info({ settlementId, status: settlement.status }, 'Settlement not in eligible/failed state — skip');
    return { skipped: true, reason: `status=${settlement.status}` };
  }

  // 3. Validate net amount > 0
  if (settlement.net_amount <= 0) {
    log.warn({ settlementId, netAmount: settlement.net_amount }, 'Net amount <= 0 — marking as paid (no payout needed)');
    await col('order_settlements').updateOne(
      { _id: settlementId },
      { $set: { status: SETTLEMENT_STATES.PAID, updated_at: new Date(), failure_reason: 'zero_payout' } }
    );
    return { skipped: true, reason: 'zero_payout' };
  }

  // 4. Fetch restaurant — derive ALWAYS from settlement.restaurant_id
  const restaurant = await col('restaurants').findOne({ _id: settlement.restaurant_id });
  if (!restaurant) throw new Error(`Restaurant ${settlement.restaurant_id} not found`);

  // 5. Validate fund account
  if (!restaurant.razorpay_fund_acct_id) {
    log.warn({ settlementId, restaurantId: settlement.restaurant_id }, 'Restaurant has no fund account — cannot payout');
    await col('order_settlements').updateOne(
      { _id: settlementId },
      { $set: { status: SETTLEMENT_STATES.FAILED, failure_reason: 'no_fund_account', updated_at: new Date() } }
    );
    return { skipped: true, reason: 'no_fund_account' };
  }
  if (restaurant.payout_enabled === false) {
    log.warn({ settlementId, restaurantId: settlement.restaurant_id }, 'Payout disabled for restaurant');
    return { skipped: true, reason: 'payout_disabled' };
  }

  // 6. Check if payout already exists for this settlement (idempotency guard)
  const existingPayout = await col('payouts').findOne({ settlement_id: settlementId });
  if (existingPayout) {
    log.info({ settlementId, payoutId: existingPayout._id }, 'Payout already exists for settlement — idempotent skip');
    return { skipped: true, reason: 'payout_exists', payoutId: existingPayout._id };
  }

  // 7. Generate idempotency key (deterministic per settlement + retry attempt)
  const retryCount = (settlement.retry_count || 0);
  const idempotencyKey = generateIdempotencyKey(settlementId, retryCount);

  // 8. Atomic state transition: ELIGIBLE/FAILED → PROCESSING (with state guard)
  const claimed = await col('order_settlements').findOneAndUpdate(
    { _id: settlementId, status: { $in: [SETTLEMENT_STATES.ELIGIBLE, SETTLEMENT_STATES.FAILED] } },
    { $set: { status: SETTLEMENT_STATES.PROCESSING, updated_at: new Date() }, $inc: { retry_count: 1 } },
    { returnDocument: 'after' }
  );
  if (!claimed) {
    log.info({ settlementId }, 'Could not claim settlement (concurrent update?)');
    return { skipped: true, reason: 'concurrent_update' };
  }

  // 9. Pre-create payout record (so webhook can find it even if API call hangs)
  const payoutId = newId();
  const now = new Date();
  await col('payouts').insertOne({
    _id: payoutId,
    settlement_id: settlementId,
    restaurant_id: settlement.restaurant_id,        // ALWAYS from settlement, never elsewhere
    fund_account_id: restaurant.razorpay_fund_acct_id,
    amount_rs: settlement.net_amount,
    razorpay_payout_id: null,
    status: PAYOUT_STATES.INITIATED,
    failure_reason: null,
    webhook_synced: false,
    idempotency_key: idempotencyKey,
    retry_count: retryCount,
    created_at: now,
    updated_at: now,
  });

  // 10. Call Razorpay payout API
  let rpPayout;
  try {
    rpPayout = await paymentSvc.createPayoutV2({
      fundAccountId: restaurant.razorpay_fund_acct_id,
      amountRs: settlement.net_amount,
      idempotencyKey,
      referenceId: settlementId,
      narration: `GB-${settlement.order_number}`,
    });
  } catch (err) {
    log.error({ err, settlementId }, 'Razorpay payout API failed');
    await col('payouts').updateOne(
      { _id: payoutId },
      { $set: { status: PAYOUT_STATES.FAILED, failure_reason: err.message, updated_at: new Date() } }
    );
    await col('order_settlements').updateOne(
      { _id: settlementId },
      { $set: { status: SETTLEMENT_STATES.FAILED, failure_reason: err.message, updated_at: new Date() } }
    );
    logActivity({
      actorType: 'system', actorName: 'Payout Engine',
      action: 'payout.api_failed', category: 'billing',
      description: `Razorpay payout API failed for settlement ${settlementId}: ${err.message}`,
      restaurantId: settlement.restaurant_id, resourceType: 'order_settlement',
      resourceId: settlementId, severity: 'error',
      metadata: { error: err.message, amount: settlement.net_amount },
    });
    return { success: false, reason: 'razorpay_api_error', error: err.message };
  }

  // 11. Update payout + settlement with Razorpay payout ID
  await col('payouts').updateOne(
    { _id: payoutId },
    { $set: {
      razorpay_payout_id: rpPayout.id,
      status: PAYOUT_STATES.PROCESSING,
      updated_at: new Date(),
    }}
  );
  await col('order_settlements').updateOne(
    { _id: settlementId },
    { $set: { payout_id: payoutId, updated_at: new Date() } }
  );

  log.info({ settlementId, payoutId, rpPayoutId: rpPayout.id, amount: settlement.net_amount }, 'Payout initiated');

  logActivity({
    actorType: 'system', actorName: 'Payout Engine',
    action: 'payout.initiated', category: 'billing',
    description: `Payout ₹${settlement.net_amount.toFixed(2)} initiated for order ${settlement.order_number}`,
    restaurantId: settlement.restaurant_id, resourceType: 'payout', resourceId: payoutId, severity: 'info',
    metadata: { rp_payout_id: rpPayout.id, settlement_id: settlementId },
  });

  return { success: true, payoutId, rpPayoutId: rpPayout.id };
};

// ════════════════════════════════════════════════════════════════
// 3. WEBHOOK HANDLERS (called by razorpay.js webhook router)
// ════════════════════════════════════════════════════════════════

const handlePayoutWebhook = async (eventId, eventType, payoutEntity) => {
  // 1. Dedupe via webhook event ID
  if (eventId) {
    try {
      await col('razorpay_webhook_events').insertOne({
        _id: newId(),
        event_id: eventId,
        type: eventType,
        payload: payoutEntity,
        processed: false,
        created_at: new Date(),
      });
    } catch (err) {
      if (err.code === 11000) {
        log.info({ eventId, eventType }, 'Webhook event already processed — duplicate skip');
        return { duplicate: true };
      }
      throw err;
    }
  }

  if (!payoutEntity?.id) {
    log.warn({ eventType }, 'Webhook missing payout entity ID');
    return { error: 'no_payout_id' };
  }

  // 2. Find payout record by Razorpay payout ID
  const payout = await col('payouts').findOne({ razorpay_payout_id: payoutEntity.id });
  if (!payout) {
    // Could be a legacy weekly settlement payout — let the legacy handler deal with it
    log.info({ rpPayoutId: payoutEntity.id }, 'No order_settlement payout found — likely legacy weekly');
    return { legacy: true };
  }

  // 3. Update payout + settlement based on event type
  let newPayoutStatus, newSettlementStatus, failureReason = null;
  switch (eventType) {
    case 'payout.processed':
      newPayoutStatus = PAYOUT_STATES.PROCESSED;
      newSettlementStatus = SETTLEMENT_STATES.PAID;
      break;
    case 'payout.failed':
      newPayoutStatus = PAYOUT_STATES.FAILED;
      newSettlementStatus = SETTLEMENT_STATES.FAILED;
      failureReason = payoutEntity.failure_reason || 'unknown';
      break;
    case 'payout.reversed':
      newPayoutStatus = PAYOUT_STATES.REVERSED;
      newSettlementStatus = SETTLEMENT_STATES.REVERSED;
      failureReason = 'reversed_by_razorpay';
      break;
    default:
      log.warn({ eventType }, 'Unknown payout webhook event type');
      return { unknown: true };
  }

  await col('payouts').updateOne(
    { _id: payout._id },
    { $set: {
      status: newPayoutStatus,
      failure_reason: failureReason,
      webhook_synced: true,
      utr: payoutEntity.utr || null,
      updated_at: new Date(),
    }}
  );

  await col('order_settlements').updateOne(
    { _id: payout.settlement_id },
    { $set: {
      status: newSettlementStatus,
      failure_reason: failureReason,
      updated_at: new Date(),
    }}
  );

  // 4. Mark webhook event as processed
  if (eventId) {
    await col('razorpay_webhook_events').updateOne(
      { event_id: eventId },
      { $set: { processed: true, processed_at: new Date() } }
    );
  }

  log.info({ payoutId: payout._id, settlementId: payout.settlement_id, newPayoutStatus, newSettlementStatus }, 'Payout webhook processed');

  logActivity({
    actorType: 'system', actorName: 'Razorpay',
    action: `payout.${newPayoutStatus}`, category: 'billing',
    description: `Payout ${newPayoutStatus} (${payoutEntity.id})${failureReason ? `: ${failureReason}` : ''}`,
    restaurantId: payout.restaurant_id, resourceType: 'payout', resourceId: String(payout._id),
    severity: newPayoutStatus === 'failed' || newPayoutStatus === 'reversed' ? 'error' : 'info',
    metadata: { rp_payout_id: payoutEntity.id, utr: payoutEntity.utr, failure_reason: failureReason },
  });

  return { success: true, payoutStatus: newPayoutStatus, settlementStatus: newSettlementStatus };
};

// ════════════════════════════════════════════════════════════════
// 4. RETRY FAILED PAYOUTS
// ════════════════════════════════════════════════════════════════

const MAX_RETRY_COUNT = 3;

const retryFailedSettlement = async (settlementId) => {
  const settlement = await col('order_settlements').findOne({ _id: settlementId });
  if (!settlement) throw new Error('Settlement not found');
  if (settlement.status !== SETTLEMENT_STATES.FAILED) {
    return { skipped: true, reason: `status=${settlement.status}` };
  }
  if ((settlement.retry_count || 0) >= MAX_RETRY_COUNT) {
    return { skipped: true, reason: 'max_retries_reached' };
  }

  // Delete the previous payout record so a new one can be created
  if (settlement.payout_id) {
    await col('payouts').deleteOne({ _id: settlement.payout_id });
  }
  await col('order_settlements').updateOne(
    { _id: settlementId },
    { $set: { payout_id: null, status: SETTLEMENT_STATES.ELIGIBLE, failure_reason: null, updated_at: new Date() } }
  );

  return processSettlement(settlementId);
};

// Cron-friendly: retry all failed settlements under retry limit
const retryAllFailedSettlements = async () => {
  const failed = await col('order_settlements').find({
    status: SETTLEMENT_STATES.FAILED,
    retry_count: { $lt: MAX_RETRY_COUNT },
  }).limit(50).toArray();

  let succeeded = 0, skipped = 0, errored = 0;
  for (const s of failed) {
    try {
      const result = await retryFailedSettlement(String(s._id));
      if (result.success) succeeded++;
      else skipped++;
    } catch (err) {
      log.error({ err, settlementId: String(s._id) }, 'Retry failed');
      errored++;
    }
  }
  log.info({ total: failed.length, succeeded, skipped, errored }, 'Retry batch complete');
  return { total: failed.length, succeeded, skipped, errored };
};

// ════════════════════════════════════════════════════════════════
// 5. HELPERS
// ════════════════════════════════════════════════════════════════

function generateIdempotencyKey(settlementId, retryCount) {
  // Deterministic but unique per retry attempt
  return crypto.createHash('sha256')
    .update(`${settlementId}:${retryCount}`)
    .digest('hex')
    .slice(0, 32);
}

module.exports = {
  SETTLEMENT_STATES,
  PAYOUT_STATES,
  createSettlementForOrder,
  processSettlement,
  handlePayoutWebhook,
  retryFailedSettlement,
  retryAllFailedSettlements,
};
