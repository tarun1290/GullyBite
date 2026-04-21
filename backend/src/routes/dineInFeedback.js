'use strict';

// Unified feedback & review funnel routes.
// Mounted at /api/restaurant/feedback.
//
// Endpoints:
//   POST  /dine-in/send             — merchant triggers a 1-5 star prompt
//                                     via WhatsApp list message.
//   GET   /events                   — paginated feedback_events feed.
//   GET   /stats                    — unified rating overview +
//                                     30-day / all-time toggle.
//   GET   /escalations              — escalation inbox (open or all).
//   PATCH /escalations/:id/resolve  — mark escalation resolved.
//   GET   /notifications            — dashboard bell feed.
//   PATCH /notifications/:id/read   — single-row ack.
//   PATCH /notifications/read-all   — mass ack.
//   GET   /settings/review-links    — google + zomato review URLs.
//   PATCH /settings/review-links    — update one or both URLs.

const express = require('express');
const { col } = require('../config/database');
const { requireAuth } = require('./auth');
const feedbackSvc = require('../services/feedbackService');
const wa = require('../services/whatsapp');
const { hashPhone } = require('../utils/phoneHash');
const log = require('../utils/logger').child({ component: 'feedback-routes' });

const router = express.Router();
router.use(requireAuth);

function normPhone(raw) {
  const s = String(raw || '').trim();
  return s.replace(/\D+/g, '');
}

function sanitiseUrl(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) return { error: 'URL must start with http:// or https://' };
  if (s.length > 1000) return { error: 'URL too long' };
  return s;
}

// ─── POST /dine-in/send ────────────────────────────────────────
// Merchant enters a phone (+ optional customer name / order ref),
// backend creates a feedback_events row, sends a WA list message
// with 5 star options, and records wa_message_id on the row so
// the inbound reply handler can match it.
router.post('/dine-in/send', async (req, res) => {
  const { phone, customer_name, outlet_id, order_ref } = req.body || {};
  const phoneNorm = normPhone(phone);
  if (!phoneNorm) return res.status(400).json({ error: 'phone required' });

  const restaurantId = req.restaurantId;
  const restaurant = await col('restaurants').findOne({ _id: restaurantId });
  if (!restaurant) return res.status(404).json({ error: 'restaurant_not_found' });

  const wa_acc = await col('whatsapp_accounts').findOne({ restaurant_id: restaurantId });
  if (!wa_acc) return res.status(400).json({ error: 'whatsapp_account_not_configured' });

  // Try to attach the existing customer row (best effort — we also
  // happily send prompts to walk-ins we've never seen before).
  let customer = null;
  try {
    const ph = hashPhone(phoneNorm);
    customer = await col('customers').findOne({ phone_hash: ph });
  } catch (_) { /* fallback below */ }
  if (!customer) customer = await col('customers').findOne({ wa_phone: phoneNorm });

  const fb = await feedbackSvc.createFeedbackRequest({
    restaurantId,
    outletId: outlet_id || null,
    customerId: customer?._id || null,
    customerPhone: phoneNorm,
    source: 'dine_in',
    orderId: order_ref ? String(order_ref) : null,
    triggeredBy: req.userId || req.restaurantId,
  });

  const greeting = customer_name ? `Hi ${String(customer_name).split(/\s+/)[0]}! ` : 'Hi! ';
  const body = `${greeting}How was your visit to ${restaurant.business_name || 'us'}? Tap a star to rate \u2014 your feedback helps us serve better.`;
  const sections = [{
    title: 'Rate your visit',
    rows: [
      { id: `dinein-rating-${fb._id}-5`, title: '\u2B50\u2B50\u2B50\u2B50\u2B50 Excellent', description: '5 \u2014 Loved it' },
      { id: `dinein-rating-${fb._id}-4`, title: '\u2B50\u2B50\u2B50\u2B50 Great',         description: '4 \u2014 Really good' },
      { id: `dinein-rating-${fb._id}-3`, title: '\u2B50\u2B50\u2B50 Okay',                description: '3 \u2014 Just fine' },
      { id: `dinein-rating-${fb._id}-2`, title: '\u2B50\u2B50 Below average',             description: '2 \u2014 Not great' },
      { id: `dinein-rating-${fb._id}-1`, title: '\u2B50 Poor',                            description: '1 \u2014 Needs work' },
    ],
  }];

  let sendResult = null;
  try {
    sendResult = await wa.sendList(wa_acc.phone_number_id, wa_acc.access_token, phoneNorm, {
      body,
      footer: restaurant.business_name || undefined,
      buttonText: 'Rate now',
      sections,
    });
  } catch (err) {
    log.warn({ err, feedbackEventId: fb._id }, 'dine-in send failed');
    await col('feedback_events').deleteOne({ _id: fb._id });
    return res.status(502).json({ error: 'whatsapp_send_failed', reason: err?.response?.data?.error?.message || err.message });
  }

  const waMessageId = sendResult?.messages?.[0]?.id || null;
  if (waMessageId) {
    await col('feedback_events').updateOne(
      { _id: fb._id },
      { $set: { wa_message_id: waMessageId, updated_at: new Date() } }
    );
  }

  res.json({
    ok: true,
    feedback_event: { id: fb._id, status: 'sent', customer_phone: phoneNorm, wa_message_id: waMessageId },
  });
});

// ─── GET /events ───────────────────────────────────────────────
router.get('/events', async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 25);
  const skip  = (page - 1) * limit;
  const q = { restaurant_id: req.restaurantId };
  if (req.query.source) q.source = String(req.query.source);
  if (req.query.status) q.status = String(req.query.status);

  const [rows, total] = await Promise.all([
    col('feedback_events').find(q).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
    col('feedback_events').countDocuments(q),
  ]);
  res.json({ events: rows, total, page, pages: Math.ceil(total / limit) });
});

// ─── GET /stats ────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  const window = req.query.window === '30d' ? 30 : null;
  const data = await feedbackSvc.getUnifiedRating(req.restaurantId, { sinceDays: window });
  res.json(data);
});

// ─── GET /escalations ─────────────────────────────────────────
router.get('/escalations', async (req, res) => {
  const includeResolved = String(req.query.include_resolved || '').toLowerCase() === 'true';
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
  const data = await feedbackSvc.getEscalations(req.restaurantId, { includeResolved, limit });
  res.json(data);
});

// ─── PATCH /escalations/:id/resolve ───────────────────────────
router.patch('/escalations/:id/resolve', async (req, res) => {
  const { note } = req.body || {};
  const doc = await feedbackSvc.resolveEscalation({
    restaurantId: req.restaurantId,
    feedbackEventId: req.params.id,
    note: note || null,
    actorId: req.userId || null,
  });
  if (!doc) return res.status(404).json({ error: 'escalation_not_found_or_not_open' });
  res.json(doc);
});

// ─── GET /notifications ───────────────────────────────────────
router.get('/notifications', async (req, res) => {
  const limit = Math.min(50, parseInt(req.query.limit, 10) || 10);
  const [rows, unread] = await Promise.all([
    col('restaurant_notifications')
      .find({ restaurant_id: req.restaurantId })
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray(),
    col('restaurant_notifications')
      .countDocuments({ restaurant_id: req.restaurantId, is_read: false }),
  ]);
  res.json({ notifications: rows, unread });
});

// ─── PATCH /notifications/:id/read ────────────────────────────
router.patch('/notifications/:id/read', async (req, res) => {
  const r = await col('restaurant_notifications').updateOne(
    { _id: req.params.id, restaurant_id: req.restaurantId },
    { $set: { is_read: true } }
  );
  if (!r.matchedCount) return res.status(404).json({ error: 'notification_not_found' });
  res.json({ ok: true });
});

// ─── PATCH /notifications/read-all ────────────────────────────
router.patch('/notifications/read-all', async (req, res) => {
  await col('restaurant_notifications').updateMany(
    { restaurant_id: req.restaurantId, is_read: false },
    { $set: { is_read: true } }
  );
  res.json({ ok: true });
});

// ─── GET/PATCH /settings/review-links ─────────────────────────
router.get('/settings/review-links', async (req, res) => {
  const r = await col('restaurants').findOne(
    { _id: req.restaurantId },
    { projection: { google_review_link: 1, zomato_review_link: 1 } }
  );
  res.json({
    google_review_link: r?.google_review_link || null,
    zomato_review_link: r?.zomato_review_link || null,
  });
});

router.patch('/settings/review-links', async (req, res) => {
  const body = req.body || {};
  const patch = {};
  if ('google_review_link' in body) {
    const v = sanitiseUrl(body.google_review_link);
    if (v && typeof v === 'object') return res.status(400).json({ error: v.error });
    patch.google_review_link = v;
  }
  if ('zomato_review_link' in body) {
    const v = sanitiseUrl(body.zomato_review_link);
    if (v && typeof v === 'object') return res.status(400).json({ error: v.error });
    patch.zomato_review_link = v;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'no_fields_to_update' });
  patch.updated_at = new Date();
  await col('restaurants').updateOne({ _id: req.restaurantId }, { $set: patch });
  const r = await col('restaurants').findOne(
    { _id: req.restaurantId },
    { projection: { google_review_link: 1, zomato_review_link: 1 } }
  );
  res.json({
    google_review_link: r?.google_review_link || null,
    zomato_review_link: r?.zomato_review_link || null,
  });
});

module.exports = router;
