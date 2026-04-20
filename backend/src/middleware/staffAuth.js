'use strict';

// Staff POS auth middleware. JWTs carry restaurant_id, restaurant_slug,
// and role:'staff'. 30-day expiry so tablets in the kitchen aren't
// prompted for the PIN every shift.
//
// Uses STAFF_JWT_SECRET when set; falls back to JWT_SECRET with a
// `staff:` prefix so the same physical secret cannot be used to forge
// admin-style tokens.

const jwt = require('jsonwebtoken');
const log = require('../utils/logger').child({ component: 'staffAuth' });

function getSecret() {
  if (process.env.STAFF_JWT_SECRET) return process.env.STAFF_JWT_SECRET;
  if (process.env.JWT_SECRET) return `staff:${process.env.JWT_SECRET}`;
  const msg = 'FATAL: STAFF_JWT_SECRET (or JWT_SECRET) is not set. Staff auth cannot function.';
  log.error(msg);
  if (process.env.NODE_ENV === 'production') throw new Error(msg);
  return 'staff:dev-insecure';
}

function signStaffToken({ restaurantId, restaurantSlug }) {
  if (!restaurantId) throw new Error('signStaffToken: restaurantId required');
  return jwt.sign(
    {
      restaurant_id: String(restaurantId),
      restaurant_slug: restaurantSlug ? String(restaurantSlug) : null,
      role: 'staff',
    },
    getSecret(),
    { expiresIn: '30d', algorithm: 'HS256' }
  );
}

function requireStaffAuth() {
  return function staffAuthMw(req, res, next) {
    try {
      // Allow query-param token for SSE endpoints — EventSource can't set
      // Authorization headers. Header path is still preferred for POST/GET.
      const header = req.headers['authorization'] || '';
      let token = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (!token && req.query && typeof req.query.token === 'string') token = req.query.token;
      if (!token) return res.status(401).json({ error: 'Authentication required' });

      let decoded;
      try {
        decoded = jwt.verify(token, getSecret(), { algorithms: ['HS256'] });
      } catch (e) {
        log.warn({ ip: req.ip, path: req.path, reason: e.message }, 'staff auth: invalid token');
        return res.status(401).json({ error: 'Invalid or expired token' });
      }
      if (decoded.role !== 'staff' || !decoded.restaurant_id) {
        return res.status(401).json({ error: 'Invalid token' });
      }
      req.staff = {
        restaurantId: decoded.restaurant_id,
        restaurantSlug: decoded.restaurant_slug || null,
      };
      next();
    } catch (err) {
      log.error({ err }, 'staffAuth middleware error');
      res.status(500).json({ error: 'Authentication error' });
    }
  };
}

module.exports = { signStaffToken, requireStaffAuth, getSecret };
