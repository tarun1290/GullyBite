// src/services/orderAcceptance.js
//
// Single source of truth for the order-acceptance side-effect chain.
// Replaces inline blocks that previously lived in two places:
//   • routes/restaurant.js POST /orders/:id/accept   (dashboard)
//   • webhooks/petpoojaCallback.js ACCEPTED branch    (POS auto-accept)
//
// The Petpooja path previously ran only a subset of the contract —
// notably it never enqueued ORDER_DISPATCH, so Petpooja-accepted
// orders never reached Prorouting. It also stamped petpooja_accepted_at
// without acknowledged_at, which left orderAcceptanceProcessor's
// `status !== 'PAID'` guard as the only protection against the BullMQ
// acceptance-timeout worker booking a fault-fee on a POS-accepted
// order. Pairing this module with the new
// `acknowledged_at: { $exists: false }` guard added to the worker
// closes that race.
//
// Idempotency: the CAS at step 1 is the SINGLE arbiter. Two transports
// racing on the same order (dashboard accept + Petpooja callback fired
// within the same millisecond) both call applyOrderAcceptance; only
// one stamps acknowledged_at; the other gets { alreadyAcknowledged }
// and short-circuits. No double dispatch, no double customer message.

'use strict';

const { col } = require('../config/database');
const orderSvc = require('./order');
const log = require('../utils/logger').child({ component: 'orderAcceptance' });

/**
 * Apply the canonical acceptance side-effects for an order.
 *
 * Transport-specific guards (tenant scope, branch scope, status-is-PAID
 * pre-check) MUST run at the call site BEFORE invoking this. This
 * function's CAS is the final correctness boundary, not a substitute
 * for caller-side authorization.
 *
 * @param {string} orderId
 * @param {object} opts
 * @param {'dashboard'|'petpooja'} opts.source
 * @param {string} opts.actor           — userId / 'petpooja_pos' / etc.
 * @param {string} opts.actorType       — 'restaurant' | 'staff' | 'pp-pos' | future POS tags
 * @param {string|null} [opts.acknowledgedBy]  — userId for dashboard, null for POS callbacks
 * @param {string|null} [opts.actorName]       — display name for the activity log entry
 * @param {object}      [opts.petpoojaExtras]  — { minimum_prep_time } when source === 'petpooja'
 *
 * @returns {Promise<{ applied: boolean, alreadyAcknowledged?: boolean, status: string|null }>}
 */
async function applyOrderAcceptance(orderId, opts) {
  const {
    source,
    actor,
    actorType,
    acknowledgedBy = null,
    actorName = null,
    petpoojaExtras,
  } = opts || {};

  const now = new Date();
  const stamp = {
    acknowledged_at: now,
    acknowledged_by: acknowledgedBy,
    updated_at: now,
  };
  if (source === 'petpooja') {
    stamp.petpooja_accepted_at = now;
    stamp.minimum_prep_time = petpoojaExtras?.minimum_prep_time ?? null;
  }

  // ── 1. Atomic CAS ─────────────────────────────────────────────
  // Filter requires BOTH status:'PAID' AND no existing acknowledged_at.
  // This is the single idempotency boundary: covers "already accepted",
  // "already past PAID" (e.g. the timeout worker won the race), and the
  // double-transport race. returnDocument:'after' hands back the post-
  // update doc so we don't need a follow-up findOne for downstream
  // side-effects' restaurant_id / branch_id / acceptance_timeout_job_id.
  let casResult;
  try {
    casResult = await col('orders').findOneAndUpdate(
      { _id: orderId, status: 'PAID', acknowledged_at: { $exists: false } },
      { $set: stamp },
      { returnDocument: 'after' },
    );
  } catch (err) {
    log.error({ err: err?.message, orderId }, 'applyOrderAcceptance: CAS findOneAndUpdate threw');
    throw err;
  }

  // mongodb driver v4 returns { value, lastErrorObject, ok }; v5+/v6
  // returns the doc directly. Handle both shapes (mirror withIdempotency).
  const order = casResult?.value ?? casResult ?? null;

  if (!order) {
    // CAS didn't match. Two possibilities: order already acknowledged,
    // or order not in PAID anymore. Either way we don't run side-effects.
    let currentStatus = null;
    try {
      const current = await col('orders').findOne(
        { _id: orderId },
        { projection: { status: 1 } },
      );
      currentStatus = current?.status ?? null;
    } catch (err) {
      log.warn({ err: err?.message, orderId }, 'applyOrderAcceptance: current-status lookup failed (continuing)');
    }
    log.info({ orderId, currentStatus, source }, 'applyOrderAcceptance: CAS no-op (already acknowledged or past PAID)');
    return { applied: false, alreadyAcknowledged: true, status: currentStatus };
  }

  // ── 2. Cancel acceptance-timeout BullMQ job ───────────────────
  // BEFORE the state transition. Best-effort: removeAcceptanceTimeoutJob
  // is idempotent against a missing/already-removed job, and the worker
  // (with its acknowledged_at guard added in jobs/orderAcceptanceProcessor.js)
  // backstops if this fails. Own try/catch so a Redis blip can't
  // poison subsequent side-effects.
  if (order.acceptance_timeout_job_id) {
    try {
      const { removeAcceptanceTimeoutJob } = require('../jobs/orderAcceptanceQueue');
      await removeAcceptanceTimeoutJob(order.acceptance_timeout_job_id);
    } catch (err) {
      log.warn(
        { err: err?.message, orderId, jobId: order.acceptance_timeout_job_id },
        'applyOrderAcceptance: cancel timeout job failed (continuing)',
      );
    }
  }

  // ── 3. State transition PAID → CONFIRMED ──────────────────────
  // Owns the order_status_changed bus/socket fan-out via
  // orderStateEngine. actor/actorType drive the order_state_log entry.
  // `confirmed` flag gates the PREPARING auto-advance below: if this
  // call threw, the order is still PAID and a CONFIRMED→PREPARING
  // advance would actually be PAID→PREPARING (invalid transition — the
  // exact class of bug the owner-PATCH guard exists to block).
  let confirmed = false;
  try {
    await orderSvc.updateStatus(orderId, 'CONFIRMED', { actor, actorType });
    confirmed = true;
  } catch (err) {
    log.error(
      { err: err?.message, orderId, actor, actorType },
      'applyOrderAcceptance: PAID→CONFIRMED transition failed (continuing with downstream side-effects)',
    );
  }

  // ── 4. Enqueue ORDER_DISPATCH ─────────────────────────────────
  // setImmediate + fire-and-forget mirrors the prior /accept behaviour
  // (a Prorouting outage shouldn't block the caller). Lazy-required to
  // avoid an import-time cycle with services/order which postPaymentJobs
  // indirectly references.
  setImmediate(() => {
    try {
      const { enqueue, JOB_TYPES } = require('../queue/postPaymentJobs');
      enqueue(JOB_TYPES.ORDER_DISPATCH, {
        orderId: String(orderId),
        restaurantId: order.restaurant_id ? String(order.restaurant_id) : null,
      }).catch((err) => log.warn(
        { err: err?.message, orderId },
        'applyOrderAcceptance: enqueue ORDER_DISPATCH failed (non-fatal)',
      ));
    } catch (err) {
      log.warn({ err: err?.message, orderId }, 'applyOrderAcceptance: ORDER_DISPATCH enqueue setup threw');
    }
  });

  // ── 5. Socket broadcast: order_acknowledged ───────────────────
  try {
    const ws = require('./websocket');
    ws.broadcastOrder(order.restaurant_id, 'order_acknowledged', {
      orderId: String(orderId),
      action: 'accept',
      newStatus: 'CONFIRMED',
    });
  } catch (err) {
    log.warn({ err: err?.message, orderId }, 'applyOrderAcceptance: order_acknowledged broadcast failed');
  }

  // ── 6. Customer "CONFIRMED" WhatsApp ──────────────────────────
  // CSW-gated by notifyOrderStatus internally — we don't replicate the
  // gate here. Runs for both sources; Petpooja does not itself notify
  // GullyBite customers via WA, so this is the canonical channel.
  try {
    const orderNotify = require('./orderNotify');
    const fullOrder = await orderSvc.getOrderDetails(orderId);
    if (fullOrder?.phone_number_id) {
      orderNotify.notifyOrderStatus(
        order.restaurant_id,
        fullOrder.phone_number_id,
        fullOrder.access_token,
        fullOrder.wa_phone,
        'CONFIRMED',
        {
          _orderId: orderId,
          order_number: fullOrder.order_number,
          customer_name: fullOrder.customer_name,
          total_rs: `₹${parseFloat(fullOrder.total_rs).toFixed(0)}`,
          branch_name: fullOrder.branch_name,
          restaurant_name: fullOrder.business_name,
        },
      ).catch(() => { /* fire-and-forget */ });
    }
  } catch (err) {
    log.warn({ err: err?.message, orderId }, 'applyOrderAcceptance: customer WA confirm setup failed');
  }

  // ── 7. Activity log ───────────────────────────────────────────
  try {
    const { logActivity } = require('./activityLog');
    logActivity({
      actorType,
      actorId: actor ? String(actor) : null,
      actorName,
      action: 'order.accepted',
      category: 'order',
      description: `Order ${orderId} accepted (PAID → CONFIRMED)${source === 'petpooja' ? ' via Petpooja POS' : ''}`,
      restaurantId: order.restaurant_id,
      branchId: order.branch_id,
      resourceType: 'order',
      resourceId: String(orderId),
      severity: 'info',
    });
  } catch (err) {
    log.warn({ err: err?.message, orderId }, 'applyOrderAcceptance: activity log failed');
  }

  // ── 8. Auto-advance CONFIRMED → PREPARING ─────────────────────
  // The owner dashboard treats CONFIRMED as a transient state — only
  // the staff app keeps an explicit "Start prep" click. This advance
  // used to happen in the frontend by re-calling PATCH /status, which
  // ran as a separate request with no shared acceptance context. With
  // the row Confirm button now hitting POST /accept (and the dedicated
  // /accept handler removed of its own frontend-side auto-advance),
  // doing the advance server-side here keeps the kitchen view in step.
  //
  // GATED on `confirmed`: if the CONFIRMED transition failed above the
  // order is still in PAID, so an "advance to PREPARING" call here
  // would actually be PAID→PREPARING — an invalid transition the state
  // engine would reject. Skip silently in that case; the order is
  // still at PAID and ops can replay /accept manually.
  //
  // WA-silent: orderSvc.updateStatus → transitionOrder writes
  // order_state_log + emits order.updated to the bus. The only
  // order.updated listener after the notificationListener removal is
  // sseListener (socket emit only — no WhatsApp). The customer's
  // "CONFIRMED" WA was already sent in step 6; no PREPARING customer
  // message is sent anywhere in the stack, so no suppression flag is
  // needed. Own try/catch — failing the advance must not mask the
  // CONFIRMED success the caller is about to receive.
  let advanced = false;
  if (confirmed) {
    try {
      await orderSvc.updateStatus(orderId, 'PREPARING', { actor, actorType });
      advanced = true;
    } catch (err) {
      log.warn(
        { err: err?.message, orderId, actor, actorType },
        'applyOrderAcceptance: CONFIRMED→PREPARING advance failed (order remains CONFIRMED; kitchen can advance manually)',
      );
    }
  }

  return { applied: true, status: advanced ? 'PREPARING' : 'CONFIRMED' };
}

module.exports = { applyOrderAcceptance };
