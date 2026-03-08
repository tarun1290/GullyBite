// src/jobs/settlement.js
// Weekly settlement cron job
// Runs every Monday at 9:00 AM — calculates and pays out restaurant earnings

const cron = require('node-cron');
const { col, newId } = require('../config/database');
const paymentSvc = require('../services/payment');

// ─── SCHEDULE THE JOB ─────────────────────────────────────────
const scheduleSettlement = () => {
  cron.schedule('0 9 * * 1', runSettlement, { timezone: 'Asia/Kolkata' });
  console.log('⏰ Settlement cron scheduled: Every Monday at 9:00 AM IST');
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

  for (const restaurant of restaurants) {
    try {
      await settleRestaurant(restaurant, periodStart, periodEnd);
    } catch (err) {
      console.error(`❌ Settlement failed for ${restaurant.business_name}:`, err.message);
    }
  }

  console.log('✅ Settlement run complete\n');
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

  const grossRevenue = orders.reduce((s, o) => s + (parseFloat(o.total_rs) || 0), 0);
  const commissionRate = parseFloat(restaurant.commission_pct || 10) / 100;
  const platformFee = orders.reduce((s, o) => s + (parseFloat(o.subtotal_rs) || 0) * commissionRate, 0);
  const deliveryCosts = orders.reduce((s, o) => s + (parseFloat(o.delivery_fee_rs) || 0), 0);
  const restaurantDeliveryDeduction = orders.reduce(
    (s, o) => s + (parseFloat(o.restaurant_delivery_rs) || 0) + (parseFloat(o.restaurant_delivery_gst_rs) || 0),
    0
  );

  // Get refunds for this period
  const orderIds = orders.map(o => String(o._id));
  const refundPayments = await col('payments').find({
    order_id: { $in: orderIds },
    status: 'refunded',
    updated_at: { $gte: periodStart, $lt: periodEnd },
  }).toArray();
  const refunds = refundPayments.reduce((s, p) => s + (parseFloat(p.amount_rs) || 0), 0);

  const netPayout = grossRevenue - platformFee - deliveryCosts - restaurantDeliveryDeduction - refunds;

  console.log(
    `  ${restaurant.business_name}: ${orders.length} orders, ` +
    `₹${grossRevenue.toFixed(0)} gross, ₹${netPayout.toFixed(0)} payout`
  );

  const settlementId = newId();
  const now = new Date();

  await col('settlements').insertOne({
    _id: settlementId,
    restaurant_id: restaurantId,
    period_start: periodStart,
    period_end: periodEnd,
    gross_revenue_rs: parseFloat(grossRevenue.toFixed(2)),
    platform_fee_rs: parseFloat(platformFee.toFixed(2)),
    delivery_costs_rs: parseFloat((deliveryCosts + restaurantDeliveryDeduction).toFixed(2)),
    refunds_rs: parseFloat(refunds.toFixed(2)),
    net_payout_rs: parseFloat(netPayout.toFixed(2)),
    orders_count: orders.length,
    payout_status: 'pending',
    rp_payout_id: null,
    payout_at: null,
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

  return { id: settlementId };
};

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

module.exports = { scheduleSettlement, runSettlement };
