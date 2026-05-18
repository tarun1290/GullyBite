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
  // Customer paid but the order's expires_at had already elapsed when
  // the payment webhook arrived. The captured amount is refunded in
  // full and the row stays terminal here for audit / analytics.
  // Distinct from EXPIRED (no payment captured): we owe the customer
  // their money back, and settlement reporting needs to see this row
  // as a refunded sale, not a missed sale.
  'EXPIRED_PAYMENT',
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
  // EXPIRED_PAYMENT may be reached from PENDING_PAYMENT (gate fired
  // before the PAID flip) OR from PAID (gate fired after the flip but
  // before fulfillment) — both are valid landing points for the
  // payment-expiry gate in webhooks/razorpay.js + webhooks/checkout.js.
  PENDING_PAYMENT: new Set(['PAID', 'PAYMENT_FAILED', 'EXPIRED', 'EXPIRED_PAYMENT', 'CANCELLED']),
  PAYMENT_FAILED:  new Set(['PAID', 'EXPIRED', 'CANCELLED']),  // Retry allowed → PAID
  EXPIRED:         new Set([]),  // Terminal — missed sale, no further transitions
  EXPIRED_PAYMENT: new Set([]),  // Terminal — refunded post-capture
  // PAID → REJECTED_BY_RESTAURANT (manual /decline) or RESTAURANT_TIMEOUT
  // (BullMQ acceptance-timeout job fires) before the restaurant accepts.
  PAID:            new Set(['CONFIRMED', 'CANCELLED', 'REJECTED_BY_RESTAURANT', 'RESTAURANT_TIMEOUT', 'EXPIRED_PAYMENT']),
  // CONFIRMED → NO_DELIVERY_AVAILABLE when Prorouting can't allocate a rider
  // (webhook fires before any agent-assigned event).
  CONFIRMED:       new Set(['PREPARING', 'CANCELLED', 'NO_DELIVERY_AVAILABLE']),
  PREPARING:       new Set(['PACKED', 'CANCELLED']),
  // PACKED → DELIVERED is a self-heal path: when Prorouting drops the
  // agent-assigned / picked-up callbacks but does fire delivered, the
  // order would otherwise be stuck in PACKED forever. The transition
  // is logged at warn-level by the caller (services/proroutingState.js
  // delivered branch) so ops can spot the missing intermediate events.
  PACKED:          new Set(['DISPATCHED', 'DELIVERED', 'CANCELLED']),
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
  EXPIRED_PAYMENT: 'expired_payment_at',
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
  // 3PL SOP: order returned then disposed/destroyed by the 3PL. NOTE:
  // RTO_DISPOSED is intentionally NOT yet added to ORDER_STATES /
  // TRANSITIONS — a real transitionOrder(…, 'RTO_DISPOSED') call also
  // needs those, wired when Prorouting's disposed event is confirmed
  // (see the no-op stub in proroutingState.js).
  RTO_DISPOSED:    'rto_disposed_at',
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

// ─── SLA SPAN HELPER ────────────────────────────────────────
// Whole-minute span from `a` → `b`. Returns null (an explicit
// "not measurable", distinct from 0) when either endpoint is
// missing/invalid or the span is not strictly positive.
function _slaMin(a, b) {
  if (!a || !b) return null;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  const m = Math.round((tb - ta) / 60000);
  return m > 0 ? m : null;
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

  // 5b. SLA spans (DELIVERED only). delivered_at was just stamped on
  // `updated` (returnDocument:'after'), so the post-update doc carries
  // every endpoint. Persisted via a follow-up $set on the same doc and
  // mirrored onto `updated` so the bus payload / return value match the
  // DB. Resilient: a failed analytics write must never unwind a
  // transition that already atomically committed above.
  if (nextState === 'DELIVERED') {
    const slaPrep     = _slaMin(updated.confirmed_at,    updated.packed_at);
    const slaDispatch = _slaMin(updated.packed_at,       updated.rider_pickup_at);
    const slaTransit  = _slaMin(updated.rider_pickup_at, updated.delivered_at);
    updated.sla_prep_min     = slaPrep;
    updated.sla_dispatch_min = slaDispatch;
    updated.sla_transit_min  = slaTransit;
    await col('orders').updateOne(
      { _id: orderId },
      { $set: {
          sla_prep_min:     slaPrep,
          sla_dispatch_min: slaDispatch,
          sla_transit_min:  slaTransit,
          updated_at:       new Date(),
        } },
    ).catch(e => log.warn({ err: e?.message, orderId }, 'SLA span write failed'));

    // ─── Post-delivery Issue Flow enqueue ──────────────────────
    // 90s after DELIVERED, prompt the customer with the issue/dispute
    // Flow template (order_issue_report_v1). Env-gated: dev/staging
    // without ISSUE_FLOW_ID skip silently — the FLOW button needs a
    // real published Flow id anyway. The `issue-flow-<orderId>` jobId
    // makes the enqueue idempotent across duplicate transitions. The
    // handler re-checks status at fire time. Fire-and-forget — must
    // never block or unwind the DELIVERED transition. Mirrors the
    // CART_RECOVERY-on-EXPIRED enqueue pattern below.
    if (process.env.ISSUE_FLOW_ID) {
      try {
        const { enqueue, JOB_TYPES: JOBS } = require('../queue/postPaymentJobs');
        enqueue(
          JOBS.send_issue_flow_template,
          { orderId },
          { delayMs: 90000, jobId: `issue-flow-${orderId}` },
        ).catch((err) => log.warn({ err: err?.message, orderId }, 'send_issue_flow_template enqueue failed'));
      } catch (err) {
        log.warn({ err: err?.message, orderId }, 'send_issue_flow_template enqueue dispatch failed');
      }
    }
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
  // out as 'order_status_changed' so the dashboard's open list mutates
  // without polling. The PAID-specific 'new_order' and 'new_paid_order'
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
    emitToRestaurant(updated.restaurant_id, 'order_status_changed', updatedPayload);
    emitToAdmin('order_status_changed', updatedPayload);
  } catch (_) { /* socket failures must never block the transition */ }

  // ─── CART_RECOVERY ENQUEUE ON EXPIRED ──────────────────────
  // Single chokepoint: every EXPIRED write site funnels through this
  // function (jobs/recovery.js × 3, webhooks/razorpay.js × 2,
  // routes/cron.js order-cleanup × 1, all either calling transitionOrder
  // directly or via orderSvc.updateStatus → transitionOrder). Enqueueing
  // here instead of at each call site means a future EXPIRED writer
  // automatically gets cart-recovery without a code change.
  //
  // 30-min delay gives the customer a window to retry payment on their
  // own first (the cart-recovery template should treat the failure as
  // a friendly nudge, not an immediate ping). The handler in
  // queue/postPaymentJobs.js re-checks status at fire time so a
  // late-arriving payment cancels the send.
  //
  // Guest / anonymous orders skip — no customer_id means no recipient.
  // jobId is deterministic per order so a retry of the EXPIRED transition
  // (e.g. cron pass picks up a row already mid-transition) doesn't
  // double-enqueue.
  if (nextState === 'EXPIRED' && updated?.customer_id) {
    try {
      const { enqueue, JOB_TYPES: JOBS } = require('../queue/postPaymentJobs');
      enqueue(
        JOBS.CART_RECOVERY,
        {
          orderId: String(orderId),
          restaurantId: updated.restaurant_id ? String(updated.restaurant_id) : null,
        },
        {
          delayMs: 30 * 60 * 1000,
          jobId: `cart-recovery-${orderId}`,
          // executeJourney never throws, so retries cannot recover from
          // any failure — keep it to a single attempt to avoid noise in
          // the queue's retry/failure logs.
          maxAttempts: 1,
        },
      ).catch((err) => log.warn({ err, orderId }, 'CART_RECOVERY enqueue failed'));
    } catch (err) {
      log.warn({ err, orderId }, 'CART_RECOVERY enqueue dispatch failed');
    }
  }

  // ─── CONVERSATION RESET ON TERMINAL-FAILURE (defense in depth) ─
  // When an order dies (EXPIRED, CANCELLED, REJECTED_BY_RESTAURANT,
  // RESTAURANT_TIMEOUT, PAYMENT_FAILED), reset the customer's
  // conversation back to GREETING and clear active_order_id. Without
  // this, the customer keeps showing up under Incomplete Orders /
  // dropoff analytics because (a) services/dropoff.js's hasOrder check
  // treats CANCELLED/PAYMENT_FAILED as "no completed order" and falls
  // through to stage classification, and (b) conv.state often stays
  // pinned to ORDER_REVIEW / AWAITING_PAYMENT for the lifetime of the
  // dead order. PAID orders intentionally don't trigger this — that
  // path schedules the acceptance-timeout job below.
  // Fire-and-forget: a conversations write failure must not abort the
  // already-committed order transition.
  const TERMINAL_FAILURE_STATES = new Set([
    'EXPIRED', 'CANCELLED', 'REJECTED_BY_RESTAURANT',
    'RESTAURANT_TIMEOUT', 'PAYMENT_FAILED',
  ]);
  if (TERMINAL_FAILURE_STATES.has(nextState)) {
    setImmediate(() => {
      col('conversations').updateOne(
        { active_order_id: orderId },
        { $set: { state: 'GREETING', active_order_id: null, updated_at: new Date() } },
      ).catch((err) => log.warn(
        { err: err.message, orderId, nextState },
        'conversation reset on terminal transition failed (non-fatal)',
      ));
    });
  }

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
