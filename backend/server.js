// server.js
// Works both locally (npm run dev) AND on Vercel (serverless)

// Load .env — check backend/ first (local dev), then root (Vercel/other)
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { apiLimiter, authLimiter } = require('./src/middleware/rateLimit');

const app = express();

// ─── FEATURE FLAGS ─────────────────────────────────────────────
const features = require('./src/config/features');
console.log('[Features] Image Pipeline:', features.IMAGE_PIPELINE_ENABLED ? '✅ ON' : '⚠️  OFF');
console.log('[Features] POS Integrations:', features.POS_INTEGRATIONS_ENABLED ? '✅ ON' : '⚠️  OFF');

// ─── META CONFIG STATUS ───────────────────────────────────────
const metaConfig = require('./src/config/meta');
metaConfig.logStatus();

// ─── SECURITY ─────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? [process.env.BASE_URL, /\.vercel\.app$/]
    : '*',
  credentials: true,
}));

// ─── RATE LIMITING ───────────────────────────────────────────
// General API rate limit: 100 req/min per IP
app.use('/api/', (req, res, next) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const { allowed, remaining, retryAfterMs } = apiLimiter.isAllowed(ip);
  if (!allowed) {
    res.set('Retry-After', String(Math.ceil((retryAfterMs || 60000) / 1000)));
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }
  res.set('X-RateLimit-Remaining', String(remaining));
  next();
});
// Stricter limit for auth endpoints: 5 attempts per 15 min per IP
// Exempt GET /auth/me — it's a profile read, not a login attempt
app.use('/auth/', (req, res, next) => {
  if (req.method === 'GET' && req.path === '/me') return next();
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const { allowed, retryAfterMs } = authLimiter.isAllowed(ip);
  if (!allowed) {
    res.set('Retry-After', String(Math.ceil((retryAfterMs || 900000) / 1000)));
    return res.status(429).json({ error: 'Too many login attempts. Please wait 15 minutes.' });
  }
  next();
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
    console.error('[Feed]', err.message);
    res.status(500).type('text/plain').send('Error generating feed');
  }
});

// ─── ROUTES ───────────────────────────────────────────────────
const { router: authRouter } = require('./src/routes/auth');
app.use('/auth', express.json(), authRouter);
app.use('/api/restaurant', express.json(), require('./src/routes/restaurant'));
app.use('/api/restaurant/integrations', express.json(), require('./src/routes/integrations'));
app.use('/api/upload', express.json(), require('./src/routes/upload'));
app.use('/api/admin', express.json(), require('./src/routes/admin'));

// Webhooks need raw body for HMAC signature verification
app.use('/webhooks/whatsapp', require('./src/webhooks/whatsapp'));
app.use('/webhooks/razorpay', require('./src/webhooks/razorpay'));
app.use('/webhooks/catalog',  require('./src/webhooks/catalog'));
app.use('/webhooks/delivery',  require('./src/webhooks/delivery'));
app.use('/webhooks/directory', require('./src/webhooks/directory'));
app.use('/webhooks/checkout',  require('./src/webhooks/checkout'));

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

    const { scheduleWebhookRetry } = require('./src/jobs/webhook-retry');
    scheduleWebhookRetry();

    const { scheduleCampaignSender } = require('./src/jobs/campaign-sender');
    scheduleCampaignSender();
  });
}

// Vercel needs this export
module.exports = app;