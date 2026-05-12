#!/usr/bin/env node
// migrate-restaurants-captain.js
// One-time migration: stamp the City Captain restaurant fields
// (business_type, parent_kitchen_id, delivery_zones, gbref_commission_rate)
// onto every restaurants doc that doesn't already have business_type set.
//
// Idempotent — restaurants already migrated (business_type present) are
// skipped by the filter.

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), quiet: true });

const { connect, col } = require('../src/config/database');

async function main() {
  await connect();

  const result = await col('restaurants').updateMany(
    { business_type: { $exists: false } },
    {
      $set: {
        business_type: 'physical',
        parent_kitchen_id: null,
        delivery_zones: [],
        gbref_commission_rate: null,
      },
    }
  );

  console.log({ matched: result.matchedCount, modified: result.modifiedCount });

  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
