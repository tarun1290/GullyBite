// src/services/metaBatch.js
// Meta Graph API batch requests — combine multiple API calls into single HTTP requests.
// Max 50 requests per batch call (Meta's limit).

'use strict';

const axios = require('axios');
const metaConfig = require('../config/meta');

const BATCH_LIMIT = 50;

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

    try {
      const { data } = await axios.post(
        `${metaConfig.graphUrl}`,
        { access_token: token, batch: JSON.stringify(batchPayload) },
        { timeout: 30000 }
      );

      for (const item of (data || [])) {
        let body;
        try { body = JSON.parse(item.body); } catch { body = item.body; }
        results.push({ code: item.code, body, headers: item.headers });
      }
    } catch (err) {
      console.error('[MetaBatch] Batch call failed:', err.response?.data?.error?.message || err.message);
      chunk.forEach(() => results.push({ code: 500, body: { error: err.message }, headers: {} }));
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
    console.error(`[MetaBatch] Message ${i} failed:`, r.body?.error?.message || r.code);
    return { success: false, error: r.body?.error?.message || `HTTP ${r.code}` };
  });
}

module.exports = { batchExecute, batchSendMessages, BATCH_LIMIT };
