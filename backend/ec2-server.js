// ec2-server.js
// Standalone Express server for EC2 deployment — handles webhooks + WebSocket.
// Does NOT serve dashboard, admin panel, auth pages, or static files.
// Shares the same MongoDB, services, and config as the Vercel deployment.

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── SECURITY ────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// Explicit CORS allowlist. No wildcard fallback — unconfigured origins are
// rejected so a forgotten env var can't open the API to the world.
const corsAllowed = (process.env.CORS_ALLOWED_ORIGINS || process.env.FRONTEND_URL || process.env.BASE_URL || '')
  .split(',').map(s => s.trim()).filter(Boolean);
if (process.env.NODE_ENV !== 'production') {
  corsAllowed.push('http://localhost:3000', 'http://localhost:5173');
}
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / curl / mobile
    if (corsAllowed.includes(origin) || /\.vercel\.app$/.test(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));

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
    console.error('[EC2] Feed generation failed:', err.message);
    res.status(500).type('text/plain').send('Error generating feed');
  }
});

// ─── WEBHOOK HEALTH CHECK ────────────────────────────────────
app.use('/api/webhook-health', require('./src/routes/webhookHealth'));

// ─── CRON ENDPOINTS (called by cron-job.org) ─────────────────
app.use('/api/cron', express.json(), require('./src/routes/cron'));

// ─── AUTH ROUTES ─────────────────────────────────────────────
// Mounted on EC2 because Vercel no longer runs the Express backend —
// it serves only the static frontend. The auth router does not apply
// express.json() internally, so it must be wired here.
const { router: authRouter } = require('./src/routes/auth');
app.use('/auth', express.json(), authRouter);

// ─── PUBLIC REDIRECT (unauthed customer click-through) ───────
// Mounted BEFORE auth-gated mounts so the customer's WhatsApp link works
// without login.
app.use('/api/review-redirect', require('./src/routes/reviewRedirect'));

// ─── DASHBOARD ROUTES (RESTAURANT) ───────────────────────────
// /api/restaurant/* sub-routes MUST be mounted BEFORE the catch-all
// /api/restaurant router, which would otherwise shadow more specific paths.
app.use('/api/restaurant/products', express.json({ limit: '10mb' }), require('./src/routes/products'));
// Menu file ingestion via multer — do NOT wrap in express.json().
app.use('/api/restaurant/menu', require('./src/routes/menuUpload'));
const _marketing = require('./src/routes/marketingMessages');
app.use('/api/restaurant/marketing-messages', express.json(), _marketing.restaurantRouter);
app.use('/api/admin/marketing-messages', express.json(), _marketing.adminRouter);
app.use('/api/restaurant/customers', express.json(), require('./src/routes/customerProfiles'));
app.use('/api/restaurant/settings', express.json(), require('./src/routes/marketingWa'));
const _campaignTemplates = require('./src/routes/campaignTemplates');
app.use('/api/restaurant/campaign-templates', express.json(), _campaignTemplates.restaurantRouter);
app.use('/api/admin/campaign-templates', express.json(), _campaignTemplates.adminRouter);
app.use('/api/restaurant/marketing-campaigns', express.json(), require('./src/routes/marketingCampaigns'));
const _festivals = require('./src/routes/festivals');
app.use('/api/restaurant/festivals', express.json(), _festivals.restaurantRouter);
app.use('/api/restaurant/campaigns', express.json(), _festivals.restaurantCampaignsRouter);
app.use('/api/admin/festivals', express.json(), _festivals.adminRouter);
app.use('/api/restaurant/auto-journeys', express.json(), require('./src/routes/autoJourneys'));
app.use('/api/restaurant/loyalty-program', express.json(), require('./src/routes/loyalty'));
app.use('/api/restaurant/feedback', express.json(), require('./src/routes/dineInFeedback'));
const _marketingAnalytics = require('./src/routes/marketingAnalytics');
app.use('/api/restaurant/marketing-analytics', express.json(), _marketingAnalytics.restaurantRouter);
// Catch-all /api/restaurant router — must be LAST of the /api/restaurant/* group.
app.use('/api/restaurant', express.json({ limit: '10mb' }), require('./src/routes/restaurant'));

// ─── UPLOADS + STAFF + ADMIN PANEL + CUSTOMER ────────────────
app.use('/api/upload', express.json(), require('./src/routes/upload'));
// Staff POS router applies body parsers per-route — /stream is SSE and must
// not be consumed by a top-level express.json().
app.use('/api/staff', require('./src/routes/staff'));
app.use('/api/admin', express.json(), require('./src/routes/admin'));
app.use('/api/admin/pincodes', express.json(), require('./src/routes/adminPincodes'));
app.use('/api/customer', express.json(), require('./src/routes/customer'));
app.use('/api/admin/analytics', express.json(), require('./src/routes/analytics'));
app.use('/api/admin/platform-marketing', express.json(), _marketingAnalytics.adminRouter);

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
app.use((err, req, res, _next) => {
  console.error('[EC2] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
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
