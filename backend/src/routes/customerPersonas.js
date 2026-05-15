// src/routes/customerPersonas.js
// Admin surface for the customer_personas collection. Mounted at
// /api/admin/personas in ec2-server.js BEFORE the generic admin router
// so its paths win. All routes go through requireRole() from
// routes/auth.js, which itself spreads in requireAdminAuth() — do NOT
// add requireAdminAuth manually.
//
// Persona writes never happen inside read endpoints; they always go via
// services/personaComputer.upsertPersona so the compute logic stays in
// one place.

'use strict';

const express = require('express');
const router = express.Router();
const { col, getDb } = require('../config/database');
const { requireRole } = require('./auth');
const { upsertPersona } = require('../services/personaComputer');
const log = require('../utils/logger').child({ component: 'customer-personas' });

router.use(express.json());

// Mask a phone for the admin UI without exposing the full number.
// Spec format: 'XXXXXX' + last 4 digits. Inputs that can't be reduced to
// at least 4 trailing digits get a flat 'Hidden' — no partial leak.
function maskPhoneForAdmin(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D+/g, '');
  if (digits.length < 4) return 'Hidden';
  return 'XXXXXX' + digits.slice(-4);
}

function basicCustomer(customer) {
  if (!customer) return null;
  return {
    id: String(customer._id),
    name: customer.name || customer.display_name || null,
    phone: maskPhoneForAdmin(customer.wa_phone || customer.phone),
  };
}

// Pick the top-N cuisines from the cuisine_affinity score map, sorted
// by score desc. Returns [{ cuisine, score }, ...] capped at limit.
function topCuisines(affinity, limit = 3) {
  if (!affinity || typeof affinity !== 'object') return [];
  return Object.entries(affinity)
    .filter(([, score]) => typeof score === 'number')
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([cuisine, score]) => ({ cuisine, score }));
}

// Parse comma-or-array multi-value query params into a string[] of
// trimmed, non-empty tokens. Returns null when the input is empty so
// callers can skip adding the clause entirely.
function parseMulti(value) {
  if (value == null) return null;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const tokens = raw.map((v) => String(v).trim()).filter(Boolean);
  return tokens.length ? tokens : null;
}

// ─── STATIC PATHS FIRST ──────────────────────────────────────
// Express matches in registration order and `:customerId` is greedy —
// /rebuild-batch, /query, /distribution must be declared before the
// param route below or they'd be swallowed.

// POST /rebuild-batch — fire-and-forget rebuild for a city or since-date
// slice. Body: { city_id?, since? (ISO date) }. Responds with the queued
// count immediately; per-customer errors are swallowed in the background
// loop.
router.post('/rebuild-batch', ...requireRole(['super_admin']), async (req, res) => {
  try {
    const { city_id, since } = req.body || {};
    const ids = new Set();

    if (city_id) {
      // City association comes from captain session activity — same
      // definition used by the city-listing analytics endpoints.
      const cityIds = await col('city_captain_sessions').distinct('customer_id', { city_id });
      for (const id of cityIds) if (id) ids.add(id);
    }

    if (since) {
      const sinceDate = new Date(since);
      if (isNaN(sinceDate.getTime())) {
        return res.status(400).json({ error: 'Invalid `since` — expected ISO date' });
      }
      const [signalIds, orderIds] = await Promise.all([
        col('user_signals').distinct('customer_id', { ts: { $gte: sinceDate } }),
        col('orders').distinct('customer_id', { created_at: { $gte: sinceDate } }),
      ]);
      for (const id of signalIds) if (id) ids.add(id);
      for (const id of orderIds) if (id) ids.add(id);
    }

    if (ids.size === 0) {
      return res.json({ queued: 0 });
    }

    const queued = ids.size;
    res.json({ queued });

    // Background fan-out — per-customer errors are logged, never thrown.
    const db = getDb();
    (async () => {
      let ok = 0, failed = 0;
      for (const customerId of ids) {
        try {
          await upsertPersona(db, customerId);
          ok++;
        } catch (err) {
          failed++;
          log.warn({ err, customerId }, 'rebuild-batch per-customer failed');
        }
      }
      log.info({ queued, ok, failed }, 'rebuild-batch complete');
    })().catch((err) => log.error({ err }, 'rebuild-batch crashed'));
  } catch (e) {
    log.error({ err: e }, 'rebuild-batch error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /query — audience preview. Returns the matched count + a 10-row
// sample with cuisine_affinity top 3, NO phone or PII.
router.get('/query', ...requireRole(['super_admin', 'city_ops']), async (req, res) => {
  try {
    const {
      cuisine,
      min_cuisine_score,
      price_sensitivity,
      order_frequency,
      veg_strictness,
      discovery_stage,
      area,
      city_id,
    } = req.query;

    const query = {};

    if (cuisine) {
      const c = String(cuisine);
      // Mongo dotted-key injection guard — a '.' or '$' in the key
      // would let the caller traverse nested fields or invoke an
      // operator. Reject outright.
      if (c.includes('.') || c.includes('$')) {
        return res.status(400).json({ error: 'Invalid cuisine name' });
      }
      const minScore = Number(min_cuisine_score);
      const threshold = Number.isFinite(minScore) ? minScore : 30;
      query[`cuisine_affinity.${c}`] = { $gte: threshold };
    }

    const priceList = parseMulti(price_sensitivity);
    if (priceList) query.price_sensitivity = { $in: priceList };

    const freqList = parseMulti(order_frequency);
    if (freqList) query.order_frequency = { $in: freqList };

    const vegList = parseMulti(veg_strictness);
    if (vegList) query.veg_strictness = { $in: vegList };

    const stageList = parseMulti(discovery_stage);
    if (stageList) query.discovery_stage = { $in: stageList };

    const areaList = parseMulti(area);
    if (areaList) query.area_clusters = { $in: areaList };

    if (city_id) query.primary_city_id = String(city_id);

    const personas = col('customer_personas');
    const [count, sampleRows] = await Promise.all([
      personas.countDocuments(query),
      personas.find(query).limit(10).toArray(),
    ]);

    const sample = sampleRows.map((row) => ({
      customer_id: row.customer_id,
      discovery_stage: row.discovery_stage || null,
      top_cuisines: topCuisines(row.cuisine_affinity, 3),
      last_active_at: row.last_active_at || null,
    }));

    res.json({ count, sample });
  } catch (e) {
    log.error({ err: e }, 'persona query error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /distribution — bucket counts for the four categorical axes,
// optionally scoped to a single city. One $facet pipeline so we hit
// the collection once regardless of city filter.
router.get('/distribution', ...requireRole(['super_admin', 'city_ops']), async (req, res) => {
  try {
    const { city_id } = req.query;
    const match = city_id ? { primary_city_id: String(city_id) } : {};

    const pipeline = [
      { $match: match },
      {
        $facet: {
          discovery_stage: [{ $group: { _id: '$discovery_stage', count: { $sum: 1 } } }],
          price_sensitivity: [{ $group: { _id: '$price_sensitivity', count: { $sum: 1 } } }],
          order_frequency: [{ $group: { _id: '$order_frequency', count: { $sum: 1 } } }],
          veg_strictness: [{ $group: { _id: '$veg_strictness', count: { $sum: 1 } } }],
        },
      },
    ];

    const [facet] = await col('customer_personas').aggregate(pipeline).toArray();

    // Flatten { _id: bucket, count } rows into { bucket: count } maps.
    // Null/missing bucket values get key '__null' so they're still
    // visible to the dashboard rather than silently merged.
    const flatten = (rows) => {
      const out = {};
      for (const row of rows || []) {
        const key = row._id == null ? '__null' : String(row._id);
        out[key] = row.count;
      }
      return out;
    };

    res.json({
      discovery_stage: flatten(facet?.discovery_stage),
      price_sensitivity: flatten(facet?.price_sensitivity),
      order_frequency: flatten(facet?.order_frequency),
      veg_strictness: flatten(facet?.veg_strictness),
    });
  } catch (e) {
    log.error({ err: e }, 'persona distribution error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PARAM PATHS LAST ────────────────────────────────────────

// POST /:customerId/rebuild — synchronous recompute for a single
// customer. Returns the upserted persona.
router.post('/:customerId/rebuild', ...requireRole(['super_admin']), async (req, res) => {
  try {
    const { customerId } = req.params;
    const db = getDb();
    const persona = await upsertPersona(db, customerId);
    res.json({ persona: persona || null });
  } catch (e) {
    log.error({ err: e, customerId: req.params.customerId }, 'persona single rebuild error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:customerId — load a single customer's persona alongside basic
// (masked) customer info. Returns persona:null if no persona doc exists
// yet but the customer record does.
router.get('/:customerId', ...requireRole(['super_admin', 'city_ops']), async (req, res) => {
  try {
    const { customerId } = req.params;
    const [persona, customer] = await Promise.all([
      col('customer_personas').findOne({ customer_id: customerId }),
      col('customers').findOne({ _id: customerId }),
    ]);

    if (!persona && !customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    res.json({
      customer: basicCustomer(customer),
      persona: persona || null,
    });
  } catch (e) {
    log.error({ err: e, customerId: req.params.customerId }, 'persona fetch error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
