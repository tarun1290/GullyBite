// src/core/settlementStateEngine.js
// Strict settlement lifecycle state machine.
//
// Mirrors core/orderStateEngine.js — same atomic-CAS transition pattern.
// Recovery jobs rely on being able to find settlements stuck in PROCESSING
// past a threshold, so every transition must go through this engine so
// timestamps are reliable.
//
//   INITIATED  — row inserted, not yet handed to Razorpay
//   PROCESSING — payout call made, awaiting Razorpay callback
//   COMPLETED  — payout.processed / fund_account.processed received
//   FAILED     — payout rejected / terminal failure
//
// Transitions:
//   INITIATED  → PROCESSING | FAILED
//   PROCESSING → COMPLETED  | FAILED
//   COMPLETED  → (terminal)
//   FAILED     → PROCESSING   (retry allowed by recovery job)
//
// FAILED → PROCESSING is the retry lane that the stuck-settlement
// recovery job walks down. Without it, a transient Razorpay outage would
// permanently strand a settlement row.

'use strict';

const { col } = require('../config/database');
const log = require('../utils/logger').child({ component: 'settlementState' });

const STATES = ['INITIATED', 'PROCESSING', 'COMPLETED', 'FAILED'];

const TRANSITIONS = {
  INITIATED:  new Set(['PROCESSING', 'FAILED']),
  PROCESSING: new Set(['COMPLETED', 'FAILED']),
  COMPLETED:  new Set([]),
  FAILED:     new Set(['PROCESSING']), // retry
};

const STATE_TIMESTAMP = {
  PROCESSING: 'processing_at',
  COMPLETED:  'completed_at',
  FAILED:     'failed_at',
};

function isValidTransition(current, next) {
  if (!STATES.includes(current)) return { valid: false, reason: `unknown: ${current}` };
  if (!STATES.includes(next))    return { valid: false, reason: `unknown: ${next}` };
  if (current === next)          return { valid: false, reason: 'no-op' };
  if (!TRANSITIONS[current].has(next)) {
    return { valid: false, reason: `${current} → ${next} not allowed` };
  }
  return { valid: true };
}

/**
 * Atomic state transition — the only supported way to change a
 * settlement's `state` field. Uses a conditional updateOne so two workers
 * can race and exactly one will win; the loser gets matchedCount=0 and
 * learns the current state by reading the row.
 *
 * @param {string} settlementId
 * @param {string} next
 * @param {{ metadata?: object, actor?: string, session?: any }} opts
 */
async function transitionSettlement(settlementId, next, opts = {}) {
  const sess = opts.session ? { session: opts.session } : {};
  const row = await col('settlements').findOne({ _id: settlementId }, sess);
  if (!row) throw new Error(`settlement not found: ${settlementId}`);
  const current = row.state || 'INITIATED';

  const check = isValidTransition(current, next);
  if (!check.valid) {
    log.warn({ settlementId, current, next, reason: check.reason }, 'invalid settlement transition');
    const err = new Error(`Invalid settlement transition: ${check.reason}`);
    err.code = 'INVALID_TRANSITION';
    err.current = current;
    throw err;
  }

  const now = new Date();
  const setFields = { state: next, updated_at: now };
  if (STATE_TIMESTAMP[next]) setFields[STATE_TIMESTAMP[next]] = now;
  if (opts.metadata) setFields.last_metadata = opts.metadata;

  const result = await col('settlements').updateOne(
    { _id: settlementId, state: current },
    { $set: setFields },
    sess
  );
  if (result.matchedCount === 0) {
    // Lost the race to a concurrent worker. Caller checks .raced flag.
    log.warn({ settlementId, current, next }, 'settlement transition raced');
    return { raced: true };
  }

  await col('settlement_state_log').insertOne({
    settlement_id: settlementId,
    from: current,
    to: next,
    actor: opts.actor || 'system',
    metadata: opts.metadata || null,
    timestamp: now,
  }, sess).catch(() => {});

  log.info({ settlementId, from: current, to: next }, 'settlement transitioned');
  return { ok: true, from: current, to: next };
}

module.exports = {
  STATES,
  TRANSITIONS,
  isValidTransition,
  transitionSettlement,
};
