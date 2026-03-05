// src/jobs/settlement.js
// Weekly settlement cron job
// Runs every Monday at 9:00 AM — calculates and pays out restaurant earnings

const cron = require('node-cron');
const db = require('../config/database');
const paymentSvc = require('../services/payment');

// ─── SCHEDULE THE JOB ─────────────────────────────────────────
// Cron syntax: second minute hour day-of-month month day-of-week
// '0 9 * * 1' = at 09:00 on Monday
const scheduleSettlement = () => {
  cron.schedule('0 9 * * 1', runSettlement, { timezone: 'Asia/Kolkata' });
  console.log('⏰ Settlement cron scheduled: Every Monday at 9:00 AM IST');
};

// ─── MANUAL TRIGGER ───────────────────────────────────────────
// For testing or admin use: POST /api/admin/run-settlement
const runSettlement = async () => {
  console.log('\n💰 ===== RUNNING WEEKLY SETTLEMENT =====');

  const now = new Date();
  // Calculate period: last Monday to this Monday
  const thisMonday = getLastMonday(now);
  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(lastMonday.getDate() - 7);

  const periodStart = formatDate(lastMonday);
  const periodEnd = formatDate(thisMonday);
  console.log(`Period: ${periodStart} → ${periodEnd}`);

  // Get all active restaurants
  const { rows: restaurants } = await db.query(
    "SELECT * FROM restaurants WHERE status = 'active'"
  );

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
  // Find all delivered orders in this period that haven't been settled yet
  const { rows: orders } = await db.query(
    `SELECT * FROM orders
     WHERE customer_id IN (SELECT id FROM customers)
       AND branch_id IN (SELECT id FROM branches WHERE restaurant_id = $1)
       AND status = 'DELIVERED'
       AND delivered_at >= $2
       AND delivered_at < $3
       AND settlement_id IS NULL`,
    [restaurant.id, periodStart, periodEnd]
  );

  if (!orders.length) {
    console.log(`  ${restaurant.business_name}: No orders to settle`);
    return;
  }

  // ── CALCULATE FINANCIALS ────────────────────────────────────
  const grossRevenue = orders.reduce((s, o) => s + parseFloat(o.total_rs), 0);
  const commissionRate = parseFloat(restaurant.commission_pct || 10) / 100;
  // Platform fee is calculated on subtotal (not delivery fee)
  const platformFee = orders.reduce((s, o) => s + parseFloat(o.subtotal_rs) * commissionRate, 0);
  const deliveryCosts = orders.reduce((s, o) => s + parseFloat(o.delivery_fee_rs), 0);

  // Get refunds for this period
  const { rows: refundRows } = await db.query(
    `SELECT COALESCE(SUM(p.amount_rs), 0) AS refunds
     FROM payments p
     JOIN orders o ON p.order_id = o.id
     WHERE o.branch_id IN (SELECT id FROM branches WHERE restaurant_id = $1)
       AND p.status = 'refunded'
       AND p.updated_at >= $2
       AND p.updated_at < $3`,
    [restaurant.id, periodStart, periodEnd]
  );
  const refunds = parseFloat(refundRows[0].refunds);

  const netPayout = grossRevenue - platformFee - deliveryCosts - refunds;

  console.log(
    `  ${restaurant.business_name}: ${orders.length} orders, ` +
    `₹${grossRevenue.toFixed(0)} gross, ₹${netPayout.toFixed(0)} payout`
  );

  return db.transaction(async (client) => {
    // Create settlement record
    const { rows: [settlement] } = await client.query(
      `INSERT INTO settlements
         (restaurant_id, period_start, period_end,
          gross_revenue_rs, platform_fee_rs, delivery_costs_rs, refunds_rs, net_payout_rs,
          orders_count, payout_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
       RETURNING id`,
      [restaurant.id, periodStart, periodEnd,
       grossRevenue.toFixed(2), platformFee.toFixed(2), deliveryCosts.toFixed(2),
       refunds.toFixed(2), netPayout.toFixed(2), orders.length]
    );

    // Mark all orders as settled
    await client.query(
      'UPDATE orders SET settlement_id=$1, settled_at=NOW() WHERE id = ANY($2::uuid[])',
      [settlement.id, orders.map((o) => o.id)]
    );

    // ── INITIATE PAYOUT via Razorpay X ───────────────────────
    // Transfers the net settlement to the restaurant's registered bank account.
    // Requires: RAZORPAY_ACCOUNT_NUMBER in .env + restaurant.razorpay_fund_acct_id set.
    // Register the fund account via POST /api/restaurant/payout-account.
    if (netPayout > 0 && restaurant.razorpay_fund_acct_id) {
      try {
        const payout = await paymentSvc.createPayout(restaurant, netPayout, settlement.id);
        await client.query(
          "UPDATE settlements SET rp_payout_id=$1, payout_status='processing', payout_at=NOW() WHERE id=$2",
          [payout.id, settlement.id]
        );
        console.log(`  → ₹${netPayout.toFixed(0)} payout initiated for ${restaurant.business_name}: ${payout.id}`);
      } catch (payoutErr) {
        console.error(`  ❌ Payout failed for ${restaurant.business_name}:`, payoutErr.message);
        await client.query(
          "UPDATE settlements SET payout_status='failed' WHERE id=$1",
          [settlement.id]
        );
      }
    } else if (netPayout <= 0) {
      console.log(`  ⚠️  ${restaurant.business_name}: Net payout ₹0 — skipping`);
    } else {
      console.log(`  ⚠️  ${restaurant.business_name}: No payout account — call POST /api/restaurant/payout-account first`);
    }

    return settlement;
  });
};

// ─── UTILITIES ────────────────────────────────────────────────
const getLastMonday = (date) => {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun, 1=Mon, ...
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
};

const formatDate = (date) => date.toISOString().split('T')[0];

module.exports = { scheduleSettlement, runSettlement };