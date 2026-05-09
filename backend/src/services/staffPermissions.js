'use strict';

// ─── Staff permissions — canonical map + helpers ─────────────────
//
// The 10-key permission contract for restaurant_users with role='staff'
// (and 'manager', which currently maps to the branch_manager preset on
// the UI). Owners are NEVER constrained by these — owner JWTs bypass
// requirePermission unconditionally and are presumed to have all 10.
//
// Why 10 keys (not the legacy {manage_orders, manage_menu, manage_users,
// view_analytics, manage_settings} owner-side set): the staff app needs
// finer-grained gating (a cashier should accept orders but not refund
// them; a kitchen tablet should toggle stock but not view sales reports;
// etc.). The 10 keys here are the staff-side contract; the legacy
// owner-side ROLE_PERMISSIONS map in routes/auth.js stays as-is for
// owner JWTs.
//
// Validation rules (enforced by isValidPermissions on every WRITE):
//   - exactly the 10 keys present (no more, no less)
//   - every value is a strict boolean
//   - no extras tolerated on the WRITE path
//
// On the READ path, callers should pass through extra keys defensively
// — pre-existing rows in restaurant_users may carry the legacy owner
// permission keys; we don't strip them here. UI / staff-app gating only
// looks at the 10 known keys.

const STAFF_PERMISSION_KEYS = Object.freeze([
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
]);

// Internal helper — build a permissions object from a list of "true" keys,
// defaulting all other keys to false. Frozen-array safe (we always copy).
function _fromTrueKeys(trueKeys) {
  const out = {};
  for (const k of STAFF_PERMISSION_KEYS) out[k] = false;
  for (const k of trueKeys) {
    if (STAFF_PERMISSION_KEYS.includes(k)) out[k] = true;
  }
  return out;
}

// Canonical role preset map. Each value is a fresh object every time
// permissionsFromPreset is called — never mutated in place, never
// shared by reference. The constant exposed here is for documentation
// / tests; runtime callers should ALWAYS go through permissionsFromPreset.
const ROLE_PRESETS = Object.freeze({
  // Cashier: front-of-house operator. Sees orders, accepts/rejects,
  // marks ready (handoff to delivery). No menu/stock/reports.
  cashier: Object.freeze(_fromTrueKeys([
    'view_orders', 'accept_orders', 'reject_orders', 'mark_ready',
  ])),
  // Kitchen: read-only orders + mark_ready (the BOH state transition).
  // Cannot accept/reject (that's cashier's call) or touch menu/stock.
  kitchen: Object.freeze(_fromTrueKeys([
    'view_orders', 'mark_ready',
  ])),
  // Branch manager: everything except customer PII view + refund
  // authority. Refund + customer-details require explicit owner /
  // custom toggle.
  branch_manager: Object.freeze(_fromTrueKeys([
    'view_orders', 'accept_orders', 'reject_orders', 'mark_ready',
    'manage_menu', 'manage_stock', 'view_reports', 'manage_settings',
  ])),
  // Owner: ALL 10 true. UI can NEVER toggle these — programmatic only,
  // and requirePermission bypasses the check entirely for owner JWTs
  // (defence-in-depth: even if this row were corrupted, the middleware
  // never reads it for owners).
  owner: Object.freeze(_fromTrueKeys([...STAFF_PERMISSION_KEYS])),
  // Custom: ALL 10 false initially. The UI lets the owner toggle each
  // key freely — the validation path enforces "all 10 keys present, all
  // booleans" on save.
  custom: Object.freeze(_fromTrueKeys([])),
});

/**
 * Returns a fresh, mutable permissions object for the given preset.
 * Falls back to 'custom' (all false) for unknown preset names — the
 * caller (POST /staff handler) validates the preset name separately
 * before reaching here, but we never throw on unknown input so a
 * misconfigured caller can't 500 the request path.
 *
 * @param {string} preset — one of: cashier, kitchen, branch_manager, owner, custom
 * @returns {Object<string, boolean>} fresh object with all 10 keys
 */
function permissionsFromPreset(preset) {
  const frozen = ROLE_PRESETS[preset] || ROLE_PRESETS.custom;
  // Spread to break the freeze + sharing — caller should be free to
  // mutate (e.g. layer custom overrides on top of a preset).
  return { ...frozen };
}

/**
 * Strict validator for the WRITE path. Rejects:
 *   - non-objects
 *   - missing keys (any of the 10)
 *   - extra keys (anything not in STAFF_PERMISSION_KEYS)
 *   - non-boolean values
 *
 * Returns true on success. Returns false on any failure — the caller
 * is expected to translate that into a 400 response. We don't throw
 * because the route handler wants to surface { ok: false, error,
 * details } not crash.
 *
 * @param {unknown} obj
 * @returns {boolean}
 */
function isValidPermissions(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  if (keys.length !== STAFF_PERMISSION_KEYS.length) return false;
  for (const k of STAFF_PERMISSION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) return false;
    if (typeof obj[k] !== 'boolean') return false;
  }
  // Extra-key check — any key in obj not in our canonical list fails.
  for (const k of keys) {
    if (!STAFF_PERMISSION_KEYS.includes(k)) return false;
  }
  return true;
}

module.exports = {
  STAFF_PERMISSION_KEYS,
  ROLE_PRESETS,
  permissionsFromPreset,
  isValidPermissions,
};
