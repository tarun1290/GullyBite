'use strict';

// Analytics listener: persists every event to col('events') and times its
// own execution for observability. This IS the event-store for audit and
// replay — other listeners are free to fail; the record here is the truth.
// The persisted payload strips the `_order` helper field (too big, already
// authoritative in `orders` collection) and keeps the canonical summary.

const log = require('../../utils/logger').child({ component: 'analytics-listener' });
const { col, newId } = require('../../config/database');

function handleEvent(eventName) {
  return async function (payload) {
    const started = Date.now();
    try {
      const doc = {
        _id: newId(),
        event: eventName,
        restaurant_id: payload?.restaurantId || null,
        payload: _sanitize(payload),
        emitted_at: new Date(),
      };
      await col('events').insertOne(doc);
      log.info({ event: eventName, restaurantId: doc.restaurant_id, ms: Date.now() - started }, 'Event persisted');
    } catch (err) {
      log.error({ event: eventName, err: err.message, ms: Date.now() - started }, 'Event persist failed');
    }
  };
}

function _sanitize(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const { _order, ...rest } = payload;
  return rest;
}

module.exports = { handleEvent };
