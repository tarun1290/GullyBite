#!/usr/bin/env node
'use strict';

// migrate-pending-payment-to-approval.js
//
// One-time migration for the branch-onboarding refactor (Prompt 2).
// The `pending_payment` subscription_status (Razorpay-gated onboarding)
// is replaced by `pending_approval` (admin-gated onboarding). Two legacy
// shapes must move to the new state:
//
//   1. subscription_status === 'pending_payment'  (explicit legacy value)
//   2. subscription_status null / undefined / absent (older branches
//      created before the field existed — these were effectively
//      unpaywalled; under the new model they require admin approval too)
//
// Each migrated branch is stamped:
//   migrated_from_pending_payment: true
//   migrated_at: <Date>
//   migration_source: 'pending_payment' | 'null'
//
// Idempotent: after a successful run no branch is in 'pending_payment'
// and none has a null/absent subscription_status, so a re-run migrates 0
// of each. Active / paused / force_paused branches are never touched.
//
// Usage (EC2):
//   node --env-file=/home/ubuntu/GullyBite/.env backend/scripts/migrate-pending-payment-to-approval.js
//
// DO NOT auto-run. Tarun executes this manually after deploy.

const { MongoClient } = require('mongodb');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('ERROR: MONGODB_URI not set. Did you pass --env-file=...?');
    process.exit(1);
  }

  const client = await MongoClient.connect(uri);
  try {
    const branches = client.db('gullybite').collection('branches');

    // ── Case 1: explicit legacy 'pending_payment' ──────────────
    const ppFilter = { subscription_status: 'pending_payment' };
    const ppSample = await branches
      .find(ppFilter, { projection: { _id: 1 } })
      .limit(10)
      .toArray();
    const ppRes = await branches.updateMany(ppFilter, {
      $set: {
        subscription_status: 'pending_approval',
        migrated_from_pending_payment: true,
        migrated_at: new Date(),
        migration_source: 'pending_payment',
      },
    });

    // ── Case 2: null / undefined / absent subscription_status ──
    // { field: null } already matches missing fields in MongoDB; the
    // explicit $exists:false arm is kept for clarity / belt-and-braces.
    const nullFilter = {
      $or: [
        { subscription_status: null },
        { subscription_status: { $exists: false } },
      ],
    };
    const nullSample = await branches
      .find(nullFilter, { projection: { _id: 1 } })
      .limit(10)
      .toArray();
    const nullRes = await branches.updateMany(nullFilter, {
      $set: {
        subscription_status: 'pending_approval',
        migrated_from_pending_payment: true,
        migrated_at: new Date(),
        migration_source: 'null',
      },
    });

    console.log('── migrate-pending-payment-to-approval ──');
    console.log('Case 1 — pending_payment:');
    console.log('  matched:  ', ppRes.matchedCount);
    console.log('  modified: ', ppRes.modifiedCount);
    console.log('  sample _ids:', ppSample.map((b) => b._id));
    console.log('Case 2 — null/absent subscription_status:');
    console.log('  matched:  ', nullRes.matchedCount);
    console.log('  modified: ', nullRes.modifiedCount);
    console.log('  sample _ids:', nullSample.map((b) => b._id));
    console.log('Total migrated:', ppRes.modifiedCount + nullRes.modifiedCount);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
