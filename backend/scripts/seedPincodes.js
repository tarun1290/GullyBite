#!/usr/bin/env node
// scripts/seedPincodes.js
// Seed or top-up the serviceable_pincodes collection from the Prorouting
// CSV at data/serviceable_pincodes.csv (repo root).
//
// IDEMPOTENT: uses $setOnInsert, so re-running never overrides admin
// toggles. Safe to run after a manual CSV refresh.
//
// Usage:  node backend/scripts/seedPincodes.js
// Env:    MONGODB_URI  (same as the main app)

'use strict';

const path = require('path');
const fs = require('fs');

const ServiceablePincode = require('../src/models/ServiceablePincode');
const { getCityForPincode } = require('../src/utils/pincodeCityMap');
const { connect, col } = require('../src/config/database');

const CSV_PATH = path.resolve(__dirname, '..', '..', 'data', 'serviceable_pincodes.csv');

function parseCsv(contents) {
  const lines = contents.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] || '').trim();
    if (!raw) continue;
    if (i === 0 && /pickup/i.test(raw)) continue;  // header row
    if (/^[1-9][0-9]{5}$/.test(raw)) out.push(raw);
  }
  return out;
}

async function run() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`[seedPincodes] CSV not found at ${CSV_PATH}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(CSV_PATH, 'utf8');
  const pincodes = parseCsv(raw);
  console.log(`[seedPincodes] Parsed ${pincodes.length} pincodes from CSV`);

  await connect();

  // Ensure the unique index exists even if config/indexes.js hasn't
  // been run yet (scripts are often invoked standalone).
  try {
    await col(ServiceablePincode.COLLECTION).createIndex(
      { pincode: 1 },
      { unique: true, name: 'pincode_1' }
    );
  } catch (_) { /* index exists — safe to ignore */ }

  let inserted = 0;
  let existed = 0;
  for (const pc of pincodes) {
    const r = await ServiceablePincode.upsertIdempotent(pc, 'Prorouting batch');
    if (r.inserted) inserted += 1;
    else existed += 1;
  }

  console.log(`[seedPincodes] Seeded ${pincodes.length} pincodes (${inserted} inserted, ${existed} already existed)`);

  // Backfill: catch any legacy documents that were inserted before the
  // city/state map existed. upsertIdempotent already $sets city/state
  // on everything in the CSV, so this only touches strays.
  const untagged = col(ServiceablePincode.COLLECTION).find({
    $or: [{ city: { $exists: false } }, { city: null }],
  });
  let backfilled = 0;
  for await (const doc of untagged) {
    const { city, state } = getCityForPincode(doc.pincode);
    await col(ServiceablePincode.COLLECTION).updateOne(
      { _id: doc._id },
      { $set: { city, state, updated_at: new Date() } }
    );
    backfilled += 1;
  }
  console.log(`[seedPincodes] Backfilled ${backfilled} documents with city/state tags`);

  process.exit(0);
}

run().catch((err) => {
  console.error('[seedPincodes] FAILED:', err);
  process.exit(1);
});
