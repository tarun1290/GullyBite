#!/usr/bin/env node
// migrate-admin-rbac.js
// One-time migration: stamp role/cities/is_active on every admin_users
// document so the new RBAC enum (super_admin | city_ops | sales) is
// satisfied. Existing legacy 'admin' rows get normalized to super_admin
// per spec — every pre-existing operator keeps full access.
//
// Idempotent: re-running just re-sets the same values.

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), quiet: true });

const { connect, col } = require('../src/config/database');

async function main() {
  await connect();

  const before = await col('admin_users').countDocuments({});
  const result = await col('admin_users').updateMany(
    {},
    { $set: { role: 'super_admin', cities: [], is_active: true } }
  );

  console.log(`admin_users total:     ${before}`);
  console.log(`matched:               ${result.matchedCount}`);
  console.log(`modified:              ${result.modifiedCount}`);

  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
