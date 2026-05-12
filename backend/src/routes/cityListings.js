// src/routes/cityListings.js
// City-listing CRUD for the admin surface. Mounted at /api/admin/cities
// in ec2-server.js AHEAD of routes/cities.js so /:slug/listings/* land
// here. Role gating uses requireRole() from routes/auth.js, which spreads
// in requireAdminAuth() — do NOT add it manually.

'use strict';

const express = require('express');
const router = express.Router();
const { col, connect, newId, mapId, mapIds } = require('../config/database');
const { requireRole } = require('./auth');
const { logAdminAction } = require('../utils/adminAudit');
const { enqueueMenuResearch } = require('../utils/captainQueues');
const redisClient = require('../queue/redis');
const { validateAndSplitTags, promoteCandidateTags } = require('../services/menuTagger');
const log = require('../utils/logger').child({ component: 'cityListings' });

// Lowercase, replace any non-alphanumeric run with '-', trim leading/
// trailing '-'. Kept inline (mirrors cities.js convention).
function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Per-route city access gate keyed off `:slug`. Mirrors the same
// middleware in cities.js — kept inline rather than shared so each
// router stays self-contained. Stashes the loaded city on
// req._cityResolved so handlers can reuse it without a second findOne.
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

// Pick only whitelisted keys from a request body. Caller passes a Set
// for fast lookups.
function validatePatchFields(body, allowedSet) {
  const out = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (allowedSet.has(key)) out[key] = value;
  }
  return out;
}

// Load the canonical tag taxonomy. Prefers the Redis cache key set by
// the research worker; falls back to platform_settings if the cache is
// empty or Redis is unreachable.
async function loadTaxonomy() {
  try {
    const cached = await redisClient.get('captain:taxonomy');
    if (cached) return JSON.parse(cached);
  } catch {
    /* fall through to DB */
  }
  return col('platform_settings').findOne({ _id: 'tag_taxonomy' });
}

// requireCityAccessBySlug only loads the city for non-super_admin. For
// super_admin (or endpoints without the slug-gate) we still need to
// fetch by slug.
async function loadCity(req) {
  if (req._cityResolved) return req._cityResolved;
  return col('cities').findOne({ slug: req.params.slug });
}

// Parse and clamp the days query param across the three analytics
// endpoints. Default 7, hard ceiling 30. Anything non-numeric or out
// of range clamps to default 7 — keep it strict so a bad caller can't
// request 5 years of aggregates.
function clampDays(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 7;
  return Math.min(n, 30);
}

// The action set used by both the leaderboard and the listing-level
// funnel. Captain emits these via logSignal in captainHandler +
// captainReengagement; gbref_order_attributed is written by the
// order.js attribution hook.
const INTEREST_ACTIONS = [
  'listing_card_shown',
  'menu_viewed',
  'tapped_notify_me',
  'tapped_order_handoff',
  'gbref_link_generated',
  'gbref_order_attributed',
];

// Weighted-score branch used inside aggregation pipelines so the score
// is computed in Mongo (one round-trip, no in-process recomputation).
const INTEREST_WEIGHTS = {
  listing_card_shown: 1,
  menu_viewed: 2,
  tapped_notify_me: 3,
  tapped_order_handoff: 5,
  gbref_link_generated: 5,
  gbref_order_attributed: 10,
};

// ─── A1: GET /:slug/analytics — city-level analytics summary ─────────
router.get(
  '/:slug/analytics',
  ...requireRole(['super_admin', 'city_ops']),
  requireCityAccessBySlug,
  async (req, res) => {
    try {
      const slug = req.params.slug;
      const days = clampDays(req.query.days);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const city = req._cityResolved || await col('cities').findOne({ slug });
      if (!city) return res.status(404).json({ error: 'City not found' });

      const [listingFacets, signalRows, sessionCounts] = await Promise.all([
        col('city_listings').aggregate([
          { $match: { city_id: city._id } },
          {
            $facet: {
              by_research_status: [{ $group: { _id: '$research_status', count: { $sum: 1 } } }],
              by_status:          [{ $group: { _id: '$status', count: { $sum: 1 } } }],
            },
          },
        ]).toArray(),
        col('user_signals').aggregate([
          { $match: { city_id: city._id, action: { $in: INTEREST_ACTIONS }, ts: { $gte: since } } },
          { $group: { _id: '$action', count: { $sum: 1 } } },
        ]).toArray(),
        Promise.all([
          col('city_captain_sessions').countDocuments({ city_id: city._id }),
          col('city_captain_sessions').countDocuments({ city_id: city._id, created_at: { $gte: since } }),
        ]),
      ]);

      // Reshape facet arrays into `{ [key]: count }`, dropping null keys.
      const reshape = (rows) => {
        const out = {};
        for (const r of rows || []) {
          if (r && r._id != null) out[String(r._id)] = r.count;
        }
        return out;
      };
      const facets = listingFacets[0] || { by_research_status: [], by_status: [] };

      // Flat signals object — missing actions get 0.
      const signals = {};
      for (const a of INTEREST_ACTIONS) signals[a] = 0;
      for (const r of signalRows) {
        if (r && r._id) signals[String(r._id)] = r.count;
      }

      const [sessionsTotal, sessionsNewInWindow] = sessionCounts;

      res.json({
        days,
        listings: {
          by_research_status: reshape(facets.by_research_status),
          by_status: reshape(facets.by_status),
        },
        signals,
        sessions: { total: sessionsTotal, new_in_window: sessionsNewInWindow },
      });
    } catch (err) {
      log.error({ err }, 'GET /:slug/analytics failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── A2: GET /:slug/interest-leaderboard — top listings by score ─────
router.get(
  '/:slug/interest-leaderboard',
  ...requireRole(['super_admin', 'city_ops']),
  requireCityAccessBySlug,
  async (req, res) => {
    try {
      const slug = req.params.slug;
      const city = req._cityResolved || await col('cities').findOne({ slug });
      if (!city) return res.status(404).json({ error: 'City not found' });

      const days = clampDays(req.query.days);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const top = await col('user_signals').aggregate([
        { $match: { city_id: city._id, action: { $in: INTEREST_ACTIONS }, ts: { $gte: since } } },
        {
          $group: {
            _id: '$listing_id',
            listing_card_shown:       { $sum: { $cond: [{ $eq: ['$action', 'listing_card_shown'] }, 1, 0] } },
            menu_viewed:              { $sum: { $cond: [{ $eq: ['$action', 'menu_viewed'] }, 1, 0] } },
            tapped_notify_me:         { $sum: { $cond: [{ $eq: ['$action', 'tapped_notify_me'] }, 1, 0] } },
            tapped_order_handoff:     { $sum: { $cond: [{ $eq: ['$action', 'tapped_order_handoff'] }, 1, 0] } },
            gbref_link_generated:     { $sum: { $cond: [{ $eq: ['$action', 'gbref_link_generated'] }, 1, 0] } },
            gbref_order_attributed:   { $sum: { $cond: [{ $eq: ['$action', 'gbref_order_attributed'] }, 1, 0] } },
          },
        },
        {
          $addFields: {
            interest_score: {
              $add: [
                { $multiply: ['$listing_card_shown', INTEREST_WEIGHTS.listing_card_shown] },
                { $multiply: ['$menu_viewed', INTEREST_WEIGHTS.menu_viewed] },
                { $multiply: ['$tapped_notify_me', INTEREST_WEIGHTS.tapped_notify_me] },
                { $multiply: ['$tapped_order_handoff', INTEREST_WEIGHTS.tapped_order_handoff] },
                { $multiply: ['$gbref_link_generated', INTEREST_WEIGHTS.gbref_link_generated] },
                { $multiply: ['$gbref_order_attributed', INTEREST_WEIGHTS.gbref_order_attributed] },
              ],
            },
          },
        },
        { $match: { _id: { $ne: null } } },
        { $sort: { interest_score: -1 } },
        { $limit: 20 },
      ]).toArray();

      const ids = top.map((t) => t._id);

      const [listings, intentCounts] = await Promise.all([
        ids.length
          ? col('city_listings')
            .find({ _id: { $in: ids } }, { projection: { name: 1, area: 1, status: 1 } })
            .toArray()
          : Promise.resolve([]),
        ids.length
          ? col('notify_intents').aggregate([
            { $match: { listing_id: { $in: ids }, $or: [{ fulfilled: { $ne: true } }, { reengaged_at: { $exists: false } }] } },
            { $group: { _id: '$listing_id', count: { $sum: 1 } } },
          ]).toArray()
          : Promise.resolve([]),
      ]);

      const byId = new Map(listings.map((l) => [String(l._id), l]));
      const countById = new Map(intentCounts.map((c) => [String(c._id), c.count]));

      const enriched = top.map((t, i) => {
        const l = byId.get(String(t._id));
        return {
          rank: i + 1,
          listing_id: t._id,
          name: l?.name || '—',
          area: l?.area || null,
          status: l?.status || null,
          listing_card_shown: t.listing_card_shown,
          menu_viewed: t.menu_viewed,
          tapped_notify_me: t.tapped_notify_me,
          tapped_order_handoff: t.tapped_order_handoff,
          gbref_link_generated: t.gbref_link_generated,
          gbref_order_attributed: t.gbref_order_attributed,
          interest_score: t.interest_score,
          unfulfilled_notify_count: countById.get(String(t._id)) || 0,
        };
      });

      res.json({ days, results: enriched });
    } catch (err) {
      log.error({ err }, 'GET /:slug/interest-leaderboard failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── A2b: GET /:slug/interest-leaderboard/export — same aggregation as
// the JSON leaderboard, emitted as RFC-4180 CSV. Adds business_type +
// website_url to the projection so the export captures lead-contact
// fields the dashboard doesn't render inline. Empty results still
// succeed with a header-only file.
router.get(
  '/:slug/interest-leaderboard/export',
  ...requireRole(['super_admin', 'city_ops']),
  requireCityAccessBySlug,
  async (req, res) => {
    try {
      const slug = req.params.slug;
      const city = req._cityResolved || await col('cities').findOne({ slug });
      if (!city) return res.status(404).json({ error: 'City not found' });

      const days = clampDays(req.query.days);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      // SAME aggregation as the JSON leaderboard — copy the pipeline
      // verbatim so the CSV represents the same ranking the dashboard
      // shows. Limit 20 matches the JSON endpoint.
      const top = await col('user_signals').aggregate([
        { $match: { city_id: city._id, action: { $in: INTEREST_ACTIONS }, ts: { $gte: since } } },
        {
          $group: {
            _id: '$listing_id',
            listing_card_shown:     { $sum: { $cond: [{ $eq: ['$action', 'listing_card_shown'] }, 1, 0] } },
            menu_viewed:            { $sum: { $cond: [{ $eq: ['$action', 'menu_viewed'] }, 1, 0] } },
            tapped_notify_me:       { $sum: { $cond: [{ $eq: ['$action', 'tapped_notify_me'] }, 1, 0] } },
            tapped_order_handoff:   { $sum: { $cond: [{ $eq: ['$action', 'tapped_order_handoff'] }, 1, 0] } },
            gbref_link_generated:   { $sum: { $cond: [{ $eq: ['$action', 'gbref_link_generated'] }, 1, 0] } },
            gbref_order_attributed: { $sum: { $cond: [{ $eq: ['$action', 'gbref_order_attributed'] }, 1, 0] } },
          },
        },
        {
          $addFields: {
            interest_score: {
              $add: [
                { $multiply: ['$listing_card_shown', INTEREST_WEIGHTS.listing_card_shown] },
                { $multiply: ['$menu_viewed', INTEREST_WEIGHTS.menu_viewed] },
                { $multiply: ['$tapped_notify_me', INTEREST_WEIGHTS.tapped_notify_me] },
                { $multiply: ['$tapped_order_handoff', INTEREST_WEIGHTS.tapped_order_handoff] },
                { $multiply: ['$gbref_link_generated', INTEREST_WEIGHTS.gbref_link_generated] },
                { $multiply: ['$gbref_order_attributed', INTEREST_WEIGHTS.gbref_order_attributed] },
              ],
            },
          },
        },
        { $match: { _id: { $ne: null } } },
        { $sort: { interest_score: -1 } },
        { $limit: 20 },
      ]).toArray();

      const ids = top.map((t) => t._id);
      const [listings, intentCounts] = await Promise.all([
        ids.length
          ? col('city_listings')
            .find(
              { _id: { $in: ids } },
              { projection: { name: 1, area: 1, status: 1, business_type: 1, website_url: 1 } },
            ).toArray()
          : Promise.resolve([]),
        ids.length
          ? col('notify_intents').aggregate([
            { $match: { listing_id: { $in: ids }, $or: [{ fulfilled: { $ne: true } }, { reengaged_at: { $exists: false } }] } },
            { $group: { _id: '$listing_id', count: { $sum: 1 } } },
          ]).toArray()
          : Promise.resolve([]),
      ]);
      const byId = new Map(listings.map((l) => [String(l._id), l]));
      const countById = new Map(intentCounts.map((c) => [String(c._id), c.count]));

      // Manual CSV builder — escape commas + quotes + newlines per
      // RFC 4180. Wrap any field containing them in double quotes and
      // double-up any embedded quotes. Numbers and bools coerce to
      // string with String(); null/undefined → empty string.
      function csvEscape(v) {
        if (v === null || v === undefined) return '';
        const s = String(v);
        if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
          return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
      }
      function csvRow(fields) { return fields.map(csvEscape).join(','); }

      const headers = [
        'Rank', 'Listing Name', 'Area', 'Business Type', 'Status',
        'Interest Score', 'Impressions', 'Menu Views', 'Notify-Me Taps', 'Order Taps',
        'Customers Waiting', 'Website URL',
      ];
      const lines = [csvRow(headers)];
      top.forEach((t, i) => {
        const l = byId.get(String(t._id));
        lines.push(csvRow([
          i + 1,
          l?.name || '',
          l?.area || '',
          l?.business_type || '',
          l?.status || '',
          t.interest_score,
          t.listing_card_shown,
          t.menu_viewed,
          t.tapped_notify_me,
          t.tapped_order_handoff,
          countById.get(String(t._id)) || 0,
          l?.website_url || '',
        ]));
      });
      const csv = lines.join('\r\n') + '\r\n';

      const today = new Date().toISOString().slice(0, 10);
      const filename = `captain-leads-${slug}-${today}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(csv);
    } catch (err) {
      log.error({ err }, 'GET /:slug/interest-leaderboard/export failed');
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── E1: POST /:slug/listings — create a listing ─────────────────────
router.post('/:slug/listings', ...requireRole(['super_admin']), async (req, res) => {
  try {
    const city = await loadCity(req);
    if (!city || city.status === 'deleted') {
      return res.status(404).json({ error: 'City not found' });
    }

    const {
      name,
      area,
      business_type,
      description,
      website_url,
      phone_number,
      lat,
      lng,
      address,
      delivery_zones,
    } = req.body || {};

    if (!name || !area || !business_type) {
      return res.status(400).json({ error: 'name, area and business_type are required' });
    }
    if (!['physical', 'cloud_kitchen'].includes(business_type)) {
      return res.status(400).json({ error: 'business_type must be physical or cloud_kitchen' });
    }
    if (!Array.isArray(city.areas) || !city.areas.includes(area)) {
      return res.status(400).json({ error: 'area must be one of the city\'s configured areas' });
    }
    if (business_type === 'cloud_kitchen' && (!Array.isArray(delivery_zones) || delivery_zones.length === 0)) {
      return res.status(400).json({ error: 'cloud_kitchen listings require at least one delivery_zone' });
    }

    const listingSlug = `${city.slug}-${slugify(name)}`;
    const clash = await col('city_listings').findOne({ city_id: city._id, slug: listingSlug });
    if (clash) {
      return res.status(409).json({ error: 'A listing with this slug already exists in this city' });
    }

    const doc = {
      _id: newId(),
      city_id: city._id,
      name,
      slug: listingSlug,
      area,
      business_type,
      description: description || null,
      website_url: website_url || null,
      phone_number: phone_number || null,
      lat: typeof lat === 'number' ? lat : null,
      lng: typeof lng === 'number' ? lng : null,
      address: address || null,
      delivery_zones: Array.isArray(delivery_zones) ? delivery_zones : [],
      status: 'draft',
      fulfillment_mode: 'notify_only',
      research_status: 'pending',
      editorial_boost_score: 0,
      sponsored_until: null,
      sponsored_metadata: null,
      tags: null,
      latest_snapshot_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    await col('city_listings').insertOne(doc);

    enqueueMenuResearch(redisClient, doc._id, city._id, 'normal').catch((err) => {
      log.warn({ err: err.message, listingId: doc._id }, 'enqueueMenuResearch failed');
    });

    const db = await connect();
    logAdminAction(
      db,
      req.adminUser?._id,
      'listing_created',
      'listing',
      doc._id,
      city._id,
      null,
      doc,
      req.ip,
    );

    res.json(mapId(doc));
  } catch (err) {
    log.error({ err }, 'POST /:slug/listings failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── E2: GET /:slug/listings — list with filters + pagination ────────
router.get(
  '/:slug/listings',
  ...requireRole(['super_admin', 'city_ops']),
  requireCityAccessBySlug,
  async (req, res) => {
    try {
      const city = await loadCity(req);
      if (!city) return res.status(404).json({ error: 'City not found' });

      const filter = { city_id: city._id };
      const { status, fulfillment_mode, business_type, research_status, area } = req.query;
      if (status) filter.status = status;
      if (fulfillment_mode) filter.fulfillment_mode = fulfillment_mode;
      if (business_type) filter.business_type = business_type;
      if (research_status) filter.research_status = research_status;
      if (area) filter.area = area;

      const page = parseInt(req.query.page, 10) || 1;
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const skip = (page - 1) * limit;

      const [total, items] = await Promise.all([
        col('city_listings').countDocuments(filter),
        col('city_listings')
          .find(filter)
          .sort({ created_at: -1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
      ]);

      res.json({ total, page, limit, results: mapIds(items) });
    } catch (err) {
      log.error({ err }, 'GET /:slug/listings failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── E3: GET /:slug/listings/:listingId — fetch one + snapshot summary
router.get(
  '/:slug/listings/:listingId',
  ...requireRole(['super_admin', 'city_ops']),
  requireCityAccessBySlug,
  async (req, res) => {
    try {
      const city = await loadCity(req);
      if (!city) return res.status(404).json({ error: 'City not found' });

      const listing = await col('city_listings').findOne({ _id: req.params.listingId });
      if (!listing || String(listing.city_id) !== String(city._id)) {
        return res.status(404).json({ error: 'Listing not found' });
      }

      const latest = listing.latest_snapshot_id
        ? await col('menu_snapshots').findOne({ _id: listing.latest_snapshot_id })
        : null;

      const snapshotSummary = latest
        ? {
          _id: latest._id,
          status: latest.status,
          source: latest.source,
          is_live: latest.is_live,
          created_at: latest.created_at,
          item_count: Array.isArray(latest.extracted_items) ? latest.extracted_items.length : 0,
        }
        : null;

      res.json({ ...mapId(listing), latest_snapshot: snapshotSummary });
    } catch (err) {
      log.error({ err }, 'GET /:slug/listings/:listingId failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── A3: GET /:slug/listings/:listingId/analytics — per-listing analytics
router.get(
  '/:slug/listings/:listingId/analytics',
  ...requireRole(['super_admin', 'city_ops']),
  requireCityAccessBySlug,
  async (req, res) => {
    try {
      const city = await loadCity(req);
      if (!city) return res.status(404).json({ error: 'City not found' });

      const listingId = req.params.listingId;
      const listing = await col('city_listings').findOne({ _id: listingId });
      if (!listing || String(listing.city_id) !== String(city._id)) {
        return res.status(404).json({ error: 'Listing not found' });
      }

      const days = clampDays(req.query.days);
      const since = new Date(Date.now() - days * 86400000);
      const since14 = new Date(Date.now() - 14 * 86400000);

      const [actionRows, intentStatsRows, tsRows] = await Promise.all([
        col('user_signals').aggregate([
          { $match: { city_id: city._id, listing_id: String(listingId), action: { $in: INTEREST_ACTIONS }, ts: { $gte: since } } },
          { $group: { _id: '$action', count: { $sum: 1 } } },
        ]).toArray(),
        col('notify_intents').aggregate([
          { $match: { listing_id: String(listingId) } },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              unfulfilled: { $sum: { $cond: [{ $ne: ['$fulfilled', true] }, 1, 0] } },
              fulfilled: { $sum: { $cond: [{ $eq: ['$fulfilled', true] }, 1, 0] } },
            },
          },
        ]).toArray(),
        col('user_signals').aggregate([
          { $match: { city_id: city._id, listing_id: String(listingId), action: { $in: INTEREST_ACTIONS }, ts: { $gte: since14 } } },
          {
            $group: {
              _id: {
                // Truncate ts to YYYY-MM-DD using $dateTrunc — Mongo 5.0+
                day: { $dateTrunc: { date: '$ts', unit: 'day' } },
                action: '$action',
              },
              count: { $sum: 1 },
            },
          },
          { $sort: { '_id.day': 1 } },
        ]).toArray(),
      ]);

      // Flat actions object — default 0 for each known action.
      const actions = {};
      for (const a of INTEREST_ACTIONS) actions[a] = 0;
      for (const r of actionRows) {
        if (r && r._id) actions[String(r._id)] = r.count;
      }

      const safe = (num, den) => (den > 0 ? Number((num / den).toFixed(4)) : 0);
      const funnel = {
        impression_to_view: safe(actions.menu_viewed, actions.listing_card_shown),
        view_to_action: safe(actions.tapped_notify_me + actions.tapped_order_handoff, actions.menu_viewed),
        action_to_conversion: safe(actions.gbref_order_attributed, actions.tapped_order_handoff),
      };

      const intentStats = intentStatsRows[0] || { total: 0, unfulfilled: 0, fulfilled: 0 };

      // Reshape day-bucketed rows into [{ date, action, count }, ...].
      const time_series = tsRows.map((r) => {
        const day = r?._id?.day;
        const iso = day instanceof Date ? day.toISOString().slice(0, 10) : String(day || '').slice(0, 10);
        return {
          date: iso,
          action: r?._id?.action || null,
          count: r.count,
        };
      });

      res.json({
        days,
        actions,
        funnel,
        notify_intents: {
          total: intentStats.total || 0,
          unfulfilled: intentStats.unfulfilled || 0,
          fulfilled: intentStats.fulfilled || 0,
        },
        time_series,
      });
    } catch (err) {
      log.error({ err }, 'GET /:slug/listings/:listingId/analytics failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── E4: PATCH /:slug/listings/:listingId — partial update ───────────
// Whitelist intentionally EXCLUDES city_id, slug, research_status, and
// tags. research_status is only mutated by the research pipeline (and
// POST /research below); tags get their own PATCH endpoint that also
// runs taxonomy validation.
const PATCH_ALLOWED = new Set([
  'name',
  'description',
  'website_url',
  'phone_number',
  'lat',
  'lng',
  'address',
  'area',
  'delivery_zones',
  'fulfillment_mode',
  'status',
  'linked_restaurant_id',
  'editorial_boost_score',
  'sponsored_until',
  'sponsored_metadata',
]);

router.patch(
  '/:slug/listings/:listingId',
  ...requireRole(['super_admin']),
  async (req, res) => {
    try {
      const existing = await col('city_listings').findOne({ _id: req.params.listingId });
      if (!existing) return res.status(404).json({ error: 'Listing not found' });

      const city = await loadCity(req);
      if (!city || String(existing.city_id) !== String(city._id)) {
        return res.status(404).json({ error: 'Listing not found' });
      }

      const $set = validatePatchFields(req.body, PATCH_ALLOWED);

      if (Object.prototype.hasOwnProperty.call($set, 'area')) {
        if (!Array.isArray(city.areas) || !city.areas.includes($set.area)) {
          return res.status(400).json({ error: 'area must be one of the city\'s configured areas' });
        }
      }

      $set.updated_at = new Date();

      await col('city_listings').updateOne({ _id: existing._id }, { $set });
      const after = await col('city_listings').findOne({ _id: existing._id });

      const db = await connect();
      logAdminAction(
        db,
        req.adminUser?._id,
        'listing_updated',
        'listing',
        existing._id,
        city._id,
        existing,
        after,
        req.ip,
      );

      // ─── CAPTAIN RE-ENGAGEMENT TRIGGER ─────────────────────────
      // Fires when a listing newly becomes orderable: fulfillment_mode ==
      // 'handoff' AND linked_restaurant_id is present. Only enqueue if at
      // least one customer has tapped "Notify me 🔔" on this listing — a
      // quick countDocuments avoids dispatching a job that would no-op.
      try {
        const finalFulfillment = after?.fulfillment_mode;
        const finalRestaurantId = after?.linked_restaurant_id;
        if (finalFulfillment === 'handoff' && finalRestaurantId) {
          const intentCount = await col('notify_intents').countDocuments({
            listing_id: after._id,
            $or: [{ fulfilled: { $ne: true } }, { reengaged_at: { $exists: false } }],
          });
          if (intentCount > 0) {
            const { enqueueNotifyReengagement } = require('../utils/captainQueues');
            const redisClient = require('../queue/redis');
            enqueueNotifyReengagement(redisClient, after._id, after.city_id).catch((err) => {
              log.warn({ err: err.message, listingId: after._id }, 'enqueueNotifyReengagement failed');
            });
            log.info({ listingId: after._id, intentCount }, 'queued captain reengagement');
          }
        }
      } catch (err) {
        log.warn({ err: err.message }, 'captain reengagement trigger threw (swallowed)');
      }

      res.json(mapId(after));
    } catch (err) {
      log.error({ err }, 'PATCH /:slug/listings/:listingId failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── E5: PATCH /:slug/listings/:listingId/tags — set tags ────────────
router.patch(
  '/:slug/listings/:listingId/tags',
  ...requireRole(['super_admin']),
  async (req, res) => {
    try {
      const existing = await col('city_listings').findOne({ _id: req.params.listingId });
      if (!existing) return res.status(404).json({ error: 'Listing not found' });

      const taxonomy = await loadTaxonomy();
      if (!taxonomy) {
        return res.status(503).json({ error: 'Tag taxonomy unavailable' });
      }

      const { validTags, unknownTags } = validateAndSplitTags(req.body?.tags || {}, taxonomy);

      const $set = { tags: validTags, updated_at: new Date() };

      // Promote a draft to active once it has the two minimum-required
      // tags set (at least one primary cuisine + veg_status).
      if (
        existing.status === 'draft'
        && Array.isArray(validTags.cuisine_primary)
        && validTags.cuisine_primary.length > 0
        && validTags.veg_status
      ) {
        $set.status = 'active';
      }

      await col('city_listings').updateOne({ _id: existing._id }, { $set });

      if (unknownTags && Object.keys(unknownTags).length > 0) {
        const db = await connect();
        await promoteCandidateTags(unknownTags, existing._id, db);
      }

      const after = await col('city_listings').findOne({ _id: existing._id });

      const db = await connect();
      logAdminAction(
        db,
        req.adminUser?._id,
        'listing_tags_updated',
        'listing',
        existing._id,
        existing.city_id,
        existing,
        after,
        req.ip,
      );

      res.json({ ...mapId(after), unknown_tags_promoted: unknownTags || {} });
    } catch (err) {
      log.error({ err }, 'PATCH /:slug/listings/:listingId/tags failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── E6: POST /:slug/listings/:listingId/research — re-enqueue ──────
const RESEARCH_RETRY_STATES = new Set(['pending', 'research_failed', 'no_content_found']);

router.post(
  '/:slug/listings/:listingId/research',
  ...requireRole(['super_admin']),
  async (req, res) => {
    try {
      const existing = await col('city_listings').findOne({ _id: req.params.listingId });
      if (!existing) return res.status(404).json({ error: 'Listing not found' });

      if (!RESEARCH_RETRY_STATES.has(existing.research_status)) {
        return res.status(409).json({
          error: 'Listing research_status does not allow re-research',
          research_status: existing.research_status,
        });
      }

      await col('city_listings').updateOne(
        { _id: existing._id },
        { $set: { research_status: 'in_progress', updated_at: new Date() } },
      );

      enqueueMenuResearch(redisClient, existing._id, existing.city_id, 'high').catch((err) => {
        log.warn({ err: err.message, listingId: existing._id }, 'enqueueMenuResearch (high) failed');
      });

      res.json({ success: true, listing_id: existing._id });
    } catch (err) {
      log.error({ err }, 'POST /:slug/listings/:listingId/research failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── E7: POST /:slug/research-all — bulk re-research for a city ─────
router.post(
  '/:slug/research-all',
  ...requireRole(['super_admin']),
  async (req, res) => {
    try {
      const city = await loadCity(req);
      if (!city) return res.status(404).json({ error: 'City not found' });

      const eligibleStates = ['pending', 'research_failed', 'no_content_found'];

      const candidates = await col('city_listings')
        .find(
          { city_id: city._id, research_status: { $in: eligibleStates } },
          { projection: { _id: 1 } },
        )
        .toArray();

      const skippedCount = await col('city_listings').countDocuments({
        city_id: city._id,
        research_status: { $nin: eligibleStates },
      });

      if (candidates.length > 0) {
        await col('city_listings').updateMany(
          { _id: { $in: candidates.map((c) => c._id) } },
          { $set: { research_status: 'in_progress', updated_at: new Date() } },
        );
        for (const c of candidates) {
          enqueueMenuResearch(redisClient, c._id, city._id, 'normal').catch((err) => {
            log.warn({ listingId: c._id, err: err.message }, 'enqueueMenuResearch failed');
          });
        }
      }

      res.json({ enqueued: candidates.length, skipped: skippedCount });
    } catch (err) {
      log.error({ err }, 'POST /:slug/research-all failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── E8: GET /:slug/listings/:listingId/snapshots — snapshot summary list
router.get(
  '/:slug/listings/:listingId/snapshots',
  ...requireRole(['super_admin', 'city_ops']),
  requireCityAccessBySlug,
  async (req, res) => {
    try {
      const city = await loadCity(req);
      if (!city) return res.status(404).json({ error: 'City not found' });

      const existing = await col('city_listings').findOne({ _id: req.params.listingId });
      if (!existing || String(existing.city_id) !== String(city._id)) {
        return res.status(404).json({ error: 'Listing not found' });
      }

      const snaps = await col('menu_snapshots')
        .find({ listing_id: existing._id })
        .sort({ created_at: -1 })
        .toArray();

      res.json(snaps.map((s) => ({
        _id: s._id,
        status: s.status,
        is_live: !!s.is_live,
        source: s.source,
        sources_cited: s.sources_cited || [],
        item_count: Array.isArray(s.extracted_items) ? s.extracted_items.length : 0,
        has_tags: !!(s.tags && Object.keys(s.tags).length > 0),
        created_at: s.created_at,
      })));
    } catch (err) {
      log.error({ err }, 'GET /:slug/listings/:listingId/snapshots failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── E8b: GET /:slug/listings/:listingId/snapshots/:snapshotId — full doc
router.get(
  '/:slug/listings/:listingId/snapshots/:snapshotId',
  ...requireRole(['super_admin', 'city_ops']),
  requireCityAccessBySlug,
  async (req, res) => {
    try {
      const { listingId, snapshotId } = req.params;
      // We don't actually need the city here for the response — the access
      // gate already validated it — but match the style of sibling handlers
      // that fetch via the resolved city when present.
      const listing = await col('city_listings').findOne({ _id: listingId });
      if (!listing) return res.status(404).json({ error: 'Listing not found' });
      const snapshot = await col('menu_snapshots').findOne({ _id: snapshotId });
      if (!snapshot) return res.status(404).json({ error: 'Snapshot not found' });
      if (String(snapshot.listing_id) !== String(listing._id)) {
        return res.status(404).json({ error: 'Snapshot does not belong to this listing' });
      }
      return res.json(mapId(snapshot));
    } catch (err) {
      log.error({ err }, 'GET single snapshot failed');
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── E9: POST /:slug/listings/:listingId/snapshots/:snapshotId/publish
router.post(
  '/:slug/listings/:listingId/snapshots/:snapshotId/publish',
  ...requireRole(['super_admin']),
  async (req, res) => {
    try {
      const listing = await col('city_listings').findOne({ _id: req.params.listingId });
      if (!listing) return res.status(404).json({ error: 'Listing not found' });

      const snap = await col('menu_snapshots').findOne({ _id: req.params.snapshotId });
      if (!snap || String(snap.listing_id) !== String(listing._id)) {
        return res.status(404).json({ error: 'Snapshot not found for this listing' });
      }

      if (!snap.tags || Object.keys(snap.tags).length === 0) {
        return res.status(400).json({ error: 'Snapshot has no tags. Set tags first.' });
      }

      // Demote any other live snapshot for this listing — only one
      // is_live=true row at a time.
      await col('menu_snapshots').updateMany(
        { listing_id: listing._id, _id: { $ne: snap._id }, is_live: true },
        { $set: { is_live: false } },
      );

      await col('menu_snapshots').updateOne(
        { _id: snap._id },
        { $set: { is_live: true, status: 'live', published_at: new Date() } },
      );

      await col('city_listings').updateOne(
        { _id: listing._id },
        {
          $set: {
            tags: snap.tags,
            research_status: 'complete',
            status: 'active',
            latest_snapshot_id: snap._id,
            updated_at: new Date(),
          },
        },
      );

      const db = await connect();
      logAdminAction(
        db,
        req.adminUser?._id,
        'snapshot_published',
        'listing',
        listing._id,
        listing.city_id,
        listing,
        {
          ...listing,
          tags: snap.tags,
          status: 'active',
          research_status: 'complete',
          latest_snapshot_id: snap._id,
        },
        req.ip,
      );

      res.json({ success: true });
    } catch (err) {
      log.error({ err }, 'POST /:slug/listings/:listingId/snapshots/:snapshotId/publish failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── E10: DELETE /:slug/listings/:listingId — soft delete only ──────
router.delete(
  '/:slug/listings/:listingId',
  ...requireRole(['super_admin']),
  async (req, res) => {
    try {
      const existing = await col('city_listings').findOne({ _id: req.params.listingId });
      if (!existing) return res.status(404).json({ error: 'Listing not found' });

      await col('city_listings').updateOne(
        { _id: existing._id },
        { $set: { status: 'deleted', deleted_at: new Date(), updated_at: new Date() } },
      );

      const db = await connect();
      logAdminAction(
        db,
        req.adminUser?._id,
        'listing_deleted',
        'listing',
        existing._id,
        existing.city_id,
        existing,
        null,
        req.ip,
      );

      res.json({ success: true });
    } catch (err) {
      log.error({ err }, 'DELETE /:slug/listings/:listingId failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

module.exports = router;
