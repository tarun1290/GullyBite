'use strict';

const express = require('express');
const router = express.Router();
const { col, newId, mapId, mapIds, connect } = require('../config/database');
const { requireAuth } = require('./auth');
const log = require('../utils/logger').child({ component: 'captainRestaurant' });

// Resolve the city_listing linked to this restaurant, or null. Used by
// /listing and /listing PATCH so they share one lookup path with the
// same projection.
async function findLinkedListing(restaurantId) {
  return col('city_listings').findOne({ linked_restaurant_id: restaurantId, status: { $ne: 'deleted' } });
}

// ─── ENDPOINT 1: GET /listing ────────────────────────────────
// Returns the city_listing linked to req.restaurantId (if any) plus
// the parent city's name + slug. { linked: false } when unclaimed.
router.get('/listing', requireAuth, async (req, res) => {
  try {
    const listing = await findLinkedListing(req.restaurantId);
    if (!listing) return res.json({ linked: false });
    // Parallelise the city lookup with the notify_intents rollup so the
    // page can render the "X customers are waiting" callout without a
    // second round-trip. `fulfilled !== true` is the unfulfilled cohort;
    // `fulfilled === true` is the re-engaged cohort (captainReengagement
    // stamps both fulfilled + reengaged_at when the send goes out).
    const [city, notifyRows] = await Promise.all([
      col('cities').findOne(
        { _id: listing.city_id },
        { projection: { name: 1, slug: 1 } },
      ),
      col('notify_intents').aggregate([
        { $match: { listing_id: String(listing._id) } },
        { $group: {
          _id: null,
          total: { $sum: 1 },
          unfulfilled: { $sum: { $cond: [{ $ne: ['$fulfilled', true] }, 1, 0] } },
          fulfilled: { $sum: { $cond: [{ $eq: ['$fulfilled', true] }, 1, 0] } },
        } },
      ]).toArray(),
    ]);
    const notify = notifyRows[0] || { total: 0, unfulfilled: 0, fulfilled: 0 };
    return res.json({
      linked: true,
      listing: mapId(listing),
      city: city ? { name: city.name, slug: city.slug } : null,
      notify_counts: { total: notify.total, unfulfilled: notify.unfulfilled, fulfilled: notify.fulfilled },
    });
  } catch (err) {
    log.error({ err }, 'GET /listing failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── ENDPOINT 2: GET /suggested ──────────────────────────────
// Fuzzy-match unlinked city_listings on the restaurant's business name.
// Returns up to 5 candidates with city info + unfulfilled notify counts
// so the captain can pick which listing to claim.
router.get('/suggested', requireAuth, async (req, res) => {
  try {
    const existing = await findLinkedListing(req.restaurantId);
    if (existing) return res.json([]); // already claimed — no suggestions
    const restaurant = await col('restaurants').findOne(
      { _id: req.restaurantId },
      { projection: { business_name: 1, brand_name: 1 } },
    );
    const term = (restaurant?.business_name || restaurant?.brand_name || '').trim();
    if (!term || term.length < 2) return res.json([]);
    // Escape regex metachars to avoid accidental wildcards from punctuation.
    const safe = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = await col('city_listings').find(
      {
        $or: [{ linked_restaurant_id: null }, { linked_restaurant_id: { $exists: false } }],
        status: { $ne: 'deleted' },
        name: { $regex: safe, $options: 'i' },
      },
      { projection: { name: 1, area: 1, city_id: 1, status: 1, business_type: 1 } },
    ).limit(5).toArray();
    if (matches.length === 0) return res.json([]);
    const cityIds = [...new Set(matches.map((m) => String(m.city_id)))];
    const cities = await col('cities').find(
      { _id: { $in: cityIds } },
      { projection: { name: 1, slug: 1 } },
    ).toArray();
    const cityById = new Map(cities.map((c) => [String(c._id), c]));
    const intentCounts = await col('notify_intents').aggregate([
      { $match: {
        listing_id: { $in: matches.map((m) => String(m._id)) },
        $or: [{ fulfilled: { $ne: true } }, { reengaged_at: { $exists: false } }],
      } },
      { $group: { _id: '$listing_id', count: { $sum: 1 } } },
    ]).toArray();
    const countById = new Map(intentCounts.map((c) => [String(c._id), c.count]));
    const enriched = matches.map((l) => ({
      ...mapId(l),
      city: cityById.get(String(l.city_id))
        ? { name: cityById.get(String(l.city_id)).name, slug: cityById.get(String(l.city_id)).slug }
        : null,
      unfulfilled_notify_count: countById.get(String(l._id)) || 0,
    }));
    return res.json(enriched);
  } catch (err) {
    log.error({ err }, 'GET /suggested failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── ENDPOINT 3: POST /listing/claim/:listingId ──────────────
// Claim an unlinked listing (or re-confirm one already linked to this
// restaurant). Flips fulfillment_mode → 'handoff' and triggers the
// captain re-engagement queue if there are pending notify intents.
router.post('/listing/claim/:listingId', requireAuth, async (req, res) => {
  try {
    const { listingId } = req.params;
    const listing = await col('city_listings').findOne({ _id: listingId });
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    if (listing.status === 'deleted') return res.status(404).json({ error: 'Listing not found' });
    if (listing.linked_restaurant_id && String(listing.linked_restaurant_id) !== String(req.restaurantId)) {
      return res.status(409).json({ error: 'Listing already claimed by another restaurant' });
    }
    await col('city_listings').updateOne(
      { _id: listing._id },
      { $set: {
        linked_restaurant_id: req.restaurantId,
        fulfillment_mode: 'handoff',
        updated_at: new Date(),
      } },
    );
    const after = await col('city_listings').findOne({ _id: listing._id });

    // Enqueue re-engagement only if there's at least one unfulfilled
    // notify intent — mirrors the cityListings.js PATCH trigger.
    try {
      const intentCount = await col('notify_intents').countDocuments({
        listing_id: listing._id,
        $or: [{ fulfilled: { $ne: true } }, { reengaged_at: { $exists: false } }],
      });
      if (intentCount > 0) {
        const { enqueueNotifyReengagement } = require('../utils/captainQueues');
        const redisClient = require('../queue/redis');
        enqueueNotifyReengagement(redisClient, listing._id, listing.city_id).catch((err) => {
          log.warn({ err: err.message, listingId: listing._id }, 'enqueueNotifyReengagement failed');
        });
        log.info({ listingId: listing._id, intentCount, restaurantId: req.restaurantId }, 'queued captain reengagement after claim');
      }
    } catch (err) {
      log.warn({ err: err.message }, 'captain reengagement trigger threw (swallowed)');
    }

    return res.json(mapId(after));
  } catch (err) {
    log.error({ err }, 'POST /listing/claim/:listingId failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── ENDPOINT 4: PATCH /listing ──────────────────────────────
// Update editable fields on the linked listing. Whitelist excludes
// status, name, slug, city_id, fulfillment_mode, linked_restaurant_id
// — those are admin-only. delivery_zones is dropped silently for
// non-cloud_kitchen listings (no error — keeps client payloads simple).
router.patch('/listing', requireAuth, async (req, res) => {
  try {
    const listing = await findLinkedListing(req.restaurantId);
    if (!listing) return res.status(404).json({ error: 'No linked listing' });
    const ALLOWED = new Set(['description', 'website_url', 'phone_number', 'delivery_zones']);
    const $set = { updated_at: new Date() };
    for (const [key, value] of Object.entries(req.body || {})) {
      if (!ALLOWED.has(key)) continue;
      if (key === 'delivery_zones') {
        if (listing.business_type !== 'cloud_kitchen') continue; // silent drop
        if (!Array.isArray(value)) return res.status(400).json({ error: 'delivery_zones must be an array' });
        $set.delivery_zones = value;
        continue;
      }
      $set[key] = value;
    }
    await col('city_listings').updateOne({ _id: listing._id }, { $set });
    const after = await col('city_listings').findOne({ _id: listing._id });
    return res.json(mapId(after));
  } catch (err) {
    log.error({ err }, 'PATCH /listing failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
