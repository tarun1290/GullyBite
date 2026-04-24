// src/scripts/migrate-phase1.js
// Phase 1 migration — run once per environment.
//
// What it does:
//
//   1. Drops the legacy GLOBAL-unique index on menu_items.retailer_id.
//      The composite (restaurant_id, retailer_id) unique index is
//      created by ensureIndexes(). Both cannot coexist because the
//      legacy index would reject any multi-tenant reuse of a SKU.
//
//   2. Backfills denormalized restaurant_id on legacy rows that
//      predate Phase 1 (order_items, payments, conversations,
//      messages). Backfill is driven by joining each row to its
//      parent order/customer.
//
//   3. Backfills customer_profiles from the legacy per-tenant fields
//      that used to live on `customers` (total_orders, total_spent_rs)
//      — only if those fields are still present. New customers.js
//      does not write them.
//
//   4. Calls ensureIndexes() to create every new Phase 1 index.
//
// Run:
//     node backend/src/scripts/migrate-phase1.js
//
// Safe to re-run. Every step is idempotent.

'use strict';

require('dotenv').config({ quiet: true });

const { connect, col, newId } = require('../config/database');
const { ensureIndexes } = require('../config/indexes');
const log = require('../utils/logger').child({ component: 'migrate-phase1' });

async function dropLegacyRetailerIdIndex() {
  const indexes = await col('menu_items').indexes().catch(() => []);
  for (const ix of indexes) {
    // The legacy global-unique index looks like { retailer_id: 1 }, unique: true
    // (no restaurant_id). Drop it by name — createIndex for the new
    // composite will succeed afterwards via ensureIndexes().
    const keys = Object.keys(ix.key || {});
    if (keys.length === 1 && keys[0] === 'retailer_id' && ix.unique) {
      log.info({ name: ix.name }, 'Dropping legacy global-unique menu_items.retailer_id index');
      try {
        await col('menu_items').dropIndex(ix.name);
      } catch (err) {
        log.warn({ err, name: ix.name }, 'Failed to drop legacy retailer_id index');
      }
      return true;
    }
  }
  log.info('No legacy global-unique menu_items.retailer_id index found');
  return false;
}

async function backfillOrderItemsRestaurantId() {
  const cursor = col('order_items').find(
    { restaurant_id: { $exists: false } },
    { projection: { _id: 1, order_id: 1 } }
  );
  let n = 0;
  while (await cursor.hasNext()) {
    const row = await cursor.next();
    const order = await col('orders').findOne(
      { _id: row.order_id },
      { projection: { restaurant_id: 1 } }
    );
    if (!order?.restaurant_id) continue;
    await col('order_items').updateOne(
      { _id: row._id },
      { $set: { restaurant_id: order.restaurant_id } }
    );
    n++;
  }
  log.info({ updated: n }, 'order_items.restaurant_id backfilled');
}

async function backfillPaymentsRestaurantId() {
  const cursor = col('payments').find(
    { restaurant_id: { $exists: false } },
    { projection: { _id: 1, order_id: 1 } }
  );
  let n = 0;
  while (await cursor.hasNext()) {
    const row = await cursor.next();
    const order = await col('orders').findOne(
      { _id: row.order_id },
      { projection: { restaurant_id: 1 } }
    );
    if (!order?.restaurant_id) continue;
    await col('payments').updateOne(
      { _id: row._id },
      { $set: { restaurant_id: order.restaurant_id } }
    );
    n++;
  }
  log.info({ updated: n }, 'payments.restaurant_id backfilled');
}

async function backfillConversationsRestaurantId() {
  // conversations link to wa_account_id → whatsapp_accounts → restaurant_id.
  const cursor = col('conversations').find(
    { restaurant_id: { $exists: false } },
    { projection: { _id: 1, wa_account_id: 1 } }
  );
  let n = 0;
  while (await cursor.hasNext()) {
    const row = await cursor.next();
    const acct = await col('whatsapp_accounts').findOne(
      { _id: row.wa_account_id },
      { projection: { restaurant_id: 1 } }
    );
    if (!acct?.restaurant_id) continue;
    await col('conversations').updateOne(
      { _id: row._id },
      { $set: { restaurant_id: acct.restaurant_id } }
    );
    n++;
  }
  log.info({ updated: n }, 'conversations.restaurant_id backfilled');
}

async function backfillMessagesRestaurantId() {
  // messages already carries business_id (== restaurant_id in this codebase).
  const res = await col('messages').updateMany(
    { restaurant_id: { $exists: false }, business_id: { $exists: true, $ne: null } },
    [{ $set: { restaurant_id: '$business_id' } }]  // aggregation-pipeline update
  );
  log.info({ matched: res.matchedCount, modified: res.modifiedCount }, 'messages.restaurant_id backfilled');
}

async function backfillCustomerProfiles() {
  // If a customers row still carries legacy total_orders / total_spent_rs,
  // we can't know WHICH tenant those belong to without order history.
  // Instead, rebuild customer_profiles from orders: one row per
  // (restaurant_id, customer_id) with aggregated totals.
  const pipeline = [
    { $match: { restaurant_id: { $exists: true, $ne: null }, customer_id: { $exists: true, $ne: null } } },
    {
      $group: {
        _id: { restaurant_id: '$restaurant_id', customer_id: '$customer_id' },
        total_orders:   { $sum: 1 },
        total_spent_rs: { $sum: { $ifNull: ['$total_rs', 0] } },
        last_order_at:  { $max: '$created_at' },
      },
    },
  ];
  const rows = await col('orders').aggregate(pipeline).toArray();
  log.info({ count: rows.length }, 'Rebuilding customer_profiles from orders');

  const now = new Date();
  let n = 0;
  for (const r of rows) {
    await col('customer_profiles').updateOne(
      { restaurant_id: r._id.restaurant_id, customer_id: r._id.customer_id },
      {
        $setOnInsert: {
          _id: newId(),
          restaurant_id: r._id.restaurant_id,
          customer_id: r._id.customer_id,
          preferences: {},
          created_at: now,
        },
        $set: {
          total_orders: r.total_orders,
          total_spent_rs: Math.round(r.total_spent_rs * 100) / 100,
          last_order_at: r.last_order_at,
          updated_at: now,
        },
      },
      { upsert: true }
    );
    n++;
  }
  log.info({ upserted: n }, 'customer_profiles backfill complete');
}

async function main() {
  await connect();
  log.info('Phase 1 migration starting');

  await dropLegacyRetailerIdIndex();
  await backfillOrderItemsRestaurantId();
  await backfillPaymentsRestaurantId();
  await backfillConversationsRestaurantId();
  await backfillMessagesRestaurantId();
  await backfillCustomerProfiles();

  log.info('Running ensureIndexes() to create Phase 1 indexes');
  await ensureIndexes();

  log.info('Phase 1 migration complete');
  process.exit(0);
}

main().catch((err) => {
  log.error({ err }, 'Phase 1 migration failed');
  process.exit(1);
});
