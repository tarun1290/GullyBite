'use strict';

// 2026-05-12-backfill-variant-restaurant-id.js
//
// One-shot backfill: stamp `restaurant_id` on every `menu_items` document
// that has an `item_group_id` but is missing `restaurant_id`. The value
// is copied from any sibling row in the same `item_group_id` family that
// already carries `restaurant_id`.
//
// WHY
// ---
// POST /api/restaurant/menu/variant (backend/src/routes/restaurant.js,
// the variant upsert handler) inserted documents whose `$setOnInsert`
// block was missing `restaurant_id`. Every variant created via that
// codepath therefore landed in `menu_items` without a tenant tag, even
// though every read in the variants surface (e.g. GET /menu/variants/
// :itemGroupId) explicitly pins `restaurant_id` for tenant safety.
// Part 6d patches the upsert in place AND backfills the historical rows
// via this script — the upsert fix is the ongoing protection, this is
// the one-time cleanup.
//
// There is no `variant_of` or `parent_item_id` field on `menu_items`;
// variants are a flat namespace under `item_group_id`. Any sibling in
// the same `item_group_id` whose `restaurant_id` is set can serve as
// the source — they all belong to the same restaurant by construction
// (item_group_id is allocated per-restaurant by the dashboard menu
// editor and is never shared cross-tenant).
//
// MODE TOGGLE
// -----------
// const BATCH_MODE = false;  // single-sweep — DEFAULT. Use when Atlas count is 1–1000.
// const BATCH_MODE = true;   // batched.       Use when Atlas count > 1000.
//
// Single-sweep loads all candidates into memory and processes in one
// linear loop. Cleanest, safest, no inter-batch state to reason about.
// Right for the default 1–1000 cardinality.
//
// Batched repeatedly runs `find(filter).limit(200).toArray()` in a
// `while` loop, sleeping 50ms between iterations, exiting when the
// batch is empty. The 50ms cadence keeps Atlas IOPS within steady-state
// during business hours so a long migration doesn't impact live menu
// reads. Orphan IDs (docs whose item_group_id has no sibling with
// restaurant_id) are tracked in an in-memory Set and excluded from
// subsequent batch queries via $nin — without this, the same orphans
// would be re-fetched on every iteration and the loop would never
// terminate.
//
// Run the Atlas diagnostic before flipping the flag:
//   db.menu_items.countDocuments({
//     item_group_id: { $exists: true, $ne: null },
//     restaurant_id: { $exists: false },
//   })
// 0          → no run needed.
// 1–1000     → BATCH_MODE = false (default).
// > 1000     → flip BATCH_MODE = true, then run.
//
// HOW TO RUN
// ----------
// On EC2 (production):
//   node --env-file=/home/ubuntu/GullyBite/.env backend/scripts/2026-05-12-backfill-variant-restaurant-id.js
//
// Locally (against staging or a copy):
//   node --env-file=.env backend/scripts/2026-05-12-backfill-variant-restaurant-id.js
//
// IDEMPOTENCY
// -----------
// The selection filter `restaurant_id: { $exists: false }` only matches
// docs that still need fixing, so a second run is a no-op (zero rows
// will be re-examined). Sibling lookup re-uses any row with
// restaurant_id set, which after a first successful sweep includes the
// newly-stamped variants — but they're filtered out of the candidate
// set before the lookup runs, so we never double-write.
//
// In batched mode, the in-memory orphan set is rebuilt on each fresh
// invocation. A re-run after a partial backfill picks up only the
// remaining un-stamped docs (orphans included); orphan handling is
// per-row idempotent (the warn log fires again, no DB write happens).
//
// EXIT CODES
// ----------
// 0 on success (including when no docs needed updating).
// 1 on any connect / op error.

const { connect, close, col } = require('../src/config/database');

// ─── Mode toggle ────────────────────────────────────────────
const BATCH_MODE = false;        // ← flip to true if Atlas count > 1000
const BATCH_SIZE = 200;
const BATCH_SLEEP_MS = 50;

// ─── Shared query bits ──────────────────────────────────────
const SELECT_FILTER = {
  item_group_id: { $exists: true, $ne: null },
  restaurant_id: { $exists: false },
};
const PROJECTION = { _id: 1, item_group_id: 1 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Per-row processing (shared by both modes) ──────────────
//
// Returns one of:
//   'modified' — restaurant_id was successfully stamped onto this row
//   'noop'     — sibling found but updateOne reported modifiedCount === 0
//                (race with a concurrent write, idempotent re-stamp, etc.)
//   'orphan'   — no sibling in the same item_group_id has restaurant_id;
//                row is logged via `event: 'orphan_skipped'` and left
//                untouched. Caller in batched mode should add this _id
//                to the in-memory exclusion set so the next batch query
//                doesn't re-fetch it.
//   'error'    — a per-row Mongo / driver error fired; logged via
//                `event: 'row_error'`. Caller adds to errors counter.
//
// All branches are non-throwing — the outer driver loop continues.
async function processVariant(variant) {
  try {
    // First sibling in the same item_group_id family that DOES have
    // restaurant_id wins. Within an item_group_id every doc that has
    // restaurant_id has the SAME restaurant_id (item_group_id is
    // per-restaurant by construction), so picking any one is safe.
    const sibling = await col('menu_items').findOne(
      {
        item_group_id: variant.item_group_id,
        restaurant_id: { $exists: true },
      },
      { projection: { restaurant_id: 1 } },
    );

    if (!sibling || !sibling.restaurant_id) {
      // eslint-disable-next-line no-console
      console.warn(
        JSON.stringify({
          event: 'orphan_skipped',
          _id: variant._id,
          item_group_id: variant.item_group_id,
          reason: 'no sibling with restaurant_id — manual triage',
        }),
      );
      return 'orphan';
    }

    const result = await col('menu_items').updateOne(
      { _id: variant._id },
      { $set: { restaurant_id: sibling.restaurant_id } },
    );
    const modified = result.modifiedCount ?? result.modified ?? 0;
    return modified > 0 ? 'modified' : 'noop';
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        event: 'row_error',
        _id: variant._id,
        item_group_id: variant.item_group_id,
        err: err && err.message ? err.message : String(err),
      }),
    );
    return 'error';
  }
}

// ─── Mode A: single-sweep ───────────────────────────────────
async function runSingleSweep(summary) {
  // Snapshot the candidate set up front so the loop iterates over a
  // stable list. Cursor-style streaming would be fine too, but at the
  // assumed cardinality (<1000) loading the array is cheaper to reason
  // about and keeps the orphan/skip log simple.
  const candidates = await col('menu_items').find(
    SELECT_FILTER,
    { projection: PROJECTION },
  ).toArray();

  summary.matched = candidates.length;

  for (const variant of candidates) {
    const status = await processVariant(variant);
    if (status === 'modified') summary.modified += 1;
    else if (status === 'orphan') summary.skipped += 1;
    else if (status === 'error') summary.errors += 1;
    // 'noop' is silent.
  }
}

// ─── Mode B: batched (200/iter, 50ms sleep) ─────────────────
async function runBatched(summary) {
  // Orphan IDs accumulate across batches and are excluded from
  // subsequent find()s via $nin. Without this, an orphan would
  // re-appear in every batch's candidate slice and the while loop
  // would never reach an empty batch.
  const orphanIds = [];
  let batchNum = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const filter = orphanIds.length
      ? { ...SELECT_FILTER, _id: { $nin: orphanIds } }
      : SELECT_FILTER;

    const batch = await col('menu_items').find(
      filter,
      { projection: PROJECTION },
    ).limit(BATCH_SIZE).toArray();

    if (batch.length === 0) break;

    batchNum += 1;
    summary.matched += batch.length;

    for (const variant of batch) {
      const status = await processVariant(variant);
      if (status === 'modified') summary.modified += 1;
      else if (status === 'orphan') {
        summary.skipped += 1;
        orphanIds.push(variant._id);
      } else if (status === 'error') summary.errors += 1;
    }

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        event: 'batch_done',
        batch: batchNum,
        totalFixed: summary.modified,
        totalOrphans: summary.skipped,
      }),
    );

    await sleep(BATCH_SLEEP_MS);
  }
}

// ─── Driver ─────────────────────────────────────────────────
(async () => {
  const summary = { matched: 0, modified: 0, skipped: 0, errors: 0 };
  try {
    await connect();
    if (BATCH_MODE) {
      await runBatched(summary);
    } else {
      await runSingleSweep(summary);
    }
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary));
    await close();
    process.exit(0);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Backfill failed:', err && err.message ? err.message : err);
    // eslint-disable-next-line no-console
    console.error('Partial summary:', JSON.stringify(summary));
    try { await close(); } catch (_) { /* ignore */ }
    process.exit(1);
  }
})();
