// server.js
// Works both locally (npm run dev) AND on Vercel (serverless)

// Load .env — check backend/ first (local dev), then root (Vercel/other)
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// ── STARTUP SECRET VALIDATION ────────────────────────────────
// Required secrets must be set. Crash early with clear error in production.
const REQUIRED_SECRETS = ['JWT_SECRET'];
const REQUIRED_IN_PROD = [
  'ADMIN_JWT_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'MONGODB_URI',
  'WEBHOOK_APP_SECRET',          // Meta WhatsApp / Directory X-Hub-Signature-256
  'WA_CHECKOUT_WEBHOOK_SECRET',  // WhatsApp checkout webhook HMAC
  'DELIVERY_WEBHOOK_SECRET',     // 3PL delivery webhook bearer
];
const missing = REQUIRED_SECRETS.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`FATAL: Required environment variable(s) missing: ${missing.join(', ')}`); // console.error OK — logger not loaded yet
  if (process.env.NODE_ENV === 'production') process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  const missingProd = REQUIRED_IN_PROD.filter(k => !process.env[k]);
  if (missingProd.length) {
    console.error(`FATAL: Production-required env var(s) missing: ${missingProd.join(', ')}`); // console.error OK — logger not loaded yet
    process.exit(1);
  }
}

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const log = require('./src/utils/logger');
const requestId = require('./src/middleware/requestId');
const { apiLimiter, authLimiter, globalLimiter, rateLimitFn, limits: rlLimits, isBlocked } = require('./src/middleware/rateLimit');

const app = express();

// ─── REQUEST ID ──────────────────────────────────────────────
app.use(requestId);

// ─── FEATURE FLAGS ─────────────────────────────────────────────
const features = require('./src/config/features');
log.info({ component: 'features' }, `Image Pipeline: ${features.IMAGE_PIPELINE_ENABLED ? 'ON' : 'OFF'}`);
log.info({ component: 'features' }, `POS Integrations: ${features.POS_INTEGRATIONS_ENABLED ? 'ON' : 'OFF'}`);

// ─── META CONFIG STATUS ───────────────────────────────────────
const metaConfig = require('./src/config/meta');
metaConfig.logStatus();

// ─── SECURITY ─────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// Explicit CORS allowlist. In production, only BASE_URL + *.vercel.app are
// allowed. In dev, localhost is added. No wildcard fallback even in dev —
// that used to mask misconfigured origins.
const corsAllowed = (process.env.CORS_ALLOWED_ORIGINS || process.env.BASE_URL || '')
  .split(',').map(s => s.trim()).filter(Boolean);
if (process.env.NODE_ENV !== 'production') {
  corsAllowed.push('http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000');
}
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (corsAllowed.includes(origin) || /\.vercel\.app$/.test(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));

// ─── RATE LIMITING ───────────────────────────────────────────
// Layered protection:
//   (a) Global ceiling: 1000 req/min across the whole platform — catches
//       runaway clients, cron storms, coordinated spam. Applied FIRST so a
//       flood burns the global bucket, not per-IP buckets.
//   (b) Per-IP API: 100 req/min — legacy in-memory, fine-grained.
//   (c) Short-lived Redis block check on /api and /auth so a flagged IP
//       bounces before doing any real work.
//   (d) Auth: 10 attempts per 60s per IP (Redis, spec-compliant). Narrower
//       than before (was 5/15min) but the shorter window matches typical
//       legit retry patterns — e.g. user mistyping OTP 3–4 times in a row.
app.use((req, res, next) => {
  try {
    const { allowed, retryAfterMs } = globalLimiter.isAllowed('platform');
    if (!allowed) {
      res.set('Retry-After', String(Math.ceil((retryAfterMs || 60000) / 1000)));
      return res.status(429).json({ error: 'Service is temporarily busy. Please try again shortly.' });
    }
  } catch { /* fail-open on limiter errors */ }
  next();
});

app.use('/api/', async (req, res, next) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  // Reject hot-blocked IPs fast
  const block = await isBlocked(`auth:${ip}`).catch(() => ({ blocked: false }));
  if (block.blocked) {
    res.set('Retry-After', String(block.ttl || 600));
    return res.status(429).json({ error: 'Too many requests, please try again shortly.', blocked: true });
  }
  const { allowed, remaining, retryAfterMs } = apiLimiter.isAllowed(ip);
  if (!allowed) {
    res.set('Retry-After', String(Math.ceil((retryAfterMs || 60000) / 1000)));
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }
  res.set('X-RateLimit-Remaining', String(remaining));
  next();
});

// Auth: spec calls for 10/60s per IP. GET /me and /meta-config are exempt
// — one is a profile read, the other is a public config fetched on every
// page load; neither is a login attempt.
app.use('/auth/', (req, res, next) => {
  if (req.method === 'GET' && (req.path === '/me' || req.path === '/meta-config')) return next();
  return rateLimitFn(
    r => `auth:${r.ip || r.headers['x-forwarded-for'] || 'unknown'}`,
    10,
    60,
    { message: 'Too many auth attempts, please try again shortly.' }
  )(req, res, next);
});

// ─── STATIC FILES ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../frontend')));

app.get('/placeholder.jpg', (req, res) => {
  res.redirect('https://placehold.co/400x400/1a1a2e/ffffff?text=Food');
});

// ─── HEALTH CHECK (no DB needed) ──────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', time: new Date() });
});

// ─── ENSURE DB CONNECTED BEFORE ANY ROUTE THAT NEEDS IT ───────
const { ensureConnected } = require('./src/config/database');
app.use(ensureConnected);

// Register event-bus listeners (order.created → WhatsApp + dashboard).
require('./src/events');

/* ═══ FUTURE FEATURE: GridFS Image Serving ═══
   Legacy route that served images from MongoDB GridFS.
   Replaced by S3 + CloudFront CDN (see imageUpload.js).
   Keep as reference for any future GridFS-based file serving needs.

   app.get('/images/:fileId', async (req, res) => {
     try {
       const { ObjectId } = require('mongodb');
       const { getBucket } = require('./src/config/database');
       const bucket = getBucket();
       let id;
       try { id = new ObjectId(req.params.fileId); } catch { return res.status(400).json({ error: 'Invalid image ID' }); }
       const files = await bucket.find({ _id: id }).toArray();
       if (!files.length) return res.status(404).json({ error: 'Image not found' });
       res.set('Content-Type', files[0].contentType || 'image/jpeg');
       res.set('Cache-Control', 'public, max-age=31536000');
       bucket.openDownloadStream(id).pipe(res);
     } catch (err) {
       res.status(500).json({ error: err.message });
     }
   });
   ═══ END FUTURE FEATURE ═══ */

// ─── PUBLIC STORE PAGE ────────────────────────────────────────
app.get('/store/:slug', async (req, res) => {
  try {
    const { col } = require('./src/config/database');
    const restaurant = await col('restaurants').findOne(
      { store_slug: req.params.slug, approval_status: 'approved' },
      { projection: { business_name: 1, brand_name: 1, city: 1, restaurant_type: 1, logo_url: 1, store_url: 1 } }
    );
    if (!restaurant) return res.status(404).send('<h2>Store not found</h2>');
    const name = restaurant.brand_name || restaurant.business_name;
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>${name} — Order on WhatsApp</title>
      <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem}.card{background:#fff;border-radius:1rem;padding:2.5rem;text-align:center;max-width:420px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.08)}.logo{font-size:3rem;margin-bottom:1rem}h1{font-size:1.6rem;font-weight:700;margin-bottom:.4rem}p{color:#64748b;margin-bottom:1.5rem;font-size:.95rem}.badge{display:inline-block;padding:.25rem .75rem;border-radius:99px;font-size:.75rem;font-weight:600;margin-bottom:1rem}.veg{background:#dcfce7;color:#15803d}.nveg{background:#fee2e2;color:#b91c1c}.both{background:#e0e7ff;color:#4338ca}</style>
    </head><body><div class="card">
      ${restaurant.logo_url ? `<img src="${restaurant.logo_url}" alt="logo" style="width:80px;height:80px;border-radius:12px;object-fit:cover;margin-bottom:1rem">` : '<div class="logo">🍽️</div>'}
      <h1>${name}</h1>
      ${restaurant.city ? `<p style="margin-bottom:.5rem">📍 ${restaurant.city}</p>` : ''}
      <span class="badge ${{veg:'veg',non_veg:'nveg',both:'both'}[restaurant.restaurant_type]||'both'}">${{veg:'Pure Veg',non_veg:'Non-Veg',both:'Veg &amp; Non-Veg'}[restaurant.restaurant_type]||'Veg &amp; Non-Veg'}</span>
      <p>Order directly on WhatsApp — fast, simple and no app needed.</p>
    </div></body></html>`);
  } catch (err) {
    res.status(500).send('<h2>Error loading store</h2>');
  }
});

// ─── PUBLIC CATALOG FEED (Meta fetches this periodically) ─────
// No auth — URL contains an unguessable token
app.get('/feed/:feedToken', async (req, res) => {
  try {
    const { col } = require('./src/config/database');
    const restaurant = await col('restaurants').findOne({ catalog_feed_token: req.params.feedToken });
    if (!restaurant) return res.status(404).type('text/plain').send('Feed not found');

    const rid = String(restaurant._id);
    const branches = await col('branches').find({ restaurant_id: rid }).toArray();
    const branchIds = branches.map(b => String(b._id));

    const items = await col('menu_items').find({
      branch_id: { $in: branchIds },
      is_available: true,
      retailer_id: { $exists: true, $ne: null },
    }).toArray();

    const esc = v => `"${String(v || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`;
    const brandName = esc(restaurant.business_name || 'Restaurant');
    const baseUrl = process.env.BASE_URL || 'https://gully-bite.vercel.app';

    const header = 'id,title,description,availability,condition,price,link,image_link,brand,google_product_category';
    const rows = items.map(item => {
      const title = esc((item.variant_value ? `${item.name} - ${item.variant_value}` : item.name).substring(0, 100));
      const desc  = esc((item.description || item.name).substring(0, 999));
      const price = `${(item.price_paise / 100).toFixed(2)} INR`;
      const link  = `${baseUrl}/menu/${String(item._id)}`;
      const img   = item.image_url || `${baseUrl}/placeholder.jpg`;
      return [item.retailer_id, title, desc, 'in stock', 'new', price, link, img, brandName, '1567'].join(',');
    });

    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send([header, ...rows].join('\n'));
  } catch (err) {
    log.error({ component: 'feed', err }, 'Feed generation failed');
    res.status(500).type('text/plain').send('Error generating feed');
  }
});

// ─── ROUTES ───────────────────────────────────────────────────
app.get('/auth/test', (req, res) => res.json({ ok: true }));
const { router: authRouter } = require('./src/routes/auth');
app.use('/auth', express.json(), authRouter);
// Branch-first product routes. Mounted BEFORE the legacy restaurant
// router so specific paths (/products/unassigned, /products/:id/assign-branch)
// resolve here rather than being shadowed by catch-all handlers downstream.
app.use('/api/restaurant/products', express.json({ limit: '10mb' }), require('./src/routes/products'));
// Menu file ingestion (XLSX). Mounted BEFORE the catch-all restaurant
// router so /menu/upload doesn't collide with menu CRUD endpoints there.
// Multer parses multipart/form-data — do NOT wrap in express.json().
app.use('/api/restaurant/menu', require('./src/routes/menuUpload'));
// Marketing messages ledger — mounted before catch-all restaurant router.
const _marketing = require('./src/routes/marketingMessages');
app.use('/api/restaurant/marketing-messages', express.json(), _marketing.restaurantRouter);
app.use('/api/admin/marketing-messages', express.json(), _marketing.adminRouter);
app.use('/api/restaurant', express.json({ limit: '10mb' }), require('./src/routes/restaurant'));
// POS_DISABLED — POS integrations router (Petpooja/UrbanPiper/DotPe) gated off.
// Re-enable by uncommenting and setting POS_ENABLED=true.
// app.use('/api/restaurant/integrations', express.json(), require('./src/routes/integrations'));
app.use('/api/upload', express.json(), require('./src/routes/upload'));
app.use('/api/admin', express.json(), require('./src/routes/admin'));
// Phase 1 (Commit A): customer-facing API — addresses + profile. Cart
// / reorder / order-create land with the WhatsApp flow handler (Commit B).
app.use('/api/customer', express.json(), require('./src/routes/customer'));
app.use('/api/admin/analytics', express.json(), require('./src/routes/analytics'));
app.use('/api/cron', express.json(), require('./src/routes/cron'));
app.use('/api/webhook-health', require('./src/routes/webhookHealth'));
// Meta WhatsApp Checkout endpoint (beta, ECDH + AES-GCM). Route owns its
// own json parser — mounted bare so request body is untouched before decrypt.
app.use('/api/checkout-endpoint', require('./src/routes/checkout-endpoint'));
// Address Flow endpoint — Google Places autocomplete + submit handler.
// Same RSA+AES-GCM crypto as /api/checkout-endpoint; route owns its parser.
app.use('/flow/address', require('./src/routes/flowAddress'));

// Prorouting (3PL) webhook — lifecycle callbacks from the dispatch
// partner. Owns its own parser and api-key auth; see
// src/routes/webhookProrouting.js.
app.use('/webhook/prorouting', require('./src/routes/webhookProrouting'));

// Webhooks: either handled here (Vercel) or offloaded to EC2 backend
if (process.env.USE_EC2_WEBHOOKS === 'true') {
  // Webhooks handled by EC2 — return 200 to prevent Meta retries during migration
  app.use('/webhooks', (req, res) => {
    req.log.info({ component: 'webhook' }, 'Webhook forwarded to EC2');
    res.status(200).json({ message: 'Webhooks handled by EC2 backend', ec2_url: process.env.EC2_BACKEND_URL });
  });
} else {
  // Webhooks handled here on Vercel (default — no flag set)
  app.use('/webhooks/whatsapp', require('./src/webhooks/whatsapp'));
  app.use('/webhooks/razorpay', require('./src/webhooks/razorpay'));
  app.use('/webhooks/catalog',  require('./src/webhooks/catalog'));
  app.use('/webhooks/delivery',  require('./src/webhooks/delivery'));
  app.use('/webhooks/directory', require('./src/webhooks/directory'));
  app.use('/webhooks/checkout',  require('./src/webhooks/checkout'));
  // POS_DISABLED — POS webhook handler (Petpooja/UrbanPiper/DotPe) gated off.
  // Re-enable by uncommenting and setting POS_ENABLED=true.
  // app.use('/webhooks/pos',      require('./src/webhooks/pos'));
}

// Admin dashboard
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/admin.html'));
});

// Restaurant dashboard (post-login)
app.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/dashboard.html'));
});

// Payment redirect page
app.get('/payment-success', (req, res) => {
  const status = req.query.razorpay_payment_link_status;
  const success = status === 'paid';
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${success ? 'Payment Successful' : 'Payment Failed'}</title>
    <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem}.card{background:#1e293b;border-radius:1rem;padding:2.5rem;text-align:center;max-width:400px;width:100%}.icon{font-size:4rem;margin-bottom:1rem}h1{font-size:1.5rem;margin-bottom:.75rem}p{color:#94a3b8}</style>
    </head><body><div class="card">
    <div class="icon">${success ? '✅' : '❌'}</div>
    <h1>${success ? 'Payment Successful!' : 'Payment Failed'}</h1>
    <p>${success ? 'Your order is confirmed. You will receive WhatsApp updates.' : 'Payment could not be completed. Please try again.'}</p>
    </div></body></html>`);
});

// Fallback → frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ─── ERROR HANDLER ────────────────────────────────────────────
app.use((err, req, res, next) => {
  // RateLimitExceededError bubbled up from service-layer guards (e.g.
  // orderSvc.createOrder) — surface as HTTP 429 with Retry-After.
  if (err && err.code === 'RATE_LIMIT_EXCEEDED') {
    const retryAfterSec = Math.ceil((err.retryAfterMs || 60000) / 1000);
    res.set('Retry-After', String(retryAfterSec));
    return res.status(429).json({
      error: 'Too many requests, please try again shortly.',
      retry_after_seconds: retryAfterSec,
    });
  }
  log.error({ component: 'server', err, requestId: req?.id }, 'Unhandled route error');
  res.status(500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// ─── LOCAL DEV: start server normally ─────────────────────────
// On Vercel this block is SKIPPED — Vercel imports app directly
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    log.info({ component: 'server', port: PORT }, `GullyBite running on http://localhost:${PORT}`);
    log.info({ component: 'server' }, `WA Webhook  → ${process.env.BASE_URL}/webhooks/whatsapp`);
    log.info({ component: 'server' }, `Pay Webhook → ${process.env.BASE_URL}/webhooks/razorpay`);
    // POS_DISABLED — log suppressed while POS integrations are off.
    // log.info({ component: 'server' }, `POS Webhook → ${process.env.BASE_URL}/webhooks/pos/{platform}`);

    // Ensure MongoDB indexes after DB connects (fire-and-forget)
    const { connect } = require('./src/config/database');
    connect().then(() => require('./src/config/indexes').ensureIndexes()).catch(e => log.warn({ component: 'db', err: e }, 'Index init failed'));

    const { scheduleSettlement } = require('./src/jobs/settlement');
    scheduleSettlement();

    const { scheduleWebhookRetry } = require('./src/jobs/webhook-retry');
    scheduleWebhookRetry();

    const { scheduleCampaignSender } = require('./src/jobs/campaign-sender');
    scheduleCampaignSender();

    // POS_DISABLED — periodic POS menu sync cron suppressed.
    // const { schedulePosSync } = require('./src/jobs/pos-sync');
    // schedulePosSync();

    const { scheduleRecovery } = require('./src/jobs/recovery');
    scheduleRecovery();

    // Mongo-backed outbound WhatsApp message worker. Polls `message_jobs`,
    // delegates to wa.sendMessage, retries with exponential backoff.
    require('./src/queue/messageWorker').start();

    // Phase 3: post-payment fan-out worker. Handles ORDER_DISPATCH,
    // CUSTOMER_NOTIFICATION, POS_SYNC jobs enqueued by the Razorpay
    // payment-success path. Persistent retries + process-restart safety.
    require('./src/queue/postPaymentJobs').start();

    // Phase 3.1: nightly ledger-vs-Razorpay reconciliation. STUB — the
    // Razorpay settlements fetch is a placeholder. Scheduling it now so
    // cron wiring/ops are in place when the fetch lands.
    require('./src/jobs/reconciliation').schedule();

    // Phase 4: catalog sync scheduler. Claims due rows from
    // catalog_sync_schedule and dispatches CATALOG_SYNC jobs.
    require('./src/services/catalogSyncQueue').startProcessor();

    // Phase 5: daily on-demand settlement payout cron. Drains each
    // tenant's restaurant_ledger balance into a paise-shaped settlement
    // row + Razorpay payout (subject to MIN_PAYOUT_PAISE threshold).
    require('./src/jobs/settlementPayout').schedule();
  });
}

// Vercel needs this export
module.exports = app;