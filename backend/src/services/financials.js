// src/services/financials.js
// Financial aggregation, tax calculations, and compliance helpers.
// Used by both restaurant and admin API endpoints.

'use strict';

const { col } = require('../config/database');

// ─── TAX CONSTANTS ────────────────────────────────────────────────
const GST_FOOD_PCT        = 5;
const GST_PACKAGING_PCT   = 18;
const GST_DELIVERY_PCT    = 18;
const GST_PLATFORM_FEE_PCT = 18;
const TDS_RATE_WITH_PAN   = 1;   // Section 194O
const TDS_RATE_NO_PAN     = 5;
const TDS_THRESHOLD_RS    = 500000; // ₹5 lakh annual threshold
const TDS_SECTION         = '194O';

const round2 = n => Math.round((n || 0) * 100) / 100;

// ─── FINANCIAL YEAR HELPERS ───────────────────────────────────────
function getFYBounds(fyLabel) {
  // fyLabel like "2025-26" → Apr 1 2025 to Mar 31 2026
  if (fyLabel) {
    const startYear = parseInt(fyLabel.split('-')[0]);
    return {
      start: new Date(startYear, 3, 1),       // Apr 1
      end:   new Date(startYear + 1, 2, 31, 23, 59, 59, 999), // Mar 31
    };
  }
  // Default: current FY
  const now = new Date();
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return {
    start: new Date(year, 3, 1),
    end:   new Date(year + 1, 2, 31, 23, 59, 59, 999),
  };
}

function getCurrentFYLabel() {
  const now = new Date();
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-${String(year + 1).slice(2)}`;
}

// ─── TDS CALCULATION ──────────────────────────────────────────────
async function calculateTDS(restaurantId, currentSettlementNetRs) {
  const fy = getFYBounds();

  // Sum previous settlements in this FY
  const prev = await col('settlements').aggregate([
    {
      $match: {
        restaurant_id: restaurantId,
        period_end: { $gte: fy.start, $lte: fy.end },
      },
    },
    { $group: { _id: null, total: { $sum: '$net_payout_rs' } } },
  ]).toArray();

  const cumulativePrevious = prev[0]?.total || 0;
  const cumulativeWithCurrent = cumulativePrevious + currentSettlementNetRs;

  if (cumulativeWithCurrent <= TDS_THRESHOLD_RS) {
    return { applicable: false, rate: 0, amount: 0, section: null, cumulative: cumulativeWithCurrent };
  }

  // Check if restaurant has PAN
  const restaurant = await col('restaurants').findOne(
    { _id: restaurantId },
    { projection: { pan_number: 1 } },
  );
  const hasPAN = !!restaurant?.pan_number;
  const rate = hasPAN ? TDS_RATE_WITH_PAN : TDS_RATE_NO_PAN;

  // TDS on the amount that crosses threshold (or full current if already crossed)
  let taxableAmount;
  if (cumulativePrevious >= TDS_THRESHOLD_RS) {
    taxableAmount = currentSettlementNetRs;
  } else {
    taxableAmount = cumulativeWithCurrent - TDS_THRESHOLD_RS;
  }

  const amount = round2(taxableAmount * rate / 100);

  return {
    applicable: true,
    rate,
    amount,
    section: TDS_SECTION,
    cumulative: cumulativeWithCurrent,
    hasPAN,
  };
}

// ─── PERIOD HELPERS ───────────────────────────────────────────────
function parsePeriod(period, from, to) {
  const now = new Date();
  if (from && to) return { start: new Date(from), end: new Date(to) };

  switch (period) {
    case 'today': {
      const s = new Date(now); s.setHours(0,0,0,0);
      return { start: s, end: now };
    }
    case '7d': {
      const s = new Date(now); s.setDate(s.getDate() - 7);
      return { start: s, end: now };
    }
    case '30d': {
      const s = new Date(now); s.setDate(s.getDate() - 30);
      return { start: s, end: now };
    }
    case '90d': {
      const s = new Date(now); s.setDate(s.getDate() - 90);
      return { start: s, end: now };
    }
    case 'this_week': {
      const s = new Date(now);
      const day = s.getDay();
      s.setDate(s.getDate() - (day === 0 ? 6 : day - 1));
      s.setHours(0,0,0,0);
      return { start: s, end: now };
    }
    case 'this_month': {
      const s = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start: s, end: now };
    }
    case 'last_month': {
      const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const e = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      return { start: s, end: e };
    }
    case 'this_quarter': {
      const q = Math.floor(now.getMonth() / 3);
      const s = new Date(now.getFullYear(), q * 3, 1);
      return { start: s, end: now };
    }
    case 'this_fy': return getFYBounds();
    default: {
      const s = new Date(now); s.setDate(s.getDate() - 30);
      return { start: s, end: now };
    }
  }
}

// ─── AGGREGATE ORDER FINANCIALS ────────────────────────────────────
// Returns detailed financial breakdown for delivered orders in a period
async function aggregateOrderFinancials(branchIds, start, end) {
  const match = {
    branch_id: { $in: branchIds },
    status: 'DELIVERED',
    delivered_at: { $gte: start, $lt: end },
  };

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: null,
        order_count:               { $sum: 1 },
        food_revenue_rs:           { $sum: { $ifNull: ['$subtotal_rs', 0] } },
        food_gst_collected_rs:     { $sum: { $ifNull: ['$food_gst_rs', 0] } },
        delivery_fee_collected_rs: { $sum: { $ifNull: ['$customer_delivery_rs', 0] } },
        delivery_fee_cust_gst_rs:  { $sum: { $ifNull: ['$customer_delivery_gst_rs', 0] } },
        delivery_fee_rest_share_rs:{ $sum: { $ifNull: ['$restaurant_delivery_rs', 0] } },
        delivery_fee_rest_gst_rs:  { $sum: { $ifNull: ['$restaurant_delivery_gst_rs', 0] } },
        packaging_collected_rs:    { $sum: { $ifNull: ['$packaging_rs', 0] } },
        packaging_gst_rs:          { $sum: { $ifNull: ['$packaging_gst_rs', 0] } },
        discount_total_rs:         { $sum: { $ifNull: ['$discount_rs', 0] } },
        platform_fee_rs:           { $sum: { $ifNull: ['$platform_fee_rs', 0] } },
        referral_fee_rs:           { $sum: { $ifNull: ['$referral_fee_rs', 0] } },
        total_collected_rs:        { $sum: { $ifNull: ['$total_rs', 0] } },
      },
    },
  ];

  const [agg] = await col('orders').aggregate(pipeline).toArray();
  if (!agg) {
    return {
      order_count: 0, food_revenue_rs: 0, food_gst_collected_rs: 0,
      delivery_fee_collected_rs: 0, delivery_fee_cust_gst_rs: 0,
      delivery_fee_rest_share_rs: 0, delivery_fee_rest_gst_rs: 0,
      packaging_collected_rs: 0, packaging_gst_rs: 0,
      discount_total_rs: 0, platform_fee_rs: 0, referral_fee_rs: 0,
      total_collected_rs: 0,
    };
  }
  delete agg._id;
  // Round all values
  for (const k of Object.keys(agg)) {
    if (typeof agg[k] === 'number' && k !== 'order_count') agg[k] = round2(agg[k]);
  }
  return agg;
}

// ─── DAILY BREAKDOWN ──────────────────────────────────────────────
async function getDailyBreakdown(branchIds, start, end) {
  const match = {
    branch_id: { $in: branchIds },
    status: 'DELIVERED',
    delivered_at: { $gte: start, $lt: end },
  };

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$delivered_at' } },
        orders:  { $sum: 1 },
        revenue: { $sum: { $ifNull: ['$total_rs', 0] } },
        subtotal:{ $sum: { $ifNull: ['$subtotal_rs', 0] } },
        gst:     { $sum: { $add: [
          { $ifNull: ['$food_gst_rs', 0] },
          { $ifNull: ['$packaging_gst_rs', 0] },
          { $ifNull: ['$customer_delivery_gst_rs', 0] },
        ] } },
        fees:    { $sum: { $ifNull: ['$platform_fee_rs', 0] } },
      },
    },
    { $sort: { _id: 1 } },
  ];

  const days = await col('orders').aggregate(pipeline).toArray();
  return days.map(d => ({
    date: d._id,
    orders: d.orders,
    revenue: round2(d.revenue),
    subtotal: round2(d.subtotal),
    gst: round2(d.gst),
    fees: round2(d.fees),
    net: round2(d.revenue - d.fees),
    avg_order: d.orders ? round2(d.revenue / d.orders) : 0,
  }));
}

// ─── REFUND AGGREGATION ───────────────────────────────────────────
async function getRefundSummary(branchIds, start, end) {
  // Get orders in these branches
  const orderIds = await col('orders').find({
    branch_id: { $in: branchIds },
    delivered_at: { $gte: start, $lt: end },
  }).project({ _id: 1 }).toArray().then(os => os.map(o => String(o._id)));

  if (!orderIds.length) return { total_rs: 0, count: 0, refunds: [] };

  const refunds = await col('payments').find({
    order_id: { $in: orderIds },
    status: 'refunded',
  }).sort({ updated_at: -1 }).toArray();

  const total = refunds.reduce((s, p) => s + (parseFloat(p.amount_rs) || 0), 0);
  return { total_rs: round2(total), count: refunds.length, refunds };
}

// ─── FULL FINANCIAL SUMMARY ────────────────────────────────────────
async function getFinancialSummary(restaurantId, period, from, to) {
  const { start, end } = parsePeriod(period, from, to);

  const branches = await col('branches').find({ restaurant_id: restaurantId }).project({ _id: 1 }).toArray();
  const branchIds = branches.map(b => String(b._id));
  if (!branchIds.length) return emptyFinancialSummary(start, end);

  const restaurant = await col('restaurants').findOne(
    { _id: restaurantId },
    { projection: { commission_pct: 1, gst_number: 1, pan_number: 1, business_name: 1 } },
  );

  const [agg, refundData] = await Promise.all([
    aggregateOrderFinancials(branchIds, start, end),
    getRefundSummary(branchIds, start, end),
  ]);

  const commissionRate = parseFloat(restaurant?.commission_pct || 10) / 100;
  const platformFee = round2(agg.food_revenue_rs * commissionRate);
  const platformFeeGst = round2(platformFee * GST_PLATFORM_FEE_PCT / 100);
  const referralFeeGst = round2(agg.referral_fee_rs * GST_PLATFORM_FEE_PCT / 100);

  const grossCollections = round2(
    agg.food_revenue_rs + agg.food_gst_collected_rs +
    agg.packaging_collected_rs + agg.packaging_gst_rs +
    agg.delivery_fee_collected_rs + agg.delivery_fee_cust_gst_rs
  );

  const totalDeductions = round2(
    platformFee + platformFeeGst +
    agg.delivery_fee_rest_share_rs + agg.delivery_fee_rest_gst_rs +
    agg.discount_total_rs + refundData.total_rs +
    agg.referral_fee_rs + referralFeeGst
  );

  const netEarnings = round2(grossCollections - totalDeductions);

  return {
    period: { start, end },
    order_count: agg.order_count,
    avg_order_value: agg.order_count ? round2(agg.total_collected_rs / agg.order_count) : 0,

    // Revenue
    food_revenue_rs: agg.food_revenue_rs,
    food_gst_collected_rs: agg.food_gst_collected_rs,
    packaging_collected_rs: agg.packaging_collected_rs,
    packaging_gst_rs: agg.packaging_gst_rs,
    delivery_fee_collected_rs: agg.delivery_fee_collected_rs,
    delivery_fee_cust_gst_rs: agg.delivery_fee_cust_gst_rs,
    gross_collections_rs: grossCollections,

    // Deductions
    platform_fee_rs: platformFee,
    platform_fee_gst_rs: platformFeeGst,
    delivery_cost_restaurant_rs: agg.delivery_fee_rest_share_rs,
    delivery_cost_restaurant_gst_rs: agg.delivery_fee_rest_gst_rs,
    discount_total_rs: agg.discount_total_rs,
    refund_total_rs: refundData.total_rs,
    refund_count: refundData.count,
    referral_fee_rs: agg.referral_fee_rs,
    referral_fee_gst_rs: referralFeeGst,
    total_deductions_rs: totalDeductions,

    // Net
    net_earnings_rs: netEarnings,

    // Tax info
    gst_number: restaurant?.gst_number || null,
    pan_number: restaurant?.pan_number ? maskPAN(restaurant.pan_number) : null,
  };
}

function emptyFinancialSummary(start, end) {
  return {
    period: { start, end }, order_count: 0, avg_order_value: 0,
    food_revenue_rs: 0, food_gst_collected_rs: 0,
    packaging_collected_rs: 0, packaging_gst_rs: 0,
    delivery_fee_collected_rs: 0, delivery_fee_cust_gst_rs: 0,
    gross_collections_rs: 0,
    platform_fee_rs: 0, platform_fee_gst_rs: 0,
    delivery_cost_restaurant_rs: 0, delivery_cost_restaurant_gst_rs: 0,
    discount_total_rs: 0, refund_total_rs: 0, refund_count: 0,
    referral_fee_rs: 0, referral_fee_gst_rs: 0, total_deductions_rs: 0,
    net_earnings_rs: 0, gst_number: null, pan_number: null,
  };
}

// ─── TAX SUMMARY (MONTHLY) ────────────────────────────────────────
async function getTaxSummary(restaurantId, fyLabel) {
  const fy = getFYBounds(fyLabel);
  const branches = await col('branches').find({ restaurant_id: restaurantId }).project({ _id: 1 }).toArray();
  const branchIds = branches.map(b => String(b._id));

  const restaurant = await col('restaurants').findOne(
    { _id: restaurantId },
    { projection: { gst_number: 1, pan_number: 1, commission_pct: 1 } },
  );
  const commRate = parseFloat(restaurant?.commission_pct || 10) / 100;

  // Monthly GST aggregation
  const pipeline = [
    {
      $match: {
        branch_id: { $in: branchIds },
        status: 'DELIVERED',
        delivered_at: { $gte: fy.start, $lte: fy.end },
      },
    },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m', date: '$delivered_at' } },
        food_gst: { $sum: { $ifNull: ['$food_gst_rs', 0] } },
        pkg_gst:  { $sum: { $ifNull: ['$packaging_gst_rs', 0] } },
        del_gst:  { $sum: { $ifNull: ['$customer_delivery_gst_rs', 0] } },
        subtotal: { $sum: { $ifNull: ['$subtotal_rs', 0] } },
      },
    },
    { $sort: { _id: 1 } },
  ];

  const months = await col('orders').aggregate(pipeline).toArray();
  const gstMonthly = months.map(m => ({
    month: m._id,
    food_gst_rs: round2(m.food_gst),
    packaging_gst_rs: round2(m.pkg_gst),
    delivery_gst_rs: round2(m.del_gst),
    platform_fee_gst_rs: round2(m.subtotal * commRate * GST_PLATFORM_FEE_PCT / 100),
    total_gst_rs: round2(m.food_gst + m.pkg_gst + m.del_gst + m.subtotal * commRate * GST_PLATFORM_FEE_PCT / 100),
  }));

  // TDS summary from settlements
  const settlements = await col('settlements').find({
    restaurant_id: restaurantId,
    period_end: { $gte: fy.start, $lte: fy.end },
  }).sort({ period_start: 1 }).toArray();

  const tdsEntries = settlements
    .filter(s => s.tds_applicable)
    .map(s => ({
      period: `${s.period_start.toISOString().split('T')[0]} to ${s.period_end.toISOString().split('T')[0]}`,
      gross_payout_rs: round2(s.net_payout_rs + (s.tds_amount_rs || 0)),
      tds_rate_pct: s.tds_rate_pct || 0,
      tds_amount_rs: round2(s.tds_amount_rs || 0),
      section: s.tds_section || TDS_SECTION,
    }));

  const totalTDS = tdsEntries.reduce((s, t) => s + t.tds_amount_rs, 0);

  return {
    fy: fyLabel || getCurrentFYLabel(),
    gst_number: restaurant?.gst_number || null,
    pan_number: restaurant?.pan_number ? maskPAN(restaurant.pan_number) : null,
    has_pan: !!restaurant?.pan_number,
    gst_monthly: gstMonthly,
    tds_entries: tdsEntries,
    tds_total_rs: round2(totalTDS),
    cumulative_payouts_rs: round2(settlements.reduce((s, st) => s + (st.net_payout_rs || 0), 0)),
  };
}

// ─── PLATFORM OVERVIEW (ADMIN) ─────────────────────────────────────
async function getPlatformOverview(period, from, to) {
  const { start, end } = parsePeriod(period, from, to);

  const [orderAgg, refundAgg, settlementAgg, pendingPayouts] = await Promise.all([
    col('orders').aggregate([
      { $match: { status: 'DELIVERED', delivered_at: { $gte: start, $lt: end } } },
      {
        $group: {
          _id: null,
          gmv: { $sum: { $ifNull: ['$total_rs', 0] } },
          subtotal: { $sum: { $ifNull: ['$subtotal_rs', 0] } },
          platform_fees: { $sum: { $ifNull: ['$platform_fee_rs', 0] } },
          delivery_costs: { $sum: { $add: [
            { $ifNull: ['$restaurant_delivery_rs', 0] },
            { $ifNull: ['$restaurant_delivery_gst_rs', 0] },
          ] } },
          referral_fees: { $sum: { $ifNull: ['$referral_fee_rs', 0] } },
          order_count: { $sum: 1 },
        },
      },
    ]).toArray(),
    col('payments').aggregate([
      { $match: { status: 'refunded', updated_at: { $gte: start, $lt: end } } },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$amount_rs', 0] } }, count: { $sum: 1 } } },
    ]).toArray(),
    col('settlements').aggregate([
      { $match: { period_end: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: null,
          total_payouts: { $sum: { $ifNull: ['$net_payout_rs', 0] } },
          total_tds: { $sum: { $ifNull: ['$tds_amount_rs', 0] } },
          count: { $sum: 1 },
        },
      },
    ]).toArray(),
    col('settlements').aggregate([
      { $match: { payout_status: 'pending' } },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$net_payout_rs', 0] } }, count: { $sum: 1 } } },
    ]).toArray(),
  ]);

  const o = orderAgg[0] || { gmv: 0, subtotal: 0, platform_fees: 0, delivery_costs: 0, referral_fees: 0, order_count: 0 };
  const r = refundAgg[0] || { total: 0, count: 0 };
  const s = settlementAgg[0] || { total_payouts: 0, total_tds: 0, count: 0 };
  const p = pendingPayouts[0] || { total: 0, count: 0 };

  const platformFeeGst = round2(o.platform_fees * GST_PLATFORM_FEE_PCT / 100);

  return {
    period: { start, end },
    gmv_rs: round2(o.gmv),
    order_count: o.order_count,
    platform_fee_rs: round2(o.platform_fees),
    platform_fee_gst_rs: platformFeeGst,
    total_payouts_rs: round2(s.total_payouts),
    pending_payouts_rs: round2(p.total),
    pending_payouts_count: p.count,
    total_tds_rs: round2(s.total_tds),
    total_refunds_rs: round2(r.total),
    refund_count: r.count,
    delivery_costs_rs: round2(o.delivery_costs),
    referral_fees_rs: round2(o.referral_fees),
    settlement_count: s.count,
    // Cash flow
    money_in_rs: round2(o.gmv),
    money_out_rs: round2(s.total_payouts + o.delivery_costs + r.total),
  };
}

// ─── PLATFORM TAX SUMMARY (ADMIN) ─────────────────────────────────
async function getPlatformTaxSummary(fyLabel) {
  const fy = getFYBounds(fyLabel);

  // Monthly platform fee GST
  const monthlyGst = await col('orders').aggregate([
    {
      $match: {
        status: 'DELIVERED',
        delivered_at: { $gte: fy.start, $lte: fy.end },
      },
    },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m', date: '$delivered_at' } },
        platform_fees: { $sum: { $ifNull: ['$platform_fee_rs', 0] } },
        subtotal: { $sum: { $ifNull: ['$subtotal_rs', 0] } },
      },
    },
    { $sort: { _id: 1 } },
  ]).toArray();

  const gstMonthly = monthlyGst.map(m => ({
    month: m._id,
    platform_fee_rs: round2(m.platform_fees),
    gst_on_platform_fee_rs: round2(m.platform_fees * GST_PLATFORM_FEE_PCT / 100),
  }));

  // Per-restaurant TDS summary
  const tdsPerRestaurant = await col('settlements').aggregate([
    {
      $match: {
        period_end: { $gte: fy.start, $lte: fy.end },
        tds_applicable: true,
      },
    },
    {
      $group: {
        _id: '$restaurant_id',
        total_payout: { $sum: { $ifNull: ['$net_payout_rs', 0] } },
        total_tds: { $sum: { $ifNull: ['$tds_amount_rs', 0] } },
        settlement_count: { $sum: 1 },
      },
    },
    { $sort: { total_tds: -1 } },
  ]).toArray();

  // Enrich with restaurant names + PAN
  const restIds = tdsPerRestaurant.map(r => r._id);
  const restaurants = restIds.length
    ? await col('restaurants').find({ _id: { $in: restIds } }, { projection: { business_name: 1, pan_number: 1 } }).toArray()
    : [];
  const restMap = Object.fromEntries(restaurants.map(r => [String(r._id), r]));

  const tdsReport = tdsPerRestaurant.map(r => ({
    restaurant_id: r._id,
    name: restMap[r._id]?.business_name || r._id,
    pan: restMap[r._id]?.pan_number || 'NOT PROVIDED',
    total_payout_rs: round2(r.total_payout),
    total_tds_rs: round2(r.total_tds),
    settlements: r.settlement_count,
  }));

  const totalTDS = tdsPerRestaurant.reduce((s, r) => s + r.total_tds, 0);
  const totalGST = gstMonthly.reduce((s, m) => s + m.gst_on_platform_fee_rs, 0);

  return {
    fy: fyLabel || getCurrentFYLabel(),
    gst_monthly: gstMonthly,
    total_platform_gst_rs: round2(totalGST),
    tds_per_restaurant: tdsReport,
    total_tds_rs: round2(totalTDS),
  };
}

// ─── HELPERS ──────────────────────────────────────────────────────
function maskPAN(pan) {
  if (!pan || pan.length < 4) return pan;
  return pan.slice(0, 2) + '*'.repeat(pan.length - 4) + pan.slice(-2);
}

module.exports = {
  calculateTDS,
  getFinancialSummary,
  getDailyBreakdown,
  getRefundSummary,
  getTaxSummary,
  getPlatformOverview,
  getPlatformTaxSummary,
  aggregateOrderFinancials,
  parsePeriod,
  getFYBounds,
  getCurrentFYLabel,
  round2,
  GST_FOOD_PCT,
  GST_PACKAGING_PCT,
  GST_DELIVERY_PCT,
  GST_PLATFORM_FEE_PCT,
  TDS_RATE_WITH_PAN,
  TDS_RATE_NO_PAN,
  TDS_THRESHOLD_RS,
  TDS_SECTION,
};
