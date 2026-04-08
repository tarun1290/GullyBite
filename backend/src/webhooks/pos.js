// src/webhooks/pos.js
// Receives real-time stock/menu updates from POS platforms (Petpooja, UrbanPiper, DotPe)
// Always returns 200 immediately, then processes asynchronously.

const express = require('express');
const router  = express.Router();
const { col, newId } = require('../config/database');
const memcache = require('../config/memcache');
const { POS_INTEGRATIONS_ENABLED } = require('../config/features');
const { triggerSync, SERVICES } = require('../services/posSync');
const log = require('../utils/logger').child({ component: 'pos' });

router.use(express.json({ limit: '5mb' }));

const VALID_PLATFORMS = ['petpooja', 'urbanpiper', 'dotpe'];

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
      received_at: new Date(),
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
