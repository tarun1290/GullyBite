'use strict';

// Per-restaurant auto-journey CRUD + 30-day stats. Mounted at
//   /api/restaurant/auto-journeys
// Restaurant JWT-scoped via requireAuth. Writes merge-update only the
// journey keys present in the payload so partial updates stay safe.

const express = require('express');
const { col, newId } = require('../config/database');
const { requireAuth } = require('./auth');
const { DEFAULT_JOURNEY_CONFIG, JOURNEY_TYPES, defaultConfig, getConfig } = require('../services/journeyExecutor');

const router = express.Router();
router.use(requireAuth);

function projectConfig(doc) {
  if (!doc) return null;
  const out = {
    restaurant_id: doc.restaurant_id,
    welcome:        doc.welcome        || { ...DEFAULT_JOURNEY_CONFIG.welcome },
    winback_short:  doc.winback_short  || { ...DEFAULT_JOURNEY_CONFIG.winback_short },
    reactivation:   doc.reactivation   || { ...DEFAULT_JOURNEY_CONFIG.reactivation },
    birthday:       doc.birthday       || { ...DEFAULT_JOURNEY_CONFIG.birthday },
    loyalty_expiry: doc.loyalty_expiry || { ...DEFAULT_JOURNEY_CONFIG.loyalty_expiry },
    milestone:      doc.milestone      || { ...DEFAULT_JOURNEY_CONFIG.milestone },
    created_at: doc.created_at || null,
    updated_at: doc.updated_at || null,
  };
  return out;
}

// GET /api/restaurant/auto-journeys/config
router.get('/config', async (req, res) => {
  const config = await getConfig(req.restaurantId);
  res.json(projectConfig(config));
});

// Validation helpers for PUT /config
function isPosInt(x) {
  return Number.isInteger(x) && x > 0;
}

async function validateTemplateId(templateId, expectedUseCase) {
  if (!templateId) return { ok: true };
  const tpl = await col('campaign_templates').findOne({
    template_id: String(templateId),
    is_active: true,
    meta_approval_status: 'approved',
  });
  if (!tpl) return { ok: false, reason: 'template_not_found_or_not_approved' };
  // If a use_case is asserted, prefer matches — but don't hard-block,
  // since admins sometimes create cross-purpose templates.
  return { ok: true, mismatch: expectedUseCase && tpl.use_case !== expectedUseCase };
}

// PUT /api/restaurant/auto-journeys/config
router.put('/config', async (req, res) => {
  const body = req.body || {};
  const $set = { updated_at: new Date() };

  for (const key of JOURNEY_TYPES) {
    if (!(key in body)) continue;
    const incoming = body[key];
    if (incoming == null || typeof incoming !== 'object') {
      return res.status(400).json({ error: `${key} must be an object` });
    }
    const entry = { ...incoming };

    if ('enabled' in entry && typeof entry.enabled !== 'boolean') {
      return res.status(400).json({ error: `${key}.enabled must be a boolean` });
    }

    if (key === 'winback_short' || key === 'reactivation') {
      if ('trigger_day' in entry) {
        const n = Number(entry.trigger_day);
        if (!isPosInt(n)) return res.status(400).json({ error: `${key}.trigger_day must be a positive integer` });
        entry.trigger_day = n;
      }
    }

    if (key === 'birthday') {
      if ('send_hour_ist' in entry) {
        const n = Number(entry.send_hour_ist);
        if (!Number.isInteger(n) || n < 0 || n > 23) {
          return res.status(400).json({ error: 'birthday.send_hour_ist must be 0–23' });
        }
        entry.send_hour_ist = n;
      }
    }

    if (key === 'loyalty_expiry') {
      if ('days_before_expiry' in entry) {
        const n = Number(entry.days_before_expiry);
        if (!isPosInt(n)) return res.status(400).json({ error: 'loyalty_expiry.days_before_expiry must be a positive integer' });
        entry.days_before_expiry = n;
      }
    }

    if (key === 'milestone') {
      if ('trigger_orders' in entry) {
        if (!Array.isArray(entry.trigger_orders) || !entry.trigger_orders.every((x) => isPosInt(Number(x)))) {
          return res.status(400).json({ error: 'milestone.trigger_orders must be an array of positive integers' });
        }
        entry.trigger_orders = entry.trigger_orders.map((x) => Number(x));
      }
    }

    if ('template_id' in entry && entry.template_id) {
      const result = await validateTemplateId(entry.template_id, key);
      if (!result.ok) return res.status(400).json({ error: `${key}.template_id: ${result.reason}` });
    } else if ('template_id' in entry && !entry.template_id) {
      entry.template_id = null;
    }

    if ('custom_variable_values' in entry) {
      if (entry.custom_variable_values == null || typeof entry.custom_variable_values !== 'object' || Array.isArray(entry.custom_variable_values)) {
        return res.status(400).json({ error: `${key}.custom_variable_values must be an object` });
      }
    }

    // Merge over defaults so we persist a full sub-doc (not a partial).
    const existing = await col('auto_journey_config').findOne({ restaurant_id: req.restaurantId });
    const existingEntry = existing?.[key] || DEFAULT_JOURNEY_CONFIG[key];
    $set[key] = { ...DEFAULT_JOURNEY_CONFIG[key], ...existingEntry, ...entry };
  }

  await col('auto_journey_config').updateOne(
    { restaurant_id: req.restaurantId },
    {
      $set,
      $setOnInsert: {
        _id: newId(),
        restaurant_id: req.restaurantId,
        created_at: new Date(),
      },
    },
    { upsert: true },
  );

  const updated = await col('auto_journey_config').findOne({ restaurant_id: req.restaurantId });
  res.json(projectConfig(updated));
});

// GET /api/restaurant/auto-journeys/stats
// Per-journey stats for the last 30 days. Reads marketing_campaigns
// rows whose display_name ends with '— auto' (journey-sent). Per-journey
// grouping is by use_case which matches the journey type 1:1.
router.get('/stats', async (req, res) => {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await col('marketing_campaigns').find(
    {
      restaurant_id: req.restaurantId,
      display_name: { $regex: '\u2014 auto$' },
      created_at: { $gte: since },
    },
    { projection: { use_case: 1, stats: 1, actual_cost_rs: 1, journey_type: 1 } },
  ).toArray();

  const buckets = {};
  for (const t of JOURNEY_TYPES) {
    buckets[t] = { total_sent: 0, total_converted: 0, conversion_rate: 0, total_cost_rs: 0 };
  }

  for (const r of rows) {
    const key = r.journey_type || r.use_case;
    if (!buckets[key]) continue;
    const s = r.stats || {};
    buckets[key].total_sent       += s.sent || 0;
    buckets[key].total_converted  += s.converted || 0;
    buckets[key].total_cost_rs    += Number(r.actual_cost_rs) || 0;
  }
  for (const k of JOURNEY_TYPES) {
    const b = buckets[k];
    b.conversion_rate = b.total_sent > 0
      ? Number((b.total_converted * 100 / b.total_sent).toFixed(2))
      : 0;
    b.total_cost_rs = Number(b.total_cost_rs.toFixed(2));
  }

  res.json({ window_days: 30, by_journey: buckets });
});

module.exports = router;
