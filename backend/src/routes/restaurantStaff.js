'use strict';

// ─── Restaurant Staff CRUD router ────────────────────────────────
//
// Mounted at /api/restaurant/staff in backend/ec2-server.js. Owner-only
// (gated by requireAuth from routes/auth.js — the zm_token JWT). Manages
// staff rows in restaurant_users (role='staff'). Note: managers
// (role='manager') and owners (role='owner') are NOT exposed by this
// router — managers are created via a separate flow (TBD), owners are
// created at signup.
//
// Endpoint summary (full contract in docs / Subagent A's audit):
//   GET    /api/restaurant/staff           — list all staff for this restaurant (incl. inactive)
//   POST   /api/restaurant/staff           — create staff + generate PIN (returned ONCE)
//   PUT    /api/restaurant/staff/:id       — update fields; reset_pin:true regenerates PIN
//   DELETE /api/restaurant/staff/:id       — soft delete (is_active:false + token_version++)
//
// PIN generation, hashing, and the SanitizedStaff serializer are
// delegated to services/staffAuth.js (Subagent A's file). If that file
// isn't present yet at runtime, the require() throws on cold start —
// fail loud rather than ship a broken endpoint set with subtly wrong
// PIN behaviour.

const express = require('express');
const router = express.Router();

const { col, newId } = require('../config/database');
const { requireAuth, requirePermission } = require('./auth');
const log = require('../utils/logger').child({ component: 'restaurantStaff' });

const {
  permissionsFromPreset,
  isValidPermissions,
  ROLE_PRESETS,
} = require('../services/staffPermissions');

// Subagent A's exports — generatePin / hashPin / sanitizeStaff. Loaded
// lazily so a missing-module error surfaces only when the route is
// actually hit (not at process boot, which would block every endpoint
// in the app). Each handler calls _staffAuth() which caches the
// resolved module on first successful require.
let _cachedStaffAuth = null;
function _staffAuth() {
  if (_cachedStaffAuth) return _cachedStaffAuth;
  // eslint-disable-next-line global-require
  _cachedStaffAuth = require('../services/staffAuth');
  return _cachedStaffAuth;
}

// All routes below this line require a valid owner / restaurant JWT.
router.use(requireAuth);
router.use(requirePermission('manage_users'));

// Valid presets accepted by POST/PUT. Note: 'owner' is intentionally
// EXCLUDED from the user-facing preset list — owner permissions are
// programmatic and the staff CRUD never creates owner rows.
const VALID_PRESETS = ['cashier', 'kitchen', 'branch_manager', 'custom'];
const VALID_ROLES = ['staff', 'manager'];

// ─── Helpers ─────────────────────────────────────────────────────

// Generates the next staff_id for a restaurant. Strategy: find the
// highest existing numeric suffix among rows with role='staff' AND a
// staff_id matching /^S\d+$/, increment by 1, zero-pad to width 3.
// Falls back to "S001" for the first staff member. Concurrent inserts
// can theoretically collide on the suffix — we don't enforce a unique
// index here; if collisions become a problem we'll move to a counter
// document.
async function _nextStaffId(restaurantId) {
  const rows = await col('restaurant_users')
    .find(
      { restaurant_id: restaurantId, role: 'staff', staff_id: { $regex: /^S\d+$/ } },
      { projection: { staff_id: 1 } },
    )
    .toArray();
  let max = 0;
  for (const r of rows) {
    const m = /^S(\d+)$/.exec(String(r.staff_id || ''));
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  const next = max + 1;
  return `S${String(next).padStart(3, '0')}`;
}

// Validate branch_ids: every entry must be a string id that belongs to
// this restaurant. Returns { ok:true, ids } on success or
// { ok:false, missing } on mismatch. Empty array is valid (= unscoped /
// all branches; the staff-app /auth handler interprets empty as "all").
async function _validateBranchIds(restaurantId, branchIds) {
  if (!Array.isArray(branchIds)) return { ok: false, missing: ['branch_ids must be array'] };
  if (branchIds.length === 0) return { ok: true, ids: [] };
  const ids = branchIds.map(String);
  const rows = await col('branches')
    .find({ _id: { $in: ids }, restaurant_id: restaurantId }, { projection: { _id: 1 } })
    .toArray();
  const found = new Set(rows.map((b) => String(b._id)));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) return { ok: false, missing };
  return { ok: true, ids };
}

// Resolve permissions from request body. Rules per contract:
//   - If preset !== 'custom' AND permissions omitted → fill from preset
//   - If preset === 'custom' → permissions REQUIRED + must validate
//   - If both preset !== 'custom' AND permissions present → use the
//     explicit permissions (UI-allowed override) AFTER validating shape
function _resolvePermissions(preset, providedPermissions) {
  const presetIsCustom = preset === 'custom';
  if (providedPermissions !== undefined && providedPermissions !== null) {
    if (!isValidPermissions(providedPermissions)) {
      return { ok: false, error: 'permissions must include all 10 boolean keys with no extras' };
    }
    return { ok: true, permissions: { ...providedPermissions } };
  }
  if (presetIsCustom) {
    return { ok: false, error: 'permissions required when role_preset is "custom"' };
  }
  return { ok: true, permissions: permissionsFromPreset(preset) };
}

// ─── GET /api/restaurant/staff ───────────────────────────────────
// Returns ALL staff rows for this restaurant — active and inactive.
// The dashboard UI is responsible for filtering by is_active when
// rendering the "active staff" view.
router.get('/', async (req, res) => {
  try {
    const rows = await col('restaurant_users')
      .find({ restaurant_id: req.restaurantId, role: { $in: VALID_ROLES } })
      .sort({ created_at: -1 })
      .toArray();
    const { sanitizeStaff } = _staffAuth();
    return res.json({ ok: true, staff: rows.map(sanitizeStaff) });
  } catch (err) {
    log.error({ err, restaurantId: req.restaurantId }, 'staff list failed');
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});

// ─── POST /api/restaurant/staff ──────────────────────────────────
router.post('/', express.json(), async (req, res) => {
  try {
    const {
      display_name,
      phone,
      role_preset,
      branch_ids,
      permissions,
      role,
    } = req.body || {};

    const effectiveRole = role === undefined ? 'staff' : role;

    const details = [];
    if (!display_name || typeof display_name !== 'string' || !display_name.trim()) {
      details.push('display_name required');
    }
    if (!role_preset || !VALID_PRESETS.includes(role_preset)) {
      details.push(`role_preset must be one of: ${VALID_PRESETS.join(', ')}`);
    }
    if (!VALID_ROLES.includes(effectiveRole)) {
      details.push(`role must be one of: ${VALID_ROLES.join(', ')}`);
    }
    if (!Array.isArray(branch_ids)) {
      details.push('branch_ids must be array');
    }
    if (phone !== undefined && phone !== null && typeof phone !== 'string') {
      details.push('phone must be string when provided');
    }
    if (details.length) {
      return res.status(400).json({ ok: false, error: 'validation', details });
    }

    const branchCheck = await _validateBranchIds(req.restaurantId, branch_ids);
    if (!branchCheck.ok) {
      return res.status(400).json({
        ok: false, error: 'validation',
        details: [`branch_ids contain ids not in this restaurant: ${branchCheck.missing.join(', ')}`],
      });
    }

    const permResolve = _resolvePermissions(role_preset, permissions);
    if (!permResolve.ok) {
      return res.status(400).json({ ok: false, error: 'validation', details: [permResolve.error] });
    }

    const { generatePin, hashPin } = _staffAuth();
    const generated_pin = await generatePin();
    const pin_hash = await hashPin(generated_pin);

    const now = new Date();
    const userId = newId();
    const doc = {
      _id: userId,
      restaurant_id: req.restaurantId,
      role: effectiveRole,
      name: display_name.trim(),
      phone: phone ? String(phone).trim() : null,
      pin_hash,
      pin_set_at: now,
      role_preset,
      permissions: permResolve.permissions,
      branch_ids: branchCheck.ids,
      is_active: true,
      token_version: 0,
      created_at: now,
      updated_at: now,
    };
    if (effectiveRole === 'staff') {
      doc.staff_id = await _nextStaffId(req.restaurantId);
    }
    await col('restaurant_users').insertOne(doc);

    const { sanitizeStaff } = _staffAuth();
    return res.json({ ok: true, staff: sanitizeStaff(doc), generated_pin });
  } catch (err) {
    log.error({ err, restaurantId: req.restaurantId }, 'staff create failed');
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});

// ─── PUT /api/restaurant/staff/:id ───────────────────────────────
router.put('/:id', express.json(), async (req, res) => {
  try {
    const id = req.params.id;
    const existing = await col('restaurant_users').findOne({ _id: id });
    if (!existing || !VALID_ROLES.includes(existing.role)) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    if (String(existing.restaurant_id) !== String(req.restaurantId)) {
      // Tenant isolation — 404, not 403, to avoid leaking existence.
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    const {
      display_name,
      phone,
      role_preset,
      branch_ids,
      permissions,
      is_active,
      reset_pin,
    } = req.body || {};

    const details = [];
    if (display_name !== undefined) {
      if (typeof display_name !== 'string' || !display_name.trim()) {
        details.push('display_name must be non-empty string');
      }
    }
    if (phone !== undefined && phone !== null && typeof phone !== 'string') {
      details.push('phone must be string when provided');
    }
    if (role_preset !== undefined && !VALID_PRESETS.includes(role_preset)) {
      details.push(`role_preset must be one of: ${VALID_PRESETS.join(', ')}`);
    }
    if (branch_ids !== undefined && !Array.isArray(branch_ids)) {
      details.push('branch_ids must be array');
    }
    if (is_active !== undefined && typeof is_active !== 'boolean') {
      details.push('is_active must be boolean');
    }
    if (reset_pin !== undefined && typeof reset_pin !== 'boolean') {
      details.push('reset_pin must be boolean');
    }
    if (details.length) {
      return res.status(400).json({ ok: false, error: 'validation', details });
    }

    const set = { updated_at: new Date() };
    const inc = {};

    if (display_name !== undefined) set.name = display_name.trim();
    if (phone !== undefined) set.phone = phone ? String(phone).trim() : null;
    if (is_active !== undefined) set.is_active = is_active;

    if (branch_ids !== undefined) {
      const branchCheck = await _validateBranchIds(req.restaurantId, branch_ids);
      if (!branchCheck.ok) {
        return res.status(400).json({
          ok: false, error: 'validation',
          details: [`branch_ids contain ids not in this restaurant: ${branchCheck.missing.join(', ')}`],
        });
      }
      set.branch_ids = branchCheck.ids;
    }

    // Permissions resolution:
    //   - If role_preset changes AND permissions NOT provided → auto-fill from new preset
    //   - If permissions provided → validate + use as-is (regardless of preset)
    //   - If neither → no change
    const presetChanged = role_preset !== undefined && role_preset !== existing.role_preset;
    if (permissions !== undefined && permissions !== null) {
      if (!isValidPermissions(permissions)) {
        return res.status(400).json({
          ok: false, error: 'validation',
          details: ['permissions must include all 10 boolean keys with no extras'],
        });
      }
      set.permissions = { ...permissions };
      if (role_preset !== undefined) set.role_preset = role_preset;
    } else if (presetChanged) {
      // Custom preset without explicit permissions is a hard error —
      // matches the POST contract.
      if (role_preset === 'custom') {
        return res.status(400).json({
          ok: false, error: 'validation',
          details: ['permissions required when role_preset is "custom"'],
        });
      }
      set.role_preset = role_preset;
      set.permissions = permissionsFromPreset(role_preset);
    } else if (role_preset !== undefined) {
      // Same preset re-supplied — no-op on permissions.
      set.role_preset = role_preset;
    }

    let generated_pin;
    if (reset_pin === true) {
      const { generatePin, hashPin } = _staffAuth();
      generated_pin = await generatePin();
      set.pin_hash = await hashPin(generated_pin);
      set.pin_set_at = new Date();
      // Bump token_version so existing JWTs for this user immediately
      // stop working (the staffAuth verifier compares against db value).
      inc.token_version = 1;
    }
    // is_active=false also bumps token_version (soft-delete-style
    // invalidation, even though this is technically just a deactivate).
    if (is_active === false) {
      // Only inc once — if reset_pin already incremented it, don't
      // double-increment.
      if (!inc.token_version) inc.token_version = 1;
    }

    const update = { $set: set };
    if (Object.keys(inc).length) update.$inc = inc;
    await col('restaurant_users').updateOne({ _id: id }, update);

    const updated = await col('restaurant_users').findOne({ _id: id });
    const { sanitizeStaff } = _staffAuth();
    const body = { ok: true, staff: sanitizeStaff(updated) };
    if (generated_pin) body.generated_pin = generated_pin;
    return res.json(body);
  } catch (err) {
    log.error({ err, restaurantId: req.restaurantId, staffId: req.params.id }, 'staff update failed');
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});

// ─── DELETE /api/restaurant/staff/:id (soft) ─────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const existing = await col('restaurant_users').findOne({ _id: id });
    if (!existing || !VALID_ROLES.includes(existing.role)) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    if (String(existing.restaurant_id) !== String(req.restaurantId)) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    await col('restaurant_users').updateOne(
      { _id: id },
      { $set: { is_active: false, updated_at: new Date() }, $inc: { token_version: 1 } },
    );
    return res.json({ ok: true });
  } catch (err) {
    log.error({ err, restaurantId: req.restaurantId, staffId: req.params.id }, 'staff soft-delete failed');
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});

// Expose ROLE_PRESETS for any server-side caller wanting to introspect
// the preset map without re-importing the service. Re-exported via the
// router.locals so consumers can reach it via `app.get('staffPresets')`
// pattern — left as a simple property attach so we don't pollute the
// router.use chain.
router._ROLE_PRESETS = ROLE_PRESETS;

module.exports = router;
