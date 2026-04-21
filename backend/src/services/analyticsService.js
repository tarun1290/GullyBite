// src/services/analyticsService.js
// Marketing-analytics aggregation layer. Reads from marketing_campaigns,
// journey_send_log, orders, customer_rfm_profiles, feedback_events and
// loyalty_* to produce per-section summaries for the restaurant's
// Marketing Analytics tab and the admin Platform Marketing section.
//
// Each section function is cached for 1h in the `_cache` collection
// (6h at the platform level). Failures never throw — the top-level
// getFullDashboard parallelises via Promise.allSettled so one bad
// section can't take down the page.

'use strict';

const { col } = require('../config/database');
const cache = require('../config/cache');
const log = require('../utils/logger').child({ component: 'analyticsService' });

const PERIOD_DAYS = { '7d': 7, '30d': 30, '90d': 90, 'all': null };
const SECTION_TTL = 60 * 60;          // 1h per-restaurant section
const PLATFORM_TTL = 6 * 60 * 60;     // 6h platform-level

function normalisePeriod(period) {
  if (period && Object.prototype.hasOwnProperty.call(PERIOD_DAYS, period)) return period;
  return '30d';
}

function periodStart(period) {
  const days = PERIOD_DAYS[normalisePeriod(period)];
  if (days == null) return null;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function key(fn, restaurantId, period) {
  return `analytics_${fn}_${restaurantId}_${normalisePeriod(period)}`;
}

function safeDiv(a, b) {
  const n = Number(a) || 0;
  const d = Number(b) || 0;
  if (d === 0) return 0;
  return n / d;
}

// ---------------------------------------------------------------------
// 1. Campaign summary — marketing_campaigns.stats + per-template ROI.
// ---------------------------------------------------------------------
async function getCampaignSummary(restaurantId, period = '30d') {
  return cache.getCached(key('campaigns', restaurantId, period), async () => {
    const match = { restaurant_id: restaurantId };
    const start = periodStart(period);
    if (start) match.created_at = { $gte: start };

    const campaigns = await col('marketing_campaigns').find(match).toArray();

    const totals = {
      total_campaigns: campaigns.length,
      sent: 0, delivered: 0, read: 0, failed: 0, replied: 0, converted: 0,
      revenue_attributed_rs: 0, spend_rs: 0,
    };
    const byTemplate = new Map();

    for (const c of campaigns) {
      const s = c.stats || {};
      totals.sent      += Number(s.sent || c.actual_sent_count || 0);
      totals.delivered += Number(s.delivered || 0);
      totals.read      += Number(s.read || 0);
      totals.failed    += Number(s.failed || 0);
      totals.replied   += Number(s.replied || 0);
      totals.converted += Number(s.converted || 0);
      totals.revenue_attributed_rs += Number(s.revenue_attributed_rs || 0);
      totals.spend_rs  += Number(c.actual_cost_rs || c.estimated_cost_rs || 0);

      const tplId = c.template_id || 'unknown';
      if (!byTemplate.has(tplId)) {
        byTemplate.set(tplId, {
          template_id: tplId,
          use_case: c.use_case || null,
          campaigns: 0, sent: 0, converted: 0,
          revenue_rs: 0, spend_rs: 0,
        });
      }
      const row = byTemplate.get(tplId);
      row.campaigns += 1;
      row.sent      += Number(s.sent || c.actual_sent_count || 0);
      row.converted += Number(s.converted || 0);
      row.revenue_rs+= Number(s.revenue_attributed_rs || 0);
      row.spend_rs  += Number(c.actual_cost_rs || c.estimated_cost_rs || 0);
    }

    const topTemplates = [...byTemplate.values()]
      .map((r) => ({
        ...r,
        conversion_rate: safeDiv(r.converted, r.sent),
        roi: r.spend_rs > 0 ? r.revenue_rs / r.spend_rs : null,
      }))
      .sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))
      .slice(0, 5);

    return {
      period: normalisePeriod(period),
      totals: {
        ...totals,
        delivery_rate: safeDiv(totals.delivered, totals.sent),
        read_rate:     safeDiv(totals.read, totals.delivered),
        reply_rate:    safeDiv(totals.replied, totals.delivered),
        conversion_rate: safeDiv(totals.converted, totals.sent),
        roi:           totals.spend_rs > 0 ? totals.revenue_attributed_rs / totals.spend_rs : null,
      },
      top_templates: topTemplates,
    };
  }, SECTION_TTL);
}

// ---------------------------------------------------------------------
// 2. Journey summary — journey_send_log grouped by journey_type.
// ---------------------------------------------------------------------
async function getJourneySummary(restaurantId, period = '30d') {
  return cache.getCached(key('journeys', restaurantId, period), async () => {
    const match = { restaurant_id: restaurantId };
    const start = periodStart(period);
    if (start) match.sent_at = { $gte: start };

    const byType = await col('journey_send_log').aggregate([
      { $match: match },
      { $group: { _id: '$journey_type', sends: { $sum: 1 } } },
      { $sort: { sends: -1 } },
    ]).toArray();

    const config = await col('auto_journey_config').findOne({ restaurant_id: restaurantId });
    const journeys = (config && typeof config === 'object') ? config : {};

    return {
      period: normalisePeriod(period),
      total_sends: byType.reduce((a, b) => a + b.sends, 0),
      by_type: byType.map((r) => ({
        journey_type: r._id,
        sends: r.sends,
        enabled: !!(journeys[r._id] && journeys[r._id].enabled),
      })),
    };
  }, SECTION_TTL);
}

// ---------------------------------------------------------------------
// 3. Customer growth — new customers by day, RFM label distribution,
//    acquisition source breakdown.
// ---------------------------------------------------------------------
async function getCustomerGrowth(restaurantId, period = '30d') {
  return cache.getCached(key('customers', restaurantId, period), async () => {
    const match = { restaurant_id: restaurantId };
    const start = periodStart(period);
    if (start) match.first_order_at = { $gte: start };

    const [newByDay, rfmLabels, sources, totals] = await Promise.all([
      col('customer_rfm_profiles').aggregate([
        { $match: { ...match, first_order_at: { $exists: true, $ne: null, ...(start ? { $gte: start } : {}) } } },
        { $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$first_order_at', timezone: 'Asia/Kolkata' } },
            count: { $sum: 1 },
        } },
        { $sort: { _id: 1 } },
      ]).toArray(),
      col('customer_rfm_profiles').aggregate([
        { $match: { restaurant_id: restaurantId } },
        { $group: { _id: '$rfm_label', count: { $sum: 1 } } },
      ]).toArray(),
      col('customer_rfm_profiles').aggregate([
        { $match: { restaurant_id: restaurantId } },
        { $group: { _id: { $ifNull: ['$acquisition_source', 'unknown'] }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]).toArray(),
      col('customer_rfm_profiles').countDocuments({ restaurant_id: restaurantId }),
    ]);

    return {
      period: normalisePeriod(period),
      total_customers: totals,
      new_customers_in_period: newByDay.reduce((a, b) => a + b.count, 0),
      new_by_day: newByDay.map((r) => ({ date: r._id, count: r.count })),
      rfm_distribution: rfmLabels.map((r) => ({ label: r._id || 'unlabeled', count: r.count })),
      acquisition_sources: sources.map((r) => ({ source: r._id, count: r.count })),
    };
  }, SECTION_TTL);
}

// ---------------------------------------------------------------------
// 4. Revenue insights — paid-order totals + AOV + campaign-attributed
//    revenue share.
// ---------------------------------------------------------------------
async function getRevenueInsights(restaurantId, period = '30d') {
  return cache.getCached(key('revenue', restaurantId, period), async () => {
    const match = { restaurant_id: restaurantId, payment_status: 'paid' };
    const start = periodStart(period);
    if (start) match.created_at = { $gte: start };

    const [totals, byDay, campaignRevenueAgg] = await Promise.all([
      col('orders').aggregate([
        { $match: match },
        { $group: {
            _id: null,
            orders: { $sum: 1 },
            revenue_rs: { $sum: { $ifNull: ['$total_rs', 0] } },
            unique_customers: { $addToSet: '$customer_id' },
        } },
      ]).toArray(),
      col('orders').aggregate([
        { $match: match },
        { $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$created_at', timezone: 'Asia/Kolkata' } },
            orders: { $sum: 1 },
            revenue_rs: { $sum: { $ifNull: ['$total_rs', 0] } },
        } },
        { $sort: { _id: 1 } },
      ]).toArray(),
      col('marketing_campaigns').aggregate([
        { $match: { restaurant_id: restaurantId, ...(start ? { created_at: { $gte: start } } : {}) } },
        { $group: {
            _id: null,
            revenue_rs: { $sum: { $ifNull: ['$stats.revenue_attributed_rs', 0] } },
            spend_rs:   { $sum: { $ifNull: ['$actual_cost_rs', 0] } },
        } },
      ]).toArray(),
    ]);

    const t = totals[0] || {};
    const orders = Number(t.orders || 0);
    const revenue = Number(t.revenue_rs || 0);
    const uniq = Array.isArray(t.unique_customers) ? t.unique_customers.length : 0;
    const camp = campaignRevenueAgg[0] || {};

    return {
      period: normalisePeriod(period),
      orders,
      unique_customers: uniq,
      revenue_rs: revenue,
      aov_rs: safeDiv(revenue, orders),
      campaign_attributed_revenue_rs: Number(camp.revenue_rs || 0),
      campaign_attributed_share: safeDiv(camp.revenue_rs, revenue),
      marketing_spend_rs: Number(camp.spend_rs || 0),
      net_marketing_contribution_rs: Number(camp.revenue_rs || 0) - Number(camp.spend_rs || 0),
      by_day: byDay.map((r) => ({ date: r._id, orders: r.orders, revenue_rs: r.revenue_rs })),
    };
  }, SECTION_TTL);
}

// ---------------------------------------------------------------------
// 5. Feedback insights — rating distribution, review link CTR, positive
//    share, breakdown by source.
// ---------------------------------------------------------------------
async function getFeedbackInsights(restaurantId, period = '30d') {
  return cache.getCached(key('feedback', restaurantId, period), async () => {
    const match = { restaurant_id: restaurantId };
    const start = periodStart(period);
    if (start) match.created_at = { $gte: start };

    const [totals, byRating, bySource] = await Promise.all([
      col('feedback_events').aggregate([
        { $match: match },
        { $group: {
            _id: null,
            total: { $sum: 1 },
            positives: { $sum: { $cond: [{ $eq: ['$is_positive', true] }, 1, 0] } },
            review_sent: { $sum: { $cond: [{ $ifNull: ['$review_link_sent_at', false] }, 1, 0] } },
            review_clicks: { $sum: { $cond: [{ $eq: ['$review_link_clicked', true] }, 1, 0] } },
            avg_rating: { $avg: '$rating' },
        } },
      ]).toArray(),
      col('feedback_events').aggregate([
        { $match: match },
        { $group: { _id: '$rating', count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]).toArray(),
      col('feedback_events').aggregate([
        { $match: match },
        { $group: { _id: { $ifNull: ['$source', 'unknown'] }, count: { $sum: 1 }, avg_rating: { $avg: '$rating' } } },
      ]).toArray(),
    ]);

    const t = totals[0] || {};
    return {
      period: normalisePeriod(period),
      total: Number(t.total || 0),
      avg_rating: t.avg_rating != null ? Number(t.avg_rating.toFixed(2)) : null,
      positive_share: safeDiv(t.positives, t.total),
      review_link_ctr: safeDiv(t.review_clicks, t.review_sent),
      rating_distribution: byRating.map((r) => ({ rating: r._id, count: r.count })),
      by_source: bySource.map((r) => ({
        source: r._id,
        count: r.count,
        avg_rating: r.avg_rating != null ? Number(r.avg_rating.toFixed(2)) : null,
      })),
    };
  }, SECTION_TTL);
}

// ---------------------------------------------------------------------
// 6. Loyalty summary — program state, enrolled customers, points
//    outstanding (liability in ₹), redemption count & amount.
// ---------------------------------------------------------------------
async function getLoyaltySummary(restaurantId, period = '30d') {
  return cache.getCached(key('loyalty', restaurantId, period), async () => {
    const start = periodStart(period);
    const txMatch = { restaurant_id: restaurantId };
    if (start) txMatch.created_at = { $gte: start };

    const [config, points, txAgg, enrolled] = await Promise.all([
      col('loyalty_config').findOne({ restaurant_id: restaurantId }),
      col('loyalty_points').aggregate([
        { $match: { restaurant_id: restaurantId } },
        { $group: {
            _id: null,
            outstanding_points: { $sum: { $ifNull: ['$points_balance', 0] } },
            lifetime_points: { $sum: { $ifNull: ['$lifetime_points', 0] } },
        } },
      ]).toArray(),
      col('loyalty_transactions').aggregate([
        { $match: txMatch },
        { $group: {
            _id: '$type',
            count: { $sum: 1 },
            points: { $sum: { $ifNull: ['$points', 0] } },
        } },
      ]).toArray(),
      col('loyalty_points').countDocuments({
        restaurant_id: restaurantId,
        points_balance: { $gt: 0 },
      }),
    ]);

    const ratio = Number((config && config.points_to_rupee_ratio) || 1);
    const p = points[0] || {};
    const txByType = Object.fromEntries(txAgg.map((r) => [r._id, r]));

    const earnPts   = Math.abs(Number((txByType.earn && txByType.earn.points) || 0));
    const redeemPts = Math.abs(Number((txByType.redeem && txByType.redeem.points) || 0));
    const expirePts = Math.abs(Number((txByType.expire && txByType.expire.points) || 0));

    return {
      period: normalisePeriod(period),
      program_active: !!(config && config.is_active),
      program_name: (config && config.program_name) || null,
      enrolled_customers: enrolled,
      outstanding_points: Number(p.outstanding_points || 0),
      outstanding_liability_rs: Number(p.outstanding_points || 0) / (ratio > 0 ? ratio : 1),
      lifetime_points: Number(p.lifetime_points || 0),
      points_earned_in_period: earnPts,
      points_redeemed_in_period: redeemPts,
      points_expired_in_period: expirePts,
      redemption_count_in_period: Number((txByType.redeem && txByType.redeem.count) || 0),
      redemption_value_rs: redeemPts / (ratio > 0 ? ratio : 1),
    };
  }, SECTION_TTL);
}

// ---------------------------------------------------------------------
// Orchestrator — kicks off all six in parallel; a failing section
// resolves to null so the page can still render the rest.
// ---------------------------------------------------------------------
async function getFullDashboard(restaurantId, period = '30d') {
  const tasks = [
    ['campaigns', () => getCampaignSummary(restaurantId, period)],
    ['journeys',  () => getJourneySummary(restaurantId, period)],
    ['customers', () => getCustomerGrowth(restaurantId, period)],
    ['revenue',   () => getRevenueInsights(restaurantId, period)],
    ['feedback',  () => getFeedbackInsights(restaurantId, period)],
    ['loyalty',   () => getLoyaltySummary(restaurantId, period)],
  ];
  const settled = await Promise.allSettled(tasks.map(([, fn]) => fn()));
  const out = { period: normalisePeriod(period) };
  settled.forEach((r, i) => {
    const name = tasks[i][0];
    if (r.status === 'fulfilled') {
      out[name] = r.value;
    } else {
      log.warn({ restaurantId, section: name, err: r.reason }, 'analytics section failed');
      out[name] = null;
    }
  });
  return out;
}

// ---------------------------------------------------------------------
// Admin platform-wide snapshot. 6h cache.
// ---------------------------------------------------------------------
async function getPlatformSnapshot(period = '30d') {
  const p = normalisePeriod(period);
  return cache.getCached(`analytics_platform_${p}`, async () => {
    const start = periodStart(p);
    const campMatch = start ? { created_at: { $gte: start } } : {};
    const orderMatch = { payment_status: 'paid', ...(start ? { created_at: { $gte: start } } : {}) };
    const fbMatch = start ? { created_at: { $gte: start } } : {};
    const journeyMatch = start ? { sent_at: { $gte: start } } : {};

    const [campTotals, orderTotals, fbTotals, journeySends, topRoi, activeRestaurants, activeLoyalty] = await Promise.all([
      col('marketing_campaigns').aggregate([
        { $match: campMatch },
        { $group: {
            _id: null,
            campaigns: { $sum: 1 },
            sent: { $sum: { $ifNull: ['$stats.sent', 0] } },
            delivered: { $sum: { $ifNull: ['$stats.delivered', 0] } },
            converted: { $sum: { $ifNull: ['$stats.converted', 0] } },
            revenue_rs: { $sum: { $ifNull: ['$stats.revenue_attributed_rs', 0] } },
            spend_rs: { $sum: { $ifNull: ['$actual_cost_rs', 0] } },
        } },
      ]).toArray(),
      col('orders').aggregate([
        { $match: orderMatch },
        { $group: {
            _id: null,
            orders: { $sum: 1 },
            revenue_rs: { $sum: { $ifNull: ['$total_rs', 0] } },
            active_restaurants: { $addToSet: '$restaurant_id' },
        } },
      ]).toArray(),
      col('feedback_events').aggregate([
        { $match: fbMatch },
        { $group: {
            _id: null,
            total: { $sum: 1 },
            positives: { $sum: { $cond: [{ $eq: ['$is_positive', true] }, 1, 0] } },
            avg_rating: { $avg: '$rating' },
        } },
      ]).toArray(),
      col('journey_send_log').countDocuments(journeyMatch),
      col('marketing_campaigns').aggregate([
        { $match: { ...campMatch, actual_cost_rs: { $gt: 0 } } },
        { $group: {
            _id: '$restaurant_id',
            campaigns: { $sum: 1 },
            revenue_rs: { $sum: { $ifNull: ['$stats.revenue_attributed_rs', 0] } },
            spend_rs:   { $sum: { $ifNull: ['$actual_cost_rs', 0] } },
        } },
        { $addFields: { roi: { $cond: [{ $gt: ['$spend_rs', 0] }, { $divide: ['$revenue_rs', '$spend_rs'] }, 0] } } },
        { $sort: { roi: -1 } },
        { $limit: 5 },
      ]).toArray(),
      col('restaurants').countDocuments({ campaigns_enabled: true }),
      col('loyalty_config').countDocuments({ is_active: true }),
    ]);

    const ct = campTotals[0] || {};
    const ot = orderTotals[0] || {};
    const ft = fbTotals[0] || {};

    // Resolve restaurant names for the ROI leaderboard.
    const restaurantIds = topRoi.map((r) => r._id).filter(Boolean);
    const names = restaurantIds.length
      ? await col('restaurants').find({ _id: { $in: restaurantIds } })
          .project({ _id: 1, name: 1, restaurant_name: 1 }).toArray()
      : [];
    const nameMap = new Map(names.map((r) => [r._id, r.name || r.restaurant_name || 'Unknown']));

    return {
      period: p,
      totals: {
        campaigns: Number(ct.campaigns || 0),
        messages_sent: Number(ct.sent || 0),
        delivery_rate: safeDiv(ct.delivered, ct.sent),
        conversions: Number(ct.converted || 0),
        revenue_attributed_rs: Number(ct.revenue_rs || 0),
        marketing_spend_rs: Number(ct.spend_rs || 0),
        platform_roi: ct.spend_rs > 0 ? Number(ct.revenue_rs || 0) / Number(ct.spend_rs) : null,
        paid_orders: Number(ot.orders || 0),
        paid_revenue_rs: Number(ot.revenue_rs || 0),
        transacting_restaurants: Array.isArray(ot.active_restaurants) ? ot.active_restaurants.length : 0,
        feedback_total: Number(ft.total || 0),
        feedback_positive_share: safeDiv(ft.positives, ft.total),
        feedback_avg_rating: ft.avg_rating != null ? Number(ft.avg_rating.toFixed(2)) : null,
        journey_sends: Number(journeySends || 0),
      },
      top_restaurants_by_roi: topRoi.map((r) => ({
        restaurant_id: r._id,
        restaurant_name: nameMap.get(r._id) || 'Unknown',
        campaigns: r.campaigns,
        revenue_rs: r.revenue_rs,
        spend_rs: r.spend_rs,
        roi: r.roi,
      })),
      counts: {
        restaurants_with_campaigns_enabled: Number(activeRestaurants || 0),
        restaurants_with_loyalty_active: Number(activeLoyalty || 0),
      },
    };
  }, PLATFORM_TTL);
}

module.exports = {
  getCampaignSummary,
  getJourneySummary,
  getCustomerGrowth,
  getRevenueInsights,
  getFeedbackInsights,
  getLoyaltySummary,
  getFullDashboard,
  getPlatformSnapshot,
  // exported for tests / admin cache-invalidation
  PERIOD_DAYS,
};
