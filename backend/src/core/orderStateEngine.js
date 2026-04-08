// src/core/orderStateEngine.js
// Strict Order State Transition Engine.
// Defines all valid states and allowed transitions.
// All order status changes MUST go through transitionOrder().
// Rejects invalid transitions, enforces idempotency, adds audit logging.

'use strict';

const { col, newId } = require('../config/database');
const log = require('../utils/logger').child({ component: 'orderState' });

// ─── VALID STATES ───────────────────────────────────────────
const ORDER_STATES = [
  'PENDING_PAYMENT',
  'PAID',
  'CONFIRMED',
  'PREPARING',
  'PACKED',
  'DISPATCHED',
  'DELIVERED',
  'CANCELLED',
];

// ─── ALLOWED TRANSITIONS ────────────────────────────────────
// Map of currentState → Set of allowed nextStates.
// CANCELLED is reachable from most states (customer/system can cancel).
const TRANSITIONS = {
  PENDING_PAYMENT: new Set(['PAID', 'CANCELLED']),
  PAID:            new Set(['CONFIRMED', 'CANCELLED']),
  CONFIRMED:       new Set(['PREPARING', 'CANCELLED']),
  PREPARING:       new Set(['PACKED', 'CANCELLED']),
  PACKED:          new Set(['DISPATCHED', 'CANCELLED']),
  DISPATCHED:      new Set(['DELIVERED', 'CANCELLED']),
  DELIVERED:       new Set([]),  // Terminal state — no further transitions
  CANCELLED:       new Set([]),  // Terminal state — no further transitions
};

// ─── TIMESTAMP FIELDS PER STATE ─────────────────────────────
const STATE_TIMESTAMP = {
  PAID:       'paid_at',
  CONFIRMED:  'confirmed_at',
  PREPARING:  'preparing_at',
  PACKED:     'packed_at',
  DISPATCHED: 'dispatched_at',
  DELIVERED:  'delivered_at',
  CANCELLED:  'cancelled_at',
};

// ─── TRANSITION VALIDATION ──────────────────────────────────

/**
 * Check if a state transition is valid.
 * @param {string} currentState
 * @param {string} nextState
 * @returns {{ valid: boolean, reason?: string }}
 */
function isValidTransition(currentState, nextState) {
  if (!ORDER_STATES.includes(currentState)) {
    return { valid: false, reason: `Unknown current state: ${currentState}` };
  }
  if (!ORDER_STATES.includes(nextState)) {
    return { valid: false, reason: `Unknown target state: ${nextState}` };
  }
  if (currentState === nextState) {
    return { valid: false, reason: 'Already in this state', idempotent: true };
  }
  const allowed = TRANSITIONS[currentState];
  if (!allowed || !allowed.has(nextState)) {
    return { valid: false, reason: `Transition ${currentState} → ${nextState} is not allowed` };
  }
  return { valid: true };
}

// ─── TRANSITION ORDER ───────────────────────────────────────

/**
 * Transition an order to a new state.
 * Validates the transition, updates the order, logs the change.
 *
 * @param {string} orderId - Order document _id
 * @param {string} nextState - Target state
 * @param {object} opts - { actor, actorType, cancelReason, metadata }
 *   actor: who triggered (user ID, 'system', 'razorpay', etc.)
 *   actorType: 'customer' | 'restaurant' | 'system' | 'admin'
 *   cancelReason: reason string (only for CANCELLED)
 *   metadata: optional context object (payment details, delivery info, etc.)
 * @returns {object} - Updated order document
 * @throws {Error} - If transition is invalid
 */
async function transitionOrder(orderId, nextState, opts = {}) {
  const { actor = 'system', actorType = 'system', cancelReason, metadata } = opts;
  const now = new Date();

  // 1. Fetch current order
  const order = await col('orders').findOne({ _id: orderId });
  if (!order) throw new Error(`Order ${orderId} not found`);

  const currentState = order.status;

  // 2. Idempotency check — if already in target state, return silently
  if (currentState === nextState) {
    log.info({ orderId, state: nextState }, 'Idempotent: order already in target state');
    return order;
  }

  // 3. Validate transition
  const check = isValidTransition(currentState, nextState);
  if (!check.valid) {
    log.error({ orderId, from: currentState, to: nextState, reason: check.reason }, 'Invalid state transition');
    throw new Error(check.reason);
  }

  // 4. Build update
  const $set = { status: nextState, updated_at: now };
  const tsField = STATE_TIMESTAMP[nextState];
  if (tsField) $set[tsField] = now;
  if (nextState === 'CANCELLED' && cancelReason) $set.cancel_reason = cancelReason;

  // 5. Atomic update with state guard (prevents race conditions)
  // Only update if current state still matches — protects against concurrent transitions
  const updated = await col('orders').findOneAndUpdate(
    { _id: orderId, status: currentState }, // State guard
    { $set },
    { returnDocument: 'after' }
  );

  if (!updated) {
    // State changed between read and write — fetch current and report
    const current = await col('orders').findOne({ _id: orderId });
    if (current?.status === nextState) {
      // Another process completed this transition — idempotent success
      log.info({ orderId, state: nextState }, 'Concurrent transition resolved: already in target state');
      return current;
    }
    throw new Error(`Order ${orderId} state changed concurrently (expected ${currentState}, found ${current?.status})`);
  }

  // 6. Audit log (fire-and-forget)
  col('order_state_log').insertOne({
    _id: newId(),
    order_id: orderId,
    order_number: order.order_number,
    from_state: currentState,
    to_state: nextState,
    actor,
    actor_type: actorType,
    cancel_reason: cancelReason || null,
    metadata: metadata || null,
    timestamp: now,
  }).catch(e => log.warn({ err: e, orderId }, 'Audit log failed'));

  log.info({ orderId, from: currentState, to: nextState, actorType, actor }, 'Order state transitioned');

  return updated;
}

module.exports = {
  ORDER_STATES,
  TRANSITIONS,
  STATE_TIMESTAMP,
  isValidTransition,
  transitionOrder,
};
