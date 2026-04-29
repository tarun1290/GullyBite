// src/core/orderStateEngine.js
// Strict Order State Transition Engine.
// Defines all valid states and allowed transitions.
// All order status changes MUST go through transitionOrder().
// Rejects invalid transitions, enforces idempotency, adds audit logging.

'use strict';

const { col, newId } = require('../config/database');
const log = require('../utils/logger').child({ component: 'orderState' });

// ─── VALID STATES ───────────────────────────────────────────
// Commerce lifecycle:
//   PENDING_PAYMENT → (payment succeeds) → PAID → CONFIRMED → PREPARING → ...
//   PENDING_PAYMENT → (payment fails)    → PAYMENT_FAILED (retryable)
//   PENDING_PAYMENT → (1h expiry / Razorpay order.expired) → EXPIRED (missed sale)
//   PAYMENT_FAILED  → (retry succeeds)   → PAID
//   PAYMENT_FAILED  → (1h expiry)        → EXPIRED
//   Any active      → (user/system)      → CANCELLED
//
// EXPIRED is a DISTINCT terminal state for missed-sale analytics.
// It is NOT the same as CANCELLED (which is an explicit user/admin action).
//
// Fault states (REJECTED_BY_RESTAURANT, RESTAURANT_TIMEOUT, NO_DELIVERY_AVAILABLE)
// are terminal too. They split out from CANCELLED so analytics + settlement
// can attribute the refund cost correctly: restaurant-fault rows feed back
// into the restaurant's cancellation_fault_fees on the next settlement;
// no-rider rows land in platform_absorbed_fee on the order itself only.
const ORDER_STATES = [
  'PENDING_PAYMENT',
  'PAYMENT_FAILED',
  'EXPIRED',
  'PAID',
  'CONFIRMED',
  'PREPARING',
  'PACKED',
  'DISPATCHED',
  'DELIVERED',
  'CANCELLED',
  'REJECTED_BY_RESTAURANT',
  'RESTAURANT_TIMEOUT',
  'NO_DELIVERY_AVAILABLE',
  // Prorouting RTO lifecycle. When a 3PL rider cannot deliver and
  // initiates return-to-origin, the order moves DISPATCHED → RTO_IN_PROGRESS.
  // Once the package is returned (or disposed) it becomes terminal at
  // RTO_COMPLETE. Neither state counts as a delivered order.
  'RTO_IN_PROGRESS',
  'RTO_COMPLETE',
];

// ─── CONFIRMED ORDER STATES ────────────────────────────────
// Only these count as "real orders" in analytics/revenue.
// PENDING_PAYMENT, PAYMENT_FAILED, and EXPIRED are checkout attempts, not orders.
const CONFIRMED_ORDER_STATES = ['PAID', 'CONFIRMED', 'PREPARING', 'PACKED', 'DISPATCHED', 'DELIVERED'];

// ─── ALLOWED TRANSITIONS ────────────────────────────────────
// Map of currentState → Set of allowed nextStates.
const TRANSITIONS = {
  PENDING_PAYMENT: new Set(['PAID', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED']),
  PAYMENT_FAILED:  new Set(['PAID', 'EXPIRED', 'CANCELLED']),  // Retry allowed → PAID
  EXPIRED:         new Set([]),  // Terminal — missed sale, no further transitions
  // PAID → REJECTED_BY_RESTAURANT (manual /decline) or RESTAURANT_TIMEOUT
  // (BullMQ acceptance-timeout job fires) before the restaurant accepts.
  PAID:            new Set(['CONFIRMED', 'CANCELLED', 'REJECTED_BY_RESTAURANT', 'RESTAURANT_TIMEOUT']),
  // CONFIRMED → NO_DELIVERY_AVAILABLE when Prorouting can't allocate a rider
  // (webhook fires before any agent-assigned event).
  CONFIRMED:       new Set(['PREPARING', 'CANCELLED', 'NO_DELIVERY_AVAILABLE']),
  PREPARING:       new Set(['PACKED', 'CANCELLED']),
  PACKED:          new Set(['DISPATCHED', 'CANCELLED']),
  // Defensive: a rider can drop after pickup. NO_DELIVERY_AVAILABLE allowed
  // here too so the same fault handler covers both paths.
  DISPATCHED:      new Set(['DELIVERED', 'CANCELLED', 'RTO_IN_PROGRESS', 'NO_DELIVERY_AVAILABLE']),
  DELIVERED:       new Set([]),  // Terminal state
  CANCELLED:       new Set([]),  // Terminal state
  REJECTED_BY_RESTAURANT: new Set([]),  // Terminal — restaurant declined
  RESTAURANT_TIMEOUT:     new Set([]),  // Terminal — restaurant didn't act in time
  NO_DELIVERY_AVAILABLE:  new Set([]),  // Terminal — Prorouting couldn't allocate
  RTO_IN_PROGRESS: new Set(['RTO_COMPLETE', 'CANCELLED']),
  RTO_COMPLETE:    new Set([]),  // Terminal state
};

// ─── TIMESTAMP FIELDS PER STATE ─────────────────────────────
const STATE_TIMESTAMP = {
  PAYMENT_FAILED:  'payment_failed_at',
  EXPIRED:         'expired_at',
  PAID:            'paid_at',
  CONFIRMED:       'confirmed_at',
  PREPARING:       'preparing_at',
  PACKED:          'packed_at',
  DISPATCHED:      'dispatched_at',
  DELIVERED:       'delivered_at',
  CANCELLED:       'cancelled_at',
  REJECTED_BY_RESTAURANT: 'rejected_at',
  RESTAURANT_TIMEOUT:     'timeout_at',
  NO_DELIVERY_AVAILABLE:  'no_delivery_at',
  RTO_IN_PROGRESS: 'rto_initiated_at',
  RTO_COMPLETE:    'rto_completed_at',
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
  if (nextState === 'EXPIRED') $set.missed_sale_reason = cancelReason || 'payment_timeout';
  if (nextState === 'PAYMENT_FAILED') $set.payment_failure_reason = cancelReason || 'payment_failed';

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

  // Fan out order.updated via the event bus. Listeners (notification,
  // analytics) run async and isolated — a listener failure never breaks
  // the transition.
  try {
    const bus = require('../events');
    bus.emit('order.updated', {
      orderId,
      restaurantId: updated.restaurant_id,
      orderNumber: updated.order_number,
      oldStatus: currentState,
      newStatus: nextState,
      actor,
      actorType,
      _order: updated,
    });
  } catch (_) { /* bus load errors must never block the transition */ }

  // Socket.io fan-out — fire-and-forget. Every state transition fans
  // out as 'order:updated' so the dashboard's open list mutates
  // without polling. The PAID-specific 'order:new' and 'order:paid'
  // chimes are emitted by the webhook entrypoints (checkout.js for
  // WhatsApp native, razorpay.js for hosted) — we only emit the
  // generic transition event here. Mirrors to admin:platform so
  // platform-side dashboards see the same transitions.
  try {
    const { emitToRestaurant, emitToAdmin } = require('../utils/socketEmit');
    const updatedPayload = {
      orderId: String(orderId),
      status: nextState,
      updatedAt: now.toISOString(),
    };
    emitToRestaurant(updated.restaurant_id, 'order:updated', updatedPayload);
    emitToAdmin('order:updated', updatedPayload);
  } catch (_) { /* socket failures must never block the transition */ }

  // ─── ACCEPTANCE TIMEOUT JOB (PAID only) ──────────────────────
  // Schedule the BullMQ acceptance-timeout job so the restaurant has
  // ORDER_ACCEPTANCE_TIMEOUT_MS (default 4 min) to /accept or /decline
  // before orderCancellationService.handleRestaurantFault('restaurant_timeout')
  // fires. Centralized here so all PAID transition sites (Razorpay
  // webhook, WhatsApp checkout webhook, recovery job) pick it up
  // without duplication. Idempotent: jobId === orderId.
  // Fire-and-forget: a Redis hiccup must never abort the state change.
  if (nextState === 'PAID') {
    setImmediate(() => {
      try {
        const { addAcceptanceTimeoutJob } = require('../jobs/orderAcceptanceQueue');
        addAcceptanceTimeoutJob(orderId)
          .then(({ jobId }) => {
            // Stamp the BullMQ job id on the order so accept/decline can
            // cancel it later. Stale stamp from a duplicate enqueue is
            // harmless — same orderId means same jobId via dedup.
            col('orders').updateOne(
              { _id: orderId },
              { $set: { acceptance_timeout_job_id: jobId, acceptance_timeout_scheduled_at: new Date() } }
            ).catch(() => {});
          })
          .catch((err) => log.warn({ err: err.message, orderId }, 'addAcceptanceTimeoutJob failed (non-fatal)'));
      } catch (err) {
        log.warn({ err: err.message, orderId }, 'addAcceptanceTimeoutJob require failed (non-fatal)');
      }
    });
  }

  return updated;
}

module.exports = {
  ORDER_STATES,
  CONFIRMED_ORDER_STATES,
  TRANSITIONS,
  STATE_TIMESTAMP,
  isValidTransition,
  transitionOrder,
};
