'use strict';

// Per-restaurant loyalty CRUD + lookup + manual credit. Mounted at
//   /api/restaurant/loyalty-program
// All routes JWT-scoped via requireAuth (sets req.restaurantId).
//
// Endpoints:
//   GET  /config              — loyalty_config for this restaurant
//   PUT  /config              — partial update of loyalty_config
//   GET  /stats               — program rollups (members, balance, liability)
//   GET  /customers           — paginated member list with balance
//   GET  /customer/:phone     — balance + transactions summary
//   POST /dine-in-credit      — merchant-initiated manual credit
//
// Inactive program (is_active=false) still exposes config/stats and
// manual credit so merchants can prep ahead of launch, but the
// earn/redeem hot paths (queue/postPaymentJobs.js LOYALTY_AWARD +
// flowHandler.js pre-checkout prompt) are gated inside loyaltyEngine.

const express = require('express');
const { col } = require('../config/database');
const { requireAuth } = require('./auth');
const loyaltyEngine = require('../services/loyaltyEngine');
const { hashPhone } = require('../utils/phoneHash');
// Use the canonical shared mask. The earlier local helper produced
// '****1234' which leaked through restaurant dashboards inconsistently
// alongside the '+91 XXXXX XXXXX' shape the rest of the codebase emits;
// one shared format keeps PII redaction uniform.
const { maskPhone } = require('../utils/maskPhone');

const router = express.Router();
router.use(requireAuth);

function normalisePhone(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s.replace(/\D+/g, '');
}

// GET /config
router.get('/config', async (req, res) => {
  const cfg = await loyaltyEngine.ensureConfig(req.restaurantId);
  res.json(cfg);
});

// PUT /config — merchant-facing knob edits. Whitelisted to the keys
// in DEFAULT_CONFIG so a stray payload can't poison the document.
router.put('/config', async (req, res) => {
  const body = req.body || {};
  const patch = {};
  const numericKeys = [
    'points_per_rupee', 'first_order_multiplier', 'birthday_week_multiplier',
    'referral_bonus_points', 'min_points_to_redeem', 'max_redemption_percent',
    'points_to_rupee_ratio', 'max_redemptions_per_day', 'points_expiry_days',
    'expiry_warning_days',
  ];
  for (const k of numericKeys) {
    if (!(k in body)) continue;
    const n = Number(body[k]);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: `${k} must be a non-negative number` });
    }
    if (k === 'max_redemption_percent' && n > 100) {
      return res.status(400).json({ error: 'max_redemption_percent must be between 0 and 100' });
    }
    patch[k] = n;
  }
  if ('is_active' in body) {
    if (typeof body.is_active !== 'boolean') {
      return res.status(400).json({ error: 'is_active must be a boolean' });
    }
    patch.is_active = body.is_active;
  }
  if ('program_name' in body) {
    const name = String(body.program_name || '').trim();
    if (!name) return res.status(400).json({ error: 'program_name cannot be empty' });
    patch.program_name = name.substring(0, 60);
  }
  const updated = await loyaltyEngine.updateConfig(req.restaurantId, patch);
  res.json(updated);
});

// GET /stats — program-level rollups for the merchant dashboard.
router.get('/stats', async (req, res) => {
  const stats = await loyaltyEngine.getStats(req.restaurantId);
  res.json(stats);
});

// GET /customers — paginated loyalty member list.
router.get('/customers', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
    const skip  = (page - 1) * limit;

    const [docs, total] = await Promise.all([
      col('loyalty_points')
        .find({ restaurant_id: req.restaurantId })
        .sort({ lifetime_points: -1 })
        .skip(skip).limit(limit).toArray(),
      col('loyalty_points').countDocuments({ restaurant_id: req.restaurantId }),
    ]);

    const customerIds = docs.map((d) => d.customer_id).filter(Boolean);
    const customers = customerIds.length
      ? await col('customers').find({ _id: { $in: customerIds } }).toArray()
      : [];
    const custMap = Object.fromEntries(customers.map((c) => [String(c._id), c]));

    const enriched = docs.map((d) => {
      const c = custMap[d.customer_id] || {};
      return {
        id: String(d._id),
        customer_name: c.name || 'Unknown',
        wa_phone: maskPhone(c.wa_phone),
        points_balance: d.points_balance,
        lifetime_points: d.lifetime_points,
        total_orders: c.total_orders || 0,
        total_spent_rs: c.total_spent_rs || 0,
        last_order_at: c.last_order_at,
      };
    });

    res.json({ customers: enriched, total, page, pages: Math.ceil(total / limit) });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// GET /customer/:phone — ledger summary for a single customer.
router.get('/customer/:phone', async (req, res) => {
  const phone = normalisePhone(req.params.phone);
  if (!phone) return res.status(400).json({ error: 'phone required' });

  let customer = null;
  try {
    const ph = hashPhone(phone);
    customer = await col('customers').findOne({ phone_hash: ph });
  } catch (_) { /* fall through */ }
  if (!customer) {
    customer = await col('customers').findOne({ wa_phone: phone });
  }
  if (!customer) return res.status(404).json({ error: 'customer_not_found' });

  const summary = await loyaltyEngine.getLedgerSummary({
    restaurantId: req.restaurantId,
    customerId: customer._id,
  });
  res.json({
    customer: {
      id: customer._id,
      name: customer.name || null,
      wa_phone_masked: maskPhone(phone),
    },
    ...summary,
  });
});

// POST /dine-in-credit — merchant manually credits points for a walk-in
// or phone order where no Razorpay payment was captured.
router.post('/dine-in-credit', async (req, res) => {
  const { phone, points, description } = req.body || {};
  const phoneNorm = normalisePhone(phone);
  const p = Math.floor(Number(points) || 0);
  if (!phoneNorm) return res.status(400).json({ error: 'phone required' });
  if (p <= 0) return res.status(400).json({ error: 'points must be a positive integer' });

  let customer = null;
  try {
    const ph = hashPhone(phoneNorm);
    customer = await col('customers').findOne({ phone_hash: ph });
  } catch (_) { /* fall through */ }
  if (!customer) customer = await col('customers').findOne({ wa_phone: phoneNorm });
  if (!customer) return res.status(404).json({ error: 'customer_not_found' });

  const result = await loyaltyEngine.manualCredit({
    restaurantId: req.restaurantId,
    customerId: customer._id,
    points: p,
    description: description ? String(description).substring(0, 200) : 'Dine-in credit',
    actor: req.userId || req.restaurantId,
  });
  if (!result.ok) return res.status(400).json({ error: result.reason });
  res.json({
    awarded: result.awarded,
    balance: result.balance,
    customer: {
      id: customer._id,
      name: customer.name || null,
      wa_phone_masked: maskPhone(phoneNorm),
    },
  });
});

module.exports = router;
