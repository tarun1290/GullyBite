  // src/routes/cron.js
// Cron-triggered endpoints for automated background tasks.
// Protected by CRON_SECRET — only Vercel Cron or external cron services can call these.

'use strict';

const express = require('express');
const router = express.Router();
const { col, newId } = require('../config/database');
const catalog = require('../services/catalog');
const { logActivity } = require('../services/activityLog');

// Auth: verify cron secret (accepts Bearer token or Vercel's internal header)
router.use((req, res, next) => {
  console.log(`[Cron] Request received: ${req.method} ${req.originalUrl} ${req.path}`);
  const auth = req.headers['authorization'];
  const secret = process.env.CRON_SECRET;
  if (secret && auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ─── CATALOG AUTO-SYNC (every 30 minutes) ────────────────────
// Returns 200 immediately, processes sync in background.
// Vercel Hobby has 30s function timeout — sync can take longer than that.
router.get('/catalog-sync', async (req, res) => {
  // Respond immediately so cron-job.org gets a 200 (prevents "output too large" errors)
  res.json({ ok: true, message: 'catalog-sync started', timestamp: new Date().toISOString() });

  // Process in background after response is sent
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
  } catch (e) {
    console.error('[Cron] Auto-sync error:', e.message);
  }
});

// ─── CART RECOVERY (every 5 minutes) ────────────────────────
// Sends timed recovery reminders for abandoned carts.
router.get('/cart-recovery', async (req, res) => {
  res.json({ ok: true, message: 'cart-recovery started', timestamp: new Date().toISOString() });

  try {
    const cartRecovery = require('../services/cart-recovery');
    const result = await cartRecovery.processRecoveryQueue();
    console.log(`[Cron] Cart recovery: sent=${result.sent} expired=${result.expired}`);
    logActivity({ actorType: 'system', action: 'cron.cart_recovery', category: 'marketing', description: `Cart recovery: ${result.sent} reminders sent, ${result.expired} expired`, severity: 'info' });
  } catch (e) {
    console.error('[Cron] Cart recovery error:', e.message);
  }
});

// ─── HEALTH CHECK (every 30 minutes) ─────────────────────────
// Checks webhook heartbeat + token validity, creates platform_alerts if issues found.
router.get('/health-check', async (req, res) => {
  res.json({ ok: true, message: 'health-check started', timestamp: new Date().toISOString() });

  try {
    const now = new Date();
    const alerts = [];

    // Check 1: Webhook heartbeat — alert if no webhook received in 2h during business hours (8AM-11PM IST)
    const istHour = new Date(now.getTime() + 5.5 * 3600000).getUTCHours();
    const isBusinessHours = istHour >= 8 && istHour < 23;

    const heartbeat = await col('platform_health').findOne({ _id: 'webhook_heartbeat' });
    if (heartbeat?.last_received && isBusinessHours) {
      const silenceMs = now - new Date(heartbeat.last_received);
      if (silenceMs > 2 * 3600000) {
        const hoursAgo = Math.round(silenceMs / 3600000);
        alerts.push({
          _id: newId(),
          type: 'webhook_silence',
          severity: silenceMs > 6 * 3600000 ? 'critical' : 'warning',
          message: `No WhatsApp webhooks received in ${hoursAgo} hours (last: ${new Date(heartbeat.last_received).toISOString()})`,
          created_at: now,
          acknowledged: false,
        });
      }
    } else if (!heartbeat && isBusinessHours) {
      alerts.push({
        _id: newId(),
        type: 'webhook_silence',
        severity: 'warning',
        message: 'No webhook heartbeat record found — webhooks may not be configured',
        created_at: now,
        acknowledged: false,
      });
    }

    // Check 2: Meta token validity
    try {
      const metaConfig = require('../config/meta');
      const token = metaConfig.systemUserToken;
      if (token) {
        const axios = require('axios');
        const { data } = await axios.get(`${metaConfig.graphUrl}/debug_token`, {
          params: { input_token: token, access_token: token },
          timeout: 8000,
        });
        const d = data.data || {};
        if (!d.is_valid) {
          alerts.push({ _id: newId(), type: 'token_invalid', severity: 'critical', message: 'META_SYSTEM_USER_TOKEN is invalid or expired', created_at: now, acknowledged: false });
        } else if (d.expires_at && d.expires_at > 0) {
          const daysLeft = Math.round((d.expires_at * 1000 - Date.now()) / 86400000);
          if (daysLeft < 7) {
            alerts.push({ _id: newId(), type: 'token_expiring', severity: 'warning', message: `META_SYSTEM_USER_TOKEN expires in ${daysLeft} days`, created_at: now, acknowledged: false });
          }
        }
      }
    } catch (e) {
      console.warn('[HealthCheck] Token check failed:', e.message);
    }

    // Store alerts
    if (alerts.length) {
      // Don't duplicate alerts of the same type within 2 hours
      for (const alert of alerts) {
        const recent = await col('platform_alerts').findOne({ type: alert.type, created_at: { $gte: new Date(now - 2 * 3600000) }, acknowledged: false });
        if (!recent) {
          await col('platform_alerts').insertOne(alert);
          console.log(`[HealthCheck] Alert created: ${alert.severity} — ${alert.message}`);
        }
      }
    }

    // Reset 24h counter at midnight IST
    if (istHour === 0) {
      await col('platform_health').updateOne({ _id: 'webhook_heartbeat' }, { $set: { count_24h: 0 } });
    }

    logActivity({ actorType: 'system', action: 'cron.health_check', category: 'platform', description: `Health check: ${alerts.length} alerts`, severity: alerts.length ? 'warning' : 'info' });
  } catch (e) {
    console.error('[HealthCheck] Error:', e.message);
  }
});

module.exports = router;
