// src/services/messageTracking.js
// [WhatsApp2026] Message Status Tracking + Conversation Cost Tracking
//
// Tracks every outgoing WhatsApp message: sent → delivered → read → failed
// Also estimates per-message cost based on conversation category and India 2026 rates.
//
// Collection: message_statuses
//   { _id, wam_id (WhatsApp message ID), restaurant_id, branch_id, customer_id,
//     direction (outgoing|incoming), category (marketing|utility|service|authentication),
//     context (order_update|payment|campaign|rating|greeting|...),
//     status (sent|delivered|read|failed), error_code, error_message,
//     estimated_cost_rs, conversation_id (WA conversation, not our conv),
//     sent_at, delivered_at, read_at, failed_at, created_at }
//
// Collection: waba_health_log
//   { _id, restaurant_id, phone_number_id, quality_rating, messaging_limit,
//     checked_at, alert_sent }

'use strict';

const { col, newId } = require('../config/database');
const log = require('../utils/logger').child({ component: 'MessageTracking' });
const { hashPhone } = require('../utils/phoneHash');

// ─── INDIA 2026 MESSAGING RATES (₹ per message) ─────────────
// Source: Meta WhatsApp Business pricing (India market)
const MESSAGING_RATES = {
  marketing:      0.48,
  utility:        0.12,   // Free if sent within 24h customer-service window
  utility_free:   0,      // Within 24h window
  service:        0,      // Always free (customer-initiated)
  authentication: 0.30,
};

// ─── CONTEXT → CATEGORY MAPPING ─────────────────────────────
function categorizeMessage(context) {
  switch (context) {
    case 'campaign':
    case 'promotion':
      return 'marketing';
    case 'order_update':
    case 'payment':
    case 'payment_link':
    case 'delivery_update':
    case 'template':
      return 'utility';
    case 'otp':
    case 'verification':
      return 'authentication';
    default:
      return 'service'; // greeting, menu, rating, tracking — all customer-initiated
  }
}

// ─── ESTIMATE COST ──────────────────────────────────────────
function estimateCost(category, withinServiceWindow = true) {
  if (category === 'utility' && withinServiceWindow) return MESSAGING_RATES.utility_free;
  return MESSAGING_RATES[category] || 0;
}

// ─── TRACK OUTGOING MESSAGE ─────────────────────────────────
// Called right after sendMsg() succeeds — records the message with status "sent".
// Optional params (to, customerName, wabaId, messageType, rawMetaPayload) power the
// marketing_messages ledger when category === 'marketing'; all are best-effort.
async function trackOutgoing({
  wamId, restaurantId, branchId, customerId, context, withinServiceWindow = true,
  to, customerName, wabaId, messageType, rawMetaPayload,
}) {
  if (!wamId) return null;

  const category = categorizeMessage(context);
  const cost = estimateCost(category, withinServiceWindow);

  const doc = {
    _id: newId(),
    wam_id: wamId,
    restaurant_id: restaurantId || null,
    branch_id: branchId || null,
    customer_id: customerId || null,
    direction: 'outgoing',
    category,
    context: context || 'unknown',
    status: 'sent',
    error_code: null,
    error_message: null,
    estimated_cost_rs: cost,
    sent_at: new Date(),
    delivered_at: null,
    read_at: null,
    failed_at: null,
    created_at: new Date(),
  };

  await col('message_statuses').insertOne(doc);

  // Deduct conversation cost from restaurant wallet (fire-and-forget)
  if (cost > 0 && restaurantId) {
    const wallet = require('./wallet');
    const isOrderLifecycle = ['order_update', 'payment', 'delivery', 'order_confirmed', 'order_dispatched', 'order_delivered'].includes(context);
    wallet.debit(restaurantId, cost, `${category} message: ${context}`, wamId, { isOrderLifecycle }).catch(() => {});
  }

  // Marketing ledger — fire-and-forget, never blocks caller.
  if (category === 'marketing' || context === 'campaign' || context === 'promotion') {
    setImmediate(() => {
      _logMarketingMessage({
        wamId, restaurantId, branchId, customerId, category, context,
        cost, to, customerName, wabaId, messageType, rawMetaPayload,
      }).catch((err) => log.warn({ err, wamId }, 'marketing_messages insert failed'));
    });
  }

  return doc;
}

// ─── MARKETING MESSAGE LEDGER INSERT ────────────────────────
// Separate collection for chargeable marketing sends. Phone numbers stored
// hashed only — never raw. Best-effort enrichment from customers / wa_accounts.
async function _logMarketingMessage({
  wamId, restaurantId, branchId, customerId, category, context,
  cost, to, customerName, wabaId, messageType, rawMetaPayload,
}) {
  // If we don't have phone/name/waba, enrich from existing docs.
  let phone = to;
  let name = customerName;
  if ((!phone || !name) && customerId) {
    const customer = await col('customers').findOne(
      { _id: customerId },
      { projection: { wa_phone: 1, name: 1 } },
    ).catch(() => null);
    if (customer) {
      if (!phone) phone = customer.wa_phone;
      if (!name) name = customer.name;
    }
  }
  if (!wabaId && restaurantId) {
    const wa = await col('wa_accounts').findOne(
      { restaurant_id: restaurantId, is_active: true },
      { projection: { waba_id: 1 } },
    ).catch(() => null);
    if (wa) wabaId = wa.waba_id;
  }

  const resolvedType = messageType
    || (context && /template|campaign|promotion/i.test(context) ? 'template' : 'freeform');

  const now = new Date();
  await col('marketing_messages').insertOne({
    _id: newId(),
    restaurant_id: restaurantId || null,
    branch_id: branchId || null,
    waba_id: wabaId || null,
    customer_id: customerId || null,
    phone_hash: phone ? hashPhone(phone) : null,
    customer_name: name || null,
    message_id: wamId,
    message_type: resolvedType,
    category: category || 'unknown',
    cost: cost || 0,
    currency: 'INR',
    status: 'sent',
    sent_at: now,
    delivered_at: null,
    raw_meta_payload: rawMetaPayload || null,
    created_at: now,
    updated_at: now,
  });
}

// ─── UPDATE STATUS FROM WEBHOOK ─────────────────────────────
// Called from handleStatus() when Meta sends delivery/read/failed updates
async function updateStatus(wamId, status, errorInfo = null) {
  if (!wamId) return false;

  const update = { $set: { status } };

  if (status === 'delivered') update.$set.delivered_at = new Date();
  else if (status === 'read') update.$set.read_at = new Date();
  else if (status === 'failed') {
    update.$set.failed_at = new Date();
    if (errorInfo) {
      update.$set.error_code = errorInfo.code || null;
      update.$set.error_message = errorInfo.message || null;
    }
  }

  const result = await col('message_statuses').updateOne({ wam_id: wamId }, update);

  // Mirror status onto marketing_messages row if one exists (fire-and-forget).
  setImmediate(() => {
    const mkUpdate = { $set: { status, updated_at: new Date() } };
    if (status === 'delivered') mkUpdate.$set.delivered_at = new Date();
    col('marketing_messages').updateOne({ message_id: wamId }, mkUpdate)
      .catch((err) => log.warn({ err, wamId }, 'marketing_messages status update failed'));
  });

  return result.modifiedCount > 0;
}

// ─── UPDATE MARKETING COST (from pricing webhook) ───────────
// Called when Meta's status webhook carries pricing.category + billable info.
// Safe to call repeatedly; only sets cost when provided and > 0.
async function updateMarketingCost(wamId, { cost, category } = {}) {
  if (!wamId) return false;
  const $set = { updated_at: new Date() };
  if (typeof cost === 'number') $set.cost = cost;
  if (category) $set.category = category;
  const res = await col('marketing_messages').updateOne({ message_id: wamId }, { $set });
  return res.modifiedCount > 0;
}

// ─── CAPTURE PRICING FROM STATUS WEBHOOK ────────────────────
// Parses conversation + pricing from Meta's status payload and upserts the
// marketing_messages row. Safe to call on every status event — only acts
// when the category resolves to "marketing". Never throws.
//
// Meta payload shape (relevant fields):
//   status.id                       → message_id
//   status.status                   → sent|delivered|read|failed
//   status.timestamp                → unix seconds
//   status.recipient_id             → customer phone (hashed before store)
//   status.conversation.id          → WA conversation id
//   status.conversation.origin.type → marketing|utility|authentication|service
//   status.pricing.category         → authoritative category
//   status.pricing.billable         → boolean
//   status.pricing.pricing_model    → CBP|PMP
async function capturePricingFromWebhook(status) {
  try {
    const wamId = status?.id;
    if (!wamId) return false;

    const pricing = status.pricing || {};
    const conversation = status.conversation || {};
    const category = pricing.category || conversation.origin?.type || null;

    // Only act on marketing. Non-marketing statuses are handled elsewhere.
    if (category !== 'marketing') return false;

    const billable = pricing.billable !== false; // default true when absent
    const cost = billable ? estimateCost('marketing', false) : 0;

    const eventAt = status.timestamp
      ? new Date(Number(status.timestamp) * 1000)
      : new Date();

    // If this message was sent by a campaign, carry the campaign_id through
    // so the analytics aggregate can key costs by campaign_id directly
    // without a second collection scan.
    let campaignId = null;
    try {
      const cm = await col('campaign_messages').findOne(
        { message_id: wamId },
        { projection: { campaign_id: 1 } },
      );
      if (cm?.campaign_id) campaignId = cm.campaign_id;
    } catch (_) { /* best-effort */ }

    const $set = {
      category,
      cost,
      currency: 'INR',
      updated_at: new Date(),
    };
    if (campaignId) $set.campaign_id = campaignId;
    if (conversation.id) $set.conversation_id = conversation.id;
    if (pricing.pricing_model) $set.pricing_model = pricing.pricing_model;
    if (typeof pricing.billable === 'boolean') $set.billable = pricing.billable;
    if (status.status === 'delivered') $set.delivered_at = eventAt;
    if (status.status === 'read')      $set.read_at      = eventAt;
    if (status.status === 'failed')    $set.failed_at    = eventAt;
    if (['sent', 'delivered', 'read', 'failed'].includes(status.status)) {
      $set.status = status.status;
    }

    // Fallback fields only applied if we end up inserting a brand-new row.
    const $setOnInsert = {
      _id: newId(),
      message_id: wamId,
      restaurant_id: null,
      branch_id: null,
      waba_id: null,
      phone_hash: status.recipient_id ? hashPhone(status.recipient_id) : null,
      customer_name: null,
      message_type: 'unknown',
      sent_at: eventAt,
      raw_meta_payload: status,
      created_at: new Date(),
    };

    await col('marketing_messages').updateOne(
      { message_id: wamId },
      { $set, $setOnInsert },
      { upsert: true },
    );
    return true;
  } catch (err) {
    log.warn({ err, wamId: status?.id }, 'capturePricingFromWebhook failed');
    return false;
  }
}

// ─── GET MESSAGE STATS FOR RESTAURANT ───────────────────────
// Aggregates message counts and costs for a date range
async function getMessageStats(restaurantId, { from, to } = {}) {
  const match = { restaurant_id: restaurantId, direction: 'outgoing' };
  if (from || to) {
    match.created_at = {};
    if (from) match.created_at.$gte = new Date(from);
    if (to) match.created_at.$lte = new Date(to);
  }

  const [stats] = await col('message_statuses').aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        sent: { $sum: { $cond: [{ $eq: ['$status', 'sent'] }, 1, 0] } },
        delivered: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] } },
        read: { $sum: { $cond: [{ $eq: ['$status', 'read'] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
        total_cost_rs: { $sum: '$estimated_cost_rs' },
      },
    },
  ]).toArray();

  return stats || { total: 0, sent: 0, delivered: 0, read: 0, failed: 0, total_cost_rs: 0 };
}

// ─── GET COST BREAKDOWN BY CATEGORY ─────────────────────────
async function getCostBreakdown(restaurantId, { from, to } = {}) {
  const match = { restaurant_id: restaurantId, direction: 'outgoing' };
  if (from || to) {
    match.created_at = {};
    if (from) match.created_at.$gte = new Date(from);
    if (to) match.created_at.$lte = new Date(to);
  }

  const breakdown = await col('message_statuses').aggregate([
    { $match: match },
    {
      $group: {
        _id: '$category',
        count: { $sum: 1 },
        cost_rs: { $sum: '$estimated_cost_rs' },
      },
    },
    { $sort: { cost_rs: -1 } },
  ]).toArray();

  return breakdown.map(b => ({ category: b._id, count: b.count, cost_rs: b.cost_rs }));
}

// ─── GET DAILY COST TREND ───────────────────────────────────
async function getDailyCostTrend(restaurantId, days = 30) {
  const from = new Date();
  from.setDate(from.getDate() - days);

  const trend = await col('message_statuses').aggregate([
    { $match: { restaurant_id: restaurantId, direction: 'outgoing', created_at: { $gte: from } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$created_at' } },
        messages: { $sum: 1 },
        cost_rs: { $sum: '$estimated_cost_rs' },
      },
    },
    { $sort: { _id: 1 } },
  ]).toArray();

  return trend.map(d => ({ date: d._id, messages: d.messages, cost_rs: d.cost_rs }));
}

// ─── ACCOUNT QUALITY CHECK ──────────────────────────────────
// [WhatsApp2026] Fetches phone number quality rating from Meta Graph API
// and logs it to waba_health_log collection
async function checkAccountQuality(phoneNumberId, accessToken, restaurantId) {
  const axios = require('axios');
  try {
    const url = `https://graph.facebook.com/${process.env.WA_API_VERSION}/${phoneNumberId}?fields=quality_rating,messaging_limit_tier,account_mode,status`;
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 10000,
    });

    const logEntry = {
      _id: newId(),
      restaurant_id: restaurantId,
      phone_number_id: phoneNumberId,
      quality_rating: data.quality_rating || 'UNKNOWN',
      messaging_limit: data.messaging_limit_tier || 'UNKNOWN',
      account_mode: data.account_mode || null,
      phone_status: data.status || null,
      checked_at: new Date(),
      alert_sent: false,
    };

    await col('waba_health_log').insertOne(logEntry);

    // Auto-alert if quality is degraded
    if (['LOW', 'FLAGGED'].includes(data.quality_rating)) {
      logEntry.alert_sent = true;
      await col('waba_health_log').updateOne({ _id: logEntry._id }, { $set: { alert_sent: true } });
      log.warn({ phoneNumberId, qualityRating: data.quality_rating }, 'WABA quality degraded');
    }

    return {
      quality_rating: data.quality_rating,
      messaging_limit: data.messaging_limit_tier,
      account_mode: data.account_mode,
      phone_status: data.status,
    };
  } catch (err) {
    log.error({ err, phoneNumberId }, 'Failed to check WABA quality');
    return null;
  }
}

// ─── GET LATEST HEALTH STATUS ────────────────────────────────
async function getLatestHealth(restaurantId) {
  return col('waba_health_log')
    .findOne({ restaurant_id: restaurantId }, { sort: { checked_at: -1 } });
}

// ─── GET HEALTH HISTORY ─────────────────────────────────────
async function getHealthHistory(restaurantId, limit = 30) {
  return col('waba_health_log')
    .find({ restaurant_id: restaurantId })
    .sort({ checked_at: -1 })
    .limit(limit)
    .toArray();
}

module.exports = {
  MESSAGING_RATES,
  categorizeMessage,
  estimateCost,
  trackOutgoing,
  updateStatus,
  updateMarketingCost,
  capturePricingFromWebhook,
  getMessageStats,
  getCostBreakdown,
  getDailyCostTrend,
  checkAccountQuality,
  getLatestHealth,
  getHealthHistory,
};
