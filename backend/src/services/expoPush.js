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

// sendPush(tokens, { title, body, data })
// tokens: array of strings (invalid entries are filtered out)
// Returns a promise that resolves when all batches settle, but callers
// should NOT await it in a response path — kick it off with .catch() and
// move on.
async function sendPush(tokens, { title, body, data } = {}) {
  try {
    const valid = (Array.isArray(tokens) ? tokens : []).filter(isValidExpoToken);
    if (!valid.length) return;
    const base = {
      sound: 'default',
      priority: 'high',
      title: title || '',
      body: body || '',
      data: data || {},
    };
    const batches = _chunk(valid.map(to => ({ ...base, to })), BATCH_SIZE);
    await Promise.all(batches.map(_sendBatch));
  } catch (err) {
    log.warn({ err: err.message }, 'Expo push sendPush failed');
  }
}

module.exports = { sendPush, isValidExpoToken };
