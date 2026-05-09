'use strict';

// ─── Staff permission + branch-access middleware ────────────────
//
// Two factories:
//
//   requirePermission(key)
//     - Owners (req.actor.type === 'owner' OR req.userRole === 'owner')
//       bypass the check unconditionally. They are presumed to have all
//       10 staff permissions; the legacy owner ROLE_PERMISSIONS map in
//       routes/auth.js continues to gate owner-only operations
//       (manage_users, view_analytics, etc.) — those are intentionally
//       NOT in the 10-key staff contract.
//     - Otherwise checks req.staff.permissions[key] === true. On fail
//       responds 403 { ok:false, error:'forbidden', missing_permission }.
//
//   requireBranchAccess(branchIdSource)
//     - branchIdSource may be a STRING (req.params key name, e.g. 'id')
//       or a FUNCTION (req) => string|null|undefined for body / query
//       extraction.
//     - Owners bypass. Staff: the resolved branch_id must be in
//       req.staff.branch_ids OR req.staff.branchIds. Missing branch_id
//       (the source returned null/undefined) → next() — the route
//       handler is expected to enforce its own validation. We don't
//       block the request just because a query param was absent.
//
// Both middlewares ASSUME requireStaffAuth or requireStaffOrRestaurantAuth
// has run before them. They never call those themselves — the route
// definition is responsible for the auth → permission → branch chain
// order. Calling these without auth-set state will 401 (no req.staff
// AND no owner actor → can't make a decision → fail closed).
//
// USAGE EXAMPLES:
//
//   // Order accept — both owner JWT (manager dashboard) and staff JWT
//   // (cashier tablet) are accepted, branch resolved from the order doc.
//   router.post('/orders/:id/accept',
//     requireStaffOrRestaurantAuth(requireAuth),
//     requirePermission('accept_orders'),
//     requireBranchAccess(async (req) => {
//       const o = await col('orders').findOne({ _id: req.params.id }, { projection: { branch_id: 1 } });
//       return o?.branch_id;
//     }),
//     handler,
//   );
//
//   // Branch settings — branch id straight from :id param.
//   router.post('/branches/:id/settings',
//     requireStaffOrRestaurantAuth(requireAuth),
//     requirePermission('manage_settings'),
//     requireBranchAccess('id'),
//     handler,
//   );
//
// On the 403 response shape: { ok:false, ... } intentionally diverges
// from the older { error: 'string' } shape used elsewhere in the
// codebase. The new staff CRUD + permission contract is `{ ok, ... }`
// across the board (per the patched contract); callers translating
// from the old shape should accept both during the migration window.

/**
 * Permission gate for staff-app routes. Owners bypass; staff need the
 * specified key to be true on their JWT permissions blob.
 *
 * @param {string} key — one of STAFF_PERMISSION_KEYS
 * @returns {import('express').RequestHandler}
 */
function requirePermission(key) {
  if (!key || typeof key !== 'string') {
    throw new Error('requirePermission: key must be a non-empty string');
  }
  return function requirePermissionMw(req, res, next) {
    // Owner bypass — covers BOTH actor-style (req.actor set by
    // requireStaffOrRestaurantAuth) and legacy req.userRole-style
    // (set by routes/auth.js requireAuth direct).
    const isOwner = (req.actor && req.actor.type === 'owner')
      || req.userRole === 'owner';
    if (isOwner) return next();

    // Staff path — check the JWT permissions blob. Defensive on shape:
    // req.staff may be undefined if the middleware was invoked without
    // auth above; treat that as a forbidden (fail closed).
    const perms = (req.staff && req.staff.permissions)
      || (req.actor && req.actor.permissions)
      || req.userPermissions
      || null;
    if (perms && perms[key] === true) return next();
    return res.status(403).json({
      ok: false,
      error: 'forbidden',
      missing_permission: key,
    });
  };
}

// Resolve the branch id to check from a string key (req.params lookup)
// or a function (req) => id. Functions may return a Promise — we await
// before continuing. Anything falsy (null/undefined/empty string) is
// treated as "no branch context to check" and the middleware passes
// through; the route handler is then responsible for its own validation.
async function _resolveBranchId(source, req) {
  if (typeof source === 'string') {
    return req.params ? req.params[source] : null;
  }
  if (typeof source === 'function') {
    return await source(req);
  }
  return null;
}

/**
 * Branch-access gate. Owners bypass; staff need the resolved branch id
 * to be a member of their assigned set (req.staff.branch_ids or
 * req.staff.branchIds — both shapes tolerated for back-compat with the
 * existing JWT verifier).
 *
 * @param {string | ((req: import('express').Request) => string | Promise<string>)} branchIdSource
 * @returns {import('express').RequestHandler}
 */
function requireBranchAccess(branchIdSource) {
  if (!branchIdSource
    || (typeof branchIdSource !== 'string' && typeof branchIdSource !== 'function')) {
    throw new Error('requireBranchAccess: source must be a string param name or a function');
  }
  return async function requireBranchAccessMw(req, res, next) {
    try {
      const isOwner = (req.actor && req.actor.type === 'owner')
        || req.userRole === 'owner';
      if (isOwner) return next();

      const branchId = await _resolveBranchId(branchIdSource, req);
      // Missing branch context — pass through (handler validates).
      if (!branchId) return next();

      const assigned = (req.staff && (req.staff.branch_ids || req.staff.branchIds))
        || (req.actor && req.actor.branchIds)
        || req.userBranchIds
        || [];
      const assignedStr = Array.isArray(assigned) ? assigned.map(String) : [];
      if (assignedStr.includes(String(branchId))) return next();
      return res.status(403).json({
        ok: false,
        error: 'forbidden',
        missing_branch_access: String(branchId),
      });
    } catch (err) {
      // Resolver threw (e.g. DB error inside the function form). We
      // surface a 500 rather than passing through — passing through
      // would let an attacker provoke errors on the resolver to bypass
      // the gate. Fail closed.
      return res.status(500).json({
        ok: false,
        error: 'internal',
        message: 'branch access check failed',
      });
    }
  };
}

module.exports = {
  requirePermission,
  requireBranchAccess,
};
