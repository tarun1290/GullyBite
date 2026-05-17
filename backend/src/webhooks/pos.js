// src/webhooks/pos.js
// Receives real-time stock/menu updates from POS platforms (Petpooja, UrbanPiper, DotPe)
// Always returns 200 immediately, then processes asynchronously.

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const { col, newId } = require('../config/database');
const memcache = require('../config/memcache');
const { POS_INTEGRATIONS_ENABLED } = require('../config/features');
const { triggerSync, SERVICES } = require('../services/posSync');
const log = require('../utils/logger').child({ component: 'pos' });

// Preserve raw body so HMAC signatures can be verified against the exact bytes.
router.use(express.json({
  limit: '5mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// File-local inbound Authorization-secret guard for the PETPOOJA path only.
// Mirrors the contract used by the sibling Petpooja files (webhooks/petpoojaCallback.js,
// routes/petpoojaIntegration.js): raw secret in the Authorization header (NO "Bearer"
// prefix), length guard BEFORE timingSafeEqual (which throws on length mismatch).
// Returns true if authorized; on failure it has already written a non-2xx response
// (so Petpooja sees a rejection) and returns false.
function verifyPetpoojaAuth(req, res) {
  const expected = process.env.PETPOOJA_CALLBACK_SECRET;
  const provided = req.headers['authorization'];

  if (!expected) {
    console.error('[petpooja] FATAL: PETPOOJA_CALLBACK_SECRET not set');
    res.status(500).json({ code: '500', status: 'failed', message: 'Server configuration error' });
    return false;
  }
  if (!provided) {
    res.status(401).json({ code: '401', status: 'failed', message: 'Unauthorized' });
    return false;
  }
  // Length guard BEFORE timingSafeEqual — it throws on length mismatch.
  if (Buffer.byteLength(provided) !== Buffer.byteLength(expected)) {
    res.status(401).json({ code: '401', status: 'failed', message: 'Unauthorized' });
    return false;
  }
  const cryptoLocal = require('crypto');
  if (!cryptoLocal.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    res.status(401).json({ code: '401', status: 'failed', message: 'Unauthorized' });
    return false;
  }
  return true;
}

const VALID_PLATFORMS = ['petpooja', 'urbanpiper', 'dotpe'];

// Verifies platform-specific webhook signatures. Non-strict by default — returns
// { verified: boolean, reason: string|null } so callers can log and decide whether
// to reject (gated by POS_WEBHOOK_STRICT_MODE in the future).
function verifyPosWebhookSignature(platform, rawBody, headers) {
  if (platform === 'petpooja') {
    const secret = process.env.PETPOOJA_WEBHOOK_SECRET;
    if (!secret) return { verified: false, reason: 'secret_not_configured' };
    const provided = headers['x-petpooja-signature'] || headers['X-Petpooja-Signature'];
    if (!provided) return { verified: false, reason: 'missing_signature_header' };
    if (!rawBody || !rawBody.length) return { verified: false, reason: 'empty_body' };
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    try {
      const ok = crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(String(provided), 'hex'));
      return ok ? { verified: true, reason: null } : { verified: false, reason: 'signature_mismatch' };
    } catch (_) {
      return { verified: false, reason: 'signature_format_invalid' };
    }
  }

  // TODO: urbanpiper and dotpe do not publish stable HMAC schemes for stock
  // webhooks yet — treat as verified pending vendor docs.
  if (platform === 'urbanpiper' || platform === 'dotpe') {
    return { verified: true, reason: null };
  }

  return { verified: false, reason: 'unknown_platform' };
}

router.post('/:platform', async (req, res) => {
  const platform = (req.params.platform || '').toLowerCase();

  // PETPOOJA path ONLY: verify the inbound Authorization secret and REJECT
  // (401/500) before the early 200 ack and before any stock/menu processing.
  // urbanpiper/dotpe are unaffected — they skip this guard entirely.
  if (platform === 'petpooja' && !verifyPetpoojaAuth(req, res)) return;

  // Always respond 200 immediately — POS platforms retry on slow responses
  res.status(200).json({ received: true });

  if (!VALID_PLATFORMS.includes(platform)) {
    log.warn({ platform }, 'Unknown platform');
    return;
  }
  if (!POS_INTEGRATIONS_ENABLED) {
    log.info({ platform }, 'POS integrations disabled — ignoring webhook');
    return;
  }

  // Verify signature (log-only for now; flip to reject when POS_WEBHOOK_STRICT_MODE=true).
  const sigResult = verifyPosWebhookSignature(platform, req.rawBody, req.headers);
  const signatureVerified = sigResult.verified;
  if (!signatureVerified) {
    log.warn({ platform, reason: sigResult.reason }, 'POS webhook signature not verified');
    // TODO: reject when process.env.POS_WEBHOOK_STRICT_MODE === 'true'
  }

  const payload = req.body;
  const svc = SERVICES[platform];
  if (!svc?.parseWebhookEvent) {
    log.warn({ platform }, 'No webhook parser for platform');
    return;
  }

  // Declared at handler scope (mirrors whatsapp.js:322 `let logId = null;`) so the
  // menu_update promise-chain callbacks (.then/.catch on upsertMenu/triggerSync),
  // which run AFTER the synchronous try block exits, can still see the log id.
  let logId = null;

  try {
    // Parse the event
    const event = svc.parseWebhookEvent(payload);
    log.info({ platform, type: event.type, outletId: event.outletId }, 'Webhook event parsed');

    // Idempotency: deduplicate by platform + outlet + event type + item fingerprint
    const { once } = require('../utils/idempotency');
    const itemSig = (event.items || []).map(i => `${i.pos_item_id}:${i.is_available}`).sort().join('|');
    const posKey = `${platform}:${event.outletId || 'global'}:${event.type}:${itemSig || Date.now()}`;
    const isNew = await once('pos', posKey, { platform, type: event.type });
    if (!isNew) return;

    // Log to webhook_logs. Capture the generated id first so terminal paths can
    // mark this row processed/errored (mirrors whatsapp.js logWebhook → logId).
    // Insert stays fire-and-forget exactly as before.
    logId = newId();
    col('webhook_logs').insertOne({
      _id: logId, source: 'pos', platform, event_type: event.type,
      outlet_id: event.outletId, payload: JSON.stringify(payload).substring(0, 5000),
      received_at: new Date(), signature_verified: signatureVerified,
    }).catch(() => {});

    if (event.type === 'unknown') {
      log.info({ platform }, 'Unrecognized event — logged for debugging');
      // Benign no-op terminal: the event WAS received and accepted; logging it
      // for debugging IS the intended handling. Mark processed so it does not
      // stay Pending forever (mirrors whatsapp.js success $set shape).
      if (logId) col('webhook_logs').updateOne({ _id: logId }, { $set: { processed: true, processed_at: new Date(), retry_status: 'success' } }).catch(() => {});
      return;
    }

    // Find matching integration
    const integration = await col('restaurant_integrations').findOne({
      platform, outlet_id: event.outletId, is_active: true,
    });
    if (!integration) {
      log.warn({ platform, outletId: event.outletId }, 'No active integration for outlet');
      // Benign no-op terminal: event accepted but no integration to route it to —
      // nothing further to do. Mark processed so it does not stay Pending forever.
      if (logId) col('webhook_logs').updateOne({ _id: logId }, { $set: { processed: true, processed_at: new Date(), retry_status: 'success' } }).catch(() => {});
      return;
    }

    const branchId = integration.branch_id;
    const restaurantId = integration.restaurant_id;

    // ── STOCK UPDATE — per-item availability changes ──
    if (event.type === 'stock_update' && event.items?.length) {
      let changedCount = 0;
      const changedItems = [];

      for (const stockItem of event.items) {
        if (!stockItem.pos_item_id) continue;
        const menuItem = await col('menu_items').findOne({
          branch_id: branchId, pos_item_id: stockItem.pos_item_id, pos_platform: platform,
        });
        if (!menuItem) continue;
        if (menuItem.is_available === stockItem.is_available) continue; // no change

        await col('menu_items').updateOne(
          { _id: menuItem._id },
          { $set: { is_available: stockItem.is_available, updated_at: new Date(), catalog_sync_status: 'pending', pos_synced_at: new Date() } }
        );
        changedCount++;
        if (menuItem.retailer_id) changedItems.push({ retailer_id: menuItem.retailer_id, is_available: stockItem.is_available });
      }

      // Clear MPM cache
      if (changedCount > 0) memcache.del(`branch:${branchId}:menu`);

      // Sync to Meta catalog
      if (changedItems.length) {
        const catalog = require('../services/catalog');
        catalog.syncBulkAvailability(restaurantId, changedItems)
          .catch(err => log.error({ err }, 'Meta sync failed'));
      }

      log.info({ platform, changedCount, branchId }, 'Stock update processed');

      // Genuine completion of the awaited stock_update path — mark processed
      // (mirrors whatsapp.js success $set shape; fire-and-forget).
      if (logId) col('webhook_logs').updateOne({ _id: logId }, { $set: { processed: true, processed_at: new Date(), retry_status: 'success' } }).catch(() => {});
    }

    // ── MENU UPDATE — full re-pull ──
    if (event.type === 'menu_update') {
      // If the event carried the full payload (Push Menu), parse and upsert directly.
      // Otherwise fall back to triggerSync which fetches from Petpooja API.
      if (event.rawPayload) {
        const { upsertMenu } = require('../services/posSync');
        const parsed = svc.parsePushMenuPayload(event.rawPayload);
        upsertMenu(branchId, platform, parsed, 'incremental')
          .then(result => {
            log.info({ platform, branchId, ...result }, 'Push Menu upserted directly');
            // Genuine completion of the push-menu path — mark processed
            // (mirrors whatsapp.js success $set shape; fire-and-forget).
            if (logId) col('webhook_logs').updateOne({ _id: logId }, { $set: { processed: true, processed_at: new Date(), retry_status: 'success' } }).catch(() => {});
            // Fire catalog chain
            const catalog = require('../services/catalog');
            memcache.del(`branch:${branchId}:menu`);
            catalog.syncBranchCatalog(branchId)
              .catch(err => log.error({ err }, 'Catalog sync failed after push menu'));
          })
          .catch(err => {
            log.error({ err }, 'Push Menu upsert failed');
            // Error terminal for the push-menu path — mark for retry
            // (mirrors whatsapp.js error $set shape; fire-and-forget).
            if (logId) col('webhook_logs').updateOne({ _id: logId }, { $set: { error_message: err.message, retry_status: 'pending' } }).catch(() => {});
          });
      } else {
        triggerSync(platform, String(integration._id), restaurantId, 'incremental')
          .then(() => {
            // Genuine completion of the API-sync path — mark processed
            // (mirrors whatsapp.js success $set shape; fire-and-forget).
            if (logId) col('webhook_logs').updateOne({ _id: logId }, { $set: { processed: true, processed_at: new Date(), retry_status: 'success' } }).catch(() => {});
          })
          .catch(err => {
            log.error({ err }, 'Menu sync failed');
            // Error terminal for the API-sync path — mark for retry
            // (mirrors whatsapp.js error $set shape; fire-and-forget).
            if (logId) col('webhook_logs').updateOne({ _id: logId }, { $set: { error_message: err.message, retry_status: 'pending' } }).catch(() => {});
          });
      }
    }

  } catch (err) {
    log.error({ err, platform }, 'Error processing webhook');
    // Surrounding-catch error terminal — mark for retry (mirrors whatsapp.js
    // catch-block error $set shape; fire-and-forget; logId may be null if the
    // failure happened before the insert, hence the guard).
    if (logId) col('webhook_logs').updateOne({ _id: logId }, { $set: { error_message: err.message, retry_status: 'pending' } }).catch(() => {});
  }
});

module.exports = router;
