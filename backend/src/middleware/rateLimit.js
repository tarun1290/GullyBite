// src/middleware/rateLimit.js
// In-memory sliding window rate limiter + abuse detection
// No Redis dependency — resets on restart (acceptable for this use case)
// blocked_phones collection in MongoDB persists across restarts

const { col, newId } = require('../config/database');
const log = require('../utils/logger').child({ component: 'rateLimit' });

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

// ─── ABUSE DETECTOR ──────────────────────────────────────────────
// Tracks rate-limit violations; auto-blocks after threshold
class AbuseDetector {
  constructor() {
    // phone → [timestamps of rate-limit hits]
    this.violations = new Map();
    this.threshold = 10;          // violations before auto-block
    this.windowMs = 60 * 60 * 1000; // 1 hour window
    this.blockDurationMs = 24 * 60 * 60 * 1000; // 24-hour auto-block

    // Track last warning sent per phone (to avoid message amplification)
    this.lastWarning = new Map();
    this.warningCooldownMs = 5 * 60 * 1000; // 5 minutes between warnings

    // Cleanup every 10 minutes
    this._cleanupInterval = setInterval(() => this._cleanup(), 10 * 60 * 1000);
    if (this._cleanupInterval.unref) this._cleanupInterval.unref();
  }

  // Record a rate-limit violation for a phone number
  // Returns { autoBlocked: true } if this triggers an auto-block
  async recordViolation(waPhone) {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    let hits = this.violations.get(waPhone) || [];
    hits = hits.filter(t => t > windowStart);
    hits.push(now);
    this.violations.set(waPhone, hits);

    if (hits.length >= this.threshold) {
      // Auto-block this phone
      try {
        const expiresAt = new Date(now + this.blockDurationMs);
        await col('blocked_phones').updateOne(
          { wa_phone: waPhone, blocked_by: 'auto' },
          {
            $set: {
              reason: `Auto-blocked: ${hits.length} rate-limit violations in 1 hour`,
              blocked_at: new Date(),
              expires_at: expiresAt,
              blocked_by: 'auto',
            },
            $setOnInsert: { _id: newId() },
          },
          { upsert: true }
        );
        this.violations.delete(waPhone);
        log.warn({ phone: waPhone.slice(-4), violations: hits.length }, 'Auto-blocked phone for 24h');
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
// [BSUID] Returns the block document if identifier (phone OR bsuid) is currently blocked
const isPhoneBlocked = async (identifier) => {
  if (!identifier) return null;
  try {
    // Check both wa_phone and bsuid fields
    return await col('blocked_phones').findOne({
      $or: [{ wa_phone: identifier }, { bsuid: identifier }],
      $and: [{ $or: [{ expires_at: null }, { expires_at: { $gt: new Date() } }] }],
    });
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

module.exports = {
  RateLimiter,
  waMessageLimiter,
  waOrderLimiter,
  apiLimiter,
  authLimiter,
  abuseDetector,
  isPhoneBlocked,
  extractSenderPhone,
  extractSenderIdentifier,
  extractPhoneNumberId,
};
