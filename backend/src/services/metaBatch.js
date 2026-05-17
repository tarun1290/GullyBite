// src/services/metaBatch.js
// Meta Graph API batch requests — combine multiple API calls into single HTTP requests.
// Max 50 requests per batch call (Meta's limit).

'use strict';

const axios = require('axios');
const metaConfig = require('../config/meta');
const log = require('../utils/logger').child({ component: 'MetaBatch' });

const BATCH_LIMIT = 50;

// Async sleep helper (ms).
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Max retry attempts for a rate-limited (429) batch chunk before
// surfacing the distinct `rate_limited` result.
const MAX_429_RETRIES = 3;

// Detect HTTP 429 from a thrown axios error (top-level batch call
// rejected) — distinct from per-item 429 inside a 200 envelope,
// which is detected separately by inspecting item.code.
function _isRateLimitedError(err) {
  return err?.response?.status === 429;
}

// Parse Retry-After (HTTP spec: seconds) → ms. Returns null when the
// header is absent/unparseable so the caller can fall back to
// exponential backoff. Accepts headers from either an axios error
// response or a per-item batch-envelope headers array.
function _retryAfterMs(headers) {
  if (!headers) return null;
  let raw;
  if (Array.isArray(headers)) {
    const h = headers.find(x => String(x?.name || '').toLowerCase() === 'retry-after');
    raw = h?.value;
  } else {
    raw = headers['retry-after'] ?? headers['Retry-After'];
  }
  if (raw == null) return null;
  const secs = Number(String(raw).trim());
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : null;
}

/**
 * Execute multiple Meta API requests in a single batch call.
 * @param {Array<{method, relativeUrl, body?}>} requests
 * @param {string} accessToken
 * @returns {Array<{code, body, headers}>}
 */
async function batchExecute(requests, accessToken) {
  if (!requests.length) return [];

  const token = accessToken || metaConfig.getMessagingToken();
  const results = [];

  for (let i = 0; i < requests.length; i += BATCH_LIMIT) {
    const chunk = requests.slice(i, i + BATCH_LIMIT);
    const batchPayload = chunk.map(req => {
      const item = { method: req.method, relative_url: req.relativeUrl };
      if (req.body) {
        item.body = typeof req.body === 'string' ? req.body
          : Object.entries(req.body).map(([k, v]) => `${k}=${encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : v)}`).join('&');
      }
      return item;
    });

    // Retry the whole chunk on rate limiting (429) — either the
    // top-level batch POST is rejected with HTTP 429, OR the batch
    // returns 200 but one/more per-item envelopes carry code 429.
    // We attempt up to MAX_429_RETRIES extra times with backoff
    // (Retry-After header seconds→ms if present, else exponential
    // 1s/2s/4s) BEFORE surfacing failure.
    let chunkSettled = false;
    let lastRateLimitInfo = null; // { retryAfter, error }

    for (let attempt = 0; attempt <= MAX_429_RETRIES && !chunkSettled; attempt++) {
      if (attempt > 0) {
        // Backoff before this retry. Prefer Retry-After; else exponential.
        const backoff = lastRateLimitInfo?.retryAfter || (1000 * Math.pow(2, attempt - 1));
        log.warn({ attempt, maxRetries: MAX_429_RETRIES, waitMs: backoff }, 'Batch chunk rate-limited (429) — backing off before retry');
        await sleep(backoff);
      }

      try {
        const { data } = await axios.post(
          `${metaConfig.graphUrl}`,
          { access_token: token, batch: JSON.stringify(batchPayload) },
          { timeout: 30000 }
        );

        const items = data || [];

        // Per-item 429 inside a 200 envelope → rate-limited; retry chunk.
        const rlItem = items.find(it => Number(it?.code) === 429);
        if (rlItem) {
          const retryAfter = _retryAfterMs(rlItem.headers);
          let body;
          try { body = JSON.parse(rlItem.body); } catch { body = rlItem.body; }
          lastRateLimitInfo = {
            retryAfter,
            error: body?.error?.message || body?.error || `HTTP 429`,
          };
          if (attempt < MAX_429_RETRIES) continue; // retry whole chunk
          // Retries exhausted — surface DISTINCT rate_limited result.
          // code:429 keeps this non-2xx so success-flag/2xx callers
          // still treat it as a failure (NOT flattened to code:500).
          chunk.forEach(() => results.push({
            status:     'rate_limited',
            retryAfter: lastRateLimitInfo.retryAfter,
            error:      lastRateLimitInfo.error,
            code:       429,
            body:       { error: lastRateLimitInfo.error },
            headers:    {},
          }));
          chunkSettled = true;
          break;
        }

        // Normal path — push per-item results unchanged.
        for (const item of items) {
          let body;
          try { body = JSON.parse(item.body); } catch { body = item.body; }
          results.push({ code: item.code, body, headers: item.headers });
        }
        chunkSettled = true;
      } catch (err) {
        if (_isRateLimitedError(err)) {
          const retryAfter = _retryAfterMs(err.response?.headers);
          lastRateLimitInfo = { retryAfter, error: err.message };
          if (attempt < MAX_429_RETRIES) continue; // retry whole chunk
          // Retries exhausted — surface DISTINCT rate_limited result
          // (NOT flattened to code:500).
          log.error({ err }, `Batch call rate-limited (429) after ${MAX_429_RETRIES} retries`);
          chunk.forEach(() => results.push({
            status:     'rate_limited',
            retryAfter,
            error:      err.message,
            code:       429,
            body:       { error: err.message },
            headers:    {},
          }));
          chunkSettled = true;
          break;
        }
        // Non-429 failure — unchanged behavior for existing callers.
        log.error({ err }, 'Batch call failed');
        chunk.forEach(() => results.push({ code: 500, body: { error: err.message }, headers: {} }));
        chunkSettled = true;
      }
    }
  }

  return results;
}

/**
 * Send multiple WhatsApp messages in a single batch call.
 * @param {Array<{to, type, content}>} messages
 * @param {string} phoneNumberId
 * @param {string} accessToken
 * @returns {Array<{success, messageId?, error?}>}
 */
async function batchSendMessages(messages, phoneNumberId, accessToken) {
  const requests = messages.map(msg => ({
    method: 'POST',
    relativeUrl: `${phoneNumberId}/messages`,
    body: {
      messaging_product: 'whatsapp',
      to: msg.to,
      type: msg.type || 'text',
      [msg.type || 'text']: msg.content,
    },
  }));

  const results = await batchExecute(requests, accessToken);

  return results.map((r, i) => {
    if (r.code === 200 || r.code === 201) {
      return { success: true, messageId: r.body?.messages?.[0]?.id };
    }
    log.error({ messageIndex: i, errorMsg: r.body?.error?.message, code: r.code }, 'Batch message failed');
    return { success: false, error: r.body?.error?.message || `HTTP ${r.code}` };
  });
}

module.exports = { batchExecute, batchSendMessages, BATCH_LIMIT };
