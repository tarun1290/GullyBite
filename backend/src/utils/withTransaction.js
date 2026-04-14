// src/utils/withTransaction.js
// Thin wrapper around MongoDB session transactions with structured logging
// and a graceful fallback for standalone (non-replica-set) dev Mongo.
//
// ─── WHY NOT JUST USE db.transaction() DIRECTLY ─────────────────
//
// config/database.js already exposes a `transaction(fn)` helper. This
// wrapper adds two things on top:
//
//   1. START / COMMIT / ABORT logging with duration + label. Makes it
//      possible to audit "which txns ran this request" in production and
//      debug aborts that used to be silent.
//
//   2. Fallback path for local dev where Mongo runs as a standalone
//      (no replica set). The driver rejects session.startTransaction()
//      with "Transaction numbers are only allowed on a replica set
//      member or mongos". In that mode we log once and run fn(null) —
//      every collection op skips the session, so the code path still
//      works for tests and local hacking. PRODUCTION runs on Atlas /
//      a replica set and gets real ACID transactions.
//
// ─── INTEGRATION ORDER ──────────────────────────────────────────
//
// The spec calls for: withIdempotency → withLock → transaction → commit.
// That's the outside-in nesting. Example:
//
//   await withIdempotency(idemKey, 'order', () =>
//     withLock(`order:${customerId}`, () =>
//       withTransaction(async (session) => {
//         await col('orders').insertOne(order, { session });
//         await col('order_items').insertMany(items, { session });
//       }, { label: 'createOrder' })
//     )
//   );
//
// Order matters: idempotency is the outer shield (dedup + cached result),
// lock is the next (fail-fast on concurrent), transaction is innermost
// (atomic multi-doc write). Flipping any pair changes semantics.

'use strict';

const { transaction: _transactionNative } = require('../config/database');
const log = require('./logger').child({ component: 'txn' });

// Shared flag: once the cluster tells us it's not a replica set, stop
// trying. Saves a round-trip per txn in local dev.
let _standaloneDetected = false;

/**
 * Run `fn(session)` inside a MongoDB transaction.
 * @param {(session: any) => Promise<any>} fn
 * @param {{ label?: string, session?: any }} opts
 *     label  — short identifier for logs ("createOrder", "settlement")
 *     session — if a caller already has an open session (nested call),
 *               reuse it instead of starting a new one. The outer caller
 *               owns commit/abort in that case.
 */
async function withTransaction(fn, opts = {}) {
  const label = opts.label || 'anon';
  // Nested — reuse the parent session; parent will commit.
  if (opts.session) return fn(opts.session);

  // Standalone path — we've already detected no-replica-set, just run.
  if (_standaloneDetected) return fn(null);

  const started = Date.now();
  log.debug({ label }, 'txn start');
  try {
    const result = await _transactionNative(async (session) => fn(session));
    log.info({ label, ms: Date.now() - started }, 'txn commit');
    return result;
  } catch (err) {
    const msg = err && err.message ? err.message : '';
    // Standalone Mongo — log once, flip the flag, retry without session.
    // The error code varies by driver version; match on the stable text.
    if (msg.includes('replica set') || msg.includes('Transaction numbers are only allowed')) {
      _standaloneDetected = true;
      log.warn({ label }, 'MongoDB is standalone (no replica set) — running without transaction. Production must be replica set for ACID.');
      return fn(null);
    }
    log.warn({ label, ms: Date.now() - started, err: msg }, 'txn abort');
    throw err;
  }
}

module.exports = { withTransaction };
