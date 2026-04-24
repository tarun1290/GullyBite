// src/middleware/adminAuth.js
// Admin RBAC middleware — JWT-based auth with modular permissions.
// No fallback secrets. ADMIN_JWT_SECRET must be set in production.

'use strict';

const jwt = require('jsonwebtoken');
const { col } = require('../config/database');
const log = require('../utils/logger').child({ component: 'adminAuth' });

// ── STRICT SECRET VALIDATION ────────────────────────────────
// ADMIN_JWT_SECRET is required. No fallback — admin tokens MUST be signed
// and verified with their own secret to keep privilege separation between
// admin and customer JWTs. Missing → exit immediately so the server cannot
// start with a silently insecure config (matches the boot-time pattern in
// server.js REQUIRED_IN_PROD).
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET;
if (!ADMIN_JWT_SECRET) {
  // console.error so the message survives even if logger init fails earlier.
  console.error('FATAL: ADMIN_JWT_SECRET environment variable is not set. Admin auth cannot function.');
  log.error('FATAL: ADMIN_JWT_SECRET environment variable is not set. Admin auth cannot function.');
  process.exit(1);
}

// Permission level hierarchy (higher number = more access)
const LEVEL_VALUES = { none: 0, read: 1, write: 2, process: 2, manage: 3 };

function hasLevel(userLevel, requiredLevel) {
  return (LEVEL_VALUES[userLevel] || 0) >= (LEVEL_VALUES[requiredLevel] || 0);
}

// ─── CORE AUTH MIDDLEWARE ────────────────────────────────────
// Usage: requireAdminAuth('restaurants', 'read')
//        requireAdminAuth('send_messages')  ← boolean check
//        requireAdminAuth()                 ← just needs to be logged in
function requireAdminAuth(permission, minLevel) {
  return async (req, res, next) => {
    try {
      const header = req.headers['authorization'] || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;

      if (!token) {
        log.warn({ ip: req.ip, path: req.path }, 'Auth failed: no token provided');
        return res.status(401).json({ error: 'Authentication required' });
      }

      // ── JWT auth ──
      let decoded;
      try {
        decoded = jwt.verify(token, ADMIN_JWT_SECRET, { algorithms: ['HS256'] });
      } catch (e) {
        // Log failed attempt without exposing the token
        log.warn({ ip: req.ip, path: req.path, reason: e.message }, 'Auth failed: invalid token');
        return res.status(401).json({ error: 'Invalid or expired token' });
      }

      // Fresh lookup (permissions may have changed since token was issued)
      const adminUser = await col('admin_users').findOne({ _id: decoded.adminId, is_active: true });
      if (!adminUser) return res.status(401).json({ error: 'Account not found or deactivated' });

      // Session revocation: token_version on the JWT must match the DB.
      // Missing field on either side is treated as 0 (covers legacy tokens and docs).
      const tokenVer = Number(decoded.token_version || 0);
      const dbVer    = Number(adminUser.token_version || 0);
      if (tokenVer !== dbVer) {
        return res.status(401).json({ error: 'Session expired. Please log in again.' });
      }

      req.adminUser = adminUser;
      req.canSeeFullPhones = adminUser.role === 'super_admin' || !!adminUser.permissions?.customer_full_phone;

      // Super admin bypasses all permission checks
      if (adminUser.role === 'super_admin') return next();

      // No specific permission required — just needs to be logged in
      if (!permission) return next();

      // Boolean permission check
      const perms = adminUser.permissions || {};
      if (typeof perms[permission] === 'boolean') {
        if (!perms[permission]) return res.status(403).json({ error: "You don't have permission to access this resource" });
        return next();
      }

      // Level-based permission check
      if (minLevel) {
        const userLevel = perms[permission] || 'none';
        if (!hasLevel(userLevel, minLevel)) {
          return res.status(403).json({ error: "You don't have permission to access this resource" });
        }
      } else {
        // If no minLevel specified but permission exists, require at least 'read'
        const userLevel = perms[permission] || 'none';
        if (userLevel === 'none') {
          return res.status(403).json({ error: "You don't have permission to access this resource" });
        }
      }

      next();
    } catch (e) {
      log.error({ err: e }, 'Middleware error');
      res.status(500).json({ error: 'Authentication error' });
    }
  };
}

// Simple version — just checks that the user is any admin (no specific permission)
function requireAnyAdmin() {
  return requireAdminAuth();
}

// Sign a JWT for an admin user
function signAdminToken(adminUser) {
  return jwt.sign(
    {
      adminId: adminUser._id,
      email: adminUser.email,
      role: adminUser.role,
      token_version: adminUser.token_version ?? 0,
    },
    ADMIN_JWT_SECRET,
    { expiresIn: '24h' }
  );
}

module.exports = { requireAdminAuth, requireAnyAdmin, signAdminToken, ADMIN_JWT_SECRET };
