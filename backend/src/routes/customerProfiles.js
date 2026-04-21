// src/routes/customerProfiles.js
// Restaurant-scoped RFM profile reads. Powers the dashboard Customers
// tab — which is gated on the frontend by campaigns_enabled so the
// endpoints stay inert (no writes) even when UI is hidden.

'use strict';

const express = require('express');
const { col } = require('../config/database');
const { requireAuth } = require('./auth');
const { maskPhone } = require('../utils/maskPhone');

const router = express.Router();

const LABELS = [
  'Champion',
  'Loyal',
  'Potential Loyalist',
  'At Risk',
  'Hibernating',
  'Lost',
  'Big Spender',
  'New Customer',
  'Other',
];

router.use(requireAuth);

// GET /api/restaurant/customers/stats — headline tiles for the Customers
// tab. Counts + current-month actives + last rebuild timestamp.
router.get('/stats', async (req, res) => {
  try {
    const rid = req.restaurantId;
    const thirtyDays = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [total, active30, latestRebuild, totalsAgg] = await Promise.all([
      col('customer_rfm_profiles').countDocuments({ restaurant_id: rid }),
      col('customer_rfm_profiles').countDocuments({
        restaurant_id: rid,
        last_order_at: { $gte: thirtyDays },
      }),
      col('customer_rfm_profiles').find({ restaurant_id: rid })
        .sort({ last_rebuild_at: -1 }).limit(1).project({ last_rebuild_at: 1 }).toArray(),
      col('customer_rfm_profiles').aggregate([
        { $match: { restaurant_id: rid } },
        {
          $group: {
            _id: null,
            total_spend_rs: { $sum: '$total_spend_rs' },
            total_orders: { $sum: '$order_count' },
          },
        },
      ]).toArray(),
    ]);

    const totals = totalsAgg[0] || { total_spend_rs: 0, total_orders: 0 };
    res.json({
      total_customers: total,
      active_last_30_days: active30,
      total_spend_rs: Number(totals.total_spend_rs || 0),
      total_orders: Number(totals.total_orders || 0),
      last_rebuild_at: latestRebuild[0]?.last_rebuild_at || null,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// GET /api/restaurant/customers/segments — counts per RFM label.
// Always returns all 9 labels (zero-filled) so the UI grid is stable.
router.get('/segments', async (req, res) => {
  try {
    const rid = req.restaurantId;
    const rows = await col('customer_rfm_profiles').aggregate([
      { $match: { restaurant_id: rid } },
      { $group: { _id: '$rfm_label', count: { $sum: 1 } } },
    ]).toArray();
    const byLabel = rows.reduce((acc, r) => {
      acc[r._id] = r.count;
      return acc;
    }, {});
    const segments = LABELS.map((label) => ({
      label,
      count: byLabel[label] || 0,
    }));
    res.json({ segments });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// GET /api/restaurant/customers/by-segment/:label — listing for a
// single RFM segment. Phone is looked up from the global `customers`
// row and returned masked. Capped at 200 rows; sorted by spend desc.
router.get('/by-segment/:label', async (req, res) => {
  try {
    const rid = req.restaurantId;
    const label = String(req.params.label);
    if (!LABELS.includes(label)) {
      return res.status(400).json({ success: false, message: 'Unknown segment' });
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const rows = await col('customer_rfm_profiles')
      .find({ restaurant_id: rid, rfm_label: label })
      .sort({ total_spend_rs: -1 })
      .limit(limit)
      .toArray();

    const customerIds = rows.map((r) => r.customer_id);
    const customers = customerIds.length
      ? await col('customers')
        .find({ _id: { $in: customerIds } })
        .project({ _id: 1, wa_phone: 1, name: 1 })
        .toArray()
      : [];
    const byId = new Map(customers.map((c) => [String(c._id), c]));

    const items = rows.map((r) => {
      const c = byId.get(String(r.customer_id)) || {};
      return {
        customer_id: r.customer_id,
        name: c.name || null,
        phone_masked: maskPhone(c.wa_phone || ''),
        order_count: r.order_count,
        total_spend_rs: r.total_spend_rs,
        avg_order_value_rs: r.avg_order_value_rs,
        last_order_at: r.last_order_at,
        days_since_last_order: r.days_since_last_order,
        r_score: r.r_score,
        f_score: r.f_score,
        m_score: r.m_score,
        rfm_label: r.rfm_label,
      };
    });
    res.json({ label, items });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
