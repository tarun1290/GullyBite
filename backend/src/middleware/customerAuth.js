// src/middleware/customerAuth.js
// Customer-facing auth — replaces the prior X-Customer-Phone header trust
// (OWASP A01: a spoofable header was the only thing standing between any
// caller and any customer's address book / order history).
//
// Two callable surfaces:
//
//   1) Customer JWT (preferred for browser / WhatsApp Webview clients).
//      Issued by POST /api/customer/session after a Meta-verified phone
//      handshake. Verified here on every protected route.
//
//   2) Service-secret bypass (for trusted internal callers — e.g. the
//      WhatsApp Flow handler, which already has Meta-verified the phone
//      and is running inside the same trust boundary). Caller sets
//      `x-service-secret` matching CUSTOMER_SERVICE_SECRET, plus the
//      phone in `x-customer-phone`. Comparison is constant-time.
//
// No fallback secrets. Both env vars MUST be set or the process exits at
// require-time — same pattern as adminAuth.js. This guarantees a
// misconfigured deploy crash-loops loudly instead of silently accepting
// every request.

'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const customerSvc = require('../services/customer.service');
const log = require('../utils/logger').child({ component: 'customerAuth' });

// ── STRICT SECRET VALIDATION ────────────────────────────────
// Both secrets are required. No fallback to JWT_SECRET — customer tokens
// must be cryptographically distinct from restaurant-owner / admin tokens
// so that token-substitution attacks are impossible. Missing → exit
// immediately; ec2-server.js requires this module transitively at boot.
const CUSTOMER_JWT_SECRET = process.env.CUSTOMER_JWT_SECRET;
const CUSTOMER_SERVICE_SECRET = process.env.CUSTOMER_SERVICE_SECRET;
if (!CUSTOMER_JWT_SECRET) {
  console.error('FATAL: CUSTOMER_JWT_SECRET environment variable is not set. Customer auth cannot function.');
  log.error('FATAL: CUSTOMER_JWT_SECRET environment variable is not set. Customer auth cannot function.');
  process.exit(1);
}
if (!CUSTOMER_SERVICE_SECRET) {
  console.error('FATAL: CUSTOMER_SERVICE_SECRET environment variable is not set. Customer auth cannot function.');
  log.error('FATAL: CUSTOMER_SERVICE_SECRET environment variable is not set. Customer auth cannot function.');
  process.exit(1);
}

// Constant-time string compare. Plain `===` leaks information through
// response timing (early-exit on first mismatched byte). Mirrors the
// helper in routes/webhookProrouting.js.
function timingSafeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  try {
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

// Sign a customer JWT. Called by the /session handshake endpoint after
// the caller has proven possession of a Meta-verified phone. Payload is
// intentionally minimal — anything else (LTV, prefs) lives in
// customer_profiles and is fetched fresh per request.
function signCustomerToken(customer) {
  if (!customer || !customer._id || !customer.wa_phone) {
    throw new Error('signCustomerToken: customer must have _id and wa_phone');
  }
  return jwt.sign(
    {
      customerId: String(customer._id),
      phone: String(customer.wa_phone),
    },
    CUSTOMER_JWT_SECRET,
    { expiresIn: '24h' }
  );
}

// ─── MIDDLEWARE ─────────────────────────────────────────────
// Two paths checked in order:
//   1) `x-service-secret` header → trusted internal caller. Phone comes
//      from `x-customer-phone` (or body.customer_phone). Customer is
//      resolved/created via findOrCreateByPhone.
//   2) `Authorization: Bearer <jwt>` → end-user JWT issued by /session.
// Anything else → 401.
async function requireCustomerAuth(req, res, next) {
  try {
    // ── Path 1: service-secret bypass ──
    const providedServiceSecret = req.get('x-service-secret');
    if (providedServiceSecret) {
      if (!timingSafeStringEqual(providedServiceSecret, CUSTOMER_SERVICE_SECRET)) {
        log.warn({ ip: req.ip, path: req.path }, 'customer auth: invalid service secret');
        return res.status(401).json({ error: 'Customer authentication required' });
      }
      const phone = req.headers['x-customer-phone'] || req.body?.customer_phone || req.query?.customer_phone;
      if (!phone) {
        return res.status(400).json({ error: 'service-secret call missing x-customer-phone' });
      }
      const customer = await customerSvc.findOrCreateByPhone(phone);
      if (!customer) {
        return res.status(401).json({ error: 'Customer authentication required' });
      }
      req.customer = { id: String(customer._id), wa_phone: customer.wa_phone, name: customer.name || null };
      return next();
    }

    // ── Path 2: customer JWT ──
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: 'Customer authentication required' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, CUSTOMER_JWT_SECRET, { algorithms: ['HS256'] });
    } catch (e) {
      log.warn({ ip: req.ip, path: req.path, reason: e.message }, 'customer auth: invalid token');
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    if (!decoded?.customerId || !decoded?.phone) {
      return res.status(401).json({ error: 'Invalid token payload' });
    }

    // Trust the JWT payload — no DB roundtrip on every request. The
    // customer doc is keyed on the same _id and is essentially immutable
    // (display name updates aside, which can be re-fetched lazily by
    // routes that need them).
    req.customer = { id: String(decoded.customerId), wa_phone: String(decoded.phone), name: null };
    next();
  } catch (e) {
    log.error({ err: e?.message, stack: e?.stack }, 'customerAuth middleware error');
    res.status(500).json({ error: 'Authentication error' });
  }
}

module.exports = {
  signCustomerToken,
  requireCustomerAuth,
  timingSafeStringEqual,
  CUSTOMER_JWT_SECRET,
  CUSTOMER_SERVICE_SECRET,
};
