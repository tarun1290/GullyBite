'use strict';

// GET /api/restaurant/marketing-messages  — scoped to req.restaurantId
// GET /api/admin/marketing-messages       — any restaurant; optional filter
//
// Single router; which handler fires depends on how it's mounted. Each variant
// enforces its own auth + access rules. Shared list/aggregate logic below.

const express = require('express');
const { col } = require('../config/database');
const { requireAuth, requireApproved } = require('./auth');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { maskPhone, formatPhone } = require('../utils/maskPhone');

const restaurantRouter = express.Router();
const adminRouter = express.Router();

// ─── SHARED ─────────────────────────────────────────────────
function parseRange(query) {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from
    ? new Date(query.from)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return { from, to };
}

// Thin alias retained for call-site readability — all masking routes
// through utils/maskPhone.js so there is exactly one implementation.
const maskLast4 = maskPhone;

async function enrichRows(rows, { canSeeFullPhones = false } = {}) {
  const customerIds = [...new Set(rows.map(r => r.customer_id).filter(Boolean))];
  let phoneById = {};
  if (customerIds.length) {
    const customers = await col('customers')
      .find({ _id: { $in: customerIds } })
      .project({ _id: 1, wa_phone: 1, name: 1 })
      .toArray();
    phoneById = Object.fromEntries(
      customers.map(c => [c._id, { phone: c.wa_phone, name: c.name }]),
    );
  }

  // Response shaping happens HERE, not in the caller. Raw phone from
  // customers.wa_phone is looked up above but never emitted — it flows
  // through formatPhone() which collapses to masked unless the caller
  // proved permission via canSeeFullPhones. phone_hash / raw_meta_payload /
  // conversation_id are deliberately dropped — internal fields the UI
  // doesn't need.
  return rows.map(r => {
    const cust = (r.customer_id && phoneById[r.customer_id]) || {};
    const rawPhone = cust.phone || null;
    return {
      _id: r._id,
      restaurant_id: r.restaurant_id,
      waba_id: r.waba_id,
      customer_name: r.customer_name || cust.name || null,
      phone: formatPhone(rawPhone, { canSeeFull: !!canSeeFullPhones }),
      phone_masked: !canSeeFullPhones,
      message_id: r.message_id,
      message_type: r.message_type,
      category: r.category,
      cost: r.cost || 0,
      currency: r.currency || 'INR',
      status: r.status,
      sent_at: r.sent_at,
      delivered_at: r.delivered_at || null,
    };
  });
}

async function queryMarketing({ filter, page = 1, limit = 20 }) {
  const perPage = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const skip = Math.max(Number(page) - 1, 0) * perPage;

  const [rows, total, totals] = await Promise.all([
    col('marketing_messages')
      .find(filter)
      .sort({ sent_at: -1 })
      .skip(skip)
      .limit(perPage)
      .toArray(),
    col('marketing_messages').countDocuments(filter),
    col('marketing_messages').aggregate([
      { $match: filter },
      { $group: { _id: null, total_cost: { $sum: '$cost' }, count: { $sum: 1 } } },
    ]).toArray(),
  ]);

  return {
    rows,
    total,
    totalCost: totals[0]?.total_cost || 0,
    count: totals[0]?.count || 0,
    page: Number(page) || 1,
    limit: perPage,
  };
}

// ─── RESTAURANT ENDPOINT ────────────────────────────────────
// Scoped to the authenticated restaurant. Phone always masked.
restaurantRouter.use(requireAuth);
restaurantRouter.get('/', requireApproved, async (req, res) => {
  try {
    const { from, to } = parseRange(req.query);
    const filter = {
      restaurant_id: req.restaurantId,
      sent_at: { $gte: from, $lte: to },
    };
    if (req.query.category) filter.category = req.query.category;

    const data = await queryMarketing({
      filter,
      page: req.query.page,
      limit: req.query.limit,
    });

    const items = await enrichRows(data.rows, { canSeeFullPhones: false });
    res.json({
      items,
      total: data.total,
      total_cost: data.totalCost,
      page: data.page,
      limit: data.limit,
      from, to,
    });
  } catch (err) {
    req.log?.error({ err }, 'marketing-messages list failed');
    res.status(500).json({ error: 'Failed to load marketing messages' });
  }
});

// ─── ADMIN ENDPOINT ─────────────────────────────────────────
// Any restaurant (optional filter). Phone full only if req.canSeeFullPhones.
adminRouter.get('/', requireAdminAuth('marketing_messages', 'read'), async (req, res) => {
  try {
    const { from, to } = parseRange(req.query);
    const filter = { sent_at: { $gte: from, $lte: to } };
    if (req.query.restaurant_id) filter.restaurant_id = req.query.restaurant_id;
    if (req.query.waba_id) filter.waba_id = req.query.waba_id;
    if (req.query.category) filter.category = req.query.category;

    const data = await queryMarketing({
      filter,
      page: req.query.page,
      limit: req.query.limit,
    });

    const items = await enrichRows(data.rows, {
      canSeeFullPhones: !!req.canSeeFullPhones,
    });
    res.json({
      items,
      total: data.total,
      total_cost: data.totalCost,
      total_revenue: data.totalCost,
      page: data.page,
      limit: data.limit,
      from, to,
    });
  } catch (err) {
    req.log?.error({ err }, 'admin marketing-messages list failed');
    res.status(500).json({ error: 'Failed to load marketing messages' });
  }
});

// Exposed for the settlement meta-breakdown endpoints, which reuse the
// same masking / customer-lookup logic keyed by settlement_id instead
// of a date range.
module.exports = { restaurantRouter, adminRouter, enrichRows, maskLast4 };
