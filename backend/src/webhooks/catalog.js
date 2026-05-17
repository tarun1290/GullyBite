// src/webhooks/catalog.js
// Handles Meta Catalog API webhook events:
//   - items_batch  : fires when a batch upload completes (success/failure per item)
//   - product_feed : fires when a product feed is processed

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const { col } = require('../config/database');
const log = require('../utils/logger').child({ component: 'catalog' });

// ─── GET: WEBHOOK VERIFICATION ────────────────────────────────
// Meta calls this once when you configure the webhook URL.
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Constant-time verify-token comparison. Mirrors the POST
  // X-Hub-Signature-256 idiom below (this file, ~line 47-50):
  // Buffer.from() both sides → Buffer.byteLength length guard →
  // crypto.timingSafeEqual (throws on unequal length, so the guard
  // runs first). Fail closed: unset/empty expected token, missing
  // provided token, or any mismatch → 403, never echo hub.challenge.
  const expectedVerifyToken = process.env.WEBHOOK_VERIFY_TOKEN;
  if (!expectedVerifyToken || !token) {
    return res.sendStatus(403);
  }
  const provBuf = Buffer.from(token);
  const expBuf  = Buffer.from(expectedVerifyToken);
  // timingSafeEqual throws on unequal-length buffers — guard first
  const tokenOk =
    Buffer.byteLength(token) === Buffer.byteLength(expectedVerifyToken) &&
    crypto.timingSafeEqual(provBuf, expBuf);
  if (mode === 'subscribe' && tokenOk) {
    req.log.info('Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── POST: CATALOG EVENTS ─────────────────────────────────────
router.post('/', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  // Respond immediately — Meta will retry if we take >5s
  res.sendStatus(200);

  try {
    // Verify HMAC-SHA256 signature using App Secret — MANDATORY, fail closed.
    // Absent header OR unconfigured secret must NEVER process a forgeable payload.
    const sig = req.headers['x-hub-signature-256']?.split('sha256=')[1];
    if (!sig) {
      req.log.warn('Missing x-hub-signature-256 — ignoring unsigned payload');
      return;
    }
    if (!process.env.META_APP_SECRET) {
      req.log.error('FATAL: META_APP_SECRET not configured — refusing to process unverifiable webhook (fail closed)');
      return;
    }
    const expected = crypto
      .createHmac('sha256', process.env.META_APP_SECRET)
      .update(req.body)
      .digest('hex');
    const expBuf = Buffer.from(expected);
    const sigBuf = Buffer.from(sig);
    // timingSafeEqual throws on unequal-length buffers — guard first
    if (expBuf.length !== sigBuf.length || !crypto.timingSafeEqual(expBuf, sigBuf)) {
      req.log.warn('Invalid signature — ignoring');
      return;
    }

    const body = JSON.parse(req.body.toString());

    const { once } = require('../utils/idempotency');

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const field = change.field;
        const value = change.value;

        // Deduplicate by catalog + field + event_type/feed_id
        const dedupKey = `${entry.id}:${field}:${value.event_type || ''}:${value.feed_id || ''}:${value.status || ''}`;
        const isNew = await once('catalog', dedupKey);
        if (!isNew) continue;

        if (field === 'items_batch') {
          await handleItemsBatch(entry.id, value);
        } else if (field === 'product_feed') {
          await handleProductFeed(entry.id, value);
        } else {
          log.info({ field }, 'Unhandled field');
        }
      }
    }
  } catch (err) {
    log.error({ err }, 'Webhook error');
  }
});

// ─── items_batch handler ──────────────────────────────────────
const handleItemsBatch = async (catalogId, value) => {
  const { event_type, errors = [] } = value;

  if (errors.length > 0) {
    log.warn({ catalogId, errors }, 'Batch errors');
    await col('branches').updateOne(
      { catalog_id: catalogId },
      { $set: {
        catalog_synced_at  : new Date(),
        catalog_sync_error : `Batch errors: ${errors.map(e => e.message || JSON.stringify(e)).join('; ')}`,
      }}
    ).catch(() => {});
  } else {
    log.info({ catalogId, eventType: event_type }, 'Batch completed');
    await col('branches').updateOne(
      { catalog_id: catalogId },
      { $set: { catalog_synced_at: new Date(), catalog_sync_error: null } }
    ).catch(() => {});
  }
};

// ─── product_feed handler ─────────────────────────────────────
const handleProductFeed = async (catalogId, value) => {
  const { feed_id, event_type, status, errors = [] } = value;

  log.info({ feedId: feed_id, eventType: event_type, status, catalogId }, 'Feed event');

  if (errors.length > 0) {
    log.warn({ errors }, 'Feed errors');
  }

  if (status === 'complete' || status === 'completed') {
    await col('branches').updateOne(
      { catalog_id: catalogId },
      { $set: { catalog_synced_at: new Date(), catalog_sync_error: null } }
    ).catch(() => {});
  }
};

module.exports = router;
