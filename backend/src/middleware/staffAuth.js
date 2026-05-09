'use strict';

// Per-user staff JWT auth. Each staff member has their own row in
// restaurant_users (role in STAFF_APP_ROLES) with phone + bcrypt'd PIN +
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

// Roles permitted to authenticate via the staff-app /api/staff/auth
// flow. Both 'staff' and 'manager' use the same PIN-based login and
// JWT shape; they diverge only in client-side feature gating (manager
// sees branch toggle / daily summary / etc.). Owners use a separate
// /auth/signin path and don't appear here. Order matters: index 0 is
// the safe fallback when a malformed signStaffToken caller omits role.
const STAFF_APP_ROLES = ['staff', 'manager'];

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
function signStaffToken({ userId, restaurantId, branchId, branchIds, permissions, restaurantSlug, tokenVersion, role }) {
  if (!userId) throw new Error('signStaffToken: userId required');
  if (!restaurantId) throw new Error('signStaffToken: restaurantId required');
  // Two complementary fields on the token now:
  //   branchId (singular)  — the "primary" branch the operator logged
  //                          in via (the staff_access_token's branch).
  //                          Used as the default scope when no
  //                          X-Branch-Id header is sent.
  //   branchIds (array)    — every branch the operator has access to.
  //                          The staff app reads this to populate the
  //                          branch-selector dropdown and the backend
  //                          uses it to validate X-Branch-Id values.
  // Pre-2026-05-09 only branchId was emitted; sessions issued before
  // this change carry no branchIds claim and the verify path falls
  // back to [branchId] for them.
  const effectiveBranchId = branchId
    ? String(branchId)
    : (Array.isArray(branchIds) && branchIds.length === 1 ? String(branchIds[0]) : null);
  // Normalize + dedupe the assigned set. Falls back to [branchId] when
  // the caller didn't pass an array, so older callers that still only
  // know about the singular field continue to work.
  const effectiveBranchIds = (() => {
    const seen = new Set();
    const out = [];
    if (Array.isArray(branchIds)) {
      for (const b of branchIds) {
        const s = String(b);
        if (s && !seen.has(s)) { seen.add(s); out.push(s); }
      }
    }
    if (out.length === 0 && effectiveBranchId) {
      out.push(effectiveBranchId);
      seen.add(effectiveBranchId);
    }
    return out;
  })();
  // role on the token reflects the row in restaurant_users — currently
  // 'staff' or 'manager' (post-2026-05-09 role-filter widening). Pinned
  // to one of the STAFF_APP_ROLES values; any other input (or absence)
  // falls back to STAFF_APP_ROLES[0] so a misconfigured caller can't
  // mint elevated tokens.
  const effectiveRole = STAFF_APP_ROLES.includes(role) ? role : STAFF_APP_ROLES[0];
  return jwt.sign(
    {
      userId: String(userId),
      restaurant_id: String(restaurantId),
      restaurant_slug: restaurantSlug ? String(restaurantSlug) : null,
      branchId: effectiveBranchId,
      branchIds: effectiveBranchIds,
      permissions: permissions || {},
      token_version: typeof tokenVersion === 'number' ? tokenVersion : 0,
      role: effectiveRole,
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
  if (!STAFF_APP_ROLES.includes(decoded.role) || !decoded.userId || !decoded.restaurant_id) {
    return { ok: false, status: 401, error: 'Invalid token' };
  }
  // Token-version check: bumping `token_version` on the user row
  // invalidates every in-flight token for that staff member. Used by
  // reset-pin and soft-delete.
  const user = await col('restaurant_users').findOne(
    { _id: decoded.userId, is_active: true, role: { $in: STAFF_APP_ROLES } },
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
  // Token shape post-2026-05-09:
  //   branchId  — primary (the branch the operator logged in via). Used
  //               as the default scope when no X-Branch-Id header is sent.
  //   branchIds — full assigned access set. Used to validate X-Branch-Id
  //               header values (must be a member) and for the staff
  //               app's branch-selector dropdown.
  // Legacy tokens (pre-fix) carry only branchId. We backfill branchIds
  // to [branchId] for those so the access-set check still works.
  let branchId = null;
  let branchIds = [];
  if (decoded.branchId) {
    branchId = String(decoded.branchId);
  }
  if (Array.isArray(decoded.branchIds) && decoded.branchIds.length) {
    branchIds = decoded.branchIds.map(String);
    if (!branchId) branchId = branchIds[0];
  } else if (branchId) {
    branchIds = [branchId];
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
      // Pass the actual role through (already gated by the
      // STAFF_APP_ROLES check above) so manager sessions don't get
      // demoted to 'staff' downstream — useRole on the staff app and
      // any role-aware backend gate reads this field.
      role: decoded.role,
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
    //
    // Detection strategy: requireAuth always exits one of two ways —
    //   (a) calls next() with no error, having set req.restaurantId
    //   (b) calls res.status(N).json({...}) without calling next()
    // We resolve the Promise on whichever fires first, with no timer
    // involved. To detect path (b) we wrap res.json for the duration
    // of restaurantAuthMw — the wrapper records that a response was
    // sent, then forwards to the original so the 401 still lands on
    // the client. Restored on both exit paths so the route handler /
    // staff path see the unwrapped writer.
    let restaurantOk = false;
    let resAlreadyHandled = false;
    await new Promise((resolve) => {
      let settled = false;
      const safeResolve = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const originalJson = res.json.bind(res);
      res.json = function interceptedJson(body) {
        // Restore first so a subsequent (legitimate) res.json call
        // anywhere downstream goes straight to the original writer.
        res.json = originalJson;
        resAlreadyHandled = true;
        const ret = originalJson(body);
        safeResolve();
        return ret;
      };

      restaurantAuthMw(req, res, (err) => {
        // Restore in case next() fired without res.json being called
        // (the success path). Idempotent if the intercept already
        // restored.
        res.json = originalJson;
        if (!err && req.restaurantId) restaurantOk = true;
        safeResolve();
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
      // Pass through actual role (staff or manager) so role-aware
      // gates downstream see manager when applicable, instead of the
      // hardcoded 'staff' the pre-fix combined-auth always wrote.
      role: result.payload.role,
    };
    // ALSO populate the legacy req fields so downstream middleware
    // (requireApproved, requirePermission, audit log helpers, etc.)
    // works uniformly across token types without each having to know
    // about req.actor.
    req.restaurantId = result.payload.restaurantId;
    req.userId = result.payload.userId;
    req.userRole = result.payload.role;
    req.userPermissions = result.payload.permissions || {};
    req.userBranchIds = result.payload.branchIds || [];
    next();
  };
}

// Resolve which branches the current request should query against.
// Reads X-Branch-Id from the request; validates against the staff
// session's assigned access set (req.staff.branchIds).
//
//   header missing → default to req.staff.branchId (back-compat for
//                    pre-multi-branch clients that didn't set the
//                    header). Returns scope.branchIds = [primary].
//   header = 'all' → cross-branch query across the entire access set.
//                    Returns scope.branchIds = full assigned array.
//   header = <id>  → single-branch filter. The id MUST be a member of
//                    the assigned set; otherwise 403. Returns
//                    scope.branchIds = [id].
//
// Endpoint usage:
//   const scope = resolveBranchScope(req);
//   if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
//   filter.branch_id = { $in: scope.branchIds };
//
// For single-resource endpoints (e.g. /orders/:id/status), use
// scope.branchIds as the membership-check set instead of the legacy
// req.staff.branchIds — that way "all" mode and an explicit single
// branch both validate correctly.
function resolveBranchScope(req) {
  const assigned = (req.staff && Array.isArray(req.staff.branchIds))
    ? req.staff.branchIds.map(String)
    : [];
  const primary = req.staff?.branchId ? String(req.staff.branchId) : null;
  const headerRaw = req.get('x-branch-id');
  const header = typeof headerRaw === 'string' ? headerRaw.trim() : '';

  if (!header) {
    // No header — fall back to primary (or full set if no primary,
    // which shouldn't happen for any normally-issued token).
    const branchIds = primary ? [primary] : assigned;
    return { ok: true, scope: 'single', branchIds, header: null };
  }
  if (header.toLowerCase() === 'all') {
    return { ok: true, scope: 'all', branchIds: assigned, header: 'all' };
  }
  if (!assigned.includes(header)) {
    return { ok: false, status: 403, error: 'Branch not in your access set' };
  }
  return { ok: true, scope: 'single', branchIds: [header], header };
}

module.exports = {
  signStaffToken,
  requireStaffAuth,
  requireStaffOrRestaurantAuth,
  getSecret,
  _verifyAndLoadStaff,
  resolveBranchScope,
  STAFF_APP_ROLES,
};
