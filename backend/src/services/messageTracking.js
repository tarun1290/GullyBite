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
// Called right after sendMsg() succeeds — records the message with status "sent"
async function trackOutgoing({ wamId, restaurantId, branchId, customerId, context, withinServiceWindow = true }) {
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

  return doc;
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
  return result.modifiedCount > 0;
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
      console.warn(`[WABA Health] ⚠️ Quality degraded for ${phoneNumberId}: ${data.quality_rating}`);
    }

    return {
      quality_rating: data.quality_rating,
      messaging_limit: data.messaging_limit_tier,
      account_mode: data.account_mode,
      phone_status: data.status,
    };
  } catch (err) {
    console.error(`[WABA Health] Failed to check quality for ${phoneNumberId}:`, err.message);
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
  getMessageStats,
  getCostBreakdown,
  getDailyCostTrend,
  checkAccountQuality,
  getLatestHealth,
  getHealthHistory,
};
