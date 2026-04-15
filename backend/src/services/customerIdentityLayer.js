'use strict';

// Phase 6: unified customer-identity layer.
//
// Two concerns, two writes:
//   1. customers — stamp phone_hash + first_seen_at / last_seen_at
//      (the wa_phone row already exists from the WhatsApp intake flow;
//      we only backfill the identity columns here, we don't own its
//      creation).
//   2. customer_metrics — one row per phone_hash, carrying global
//      totals + a per-restaurant stats array. Order create calls
//      `recordOrderCreated` (increments); delivery success can call
//      `recordOrderDelivered` (no-op for now — the old customers-row
//      writer at order.js:455 remains authoritative for LTV until a
//      later migration folds it in).
//
// Non-blocking contract: every public function is safe to fire-and-
// forget. Exceptions are swallowed into the logger so a metrics failure
// can never roll back an order.

const { col, newId } = require('../config/database');
const { hashPhone } = require('../utils/phoneHash');
const log = require('../utils/logger');

// Phase 6.1: classification rules. Primary type is mutually exclusive;
// 'high_value' is additive so a loyal customer can also be high_value.
// Dormant is time-based so it's checked before the count-based tiers.
const HIGH_VALUE_SPEND_RS = Number(process.env.HIGH_VALUE_SPEND_THRESHOLD_RS) || 5000;
const DORMANT_DAYS = Number(process.env.DORMANT_DAYS) || 30;

function classify({ totalOrders = 0, totalSpentRs = 0, lastOrderAt = null }) {
  const daysSince = lastOrderAt
    ? (Date.now() - new Date(lastOrderAt).getTime()) / (24 * 60 * 60 * 1000)
    : Infinity;

  let type;
  if (totalOrders >= 1 && daysSince > DORMANT_DAYS) {
    type = 'dormant';
  } else if (totalOrders >= 5) {
    type = 'loyal';
  } else if (totalOrders >= 2) {
    type = 'repeat';
  } else {
    type = 'new';
  }

  const tags = [type];
  if (totalSpentRs > HIGH_VALUE_SPEND_RS) tags.push('high_value');

  return { type, tags };
}

async function _upsertCustomerIdentity({ phoneHash, customerId, name, now }) {
  const setOnInsert = { first_seen_at: now, created_at: now };
  const set = {
    phone_hash: phoneHash,
    last_seen_at: now,
    updated_at: now,
  };
  if (name) set.name = name;

  // Match by customer_id when we have it (the WhatsApp intake flow
  // already created the customers row), otherwise by phone_hash.
  const filter = customerId ? { _id: customerId } : { phone_hash: phoneHash };
  await col('customers').updateOne(
    filter,
    { $set: set, $setOnInsert: setOnInsert },
    { upsert: !customerId },
  );
}

async function _upsertMetrics({ phoneHash, customerId, restaurantId, orderTotalRs, now }) {
  const metricsCol = col('customer_metrics');

  // Two-step because MongoDB $inc can't target an array element that
  // may not yet exist. First: ensure the top-level doc exists and bump
  // global counters. Second: either $inc the matching restaurant_stats
  // element if present, or $push a new one if not.
  await metricsCol.updateOne(
    { phone_hash: phoneHash },
    {
      $setOnInsert: {
        _id: newId(),
        phone_hash: phoneHash,
        created_at: now,
        restaurant_stats: [],
      },
      $set: {
        customer_id: customerId || null,
        last_order_at: now,
        updated_at: now,
      },
      $inc: {
        total_orders: 1,
        total_spent_rs: Number(orderTotalRs) || 0,
      },
    },
    { upsert: true },
  );

  if (!restaurantId) return;

  const incResult = await metricsCol.updateOne(
    { phone_hash: phoneHash, 'restaurant_stats.restaurant_id': restaurantId },
    {
      $inc: {
        'restaurant_stats.$.order_count': 1,
        'restaurant_stats.$.total_spent_rs': Number(orderTotalRs) || 0,
      },
      $set: {
        'restaurant_stats.$.last_order_at': now,
      },
    },
  );

  if (incResult.matchedCount === 0) {
    await metricsCol.updateOne(
      { phone_hash: phoneHash },
      {
        $push: {
          restaurant_stats: {
            restaurant_id: restaurantId,
            order_count: 1,
            total_spent_rs: Number(orderTotalRs) || 0,
            last_order_at: now,
          },
        },
      },
    );
  }
}

async function _recomputeClassification(phoneHash) {
  const doc = await col('customer_metrics').findOne(
    { phone_hash: phoneHash },
    { projection: { total_orders: 1, total_spent_rs: 1, last_order_at: 1 } },
  );
  if (!doc) return;
  const { type, tags } = classify({
    totalOrders: doc.total_orders || 0,
    totalSpentRs: doc.total_spent_rs || 0,
    lastOrderAt: doc.last_order_at,
  });
  await col('customer_metrics').updateOne(
    { phone_hash: phoneHash },
    { $set: { customer_type: type, tags, updated_at: new Date() } },
  );
}

// Public: call after an order is persisted. Safe to fire-and-forget.
async function recordOrderCreated({ waPhone, customerId, restaurantId, name, totalRs }) {
  const phoneHash = hashPhone(waPhone);
  if (!phoneHash) return;
  const now = new Date();

  try {
    await _upsertCustomerIdentity({ phoneHash, customerId, name, now });
  } catch (err) {
    log.warn({ err }, 'identity.customer_upsert_failed');
  }

  try {
    await _upsertMetrics({ phoneHash, customerId, restaurantId, orderTotalRs: totalRs, now });
  } catch (err) {
    log.warn({ err }, 'identity.metrics_upsert_failed');
  }

  try {
    await _recomputeClassification(phoneHash);
  } catch (err) {
    log.warn({ err }, 'identity.classify_failed');
  }
}

module.exports = { recordOrderCreated, classify };
