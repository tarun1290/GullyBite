'use strict';

// ─────────────────────────────────────────────────────────────────────
// STAFF AUTH SERVICE — schema + helpers for the per-staff PIN login flow.
// ─────────────────────────────────────────────────────────────────────
//
// Collection: restaurant_users (EXISTING — extended in-place; do NOT
// create a new collection). One row per human, scoped to a restaurant
// and (optionally) one or more branches. The schema below documents the
// EXTENDED shape used by the staff-app login. Existing fields from the
// owner / manager flows (token_version, is_active, name, phone,
// branch_ids, …) are kept verbatim — the new fields are additive.
//
// Document shape (rows where role === 'staff' or 'manager'):
//
//   {
//     _id:                  uuid,
//     restaurant_id:        string,
//     role:                 'staff' | 'manager' | 'owner',
//
//     // ── new fields (this service owns these) ──────────────────────
//     staff_id:             string,        // restaurant-scoped, e.g. 'S001'
//                                          // unique per (restaurant_id, staff_id)
//     role_preset:          'cashier' | 'kitchen' | 'branch_manager'
//                           | 'owner' | 'custom',
//     pin_set_at:           Date,          // set when PIN created/reset
//     legacy_access_token:  string?,       // sparse — migration grep only
//
//     // ── existing fields (untouched) ───────────────────────────────
//     name:                 string,
//     phone:                string,
//     pin_hash:             string,        // bcrypt, 10 rounds
//     branch_ids:           string[],      // [] / missing = all branches
//     permissions:          { [10 fixed keys]: boolean },
//     token_version:        number,        // bumped on PIN reset / soft-delete
//     is_active:            boolean,
//     last_login_at:        Date?,
//     last_active_at:       Date?,         // updated by /me handler
//     created_at:           Date,
//     updated_at:           Date,
//   }
//
// Permissions: the canonical 10-key set. Validate-on-write, tolerate
// extras on read so a stale doc doesn't crash login.
//
//   view_orders, accept_orders, reject_orders, mark_ready, manage_menu,
//   manage_stock, view_reports, manage_settings, refund_orders,
//   view_customer_details
//
// Indexes (idempotent — created via ensureStaffIndexes() on boot):
//
//   { restaurant_id: 1, staff_id: 1 }   unique partial
//       Partial filter `{ staff_id: { $type: 'string' } }` so rows
//       without a staff_id (owners, not-yet-assigned managers, etc.)
//       are excluded from the index entirely — sparse alone wasn't
//       enough because explicit `staff_id: null` still indexes and
//       collides on the unique constraint. Unique within the
//       (restaurant, staff_id) pair so 'S001' can be re-used across
//       restaurants but not within one.
//
//   { restaurant_id: 1, is_active: 1 }
//       Speeds up the staff-list page (Subagent B) and the active-only
//       login lookup.
//
//   { legacy_access_token: 1 }          sparse
//       Migration grep only — once every row is backfilled this index
//       can be dropped. Sparse so the column can be omitted on new
//       writes without bloating the index.
//
// Role / preset semantics:
//   - 'cashier'        → counter ops, no menu/settings.
//   - 'kitchen'        → ticket view + mark_ready, no order accept.
//   - 'branch_manager' → full operational set + view_reports.
//   - 'owner'          → all 10 permissions on (kept for completeness;
//                        owners normally don't log in via the staff app).
//   - 'custom'         → permissions object is the source of truth;
//                        used by the backfill script and the staff-CRUD
//                        flow when an admin tweaks individual toggles.
//
// JWT shape (signed by middleware/staffAuth.signStaffToken — extended
// to carry staff_id + role_preset for staff/manager rows):
//
//   { userId, restaurant_id, restaurant_slug, branchId, branchIds,
//     permissions, token_version, role,
//     staff_id, role_preset }            // ← new for staff/manager
//
// Secret: STAFF_JWT_SECRET || `staff:${JWT_SECRET}`. Kept distinct from
// the owner / admin secrets so a leaked staff token can't be replayed
// against another scope.

const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const { col } = require('../config/database');
const log = require('../utils/logger').child({ component: 'staffAuth.service' });

const BCRYPT_ROUNDS = 10;

// ─── Permissions ─────────────────────────────────────────────────────
// Canonical 10-key set. Any other key written is rejected by callers
// that go through this module (Subagent B's staffPermissions.js will
// also enforce this on create/update); on read we tolerate extras for
// forward-compat with rows written by older code paths.
const PERMISSION_KEYS = [
  'view_orders',
  'accept_orders',
  'reject_orders',
  'mark_ready',
  'manage_menu',
  'manage_stock',
  'view_reports',
  'manage_settings',
  'refund_orders',
  'view_customer_details',
];

const ROLE_PRESETS = ['cashier', 'kitchen', 'branch_manager', 'owner', 'custom'];

// Default preset → permissions mapping. Subagent B owns the canonical
// version in services/staffPermissions.js; this local fallback exists
// so login can mint a token even if B's module hasn't landed yet. The
// require-with-fallback pattern below means B's version transparently
// wins at runtime once it ships.
const _LOCAL_PRESET_MAP = {
  cashier: {
    view_orders: true,
    accept_orders: true,
    reject_orders: true,
    mark_ready: false,
    manage_menu: false,
    manage_stock: false,
    view_reports: false,
    manage_settings: false,
    refund_orders: false,
    view_customer_details: true,
  },
  kitchen: {
    view_orders: true,
    accept_orders: false,
    reject_orders: false,
    mark_ready: true,
    manage_menu: false,
    manage_stock: true,
    view_reports: false,
    manage_settings: false,
    refund_orders: false,
    view_customer_details: false,
  },
  branch_manager: {
    view_orders: true,
    accept_orders: true,
    reject_orders: true,
    mark_ready: true,
    manage_menu: true,
    manage_stock: true,
    view_reports: true,
    manage_settings: true,
    refund_orders: true,
    view_customer_details: true,
  },
  owner: {
    view_orders: true,
    accept_orders: true,
    reject_orders: true,
    mark_ready: true,
    manage_menu: true,
    manage_stock: true,
    view_reports: true,
    manage_settings: true,
    refund_orders: true,
    view_customer_details: true,
  },
  custom: {
    view_orders: false,
    accept_orders: false,
    reject_orders: false,
    mark_ready: false,
    manage_menu: false,
    manage_stock: false,
    view_reports: false,
    manage_settings: false,
    refund_orders: false,
    view_customer_details: false,
  },
};

// Lazily try to load Subagent B's authoritative permissions module. If
// it isn't on disk yet (B hasn't shipped), fall back to the local map.
// Cached after first lookup so we don't hit require() per call.
let _bMapCache;
function _bMap() {
  if (_bMapCache !== undefined) return _bMapCache;
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    const mod = require('./staffPermissions');
    if (mod && typeof mod.permissionsFromPreset === 'function') {
      _bMapCache = mod;
      return _bMapCache;
    }
  } catch (_) { /* not yet shipped — fall through */ }
  _bMapCache = null;
  return _bMapCache;
}

// Returns the 10-key permissions object for a given preset name.
// Unknown / 'custom' presets get the all-false map — caller is expected
// to overlay any specific toggles on top.
function permissionsFromPreset(preset) {
  const b = _bMap();
  if (b) return b.permissionsFromPreset(preset);
  const key = ROLE_PRESETS.includes(preset) ? preset : 'custom';
  // Return a fresh object so callers can mutate without poisoning the
  // shared default. Object.assign over an empty object keeps key order
  // stable for downstream JSON consumers.
  return Object.assign({}, _LOCAL_PRESET_MAP[key]);
}

// ─── Index management ────────────────────────────────────────────────
// Idempotent — Mongo's createIndex is a no-op when the same key/options
// pair already exists. Safe to call on every boot.
async function ensureStaffIndexes() {
  const STAFF_ID_INDEX_NAME = 'restaurant_id_1_staff_id_1';
  const STAFF_ID_PARTIAL_FILTER = { staff_id: { $type: 'string' } };

  try {
    const c = col('restaurant_users');

    // Reconcile the (restaurant_id, staff_id) index. Earlier deploys
    // created it as `unique sparse` without a partial filter — sparse
    // excludes missing fields but NOT explicit null, so multiple owner
    // rows in the same restaurant (all with staff_id: null) collide on
    // the unique constraint and the build aborts. Switching to a
    // partial index filtered on `{ staff_id: { $type: 'string' } }`
    // excludes missing AND null AND non-string entries cleanly.
    //
    // Mongo throws IndexOptionsConflict / IndexKeySpecsConflict if we
    // try to re-create the same name with different options. Detect
    // an existing-but-stale definition first, drop, then recreate.
    let existingIndexes = [];
    try {
      existingIndexes = await c.listIndexes().toArray();
    } catch (listErr) {
      // listIndexes throws NamespaceNotFound on a fresh collection.
      // Treat as empty — createIndex below will materialise the
      // collection along with the index.
      existingIndexes = [];
    }
    const existing = existingIndexes.find((i) => i.name === STAFF_ID_INDEX_NAME);
    const hasCorrectFilter =
      existing &&
      existing.partialFilterExpression &&
      existing.partialFilterExpression.staff_id &&
      existing.partialFilterExpression.staff_id.$type === 'string';
    if (existing && !hasCorrectFilter) {
      await c.dropIndex(STAFF_ID_INDEX_NAME);
      log.info({ name: STAFF_ID_INDEX_NAME }, 'ensureStaffIndexes: dropped legacy index restaurant_id_1_staff_id_1');
    }
    await c.createIndex(
      { restaurant_id: 1, staff_id: 1 },
      {
        unique: true,
        partialFilterExpression: STAFF_ID_PARTIAL_FILTER,
        name: STAFF_ID_INDEX_NAME,
      },
    );
    if (!existing || !hasCorrectFilter) {
      log.info({ name: STAFF_ID_INDEX_NAME }, 'ensureStaffIndexes: created restaurant_id_1_staff_id_1 (partial)');
    }

    await c.createIndex(
      { restaurant_id: 1, is_active: 1 },
      { name: 'restaurant_id_1_is_active_1' },
    );
    await c.createIndex(
      { legacy_access_token: 1 },
      { sparse: true, name: 'legacy_access_token_1' },
    );
    log.info('staff indexes ensured');
  } catch (err) {
    log.warn({ err: err && err.message ? err.message : String(err) },
      'ensureStaffIndexes failed — continuing boot');
  }
}

// ─── PIN helpers ─────────────────────────────────────────────────────
// generatePin: unbiased 4-digit PIN sourced from crypto.randomInt
// (Math.random is not credential-safe). Zero-padded so '0042' renders.
function generatePin() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

async function hashPin(pin) {
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
    throw new Error('hashPin: pin must be a 4-digit numeric string');
  }
  return bcrypt.hash(pin, BCRYPT_ROUNDS);
}

async function verifyPin(pin, hash) {
  if (!pin || !hash) return false;
  try {
    return await bcrypt.compare(String(pin), String(hash));
  } catch {
    return false;
  }
}

// ─── Permissions normalisation (read path) ───────────────────────────
// Tolerates extras on the stored row (legacy keys, future keys) but
// always returns an object containing exactly the 10 canonical keys —
// missing keys default to false. Used in sanitizeStaff and in /me so
// the client always sees a stable shape.
function normalizePermissions(raw) {
  const out = {};
  const src = (raw && typeof raw === 'object') ? raw : {};
  for (const k of PERMISSION_KEYS) out[k] = !!src[k];
  return out;
}

// ─── SanitizedStaff ──────────────────────────────────────────────────
// The shape returned to the client by both /api/staff/auth (login) and
// /api/staff/auth/me. Strips PIN material, token_version, and the
// legacy migration-only columns. `display_name`, `branchIds` and
// `active` are aliases retained for back-compat with frontends that
// were written against the older (camelCase) field names.
function sanitizeStaff(doc) {
  if (!doc) return null;
  const branchIds = Array.isArray(doc.branch_ids) ? doc.branch_ids.map(String) : [];
  const permissions = normalizePermissions(doc.permissions);
  return {
    _id: String(doc._id),
    restaurant_id: doc.restaurant_id != null ? String(doc.restaurant_id) : null,
    staff_id: doc.staff_id || null,
    name: doc.name || '',
    display_name: doc.name || '',         // back-compat alias
    phone: doc.phone || null,
    role: doc.role || 'staff',
    role_preset: doc.role_preset || 'custom',
    branch_ids: branchIds,
    branchIds,                             // back-compat alias
    permissions,
    is_active: !!doc.is_active,
    active: !!doc.is_active,               // back-compat alias
    created_at: doc.created_at || null,
    last_active_at: doc.last_active_at || null,
  };
}

module.exports = {
  ensureStaffIndexes,
  generatePin,
  hashPin,
  verifyPin,
  sanitizeStaff,
  normalizePermissions,
  permissionsFromPreset,
  PERMISSION_KEYS,
  ROLE_PRESETS,
};
