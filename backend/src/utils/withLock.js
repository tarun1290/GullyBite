// src/utils/withLock.js
// MongoDB-backed distributed lock with TTL auto-release.
//
// ─── WHEN TO USE THIS vs. the other concurrency primitives ──────
//
// GullyBite has FOUR layered concurrency primitives. Pick the one that
// matches the semantics you need:
//
//   1. Mongo unique-sparse indexes (e.g., `payouts.idempotency_key`,
//      `order_settlements.order_id`, `whatsapp_accounts.phone_number_id`)
//      → "Two writes can never coexist for the same key." Strongest guarantee.
//      Use when you have a natural unique key on the row itself.
//
//   2. Atomic CAS update (e.g., webhook-retry.js: `{ retry_status: 'pending' }
//      → { retry_status: 'retrying' }`)
//      → "Exactly one worker claims this row." Use for queue-style processing
//      where you already have a row to flip a status field on.
//
//   3. utils/idempotency.js once(source, eventId) → "First time = process,
//      duplicate = silently skip." Use for fire-and-forget webhook event dedup
//      where the second caller doesn't need a response.
//
//   4. utils/withIdempotency.js withIdempotency(key, type, handler) →
//      "First call runs the handler, duplicates receive the cached response."
//      Use when the second caller needs the SAME RESULT as the first
//      (e.g., order creation: a double-click must return the same order_id).
//
//   5. utils/withLock.js withLock(key, handler)  ← THIS FILE  → "First caller
//      runs the handler, ALL OTHERS fail fast with a 'busy' error." Use when
//      a destructive multi-step operation must NEVER overlap with itself
//      and the second caller should NOT wait for the first (e.g., catalog
//      clear-and-resync — concurrent runs would corrupt state).
//
// IMPORTANT: withLock and withIdempotency are SEPARATE concerns. They
// CAN be combined if you want both "fail fast on concurrent" AND
// "cache the result for legitimate retries":
//
//   await withIdempotency(idemKey, 'clear-resync', () =>
//     withLock(`lock:catalog-resync:${restaurantId}`, () => doIt())
//   );
//
// But most cases only need ONE of the two — pick whichever matches the
// required UX.
//
// ─── ALGORITHM ──────────────────────────────────────────────────
//
// withLock(key, handler) does the following:
//
//   1. Generate a unique owner token (so we only release locks WE acquired,
//      not locks that drifted to a new holder after our TTL expired).
//
//   2. Try insertOne({ _id: key, owner, expires_at }) — Mongo's E11000 on
//      the unique _id index gives us SETNX semantics for free.
//
//   2a. INSERT SUCCEEDED → we are the lock holder:
//        - Run handler() inside try/finally
//        - Always release the lock in finally (deleteOne with owner check)
//        - Return the handler's result
//
//   2b. INSERT FAILED with E11000 → another holder:
//        - Check if their lock is expired (TTL drift / race condition)
//        - If expired: try to atomically steal the lock via deleteOne+insertOne
//        - If still valid: throw LOCK_BUSY error (or retry with backoff)
//
//   3. ANY non-E11000 DB error: log and FAIL OPEN (run handler anyway).
//      Same principle as withIdempotency — locks are a protection layer,
//      never a gating layer.
//
// ─── DEADLOCK PREVENTION ────────────────────────────────────────
//
// The TTL index on `locks.expires_at` is the safety net. If a process
// crashes while holding a lock, Mongo auto-deletes the row at the TTL
// expiry — at most a few seconds of contention.
//
// Within this utility:
//   • Default TTL is 10 seconds (short — adjust per use case)
//   • The handler is NEVER run while holding more than one lock
//   • The release is in a finally block so it runs even on handler error
//   • The release uses an owner-check so we never delete someone else's lock
//     after our TTL drifts past expiry

'use strict';

const crypto = require('crypto');
const { col } = require('../config/database');
const log = require('./logger').child({ component: 'withLock' });

const COLL = 'locks';
const DEFAULT_TTL_MS    = 10 * 1000;        // 10s — short by design
const DEFAULT_RETRIES   = 0;                // fail-fast by default
const DEFAULT_RETRY_MS  = 100;
const MAX_TTL_MS        = 5 * 60 * 1000;    // 5min ceiling — anything longer is a code smell

class LockBusyError extends Error {
  constructor(key, holder) {
    super(`Resource is busy: lock '${key}' is held by another process`);
    this.code = 'LOCK_BUSY';
    this.lockKey = key;
    this.holder = holder || null;
  }
}

/**
 * Run a handler under a distributed mutual-exclusion lock.
 *
 * @param {string}   key     Globally unique lock key. Use a namespaced format
 *                           like 'catalog-resync:{restaurantId}' so different
 *                           operations and tenants don't collide.
 * @param {Function} handler Async function () => Promise<any>. Runs while
 *                           the lock is held. Whatever it returns is what
 *                           withLock returns.
 * @param {object}   [opts]
 * @param {number}   [opts.ttlMs]      Lock TTL in milliseconds (default 10s,
 *                                      capped at 5min). Should always be
 *                                      LONGER than the handler's expected
 *                                      runtime, otherwise the lock could
 *                                      drift to another holder mid-run.
 * @param {number}   [opts.retries]    Number of times to retry acquisition
 *                                      before throwing LOCK_BUSY (default 0).
 * @param {number}   [opts.retryMs]    Delay between retries (default 100ms).
 * @param {string}   [opts.type]       Coarse type tag for analytics
 *                                      ('catalog-resync', 'cron-job', etc.)
 *
 * @returns {Promise<any>} The handler's return value.
 *
 * @throws {LockBusyError} If the lock cannot be acquired after `retries`
 *                          attempts. Inspect `err.code === 'LOCK_BUSY'`.
 */
async function withLock(key, handler, opts = {}) {
  if (!key || typeof key !== 'string') {
    log.warn({ key }, 'withLock called with missing key — fail-open, running handler directly');
    return handler();
  }
  if (typeof handler !== 'function') {
    throw new Error('withLock: handler must be a function');
  }

  const ttlMs    = Math.min(opts.ttlMs || DEFAULT_TTL_MS, MAX_TTL_MS);
  const retries  = Math.max(0, opts.retries == null ? DEFAULT_RETRIES : opts.retries);
  const retryMs  = Math.max(10, opts.retryMs || DEFAULT_RETRY_MS);
  const type     = opts.type || 'lock';
  const owner    = crypto.randomBytes(16).toString('hex');

  const startedAt = Date.now();
  let acquired   = false;
  let attempts   = 0;

  // ── Acquisition loop ─────────────────────────────────────────
  while (!acquired) {
    attempts++;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    try {
      await col(COLL).insertOne({
        _id: key,
        owner,
        type,
        acquired_at: now,
        expires_at: expiresAt,
      });
      acquired = true;
      log.info({ key, owner: owner.slice(0, 8), ttlMs, attempts }, 'Lock acquired');
      break;
    } catch (err) {
      if (!err || err.code !== 11000) {
        // Unexpected DB error — fail-open. Same principle as withIdempotency:
        // never block business operations because of a meta-tracking bug.
        log.error({ err, key }, 'Lock acquire failed (non-E11000) — fail-open, running handler');
        return handler();
      }

      // E11000: someone else holds this lock. Check if their lock is stale
      // (TTL drift before Mongo's TTL sweeper has run). If so, try to steal.
      const existing = await col(COLL).findOne({ _id: key }).catch(() => null);
      if (existing && existing.expires_at && new Date(existing.expires_at) < now) {
        // Stale lock — atomically delete + reinsert. We use a CAS-style
        // delete (matching the stale owner) so two concurrent stealers can't
        // both succeed.
        const stolen = await col(COLL).deleteOne({
          _id: key,
          owner: existing.owner,
          expires_at: existing.expires_at,
        }).catch(() => ({ deletedCount: 0 }));
        if (stolen.deletedCount > 0) {
          log.warn({ key, staleOwner: existing.owner.slice(0, 8) }, 'Stole stale lock — original holder TTL expired');
          // Loop back and try insertOne again. We do NOT count this as a
          // retry because it's an immediate continuation of the acquire.
          continue;
        }
        // Lost the steal race — fall through to retry/fail
      }

      if (attempts > retries) {
        log.warn({ key, holder: existing && existing.owner ? existing.owner.slice(0, 8) : null, attempts, elapsedMs: Date.now() - startedAt }, 'Lock busy after retries — failing fast');
        throw new LockBusyError(key, existing && existing.owner ? existing.owner : null);
      }
      // Retry with backoff
      log.info({ key, attempt: attempts, retries }, 'Lock busy — retrying');
      await new Promise(r => setTimeout(r, retryMs));
    }
  }

  // ── Run the handler under the held lock ─────────────────────
  let result;
  try {
    result = await handler();
  } finally {
    // Always release. Owner-check ensures we never delete a lock that
    // drifted to a new holder after our TTL expired (which would be a
    // double-release bug).
    try {
      const r = await col(COLL).deleteOne({ _id: key, owner });
      const heldMs = Date.now() - startedAt;
      if (r.deletedCount > 0) {
        log.info({ key, owner: owner.slice(0, 8), heldMs }, 'Lock released');
      } else {
        // Our lock was already gone — either someone stole it (TTL drift)
        // or the TTL sweeper got there first. Log loudly because the
        // handler may have produced inconsistent state.
        log.warn({ key, owner: owner.slice(0, 8), heldMs }, 'Lock release: row already gone — possible TTL drift, handler may have raced with another holder');
      }
    } catch (releaseErr) {
      log.error({ err: releaseErr, key }, 'Lock release failed (non-fatal)');
    }
  }
  return result;
}

// ── Key builders ──────────────────────────────────────────────
// Conventional namespaced key formats so analytics and grep can group
// related locks. Always include the tenant id where applicable.

const keys = {
  catalogResync(restaurantId) { return `catalog-resync:${restaurantId}`; },
  cronJob(jobName)            { return `cron:${jobName}`; },
  manualSync(restaurantId)    { return `manual-sync:${restaurantId}`; },
  bulkImport(restaurantId, importId) { return `bulk-import:${restaurantId}:${importId}`; },
};

module.exports = {
  withLock,
  keys,
  LockBusyError,
};
