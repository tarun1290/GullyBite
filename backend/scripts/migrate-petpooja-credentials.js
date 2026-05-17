#!/usr/bin/env node
// migrate-petpooja-credentials.js
// One-time manual migration: strip the stored PetPooja API credentials
// (app_key, app_secret, access_token) off every restaurant_integrations
// document whose platform is 'petpooja'.
//
// This script is NOT wired into any startup / cron path. Tarun runs it by
// hand on EC2 exactly once, after the backend deploys, with:
//
//   cd /home/ubuntu/GullyBite && node --env-file=.env backend/scripts/migrate-petpooja-credentials.js
//
// It performs a SINGLE updateMany that only $unsets the three credential
// fields from petpooja rows. It is non-destructive to everything else on
// those documents — outlet_id, is_active, and any other fields are left
// untouched. No other collections are touched and there are no other
// mutations.
//
// Idempotent: $unset on absent fields is a no-op per doc, so re-running is
// safe (a second run will report modified: 0).

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), quiet: true });

const { connect, col } = require('../src/config/database');

async function main() {
  await connect();

  const result = await col('restaurant_integrations').updateMany(
    { platform: 'petpooja' },
    { $unset: { app_key: '', app_secret: '', access_token: '' } }
  );

  console.log(`[migrate-petpooja-credentials] matched:  ${result.matchedCount}`);
  console.log(`[migrate-petpooja-credentials] modified: ${result.modifiedCount}`);
  console.log(`[migrate-petpooja-credentials] done — unset app_key/app_secret/access_token on ${result.modifiedCount} petpooja row(s)`);

  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => { console.error('[migrate-petpooja-credentials] Fatal:', e); process.exit(1); });
