'use strict';

// Unified feedback & review funnel service (Prompt 8).
//
// Every feedback request the platform sends — automated post-delivery
// rating prompt, merchant-triggered dine-in rating, future journey
// variants — runs through here so the dashboard has one source of
// truth for ratings, escalations, and review-link conversions.
//
// Responsibilities:
//   createFeedbackRequest  — insert a 'sent' row, stamp wa_message_id
//                            when we have one from the Graph API.
//   recordRating           — inbound WA reply → update row, set
//                            is_positive, kick routing in the
//                            background.
//   handleRatingRouting    — 3-min delay then branch on score: high
//                            → send a Google/Zomato review nudge,
//                            low → escalate to the merchant via a
//                            restaurant_notifications row + socket.
//   getUnifiedRating       — rollups for the dashboard overview card.
//   getEscalations         — paginated list for the escalation inbox.
//   resolveEscalation      — merchant-acknowledged state transition.

const { col, newId } = require('../config/database');
const log = require('../utils/logger').child({ component: 'feedback-service' });
const wa = require('./whatsapp');
const wsvc = require('./websocket');

// 3 minutes between reply and review-link / escalation — gives the
// customer a moment to expand their rating into text feedback before
// we commit to the positive or negative branch.
const ROUTING_DELAY_MS = 3 * 60 * 1000;

const BASE_URL = () => {
  const v = process.env.BASE_URL;
  if (!v) throw new Error('BASE_URL is not set; cannot build review-redirect URL');
  return v.replace(/\/+$/, '');
};

function isPositiveScore(score) {
  return Number(score) >= 4;
}

// ─── CREATE ────────────────────────────────────────────────────
// Shared entry point for every outgoing feedback prompt. `waMessageId`
// is set later by the caller once the Graph API returns — dine-in and
// post-delivery flows both do this so inbound replies can match by
// context.id.
async function createFeedbackRequest({
  restaurantId,
  outletId = null,
  customerId = null,
  customerPhone = null,
  source,            // 'delivery' | 'dine_in' | 'reorder'
  orderId = null,
  waMessageId = null,
  triggeredBy = 'system',
}) {
  if (!restaurantId || !source) {
    throw new Error('createFeedbackRequest: restaurantId and source are required');
  }
  const doc = {
    _id: newId(),
    restaurant_id: String(restaurantId),
    outlet_id: outletId ? String(outletId) : null,
    customer_id: customerId ? String(customerId) : null,
    customer_phone: customerPhone || null,
    source,
    order_id: orderId ? String(orderId) : null,
    rating: null,
    feedback_text: null,
    status: 'sent',
    is_positive: null,
    review_link_clicked: false,
    review_link_sent_at: null,
    escalated_at: null,
    escalation_resolved_at: null,
    escalation_note: null,
    triggered_by: triggeredBy ? String(triggeredBy) : 'system',
    wa_message_id: waMessageId || null,
    created_at: new Date(),
    updated_at: new Date(),
  };
  await col('feedback_events').insertOne(doc);
  return doc;
}

// ─── FIND BY INBOUND MESSAGE ───────────────────────────────────
// Used by the WA webhook to attach an incoming rating reply to the
// originating feedback_events row. Prefers wa_message_id (exact match
// via context.id), falls back to the most recent 'sent' row for the
// phone within 24h.
async function findPendingByReply({ waMessageId, customerPhone, restaurantId }) {
  if (waMessageId) {
    const byMsg = await col('feedback_events').findOne({ wa_message_id: waMessageId });
    if (byMsg) return byMsg;
  }
  if (!customerPhone) return null;
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const q = {
    customer_phone: customerPhone,
    status: 'sent',
    created_at: { $gte: cutoff },
  };
  if (restaurantId) q.restaurant_id = String(restaurantId);
  return col('feedback_events')
    .find(q)
    .sort({ created_at: -1 })
    .limit(1)
    .next();
}

// ─── RECORD RATING ─────────────────────────────────────────────
async function recordRating({ feedbackEventId, rating, feedbackText = null }) {
  const score = Math.max(0, Math.min(5, Math.floor(Number(rating) || 0)));
  const positive = isPositiveScore(score);
  const now = new Date();

  const row = await col('feedback_events').findOneAndUpdate(
    { _id: feedbackEventId },
    {
      $set: {
        rating: score,
        feedback_text: feedbackText,
        is_positive: positive,
        status: positive ? 'rated_positive' : 'rated_negative',
        updated_at: now,
      },
    },
    { returnDocument: 'after' }
  );
  const doc = row?.value || row; // driver compat
  if (!doc) return null;

  // Fire-and-forget routing — do not block the webhook response.
  setTimeout(() => {
    handleRatingRouting(doc._id).catch((err) => {
      log.warn({ err, feedbackEventId: doc._id }, 'rating routing failed');
    });
  }, ROUTING_DELAY_MS);

  return doc;
}

// ─── ROUTING ───────────────────────────────────────────────────
// Runs after a short delay. Re-reads the row in case the merchant
// already resolved it (e.g. in-person follow-up) and no-ops if the
// status has moved on.
async function handleRatingRouting(feedbackEventId) {
  const row = await col('feedback_events').findOne({ _id: feedbackEventId });
  if (!row) return;
  if (row.status !== 'rated_positive' && row.status !== 'rated_negative') return;

  const restaurant = await col('restaurants').findOne({ _id: row.restaurant_id });
  if (!restaurant) return;

  if (row.is_positive) {
    await _sendReviewLink(row, restaurant);
  } else {
    await _escalate(row, restaurant);
  }
}

async function _sendReviewLink(row, restaurant) {
  const google = restaurant?.google_review_link;
  const zomato = restaurant?.zomato_review_link;
  if (!google && !zomato) {
    log.info({ restaurantId: restaurant._id, feedbackEventId: row._id }, 'no review links configured — skipping nudge');
    return;
  }
  if (!row.customer_phone) {
    log.info({ feedbackEventId: row._id }, 'no customer_phone on feedback_event — cannot send review link');
    return;
  }

  // Resolve outbound WA account so we can send the nudge.
  const wa_acc = await col('whatsapp_accounts').findOne({ restaurant_id: row.restaurant_id });
  if (!wa_acc) {
    log.warn({ restaurantId: row.restaurant_id }, 'no whatsapp_accounts row for review link send');
    return;
  }

  const base = BASE_URL();
  const gUrl = google ? `${base}/api/review-redirect/${row._id}` : null;
  const zUrl = zomato ? `${base}/api/review-redirect/${row._id}/zomato` : null;

  const lines = [
    `Thanks for the ${row.rating}\u2B50 rating, ${restaurant.business_name || 'we appreciate it'}!`,
    '',
    'Would you share a quick review? It helps other diners find us.',
  ];
  if (gUrl) lines.push(`\u2728 Google: ${gUrl}`);
  if (zUrl) lines.push(`\uD83C\uDF7D Zomato: ${zUrl}`);

  try {
    await wa.sendText(wa_acc.phone_number_id, wa_acc.access_token, row.customer_phone, lines.join('\n'));
    await col('feedback_events').updateOne(
      { _id: row._id },
      { $set: { review_link_sent_at: new Date(), updated_at: new Date() } }
    );
    // Lightweight positive-feedback ping for the bell — helpful so
    // the merchant sees happy customers rolling in, not just fires.
    await _notify(restaurant._id, {
      type: 'feedback_positive',
      title: `${row.rating}\u2B50 rating received`,
      body: row.feedback_text || null,
      data: { feedback_event_id: row._id, rating: row.rating, source: row.source },
    });
  } catch (err) {
    log.warn({ err, feedbackEventId: row._id }, 'review link send failed');
  }
}

async function _escalate(row, restaurant) {
  const now = new Date();
  await col('feedback_events').updateOne(
    { _id: row._id, status: 'rated_negative' },
    { $set: { status: 'escalated', escalated_at: now, updated_at: now } }
  );
  await _notify(restaurant._id, {
    type: 'feedback_escalation',
    title: `${row.rating}\u2B50 negative rating \u2014 action needed`,
    body: row.feedback_text || 'Customer left a low rating but no written feedback.',
    data: {
      feedback_event_id: row._id,
      rating: row.rating,
      source: row.source,
      order_id: row.order_id || null,
      customer_phone: row.customer_phone || null,
    },
  });
}

async function _notify(restaurantId, { type, title, body, data }) {
  const note = {
    _id: newId(),
    restaurant_id: String(restaurantId),
    type,
    title,
    body: body || null,
    data: data || {},
    is_read: false,
    created_at: new Date(),
  };
  try {
    await col('restaurant_notifications').insertOne(note);
  } catch (err) {
    log.warn({ err, restaurantId }, 'notification insert failed');
    return;
  }
  try {
    wsvc.broadcastToRestaurant(String(restaurantId), {
      type: 'restaurant.notification',
      payload: note,
    });
  } catch (err) {
    log.warn({ err, restaurantId }, 'notification broadcast failed');
  }
}

// ─── UNIFIED RATING ROLLUPS ────────────────────────────────────
async function getUnifiedRating(restaurantId, { sinceDays = null } = {}) {
  const match = { restaurant_id: String(restaurantId), rating: { $ne: null } };
  if (sinceDays) {
    match.created_at = { $gte: new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000) };
  }
  const [overall] = await col('feedback_events').aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        sum: { $sum: '$rating' },
        positives: { $sum: { $cond: [{ $gte: ['$rating', 4] }, 1, 0] } },
        review_clicks: { $sum: { $cond: ['$review_link_clicked', 1, 0] } },
        review_sent: { $sum: { $cond: [{ $ne: ['$review_link_sent_at', null] }, 1, 0] } },
      },
    },
  ]).toArray();

  const bySource = await col('feedback_events').aggregate([
    { $match: match },
    {
      $group: {
        _id: '$source',
        count: { $sum: 1 },
        sum: { $sum: '$rating' },
      },
    },
  ]).toArray();

  const total = overall?.count || 0;
  const avg = total > 0 ? (overall.sum / total) : 0;
  const sourceBreakdown = {};
  for (const s of bySource) {
    sourceBreakdown[s._id] = {
      count: s.count,
      avg: s.count > 0 ? Math.round((s.sum / s.count) * 10) / 10 : 0,
    };
  }

  return {
    total_ratings: total,
    average_rating: Math.round(avg * 10) / 10,
    positive_ratings: overall?.positives || 0,
    review_link_sent: overall?.review_sent || 0,
    review_link_clicks: overall?.review_clicks || 0,
    review_click_rate: (overall?.review_sent || 0) > 0
      ? Math.round(((overall.review_clicks / overall.review_sent) * 100) * 10) / 10
      : 0,
    by_source: sourceBreakdown,
    window_days: sinceDays || null,
  };
}

// ─── ESCALATIONS ───────────────────────────────────────────────
async function getEscalations(restaurantId, { includeResolved = false, limit = 50, skip = 0 } = {}) {
  const q = { restaurant_id: String(restaurantId) };
  q.status = includeResolved ? { $in: ['escalated', 'resolved'] } : 'escalated';
  const [rows, total] = await Promise.all([
    col('feedback_events').find(q).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
    col('feedback_events').countDocuments(q),
  ]);
  return { escalations: rows, total };
}

async function resolveEscalation({ restaurantId, feedbackEventId, note = null, actorId = null }) {
  const now = new Date();
  const patch = {
    status: 'resolved',
    escalation_resolved_at: now,
    updated_at: now,
  };
  if (note) patch.escalation_note = String(note).substring(0, 500);
  const res = await col('feedback_events').findOneAndUpdate(
    { _id: feedbackEventId, restaurant_id: String(restaurantId), status: 'escalated' },
    { $set: patch },
    { returnDocument: 'after' }
  );
  const doc = res?.value || res;
  if (!doc) return null;
  if (actorId) {
    log.info({ actorId, feedbackEventId }, 'escalation resolved');
  }
  return doc;
}

module.exports = {
  createFeedbackRequest,
  findPendingByReply,
  recordRating,
  handleRatingRouting,
  getUnifiedRating,
  getEscalations,
  resolveEscalation,
  isPositiveScore,
};
