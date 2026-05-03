#!/usr/bin/env node
'use strict';

// scripts/backfill-reset-stale-conversations.js
//
// One-shot backfill that complements the transitionOrder fix in
// core/orderStateEngine.js. The runtime fix only covers NEW terminal
// transitions going forward; existing conversations whose
// active_order_id still points at a CANCELLED / EXPIRED /
// REJECTED_BY_RESTAURANT / RESTAURANT_TIMEOUT / PAYMENT_FAILED order
// keep showing the customer in the Incomplete Orders / dropoff
// analytics. This script resets those conversations in bulk:
//   state            ← 'GREETING'      (codebase's idle state)
//   active_order_id  ← null            (analytics' hasOrder check resolves to null)
//   updated_at       ← now
//
// Dry-run by default — prints the orders/conversations counts and a
// preview before touching anything. Pass --commit to actually write.
//
// Usage on EC2:
//   cd /home/ubuntu/GullyBite/backend
//   # Dry run first (safe, read-only):
//   node --env-file=/home/ubuntu/GullyBite/.env scripts/backfill-reset-stale-conversations.js
//   # Then commit:
//   node --env-file=/home/ubuntu/GullyBite/.env scripts/backfill-reset-stale-conversations.js --commit
//
// Idempotent: re-running after a successful commit finds no
// conversations to update (active_order_id is already null) and exits
// with zero changes.

const { MongoClient } = require('mongodb');

const TERMINAL_FAILURE_STATUSES = [
  'EXPIRED',
  'CANCELLED',
  'REJECTED_BY_RESTAURANT',
  'RESTAURANT_TIMEOUT',
  'PAYMENT_FAILED',
];

const PREVIEW_LIMIT = 5;

function parseArgs(argv) {
  return {
    commit: argv.includes('--commit'),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI not set — pass via --env-file');
    process.exit(1);
  }

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db('gullybite');
  console.log('[backfill] mongo connected: gullybite');
  console.log(`[backfill] mode: ${args.commit ? 'COMMIT (will write)' : 'DRY-RUN (no writes)'}`);

  // 1. Collect ids of orders in terminal-failure statuses. We only need
  //    _id — keep the projection tight so this works even on large
  //    collections without paging.
  const orderIds = await db.collection('orders')
    .find({ status: { $in: TERMINAL_FAILURE_STATUSES } })
    .project({ _id: 1 })
    .toArray()
    .then((rows) => rows.map((r) => r._id));

  console.log(`[backfill] terminal-failure orders found: ${orderIds.length}`);
  if (orderIds.length === 0) {
    console.log('[backfill] nothing to backfill — exiting');
    await client.close();
    process.exit(0);
  }

  // 2. Count conversations that reference one of those orders AND still
  //    have a non-null active_order_id (i.e., haven't been reset yet).
  //    Idempotency baked in: a re-run after commit finds zero matches.
  const matchFilter = { active_order_id: { $in: orderIds } };
  const affected = await db.collection('conversations').countDocuments(matchFilter);
  console.log(`[backfill] conversations to reset: ${affected}`);

  if (affected === 0) {
    console.log('[backfill] no conversations need reset (already idempotent or never referenced) — exiting');
    await client.close();
    process.exit(0);
  }

  // 3. Print a small preview so the operator can sanity-check what's
  //    about to change before passing --commit.
  const preview = await db.collection('conversations')
    .find(matchFilter)
    .project({ _id: 1, state: 1, active_order_id: 1, last_msg_at: 1 })
    .limit(PREVIEW_LIMIT)
    .toArray();
  console.log(`[backfill] preview (first ${preview.length} of ${affected}):`);
  for (const c of preview) {
    console.log(`  - conv=${c._id} state=${c.state || '(null)'} active_order_id=${c.active_order_id} last_msg_at=${c.last_msg_at?.toISOString?.() || c.last_msg_at}`);
  }

  if (!args.commit) {
    console.log('');
    console.log('[backfill] DRY-RUN complete — re-run with --commit to perform the writes.');
    await client.close();
    process.exit(0);
  }

  // 4. Commit. Single updateMany — same payload as the runtime fix in
  //    core/orderStateEngine.js so behavior matches exactly.
  const now = new Date();
  const result = await db.collection('conversations').updateMany(
    matchFilter,
    { $set: { state: 'GREETING', active_order_id: null, updated_at: now } },
  );
  console.log(`[backfill] updateMany done: matched=${result.matchedCount} modified=${result.modifiedCount}`);

  await client.close();
  console.log('[backfill] done');
}

main().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error('[backfill] FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
