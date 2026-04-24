// src/scripts/migrate-branch-assignment.js
// One-shot migration to bring existing menu_items + branches in line
// with the new branch-first schema. SAFE, idempotent, additive only.
//
// What it does:
//
// 1. menu_items:
//      - Adds `branch_ids` = [branch_id] when the legacy scalar is set.
//      - Adds `is_unassigned` = (branch_ids is empty).
//      - Leaves the original `branch_id` scalar untouched.
//
// 2. branches:
//      - Adds `is_active` = true when the field is missing, inferring from
//        legacy flags (accepts_orders !== false AND is_open !== false).
//      - DOES NOT touch fssai_number / gst_number — those must be filled
//        in through the new branch-edit flow so operators explicitly
//        supply compliance data rather than having the migration guess.
//
// 3. branch_products: not seeded. Existing menu_items already carry the
//    price_paise per branch (one row per branch), so no overrides are
//    needed. New cross-branch assignments create branch_products rows
//    at assign-time.
//
// Usage:
//   node src/scripts/migrate-branch-assignment.js           # dry run
//   node src/scripts/migrate-branch-assignment.js --apply   # write

'use strict';

require('dotenv').config({ quiet: true });
const { connect, col } = require('../config/database');
const log = require('../utils/logger').child({ component: 'migration' });

const APPLY = process.argv.includes('--apply');

async function run() {
  await connect();
  log.info({ apply: APPLY }, 'starting migration');

  // ── menu_items ──────────────────────────────────────────────
  const needsBranchIds = await col('menu_items').countDocuments({
    branch_ids: { $exists: false },
  });
  const needsUnassigned = await col('menu_items').countDocuments({
    is_unassigned: { $exists: false },
  });

  if (APPLY) {
    // Case A: legacy branch_id present → branch_ids = [branch_id], unassigned=false
    const a = await col('menu_items').updateMany(
      { branch_ids: { $exists: false }, branch_id: { $exists: true, $ne: null } },
      [{ $set: { branch_ids: ['$branch_id'], is_unassigned: false } }]
    );
    // Case B: no branch_id → branch_ids = [], unassigned=true
    const b = await col('menu_items').updateMany(
      { branch_ids: { $exists: false } },
      { $set: { branch_ids: [], is_unassigned: true } }
    );
    // Backfill is_unassigned where branch_ids already exists but flag missing
    const c = await col('menu_items').updateMany(
      { is_unassigned: { $exists: false }, branch_ids: { $size: 0 } },
      { $set: { is_unassigned: true } }
    );
    const d = await col('menu_items').updateMany(
      { is_unassigned: { $exists: false } },
      { $set: { is_unassigned: false } }
    );
    log.info({ backfilledWithLegacy: a.modifiedCount, backfilledEmpty: b.modifiedCount, flagFromEmpty: c.modifiedCount, flagFromNonEmpty: d.modifiedCount }, 'menu_items migrated');
  } else {
    log.info({ needsBranchIds, needsUnassigned }, 'menu_items DRY RUN — rows that would be touched');
  }

  // ── branches ────────────────────────────────────────────────
  const needsActive = await col('branches').countDocuments({ is_active: { $exists: false } });
  if (APPLY) {
    const e = await col('branches').updateMany(
      { is_active: { $exists: false }, accepts_orders: { $ne: false }, is_open: { $ne: false } },
      { $set: { is_active: true } }
    );
    const f = await col('branches').updateMany(
      { is_active: { $exists: false } },
      { $set: { is_active: false } }
    );
    log.info({ setActive: e.modifiedCount, setInactive: f.modifiedCount }, 'branches migrated');
  } else {
    log.info({ needsActive }, 'branches DRY RUN — rows that would be touched');
  }

  log.info('migration complete');
  process.exit(0);
}

run().catch(err => {
  log.error({ err: err.message }, 'migration failed');
  process.exit(1);
});
