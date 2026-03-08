// server.js
// Works both locally (npm run dev) AND on Vercel (serverless)

// Load .env — check backend/ first (local dev), then root (Vercel/other)
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

// ─── SECURITY ─────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? [process.env.BASE_URL, /\.vercel\.app$/]
    : '*',
  credentials: true,
}));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

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

// ─── IMAGE SERVING (MongoDB GridFS — needs DB) ────────────────
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

// ─── ROUTES ───────────────────────────────────────────────────
const { router: authRouter } = require('./src/routes/auth');
app.use('/auth', express.json(), authRouter);
app.use('/api/restaurant', express.json(), require('./src/routes/restaurant'));
app.use('/api/restaurant/integrations', express.json(), require('./src/routes/integrations'));
app.use('/api/admin', express.json(), require('./src/routes/admin'));

// Webhooks need raw body for HMAC signature verification
app.use('/webhooks/whatsapp', require('./src/webhooks/whatsapp'));
app.use('/webhooks/razorpay', require('./src/webhooks/razorpay'));
app.use('/webhooks/catalog',  require('./src/webhooks/catalog'));

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
  console.error('Server error:', err.message);
  res.status(500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// ─── LOCAL DEV: start server normally ─────────────────────────
// On Vercel this block is SKIPPED — Vercel imports app directly
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n🍔 GullyBite running → http://localhost:${PORT}`);
    console.log(`   WA Webhook  → ${process.env.BASE_URL}/webhooks/whatsapp`);
    console.log(`   Pay Webhook → ${process.env.BASE_URL}/webhooks/razorpay\n`);

    const { scheduleSettlement } = require('./src/jobs/settlement');
    scheduleSettlement();
  });
}

// Vercel needs this export
module.exports = app;