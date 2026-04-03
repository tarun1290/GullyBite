// src/webhooks/pos.js
// Receives real-time stock/menu updates from POS platforms (Petpooja, UrbanPiper, DotPe)
// Always returns 200 immediately, then processes asynchronously.

const express = require('express');
const router  = express.Router();
const { col, newId } = require('../config/database');
const memcache = require('../config/memcache');
const { POS_INTEGRATIONS_ENABLED } = require('../config/features');
const { triggerSync, SERVICES } = require('../services/posSync');

router.use(express.json({ limit: '5mb' }));

const VALID_PLATFORMS = ['petpooja', 'urbanpiper', 'dotpe'];

router.post('/:platform', async (req, res) => {
  // Always respond 200 immediately — POS platforms retry on slow responses
  res.status(200).json({ received: true });

  const platform = (req.params.platform || '').toLowerCase();
  if (!VALID_PLATFORMS.includes(platform)) {
    console.warn(`[POS-WH] Unknown platform: ${platform}`);
    return;
  }
  if (!POS_INTEGRATIONS_ENABLED) {
    console.log(`[POS-WH] POS integrations disabled — ignoring ${platform} webhook`);
    return;
  }

  const payload = req.body;
  const svc = SERVICES[platform];
  if (!svc?.parseWebhookEvent) {
    console.warn(`[POS-WH] No webhook parser for ${platform}`);
    return;
  }

  try {
    // Parse the event
    const event = svc.parseWebhookEvent(payload);
    console.log(`[POS-WH] ${platform}: type=${event.type}, outletId=${event.outletId}`);

    // Log to webhook_logs
    col('webhook_logs').insertOne({
      _id: newId(), source: 'pos', platform, event_type: event.type,
      outlet_id: event.outletId, payload: JSON.stringify(payload).substring(0, 5000),
      received_at: new Date(),
    }).catch(() => {});

    if (event.type === 'unknown') {
      console.log(`[POS-WH] Unrecognized event from ${platform} — logged for debugging`);
      return;
    }

    // Find matching integration
    const integration = await col('restaurant_integrations').findOne({
      platform, outlet_id: event.outletId, is_active: true,
    });
    if (!integration) {
      console.warn(`[POS-WH] No active integration for ${platform} outlet ${event.outletId}`);
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
          .catch(err => console.error(`[POS-WH] Meta sync failed:`, err.message));
      }

      console.log(`[POS-WH] Stock update from ${platform}: ${changedCount} items updated for branch ${branchId}`);
    }

    // ── MENU UPDATE — full re-pull ──
    if (event.type === 'menu_update') {
      console.log(`[POS-WH] Menu update from ${platform} — triggering incremental sync for branch ${branchId}`);
      triggerSync(platform, String(integration._id), restaurantId, 'incremental')
        .catch(err => console.error(`[POS-WH] Menu sync failed:`, err.message));
    }

  } catch (err) {
    console.error(`[POS-WH] Error processing ${platform} webhook:`, err.message);
  }
});

module.exports = router;
