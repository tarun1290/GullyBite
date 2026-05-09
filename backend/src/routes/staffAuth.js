'use strict';

// ─────────────────────────────────────────────────────────────────────
// /api/staff/auth — staff login, logout, /me. Bearer-only transport.
// ─────────────────────────────────────────────────────────────────────
//
// Mounted in ec2-server.js BEFORE the legacy /api/staff router so the
// new POST /, POST /logout, GET /me handlers shadow any same-path
// remnant in routes/staff.js.
//
// Schema + helper docs live in services/staffAuth.js (top-of-file
// comment block). This file is the HTTP surface only.
//
// Auth contract:
//   - Login body: { store_slug, staff_id, pin }. Any payload that
//     contains the legacy 'staff_access_token' field is rejected
//     with a 400 'deprecated_login_payload' so older RN clients fail
//     loud during the rollout.
//   - 401 'invalid_credentials' is generic across every failure mode
//     (wrong slug, wrong staff_id, wrong PIN, deactivated row, missing
//     pin_hash). DO NOT distinguish — that's the spec.
//   - 429 'rate_limited' on too-many attempts. 5 / 15min, keyed
//     `staff_login:${store_slug}:${staff_id}`.

const express = require('express');
const router = express.Router();

const { col } = require('../config/database');
const {
  signStaffToken,
  requireStaffAuth,
  STAFF_APP_ROLES,
} = require('../middleware/staffAuth');
const { rateLimitFn } = require('../middleware/rateLimit');
const {
  verifyPin,
  sanitizeStaff,
} = require('../services/staffAuth');
const log = require('../utils/logger').child({ component: 'staffAuth.routes' });

// ─── Rate limiter ────────────────────────────────────────────────────
// 5 attempts per 15 minutes, keyed on (store_slug, staff_id). Falls back
// to IP when one of those fields is missing so a malformed body can't
// bypass the limiter entirely. Mirrors the spec: 'staff_login:${slug}:${id}'.
const loginRateLimit = rateLimitFn(
  (req) => {
    const slug = String(req.body?.store_slug || '').trim().toLowerCase();
    const sid = String(req.body?.staff_id || '').trim();
    if (slug && sid) return `staff_login:${slug}:${sid}`;
    // Fallback — IP scoped — only fires when the body is missing the
    // identity fields. Keeps a malformed flood from getting an
    // unlimited free pass at the auth handler.
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    return `staff_login:ip:${ip}`;
  },
  5,
  15 * 60,
  { message: 'rate_limited' },
);

// ─── POST /api/staff/auth — login ────────────────────────────────────
//
// Body: { store_slug, staff_id, pin }
// Success: 200 { ok: true, token, staff: SanitizedStaff }
// Failure: 401 { ok: false, error: 'invalid_credentials' }    (generic)
//          400 { ok: false, error: 'deprecated_login_payload' } (legacy field present)
//          429 { ok: false, error: 'rate_limited' }
//          500 { ok: false, error: 'internal_error' }
//
// Lookup chain: store_slug → restaurants._id → restaurant_users where
// (restaurant_id, staff_id) match AND role ∈ STAFF_APP_ROLES AND
// is_active. PIN bcrypt-compared against pin_hash. JWT minted via the
// shared signStaffToken helper with the new staff_id / role_preset
// claims attached.
router.post('/', loginRateLimit, express.json(), async (req, res) => {
  try {
    const body = req.body || {};

    // Legacy-payload guard. Older RN builds posted
    // { staff_access_token, name, pin } — surface a loud 400 so the
    // client team finds the bad caller during rollout instead of
    // silently 401-ing at production scale.
    if (Object.prototype.hasOwnProperty.call(body, 'staff_access_token')) {
      return res.status(400).json({ ok: false, error: 'deprecated_login_payload' });
    }

    const storeSlug = typeof body.store_slug === 'string' ? body.store_slug.trim() : '';
    const staffId   = typeof body.staff_id  === 'string' ? body.staff_id.trim()  : '';
    const pin       = typeof body.pin       === 'string' ? body.pin.trim()       : '';

    if (!storeSlug || !staffId || !/^\d{4}$/.test(pin)) {
      // Same generic 401 the contract mandates. We don't return 400 on
      // shape failures because that would leak which fields are malformed.
      return res.status(401).json({ ok: false, error: 'invalid_credentials' });
    }

    // Resolve restaurant by slug. Lower-case match — store_slug is the
    // canonical lower-case form (see existing /auth/signin path), and
    // any UI surface that sends a mixed-case input gets normalised here.
    const restaurant = await col('restaurants').findOne(
      { store_slug: storeSlug.toLowerCase() },
      { projection: { _id: 1, store_slug: 1, business_name: 1, brand_name: 1, logo_url: 1 } },
    );
    if (!restaurant) {
      return res.status(401).json({ ok: false, error: 'invalid_credentials' });
    }

    // Find the staff row. Compound match on (restaurant_id, staff_id) —
    // the unique sparse index built by ensureStaffIndexes() makes this
    // an indexed point lookup. Role gate excludes owners (separate flow).
    const user = await col('restaurant_users').findOne({
      restaurant_id: String(restaurant._id),
      staff_id: staffId,
      role: { $in: STAFF_APP_ROLES },
      is_active: true,
    });
    if (!user) {
      return res.status(401).json({ ok: false, error: 'invalid_credentials' });
    }

    // PIN check. verifyPin handles missing/empty pin_hash by returning
    // false — same generic 401 maps.
    const ok = user.pin_hash ? await verifyPin(pin, user.pin_hash) : false;
    if (!ok) {
      return res.status(401).json({ ok: false, error: 'invalid_credentials' });
    }

    // Resolve assigned branches. Two cases (mirrors legacy /auth):
    //   (a) user.branch_ids has entries → use those.
    //   (b) empty / missing → "unscoped" → expand to every branch of
    //       the restaurant so the staff app can populate the dropdown
    //       from the explicit list in the JWT.
    let assignedBranchIds = [];
    if (Array.isArray(user.branch_ids) && user.branch_ids.length) {
      assignedBranchIds = user.branch_ids.map(String);
    } else {
      const allBranches = await col('branches')
        .find({ restaurant_id: String(restaurant._id) }, { projection: { _id: 1 } })
        .toArray();
      assignedBranchIds = allBranches.map((b) => String(b._id));
    }
    // Primary branch: the first assigned id, deterministically. The
    // staff app overrides this via X-Branch-Id when the operator picks
    // a different branch from the dropdown.
    const primaryBranchId = assignedBranchIds[0] || null;

    // Mint the token with the new staff_id / role_preset claims.
    const token = signStaffToken({
      userId: user._id,
      restaurantId: String(restaurant._id),
      restaurantSlug: restaurant.store_slug || null,
      branchId: primaryBranchId,
      branchIds: assignedBranchIds,
      permissions: user.permissions || {},
      tokenVersion: Number(user.token_version || 0),
      role: user.role,
      staff_id: user.staff_id || null,
      role_preset: user.role_preset || 'custom',
    });

    // Best-effort touch of last_login_at — don't block the response on
    // it. The route's hot path is the PIN check; this is bookkeeping.
    setImmediate(() => {
      col('restaurant_users').updateOne(
        { _id: user._id },
        { $set: { last_login_at: new Date() } },
      ).catch((err) => log.warn({ err: err.message, userId: user._id }, 'last_login_at update failed'));
    });

    return res.json({
      ok: true,
      token,
      staff: sanitizeStaff(user),
    });
  } catch (err) {
    log.error({ err }, 'staff login failed');
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// ─── POST /api/staff/auth/logout ─────────────────────────────────────
//
// Bearer-only transport means the server has no session to clear —
// this endpoint exists for symmetry with the web/RN client's logout
// flow, which clears its local token store and then POSTs here to log
// the event. Always 200 / { ok: true }; we don't even verify the token.
router.post('/logout', express.json(), (_req, res) => {
  return res.json({ ok: true });
});

// ─── GET /api/staff/auth/me ──────────────────────────────────────────
//
// Auth: Bearer staff JWT. Returns a fresh sanitized view of the row
// PLUS the normalised 10-key permissions object. Refetches from Mongo
// (rather than echoing the JWT claim) so a permission change made by
// an admin while the operator's session is live takes effect on the
// next /me poll.
//
// Side effect: fire-and-forget update of last_active_at AFTER res.json.
// setImmediate detaches the work from the request lifecycle so the
// response goes out immediately and a slow Mongo write doesn't pin
// the connection open.
router.get('/me', requireStaffAuth(), async (req, res) => {
  try {
    const user = await col('restaurant_users').findOne(
      { _id: req.staff.userId, is_active: true, role: { $in: STAFF_APP_ROLES } },
    );
    if (!user) {
      return res.status(401).json({ ok: false, error: 'unauthenticated' });
    }

    const sanitized = sanitizeStaff(user);
    res.json({
      ok: true,
      staff: sanitized,
      permissions: sanitized.permissions,
    });

    // Bookkeeping write — runs AFTER res.json() is on the wire. Errors
    // are swallowed; last_active_at is non-critical and a transient
    // Mongo blip shouldn't pollute logs.
    setImmediate(() => {
      col('restaurant_users').updateOne(
        { _id: req.staff.userId },
        { $set: { last_active_at: new Date() } },
      ).catch((err) => log.warn({ err: err.message, userId: req.staff.userId }, 'last_active_at update failed'));
    });
    return;
  } catch (err) {
    log.error({ err }, 'staff /me failed');
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

module.exports = router;
