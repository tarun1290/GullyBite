'use strict';

// Phase 6 backfill: populate customer_metrics + customers.phone_hash
// from the existing orders collection.
//
// Safe to re-run — every write is an upsert/incremental update, and
// rows already carrying phone_hash are skipped on the customers pass.
//
// Run: node backend/src/scripts/backfill-customer-identity.js

require('dotenv').config({ quiet: true });
const { connect, col } = require('../config/database');
const { hashPhone } = require('../utils/phoneHash');

async function backfillCustomersHash() {
  const cursor = col('customers').find(
    { phone_hash: { $exists: false }, wa_phone: { $ne: null } },
    { projection: { _id: 1, wa_phone: 1, created_at: 1 } },
  );
  let updated = 0;
  for await (const c of cursor) {
    const h = hashPhone(c.wa_phone);
    if (!h) continue;
    await col('customers').updateOne(
      { _id: c._id },
      {
        $set: { phone_hash: h },
        $setOnInsert: { first_seen_at: c.created_at || new Date() },
      },
    );
    updated += 1;
  }
  return updated;
}

async function backfillMetricsFromOrders() {
  // Aggregate orders into the shape customer_metrics expects, then
  // replace the doc wholesale. Replace (not incremental) so repeated
  // runs converge on the correct value even if the earlier run was
  // interrupted mid-flight.
  const rows = await col('orders').aggregate([
    { $match: { phone_hash: { $ne: null } } },
    {
      $group: {
        _id: { phone_hash: '$phone_hash', restaurant_id: '$restaurant_id' },
        customer_id: { $last: '$customer_id' },
        order_count: { $sum: 1 },
        total_spent_rs: { $sum: { $ifNull: ['$total_rs', 0] } },
        last_order_at: { $max: '$created_at' },
      },
    },
    {
      $group: {
        _id: '$_id.phone_hash',
        customer_id: { $last: '$customer_id' },
        total_orders: { $sum: '$order_count' },
        total_spent_rs: { $sum: '$total_spent_rs' },
        last_order_at: { $max: '$last_order_at' },
        restaurant_stats: {
          $push: {
            restaurant_id: '$_id.restaurant_id',
            order_count: '$order_count',
            total_spent_rs: '$total_spent_rs',
            last_order_at: '$last_order_at',
          },
        },
      },
    },
  ]).toArray();

  const { newId } = require('../config/database');
  const now = new Date();
  let written = 0;
  const { classify } = require('../services/customerIdentityLayer');
  for (const r of rows) {
    const { type, tags } = classify({
      totalOrders: r.total_orders,
      totalSpentRs: r.total_spent_rs,
      lastOrderAt: r.last_order_at,
    });
    await col('customer_metrics').updateOne(
      { phone_hash: r._id },
      {
        $set: {
          phone_hash: r._id,
          customer_id: r.customer_id || null,
          total_orders: r.total_orders,
          total_spent_rs: r.total_spent_rs,
          last_order_at: r.last_order_at,
          restaurant_stats: r.restaurant_stats,
          customer_type: type,
          tags,
          updated_at: now,
        },
        $setOnInsert: { _id: newId(), created_at: now },
      },
      { upsert: true },
    );
    written += 1;
  }
  return written;
}

async function backfillOrderPhoneHash() {
  // Stamp phone_hash onto legacy orders by joining through customer_id.
  const cursor = col('orders').find(
    { phone_hash: { $exists: false }, customer_id: { $ne: null } },
    { projection: { _id: 1, customer_id: 1 } },
  );
  let updated = 0;
  for await (const o of cursor) {
    const cust = await col('customers').findOne(
      { _id: o.customer_id },
      { projection: { phone_hash: 1, wa_phone: 1 } },
    );
    const h = cust?.phone_hash || hashPhone(cust?.wa_phone);
    if (!h) continue;
    await col('orders').updateOne({ _id: o._id }, { $set: { phone_hash: h } });
    updated += 1;
  }
  return updated;
}

async function main() {
  await connect();
  console.log('[backfill] customers.phone_hash …');
  const c = await backfillCustomersHash();
  console.log(`[backfill] customers updated: ${c}`);

  console.log('[backfill] orders.phone_hash …');
  const o = await backfillOrderPhoneHash();
  console.log(`[backfill] orders updated:    ${o}`);

  console.log('[backfill] customer_metrics …');
  const m = await backfillMetricsFromOrders();
  console.log(`[backfill] metrics written:   ${m}`);

  console.log('[backfill] done');
  process.exit(0);
}

main().catch((err) => {
  console.error('[backfill] failed', err);
  process.exit(1);
});
