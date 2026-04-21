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
