#!/usr/bin/env node
// scripts/backfill-branch-login-urls.js
//
// One-shot backfill: stamp staff_access_token + staff_access_token_generated_at
// on every branch that's missing them. Branches created before the
// auto-seed in routes/restaurant.js (POST /branches) carry no token,
// which breaks the GET /branches/:branchId/staff-link endpoint and the
// staff app's /staff/<token> route. This script makes those branches
// usable without an operator clicking "Generate" per branch.
//
// The actual staff_login_url is computed on read by routes/restaurant.js
// from FRONTEND_URL + staff_access_token, so we only need to persist
// the token + timestamp here. No URL is stored in the DB — the
// env-driven base lets dev/staging/prod reuse the same DB row.
//
// Usage (either form works — both wire env before script logic runs):
//   node scripts/backfill-branch-login-urls.js
//   node --env-file=/home/ubuntu/GullyBite/.env scripts/backfill-branch-login-urls.js
//
// No mongosh, no Mongoose. Native MongoDB driver only.

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const { MongoClient } = require('mongodb');
const crypto = require('crypto');

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error('FATAL: MONGODB_URI is not set');
    process.exit(1);
  }

  const client = await MongoClient.connect(process.env.MONGODB_URI);
  const db = client.db(process.env.MONGODB_DB || 'gullybite');
  const branches = db.collection('branches');

  try {
    // Match rows that are missing the field outright OR have a null/empty
    // value. Keep is_active out of the filter so soft-deleted branches
    // are also patched — saves a follow-up run if a branch is reactivated.
    const candidates = await branches
      .find(
        {
          $or: [
            { staff_access_token: { $exists: false } },
            { staff_access_token: null },
            { staff_access_token: '' },
          ],
        },
        { projection: { _id: 1, restaurant_id: 1, name: 1 } },
      )
      .toArray();

    if (candidates.length === 0) {
      console.log('No branches missing staff_access_token — nothing to do.');
      return;
    }

    console.log(`Found ${candidates.length} branch(es) missing staff_access_token. Patching...\n`);

    let patched = 0;
    const failed = [];

    for (const b of candidates) {
      const token = crypto.randomUUID();
      const now = new Date();
      try {
        // Conditional filter — never overwrite an already-set token in
        // case a parallel run of this script (or the GET /staff-link
        // /generate endpoint) populated the field between the find and
        // the update. The $or mirrors the find shape.
        const res = await branches.updateOne(
          {
            _id: b._id,
            $or: [
              { staff_access_token: { $exists: false } },
              { staff_access_token: null },
              { staff_access_token: '' },
            ],
          },
          { $set: { staff_access_token: token, staff_access_token_generated_at: now, updated_at: now } },
        );
        if (res.modifiedCount === 1) {
          patched++;
          console.log(`  ✓ ${b.name || '(unnamed)'}  (${b._id})`);
        } else {
          // Token landed via another path between find and update — not
          // a failure, just a no-op race.
          console.log(`  · ${b.name || '(unnamed)'}  (${b._id})  — already set, skipped`);
        }
      } catch (err) {
        failed.push({ branchId: b._id, name: b.name, error: err?.message || String(err) });
        console.error(`  ✗ ${b.name || '(unnamed)'}  (${b._id})  — ${err?.message || err}`);
      }
    }

    console.log(`\nPatched ${patched}/${candidates.length} branch(es).`);
    if (failed.length) {
      console.log(`\nFailures (${failed.length}):`);
      for (const f of failed) console.log(`  - ${f.branchId}  ${f.name}  :: ${f.error}`);
      process.exitCode = 1;
    }
  } finally {
    await client.close();
  }
})().catch((err) => {
  console.error('FATAL:', err?.message || err);
  process.exit(1);
});
