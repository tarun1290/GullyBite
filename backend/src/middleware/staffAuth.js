'use strict';

// Per-user staff JWT auth. Each staff member has their own row in
// restaurant_users (role: 'staff') with phone + bcrypt'd PIN +
// branch_ids + permissions. The JWT carries the userId/restaurantId/
// branchIds/permissions so middleware can enforce branch + permission
// guards without re-reading the user row on every request.
//
// Uses STAFF_JWT_SECRET when set; falls back to JWT_SECRET with a
// `staff:` prefix so the same physical secret cannot be used to forge
// admin- or owner-style tokens.
//
// 30-day expiry so kitchen tablets aren't prompted for the PIN every
// shift. Token version is checked on every request — bumping the
// staff user's `token_version` invalidates every in-flight token for
// that user (used by reset-pin and soft-delete).

const jwt = require('jsonwebtoken');
const log = require('../utils/logger').child({ component: 'staffAuth' });
const { col } = require('../config/database');

function getSecret() {
  if (process.env.STAFF_JWT_SECRET) return process.env.STAFF_JWT_SECRET;
  if (process.env.JWT_SECRET) return `staff:${process.env.JWT_SECRET}`;
  const msg = 'FATAL: STAFF_JWT_SECRET (or JWT_SECRET) is not set. Staff auth cannot function.';
  log.error(msg);
  if (process.env.NODE_ENV === 'production') throw new Error(msg);
  return 'staff:dev-insecure';
}

// Per-user staff token. Required: userId + restaurantId. The token now
// carries `branchId` (singular string) — set by /api/staff/auth from
// the branch-scoped staff_access_token. Old multi-branch `branchIds`
// payloads are still accepted by the verifier for back-compat with any
// in-flight tokens issued before this change.
function signStaffToken({ userId, restaurantId, branchId, branchIds, permissions, restaurantSlug, tokenVersion }) {
  if (!userId) throw new Error('signStaffToken: userId required');
  if (!restaurantId) throw new Error('signStaffToken: restaurantId required');
  // Caller can pass either branchId (preferred, single-branch session)
  // or branchIds (back-compat). branchId wins; branchIds is dropped.
  const effectiveBranchId = branchId
    ? String(branchId)
    : (Array.isArray(branchIds) && branchIds.length === 1 ? String(branchIds[0]) : null);
  return jwt.sign(
    {
      userId: String(userId),
      restaurant_id: String(restaurantId),
      restaurant_slug: restaurantSlug ? String(restaurantSlug) : null,
      branchId: effectiveBranchId,
      permissions: permissions || {},
      token_version: typeof tokenVersion === 'number' ? tokenVersion : 0,
      role: 'staff',
    },
    getSecret(),
    { expiresIn: '30d', algorithm: 'HS256' },
  );
}

// Decode + verify a staff JWT and hydrate req.staff. Returns the
// decoded payload on success so requireStaffOrRestaurantAuth can reuse
// the verify path without duplicating logic.
async function _verifyAndLoadStaff(token) {
  let decoded;
  try {
    decoded = jwt.verify(token, getSecret(), { algorithms: ['HS256'] });
  } catch (e) {
    return { ok: false, status: 401, error: 'Invalid or expired token', reason: e.message };
  }
  if (decoded.role !== 'staff' || !decoded.userId || !decoded.restaurant_id) {
    return { ok: false, status: 401, error: 'Invalid token' };
  }
  // Token-version check: bumping `token_version` on the user row
  // invalidates every in-flight token for that staff member. Used by
  // reset-pin and soft-delete.
  const user = await col('restaurant_users').findOne(
    { _id: decoded.userId, is_active: true, role: 'staff' },
    { projection: { token_version: 1, restaurant_id: 1 } },
  );
  if (!user) return { ok: false, status: 401, error: 'Account not found or deactivated' };
  if (typeof decoded.token_version !== 'number') {
    return { ok: false, status: 401, error: 'Session expired. Please log in again.' };
  }
  const dbVer = Number(user.token_version || 0);
  if (decoded.token_version !== dbVer) {
    return { ok: false, status: 401, error: 'Session expired. Please log in again.' };
  }
  // Cross-restaurant guard: a stale JWT can't be replayed against a
  // different restaurant if the user was reassigned (shouldn't happen
  // in our model, but defence-in-depth).
  if (String(user.restaurant_id) !== String(decoded.restaurant_id)) {
    return { ok: false, status: 401, error: 'Session expired. Please log in again.' };
  }
  // Token may carry branchId (new shape, single string) OR branchIds
  // (legacy shape, array). Resolve to BOTH on the payload so downstream
  // consumers can use whichever they prefer:
  //   - branchId (new) — staff session's working branch
  //   - branchIds (back-compat) — non-empty array means "scoped to
  //     these branches"; empty means no restriction (legacy unscoped
  //     tokens, or a corrupted payload — fail-safe to no restriction)
  let branchId = null;
  let branchIds = [];
  if (decoded.branchId) {
    branchId = String(decoded.branchId);
    branchIds = [branchId];
  } else if (Array.isArray(decoded.branchIds)) {
    branchIds = decoded.branchIds.map(String);
    if (branchIds.length === 1) branchId = branchIds[0];
  }
  return {
    ok: true,
    payload: {
      userId: decoded.userId,
      restaurantId: decoded.restaurant_id,
      restaurantSlug: decoded.restaurant_slug || null,
      branchId,
      branchIds,
      permissions: decoded.permissions || {},
      role: 'staff',
    },
  };
}

function requireStaffAuth() {
  return async function staffAuthMw(req, res, next) {
    try {
      // EventSource cannot set the Authorization header, so the SSE
      // /stream endpoint also accepts ?token=<jwt>. Header path is
      // still preferred for POST/GET.
      const header = req.headers['authorization'] || '';
      let token = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (!token && req.query && typeof req.query.token === 'string') token = req.query.token;
      if (!token) return res.status(401).json({ error: 'Authentication required' });

      const result = await _verifyAndLoadStaff(token);
      if (!result.ok) {
        log.warn({ ip: req.ip, path: req.path, reason: result.reason }, 'staff auth failed');
        return res.status(result.status).json({ error: result.error });
      }
      req.staff = result.payload;
      next();
    } catch (err) {
      log.error({ err }, 'staffAuth middleware error');
      res.status(500).json({ error: 'Authentication error' });
    }
  };
}

// Combined middleware — accepts EITHER a restaurant JWT (owner/manager
// signed in via /auth/signin) OR a staff JWT (signed via /api/staff/auth).
// Sets a unified `req.actor`:
//
//   {
//     type: 'owner' | 'staff',
//     userId,           // restaurant_users _id
//     restaurantId,
//     branchIds,        // [] for owner = no restriction; array for staff
//     permissions,
//     role,
//   }
//
// Used on shared endpoints (e.g. /orders/:id/accept, /orders/:id/decline)
// where both token kinds are valid. Restaurant JWT is tried first
// because owners hitting these endpoints from the dashboard are the
// hot path.
function requireStaffOrRestaurantAuth(restaurantAuthMw) {
  if (typeof restaurantAuthMw !== 'function') {
    throw new Error('requireStaffOrRestaurantAuth: pass requireAuth as the first arg');
  }
  return async function combinedMw(req, res, next) {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Authentication required' });

    // Try restaurant JWT first. requireAuth populates req.restaurantId,
    // req.userId, req.userRole, req.userPermissions, req.userBranchIds.
    // Capture whether it succeeded by intercepting the next() callback.
    let restaurantOk = false;
    let resAlreadyHandled = false;
    await new Promise((resolve) => {
      restaurantAuthMw(req, res, (err) => {
        if (!err && req.restaurantId) restaurantOk = true;
        resolve();
      });
      // requireAuth may have called res.status(401).json(...) already
      // — that's fine, we'll fall through to the staff path below
      // unless headers are sent (handled below).
      setImmediate(() => {
        if (res.headersSent) resAlreadyHandled = true;
        resolve();
      });
    });

    if (restaurantOk) {
      req.actor = {
        type: 'owner',
        userId: req.userId || null,
        restaurantId: req.restaurantId,
        branchIds: Array.isArray(req.userBranchIds) ? req.userBranchIds : [],
        permissions: req.userPermissions || {},
        role: req.userRole || 'owner',
      };
      return next();
    }

    // requireAuth may have responded already (e.g., DB error) — bail.
    if (resAlreadyHandled || res.headersSent) return;

    const result = await _verifyAndLoadStaff(token).catch((err) => ({
      ok: false, status: 500, error: 'Authentication error', reason: err?.message,
    }));
    if (!result.ok) {
      // requireAuth probably tried to 401 already; if not we 401 here.
      if (res.headersSent) return;
      log.warn({ ip: req.ip, path: req.path, reason: result.reason }, 'combined auth failed (both paths rejected)');
      return res.status(result.status || 401).json({ error: result.error });
    }
    req.staff = result.payload;
    req.actor = {
      type: 'staff',
      userId: result.payload.userId,
      restaurantId: result.payload.restaurantId,
      branchId: result.payload.branchId,        // singular — new shape
      branchIds: result.payload.branchIds,      // back-compat array
      permissions: result.payload.permissions,
      role: 'staff',
    };
    // ALSO populate the legacy req fields so downstream middleware
    // (requireApproved, requirePermission, audit log helpers, etc.)
    // works uniformly across token types without each having to know
    // about req.actor.
    req.restaurantId = result.payload.restaurantId;
    req.userId = result.payload.userId;
    req.userRole = 'staff';
    req.userPermissions = result.payload.permissions || {};
    req.userBranchIds = result.payload.branchIds || [];
    next();
  };
}

module.exports = {
  signStaffToken,
  requireStaffAuth,
  requireStaffOrRestaurantAuth,
  getSecret,
  _verifyAndLoadStaff,
};
