// src/jobs/settlement.js
// LEGACY weekly settlement — order-based payout cycle. Replaced by the
// Phase 5 ledger-based system in services/settlement.service.js.
//
// Settlement cadence: bi-weekly (Monday + Friday), admin-triggered manually
// via POST /api/admin/settlements/run. Automation pending PG provider
// onboarding. The legacy weekly cron below is intentionally NOT scheduled.
// runSettlement() is kept callable for ops backfills / one-offs.
//
// expireReferrals continues to run daily at 3:00 AM IST — separate concern.

const cron = require('node-cron');
const { col, newId } = require('../config/database');
const paymentSvc = require('../services/payment');
const { generateSettlementExcel } = require('../services/settlement-export');
const wa = require('../services/whatsapp');
const { calculateTDS, aggregateOrderFinancials } = require('../services/financials');
const { calculateSettlement: calcSettlement, round2 } = require('../core/financialEngine');
const { getPlatformFeePercent, isFirstBillingMonth, shouldDeductPlatformFee } = require('../config/financeConfig');
const ws = require('../services/websocket');
const { logActivity } = require('../services/activityLog');
const log = require('../utils/logger').child({ component: 'settlement' });

// ─── SCHEDULE THE JOB ─────────────────────────────────────────
const scheduleSettlement = () => {
  // DISABLED: legacy order-based settlement replaced by Phase 5 ledger-based
  // system (services/settlement.service.js + admin POST /settlements/run).
  // Leaving runSettlement exported so ops can still invoke a backfill if
  // ever needed, but the cron does not auto-fire.
  // cron.schedule('0 9 * * 1', runSettlement, { timezone: 'Asia/Kolkata' });
  // log.info('settlement cron scheduled: every Monday at 9:00 AM IST');

  // Expire stale referrals daily at 3:00 AM IST
  cron.schedule('0 3 * * *', expireReferrals, { timezone: 'Asia/Kolkata' });
  log.info('referral expiry cron scheduled: daily at 3:00 AM IST');
};

// ─── MANUAL TRIGGER ───────────────────────────────────────────
const runSettlement = async () => {
  log.info('running weekly settlement');

  const now = new Date();
  const thisMonday = getLastMonday(now);
  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(lastMonday.getDate() - 7);

  const periodStart = lastMonday;
  const periodEnd   = thisMonday;
  log.info({ periodStart: formatDate(periodStart), periodEnd: formatDate(periodEnd) }, 'settlement period');

  const restaurants = await col('restaurants').find({ status: 'active' }).toArray();
  log.info({ count: restaurants.length }, 'processing restaurants');

  // Process restaurants in parallel batches of 5
  const BATCH_SIZE = 5;
  let settled = 0, failed = 0;
  for (let i = 0; i < restaurants.length; i += BATCH_SIZE) {
    const batch = restaurants.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(r => settleRestaurant(r, periodStart, periodEnd))
    );
    results.forEach((result, idx) => {
      if (result.status === 'rejected') {
        log.error({ err: result.reason, restaurant: batch[idx].business_name }, 'settlement failed for restaurant');
        failed++;
      } else { settled++; }
    });
  }

  log.info({ settled, failed }, 'settlement run complete');
};

// ─── SETTLE ONE RESTAURANT ────────────────────────────────────
const settleRestaurant = async (restaurant, periodStart, periodEnd) => {
  const restaurantId = String(restaurant._id);

  // Get all branch IDs for this restaurant
  const branches = await col('branches').find({ restaurant_id: restaurantId }).project({ _id: 1 }).toArray();
  const branchIds = branches.map(b => String(b._id));

  // Find all delivered orders in this period not yet settled
  const orders = await col('orders').find({
    branch_id: { $in: branchIds },
    status: 'DELIVERED',
    delivered_at: { $gte: periodStart, $lt: periodEnd },
    settlement_id: null,
  }).toArray();

  if (!orders.length) {
    log.info({ restaurant: restaurant.business_name }, 'no orders to settle');
    return;
  }

  // ── Aggregate all order financials ───────────────────────────
  const agg = await aggregateOrderFinancials(branchIds, periodStart, periodEnd);
  const orderIds = orders.map(o => String(o._id));

  // ── Refunds ──────────────────────────────────────────────────
  const refundPayments = await col('payments').find({
    order_id: { $in: orderIds },
    status: 'refunded',
    updated_at: { $gte: periodStart, $lt: periodEnd },
  }).toArray();
  const refundTotal = round2(refundPayments.reduce((s, p) => s + (parseFloat(p.amount_rs) || 0), 0));

  // ── Messaging charges (recover negative wallet balance) ──────
  const walletSvc = require('../services/wallet');
  const walletRecovery = await walletSvc.settleNegativeBalance(restaurantId);
  const messagingChargesRs = walletRecovery.deducted || 0;
  const messagingChargesGst = walletRecovery.gst || 0;

  // ── CENTRALIZED SETTLEMENT CALCULATION ───────────────────────
  // All financial math delegated to core/financialEngine.js
  // Two-pass: first calculate pre-TDS net, then use it for TDS, then finalize.
  const settlementPass1 = calcSettlement(restaurant, agg, refundTotal, messagingChargesRs, messagingChargesGst, 0);
  const tds = await calculateTDS(restaurantId, settlementPass1.pre_tds_net_rs);
  const finalCalc = calcSettlement(restaurant, agg, refundTotal, messagingChargesRs, messagingChargesGst, tds.amount);

  // ── Cancellation fault fees (drain accumulator) ─────────────
  // Fault-cancellation Razorpay-fee debits accumulate on the restaurant
  // doc as `pending_cancellation_fault_fees_paise` (written by
  // services/orderCancellationService.handleRestaurantFault). We drain
  // the accumulator into THIS settlement row's cancellation_fault_fees
  // field and apply it as a final deduction post-TDS — so platform fee,
  // referral fee, commission, and TDS amounts in finalCalc stay exactly
  // as the financial engine produced them (additive change only).
  // Absent field → treat as 0; restaurant with no faults gets a clean no-op.
  const pendingFaultFeesPaise = Number(restaurant.pending_cancellation_fault_fees_paise) || 0;
  const cancellationFaultFeesRs = round2(pendingFaultFeesPaise / 100);

  const platformFee = finalCalc.platform_fee_rs;
  const platformFeeGst = finalCalc.platform_fee_gst_rs;
  const platformFeeCalculated = finalCalc.platform_fee_calculated_rs;
  const platformFeeGstCalculated = finalCalc.platform_fee_gst_calculated_rs;
  const referralFeeGst = finalCalc.referral_fee_gst_rs;
  const grossRevenue = finalCalc.gross_revenue_rs;
  const preTdsNet = finalCalc.pre_tds_net_rs;
  // netPayout reflects the financial engine's full computation MINUS the
  // drained cancellation fault fees. This is the only line where the
  // calculation changes; all other deductions remain inside finalCalc.
  const netPayout = round2(finalCalc.net_payout_rs - cancellationFaultFeesRs);
  const firstMonth = finalCalc.is_first_billing_month;

  if (firstMonth && finalCalc.platform_fee_waived_first_month) {
    log.info({ restaurant: restaurant.business_name, platformFeeCalculated, platformFeeGstCalculated }, 'first-month: platform fee not deducted (advance collected)');
  }

  log.info({
    restaurant: restaurant.business_name, orderCount: orders.length,
    grossRevenue: grossRevenue.toFixed(0), netPayout: netPayout.toFixed(0),
    tdsApplicable: tds.applicable, tdsAmount: tds.applicable ? tds.amount.toFixed(0) : undefined,
  }, 'restaurant settlement calculated');

  const settlementId = newId();
  const now = new Date();

  const insertResult = await col('settlements').insertOne({
    _id: settlementId,
    restaurant_id: restaurantId,
    // Disambiguates from Phase 5 balance-based rows (settlement_type='new').
    settlement_type: 'legacy',
    period_start: periodStart,
    period_end: periodEnd,

    // Revenue breakdown
    food_revenue_rs: agg.food_revenue_rs,
    food_gst_collected_rs: agg.food_gst_collected_rs,
    delivery_fee_collected_rs: agg.delivery_fee_collected_rs,
    delivery_fee_restaurant_share_rs: agg.delivery_fee_rest_share_rs,
    delivery_fee_restaurant_gst_rs: agg.delivery_fee_rest_gst_rs,
    delivery_fee_platform_share_rs: round2(agg.delivery_fee_collected_rs - agg.delivery_fee_rest_share_rs),
    packaging_collected_rs: agg.packaging_collected_rs,
    packaging_gst_rs: agg.packaging_gst_rs,

    // Discounts & refunds
    discount_total_rs: agg.discount_total_rs,
    refund_total_rs: refundTotal,
    refund_count: refundPayments.length,

    // Platform fee
    platform_fee_rs: platformFee,
    platform_fee_gst_rs: platformFeeGst,
    platform_fee_calculated_rs: platformFeeCalculated,      // what WOULD have been charged
    platform_fee_gst_calculated_rs: platformFeeGstCalculated,
    platform_fee_waived_first_month: firstMonth && !shouldDeductPlatformFee(restaurant),
    is_first_billing_month: firstMonth,
    commission_rate_pct: finalCalc.commission_rate_pct,

    // TDS
    tds_applicable: tds.applicable,
    tds_rate_pct: tds.rate,
    tds_amount_rs: tds.amount,
    tds_section: tds.applicable ? tds.section : null,

    // Referral
    referral_fee_rs: agg.referral_fee_rs,
    referral_fee_gst_rs: referralFeeGst,

    // Cancellation fault fees (drained from per-restaurant accumulator).
    // Subtracted from net_payout_rs above; surfaced here so the dashboard
    // breakdown line in SettlementDetailModal can render it.
    cancellation_fault_fees: cancellationFaultFeesRs,

    // Messaging charges (recovered from negative wallet balance)
    messaging_charges_rs: messagingChargesRs,
    messaging_charges_gst_rs: messagingChargesGst,

    // Totals (backward-compatible fields)
    gross_revenue_rs: grossRevenue,
    delivery_costs_rs: round2(agg.delivery_fee_rest_share_rs + agg.delivery_fee_rest_gst_rs),
    refunds_rs: refundTotal,
    net_payout_rs: netPayout,
    orders_count: orders.length,

    // Payout
    payout_status: 'pending',
    rp_payout_id: null,
    rp_transfer_id: null,
    payout_utr: null,
    payout_initiated_at: null,
    payout_completed_at: null,
    payout_at: null,

    // Metadata
    generated_at: now,
    generated_by: 'system',
    created_at: now,
  });

  // ── Drain the cancellation-fault-fees accumulator ───────────
  // Only after the settlement row insert is acknowledged. If the insert
  // throws above, control flow never reaches here and the accumulator
  // is preserved for the next settlement run — fees never lost. The
  // `pendingFaultFeesPaise > 0` guard avoids a noisy update for the
  // common case (most restaurants have no faults this period). Done
  // BEFORE the order-tagging updateMany below so a downstream failure
  // can't cause a re-insert next run that would re-charge these fees.
  if (
    pendingFaultFeesPaise > 0
    && insertResult?.acknowledged
    && insertResult?.insertedId
  ) {
    try {
      await col('restaurants').updateOne(
        { _id: restaurantId },
        {
          $set: {
            pending_cancellation_fault_fees_paise: 0,
            pending_cancellation_fault_fees_drained_at: now,
            pending_cancellation_fault_fees_drained_settlement_id: settlementId,
          },
        },
      );
      log.info({ restaurantId, drainedPaise: pendingFaultFeesPaise, settlementId }, 'cancellation fault fees accumulator drained');
    } catch (drainErr) {
      // Non-fatal — the settlement row already records the fee. Worst
      // case: next run double-counts these fees. Surface loud so ops can
      // manually zero the accumulator if needed.
      log.error({ err: drainErr, restaurantId, settlementId, drainedPaise: pendingFaultFeesPaise },
        'cancellation fault fees accumulator drain FAILED — manual reset may be required');
    }
  }

  // Mark all orders as settled
  await col('orders').updateMany(
    { _id: { $in: orderIds } },
    { $set: { settlement_id: settlementId, settled_at: now } }
  );

  // Audit: settlement created
  logActivity({
    actorType: 'system', actorId: null, actorName: 'Settlement Job',
    action: 'settlement.created', category: 'billing',
    description: `Settlement created for ${restaurant.business_name}: ${orders.length} orders, gross ₹${grossRevenue.toFixed(0)}, net ₹${netPayout.toFixed(0)}`,
    restaurantId, resourceType: 'settlement', resourceId: settlementId, severity: 'info',
    metadata: {
      period_start: formatDate(periodStart),
      period_end: formatDate(periodEnd),
      order_count: orders.length,
      gross_revenue_rs: grossRevenue,
      net_payout_rs: netPayout,
      platform_fee_rs: platformFee,
      tds_amount_rs: tds.amount,
      refund_total_rs: refundTotal,
      is_first_billing_month: firstMonth,
    },
  });

  ws.broadcastToAdmin('settlement_update', { restaurantId, restaurantName: restaurant.business_name, status: 'created', amount: netPayout });

  // ── INITIATE PAYOUT via Razorpay X ───────────────────────
  if (netPayout > 0 && restaurant.razorpay_fund_acct_id) {
    try {
      const payout = await paymentSvc.createPayout(
        { ...restaurant, id: restaurantId },
        netPayout,
        settlementId
      );
      await col('settlements').updateOne(
        { _id: settlementId },
        { $set: { rp_payout_id: payout.id, payout_status: 'processing', payout_at: new Date() } }
      );
      log.info({ restaurant: restaurant.business_name, netPayout: netPayout.toFixed(0), payoutId: payout.id }, 'payout initiated');
      logActivity({
        actorType: 'system', actorId: null, actorName: 'Settlement Job',
        action: 'settlement.payout_initiated', category: 'billing',
        description: `Payout ₹${netPayout.toFixed(0)} initiated for ${restaurant.business_name} (${payout.id})`,
        restaurantId, resourceType: 'settlement', resourceId: settlementId, severity: 'info',
        metadata: { payout_id: payout.id, amount_rs: netPayout, fund_account_id: restaurant.razorpay_fund_acct_id },
      });
    } catch (payoutErr) {
      log.error({ err: payoutErr, restaurant: restaurant.business_name }, 'payout failed');
      await col('settlements').updateOne({ _id: settlementId }, { $set: { payout_status: 'failed' } });
      logActivity({
        actorType: 'system', actorId: null, actorName: 'Settlement Job',
        action: 'settlement.payout_failed', category: 'billing',
        description: `Payout failed for ${restaurant.business_name}: ${payoutErr.message}`,
        restaurantId, resourceType: 'settlement', resourceId: settlementId, severity: 'error',
        metadata: { error: payoutErr.message, amount_rs: netPayout },
      });
    }
  } else if (netPayout <= 0) {
    log.warn({ restaurant: restaurant.business_name }, 'net payout is zero — skipping');
  } else {
    log.warn({ restaurant: restaurant.business_name }, 'no payout account configured');
  }

  // ── SEND SETTLEMENT EXCEL VIA WHATSAPP (fire-and-forget) ────
  sendSettlementWhatsApp(restaurant, settlementId, netPayout, orders.length, periodStart, periodEnd).catch(err =>
    log.error({ err, restaurant: restaurant.business_name }, 'WhatsApp settlement report failed')
  );

  return { id: settlementId };
};

async function sendSettlementWhatsApp(restaurant, settlementId, netPayout, orderCount, periodStart, periodEnd) {
  // Need WA account linked to this restaurant
  const waAccount = await col('whatsapp_accounts').findOne({ restaurant_id: String(restaurant._id) });
  if (!waAccount) return; // No WA account, skip silently

  const managerPhone = restaurant.phone;
  if (!managerPhone) return;

  const name = restaurant.brand_name || restaurant.business_name;
  const period = `${formatDate(periodStart)} to ${formatDate(periodEnd)}`;

  // Send summary text first
  await wa.sendText(waAccount.phone_number_id, waAccount.access_token, managerPhone,
    `💰 *Weekly Settlement — ${name}*\n\n` +
    `Period: ${period}\n` +
    `Orders: ${orderCount}\n` +
    `Net Payout: ₹${netPayout.toFixed(2)}\n\n` +
    `Your detailed Excel report is attached below.`
  );

  // Generate and send Excel
  const { buffer, filename } = await generateSettlementExcel(settlementId);
  await wa.sendDocument(waAccount.phone_number_id, waAccount.access_token, managerPhone, {
    buffer: Buffer.from(buffer),
    filename,
    caption: `Settlement report for ${period}`,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

// ─── UTILITIES ────────────────────────────────────────────────
const getLastMonday = (date) => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
};

const formatDate = (date) => date.toISOString().split('T')[0];

// ─── REFERRAL EXPIRY ─────────────────────────────────────────
const expireReferrals = async () => {
  try {
    const now = new Date();
    const result = await col('referrals').updateMany(
      { status: 'active', expires_at: { $lt: now } },
      { $set: { status: 'expired', updated_at: now } }
    );
    if (result.modifiedCount > 0) {
      log.info({ count: result.modifiedCount }, 'expired stale referrals');
    }
  } catch (err) {
    log.error({ err }, 'referral expiry job failed');
  }
};

module.exports = { scheduleSettlement, runSettlement, expireReferrals };
