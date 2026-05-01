// src/utils/withIdempotency.js
// Response-caching idempotency wrapper.
//
// ─── WHEN TO USE THIS vs. utils/idempotency.js once() ──────────
//
// Two complementary primitives exist for idempotency in this codebase:
//
//   1. once(source, eventId) — fire-and-forget event dedup (legacy).
//      Used by webhook handlers that just need to skip duplicate events.
//      The second caller gets a "false" → silently bails out.
//      Backed by the `processed_events` collection.
//
//   2. withIdempotency(key, type, handler) — RESPONSE-CACHING dedup (this file).
//      Used when the second caller needs the SAME response as the first.
//      Primary use case: order creation. A double-click on Pay must return
//      the SAME order_id, not a new order. The second caller gets the
//      cached response from the first call.
//      Backed by the `idempotency_keys` collection.
//
// Pick `once()` for fire-and-forget; pick `withIdempotency()` when the
// caller needs a usable result back. They use SEPARATE collections so they
// can coexist without interference.
//
// ─── ALGORITHM ──────────────────────────────────────────────────
//
// withIdempotency(key, type, handler) does the following:
//
//   1. Try to atomically claim the key by inserting a 'processing' row.
//      Mongo's E11000 on the unique _id index makes this race-safe.
//
//   2a. INSERT SUCCEEDED (we are the first caller):
//        - Run handler()
//        - On success: update row to status='success', store response, return it
//        - On failure: update row to status='failed', store error, re-throw
//          (caller can retry — see retry semantics below)
//
//   2b. INSERT FAILED with E11000 (we are a duplicate caller):
//        - Look up the existing row
//        - If status='success': return the stored response (cache hit)
//        - If status='processing': wait briefly + re-check (concurrent caller)
//          Up to ~3s of polling; if still processing after that, throw a
//          'concurrent processing in flight' error so the caller can retry.
//        - If status='failed': depends on retryFailed option (see below)
//
//   3. On any non-E11000 DB error: log and FAIL OPEN — run the handler
//      anyway. The principle is the same as once(): never block business
//      operations because of a meta-tracking bug.
//
// ─── RETRY SEMANTICS ────────────────────────────────────────────
//
// Failed rows (status='failed'): by default, withIdempotency() treats them
// as retryable. The next caller with the same key will RUN the handler
// again, then overwrite the failed row with the new outcome. This matches
// most business needs — a payment that failed due to a transient network
// blip should be retryable.
//
// To make a key non-retryable on failure (e.g., invalidated coupon code,
// permanently rejected payment), pass `{ retryFailed: false }` and the
// failed row will be returned to subsequent callers as-is.
//
// ─── TTL CLEANUP ────────────────────────────────────────────────
//
// Each row has an `expires_at` field. The `idempotency_keys` collection
// has a TTL index on this field, so Mongo auto-removes rows after their
// expiry. Default TTL is 48 hours, which covers all reasonable retry
// windows for our use cases.

'use strict';

const { col } = require('../config/database');
const log = require('./logger').child({ component: 'withIdempotency' });

const COLL = 'idempotency_keys';
const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours
const PROCESSING_POLL_INTERVAL_MS = 200;
const PROCESSING_POLL_MAX_ATTEMPTS = 15; // ~3 seconds of polling

const STATUS = Object.freeze({
  PROCESSING: 'processing',
  SUCCESS:    'success',
  FAILED:     'failed',
});

/**
 * Wrap a side-effecting handler so that it runs at most once per `key`,
 * and any subsequent caller with the same key receives the cached response.
 *
 * @param {string}   key             Globally unique idempotency key. Conventional
 *                                   prefixes: 'order:', 'payment:', 'settlement:',
 *                                   'wa:', 'retry:'.
 * @param {string}   type            Coarse type tag for analytics ('order' | 'payment'
 *                                   | 'settlement' | 'webhook' | 'retry' | 'other').
 * @param {Function} handler         Async function () => Promise<any>. Whatever it
 *                                   returns will be JSON-stringified into the cached
 *                                   response and returned to future callers.
 * @param {object}   [options]
 * @param {string}   [options.referenceId]  Optional FK for analytics queries
 *                                          (e.g., the customer_id, the order_id).
 * @param {number}   [options.ttlMs]        TTL override (default 48h).
 * @param {boolean}  [options.retryFailed]  If true (default), failed rows are
 *                                          retried on the next call.
 *
 * @returns {Promise<any>} The handler's return value (either fresh or cached).
 *
 * @throws  Re-throws any error from the handler so the caller can react.
 *          Throws 'IDEMPOTENCY_PROCESSING_TIMEOUT' if a concurrent caller is
 *          still processing after the polling window expires.
 */
async function withIdempotency(key, type, handler, options = {}) {
  if (!key || typeof key !== 'string') {
    log.warn({ key, type }, 'withIdempotency called with missing key — fail-open, running handler directly');
    return handler();
  }
  if (typeof handler !== 'function') {
    throw new Error('withIdempotency: handler must be a function');
  }

  const ttlMs = options.ttlMs || DEFAULT_TTL_MS;
  const retryFailed = options.retryFailed !== false;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  // ── Step 1: try to atomically claim the key ──────────────────
  let claimed = false;
  try {
    await col(COLL).insertOne({
      _id: key,
      type: type || 'other',
      reference_id: options.referenceId || null,
      status: STATUS.PROCESSING,
      response: null,
      attempts: 1,
      created_at: now,
      updated_at: now,
      expires_at: expiresAt,
    });
    claimed = true;
  } catch (err) {
    if (err && err.code !== 11000) {
      // Unexpected DB error — fail-open. Better to risk a duplicate than
      // block the user's business operation on a meta-tracking bug.
      log.error({ err, key, type }, 'Idempotency claim failed (non-E11000) — fail-open');
      return handler();
    }
    // E11000: a row with this key already exists. Drop into the duplicate-handler path.
  }

  if (claimed) {
    // ── First caller — run the handler ─────────────────────────
    return _runHandler(key, type, handler, expiresAt);
  }

  // ── Duplicate caller — check existing row state ──────────────
  const existing = await _waitForResolution(key);
  if (!existing) {
    // Row vanished (race with TTL or another caller's failure) — start over.
    log.warn({ key }, 'Idempotency row vanished mid-resolution — falling through to retry');
    return withIdempotency(key, type, handler, options);
  }

  if (existing.status === STATUS.SUCCESS) {
    // ── Status-aware bypass for 'order' type ────────────────────
    // If the cached response references an order that has since reached
    // a terminal state (EXPIRED, CANCELLED, REJECTED_BY_RESTAURANT,
    // RESTAURANT_TIMEOUT), the cache is a dead end — handing the caller
    // back the expired order's id would anchor a fresh checkout (Meta
    // payload, payments row, etc.) to a doc no flow will ever advance.
    // Evict the row and recurse so a brand-new order is created.
    //
    // Uses globalThis._mongoClient.db('gullybite') explicitly per spec
    // — keeps the lookup pinned to the prod db even if MONGODB_DB env
    // var is overridden in some context. Lookup errors fall through
    // (return the cached response anyway, matching pre-fix behaviour)
    // so a transient db hiccup never blocks legitimate idempotency hits.
    if ((type === 'order' || (typeof key === 'string' && key.startsWith('order:'))) && existing.response) {
      const cachedOrderId =
        existing.response?._id ||
        existing.response?.id ||
        existing.reference_id;
      if (cachedOrderId) {
        const STALE_STATUSES = ['EXPIRED', 'CANCELLED', 'REJECTED_BY_RESTAURANT', 'RESTAURANT_TIMEOUT'];
        try {
          const client = globalThis._mongoClient;
          if (client) {
            const orderDoc = await client.db('gullybite').collection('orders').findOne(
              { _id: String(cachedOrderId) },
              { projection: { status: 1 } }
            );
            if (orderDoc && STALE_STATUSES.includes(orderDoc.status)) {
              log.info(
                { key, type, cachedOrderId, staleStatus: orderDoc.status },
                'Idempotency: cached order is stale, evicting cache and re-running handler'
              );
              await col(COLL).deleteOne({ _id: key }).catch(() => { /* best-effort */ });
              return withIdempotency(key, type, handler, options);
            }
          }
        } catch (lookupErr) {
          log.warn(
            { err: lookupErr?.message, key, cachedOrderId },
            'Stale-order lookup failed — returning cached response anyway'
          );
        }
      }
    }
    log.info({ key, type }, 'Idempotency hit: returning cached success response');
    return existing.response;
  }

  if (existing.status === STATUS.FAILED) {
    if (!retryFailed) {
      log.info({ key, type }, 'Idempotency hit: returning cached failure (retryFailed=false)');
      const cachedErr = new Error(existing.response?.error || 'Previous attempt failed');
      cachedErr.code = 'IDEMPOTENCY_CACHED_FAILURE';
      cachedErr.cachedFailure = true;
      throw cachedErr;
    }
    // retryFailed=true (default): atomically reclaim the row and retry.
    // We use a CAS update so two concurrent retriers can't both run.
    log.info({ key, type }, 'Idempotency: previous attempt failed, retrying');
    const reclaim = await col(COLL).updateOne(
      { _id: key, status: STATUS.FAILED },
      {
        $set: { status: STATUS.PROCESSING, updated_at: new Date() },
        $inc: { attempts: 1 },
      }
    );
    if (reclaim.modifiedCount === 0) {
      // Lost the race — another caller is now retrying. Wait for them.
      const next = await _waitForResolution(key);
      if (next && next.status === STATUS.SUCCESS) return next.response;
      if (next && next.status === STATUS.FAILED) {
        const cachedErr = new Error(next.response?.error || 'Concurrent retry failed');
        cachedErr.code = 'IDEMPOTENCY_CACHED_FAILURE';
        throw cachedErr;
      }
      const timeoutErr = new Error('Concurrent idempotent retry is still in progress');
      timeoutErr.code = 'IDEMPOTENCY_PROCESSING_TIMEOUT';
      throw timeoutErr;
    }
    return _runHandler(key, type, handler, expiresAt);
  }

  // status === 'processing' but our wait timed out → genuine concurrent in-flight
  const timeoutErr = new Error('Concurrent idempotent operation is still in progress');
  timeoutErr.code = 'IDEMPOTENCY_PROCESSING_TIMEOUT';
  throw timeoutErr;
}

// ── Helpers ───────────────────────────────────────────────────

async function _runHandler(key, type, handler, expiresAt) {
  let result;
  try {
    result = await handler();
  } catch (handlerErr) {
    // Mark the row as failed so a retry can pick it up. Store the error
    // message so retryFailed=false callers see why.
    try {
      await col(COLL).updateOne(
        { _id: key },
        {
          $set: {
            status: STATUS.FAILED,
            response: { error: (handlerErr && handlerErr.message) || String(handlerErr) },
            updated_at: new Date(),
            expires_at: expiresAt, // refresh TTL on every status change
          },
        }
      );
    } catch (updateErr) {
      log.error({ err: updateErr, key, type }, 'Failed to record idempotency failure (non-fatal)');
    }
    throw handlerErr;
  }

  // Success — store response. We JSON-roundtrip the response so anything
  // not serializable is detected at write time, not read time.
  let serializable = null;
  try {
    serializable = JSON.parse(JSON.stringify(result == null ? null : result));
  } catch (serErr) {
    log.warn({ err: serErr, key, type }, 'Idempotency response not JSON-serializable — storing null');
    serializable = null;
  }
  try {
    await col(COLL).updateOne(
      { _id: key },
      {
        $set: {
          status: STATUS.SUCCESS,
          response: serializable,
          updated_at: new Date(),
          expires_at: expiresAt,
        },
      }
    );
  } catch (updateErr) {
    log.error({ err: updateErr, key, type }, 'Failed to record idempotency success (non-fatal)');
  }
  return result;
}

/** Poll for an existing row to resolve (status !== 'processing'). Returns the
 *  row (success or failed) or null if it vanished. Used by duplicate callers
 *  to wait for the first caller to finish. */
async function _waitForResolution(key) {
  for (let i = 0; i < PROCESSING_POLL_MAX_ATTEMPTS; i++) {
    const row = await col(COLL).findOne({ _id: key });
    if (!row) return null;
    if (row.status !== STATUS.PROCESSING) return row;
    // First read shows 'processing' — sleep and retry.
    await new Promise(r => setTimeout(r, PROCESSING_POLL_INTERVAL_MS));
  }
  // Timed out — return whatever the row currently shows.
  return col(COLL).findOne({ _id: key });
}

// ── Key builders ──────────────────────────────────────────────
// Conventional key format helpers. Centralized so all callers produce
// the same shape and analytics can group by prefix.

const crypto = require('crypto');

function _hashShort(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, 16);
}

const keys = {
  // Order key built from (customer, branch, cart fingerprint). Two double-clicks
  // with the same cart contents collapse to one row.
  order(customerId, branchId, cart) {
    const lines = (cart || []).map(c => ({
      m: c.menuItemId || c.menu_item_id,
      q: c.qty || c.quantity,
      p: c.unitPriceRs || c.unit_price_rs || c.price_paise,
    }));
    lines.sort((a, b) => String(a.m).localeCompare(String(b.m)));
    const cartHash = _hashShort(JSON.stringify(lines));
    return `order:${customerId || 'unknown'}:${branchId || 'unknown'}:${cartHash}`;
  },

  // Payment key built from Razorpay's payment_id (their global unique identifier).
  payment(razorpayPaymentId) {
    return `payment:${razorpayPaymentId}`;
  },

  // Settlement key built from order_id + cycle_id (both required by spec).
  settlement(orderId, cycleId) {
    return `settlement:${orderId}:${cycleId || 'now'}`;
  },

  // Webhook key built from Meta's wa_message_id.
  webhook(messageId) {
    return `wa:${messageId}`;
  },

  // Generic retry key for cron jobs / backfills.
  retry(jobId) {
    return `retry:${jobId}`;
  },
};

module.exports = {
  withIdempotency,
  keys,
  STATUS,
  // Exposed for tests + manual operations
  _waitForResolution,
};
