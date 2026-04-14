// src/services/customerProfile.service.js
// Phase 1: per-tenant customer state. One row per
// (restaurant_id, customer_id). Stores LTV, preferences, and the
// last-order timestamp this tenant has seen.
//
// Kept separate from customers.service.js to preserve the invariant
// that cross-tenant writes can't leak via a shared identity row:
// restaurant A updating its view of a customer MUST NOT touch
// restaurant B's totals.

'use strict';

const { col, newId } = require('../config/database');

const COLLECTION = 'customer_profiles';

async function getOrCreate(restaurantId, customerId) {
  if (!restaurantId || !customerId) {
    throw new Error('getOrCreate requires restaurantId and customerId');
  }
  const now = new Date();
  const res = await col(COLLECTION).findOneAndUpdate(
    { restaurant_id: String(restaurantId), customer_id: String(customerId) },
    {
      $setOnInsert: {
        _id: newId(),
        restaurant_id: String(restaurantId),
        customer_id: String(customerId),
        total_orders: 0,
        total_spent_rs: 0,
        last_order_at: null,
        preferences: {},
        created_at: now,
      },
      $set: { updated_at: now },
    },
    { upsert: true, returnDocument: 'after' }
  );
  return res?.value || col(COLLECTION).findOne({
    restaurant_id: String(restaurantId),
    customer_id: String(customerId),
  });
}

function get(restaurantId, customerId) {
  return col(COLLECTION).findOne({
    restaurant_id: String(restaurantId),
    customer_id: String(customerId),
  });
}

// Called once per successful order. Atomic $inc keeps totals correct
// under concurrent webhook replays — pair with idempotency_keys at the
// caller if the same order could post twice.
async function recordOrder(restaurantId, customerId, { total_rs, ordered_at } = {}) {
  if (!restaurantId || !customerId) return null;
  await getOrCreate(restaurantId, customerId);
  const when = ordered_at instanceof Date ? ordered_at : new Date();
  const amount = Number(total_rs) || 0;
  await col(COLLECTION).updateOne(
    { restaurant_id: String(restaurantId), customer_id: String(customerId) },
    {
      $inc: { total_orders: 1, total_spent_rs: amount },
      $set: { last_order_at: when, updated_at: new Date() },
    }
  );
  return get(restaurantId, customerId);
}

async function setPreferences(restaurantId, customerId, preferences) {
  if (!restaurantId || !customerId) return null;
  await getOrCreate(restaurantId, customerId);
  await col(COLLECTION).updateOne(
    { restaurant_id: String(restaurantId), customer_id: String(customerId) },
    { $set: { preferences: preferences || {}, updated_at: new Date() } }
  );
  return get(restaurantId, customerId);
}

module.exports = {
  COLLECTION,
  getOrCreate,
  get,
  recordOrder,
  setPreferences,
};
