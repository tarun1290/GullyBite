// ec2-server.js
// Standalone Express server for EC2 deployment — handles webhooks and real-time messaging.
// Does NOT serve dashboard, admin panel, auth pages, or static files.
// Shares the same MongoDB, services, and config as the Vercel deployment.

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── SECURITY ────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.FRONTEND_URL || process.env.BASE_URL || '*',
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

// ─── 404 FOR ANYTHING ELSE ──────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found — this is the webhook backend. Dashboard routes are on Vercel.' });
});

// ─── ERROR HANDLER ──────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[EC2] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── START ──────────────────────────────────────────────────
const metaConfig = require('./src/config/meta');
metaConfig.logStatus();

connect().then(() => {
  // Ensure indexes after DB connects
  require('./src/config/indexes').ensureIndexes().catch(e => console.warn('[DB] Index init:', e.message));

  // Schedule cron jobs (settlement, referral expiry)
  const { scheduleSettlement } = require('./src/jobs/settlement');
  scheduleSettlement();

  // Schedule campaign sender
  try { require('./src/jobs/campaignSender'); } catch (e) { console.warn('[EC2] Campaign sender:', e.message); }

  app.listen(PORT, () => {
    console.log(`\n🚀 [EC2] GullyBite Webhook Backend running on port ${PORT}`);
    console.log(`   Webhooks:  http://localhost:${PORT}/webhooks/whatsapp`);
    console.log(`   Health:    http://localhost:${PORT}/health`);
    console.log(`   Cron:      http://localhost:${PORT}/api/cron/catalog-sync\n`);
  });
}).catch(err => {
  console.error('❌ [EC2] Failed to start:', err.message);
  process.exit(1);
});

module.exports = app;
