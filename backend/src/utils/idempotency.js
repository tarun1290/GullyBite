// src/utils/idempotency.js
// Centralized idempotency guard for webhook and async event processing.
//
// Uses a `processed_events` MongoDB collection with a TTL index (24h default).
// Each event is identified by a composite key: `${source}:${eventId}`
//
// Usage:
//   const { once } = require('../utils/idempotency');
//
//   // Returns true if this is the FIRST time processing this event.
//   // Returns false if already processed (duplicate — skip it).
//   const isNew = await once('razorpay', event.id);
//   if (!isNew) return;  // duplicate — bail out
//
//   // ... process the event ...
//
// The guard is atomic: two concurrent calls with the same key will
// race on insertOne — the loser gets a duplicate-key error and returns false.

'use strict';

const log = require('./logger').child({ component: 'idempotency' });

/**
 * Check-and-claim an event for processing. Returns true only once per key.
 *
 * @param {string} source   — webhook source (e.g. 'razorpay', 'delivery', 'whatsapp_status')
 * @param {string} eventId  — unique event identifier from the external system
 * @param {object} [meta]   — optional metadata stored alongside (for debugging)
 * @returns {Promise<boolean>} true = first time (process it), false = duplicate (skip)
 */
async function once(source, eventId, meta = {}) {
  if (!source || !eventId) {
    log.warn({ source, eventId }, 'Idempotency check called with missing key — allowing through');
    return true; // fail-open: don't block processing if key is missing
  }

  const { col } = require('../config/database');
  const key = `${source}:${eventId}`;

  try {
    await col('processed_events').insertOne({
      _id: key,
      source,
      event_id: eventId,
      processed_at: new Date(),
      meta,
    });
    return true; // first time — proceed
  } catch (err) {
    if (err.code === 11000) {
      // Duplicate key = already processed
      log.info({ source, eventId }, 'Duplicate event — skipping');
      return false;
    }
    // Unexpected DB error — fail-open to avoid blocking webhooks
    log.error({ err, source, eventId }, 'Idempotency check failed — allowing through');
    return true;
  }
}

module.exports = { once };
