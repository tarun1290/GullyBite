'use strict';

// Campaign ROI analytics.
// Real-time aggregate of (messages sent, total cost, orders generated,
// revenue) per campaign. Pulls from marketing_messages for cost (so the
// number reflects Meta's billed cost once the pricing webhook lands)
// and from campaign_messages as a fallback for the send count if the
// webhook hasn't arrived yet. Revenue comes from orders keyed on
// attributed_campaign_id.
//
// Intentionally NOT using settlement data — ROI must stay real-time.

const { col } = require('../config/database');

// Orders that count toward revenue — exclude unpaid / cancelled.
// Keep the set conservative so a wobbling PENDING_PAYMENT order never
// inflates ROI. If the spec ever needs "all placed orders", widen here.
const REVENUE_ORDER_STATUSES = [
  'PAID', 'CONFIRMED', 'PREPARING', 'PACKED', 'DISPATCHED', 'DELIVERED',
];

function _parseDateRange({ from, to } = {}) {
  const out = {};
  if (from) out.$gte = new Date(from);
  if (to)   out.$lt  = new Date(new Date(to).getTime() + 24 * 60 * 60 * 1000);
  return Object.keys(out).length ? out : null;
}

// ─── PER-CAMPAIGN AGGREGATE ─────────────────────────────────
// Returns one row per campaign:
//   { campaign_id, campaign_name, type, created_at,
//     messages_sent, cost, orders_generated, revenue, roi }
// `filter.restaurantId` scopes to a tenant; admin calls omit it.
async function getAnalytics({ restaurantId, from, to } = {}) {
  const dateRange = _parseDateRange({ from, to });

  // Campaigns in scope.
  const campaignFilter = {};
  if (restaurantId) campaignFilter.restaurant_id = String(restaurantId);
  if (dateRange)    campaignFilter.created_at    = dateRange;

  const campaigns = await col('campaigns')
    .find(campaignFilter)
    .project({ _id: 1, name: 1, restaurant_id: 1, created_at: 1, stats: 1, send_method: 1 })
    .toArray();

  if (!campaigns.length) return [];
  const ids = campaigns.map(c => c._id);

  // Cost + message count from marketing_messages (authoritative once
  // Meta pricing webhook has landed). campaign_messages count is used
  // as a fallback for the "sent" metric when the webhook hasn't
  // arrived — ROI ignores those because cost is 0 for them.
  const mmAgg = await col('marketing_messages').aggregate([
    { $match: { campaign_id: { $in: ids } } },
    { $group: {
        _id: '$campaign_id',
        cost: { $sum: { $ifNull: ['$cost', 0] } },
        messages: { $sum: 1 },
    } },
  ]).toArray();
  const mmByCampaign = Object.fromEntries(mmAgg.map(r => [r._id, r]));

  // campaign_messages count — authoritative send count even before Meta
  // confirms pricing.
  const cmAgg = await col('campaign_messages').aggregate([
    { $match: { campaign_id: { $in: ids } } },
    { $group: { _id: '$campaign_id', sent: { $sum: 1 } } },
  ]).toArray();
  const cmByCampaign = Object.fromEntries(cmAgg.map(r => [r._id, r.sent]));

  // Orders attributed to these campaigns.
  const ordAgg = await col('orders').aggregate([
    { $match: {
        attributed_campaign_id: { $in: ids },
        status: { $in: REVENUE_ORDER_STATUSES },
    } },
    { $group: {
        _id: '$attributed_campaign_id',
        orders: { $sum: 1 },
        revenue: { $sum: { $ifNull: ['$total_rs', 0] } },
    } },
  ]).toArray();
  const ordByCampaign = Object.fromEntries(ordAgg.map(r => [r._id, r]));

  return campaigns.map(c => {
    const mm = mmByCampaign[c._id];
    const cmSent = cmByCampaign[c._id] || 0;
    const ord = ordByCampaign[c._id] || { orders: 0, revenue: 0 };
    const cost = mm?.cost || 0;
    const messagesSent = cmSent || mm?.messages || 0;
    const revenue = ord.revenue || 0;
    const roi = cost > 0 ? revenue / cost : null;
    return {
      campaign_id: c._id,
      restaurant_id: c.restaurant_id,
      campaign_name: c.name || '—',
      type: c.send_method === 'mm_lite' ? 'automation' : 'broadcast',
      created_at: c.created_at,
      messages_sent: messagesSent,
      cost,
      orders_generated: ord.orders || 0,
      revenue,
      roi,
    };
  });
}

module.exports = { getAnalytics, REVENUE_ORDER_STATUSES };
