// src/services/orderCancellationService.js
//
// Centralized fault-cancellation logic. Two entry points:
//
//   handleRestaurantFault(orderId, reason)
//     reason ∈ { 'rejected_by_restaurant', 'restaurant_timeout' }
//     - Restaurant either declined explicitly or didn't respond in time.
//     - Refund the customer in full.
//     - Book the Razorpay processing fee (~2% + 18% GST) against the
//       restaurant via the cancellation_fault_fees accumulator on the
//       restaurant document — the next settlement job picks it up.
//
//   handleNoRiderFault(orderId)
//     - Prorouting couldn't allocate a rider after restaurant accepted.
//     - Refund the customer in full.
//     - Platform absorbs the Razorpay fee (no settlement debit) — the
//       restaurant did its part.
//
// Both handlers are idempotent (status guard) and fire-and-forget on
// notifications. Refund-call failures DO surface (caller can retry) —
// we never want to flip the order to a fault state without the refund
// going out, since that traps the customer in limbo.

'use strict';

const { col } = require('../config/database');
const orderSvc = require('./order');
const wa = require('./whatsapp');
const { resolveRecipient } = require('./customerIdentity');
const log = require('../utils/logger').child({ component: 'orderCancellationService' });

// Razorpay processing fee approximation. Real fee depends on payment
// instrument (card 2% / UPI 0% / netbanking 1.9% / wallet 1.9%) plus 18%
// GST on the fee. We use 2% as a safe upper bound for accounting; actual
// fee is reconciled from the Razorpay settlement report.
const RAZORPAY_FEE_PCT = 0.02;
const GST_ON_FEE_PCT = 0.18;

function calculateRazorpayFeeRs(orderTotalRs) {
  const total = Number(orderTotalRs) || 0;
  if (total <= 0) return 0;
  // round to 2 decimals
  return Math.round(((total * RAZORPAY_FEE_PCT) * (1 + GST_ON_FEE_PCT)) * 100) / 100;
}

// Customer-facing reason text. The order_cancelled WA template uses
// {{3}} = order.cancellation_reason, so we write this onto the order
// before invoking sendOrderTemplateMessage.
const REASON_TEXT = {
  rejected_by_restaurant: 'The restaurant was unable to accept your order',
  restaurant_timeout:     'The restaurant did not respond in time',
  no_delivery_available:  'No delivery partner was available in your area',
};

const REASON_TO_STATUS = {
  rejected_by_restaurant: 'REJECTED_BY_RESTAURANT',
  restaurant_timeout:     'RESTAURANT_TIMEOUT',
};

// Defensive: never let a notification failure throw out of a fault
// handler. We've already done the refund + state transition by the time
// we get here; the customer message is best-effort.
function fireAndForget(promise, ctx) {
  Promise.resolve(promise).catch((err) => {
    log.warn({ err: err?.message, ...ctx }, 'fault notification failed (best-effort)');
  });
}

async function _sendFaultNotifications(orderId, refundAmountRs) {
  // Best-effort fetch of the refreshed order (cancellation_reason + refund
  // amount were just stamped on it) so the WA templates resolve correctly.
  try {
    const orderNotify = require('./orderNotify');
    const fresh = await col('orders').findOne({ _id: orderId });
    if (!fresh) return;

    const ctx = await orderNotify.buildOrderContext(orderId);
    if (!ctx) return;

    // Order cancelled — free-form lifecycle copy from
    // STATUS_MESSAGES.CANCELLED. fresh.status here is the fault state
    // (REJECTED_BY_RESTAURANT / RESTAURANT_TIMEOUT / NO_DELIVERY_AVAILABLE);
    // STATUS_MESSAGES doesn't carry per-fault entries, so we map them
    // all to the customer-facing 'CANCELLED' message which already
    // mentions the refund window. Fires first so the customer sees the
    // cancellation before the separate refund confirmation.
    fireAndForget(
      wa.sendStatusUpdate(
        ctx.order.phone_number_id,
        ctx.order.access_token,
        resolveRecipient(ctx.order),
        'CANCELLED',
        { orderNumber: ctx.order.order_number },
      ),
      { orderId, event: 'order_cancelled' },
    );

    if (refundAmountRs > 0) {
      fireAndForget(
        orderNotify.sendRefundProcessedMessage(orderId, ctx),
        { orderId, event: 'refund_processed' },
      );
    }
  } catch (err) {
    log.warn({ err: err.message, orderId }, '_sendFaultNotifications wrapper failed');
  }
}

// ─── RESTAURANT FAULT (decline OR timeout) ──────────────────
async function handleRestaurantFault(orderId, reason) {
  const newStatus = REASON_TO_STATUS[reason];
  if (!newStatus) {
    throw new Error(`handleRestaurantFault: unknown reason "${reason}"`);
  }

  const order = await col('orders').findOne({ _id: orderId });
  if (!order) {
    log.warn({ orderId, reason }, 'handleRestaurantFault: order not found');
    return { skipped: true, reason: 'not found' };
  }

  // Idempotency — only PAID orders are eligible. Anything else means
  // accept/decline/cancel already happened.
  if (order.status !== 'PAID') {
    log.info({ orderId, status: order.status, reason },
      'handleRestaurantFault: order not in PAID — no-op');
    return { skipped: true, reason: `status=${order.status}` };
  }

  // ─── RACE-CLOSE (restaurant_timeout only) ────────────────────
  // Final-moment re-read placed RIGHT BEFORE the refund call to close
  // the money-race window with /accept:
  //
  //   • Worker's first-line guard (orderAcceptanceProcessor.js:55)
  //     reads acknowledged_at when the BullMQ job fires.
  //   • This function's status guard above re-reads when invoked.
  //   • THEN the prior layout awaited issueRefund (hundreds of ms)
  //     before transitioning — a /accept CAS landing in that window
  //     would refund + fault-fee + flip the row on an accepted order.
  //
  // The re-check below sits as close to the refund as possible, so a
  // mid-flight /accept cancels the entire fault chain (no refund, no
  // fault-fee, no transition) — the accept wins cleanly.
  //
  // Scope: ONLY the restaurant_timeout path. The /decline route
  // (reason==='rejected_by_restaurant') and Petpooja CANCELLED
  // callback are EXPLICIT rejections; acknowledged_at being set
  // there is NOT a reason to abort — the restaurant/POS is
  // deliberately rejecting after acknowledgement.
  //
  // The remaining race window is microseconds between this read and
  // the issueRefund call below — narrow enough to be effectively
  // closed in practice. A fully race-free design would need a
  // coordinated atomic claim CAS on both sides (timeout-marker
  // field added to the /accept CAS filter) — out of scope here.
  if (reason === 'restaurant_timeout') {
    let fresh;
    try {
      fresh = await col('orders').findOne(
        { _id: orderId },
        { projection: { acknowledged_at: 1, status: 1 } },
      );
    } catch (readErr) {
      // Read-failure: fail-CLOSED on the timeout path — better to
      // skip the fault than risk refunding an accepted order on
      // stale assumptions. The BullMQ job's single-attempt config
      // means we won't auto-retry; ops can replay manually.
      log.warn({ err: readErr?.message, orderId },
        'handleRestaurantFault: pre-refund re-read failed — aborting timeout fault (fail-closed)');
      return { skipped: true, reason: 'pre_refund_read_failed' };
    }
    if (fresh?.acknowledged_at) {
      log.warn(
        { orderId, status: fresh.status, acknowledged_at: fresh.acknowledged_at },
        'handleRestaurantFault: restaurant_timeout aborted — concurrent /accept landed during timeout dispatch (acknowledged_at present)',
      );
      return { skipped: true, reason: 'concurrent_accept_won' };
    }
    if (fresh?.status !== 'PAID') {
      // Status moved off PAID since the line ~124 guard ran (customer
      // cancel via WA, manual /decline winning the race, etc.).
      log.warn(
        { orderId, status: fresh?.status },
        'handleRestaurantFault: restaurant_timeout aborted — status moved off PAID concurrently',
      );
      return { skipped: true, reason: `status=${fresh?.status}` };
    }
  }

  const orderTotalRs = Number(order.total_rs) || 0;
  const razorpayFeeRs = calculateRazorpayFeeRs(orderTotalRs);
  const reasonText = REASON_TEXT[reason] || 'Order cancelled';
  const now = new Date();

  // 1. Refund the customer FIRST. If Razorpay rejects we abort so we
  //    never end up in a fault state without the refund going out.
  let refund = null;
  try {
    const payment = require('./payment');
    refund = await payment.issueRefund(orderId, `${newStatus}: ${reasonText}`);
  } catch (err) {
    log.error({ err: err.message, orderId, reason }, 'handleRestaurantFault: refund failed');
    throw err; // bubble up — caller (timeout processor / /decline) decides retry
  }

  // 2. Stamp fault-fee + reason fields on the order BEFORE the state
  //    transition, so the WA template variables resolve from the row.
  await col('orders').updateOne(
    { _id: orderId },
    { $set: {
        cancellation_reason: reasonText,
        cancellation_reason_code: reason,
        refund_id: refund?.id || null,
        refund_amount_rs: orderTotalRs,
        cancellation_fault_fee: {
          amount: razorpayFeeRs,
          reason,
          order_total: orderTotalRs,
          created_at: now,
        },
        updated_at: now,
    } },
  );

  // 3. Transition through the strict state engine.
  await orderSvc.updateStatus(orderId, newStatus, {
    actor: 'orderCancellationService',
    actorType: 'system',
    cancelReason: reasonText,
  });

  // 4. Add to restaurant's settlement accumulator. Stored as paise on
  //    the restaurant document so the next settlement job can drain it
  //    into the period's cancellation_fault_fees field. Additive only.
  if (razorpayFeeRs > 0 && order.restaurant_id) {
    try {
      await col('restaurants').updateOne(
        { _id: order.restaurant_id },
        {
          $inc: { pending_cancellation_fault_fees_paise: Math.round(razorpayFeeRs * 100) },
          $set: { pending_cancellation_fault_fees_updated_at: now },
        },
      );
    } catch (err) {
      // Settlement-accumulator failure is non-fatal — refund and state
      // transition already completed. Log so ops can reconcile.
      log.error({ err: err.message, orderId, restaurantId: order.restaurant_id, razorpayFeeRs },
        'handleRestaurantFault: settlement accumulator update failed');
    }
  }

  // 5. Cancel any pending acceptance-timeout job. If reason is timeout
  //    the job has already fired (we are the consumer); if reason is
  //    rejected the /decline endpoint should have cancelled — but call
  //    again as belt-and-suspenders. removeAcceptanceTimeoutJob is a
  //    no-op when the job is missing.
  if (order.acceptance_timeout_job_id) {
    try {
      const { removeAcceptanceTimeoutJob } = require('../jobs/orderAcceptanceQueue');
      await removeAcceptanceTimeoutJob(order.acceptance_timeout_job_id);
    } catch (_) {}
  }

  // 6. Notifications (fire-and-forget).
  await _sendFaultNotifications(orderId, orderTotalRs);

  log.info({ orderId, reason, newStatus, razorpayFeeRs, refundId: refund?.id },
    'handleRestaurantFault: completed');
  return { faulted: true, status: newStatus, refundId: refund?.id, razorpayFeeRs };
}

// ─── NO RIDER (Prorouting couldn't allocate) ────────────────
async function handleNoRiderFault(orderId) {
  const order = await col('orders').findOne({ _id: orderId });
  if (!order) {
    log.warn({ orderId }, 'handleNoRiderFault: order not found');
    return { skipped: true, reason: 'not found' };
  }

  // Idempotency — already in a terminal state (incl. NO_DELIVERY_AVAILABLE
  // from a duplicate webhook) means there's nothing to do.
  const TERMINAL = new Set([
    'DELIVERED', 'CANCELLED', 'EXPIRED', 'EXPIRED_PAYMENT', 'RTO_COMPLETE',
    'REJECTED_BY_RESTAURANT', 'RESTAURANT_TIMEOUT', 'NO_DELIVERY_AVAILABLE',
  ]);
  if (TERMINAL.has(order.status)) {
    log.info({ orderId, status: order.status }, 'handleNoRiderFault: order already terminal — no-op');
    return { skipped: true, reason: `status=${order.status}` };
  }

  const orderTotalRs = Number(order.total_rs) || 0;
  const razorpayFeeRs = calculateRazorpayFeeRs(orderTotalRs);
  const reasonText = REASON_TEXT.no_delivery_available;
  const now = new Date();

  let refund = null;
  try {
    const payment = require('./payment');
    refund = await payment.issueRefund(orderId, `NO_DELIVERY_AVAILABLE: ${reasonText}`);
  } catch (err) {
    log.error({ err: err.message, orderId }, 'handleNoRiderFault: refund failed');
    throw err;
  }

  // Stamp platform-absorbed fee (NOT charged to restaurant) + customer
  // fields needed by the WA templates.
  await col('orders').updateOne(
    { _id: orderId },
    { $set: {
        cancellation_reason: reasonText,
        cancellation_reason_code: 'no_delivery_available',
        refund_id: refund?.id || null,
        refund_amount_rs: orderTotalRs,
        platform_absorbed_fee: {
          amount: razorpayFeeRs,
          reason: 'no_rider_found',
          order_total: orderTotalRs,
          created_at: now,
        },
        updated_at: now,
    } },
  );

  await orderSvc.updateStatus(orderId, 'NO_DELIVERY_AVAILABLE', {
    actor: 'orderCancellationService',
    actorType: 'system',
    cancelReason: reasonText,
  });

  // No settlement debit — platform absorbs.

  await _sendFaultNotifications(orderId, orderTotalRs);

  log.info({ orderId, razorpayFeeRs, refundId: refund?.id },
    'handleNoRiderFault: completed (platform-absorbed)');
  return { faulted: true, status: 'NO_DELIVERY_AVAILABLE', refundId: refund?.id, razorpayFeeRs };
}

module.exports = {
  handleRestaurantFault,
  handleNoRiderFault,
  calculateRazorpayFeeRs,
  REASON_TEXT,
  REASON_TO_STATUS,
};
