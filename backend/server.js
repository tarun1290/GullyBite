// server.js
// GullyBite — WhatsApp Restaurant SaaS
// Main entry point — starts the Express server with all routes

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── SECURITY MIDDLEWARE ──────────────────────────────────────
// helmet adds important HTTP security headers automatically
app.use(helmet({ contentSecurityPolicy: false }));

// CORS: which origins can call our API
// In production, replace '*' with your actual frontend domain
app.use(cors({ origin: process.env.NODE_ENV === 'production' ? process.env.BASE_URL : '*' }));

// Rate limiting: prevent abuse
// 100 requests per 15 minutes per IP
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

// ─── STATIC FILES ─────────────────────────────────────────────
// Serve the frontend dashboard
app.use(express.static(path.join(__dirname, '../frontend')));

// Placeholder image for menu items without an image
app.get('/placeholder.jpg', (req, res) => {
  res.redirect('https://placehold.co/400x400/1a1a2e/ffffff?text=Food');
});

// ─── ROUTES ───────────────────────────────────────────────────

// Health check endpoint — useful for uptime monitoring
app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.0.0', time: new Date() }));

// Meta OAuth flow
const { router: authRouter } = require('./src/routes/auth');
app.use('/auth', express.json(), authRouter);

// Restaurant dashboard REST API
app.use('/api/restaurant', express.json(), require('./src/routes/restaurant'));

// Admin endpoints
app.use('/api/admin', express.json(), require('./src/routes/admin'));

// WhatsApp webhook — receives all customer messages
// Uses raw body parser (required for HMAC signature verification)
app.use('/webhooks/whatsapp', require('./src/webhooks/whatsapp'));

// Razorpay payment webhook
app.use('/webhooks/razorpay', require('./src/webhooks/razorpay'));

// 3PL Delivery webhook (future)
// app.use('/webhooks/delivery', require('./src/webhooks/delivery'));

// Payment success/failure redirect page
app.get('/payment-success', (req, res) => {
  const { razorpay_payment_link_status: status, razorpay_payment_link_id: linkId } = req.query;
  const success = status === 'paid';
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${success ? 'Payment Successful' : 'Payment Failed'}</title>
    <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem}.card{background:#1e293b;border-radius:1rem;padding:2.5rem;text-align:center;max-width:400px;width:100%}.icon{font-size:4rem;margin-bottom:1rem}h1{font-size:1.5rem;margin-bottom:.75rem}p{color:#94a3b8;line-height:1.6}small{display:block;margin-top:1.5rem;color:#475569;font-size:.8rem}</style>
    </head><body><div class="card">
    <div class="icon">${success ? '✅' : '❌'}</div>
    <h1>${success ? 'Payment Successful!' : 'Payment Failed'}</h1>
    <p>${success ? 'Your order is confirmed! You will receive WhatsApp updates.' : 'Payment could not be completed. Please try again.'}</p>
    <small>You can close this window and return to WhatsApp.</small>
    </div></body></html>`);
});

// Fallback: serve frontend for all other routes (SPA support)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ─── ERROR HANDLER ────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
});

// ─── START SERVER ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   🍔 GullyBIte — WhatsApp Restaurant SaaS ║
╠══════════════════════════════════════════╣
║  Server:    http://localhost:${PORT}         ║
║  WA Hook:   ${process.env.BASE_URL || 'set BASE_URL in .env'}/webhooks/whatsapp
║  Pay Hook:  ${process.env.BASE_URL || ''}/webhooks/razorpay
║  OAuth:     http://localhost:${PORT}/auth/login
╚══════════════════════════════════════════╝
  `);

  // Start the weekly settlement cron job
  const { scheduleSettlement } = require('./src/jobs/settlement');
  scheduleSettlement();
});

module.exports = app;