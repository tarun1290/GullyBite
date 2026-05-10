#!/usr/bin/env node
'use strict';

// scripts/migrate-manager-permissions.js
//
// One-shot migration: stamp the new 10-key permission contract onto
// any role:'manager' row in `restaurant_users` whose `permissions`
// blob is the legacy 7-key shape (or any non-conforming shape).
//
// WHY
// ---
// The dashboard "Staff" management page operates on the new 10-key
// staff-permission contract (`view_orders, accept_orders, ...`) via
// `/api/restaurant/staff`. With Part 6d+ extending that router to
// also manage role:'manager' rows, every manager row must carry the
// new 10-key shape so the API serializer (`sanitizeStaff`) doesn't
// silently coerce missing keys to false.
//
// Manager rows created via the legacy `/api/restaurant/users` route
// got the legacy `ROLE_PERMISSIONS.manager` blob (7-key shape, e.g.
// `manage_orders`, `view_analytics`, `manage_coupons`). This script
// detects those rows and overwrites their `permissions` with the
// `branch_manager` preset's 10-key blob. Also stamps
// `role_preset: 'branch_manager'` for consistency with rows created
// via the new router.
//
// PRECONDITION (Step 0)
// ---------------------
// Run scripts/audit-staff-schema.js first to confirm whether any
// legacy-shape manager rows exist. If the audit reports zero, this
// migration is a no-op (it scans, finds nothing, exits 0).
//
// HOW TO RUN (on EC2):
//
//   cd /home/ubuntu/GullyBite/backend && \
//     node --env-file=/home/ubuntu/GullyBite/.env \
//          scripts/migrate-manager-permissions.js
//
// IDEMPOTENCY
// -----------
// Selection filter `role: 'manager'` runs the conformance check via
// `isValidPermissions()` per row. Re-running on a row that already
// passes is a no-op (the row is logged with `action: 'skipped',
// reason: 'already_conforms'` and no DB write happens).
//
// EXIT CODES
// ----------
// 0 on success (including when no rows needed migrating).
// 1 on any connect / op error.

const path = require('path');
const {
  connect,
  close,
  col,
} = require(path.join(__dirname, '..', 'src', 'config', 'database'));

// Late-require the permissions service — avoids a require cycle if
// this script is loaded from a context that hasn't finished bootstrapping.
const {
  isValidPermissions,
  permissionsFromPreset,
} = require(path.join(__dirname, '..', 'src', 'services', 'staffPermissions'));

function emit(event) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(event));
}

async function main() {
  const summary = { scanned: 0, migrated: 0, skipped: 0, errors: 0 };

  await connect();
  const c = col('restaurant_users');

  // Snapshot all manager rows up front. Cardinality is small (managers
  // are typically << staff per restaurant), so loading once is cheaper
  // than streaming a cursor.
  const managers = await c.find(
    { role: 'manager' },
    { projection: { _id: 1, restaurant_id: 1, permissions: 1, role_preset: 1 } },
  ).toArray();

  summary.scanned = managers.length;

  // Compute the new 10-key blob ONCE — every migrated row gets the
  // same `branch_manager` preset, so we don't need a per-row recompute.
  const branchManagerPerms = permissionsFromPreset('branch_manager');
  const now = new Date();

  for (const row of managers) {
    try {
      const conforms = isValidPermissions(row.permissions);
      const presetAlreadySet = row.role_preset === 'branch_manager';

      if (conforms && presetAlreadySet) {
        summary.skipped += 1;
        emit({
          event: 'row',
          restaurant_id: String(row.restaurant_id),
          _id: String(row._id),
          action: 'skipped',
          reason: 'already_conforms',
        });
        continue;
      }

      // updateOne with a guard on the same conformance check would be
      // ideal, but `isValidPermissions` is a JS predicate — Mongo can't
      // run it server-side. The document-load + update pair is
      // intentionally non-atomic: if a concurrent write flips the
      // `permissions` shape between read and write, the worst case is
      // we overwrite a fresh write with the deterministic
      // `branch_manager` blob. That's acceptable in this one-shot
      // context (no concurrent writers other than this script + the
      // legacy `/users` route, which the new contract is moving away
      // from anyway).
      const update = {
        $set: {
          permissions: branchManagerPerms,
          role_preset: 'branch_manager',
          updated_at: now,
        },
      };
      const res = await c.updateOne({ _id: row._id }, update);
      const modified = res.modifiedCount ?? res.modified ?? 0;
      if (modified > 0) {
        summary.migrated += 1;
        emit({
          event: 'row',
          restaurant_id: String(row.restaurant_id),
          _id: String(row._id),
          action: 'migrated',
          reason: conforms ? 'preset_added' : 'permissions_replaced',
        });
      } else {
        summary.skipped += 1;
        emit({
          event: 'row',
          restaurant_id: String(row.restaurant_id),
          _id: String(row._id),
          action: 'skipped',
          reason: 'no_op_update',
        });
      }
    } catch (err) {
      summary.errors += 1;
      emit({
        event: 'row',
        restaurant_id: row?.restaurant_id ? String(row.restaurant_id) : null,
        _id: row?._id ? String(row._id) : null,
        action: 'error',
        reason: err && err.message ? err.message : String(err),
      });
    }
  }

  emit({ event: 'summary', ...summary });
}

main()
  .then(async () => {
    await close().catch(() => {});
    process.exit(0);
  })
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error('migrate-manager-permissions failed:', err && err.stack ? err.stack : err);
    await close().catch(() => {});
    process.exit(1);
  });
