// src/middleware/adminAuth.js
// Admin RBAC middleware — JWT-based auth with modular permissions.
// Replaces the old ADMIN_KEY check. ADMIN_KEY kept as super admin fallback.

'use strict';

const jwt = require('jsonwebtoken');
const { col } = require('../config/database');

const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET || 'admin-jwt-fallback-secret';

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
      const legacyKey = req.headers['x-admin-key'];

      // ── ADMIN_KEY fallback (super admin access during transition) ──
      if (!token && legacyKey && legacyKey === process.env.ADMIN_KEY) {
        req.adminUser = { role: 'super_admin', email: 'admin@gullybite.com', name: 'Admin (Legacy Key)', permissions: {} };
        req.canSeeFullPhones = true;
        return next();
      }
      if (token && token === process.env.ADMIN_KEY) {
        // Old frontend sends ADMIN_KEY as Bearer token
        req.adminUser = { role: 'super_admin', email: 'admin@gullybite.com', name: 'Admin (Legacy Key)', permissions: {} };
        req.canSeeFullPhones = true;
        return next();
      }

      if (!token) return res.status(401).json({ error: 'Authentication required' });

      // ── JWT auth ──
      let decoded;
      try {
        decoded = jwt.verify(token, ADMIN_JWT_SECRET);
      } catch (e) {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }

      // Fresh lookup (permissions may have changed since token was issued)
      const adminUser = await col('admin_users').findOne({ _id: decoded.adminId, is_active: true });
      if (!adminUser) return res.status(401).json({ error: 'Account not found or deactivated' });

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
      console.error('[AdminAuth] Middleware error:', e.message);
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
    { adminId: adminUser._id, email: adminUser.email, role: adminUser.role },
    ADMIN_JWT_SECRET,
    { expiresIn: '24h' }
  );
}

module.exports = { requireAdminAuth, requireAnyAdmin, signAdminToken, ADMIN_JWT_SECRET };
