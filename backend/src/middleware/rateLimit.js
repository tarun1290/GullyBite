// src/middleware/rateLimit.js
// Production rate-limiting + abuse-protection layer.
//
// TWO backends live side-by-side in this file, intentionally:
//
//   1. RateLimiter (in-memory sliding window) — legacy, per-process. Kept
//      for existing callers and for the NODE_ENV=test path. Uses per-request
//      timestamp arrays so it handles bursts precisely.
//
//   2. rateLimit(key, limit, windowSec) — the NEW, spec-compliant,
//      Redis-backed fixed-window counter. Atomic INCR+EXPIRE via
//      config/redis.js (falls back to an in-memory shim when REDIS_URL is
//      unset, so tests and local dev still work). This is what the order
//      service, payment route, WA webhook and any new call-site should use.
//
// blocked_phones (Mongo) remains the durable block store for 24h auto-blocks
// from the legacy AbuseDetector. Short-lived (5–15 min) blocks from the NEW
// blockUser() API live in Redis under blocked:<id> keys — losing them on
// restart is acceptable; the 24h policy blocks are the ones that matter.

const { col, newId } = require('../config/database');
const log = require('../utils/logger').child({ component: 'rateLimit' });
const redis = require('../config/redis');

// ─── RATE LIMITER CLASS ──────────────────────────────────────────
class RateLimiter {
  constructor({ windowMs, maxRequests, keyPrefix }) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.keyPrefix = keyPrefix;
    this.store = new Map(); // key → [timestamp1, timestamp2, ...]
    // Cleanup old entries every 5 minutes
    this._cleanupInterval = setInterval(() => this._cleanup(), 5 * 60 * 1000);
    if (this._cleanupInterval.unref) this._cleanupInterval.unref();
  }

  isAllowed(key) {
    const fullKey = `${this.keyPrefix}:${key}`;
    const now = Date.now();
    const windowStart = now - this.windowMs;

    let timestamps = this.store.get(fullKey) || [];
    // Remove timestamps outside the window
    timestamps = timestamps.filter(t => t > windowStart);

    if (timestamps.length >= this.maxRequests) {
      this.store.set(fullKey, timestamps);
      return { allowed: false, remaining: 0, retryAfterMs: timestamps[0] + this.windowMs - now };
    }

    timestamps.push(now);
    this.store.set(fullKey, timestamps);
    return { allowed: true, remaining: this.maxRequests - timestamps.length };
  }

  _cleanup() {
    const now = Date.now();
    for (const [key, timestamps] of this.store) {
      const valid = timestamps.filter(t => t > now - this.windowMs);
      if (valid.length === 0) this.store.delete(key);
      else this.store.set(key, valid);
    }
  }
}

// ─── PRE-CONFIGURED LIMITERS ─────────────────────────────────────
const waMessageLimiter = new RateLimiter({
  windowMs: 60 * 1000,       // 60 seconds
  maxRequests: 30,            // 30 messages per minute per phone
  keyPrefix: 'wa_msg',
});

const waOrderLimiter = new RateLimiter({
  windowMs: 10 * 60 * 1000,  // 10 minutes
  maxRequests: 5,             // 5 orders per 10 minutes per phone
  keyPrefix: 'wa_order',
});

const apiLimiter = new RateLimiter({
  windowMs: 60 * 1000,       // 60 seconds
  maxRequests: 100,           // 100 requests per minute per IP
  keyPrefix: 'api',
});

const authLimiter = new RateLimiter({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  maxRequests: 5,             // 5 login attempts per 15 minutes per IP
  keyPrefix: 'auth',
});

// Payment limiter — protects payment-creating endpoints from rapid retry
// loops (e.g., the wallet top-up route on the restaurant dashboard).
// The customer-facing payment flow goes through WhatsApp and is already
// protected by waOrderLimiter — this one is for the restaurant operator
// hitting the Razorpay order-create endpoint from the dashboard.
const paymentLimiter = new RateLimiter({
  windowMs: 2 * 60 * 1000,   // 120 seconds
  maxRequests: 3,             // 3 payment-create attempts per 2 minutes per restaurant
  keyPrefix: 'payment',
});

// Global API limiter — platform-wide ceiling that catches "the world is on
// fire" scenarios (DDoS, runaway client retries, accidental cron storms).
// Applied IN ADDITION to apiLimiter (per-IP) so a coordinated attack from
// many IPs still gets capped at the global ceiling. Tuned for our actual
// peak traffic — tighten if production logs show legitimate bursts being
// rejected.
const globalLimiter = new RateLimiter({
  windowMs: 60 * 1000,       // 60 seconds
  maxRequests: 1000,          // 1000 requests/min globally across all IPs
  keyPrefix: 'global',
});

// ─── ABUSE DETECTOR ──────────────────────────────────────────────
// Tracks rate-limit violations; auto-blocks after threshold
class AbuseDetector {
  constructor() {
    // phone → [timestamps of rate-limit hits]
    this.violations = new Map();
    this.threshold = 10;          // violations before auto-block
    this.windowMs = 60 * 60 * 1000; // 1 hour window
    this.blockDurationMs = 30 * 60 * 1000; // 30-minute auto-block

    // Track last warning sent per phone (to avoid message amplification)
    this.lastWarning = new Map();
    this.warningCooldownMs = 5 * 60 * 1000; // 5 minutes between warnings

    // Cleanup every 10 minutes
    this._cleanupInterval = setInterval(() => this._cleanup(), 10 * 60 * 1000);
    if (this._cleanupInterval.unref) this._cleanupInterval.unref();
  }

  // Record a rate-limit violation for a phone number.
  // Returns { autoBlocked: true } if this triggers an auto-block.
  //
  // restaurantId scopes the violation: hits against restaurant A do NOT
  // count toward auto-blocks for restaurant B. The composite map key
  // ('global' fallback when restaurantId is unknown) keeps legacy callers
  // working while a per-tenant block coexists with the global-default.
  async recordViolation(waPhone, restaurantId = null) {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const mapKey = `${restaurantId || 'global'}:${waPhone}`;

    let hits = this.violations.get(mapKey) || [];
    hits = hits.filter(t => t > windowStart);
    hits.push(now);
    this.violations.set(mapKey, hits);

    if (hits.length >= this.threshold) {
      // Auto-block this phone
      try {
        const expiresAt = new Date(now + this.blockDurationMs);
        await col('blocked_phones').updateOne(
          { wa_phone: waPhone, blocked_by: 'auto', restaurant_id: restaurantId || null },
          {
            $set: {
              reason: `30-minute auto-block: ${hits.length} rate-limit violations in 1 hour`,
              blocked_at: new Date(),
              expires_at: expiresAt,
              blocked_by: 'auto',
              restaurant_id: restaurantId || null,
            },
            $setOnInsert: { _id: newId() },
          },
          { upsert: true }
        );
        this.violations.delete(mapKey);
        log.warn({ phone: waPhone.slice(-4), violations: hits.length, restaurantId: restaurantId || null }, 'Auto-blocked phone for 30min');
        return { autoBlocked: true };
      } catch (err) {
        log.error({ err }, 'Failed to auto-block phone');
      }
    }
    return { autoBlocked: false };
  }

  // Check if we can send a rate-limit warning to this phone
  canSendWarning(waPhone) {
    const lastSent = this.lastWarning.get(waPhone);
    if (lastSent && Date.now() - lastSent < this.warningCooldownMs) return false;
    this.lastWarning.set(waPhone, Date.now());
    return true;
  }

  _cleanup() {
    const now = Date.now();
    for (const [phone, hits] of this.violations) {
      const valid = hits.filter(t => t > now - this.windowMs);
      if (valid.length === 0) this.violations.delete(phone);
      else this.violations.set(phone, valid);
    }
    for (const [phone, ts] of this.lastWarning) {
      if (now - ts > this.warningCooldownMs) this.lastWarning.delete(phone);
    }
  }
}

const abuseDetector = new AbuseDetector();

// ─── BLOCKED PHONE CHECK ─────────────────────────────────────────
// [BSUID] Returns the block document if identifier (phone OR bsuid) is
// currently blocked. Per-tenant scoping: when restaurantId is provided,
// the query matches blocks scoped to that restaurant_id OR legacy
// unscoped blocks (restaurant_id missing/null) — so existing global
// rows still apply during the migration. When restaurantId is omitted
// (legacy callers, admin tooling) the query falls back to the
// pre-scoping behavior of matching any restaurant_id value.
//
// expires_at: { $gt: new Date() } guarantees expired auto-blocks stop
// blocking even if the TTL index hasn't swept the row yet (TTL runs
// once a minute and may lag).
const isPhoneBlocked = async (identifier, restaurantId = null) => {
  if (!identifier) return null;
  try {
    const query = {
      $or: [{ wa_phone: identifier }, { bsuid: identifier }],
      $and: [{ $or: [{ expires_at: null }, { expires_at: { $gt: new Date() } }] }],
    };
    if (restaurantId) {
      query.$and.push({
        $or: [
          { restaurant_id: restaurantId },
          { restaurant_id: null },
          { restaurant_id: { $exists: false } },
        ],
      });
    }
    return await col('blocked_phones').findOne(query);
  } catch {
    return null; // If DB fails, don't block — fail open
  }
};

// [BSUID] Extract sender identifier from WA webhook payload
// Returns the best available identifier (phone or BSUID)
const extractSenderIdentifier = (rawBody) => {
  try {
    const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    const contact = value?.contacts?.[0];
    // Prefer user_id (BSUID) if present, otherwise use from field
    return msg?.user_id || contact?.user_id || msg?.from || null;
  } catch {
    return null;
  }
};

// Legacy alias — still works for existing callers
const extractSenderPhone = extractSenderIdentifier;

const extractPhoneNumberId = (rawBody) => {
  try {
    const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    return body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id || null;
  } catch {
    return null;
  }
};

// ─── GENERIC FUNCTION-STYLE rateLimit() ──────────────────────────
// Spec: rateLimit(key, limit, windowSec) — increment counter, set expiry
// on first request, throw RateLimitExceededError if count > limit.
//
// Implementation note: this is a thin wrapper around RateLimiter that
// caches one limiter instance per (limit, windowSec) tuple, so two callers
// using the same limit settings share the same in-memory store. The cache
// key includes the windowMs + maxRequests so different settings get
// independent limiters.
//
// Use this for AD-HOC rate limiting where you don't want to declare a
// long-lived limiter constant. For HOT paths (webhooks, every API request)
// use the pre-configured limiters above so the cache lookup is skipped.

class RateLimitExceededError extends Error {
  constructor(key, retryAfterMs) {
    super(`Rate limit exceeded for key '${key}'`);
    this.code = 'RATE_LIMIT_EXCEEDED';
    this.key = key;
    this.retryAfterMs = retryAfterMs || 0;
    this.statusCode = 429;
  }
}

// Redis-backed fixed-window counter. INCR on every call; set EXPIRE only on
// the first hit (NX) so the window starts when the first request arrives and
// counts reset cleanly. When count > limit, throw — caller maps to HTTP 429
// or to a WhatsApp "too many requests" reply.
//
// Why fixed-window and not sliding? For the buckets the spec defines
// (5 msgs / 10s, 2 orders / 60s, etc.) the simpler counter is easier to
// reason about across processes and costs one INCR per request. Burst edge
// cases at window boundaries are acceptable at these limits.
//
// Design notes:
//   - Fail-open: if Redis is down or the key is malformed we let the request
//     through and log. Better to serve a real user than to reject on an
//     infra hiccup. If you ever need fail-closed semantics for a specific
//     endpoint, wrap the call and check the logged error code.
//   - Keys are NOT prefixed here — caller owns the namespace. The spec uses
//     `wa:<phone>`, `order:<user_id>`, `payment:<user_id>`, `auth:<ip>`,
//     `global`. Downstream greps and Redis SCAN queries rely on those
//     prefixes being stable.

/**
 * Generic function-style rate limit (Redis-backed, multi-process safe).
 *
 * @param {string} key       Fully-qualified key, e.g. `wa:${phone}`,
 *                           `order:${user_id}`, `payment:${user_id}`,
 *                           `auth:${ip}`, `global`.
 * @param {number} limit     Max requests allowed in the window
 * @param {number} windowSec Window size in seconds
 * @returns {Promise<{ remaining: number, count: number, ttl: number }>}
 *
 * @throws {RateLimitExceededError} when count > limit
 */
async function rateLimit(key, limit, windowSec) {
  if (!key || typeof key !== 'string') {
    log.warn({ key, limit, windowSec }, 'rateLimit called with missing key — fail-open');
    return { remaining: limit, count: 0, ttl: windowSec };
  }
  let count, ttl;
  try {
    const rc = await redis.getClient();
    ({ count, ttl } = await rc.incrWithTtl(`rl:${key}`, windowSec));
  } catch (err) {
    log.error({ err: err.message, key }, 'rateLimit store error — fail-open');
    return { remaining: limit, count: 0, ttl: windowSec };
  }
  if (count > limit) {
    log.warn({ key, limit, windowSec, count, ttl }, 'Rate limit hit');
    throw new RateLimitExceededError(key, ttl * 1000);
  }
  return { remaining: Math.max(0, limit - count), count, ttl };
}

// ─── BLOCKING (short-lived, Redis) ───────────────────────────────
// Separate from the Mongo-backed blocked_phones collection used for 24h
// policy blocks — these are 5-15 min cool-downs triggered by the abuse
// scorer below. Losing them on Redis restart is fine; they auto-renew on
// the next burst.

/**
 * Block an identifier (user_id, phone, IP) for N seconds.
 * Writes `blocked:<id>` with TTL. Reason is stored as the value for
 * debugging. Returns the TTL actually set.
 */
async function blockUser(id, ttlSec = 600, reason = 'abuse') {
  if (!id) return 0;
  try {
    const rc = await redis.getClient();
    await rc.set(`blocked:${id}`, String(reason), { EX: ttlSec });
    log.warn({ id, ttlSec, reason }, 'User blocked');
    return ttlSec;
  } catch (err) {
    log.error({ err: err.message, id }, 'blockUser failed');
    return 0;
  }
}

/** Returns { blocked: boolean, reason?: string, ttl?: number } */
async function isBlocked(id) {
  if (!id) return { blocked: false };
  try {
    const rc = await redis.getClient();
    const reason = await rc.get(`blocked:${id}`);
    if (!reason) return { blocked: false };
    const ttl = await rc.ttl(`blocked:${id}`);
    return { blocked: true, reason, ttl };
  } catch {
    return { blocked: false }; // fail-open
  }
}

async function unblockUser(id) {
  if (!id) return false;
  try {
    const rc = await redis.getClient();
    await rc.del(`blocked:${id}`);
    return true;
  } catch { return false; }
}

// ─── ABUSE SCORING ───────────────────────────────────────────────
// A lightweight signal aggregator. Each suspicious event bumps a score
// stored in Redis with a rolling 10-minute window. When score crosses
// ABUSE_THRESHOLD the identifier is auto-blocked for BLOCK_TTL seconds.
//
// Weighted events (tune in production based on false-positive rate):
//   rate_limit_hit_wa:    +1   (WA spam)
//   rate_limit_hit_order: +3   (ordering abuse — higher $ risk)
//   payment_failure:      +2   (card testing / stolen card)
//   invalid_auth:         +2
//
// Threshold 10 means e.g. ~10 WA rate-limit hits in 10 min, or 3-4
// payment failures, triggers a 10-min block.

const ABUSE_WINDOW_SEC = 10 * 60;
const ABUSE_THRESHOLD = 10;
const ABUSE_BLOCK_TTL = 10 * 60; // 10 minutes — within the 5–15 min spec band

const ABUSE_WEIGHTS = {
  rate_limit_hit_wa: 1,
  rate_limit_hit_order: 3,
  rate_limit_hit_payment: 3,
  rate_limit_hit_auth: 2,
  payment_failure: 2,
  invalid_auth: 2,
  message_burst: 2,
};

/**
 * Record an abuse signal. Returns { score, blocked }.
 * Blocks the identifier when the running score exceeds ABUSE_THRESHOLD.
 */
async function recordAbuseEvent(id, eventType) {
  if (!id) return { score: 0, blocked: false };
  const weight = ABUSE_WEIGHTS[eventType] || 1;
  try {
    const rc = await redis.getClient();
    // INCRBY-equivalent with TTL refresh on first write
    const key = `abuse:${id}`;
    let { count: score, ttl } = await rc.incrWithTtl(key, ABUSE_WINDOW_SEC);
    // incrWithTtl only increments by 1 — add the remainder for weighted events
    if (weight > 1) {
      for (let i = 1; i < weight; i++) await rc.incr(key);
      score += (weight - 1);
    }
    if (score >= ABUSE_THRESHOLD) {
      await blockUser(id, ABUSE_BLOCK_TTL, `abuse_score=${score} event=${eventType}`);
      await rc.del(key); // reset so the block period isn't double-counted
      log.warn({ id, score, eventType }, 'Abuse threshold reached — user blocked');
      return { score, blocked: true, ttl: ABUSE_BLOCK_TTL };
    }
    return { score, blocked: false, ttl };
  } catch (err) {
    log.error({ err: err.message, id, eventType }, 'recordAbuseEvent failed');
    return { score: 0, blocked: false };
  }
}

// ─── ADAPTIVE (TRUST-AWARE) RATE LIMIT ───────────────────────────
// Layered integration flow (matches Section 5 of the adaptive-limits spec):
//   1. isBlocked(key)  — hot-path short-circuit for flagged users
//   2. getLimits(user) — trust-tier-driven (limit, windowSec)
//   3. rateLimit(...)  — atomic counter
//   4. on overflow → recordAbuseEvent → may trigger block
//
// Buckets map to the same prefixes as the fixed helpers (wa/order/payment)
// so Redis SCAN queries and dashboards stay consistent across the two
// regimes. The tier is logged so we can see in production which users are
// being shunted into strict-mode.
async function adaptiveRateLimit(bucket, userId) {
  if (!userId) return { skipped: true };
  const trust = require('../services/trustScore');
  const key = `${bucket}:${userId}`;

  const block = await isBlocked(key);
  if (block.blocked) {
    const err = new RateLimitExceededError(key, (block.ttl || 600) * 1000);
    err.blocked = true;
    throw err;
  }

  const tierLimits = await trust.getLimits(userId);
  const pair = tierLimits[bucket === 'wa' ? 'messaging' : bucket];
  if (!pair) {
    log.warn({ bucket }, 'adaptiveRateLimit: unknown bucket — fail-open');
    return { skipped: true };
  }
  const [limit, windowSec] = pair;

  try {
    const res = await rateLimit(key, limit, windowSec);
    return { ...res, tier: tierLimits.tier, trust_score: tierLimits.trust_score, limit, windowSec };
  } catch (err) {
    if (err instanceof RateLimitExceededError) {
      const eventType = `rate_limit_hit_${bucket === 'wa' ? 'wa' : bucket}`;
      recordAbuseEvent(userId, eventType).catch(() => {});
      // A rate-limit hit is also a spam signal for the trust system —
      // nudge the score down so repeat offenders sink into strict-mode.
      // Only for wa (message spam); order/payment overflow is often just
      // an impatient user and shouldn't tank their trust.
      if (bucket === 'wa') trust.recordEvent(userId, 'spam').catch(() => {});
    }
    throw err;
  }
}

// ─── SPEC-COMPLIANT LIMITER HELPERS ──────────────────────────────
// Thin wrappers around rateLimit() that encode the limits from the spec
// in a single place, so callers don't scatter magic numbers across the
// codebase. Each helper returns the same shape as rateLimit() and throws
// RateLimitExceededError on overflow — wrap in try/catch at the call site.
//
// Spec limits:
//   wa:<phone>      5  / 10s
//   order:<user>    2  / 60s
//   payment:<user>  3  / 120s
//   auth:<ip>       10 / 60s
//   global          1000 / 60s

const limits = {
  waMessage:   (phone)  => rateLimit(`wa:${phone}`,       5,    10),
  orderCreate: (userId) => rateLimit(`order:${userId}`,   2,    60),
  payment:     (userId) => rateLimit(`payment:${userId}`, 3,    120),
  authIp:      (ip)     => rateLimit(`auth:${ip}`,        10,   60),
  global:      ()       => rateLimit('global',            1000, 60),
};

// ─── EXPRESS MIDDLEWARE FACTORY ──────────────────────────────────
// Wraps a RateLimiter instance into an Express middleware. Use this when
// adding a NEW limiter to a route — server.js already wires apiLimiter and
// authLimiter manually, but for new endpoints this factory is cleaner.
//
// Example:
//   router.post('/wallet/topup',
//     rateLimitMiddleware(paymentLimiter, req => 'restaurant:' + req.restaurantId),
//     handler);
//
// keyExtractor is a function (req) → string. Common patterns:
//   - per IP:           req => req.ip || 'unknown'
//   - per user:         req => 'user:' + req.userId
//   - per restaurant:   req => 'restaurant:' + req.restaurantId
//   - per resource:     req => 'order:' + req.params.orderId
//
// On limit exceeded, responds with HTTP 429 + Retry-After header + JSON body.
// The body shape matches the existing apiLimiter / authLimiter responses
// so frontends only need one error handler.
function rateLimitMiddleware(limiter, keyExtractor, opts = {}) {
  if (!limiter || typeof limiter.isAllowed !== 'function') {
    throw new Error('rateLimitMiddleware: first argument must be a RateLimiter instance');
  }
  if (typeof keyExtractor !== 'function') {
    throw new Error('rateLimitMiddleware: keyExtractor must be a function (req) => string');
  }
  const errorMessage = opts.message || 'Too many requests. Please try again later.';
  const exempt = typeof opts.exempt === 'function' ? opts.exempt : null;

  return function rateLimitMw(req, res, next) {
    if (exempt && exempt(req)) return next();
    let key;
    try { key = keyExtractor(req); } catch (e) { key = null; }
    if (!key) {
      // Fail-open if we couldn't extract a key — same principle as the
      // utility itself. Better to risk an unlimited request than block
      // legit traffic because of a parsing bug.
      log.warn({ path: req.path }, 'rateLimitMiddleware: key extractor returned null — fail-open');
      return next();
    }
    const result = limiter.isAllowed(key);
    if (!result.allowed) {
      const retryAfterSec = Math.ceil((result.retryAfterMs || 60000) / 1000);
      log.warn({ path: req.path, key, retryAfterSec }, 'Rate limit middleware: blocked request');
      res.set('Retry-After', String(retryAfterSec));
      res.set('X-RateLimit-Remaining', '0');
      return res.status(429).json({
        error: errorMessage,
        retry_after_seconds: retryAfterSec,
      });
    }
    res.set('X-RateLimit-Remaining', String(result.remaining));
    next();
  };
}

// ─── EXPRESS MIDDLEWARE USING rateLimit() ────────────────────────
// Convenience wrapper so routes can drop in a Redis-backed limiter with
// one line. Responds 429 + Retry-After + JSON on overflow. Checks the
// short-lived `blocked:<id>` key first so a hot-blocked user is rejected
// before the counter even increments.
//
// Example:
//   router.post('/login',
//     rateLimitFn(req => `auth:${req.ip}`, 10, 60),
//     loginHandler);
function rateLimitFn(keyFn, limit, windowSec, opts = {}) {
  const message = opts.message || 'Too many requests, please try again shortly.';
  return async function rateLimitFnMw(req, res, next) {
    let key;
    try { key = keyFn(req); } catch { key = null; }
    if (!key) return next();
    // Short-lived Redis block check
    const blockCheck = await isBlocked(key);
    if (blockCheck.blocked) {
      res.set('Retry-After', String(blockCheck.ttl || 600));
      return res.status(429).json({ error: message, blocked: true, retry_after_seconds: blockCheck.ttl });
    }
    try {
      const { remaining } = await rateLimit(key, limit, windowSec);
      res.set('X-RateLimit-Remaining', String(remaining));
      next();
    } catch (err) {
      if (err instanceof RateLimitExceededError) {
        const retryAfterSec = Math.ceil((err.retryAfterMs || windowSec * 1000) / 1000);
        // Feed the abuse scorer if the key is namespaced — the prefix
        // (wa:/order:/payment:/auth:) tells us which weight to apply.
        const prefix = key.split(':', 1)[0];
        const eventType = `rate_limit_hit_${prefix}`;
        if (ABUSE_WEIGHTS[eventType]) {
          recordAbuseEvent(key.slice(prefix.length + 1), eventType).catch(() => {});
        }
        res.set('Retry-After', String(retryAfterSec));
        return res.status(429).json({ error: message, retry_after_seconds: retryAfterSec });
      }
      next(err);
    }
  };
}

module.exports = {
  RateLimiter,
  RateLimitExceededError,
  // Legacy pre-configured (in-memory) limiters — kept for back-compat
  waMessageLimiter,
  waOrderLimiter,
  apiLimiter,
  authLimiter,
  paymentLimiter,
  globalLimiter,
  // Legacy abuse / blocking (Mongo-backed, 24h policy blocks)
  abuseDetector,
  isPhoneBlocked,
  // Webhook payload helpers
  extractSenderPhone,
  extractSenderIdentifier,
  extractPhoneNumberId,
  // Generic Redis-backed API — prefer these for new code
  rateLimit,
  limits,
  adaptiveRateLimit,
  // Short-lived Redis blocks + abuse scoring
  blockUser,
  isBlocked,
  unblockUser,
  recordAbuseEvent,
  // Express middleware factories
  rateLimitMiddleware,   // takes a RateLimiter instance
  rateLimitFn,           // takes (keyFn, limit, windowSec) — Redis-backed
};
