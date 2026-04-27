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

    // Order cancelled template — fires first so the customer sees the
    // cancellation reason before the separate refund confirmation.
    fireAndForget(
      orderNotify.sendOrderTemplateMessage(orderId, fresh.status, ctx),
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
    'DELIVERED', 'CANCELLED', 'EXPIRED', 'RTO_COMPLETE',
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
