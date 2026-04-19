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
  // Always respond 200 immediately — POS platforms retry on slow responses
  res.status(200).json({ received: true });

  const platform = (req.params.platform || '').toLowerCase();
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

    // Log to webhook_logs
    col('webhook_logs').insertOne({
      _id: newId(), source: 'pos', platform, event_type: event.type,
      outlet_id: event.outletId, payload: JSON.stringify(payload).substring(0, 5000),
      received_at: new Date(), signature_verified: signatureVerified,
    }).catch(() => {});

    if (event.type === 'unknown') {
      log.info({ platform }, 'Unrecognized event — logged for debugging');
      return;
    }

    // Find matching integration
    const integration = await col('restaurant_integrations').findOne({
      platform, outlet_id: event.outletId, is_active: true,
    });
    if (!integration) {
      log.warn({ platform, outletId: event.outletId }, 'No active integration for outlet');
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
    }

    // ── MENU UPDATE — full re-pull ──
    if (event.type === 'menu_update') {
      log.info({ platform, branchId }, 'Menu update — triggering incremental sync');
      triggerSync(platform, String(integration._id), restaurantId, 'incremental')
        .catch(err => log.error({ err }, 'Menu sync failed'));
    }

  } catch (err) {
    log.error({ err, platform }, 'Error processing webhook');
  }
});

module.exports = router;
