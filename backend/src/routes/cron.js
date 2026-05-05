  // src/routes/cron.js
// Cron-triggered endpoints for automated background tasks.
// Protected by CRON_SECRET — only Vercel Cron or external cron services can call these.

'use strict';

const express = require('express');
const router = express.Router();
const { col, newId } = require('../config/database');
const catalog = require('../services/catalog');
const { logActivity } = require('../services/activityLog');
const log = require('../utils/logger').child({ component: 'cron' });

// Auth: verify cron secret (accepts Bearer token or Vercel's internal header)
router.use((req, res, next) => {
  log.info({ method: req.method, url: req.originalUrl, path: req.path }, 'Request received');
  const auth = req.headers['authorization'];
  const secret = process.env.CRON_SECRET;
  if (secret && auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// Periodic full-restaurant resync route removed — event-driven pipeline
// handles Meta sync. The previous external-cron handler walked every
// active restaurant every 30 min and pushed the full catalog to Meta,
// which bloated Commerce Manager's "items with issues" count. Item
// create / update / delete now flow through queueSync() → debouncer →
// BullMQ job (processor started in ec2-server.js boot).

// ─── TRUST METRICS REFRESH (every 6-12 hours) ───────────────
// Recalculates item trust scores, tags, and meta descriptions for all active restaurants.
router.get('/trust-refresh', async (req, res) => {
  res.json({ ok: true, message: 'trust-refresh started', timestamp: new Date().toISOString() });

  try {
    const { SMART_MODULES } = require('../config/features');
    if (!SMART_MODULES.ITEM_TRUST) {
      log.info('Item Trust disabled by feature flag — skipping');
      logActivity({ actorType: 'system', action: 'cron.trust_refresh', category: 'trust', description: 'Skipped — ITEM_TRUST disabled', severity: 'info' });
      return;
    }
    const itemTrust = require('../services/itemTrust');
    const restaurants = await col('restaurants').find({ status: 'active' }).toArray();
    let processed = 0, failed = 0;
    for (const r of restaurants) {
      try {
        await itemTrust.refreshTrustMetrics(String(r._id));
        processed++;
      } catch (e) {
        log.error({ err: e, restaurantName: r.business_name }, 'Trust refresh failed for restaurant');
        failed++;
      }
    }
    log.info({ processed, failed }, 'Trust refresh complete');
    logActivity({ actorType: 'system', action: 'cron.trust_refresh', category: 'trust', description: `Trust refresh: ${processed} restaurants, ${failed} failed`, severity: failed > 0 ? 'warning' : 'info' });
  } catch (e) {
    log.error({ err: e }, 'Trust refresh error');
  }
});

// ─── CART RECOVERY (every 5 minutes) ────────────────────────
// Sends timed recovery reminders for abandoned carts.
router.get('/cart-recovery', async (req, res) => {
  res.json({ ok: true, message: 'cart-recovery started', timestamp: new Date().toISOString() });

  const { SMART_MODULES } = require('../config/features');
  if (!SMART_MODULES.CART_RECOVERY) {
    log.info('Cart Recovery disabled by feature flag — skipping');
    return;
  }
  try {
    const cartRecovery = require('../services/cart-recovery');
    const result = await cartRecovery.processRecoveryQueue();
    log.info({ sent: result.sent, expired: result.expired }, 'Cart recovery complete');
    logActivity({ actorType: 'system', action: 'cron.cart_recovery', category: 'marketing', description: `Cart recovery: ${result.sent} reminders sent, ${result.expired} expired`, severity: 'info' });
  } catch (e) {
    log.error({ err: e }, 'Cart recovery error');
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
      log.warn({ err: e }, 'Token check failed');
    }

    // Store alerts
    if (alerts.length) {
      // Don't duplicate alerts of the same type within 2 hours
      for (const alert of alerts) {
        const recent = await col('platform_alerts').findOne({ type: alert.type, created_at: { $gte: new Date(now - 2 * 3600000) }, acknowledged: false });
        if (!recent) {
          await col('platform_alerts').insertOne(alert);
          log.info({ severity: alert.severity, alertMessage: alert.message }, 'Alert created');
        }
      }
    }

    // Reset 24h counter at midnight IST
    if (istHour === 0) {
      await col('platform_health').updateOne({ _id: 'webhook_heartbeat' }, { $set: { count_24h: 0 } });
    }

    logActivity({ actorType: 'system', action: 'cron.health_check', category: 'platform', description: `Health check: ${alerts.length} alerts`, severity: alerts.length ? 'warning' : 'info' });
  } catch (e) {
    log.error({ err: e }, 'Health check error');
  }
});

// ─── STALE ORDER CLEANUP (every 15 minutes) ─────────────────
// Expires PENDING_PAYMENT and PAYMENT_FAILED orders older than ORDER_EXPIRY_MINUTES (default 60).
// These become EXPIRED (missed sales) — distinct from CANCELLED for analytics.
router.get('/order-cleanup', async (req, res) => {
  res.json({ ok: true, message: 'order-cleanup started', timestamp: new Date().toISOString() });

  try {
    const orderSvc = require('../services/order');
    const { CONFIRMED_ORDER_STATES } = require('../core/orderStateEngine');
    const expiryMinutes = parseInt(process.env.ORDER_EXPIRY_MINUTES || '60');
    const cutoff = new Date(Date.now() - expiryMinutes * 60 * 1000);

    // Find stale unpaid orders
    const staleOrders = await col('orders').find({
      status: { $in: ['PENDING_PAYMENT', 'PAYMENT_FAILED'] },
      created_at: { $lt: cutoff },
    }, { projection: { _id: 1, order_number: 1, status: 1, restaurant_id: 1, total_rs: 1 } }).toArray();

    let expired = 0, failed = 0;
    for (const order of staleOrders) {
      try {
        await orderSvc.updateStatus(String(order._id), 'EXPIRED', {
          cancelReason: `Unpaid for ${expiryMinutes}+ minutes (was ${order.status})`,
          metadata: { previous_status: order.status, expiry_minutes: expiryMinutes },
        });

        // Also expire the associated payment record
        await col('payments').updateMany(
          { order_id: String(order._id), status: { $in: ['sent', 'pending'] } },
          { $set: { status: 'expired', updated_at: new Date() },
            $push: { status_history: { from_status: 'sent', to_status: 'expired', actor: 'system:order-cleanup', changed_at: new Date() } } }
        );

        expired++;
      } catch (e) {
        // May fail if order was already transitioned — non-fatal
        log.warn({ err: e, orderId: String(order._id) }, 'Order cleanup transition failed');
        failed++;
      }
    }

    if (expired > 0 || failed > 0) {
      log.info({ expired, failed, cutoffMinutes: expiryMinutes }, 'Order cleanup complete');
      logActivity({
        actorType: 'system', action: 'cron.order_cleanup', category: 'order',
        description: `Order cleanup: ${expired} expired (missed sales), ${failed} failed`,
        severity: expired > 0 ? 'info' : 'warning',
        metadata: { expired, failed, expiryMinutes },
      });
    }
  } catch (e) {
    log.error({ err: e }, 'Order cleanup error');
  }
});

// ─── PAYOUT RETRY (every 30 minutes) ─────────────────────────
// Retries v2 order_settlements that are in FAILED state.
// Stops after MAX_RETRY_COUNT attempts per settlement.
router.get('/payout-retry', async (req, res) => {
  res.json({ ok: true, message: 'payout-retry started', timestamp: new Date().toISOString() });
  try {
    const payoutEngine = require('../services/payoutEngine');
    const result = await payoutEngine.retryAllFailedSettlements();
    log.info(result, 'Payout retry batch complete');
    if (result.total > 0) {
      logActivity({
        actorType: 'system', action: 'cron.payout_retry', category: 'billing',
        description: `Payout retry: ${result.succeeded} succeeded, ${result.skipped} skipped, ${result.errored} errored`,
        severity: result.errored > 0 ? 'warning' : 'info',
        metadata: result,
      });
    }
  } catch (e) {
    log.error({ err: e }, 'Payout retry error');
  }
});

// ─── RATING REQUEST RECONCILIATION (every 5 minutes) ─────────
// Defense-in-depth for CRIT-2A-01. The primary path is the LOYALTY_AWARD
// durable job (queue/postPaymentJobs.js) scheduled 30 min after DELIVERED.
// This cron catches orders whose job was lost — e.g. a dropped message_jobs
// row or a bug that prevented enqueue — and fires the rating ask.
//
// Dedup strategy:
//   • rating_request_due <= now        — due window reached
//   • rating_requested_at = null       — not already sent (set by the
//                                         queue handler on success OR by
//                                         this cron on success)
//   • no pending/processing LOYALTY_AWARD job for the orderId — if the
//     job is still scheduled or in-flight, let it handle the send to
//     preserve the 30-min delay semantics and avoid a race.
router.post('/rating-requests', async (req, res) => {
  try {
    const now = new Date();
    const candidates = await col('orders').find({
      status: 'DELIVERED',
      rating_request_due: { $lte: now },
      rating_requested_at: null,
    }).limit(50).toArray();

    if (!candidates.length) {
      return res.json({ ok: true, processed: 0, errors: 0 });
    }

    const candidateIds = candidates.map(o => String(o._id));
    const liveJobs = await col('message_jobs').find({
      type: 'LOYALTY_AWARD',
      status: { $in: ['pending', 'processing'] },
      'payload.orderId': { $in: candidateIds },
    }, { projection: { 'payload.orderId': 1 } }).toArray();
    const heldByJob = new Set(liveJobs.map(j => j.payload?.orderId));

    const { sendRatingRequest } = require('../webhooks/whatsapp');
    const { resolveRecipient } = require('../services/customerIdentity');
    const orderSvc = require('../services/order');
    const metaConfig = require('../config/meta');

    let processed = 0, errors = 0, skipped = 0;
    for (const order of candidates) {
      const orderId = String(order._id);
      if (heldByJob.has(orderId)) { skipped++; continue; }
      try {
        const full = await orderSvc.getOrderDetails(orderId);
        if (!full) { skipped++; continue; }
        const customer = await col('customers').findOne({ _id: full.customer_id });
        const waAcc    = await col('whatsapp_accounts').findOne({ restaurant_id: full.restaurant_id, is_active: true });
        const waToken  = metaConfig.systemUserToken || waAcc?.access_token;
        const toId     = customer ? (customer.wa_phone || customer.bsuid) : resolveRecipient(full);
        if (!toId || !waAcc?.phone_number_id || !waToken) { skipped++; continue; }

        await sendRatingRequest(orderId, waAcc.phone_number_id, waToken, toId);
        await col('orders').updateOne(
          { _id: orderId, rating_requested_at: null },
          { $set: { rating_requested_at: new Date() } },
        );
        processed++;
      } catch (err) {
        log.warn({ err, orderId }, 'rating reconciliation send failed');
        errors++;
      }
    }

    log.info({ processed, errors, skipped, candidates: candidates.length }, 'rating-requests cron complete');
    res.json({ ok: true, processed, errors, skipped });
  } catch (e) {
    log.error({ err: e }, 'rating-requests cron error');
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── OWNER DAILY SUMMARY (17:30 UTC = 23:00 IST daily) ───────
// Sends each restaurant's owner mobile devices a roll-up of today's
// orders + revenue. "Today" is server-local midnight (EC2 runs UTC,
// so this is UTC midnight — a deliberate v1 approximation that
// matches the dashboard endpoint's reading). Restaurants without an
// owner push token registered are skipped at the projection level.
//
// Response is sent FIRST so Vercel/external cron sees a quick 200 and
// the actual fan-out runs after the response. Batched at 10
// restaurants per pass so a slow Mongo or Expo round-trip can't tie
// up the event loop on a single chunk.
// Extracted so the EC2 in-process cron (jobs/ownerDailySummary.js) can
// invoke the same code path as the HTTP route without making a self-call.
// No parameters — every input (prefs, restaurants, branches, orders) is
// read from Mongo at call time.
async function runOwnerDailySummary() {
  try {
    const expoPush = require('../services/expoPush');
    const prefs = await expoPush.getOwnerPushPrefs();
    if (!prefs.daily_summary) return;

    const { CONFIRMED_ORDER_STATES } = require('../core/orderStateEngine');
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Only restaurants with at least one owner_push_tokens entry —
    // anyone else has nothing to receive the push.
    const restaurants = await col('restaurants').find(
      { 'owner_push_tokens.0': { $exists: true } },
      { projection: { _id: 1, owner_push_tokens: 1 } },
    ).toArray();

    if (!restaurants.length) {
      log.info('owner-daily-summary: no eligible restaurants');
      return;
    }

    let notified = 0;
    const BATCH = 10;
    for (let i = 0; i < restaurants.length; i += BATCH) {
      const slice = restaurants.slice(i, i + BATCH);
      await Promise.all(slice.map(async (r) => {
        try {
          const tokens = (r.owner_push_tokens || []).map((e) => e?.token).filter(Boolean);
          if (!tokens.length) return;

          const branches = await col('branches').find(
            { restaurant_id: String(r._id), deleted_at: { $exists: false } },
            { projection: { _id: 1 } },
          ).toArray();
          const branchIds = branches.map((b) => b._id);
          if (!branchIds.length) return;

          // Single $in query across all branches — same pattern as the
          // owner dashboard endpoint, then aggregate in JS.
          const orders = await col('orders').find(
            {
              branch_id: { $in: branchIds },
              created_at: { $gte: todayStart },
              status: { $in: CONFIRMED_ORDER_STATES },
            },
            { projection: { total_rs: 1 } },
          ).toArray();
          const totalOrders = orders.length;
          const totalRevenue = orders.reduce((sum, o) => sum + Number(o.total_rs || 0), 0);
          const revenueLabel = Math.round(totalRevenue).toLocaleString('en-IN');

          await expoPush.sendPush(tokens, {
            title: '📊 Daily Summary',
            body: `Today: ${totalOrders} orders · ₹${revenueLabel}`,
            data: { type: 'daily_summary' },
            channelId: 'summary',
          });
          notified += 1;
        } catch (err) {
          log.warn({ err: err?.message, restaurantId: String(r._id) }, 'owner-daily-summary: per-restaurant send failed');
        }
      }));
    }

    log.info({ notified, eligible: restaurants.length }, 'owner-daily-summary complete');
    logActivity({
      actorType: 'system',
      action: 'cron.owner_daily_summary',
      category: 'notification',
      description: `Owner daily summary: notified ${notified} of ${restaurants.length} restaurants`,
      severity: 'info',
    });
  } catch (e) {
    log.error({ err: e }, 'owner-daily-summary error');
  }
}

router.get('/owner-daily-summary', async (req, res) => {
  res.json({ ok: true, message: 'owner daily summary started', timestamp: new Date().toISOString() });
  // Fire-and-forget after the response — same posture as before the
  // extraction. Errors land inside runOwnerDailySummary's outer catch.
  runOwnerDailySummary();
});

module.exports = router;
module.exports.runOwnerDailySummary = runOwnerDailySummary;
