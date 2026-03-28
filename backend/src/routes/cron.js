// src/routes/cron.js
// Cron-triggered endpoints for automated background tasks.
// Protected by CRON_SECRET — only Vercel Cron or external cron services can call these.

'use strict';

const express = require('express');
const router = express.Router();
const { col } = require('../config/database');
const catalog = require('../services/catalog');
const { logActivity } = require('../services/activityLog');

// Auth: verify cron secret
router.use((req, res, next) => {
  const auth = req.headers['authorization'];
  const secret = process.env.CRON_SECRET;
  if (secret && auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ─── CATALOG AUTO-SYNC (every 30 minutes) ────────────────────
router.get('/catalog-sync', async (req, res) => {
  const start = Date.now();
  try {
    const restaurants = await col('restaurants').find({
      status: 'active',
      $or: [
        { meta_catalog_id: { $ne: null } },
        { catalog_id: { $ne: null } },
      ],
    }).toArray();

    console.log(`[Cron] Auto-sync: ${restaurants.length} restaurants with catalogs`);

    let synced = 0, failed = 0;
    // Process 3 at a time to respect Meta API rate limits
    const BATCH = 3;
    for (let i = 0; i < restaurants.length; i += BATCH) {
      const batch = restaurants.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(async (r) => {
          try {
            await catalog.syncRestaurantCatalog(String(r._id));
            await col('restaurants').updateOne({ _id: r._id }, { $set: { last_auto_sync_at: new Date() } });
            return { id: r._id, ok: true };
          } catch (err) {
            console.error(`[Cron] Sync failed for ${r.business_name}:`, err.message);
            return { id: r._id, ok: false, error: err.message };
          }
        })
      );
      results.forEach(r => {
        if (r.status === 'fulfilled' && r.value.ok) synced++;
        else failed++;
      });
    }

    const duration = Date.now() - start;
    console.log(`[Cron] Auto-sync complete: ${synced} synced, ${failed} failed (${duration}ms)`);

    logActivity({ actorType: 'system', action: 'cron.catalog_sync', category: 'catalog', description: `Auto-sync: ${synced} restaurants synced, ${failed} failed (${duration}ms)`, severity: failed > 0 ? 'warning' : 'info' });

    res.json({ success: true, synced, failed, duration_ms: duration });
  } catch (e) {
    console.error('[Cron] Auto-sync error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
