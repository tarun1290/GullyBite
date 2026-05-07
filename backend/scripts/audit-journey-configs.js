#!/usr/bin/env node
'use strict';

// scripts/audit-journey-configs.js
//
// One-off READ-ONLY diagnostic for the auto_journey_config collection.
// Counts how many docs still have a 'reactivation' field vs how many
// already have 'winback_long', so the operator can decide whether to
// run a migration ($rename: { reactivation: 'winback_long' }) and how
// many docs would be touched.
//
// Usage on EC2:
//   node --env-file=/home/ubuntu/GullyBite/.env backend/scripts/audit-journey-configs.js
//
// Reads:  process.env.MONGODB_URI, process.env.MONGODB_DB
// Writes: nothing.

const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB;

async function main() {
  if (!MONGODB_URI) { console.error('FATAL: MONGODB_URI not set'); process.exit(1); }
  if (!MONGODB_DB)  { console.error('FATAL: MONGODB_DB not set');  process.exit(1); }

  const client = new MongoClient(MONGODB_URI, { ignoreUndefined: true });
  try {
    await client.connect();
    const db = client.db(MONGODB_DB);
    const col = db.collection('auto_journey_config');

    const total = await col.countDocuments({});
    const withReactivation = await col.countDocuments({ reactivation: { $exists: true } });
    const withWinbackLong  = await col.countDocuments({ winback_long: { $exists: true } });
    const both             = await col.countDocuments({
      reactivation: { $exists: true },
      winback_long: { $exists: true },
    });
    const neither          = await col.countDocuments({
      reactivation: { $exists: false },
      winback_long: { $exists: false },
    });

    console.log('────────────── auto_journey_config audit ──────────────');
    console.log(`Total documents:                      ${total}`);
    console.log(`Has 'reactivation' field:             ${withReactivation}`);
    console.log(`Has 'winback_long' field:             ${withWinbackLong}`);
    console.log(`Has BOTH (post-migration overlap):    ${both}`);
    console.log(`Has NEITHER (pre-onboarding default): ${neither}`);
    console.log('');

    // Sample 3 docs — newest first so the most recently active restaurants
    // show up. Pretty-printed for direct copy/paste into a migration plan.
    const samples = await col.find({}).sort({ updated_at: -1, created_at: -1 }).limit(3).toArray();
    console.log('────────────── sample documents (up to 3) ──────────────');
    if (samples.length === 0) {
      console.log('(no documents in collection)');
    } else {
      samples.forEach((doc, i) => {
        console.log(`\n── Sample ${i + 1} ──`);
        console.log(JSON.stringify(doc, null, 2));
      });
    }
    console.log('');
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('audit-journey-configs failed:', err?.message || err);
  process.exit(1);
});
