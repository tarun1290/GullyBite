#!/usr/bin/env node
'use strict';

// scripts/migrate-reactivation-to-winback-long.js
//
// One-shot migration: $rename auto_journey_config.reactivation →
// .winback_long. Run AFTER deploying the rename in services/journeyExecutor.js
// + jobs/autoJourneyRunner.js + schemas/collections.js + routes/auth.js +
// routes/autoJourneys.js so the new key is what the journey executor reads.
//
// MUTATES DATA. Run audit-journey-configs.js first to verify scope:
//   - "Has reactivation" tells you matchedCount.
//   - "Has BOTH" must be 0 — otherwise $rename will drop the existing
//     winback_long value and overwrite it with reactivation's value.
//
// Idempotent: re-running on a collection where every doc has already been
// migrated returns matchedCount: 0, modifiedCount: 0 (the filter
// {reactivation: {$exists: true}} matches nothing).
//
// Usage on EC2:
//   node --env-file=/home/ubuntu/GullyBite/.env backend/scripts/migrate-reactivation-to-winback-long.js
//
// Reads:  process.env.MONGODB_URI, process.env.MONGODB_DB
// Writes: auto_journey_config rows where reactivation exists.

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

    const result = await col.updateMany(
      { reactivation: { $exists: true } },
      { $rename: { reactivation: 'winback_long' } },
    );

    console.log('────────── migration result ──────────');
    console.log(`matchedCount:  ${result.matchedCount}`);
    console.log(`modifiedCount: ${result.modifiedCount}`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('migrate-reactivation-to-winback-long failed:', err?.message || err);
  process.exit(1);
});
