// ec2-server.js
// Standalone Express server for EC2 deployment — handles webhooks + WebSocket.
// Does NOT serve dashboard, admin panel, auth pages, or static files.
// Shares the same MongoDB, services, and config as the Vercel deployment.

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

// ── STARTUP SECRET VALIDATION ────────────────────────────────
// Required secrets must be set. Crash early with clear error in production.
// Mirrors the block in server.js. Modules like adminAuth.js and
// customerAuth.js also enforce their own secrets at require-time —
// this block exists so ops sees ALL missing secrets in one boot log
// instead of a series of one-at-a-time crash-loops.
const REQUIRED_SECRETS = ['JWT_SECRET'];
const REQUIRED_IN_PROD = [
  'ADMIN_JWT_SECRET',
  'CUSTOMER_JWT_SECRET',
  'CUSTOMER_SERVICE_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'MONGODB_URI',
  'WEBHOOK_APP_SECRET',
  'WA_CHECKOUT_WEBHOOK_SECRET',
];
const _missing = REQUIRED_SECRETS.filter(k => !process.env[k]);
if (_missing.length) {
  console.error(`FATAL: Required environment variable(s) missing: ${_missing.join(', ')}`);
  if (process.env.NODE_ENV === 'production') process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  const _missingProd = REQUIRED_IN_PROD.filter(k => !process.env[k]);
  if (_missingProd.length) {
    console.error(`FATAL: Production-required env var(s) missing: ${_missingProd.join(', ')}`);
    process.exit(1);
  }
}

const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const mongoSanitize = require('mongo-sanitize');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── SECURITY: HELMET (must be the very first middleware) ─────
// Default profile — no customisation. The earlier `contentSecurityPolicy:
// false` override is dropped: this is an API server, helmet's default CSP
// is appropriate, and disabling it left X-Powered-By, frame-options, and
// HSTS in a weaker state than helmet ships out of the box.
app.use(helmet());

// ─── SECURITY: CORS (explicit allowlist, no wildcard) ─────────
// Production origins are hard-coded so a forgotten env var can't open the
// API to the world. Vercel preview deployments (*.vercel.app) are matched
// by suffix. Localhost dev origins are added only when NODE_ENV !==
// 'production'. Any other origin → 403.
const CORS_PROD_ORIGINS = [
  'https://gullybite.in',
  'https://www.gullybite.in',
];
const CORS_DEV_ORIGINS = ['http://localhost:3000', 'http://localhost:5173'];
const corsAllowed = [...CORS_PROD_ORIGINS];
if (process.env.NODE_ENV !== 'production') {
  corsAllowed.push(...CORS_DEV_ORIGINS);
}
function isAllowedOrigin(origin) {
  if (corsAllowed.includes(origin)) return true;
  // Vercel preview deployments — suffix match against the hostname only,
  // not a substring of the full URL (avoids `evil.com/?vercel.app` tricks).
  try {
    const host = new URL(origin).hostname;
    if (host.endsWith('.vercel.app')) return true;
  } catch { /* invalid origin URL — fall through to deny */ }
  return false;
}
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / curl / mobile / server-to-server
    if (isAllowedOrigin(origin)) return cb(null, true);
    // Pass an Error so the cors middleware short-circuits with a 500 by
    // default — caught by our handler below to convert to 403.
    return cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Restaurant-Id', 'X-Service-Secret'],
}));

// Convert the cors() Error into a clean 403 instead of a 500 stack trace.
app.use((err, req, res, next) => {
  if (err && typeof err.message === 'string' && err.message.startsWith('CORS blocked:')) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  next(err);
});

// ─── SECURITY: MONGO-SANITIZE (operator-injection guard) ──────
// Strips keys beginning with `$` from req.body / req.query / req.params,
// preventing an attacker from passing `{ "email": { "$ne": null } }` and
// turning a findOne lookup into a wildcard match. Defence-in-depth: even
// if a route handler is careless about extracting fields, the operator
// keys never reach the Mongo driver.
//
// IMPORTANT: req.body is parsed PER-ROUTE in this file (each `app.use(...,
// express.json(), router)` mount), so a global app.use here can only
// sanitise req.query and req.params. Body sanitisation is wired into the
// `jsonAndSanitize` helper below, which replaces every `express.json()`
// call in the route mounts.
app.use((req, res, next) => {
  if (req.query) req.query = mongoSanitize(req.query);
  if (req.params) req.params = mongoSanitize(req.params);
  next();
});

// Helper: body parser + body sanitiser combined. Use anywhere we'd have
// previously written `express.json(opts)` in a route mount. Returns an
// array, which Express accepts as a chain of middlewares.
function jsonAndSanitize(opts) {
  return [
    express.json(opts),
    (req, _res, next) => {
      if (req.body) req.body = mongoSanitize(req.body);
      next();
    },
  ];
}

// ─── REQUEST ID + PER-REQUEST LOGGER ─────────────────────────
// Attaches req.id (unique request ID) and req.log (child logger bound to
// { requestId, method, path }). Routes + webhooks call req.log.* — without
// this middleware those calls throw and hang the request before any response
// is sent. Must be mounted BEFORE any route handler.
const requestId = require('./src/middleware/requestId');
app.use(requestId);

// ─── HEALTH CHECK (no DB needed) ─────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'gullybite-webhook-backend',
    deployment: 'ec2',
    version: '1.0.0',
    time: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
  });
});

// ─── ENSURE DB CONNECTED ────────────────────────────────────
const { ensureConnected, connect } = require('./src/config/database');
app.use(ensureConnected);

// Register event-bus listeners (order.created → WhatsApp + dashboard).
require('./src/events');

// ─── WEBHOOK ROUTES (raw body — each handler applies express.raw internally) ──
app.use('/webhooks/whatsapp', require('./src/webhooks/whatsapp'));
app.use('/webhooks/razorpay', require('./src/webhooks/razorpay'));
app.use('/webhooks/catalog', require('./src/webhooks/catalog'));
app.use('/webhooks/delivery', require('./src/webhooks/delivery'));
app.use('/webhooks/directory', require('./src/webhooks/directory'));
app.use('/webhooks/checkout', require('./src/webhooks/checkout'));

// ─── PUBLIC INLINE HANDLERS ──────────────────────────────────
// Placed before any /api/* mount so Express matches them first.
// Ported from server.js (dead Vercel file) since Meta + customers hit these in prod.

app.get('/placeholder.jpg', (req, res) => {
  res.redirect('https://placehold.co/400x400/1a1a2e/ffffff?text=Food');
});

// Public store landing page — share link surfaced in WhatsApp.
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

// Public catalog feed — Meta fetches hourly. No auth: URL contains an unguessable feed token.
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
    const baseUrl = process.env.BASE_URL;
    if (!baseUrl) throw new Error('BASE_URL is not set; cannot build feed item URLs');

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
    console.error('[EC2] Feed generation failed:', err.message);
    res.status(500).type('text/plain').send('Error generating feed');
  }
});

// ─── WEBHOOK HEALTH CHECK ────────────────────────────────────
app.use('/api/webhook-health', require('./src/routes/webhookHealth'));

// ─── CRON ENDPOINTS (called by cron-job.org) ─────────────────
app.use('/api/cron', jsonAndSanitize(), require('./src/routes/cron'));

// ─── AUTH ROUTES ─────────────────────────────────────────────
// Mounted on EC2 because Vercel no longer runs the Express backend —
// it serves only the static frontend. The auth router does not apply
// express.json() internally, so it must be wired here.
const { router: authRouter } = require('./src/routes/auth');
app.use('/auth', jsonAndSanitize(), authRouter);

// ─── PUBLIC REDIRECT (unauthed customer click-through) ───────
// Mounted BEFORE auth-gated mounts so the customer's WhatsApp link works
// without login.
app.use('/api/review-redirect', require('./src/routes/reviewRedirect'));

// ─── DASHBOARD ROUTES (RESTAURANT) ───────────────────────────
// /api/restaurant/* sub-routes MUST be mounted BEFORE the catch-all
// /api/restaurant router, which would otherwise shadow more specific paths.
app.use('/api/restaurant/products', jsonAndSanitize({ limit: '10mb' }), require('./src/routes/products'));
// Menu file ingestion via multer — do NOT wrap in express.json().
app.use('/api/restaurant/menu', require('./src/routes/menuUpload'));
const _marketing = require('./src/routes/marketingMessages');
app.use('/api/restaurant/marketing-messages', jsonAndSanitize(), _marketing.restaurantRouter);
app.use('/api/admin/marketing-messages', jsonAndSanitize(), _marketing.adminRouter);
app.use('/api/restaurant/customers', jsonAndSanitize(), require('./src/routes/customerProfiles'));
app.use('/api/restaurant/settings', jsonAndSanitize(), require('./src/routes/marketingWa'));
const _campaignTemplates = require('./src/routes/campaignTemplates');
app.use('/api/restaurant/campaign-templates', jsonAndSanitize(), _campaignTemplates.restaurantRouter);
app.use('/api/admin/campaign-templates', jsonAndSanitize(), _campaignTemplates.adminRouter);
app.use('/api/restaurant/marketing-campaigns', jsonAndSanitize(), require('./src/routes/marketingCampaigns'));
const _festivals = require('./src/routes/festivals');
app.use('/api/restaurant/festivals', jsonAndSanitize(), _festivals.restaurantRouter);
app.use('/api/restaurant/campaigns', jsonAndSanitize(), _festivals.restaurantCampaignsRouter);
app.use('/api/admin/festivals', jsonAndSanitize(), _festivals.adminRouter);
app.use('/api/restaurant/auto-journeys', jsonAndSanitize(), require('./src/routes/autoJourneys'));
app.use('/api/restaurant/loyalty-program', jsonAndSanitize(), require('./src/routes/loyalty'));
app.use('/api/restaurant/feedback', jsonAndSanitize(), require('./src/routes/dineInFeedback'));
const _marketingAnalytics = require('./src/routes/marketingAnalytics');
app.use('/api/restaurant/marketing-analytics', jsonAndSanitize(), _marketingAnalytics.restaurantRouter);
// Catch-all /api/restaurant router — must be LAST of the /api/restaurant/* group.
app.use('/api/restaurant', jsonAndSanitize({ limit: '10mb' }), require('./src/routes/restaurant'));

// ─── UPLOADS + STAFF + ADMIN PANEL + CUSTOMER ────────────────
app.use('/api/upload', jsonAndSanitize(), require('./src/routes/upload'));
// Staff POS router applies body parsers per-route — /stream is SSE and must
// not be consumed by a top-level express.json().
app.use('/api/staff', require('./src/routes/staff'));
app.use('/api/admin', jsonAndSanitize(), require('./src/routes/admin'));
app.use('/api/admin/pincodes', jsonAndSanitize(), require('./src/routes/adminPincodes'));
app.use('/api/customer', jsonAndSanitize(), require('./src/routes/customer'));
app.use('/api/admin/analytics', jsonAndSanitize(), require('./src/routes/analytics'));
app.use('/api/admin/platform-marketing', jsonAndSanitize(), _marketingAnalytics.adminRouter);

// ─── ENCRYPTED / RAW-BODY ENDPOINTS ──────────────────────────
// Each router owns its own parser — payloads are encrypted (ECDH+AES-GCM /
// RSA+AES-GCM) or HMAC-signed and must not be pre-parsed.
app.use('/api/checkout-endpoint', require('./src/routes/checkout-endpoint'));
app.use('/flow/address', require('./src/routes/flowAddress'));
app.use('/webhook/prorouting', require('./src/routes/webhookProrouting'));

// ─── 404 FOR ANYTHING ELSE ──────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found — this is the webhook backend. Dashboard routes are on Vercel.' });
});

// ─── ERROR HANDLER ──────────────────────────────────────────
// Production: response body is the generic message ONLY — no stack, no
// err.message. The full error (message + stack) is always logged
// server-side via console.error so EC2 logs / pm2 / CloudWatch still
// capture it for debugging.
// Development: include err.message + stack in the response so local
// debugging stays ergonomic.
app.use((err, req, res, _next) => {
  console.error('[EC2] Unhandled error:', err?.message, '\n', err?.stack);
  if (process.env.NODE_ENV === 'production') {
    return res.status(500).json({ error: 'Internal server error' });
  }
  res.status(500).json({
    error: 'Internal server error',
    message: err?.message,
    stack: err?.stack,
  });
});

// ─── HTTP SERVER + WEBSOCKET ────────────────────────────────
const server = http.createServer(app);

// WebSocket server on /ws path
const wss = new WebSocketServer({ noServer: true });
const wsManager = require('./src/services/wsManager');
wsManager.init(wss);

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname !== '/ws') { socket.destroy(); return; }

  // Accept both ?restaurant_id=xxx and ?room=restaurant:xxx formats
  let restaurantId = url.searchParams.get('restaurant_id');
  const room = url.searchParams.get('room');
  if (!restaurantId && room) restaurantId = room.replace('restaurant:', '');
  const token = url.searchParams.get('token');

  // Authenticate
  if (!token || !process.env.JWT_SECRET) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  try {
    jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    const room = restaurantId || 'admin';
    wsManager.addConnection(room, ws);
    console.log(`[WS] Connected: ${room} (total: ${wsManager.getConnectionCount()})`);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', () => {
      wsManager.removeConnection(room, ws);
      console.log(`[WS] Disconnected: ${room} (total: ${wsManager.getConnectionCount()})`);
    });
  });
});

// Ping every 30s to keep connections alive through nginx/proxies
const pingInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
wss.on('close', () => clearInterval(pingInterval));

// ─── START ──────────────────────────────────────────────────
const metaConfig = require('./src/config/meta');
metaConfig.logStatus();

connect().then(() => {
  require('./src/config/indexes').ensureIndexes().catch(e => console.warn('[DB] Index init:', e.message));

  const { scheduleSettlement } = require('./src/jobs/settlement');
  scheduleSettlement();

  // try { require('./src/jobs/campaignSender'); } catch (e) { console.warn('[EC2] Campaign sender:', e.message); }
  console.log('[EC2] Campaign sender: disabled — module not yet implemented');

  // BullMQ orders queue — producer + worker. EC2-only; Vercel cannot reach
  // ElastiCache across its VPC boundary. Skipped entirely if REDIS_URL is unset.
  if (process.env.REDIS_URL) {
    try {
      require('./src/queue/orderProducer').register();
      require('./src/workers/orderWorker').start();
      console.log('[EC2] BullMQ orders queue: producer + worker started');
    } catch (err) {
      console.error('[EC2] BullMQ setup failed:', err.message);
    }
  } else {
    console.log('[EC2] BullMQ orders queue: disabled (REDIS_URL not set)');
  }

  server.listen(PORT, () => {
    console.log(`\n🚀 [EC2] GullyBite Webhook Backend running on port ${PORT}`);
    console.log(`   Webhooks:  http://localhost:${PORT}/webhooks/whatsapp`);
    console.log(`   WebSocket: ws://localhost:${PORT}/ws`);
    console.log(`   Health:    http://localhost:${PORT}/health`);
    console.log(`   Cron:      http://localhost:${PORT}/api/cron/catalog-sync\n`);
  });
}).catch(err => {
  console.error('❌ [EC2] Failed to start:', err.message);
  process.exit(1);
});

module.exports = app;
