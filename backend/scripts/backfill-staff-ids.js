#!/usr/bin/env node
'use strict';

// scripts/backfill-staff-ids.js
//
// One-time backfill for the staff_id field on restaurant_users.role='staff'
// rows. Pre-2026-05-09 staff rows had no restaurant-scoped human-readable
// id; the new staff-auth contract requires one (login is keyed on
// (store_slug, staff_id, pin) — no more name regex).
//
// What this writes:
//   - staff_id    : restaurant-scoped sequential id 'S001', 'S002', …
//                   assigned in created_at-ascending order so the oldest
//                   staff row gets S001. Stable across re-runs because
//                   the script is idempotent.
//   - role_preset : 'custom' (always — the admin tool decides whether to
//                   move them onto cashier / kitchen / branch_manager
//                   later).
//   - pin_set_at  : preserved if already set; otherwise stamped with
//                   `now` so the column is never null on backfilled rows.
//   - permissions : SEMANTIC REMAP from the legacy 7-key shape to the
//                   new 10-key contract. Without this, every existing
//                   staff member 403s on /accept, /decline, /status
//                   (the new gates check accept_orders / reject_orders /
//                   mark_ready, none of which exist on legacy rows).
//                   Mapping is conservative — see remapPermissions()
//                   below; new keys with no clean predecessor
//                   (manage_stock, refund_orders, view_customer_details)
//                   default to false. Owners grant explicitly via
//                   /dashboard/staff after backfill.
//   - token_version : incremented when permissions are remapped, so
//                   any in-flight JWTs invalidate and re-issue with the
//                   new shape on next /me hit.
//
// What this leaves alone:
//   - Rows that already have staff_id AND new-shape permissions.
//   - role='owner' rows — owners log in via the dashboard, not the
//     staff app; no staff_id needed.
//   - branch_ids, name, phone, pin_hash, is_active, etc.
//
// 2026-05-12 widening: role filter extended to { $in: ['staff', 'manager'] }
// in all three scan/update queries. Pre-widening, the POST handler in
// routes/restaurantStaff.js gated staff_id generation on role==='staff'
// only, so every manager landed with null staff_id and broke their
// staff-app login. POST handler is patched in the same commit; this
// script fills in the broken manager rows.
//
// Idempotent. Safe to re-run. Prints a summary { updated, skipped, perms_remapped }.
//
// HOW TO RUN (on EC2):
//
//   node --env-file=/home/ubuntu/GullyBite/.env \
//        backend/scripts/backfill-staff-ids.js
//
// (Read-only Mongo URI is fine for a dry inspection; run against the
// real one to commit. There is no separate dry-run flag — the script
// is purely additive and idempotent, so a "dry-run" is just running it
// against a fresh dump.)

const path = require('path');
const {
  connect,
  close,
  col,
} = require(path.join(__dirname, '..', 'src', 'config', 'database'));

function fmtStaffId(seq) {
  // Three-digit zero-pad — matches the contract example 'S001'. If a
  // restaurant ever crosses 999 staff members on a single backfill run,
  // bump the pad width here. The unique sparse index doesn't care.
  return `S${String(seq).padStart(3, '0')}`;
}

// New 10-key contract. Anything missing from the source row defaults to
// false. Anything extra in the source row is dropped — the resulting
// document carries exactly these keys.
const NEW_PERM_KEYS = [
  'view_orders', 'accept_orders', 'reject_orders', 'mark_ready',
  'manage_menu', 'manage_stock', 'view_reports', 'manage_settings',
  'refund_orders', 'view_customer_details',
];

// Conservative semantic remap from legacy keys to new keys.
//
//   Legacy → New
//   ─────────────
//   view_orders / view_menu / manage_orders → view_orders (visibility floor)
//   manage_orders → accept_orders + reject_orders + mark_ready
//   manage_menu → manage_menu  (key name unchanged)
//   view_analytics OR view_payments → view_reports
//   manage_settings → manage_settings  (key name unchanged)
//   (no clean predecessor) → manage_stock / refund_orders / view_customer_details
//                            default false; owner grants explicitly.
//
// Returns `null` if the input already conforms (all 10 new keys present
// and no legacy-only keys remain) — caller skips the write.
function remapPermissions(legacy) {
  const src = legacy && typeof legacy === 'object' ? legacy : {};
  // Already-conforming detection: every new key present, and no legacy-only
  // key still in the doc. If both conditions hold the row was already
  // remapped (e.g. by a prior backfill run) and we leave it alone.
  const LEGACY_ONLY = new Set([
    'manage_orders', 'view_menu', 'view_analytics',
    'manage_coupons', 'manage_users', 'view_payments', 'manage_staff',
  ]);
  const hasAllNew = NEW_PERM_KEYS.every((k) => Object.prototype.hasOwnProperty.call(src, k));
  const hasAnyLegacy = Object.keys(src).some((k) => LEGACY_ONLY.has(k));
  if (hasAllNew && !hasAnyLegacy) return null;

  const old = (k) => src[k] === true;
  const next = {
    view_orders:           old('view_orders') || old('view_menu') || old('manage_orders'),
    accept_orders:         old('manage_orders'),
    reject_orders:         old('manage_orders'),
    mark_ready:            old('manage_orders'),
    manage_menu:           old('manage_menu'),
    manage_stock:          false,                           // new key — default off
    view_reports:          old('view_analytics') || old('view_payments'),
    manage_settings:       old('manage_settings'),
    refund_orders:         false,                           // sensitive — default off
    view_customer_details: false,                           // sensitive — default off
  };
  return next;
}

async function main() {
  await connect();

  const c = col('restaurant_users');

  // Pull every staff row with no staff_id, grouped by restaurant. We
  // sort by created_at-asc within each restaurant so 'S001' goes to
  // the oldest row deterministically — re-running the script on a
  // partially-backfilled tenant won't reshuffle existing ids.
  const missing = await c.find(
    {
      role: { $in: ['staff', 'manager'] },
      $or: [
        { staff_id: { $exists: false } },
        { staff_id: null },
        { staff_id: '' },
      ],
    },
    {
      projection: {
        _id: 1, restaurant_id: 1, created_at: 1, pin_set_at: 1,
        // Pull permissions + token_version so the same write can also
        // do the legacy→new key remap and bump the version. Saves a
        // second updateOne per row when staff_id assignment is already
        // happening.
        permissions: 1, token_version: 1,
      },
    },
  ).sort({ restaurant_id: 1, created_at: 1, _id: 1 }).toArray();

  if (missing.length === 0) {
    console.log('Nothing to backfill — every staff row already has staff_id.');
    return { updated: 0, skipped: 0 };
  }

  // Per-restaurant: find the highest existing staff_id sequence and
  // continue from there. Existing ids are parsed as 'S<NNN>' — anything
  // non-conforming is ignored for the max calculation but won't be
  // overwritten (we only target rows missing the field).
  const restaurantIds = [...new Set(missing.map((r) => String(r.restaurant_id)))];
  const seqByRestaurant = new Map();
  for (const rid of restaurantIds) {
    const rows = await c.find(
      { restaurant_id: rid, role: { $in: ['staff', 'manager'] }, staff_id: { $regex: /^S\d+$/ } },
      { projection: { staff_id: 1 } },
    ).toArray();
    let maxSeq = 0;
    for (const r of rows) {
      const m = /^S(\d+)$/.exec(r.staff_id || '');
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
      }
    }
    seqByRestaurant.set(rid, maxSeq);
  }

  let updated = 0;
  let permsRemappedInPass1 = 0;
  const skipped = 0;
  const now = new Date();

  // ─── Pass 1: rows missing staff_id ────────────────────────
  // Same write also remaps permissions if the legacy shape is detected.
  for (const row of missing) {
    const rid = String(row.restaurant_id);
    const next = (seqByRestaurant.get(rid) || 0) + 1;
    seqByRestaurant.set(rid, next);
    const newStaffId = fmtStaffId(next);

    const remapped = remapPermissions(row.permissions);

    const $set = {
      staff_id: newStaffId,
      role_preset: 'custom',
      pin_set_at: row.pin_set_at || now,
      updated_at: now,
    };
    if (remapped) {
      $set.permissions = remapped;
      // Bump token_version so any in-flight JWT for this user invalidates
      // and re-issues with the new permission claim on next /me hit.
      $set.token_version = Number(row.token_version || 0) + 1;
    }

    // updateOne with a guard on staff_id absence so a concurrent run
    // (or a row that got staff_id in flight via a different path) is
    // skipped, not overwritten.
    const result = await c.updateOne(
      {
        _id: row._id,
        $or: [
          { staff_id: { $exists: false } },
          { staff_id: null },
          { staff_id: '' },
        ],
      },
      { $set },
    );
    if (result.matchedCount > 0) {
      updated += 1;
      if (remapped) permsRemappedInPass1 += 1;
      console.log(
        `  ${rid} :: ${row._id} → staff_id=${newStaffId}` +
        (remapped ? ' (perms remapped)' : ''),
      );
    } else {
      // Decrement the local counter — this seq number wasn't actually
      // consumed, so the next missing row in the same restaurant
      // should re-use it. (Rare race; defensive.)
      seqByRestaurant.set(rid, next - 1);
    }
  }

  // ─── Pass 2: rows that already had staff_id but still carry legacy
  // permissions. Touches permissions + token_version only. Idempotent —
  // remapPermissions returns null for already-conforming rows so writes
  // are limited to actual remaps.
  const existing = await c.find(
    {
      role: { $in: ['staff', 'manager'] },
      staff_id: { $exists: true, $ne: null, $nin: ['', null] },
    },
    { projection: { _id: 1, restaurant_id: 1, permissions: 1, token_version: 1 } },
  ).toArray();

  let permsRemappedInPass2 = 0;
  for (const row of existing) {
    const remapped = remapPermissions(row.permissions);
    if (!remapped) continue;
    const result = await c.updateOne(
      { _id: row._id },
      {
        $set: {
          permissions: remapped,
          token_version: Number(row.token_version || 0) + 1,
          updated_at: now,
        },
      },
    );
    if (result.matchedCount > 0) {
      permsRemappedInPass2 += 1;
      console.log(`  ${row.restaurant_id} :: ${row._id} → perms remapped (had staff_id)`);
    }
  }

  const permsRemapped = permsRemappedInPass1 + permsRemappedInPass2;
  console.log('');
  console.log(
    `Summary: ${JSON.stringify({
      updated,
      skipped: missing.length - updated,
      perms_remapped: permsRemapped,
    })}`,
  );
  return { updated, skipped: missing.length - updated, perms_remapped: permsRemapped };
}

main()
  .then(async (summary) => {
    await close().catch(() => {});
    if (!summary || typeof summary.updated !== 'number') process.exit(0);
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('backfill-staff-ids failed:', err && err.stack ? err.stack : err);
    await close().catch(() => {});
    process.exit(1);
  });
