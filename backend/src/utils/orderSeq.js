// src/utils/orderSeq.js
//
// Per-restaurant, per-day atomic sequence counter for the
// display-friendly `order_id` shown to customers (e.g. ZM-0504-018).
// Distinct from the legacy global `order_number` (ZM-YYYYMMDD-NNNN)
// which is a tenant-blind counter — this one resets to 1 each calendar
// day per restaurant and pairs with each restaurant's `order_abbr`.
//
// Storage: a single Mongo doc per (restaurant, day) under the
// `counters` collection, keyed on (restaurantId + YYYYMMDD). The
// findOneAndUpdate with $inc + upsert is atomic, so two simultaneous
// order creations from the same restaurant on the same day cannot
// collide.
//
// Year rollover: keys include the year, so May 4 2026 and May 4 2027
// get separate counter docs (each starts at 1 on its own calendar
// day). The display string customers see still uses MMDD only —
// callers slice the year out when constructing the visible id. Old
// MMDD-keyed counter docs from before this rollout are harmless
// orphans in the collection — they never get incremented again, so a
// future cleanup job could prune them, but they don't affect the
// new YYYYMMDD-keyed counters.

'use strict';

const { col } = require('../config/database');

/**
 * Atomically increment and return the next sequence number for the
 * given (restaurantId, YYYYMMDD) tuple.
 *
 * @param {string} restaurantId — UUID of the restaurant
 * @param {string} dateStr8     — YYYYMMDD (e.g. '20260504' for May 4 2026)
 * @returns {Promise<number>}   — the post-increment seq value (1, 2, 3, …)
 */
async function getNextOrderSeq(restaurantId, dateStr8) {
  if (!restaurantId) throw new Error('getNextOrderSeq: restaurantId required');
  if (!dateStr8 || !/^\d{8}$/.test(String(dateStr8))) {
    throw new Error('getNextOrderSeq: dateStr8 must be YYYYMMDD (8 digits)');
  }
  const key = `order_seq_${restaurantId}_${dateStr8}`;
  const result = await col('counters').findOneAndUpdate(
    { _id: key },
    {
      $inc: { seq: 1 },
      $setOnInsert: {
        restaurant_id: String(restaurantId),
        date: String(dateStr8),
        created_at: new Date(),
      },
      $set: { updated_at: new Date() },
    },
    { upsert: true, returnDocument: 'after' },
  );
  // mongodb v4 wraps the doc as { value: doc }; v5+ returns the doc
  // directly. Handle both shapes — same pattern as queue/postPaymentJobs
  // _claim() at line 113.
  const doc = result?.value ?? result ?? null;
  return Number(doc?.seq) || 1;
}

module.exports = { getNextOrderSeq };
