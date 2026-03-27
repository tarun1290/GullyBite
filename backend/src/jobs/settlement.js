// src/jobs/settlement.js
// Weekly settlement cron job
// Runs every Monday at 9:00 AM — calculates and pays out restaurant earnings

const cron = require('node-cron');
const { col, newId } = require('../config/database');
const paymentSvc = require('../services/payment');
const { generateSettlementExcel } = require('../services/settlement-export');
const wa = require('../services/whatsapp');
const { calculateTDS, aggregateOrderFinancials, round2, GST_PLATFORM_FEE_PCT } = require('../services/financials');

// ─── SCHEDULE THE JOB ─────────────────────────────────────────
const scheduleSettlement = () => {
  cron.schedule('0 9 * * 1', runSettlement, { timezone: 'Asia/Kolkata' });
  console.log('⏰ Settlement cron scheduled: Every Monday at 9:00 AM IST');

  // Expire stale referrals daily at 3:00 AM IST
  cron.schedule('0 3 * * *', expireReferrals, { timezone: 'Asia/Kolkata' });
  console.log('⏰ Referral expiry cron scheduled: Daily at 3:00 AM IST');
};

// ─── MANUAL TRIGGER ───────────────────────────────────────────
const runSettlement = async () => {
  console.log('\n💰 ===== RUNNING WEEKLY SETTLEMENT =====');

  const now = new Date();
  const thisMonday = getLastMonday(now);
  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(lastMonday.getDate() - 7);

  const periodStart = lastMonday;
  const periodEnd   = thisMonday;
  console.log(`Period: ${formatDate(periodStart)} → ${formatDate(periodEnd)}`);

  const restaurants = await col('restaurants').find({ status: 'active' }).toArray();
  console.log(`Processing ${restaurants.length} restaurants...`);

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
        console.error(`❌ Settlement failed for ${batch[idx].business_name}:`, result.reason?.message || result.reason);
        failed++;
      } else { settled++; }
    });
  }

  console.log(`✅ Settlement run complete — ${settled} settled, ${failed} failed\n`);
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
    console.log(`  ${restaurant.business_name}: No orders to settle`);
    return;
  }

  const commissionRate = parseFloat(restaurant.commission_pct || 10) / 100;

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

  // ── Platform fee (commission on food subtotal) ───────────────
  const platformFee = round2(agg.food_revenue_rs * commissionRate);
  const platformFeeGst = round2(platformFee * GST_PLATFORM_FEE_PCT / 100);

  // ── Referral fee GST ─────────────────────────────────────────
  const referralFeeGst = round2(agg.referral_fee_rs * GST_PLATFORM_FEE_PCT / 100);

  // ── Gross collections (what customer paid) ───────────────────
  const grossRevenue = round2(
    agg.food_revenue_rs + agg.food_gst_collected_rs +
    agg.packaging_collected_rs + agg.packaging_gst_rs +
    agg.delivery_fee_collected_rs + agg.delivery_fee_cust_gst_rs
  );

  // ── Messaging charges (recover negative wallet balance) ──────
  const walletSvc = require('../services/wallet');
  const walletRecovery = await walletSvc.settleNegativeBalance(restaurantId);
  const messagingChargesRs = walletRecovery.deducted || 0;
  const messagingChargesGst = walletRecovery.gst || 0;

  // ── Pre-TDS net ──────────────────────────────────────────────
  const preTdsNet = round2(
    grossRevenue
    - platformFee - platformFeeGst
    - agg.delivery_fee_rest_share_rs - agg.delivery_fee_rest_gst_rs
    - agg.discount_total_rs - refundTotal
    - agg.referral_fee_rs - referralFeeGst
    - messagingChargesRs - messagingChargesGst
  );

  // ── TDS calculation ──────────────────────────────────────────
  const tds = await calculateTDS(restaurantId, preTdsNet);
  const netPayout = round2(preTdsNet - tds.amount);

  console.log(
    `  ${restaurant.business_name}: ${orders.length} orders, ` +
    `₹${grossRevenue.toFixed(0)} gross, ₹${netPayout.toFixed(0)} payout` +
    (tds.applicable ? ` (TDS ₹${tds.amount.toFixed(0)})` : '')
  );

  const settlementId = newId();
  const now = new Date();

  await col('settlements').insertOne({
    _id: settlementId,
    restaurant_id: restaurantId,
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

    // TDS
    tds_applicable: tds.applicable,
    tds_rate_pct: tds.rate,
    tds_amount_rs: tds.amount,
    tds_section: tds.applicable ? tds.section : null,

    // Referral
    referral_fee_rs: agg.referral_fee_rs,
    referral_fee_gst_rs: referralFeeGst,

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

  // Mark all orders as settled
  await col('orders').updateMany(
    { _id: { $in: orderIds } },
    { $set: { settlement_id: settlementId, settled_at: now } }
  );

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
      console.log(`  → ₹${netPayout.toFixed(0)} payout initiated for ${restaurant.business_name}: ${payout.id}`);
    } catch (payoutErr) {
      console.error(`  ❌ Payout failed for ${restaurant.business_name}:`, payoutErr.message);
      await col('settlements').updateOne({ _id: settlementId }, { $set: { payout_status: 'failed' } });
    }
  } else if (netPayout <= 0) {
    console.log(`  ⚠️  ${restaurant.business_name}: Net payout ₹0 — skipping`);
  } else {
    console.log(`  ⚠️  ${restaurant.business_name}: No payout account — call POST /api/restaurant/payout-account first`);
  }

  // ── SEND SETTLEMENT EXCEL VIA WHATSAPP (fire-and-forget) ────
  sendSettlementWhatsApp(restaurant, settlementId, netPayout, orders.length, periodStart, periodEnd).catch(err =>
    console.error(`  ⚠️  WhatsApp settlement report failed for ${restaurant.business_name}:`, err.message)
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
      console.log(`[Referrals] Expired ${result.modifiedCount} stale referrals`);
    }
  } catch (err) {
    console.error('[Referrals] Expiry job failed:', err.message);
  }
};

module.exports = { scheduleSettlement, runSettlement, expireReferrals };
