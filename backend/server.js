// server.js
// Works both locally (npm run dev) AND on Vercel (serverless)

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

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

// ─── HEALTH CHECK ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', time: new Date() });
});

// ─── ROUTES ───────────────────────────────────────────────────
const { router: authRouter } = require('./src/routes/auth');
app.use('/auth', express.json(), authRouter);
app.use('/api/restaurant', express.json(), require('./src/routes/restaurant'));
app.use('/api/admin', express.json(), require('./src/routes/admin'));

// Webhooks need raw body for HMAC signature verification
app.use('/webhooks/whatsapp', require('./src/webhooks/whatsapp'));
app.use('/webhooks/razorpay', require('./src/webhooks/razorpay'));

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