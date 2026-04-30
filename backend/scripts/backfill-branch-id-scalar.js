#!/usr/bin/env node
'use strict';

// scripts/backfill-branch-id-scalar.js
//
// One-time backfill for the branch_id scalar invariant defined in
// services/product.service.js:
//   branch_ids[] is the canonical multi-branch list.
//   branch_id (scalar) MUST be one of branch_ids[] when branch_ids is
//   non-empty, otherwise null.
//
// Items written via the products API path (assignProductToBranch) prior
// to the writer fix could leave branch_id null/missing/stale while
// branch_ids[] held the truth. The MPM reader (services/mpmBuilder.js)
// filters on the scalar, so those items were silently invisible to MPM
// even though the catalog and customer menu showed them.
//
// Read-only DRY-RUN by default. Pass --commit to actually write.
//
// Run on EC2:
//   Dry-run:
//     cd /home/ubuntu/GullyBite/backend
//     node --env-file=/home/ubuntu/GullyBite/.env \
//          scripts/backfill-branch-id-scalar.js
//   Commit:
//     node --env-file=/home/ubuntu/GullyBite/.env \
//          scripts/backfill-branch-id-scalar.js --commit
//
// Strategy:
//   1. Pull distinct restaurant_ids from menu_items.
//   2. Per restaurant, find docs where branch_ids has at least one element
//      AND scalar branch_id is missing or not in branch_ids.
//   3. Dry-run: print per-tenant counts + a global sample of up to 10 docs.
//      Commit: bulkWrite per tenant in batches of 500, setting branch_id =
//      branch_ids[0] and bumping updated_at. Idempotent — safe to re-run.
//   4. Final summary: total affected vs total fixed.
//
// Native MongoDB driver only. No mongosh, no new dependencies.

const path = require('path');
const { connect, col } = require(path.join(__dirname, '..', 'src', 'config', 'database'));

const COMMIT = process.argv.includes('--commit');
const SAMPLE_LIMIT = 10;
const BATCH_SIZE = 500;

function fmtBranchIds(arr) {
  if (!Array.isArray(arr)) return '(missing)';
  if (!arr.length) return '[]';
  return JSON.stringify(arr);
}

// Filter for the invariant violation, scoped to one restaurant. The
// $expr/$in pair handles both "scalar missing" (which evaluates to null in
// $expr context, and null is not in branch_ids) AND "scalar present but
// not in branch_ids" — a single condition that's idempotent on the
// already-fixed docs.
//
// `$ifNull: ['$branch_ids', []]` guards against multiplanner errors on
// docs that are missing branch_ids entirely. The `'branch_ids.0': $exists`
// filter narrows the doc set before evaluation, but the multiplanner
// still probes $expr against arbitrary candidates and fails hard if $in
// receives `missing` instead of an array.
function violationFilter(restaurantId) {
  return {
    restaurant_id: String(restaurantId),
    'branch_ids.0': { $exists: true },
    $expr: {
      $not: {
        $in: ['$branch_id', { $ifNull: ['$branch_ids', []] }],
      },
    },
  };
}

(async () => {
  let exitCode = 0;
  try {
    await connect();

    console.log(`MODE: ${COMMIT ? 'COMMIT (writes will happen)' : 'DRY-RUN (no writes)'}`);
    console.log(`Started at: ${new Date().toISOString()}\n`);

    // Distinct tenant list. Iterating per-tenant matches the codebase's
    // tenant-scoped-write convention — keeps a stray query change from
    // ever going cross-tenant by accident.
    const tenants = (await col('menu_items').distinct('restaurant_id')).filter(Boolean);
    console.log(`Found ${tenants.length} distinct restaurant_id(s).`);

    let totalAffected = 0;
    let totalFixed = 0;
    const samples = [];
    const perTenant = [];

    for (const restaurantId of tenants) {
      const filter = violationFilter(restaurantId);
      const docs = await col('menu_items')
        .find(filter)
        .project({ _id: 1, branch_id: 1, branch_ids: 1, restaurant_id: 1, name: 1 })
        .toArray();
      if (!docs.length) continue;

      totalAffected += docs.length;
      perTenant.push({ restaurantId, count: docs.length });

      // Pull samples until we hit the global cap. Sample order doesn't
      // matter for diagnostic value — first-seen across tenants is fine.
      for (const d of docs) {
        if (samples.length >= SAMPLE_LIMIT) break;
        samples.push(d);
      }

      if (COMMIT) {
        const now = new Date();
        let batch = [];
        let modifiedThisTenant = 0;
        for (const d of docs) {
          const newScalar = String(d.branch_ids[0]);
          batch.push({
            updateOne: {
              // Pin restaurant_id in the filter — defence in depth in case
              // a future change to violationFilter ever drops the tenant
              // scope.
              filter: { _id: d._id, restaurant_id: String(restaurantId) },
              update: { $set: { branch_id: newScalar, updated_at: now } },
            },
          });
          if (batch.length >= BATCH_SIZE) {
            const r = await col('menu_items').bulkWrite(batch, { ordered: false });
            const m = r.modifiedCount || 0;
            modifiedThisTenant += m;
            totalFixed += m;
            console.log(`  restaurant_id=${restaurantId}: flushed batch (${batch.length} ops, modified=${m})`);
            batch = [];
          }
        }
        if (batch.length) {
          const r = await col('menu_items').bulkWrite(batch, { ordered: false });
          const m = r.modifiedCount || 0;
          modifiedThisTenant += m;
          totalFixed += m;
          console.log(`  restaurant_id=${restaurantId}: flushed final batch (${batch.length} ops, modified=${m})`);
        }
        console.log(`  restaurant_id=${restaurantId}: ${modifiedThisTenant} fixed`);
      } else {
        console.log(`  restaurant_id=${restaurantId}: ${docs.length} affected (dry-run, no write)`);
      }
    }

    console.log(`\n── SAMPLE (up to ${SAMPLE_LIMIT}) ────────────────────────────`);
    if (!samples.length) {
      console.log('  (no affected docs)');
    } else {
      for (const s of samples) {
        const cur = s.branch_id == null ? '(null/missing)' : String(s.branch_id);
        console.log(`  _id=${s._id}  name="${s.name || ''}"`);
        console.log(`    current branch_id : ${cur}`);
        console.log(`    branch_ids[]      : ${fmtBranchIds(s.branch_ids)}`);
        console.log(`    will set scalar to: ${Array.isArray(s.branch_ids) && s.branch_ids[0] ? String(s.branch_ids[0]) : '(none)'}`);
      }
    }

    console.log(`\n── SUMMARY ────────────────────────────────────────────────`);
    console.log(`  Total affected docs across ${tenants.length} tenants: ${totalAffected}`);
    if (COMMIT) {
      console.log(`  Total fixed (modifiedCount): ${totalFixed}`);
      if (totalFixed !== totalAffected) {
        console.log(`  ⚠ Affected (${totalAffected}) ≠ fixed (${totalFixed}). Re-run to verify.`);
      } else {
        console.log('  ✓ All affected docs were updated.');
      }
    } else {
      console.log('  DRY-RUN complete. Re-run with --commit to apply.');
    }
  } catch (err) {
    console.error('[backfill] ERROR:', err && err.message ? err.message : err);
    exitCode = 1;
  } finally {
    try { await globalThis._mongoClient?.close(); } catch (_) { /* ignore */ }
    process.exit(exitCode);
  }
})();
