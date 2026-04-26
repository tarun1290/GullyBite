// src/routes/adminPincodes.js
// Admin REST API for the platform-wide pincode serviceability map.
// Mounted at /api/admin/pincodes (see backend/server.js).
//
// All routes require a valid admin JWT with `pincodes` read/write perms
// via requireAdminAuth (see middleware/adminAuth.js).

'use strict';

const express = require('express');
const router = express.Router();
const { col } = require('../config/database');
const { requireAdminAuth } = require('../middleware/adminAuth');
const ServiceablePincode = require('../models/ServiceablePincode');
const log = require('../utils/logger').child({ component: 'adminPincodes' });

const COLLECTION = ServiceablePincode.COLLECTION;

function buildFilter({ search, status, city, state }) {
  const q = {};
  if (search) {
    // Match search across pincode, city, state, and area. Case-insensitive
    // so partial typing surfaces results regardless of how the city/area
    // text was originally cased on insert. Special chars escaped so user
    // input can't break out of the regex.
    const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = { $regex: safe, $options: 'i' };
    q.$or = [
      { pincode: regex },
      { city: regex },
      { state: regex },
      { area: regex },
    ];
  }
  if (status === 'enabled') q.enabled = true;
  else if (status === 'disabled') q.enabled = false;
  if (city) q.city = String(city);
  if (state) q.state = String(state);
  return q;
}

// GET /api/admin/pincodes/stats
// IMPORTANT: declared BEFORE /:pincode/toggle so the /stats segment
// never collides with a pincode param.
router.get('/stats', requireAdminAuth('pincodes', 'read'), async (req, res) => {
  try {
    const [total, enabled] = await Promise.all([
      col(COLLECTION).countDocuments({}),
      col(COLLECTION).countDocuments({ enabled: true }),
    ]);
    res.json({ total, enabled, disabled: total - enabled });
  } catch (err) {
    log.error({ err }, 'stats failed');
    res.status(500).json({ error: 'Failed to load pincode stats' });
  }
});

// GET /api/admin/pincodes/cities
// Aggregated summary grouped by (state, city). Sorted by total desc.
// Declared BEFORE /:pincode/toggle so `cities` is never parsed as a PIN.
router.get('/cities', requireAdminAuth('pincodes', 'read'), async (req, res) => {
  try {
    const rows = await col(COLLECTION).aggregate([
      {
        $group: {
          _id: { state: '$state', city: '$city' },
          total: { $sum: 1 },
          enabled: { $sum: { $cond: [{ $eq: ['$enabled', true] }, 1, 0] } },
        },
      },
      {
        $project: {
          _id: 0,
          state: { $ifNull: ['$_id.state', 'Other'] },
          city: { $ifNull: ['$_id.city', 'Other'] },
          total: 1,
          enabled: 1,
          disabled: { $subtract: ['$total', '$enabled'] },
        },
      },
      { $sort: { total: -1, state: 1, city: 1 } },
    ]).toArray();
    res.json(rows);
  } catch (err) {
    log.error({ err }, 'cities failed');
    res.status(500).json({ error: 'Failed to load city groups' });
  }
});

// GET /api/admin/pincodes
router.get('/', requireAdminAuth('pincodes', 'read'), async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const skip = (page - 1) * limit;
    const q = buildFilter({
      search: req.query.search,
      status: req.query.status,
      city: req.query.city,
      state: req.query.state,
    });

    const [rows, total] = await Promise.all([
      col(COLLECTION).find(q).sort({ pincode: 1 }).skip(skip).limit(limit).toArray(),
      col(COLLECTION).countDocuments(q),
    ]);

    res.json({
      pincodes: rows.map((r) => ({
        pincode: r.pincode,
        enabled: !!r.enabled,
        notes: r.notes || null,
        city: r.city || null,
        state: r.state || null,
        area: r.area || null,
        updated_at: r.updated_at,
      })),
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    log.error({ err }, 'list failed');
    res.status(500).json({ error: 'Failed to load pincodes' });
  }
});

// PUT /api/admin/pincodes/bulk
// Body: { enabled: boolean, pincodes?: string[], filter?: { search?, status? } }
// Either `pincodes` (explicit list) OR `filter` (server-side filter) must
// be provided. Returns { updated }.
router.put('/bulk', requireAdminAuth('pincodes', 'write'), async (req, res) => {
  try {
    const { enabled, pincodes, filter } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: '`enabled` (boolean) is required' });
    }

    let result;
    if (Array.isArray(pincodes) && pincodes.length) {
      result = await ServiceablePincode.setEnabledBulk(pincodes, enabled);
    } else if (filter && typeof filter === 'object') {
      const q = buildFilter({ search: filter.search, status: filter.status });
      const r = await col(COLLECTION).updateMany(q, {
        $set: { enabled: !!enabled, updated_at: new Date() },
      });
      result = { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
    } else {
      return res.status(400).json({ error: 'Provide `pincodes` array or `filter` object' });
    }

    res.json({ updated: result.modifiedCount, matched: result.matchedCount });
  } catch (err) {
    log.error({ err }, 'bulk failed');
    res.status(500).json({ error: 'Bulk update failed' });
  }
});

// PATCH /api/admin/pincodes/bulk-toggle
// Body: { filter: { state: string, city?: string }, active: boolean }
// State-scoped (and optionally city-scoped) bulk enable/disable. The route
// accepts `active` per public API contract but writes to the schema's
// `enabled` field. Returns { modifiedCount, matchedCount, affectedRestaurants }.
//
// `affectedRestaurants` is informational — for disable actions it tells
// the admin how many tenants have at least one branch in the just-disabled
// area so they can follow up. We do NOT auto-pause those tenants.
router.patch('/bulk-toggle', requireAdminAuth('pincodes', 'write'), async (req, res) => {
  try {
    const { filter, active } = req.body || {};
    if (!filter || typeof filter !== 'object' || !filter.state || typeof active !== 'boolean') {
      return res.status(400).json({ error: '`filter.state` (string) and `active` (boolean) are required' });
    }
    const q = { state: String(filter.state) };
    if (filter.city) q.city = String(filter.city);

    // Snapshot the actual pincodes about to be toggled BEFORE the update
    // — needed for the affected-restaurants count below. Cheap because
    // these queries are state/city-indexed and the result set is bounded.
    const affectedPincodes = await col(COLLECTION)
      .find(q, { projection: { pincode: 1, _id: 0 } })
      .toArray();
    const pincodeList = affectedPincodes.map((d) => d.pincode).filter(Boolean);

    const r = await col(COLLECTION).updateMany(q, {
      $set: { enabled: !!active, updated_at: new Date() },
    });

    let affectedRestaurants = 0;
    if (!active && pincodeList.length) {
      const distinct = await col('branches').distinct('restaurant_id', {
        pincode: { $in: pincodeList },
      });
      affectedRestaurants = distinct.length;
    }

    res.json({
      modifiedCount: r.modifiedCount,
      matchedCount: r.matchedCount,
      affectedRestaurants,
    });
  } catch (err) {
    log.error({ err }, 'bulk-toggle failed');
    res.status(500).json({ error: 'Bulk toggle failed' });
  }
});

// PUT /api/admin/pincodes/bulk-by-city
// Body: { city, state, enabled }
// Flips `enabled` on every PIN in that city+state bucket.
router.put('/bulk-by-city', requireAdminAuth('pincodes', 'write'), async (req, res) => {
  try {
    const { city, state, enabled } = req.body || {};
    if (!city || !state || typeof enabled !== 'boolean') {
      return res.status(400).json({ error: '`city`, `state`, and `enabled` are required' });
    }
    const r = await col(COLLECTION).updateMany(
      { city: String(city), state: String(state) },
      { $set: { enabled: !!enabled, updated_at: new Date() } }
    );
    res.json({ updated: r.modifiedCount, matched: r.matchedCount });
  } catch (err) {
    log.error({ err }, 'bulk-by-city failed');
    res.status(500).json({ error: 'City bulk update failed' });
  }
});

// POST /api/admin/pincodes/import
// Body: { pincodes: string[], notes? }
// Uses $setOnInsert — never overrides manually-toggled `enabled` values.
router.post('/import', requireAdminAuth('pincodes', 'write'), async (req, res) => {
  try {
    const { pincodes, notes } = req.body || {};
    if (!Array.isArray(pincodes)) {
      return res.status(400).json({ error: '`pincodes` array is required' });
    }
    let inserted = 0;
    let skipped = 0;
    for (const raw of pincodes) {
      const r = await ServiceablePincode.upsertIdempotent(raw, notes || null);
      if (r.inserted) inserted += 1;
      else skipped += 1;
    }
    res.json({ inserted, skipped, total: pincodes.length });
  } catch (err) {
    log.error({ err }, 'import failed');
    res.status(500).json({ error: 'Import failed' });
  }
});

// PUT /api/admin/pincodes/:pincode/toggle
// Flips the `enabled` bit on a single row. Returns the updated doc.
router.put('/:pincode/toggle', requireAdminAuth('pincodes', 'write'), async (req, res) => {
  try {
    const pc = String(req.params.pincode || '').trim();
    if (!/^[1-9][0-9]{5}$/.test(pc)) {
      return res.status(400).json({ error: 'Invalid pincode — must be a 6-digit Indian PIN' });
    }
    const updated = await ServiceablePincode.toggle(pc);
    if (!updated) return res.status(404).json({ error: 'Pincode not found' });
    res.json({
      pincode: updated.pincode,
      enabled: !!updated.enabled,
      notes: updated.notes || null,
      updated_at: updated.updated_at,
    });
  } catch (err) {
    log.error({ err, pincode: req.params.pincode }, 'toggle failed');
    res.status(500).json({ error: 'Toggle failed' });
  }
});

module.exports = router;
