#!/usr/bin/env node
'use strict';

// scripts/dupe-check-pre-index.js
//
// One-off READ-ONLY pre-flight: detects existing duplicate data that
// would make the three new UNIQUE/partial indexes (config/indexes.js)
// fail to build with E11000. Connects directly via the MongoDB driver —
// no business-code services loaded — so it stays safe to run against
// prod from the EC2 host. PERFORMS NO WRITES (aggregate/count only).
//
// Usage on EC2:
//   cd /home/ubuntu/GullyBite
//   node --env-file=/home/ubuntu/GullyBite/.env backend/scripts/dupe-check-pre-index.js
//
// Reads:  process.env.MONGODB_URI, process.env.MONGODB_DB
// Writes: nothing.
// Delete after use if you prefer; it is side-effect free.

const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB;

function head(label) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log(label);
  console.log('══════════════════════════════════════════════════════');
}

async function main() {
  if (!MONGODB_URI) { console.error('FATAL: MONGODB_URI not set in environment'); process.exit(1); }
  if (!MONGODB_DB) { console.error('FATAL: MONGODB_DB not set in environment'); process.exit(1); }

  const client = new MongoClient(MONGODB_URI, { ignoreUndefined: false });
  try {
    await client.connect();
    const db = client.db(MONGODB_DB);
    console.log(`Connected: db='${MONGODB_DB}' (READ-ONLY dupe pre-flight)`);

    // ── 1. dine_in_visits ────────────────────────────────────────
    // The new index is UNIQUE and NOT sparse on the LITERAL key
    // { restaurant_id, branch_id, customer_id, visit_date }. Group by
    // exactly that key (a missing visit_date sorts as null and still
    // collides under a non-sparse unique index — the most likely
    // legacy failure, which a "visit_date as ISODate" view would hide).
    head("1. dine_in_visits — duplicates on the LITERAL unique-index key");
    const div = db.collection('dine_in_visits');
    const divTotal = await div.estimatedDocumentCount();
    const divMissingVisitDate = await div.countDocuments({
      $or: [{ visit_date: { $exists: false } }, { visit_date: null }],
    });
    const divDupes = await div.aggregate([
      { $group: {
          _id: { restaurant_id: '$restaurant_id', branch_id: '$branch_id', customer_id: '$customer_id', visit_date: '$visit_date' },
          count: { $sum: 1 },
        } },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray();
    console.log(`total docs in collection:            ${divTotal}`);
    console.log(`docs MISSING/null visit_date:        ${divMissingVisitDate}  <-- all collide under the non-sparse unique index if >1 share (restaurant,branch,customer)`);
    console.log(`duplicate groups (count > 1):        ${divDupes.length}`);
    divDupes.slice(0, 5).forEach((g, i) =>
      console.log(`  sample ${i + 1}: ${JSON.stringify(g._id)}  count=${g.count}`));

    // Logical "same calendar day" view (the business question) — uses
    // visit_date when present, else created_at truncated to a UTC day.
    const divSameDay = await div.aggregate([
      { $addFields: {
          _day: {
            $ifNull: [
              '$visit_date',
              { $dateToString: { format: '%Y-%m-%d', date: '$created_at', onNull: null } },
            ],
          },
        } },
      { $group: {
          _id: { restaurant_id: '$restaurant_id', branch_id: '$branch_id', customer_id: '$customer_id', day: '$_day' },
          count: { $sum: 1 },
        } },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray();
    console.log(`\n[logical same-day view] duplicate groups (visit_date OR created_at→day): ${divSameDay.length}`);
    divSameDay.slice(0, 5).forEach((g, i) =>
      console.log(`  sample ${i + 1}: ${JSON.stringify(g._id)}  count=${g.count}`));

    // ── 2. loyalty_transactions ──────────────────────────────────
    // Index is unique + SPARSE on { restaurant_id, customer_id, order_id, type }.
    // Sparse skips docs missing the key fields (manual credits w/ null
    // order_id); the collision risk is real order-linked accrual dupes.
    head("2. loyalty_transactions — duplicate order accruals (order_id not null)");
    const lt = db.collection('loyalty_transactions');
    const ltDupes = await lt.aggregate([
      { $match: { order_id: { $ne: null } } },
      { $group: {
          _id: { restaurant_id: '$restaurant_id', customer_id: '$customer_id', order_id: '$order_id', type: '$type' },
          count: { $sum: 1 },
        } },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray();
    console.log(`duplicate groups (count > 1):        ${ltDupes.length}`);
    ltDupes.slice(0, 5).forEach((g, i) =>
      console.log(`  sample ${i + 1}: ${JSON.stringify(g._id)}  count=${g.count}`));

    // ── 3. referrals ─────────────────────────────────────────────
    // Index is partial-unique on { customer_id, restaurant_id } where
    // status='active'. Only active rows participate.
    head("3. referrals — customers with >1 ACTIVE referral per restaurant");
    const ref = db.collection('referrals');
    const refDupes = await ref.aggregate([
      { $match: { status: 'active' } },
      { $group: {
          _id: { customer_id: '$customer_id', restaurant_id: '$restaurant_id' },
          count: { $sum: 1 },
        } },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray();
    console.log(`duplicate groups (count > 1):        ${refDupes.length}`);
    refDupes.slice(0, 5).forEach((g, i) =>
      console.log(`  sample ${i + 1}: ${JSON.stringify(g._id)}  count=${g.count}`));

    // ── VERDICT ──────────────────────────────────────────────────
    head('VERDICT (will the unique index builds succeed?)');
    const divBlocked = divDupes.length > 0 || divMissingVisitDate > 1;
    console.log(`dine_in_visits unique index : ${divBlocked ? 'WILL FAIL — clean dupes/missing visit_date first' : 'OK to build'}`);
    console.log(`loyalty_transactions unique : ${ltDupes.length > 0 ? 'WILL FAIL — clean dupes first' : 'OK to build'}`);
    console.log(`referrals partial-unique    : ${refDupes.length > 0 ? 'WILL FAIL — resolve multi-active first' : 'OK to build'}`);
    console.log('\n(Read-only pre-flight complete. No documents were modified.)');
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('dupe-check-pre-index failed:', err?.message || err);
  process.exit(1);
});
