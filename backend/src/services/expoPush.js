'use strict';

// Expo push sender — plain fetch, no expo-server-sdk. Always
// fire-and-forget: callers must never await this in a response path.
// Errors are logged, never thrown.

const log = require('../utils/logger').child({ component: 'expoPush' });

const EXPO_PUSH_URL = 'https://exp.host/api/v2/push/send';
const BATCH_SIZE = 100; // Expo hard-caps per-request payload at 100 messages
const TOKEN_PREFIX_RE = /^(ExponentPushToken|ExpoPushToken)\[/;

function isValidExpoToken(token) {
  return typeof token === 'string' && TOKEN_PREFIX_RE.test(token);
}

function _chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function _sendBatch(messages) {
  try {
    const resp = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate',
      },
      body: JSON.stringify(messages),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      log.warn({ status: resp.status, body: text.slice(0, 500) }, 'Expo push HTTP error');
      return;
    }
    const json = await resp.json().catch(() => null);
    const tickets = Array.isArray(json?.data) ? json.data : [];
    const errors = tickets.filter(t => t && t.status === 'error');
    if (errors.length) {
      log.warn({ errorCount: errors.length, sample: errors.slice(0, 3) }, 'Expo push tickets had errors');
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Expo push fetch failed');
  }
}

// sendPush(tokens, { title, body, data, channelId })
// tokens: array of strings (invalid entries are filtered out)
// channelId: optional Android notification channel id (e.g. 'orders',
//   'settlements', 'alerts', 'summary'). Expo passes this through to
//   FCM so Android picks the matching channel's importance + vibration
//   profile (defined in staff-app/src/push.ts setupNotificationHandler).
//   iOS ignores the field. Omit to fall back to the device's default
//   channel — staff pushes don't need it because the staff app's
//   default channel is 'orders'.
// Returns a promise that resolves when all batches settle, but callers
// should NOT await it in a response path — kick it off with .catch() and
// move on.
async function sendPush(tokens, { title, body, data, channelId } = {}) {
  try {
    const valid = (Array.isArray(tokens) ? tokens : []).filter(isValidExpoToken);
    if (!valid.length) return;
    const base = {
      sound: 'default',
      priority: 'high',
      title: title || '',
      body: body || '',
      data: data || {},
      ...(channelId ? { channelId } : {}),
    };
    const batches = _chunk(valid.map(to => ({ ...base, to })), BATCH_SIZE);
    await Promise.all(batches.map(_sendBatch));
  } catch (err) {
    log.warn({ err: err.message }, 'Expo push sendPush failed');
  }
}

// Read the platform-level owner notification preferences. Single
// source of truth for whether owner-mobile pushes for new_order /
// settlement_paid / branch_paused / daily_summary should fire. NOT
// cached — every call hits Mongo so an admin toggle in
// platform_settings.owner_push_prefs takes effect for the very next
// event without an EC2 restart. Fail-open: if the read throws (DB
// hiccup, missing collection, etc.) we return all-true so a
// transient infra problem doesn't silently mute every owner push.
//
// Lazy-require config/database to avoid a load-order circular: this
// module is required at boot from queue/postPaymentJobs.js +
// events/listeners/sseListener.js, both of which sit upstream of any
// Mongo connection setup.
async function getOwnerPushPrefs() {
  try {
    const { col } = require('../config/database');
    const doc = await col('platform_settings').findOne({ _id: 'owner_push_prefs' });
    return {
      new_order:       doc?.new_order       !== false,
      settlement_paid: doc?.settlement_paid !== false,
      branch_paused:   doc?.branch_paused   !== false,
      daily_summary:   doc?.daily_summary   !== false,
    };
  } catch {
    return { new_order: true, settlement_paid: true, branch_paused: true, daily_summary: true };
  }
}

module.exports = { sendPush, isValidExpoToken, getOwnerPushPrefs };
