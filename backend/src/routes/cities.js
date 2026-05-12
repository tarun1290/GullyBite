// src/routes/cities.js
// City CRUD for the admin surface. Mounted at /api/admin/cities in
// ec2-server.js (ahead of the legacy /api/admin catch-all so /cities
// resolves here). Role gating uses requireRole() from routes/auth.js,
// which spreads in requireAdminAuth() — do NOT add it manually.

'use strict';

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { col, connect, newId, mapId, mapIds } = require('../config/database');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { requireRole } = require('./auth');
const { logAdminAction } = require('../utils/adminAudit');
const metaConfig = require('../config/meta');
const log = require('../utils/logger').child({ component: 'cities' });

// Lowercase, replace any non-alphanumeric run with '-', trim leading/
// trailing '-'. Kept inline (no shared helper module) per route-layer
// convention.
function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Per-route city access gate keyed off `:slug` (not `:cityId`), so we
// can't reuse requireCityAccess() from auth.js. super_admin bypasses;
// city_ops must have the resolved city._id in their `cities` array.
// Stashes the loaded city on req._cityResolved so the handler can
// reuse it without a second findOne.
const requireCityAccessBySlug = async (req, res, next) => {
  try {
    if (req.adminUser?.role === 'super_admin') return next();
    const city = await col('cities').findOne({ slug: req.params.slug });
    if (!city) return res.status(404).json({ error: 'City not found' });
    const allowed = (req.adminUser?.cities || []).map(String);
    if (!allowed.includes(String(city._id))) {
      return res.status(403).json({ error: 'Forbidden: city not assigned' });
    }
    req._cityResolved = city;
    next();
  } catch (err) {
    log.error({ err }, 'requireCityAccessBySlug failed');
    res.status(500).json({ error: 'Internal server error' });
  }
};

// GET /api/admin/cities/meta-phone-numbers — list WABA phones from Meta
// and annotate each with the city (if any) currently bound to its id.
router.get('/meta-phone-numbers', ...requireRole(['super_admin']), async (req, res) => {
  let phones;
  try {
    const resp = await axios.get(
      `https://graph.facebook.com/${metaConfig.apiVersion}/${process.env.WABA_ID}/phone_numbers`,
      {
        params: {
          fields: 'id,display_phone_number,verified_name,quality_rating',
          access_token: process.env.META_SYSTEM_USER_TOKEN,
        },
      },
    );
    phones = resp.data?.data || [];
  } catch (err) {
    log.error({ err }, 'Meta phone_numbers fetch failed');
    return res.status(502).json({
      error: err.response?.data?.error?.message || err.message,
    });
  }

  try {
    const cities = await col('cities')
      .find({}, { projection: { phone_number_id: 1, name: 1 } })
      .toArray();
    const map = new Map();
    for (const c of cities) {
      if (c.phone_number_id) map.set(String(c.phone_number_id), c.name);
    }
    const augmented = phones.map((phone) => ({
      ...phone,
      assigned_to_city: map.get(String(phone.id)) ?? null,
    }));
    res.json(augmented);
  } catch (err) {
    log.error({ err }, 'GET /meta-phone-numbers DB join failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/cities — list cities the caller can see, each with
// a listing_count from city_listings.
router.get('/', ...requireRole(['super_admin', 'city_ops']), async (req, res) => {
  try {
    const filter = req.adminUser?.role === 'super_admin'
      ? {}
      : { _id: { $in: req.adminUser?.cities || [] } };

    const cities = await col('cities').find(filter).toArray();

    const withCounts = await Promise.all(
      cities.map(async (city) => {
        const listing_count = await col('city_listings').countDocuments({ city_id: city._id });
        return { ...city, listing_count };
      }),
    );

    res.json(mapIds(withCounts));
  } catch (err) {
    log.error({ err }, 'GET /api/admin/cities failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/cities — create a city. Slug + phone_number_id must
// be unique. Status starts at 'setup'.
router.post('/', ...requireRole(['super_admin']), async (req, res) => {
  try {
    const { name, slug, phone_number_id, waba_id, display_name, areas } = req.body || {};
    if (!name || !phone_number_id) {
      return res.status(400).json({ error: 'name and phone_number_id are required' });
    }

    const finalSlug = slug || slugify(name);

    const phoneClash = await col('cities').findOne({ phone_number_id });
    if (phoneClash) {
      return res.status(409).json({ error: 'phone_number_id already in use by another city' });
    }

    const slugClash = await col('cities').findOne({ slug: finalSlug });
    if (slugClash) {
      return res.status(409).json({ error: 'slug already in use' });
    }

    const doc = {
      _id: newId(),
      name,
      slug: finalSlug,
      phone_number_id,
      waba_id: waba_id || null,
      display_name: display_name || name,
      areas: Array.isArray(areas) ? areas : [],
      status: 'setup',
      editorial_config: {
        hero_banner_url: null,
        featured_listings: [],
        curated_lists: [],
      },
      created_at: new Date(),
      updated_at: new Date(),
    };

    await col('cities').insertOne(doc);

    const db = await connect();
    logAdminAction(
      db,
      req.adminUser?._id,
      'city_created',
      'city',
      doc._id,
      doc._id,
      null,
      doc,
      req.ip,
    );

    res.json(mapId(doc));
  } catch (err) {
    log.error({ err }, 'POST /api/admin/cities failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/cities/:slug — fetch a single city by slug. city_ops
// must have access to it; super_admin always passes.
router.get(
  '/:slug',
  ...requireRole(['super_admin', 'city_ops']),
  requireCityAccessBySlug,
  async (req, res) => {
    try {
      // requireCityAccessBySlug only loads the city for non-super_admin.
      // For super_admin we still need to fetch by slug.
      const city = req._cityResolved
        || (await col('cities').findOne({ slug: req.params.slug }));
      if (!city) return res.status(404).json({ error: 'City not found' });
      res.json(mapId(city));
    } catch (err) {
      log.error({ err }, 'GET /api/admin/cities/:slug failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// PATCH /api/admin/cities/:slug — update whitelisted fields only.
// _id and slug are never settable here; phone_number_id collisions
// against other cities return 409.
const PATCH_ALLOWED = new Set([
  'name',
  'display_name',
  'status',
  'areas',
  'phone_number_id',
  'waba_id',
  'editorial_config',
]);

router.patch('/:slug', ...requireRole(['super_admin']), async (req, res) => {
  try {
    const existing = await col('cities').findOne({ slug: req.params.slug });
    if (!existing) return res.status(404).json({ error: 'City not found' });

    const $set = {};
    for (const [key, value] of Object.entries(req.body || {})) {
      if (PATCH_ALLOWED.has(key)) $set[key] = value;
    }

    if ($set.phone_number_id && $set.phone_number_id !== existing.phone_number_id) {
      const clash = await col('cities').findOne({
        phone_number_id: $set.phone_number_id,
        _id: { $ne: existing._id },
      });
      if (clash) {
        return res.status(409).json({ error: 'phone_number_id already in use by another city' });
      }
    }

    $set.updated_at = new Date();

    await col('cities').updateOne({ _id: existing._id }, { $set });
    const after = await col('cities').findOne({ _id: existing._id });

    const db = await connect();
    logAdminAction(
      db,
      req.adminUser?._id,
      'city_updated',
      'city',
      existing._id,
      existing._id,
      existing,
      after,
      req.ip,
    );

    res.json(mapId(after));
  } catch (err) {
    log.error({ err }, 'PATCH /api/admin/cities/:slug failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/cities/:slug/refresh-waba-status — fetch a fresh
// projection of the city's Meta phone number (display name, verified
// name, quality rating, status) and persist it under `meta` with a
// `refreshed_at` timestamp. On Meta API failure we return 502 and
// leave the city doc untouched.
router.post('/:slug/refresh-waba-status', ...requireRole(['super_admin']), async (req, res) => {
  try {
    const city = await col('cities').findOne({ slug: req.params.slug });
    if (!city) return res.status(404).json({ error: 'City not found' });
    if (!city.phone_number_id) {
      return res.status(400).json({ error: 'City has no phone_number_id assigned' });
    }
    let meta;
    try {
      const resp = await axios.get(
        `https://graph.facebook.com/${metaConfig.apiVersion}/${city.phone_number_id}`,
        {
          params: {
            fields: 'display_phone_number,verified_name,quality_rating,status',
            access_token: process.env.META_SYSTEM_USER_TOKEN,
          },
        },
      );
      meta = resp.data || {};
    } catch (err) {
      log.error({ err: err.message, slug: req.params.slug }, 'Meta refresh-waba-status fetch failed');
      return res.status(502).json({
        error: err.response?.data?.error?.message || err.message || 'Meta API error',
      });
    }
    const refreshed = {
      display_phone_number: meta.display_phone_number || null,
      verified_name: meta.verified_name || null,
      quality_rating: meta.quality_rating || null,
      status: meta.status || null,
      refreshed_at: new Date(),
    };
    await col('cities').updateOne(
      { _id: city._id },
      { $set: { meta: refreshed, updated_at: new Date() } },
    );
    return res.json(refreshed);
  } catch (err) {
    log.error({ err }, 'POST /:slug/refresh-waba-status failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/admin/cities/:slug — soft delete via status flag, never
// a hard delete (matches the adminUsers convention).
router.delete('/:slug', ...requireRole(['super_admin']), async (req, res) => {
  try {
    const existing = await col('cities').findOne({ slug: req.params.slug });
    if (!existing) return res.status(404).json({ error: 'City not found' });

    await col('cities').updateOne(
      { _id: existing._id },
      { $set: { status: 'deleted', deleted_at: new Date(), updated_at: new Date() } },
    );

    const db = await connect();
    logAdminAction(
      db,
      req.adminUser?._id,
      'city_deleted',
      'city',
      existing._id,
      existing._id,
      existing,
      null,
      req.ip,
    );

    res.json({ success: true });
  } catch (err) {
    log.error({ err }, 'DELETE /api/admin/cities/:slug failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
