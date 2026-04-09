// src/webhooks/razorpay.js
// Handles payment events from Razorpay

const express = require('express');
const router = express.Router();
const { col, newId } = require('../config/database');
const paymentSvc = require('../services/payment');
const orderSvc = require('../services/order');
const wa = require('../services/whatsapp');
const notify = require('../services/notify');
const orderNotify = require('../services/orderNotify');
const { resolveRecipient } = require('../services/customerIdentity');
const { getNextRetryAt, retryDefaults } = require('../utils/retry');
const { logActivity } = require('../services/activityLog');
const ws = require('../services/websocket');
const log = require('../utils/logger').child({ component: 'razorpay' });

// ─── POST: PAYMENT EVENTS ─────────────────────────────────────
router.post('/', express.raw({ type: '*/*' }), async (req, res) => {
  res.sendStatus(200);

  let logId = null;
  try {
    const signature = req.headers['x-razorpay-signature'];
    if (!paymentSvc.verifyWebhookSignature(req.body, signature)) {
      req.log.error('Invalid signature — ignoring webhook');
      logActivity({
        actorType: 'system', actorId: null, actorName: 'Razorpay Webhook',
        action: 'payment.signature_invalid', category: 'payment',
        description: 'Razorpay webhook signature verification failed',
        resourceType: 'webhook', resourceId: null, severity: 'critical',
      });
      return;
    }

    const event = JSON.parse(req.body);
    req.log.info({ event: event.event }, 'Webhook event received');

    logActivity({ actorType: 'webhook', action: 'payment.webhook_received', category: 'payment', description: `Razorpay event: ${event.event}`, resourceType: 'webhook', severity: 'info' });

    logId = newId();
    await col('webhook_logs').insertOne({
      _id: logId,
      source: 'razorpay',
      event_type: event.event,
      phone_number_id: null,
      payload: event,
      processed: false,
      error_message: null,
      received_at: new Date(),
      processed_at: null,
      ...retryDefaults(),
    }).catch(() => {});

    await processRazorpayWebhook(logId, event);

    // Mark webhook as processed
    await col('webhook_logs').updateOne(
      { _id: logId },
      { $set: { processed: true, processed_at: new Date(), retry_status: 'success' } }
    ).catch(() => {});
  } catch (err) {
    req.log.error({ err }, 'Webhook error');
    // Schedule for retry
    if (logId) {
      await col('webhook_logs').updateOne(
        { _id: logId },
        {
          $set: { error_message: err.message, last_error: err.message, retry_status: 'pending', next_retry_at: getNextRetryAt(0) },
          $push: { error_history: { error: err.message, attempted_at: new Date() } },
        }
      ).catch(() => {});
    }
  }
});

// ─── REUSABLE PROCESSOR (called by POST handler and retry job) ──
const processRazorpayWebhook = async (logId, event) => {
  await handleEvent(event);
};

// ─── REVALIDATE ORDER BEFORE PAYMENT CONFIRMATION ────────────
// Checks that items, branch, and prices are still valid for delayed payments.
// Returns { valid: true } or { valid: false, reason: '...' }
const revalidateOrderForPayment = async (orderId) => {
  const order = await col('orders').findOne({ _id: orderId });
  if (!order) return { valid: false, reason: 'Order not found' };

  // 1. Check if order is in a state that can accept payment
  const payableStates = ['PENDING_PAYMENT', 'PAYMENT_FAILED'];
  if (!payableStates.includes(order.status)) {
    if (order.status === 'EXPIRED') return { valid: false, reason: 'Order expired (missed sale)' };
    if (order.status === 'CANCELLED') return { valid: false, reason: 'Order was cancelled' };
    // Already PAID or further — idempotent success
    if (['PAID', 'CONFIRMED', 'PREPARING', 'PACKED', 'DISPATCHED', 'DELIVERED'].includes(order.status)) {
      return { valid: true, alreadyPaid: true };
    }
    return { valid: false, reason: `Order in unexpected state: ${order.status}` };
  }

  // 2. Check branch exists and is active
  const branch = await col('branches').findOne({ _id: order.branch_id });
  if (!branch) return { valid: false, reason: 'Outlet no longer exists' };
  if (branch.is_active === false) return { valid: false, reason: 'Outlet is no longer active' };

  // 3. Check order age — if older than 1 hour, reject and expire
  const ageMs = Date.now() - new Date(order.created_at).getTime();
  const ORDER_EXPIRY_MS = parseInt(process.env.ORDER_EXPIRY_MINUTES || '60') * 60 * 1000;
  if (ageMs > ORDER_EXPIRY_MS) {
    return { valid: false, reason: 'Order too old — checkout expired', shouldExpire: true };
  }

  // 4. Check each item is still available and price hasn't changed materially
  const orderItems = await col('order_items').find({ order_id: String(order._id) }).toArray();
  for (const item of orderItems) {
    const menuItem = await col('menu_items').findOne({ _id: item.menu_item_id });
    if (!menuItem) return { valid: false, reason: `Item "${item.item_name}" no longer exists` };
    if (!menuItem.is_available) return { valid: false, reason: `Item "${item.item_name}" is no longer available` };

    // Price tolerance: allow up to ₹1 variance (rounding) but catch real changes
    const currentPriceRs = (menuItem.price_paise || 0) / 100;
    if (Math.abs(currentPriceRs - item.unit_price_rs) > 1) {
      return { valid: false, reason: `Price changed for "${item.item_name}" (was ₹${item.unit_price_rs}, now ₹${currentPriceRs})` };
    }
  }

  return { valid: true };
};

// ─── SHARED: CONFIRM PAID ORDER ───────────────────────────────
// Guard against double-fire: Razorpay sends both order.paid and payment.captured
// Now includes revalidation for delayed payments.
const confirmPaidOrder = async (orderId) => {
  const current = await col('orders').findOne({ _id: orderId }, { projection: { status: 1, payment_status: 1 } });
  if (current?.payment_status === 'paid') {
    log.info({ orderId }, 'Order already confirmed — skipping duplicate event');
    return;
  }

  // Revalidate before confirming — catches stale/expired orders
  const validation = await revalidateOrderForPayment(orderId);
  if (!validation.valid) {
    log.warn({ orderId, reason: validation.reason }, 'Payment revalidation failed');
    if (validation.shouldExpire) {
      // Transition to EXPIRED (missed sale) instead of confirming
      try { await orderSvc.updateStatus(orderId, 'EXPIRED', { cancelReason: validation.reason }); } catch (_) {}
    }
    logActivity({
      actorType: 'system', actorId: null, actorName: 'Razorpay',
      action: 'payment.revalidation_failed', category: 'payment',
      description: `Payment arrived but revalidation failed: ${validation.reason}`,
      resourceType: 'order', resourceId: orderId, severity: 'warning',
      metadata: { reason: validation.reason },
    });
    // Payment succeeded at Razorpay but order can't be fulfilled — will need manual refund
    return;
  }
  if (validation.alreadyPaid) return; // Idempotent — already processed

  await orderSvc.updateStatus(orderId, 'PAID');

  const order = await orderSvc.getOrderDetails(orderId);
  if (!order) return;

  // All post-payment operations run in parallel (fire-and-forget pattern)
  const _payStart = Date.now();
  const deliveryService = require('../services/delivery');
  const { POS_INTEGRATIONS_ENABLED } = require('../config/features');

  Promise.allSettled([
    // Customer notification (template or fallback)
    (async () => {
      const templateSent = await orderNotify.sendOrderTemplateMessage(orderId, 'PAID').catch(() => false);
      if (!templateSent) {
        await wa.sendStatusUpdate(order.phone_number_id, order.access_token, resolveRecipient(order), 'CONFIRMED', { orderNumber: order.order_number });
      }
    })(),
    // WebSocket broadcast
    ws.broadcastOrder(order.restaurant_id, 'payment_received', { orderId, orderNumber: order.order_number, amountRs: order.total_rs }),
    // Manager notification
    notify.notifyNewOrder(order),
    // 3PL auto-dispatch
    deliveryService.dispatchDelivery(orderId).then(async (task) => {
      log.info({ orderNumber: order.order_number, taskId: task.taskId }, 'Dispatched order');
      if (task.trackingUrl && order.phone_number_id && resolveRecipient(order)) {
        await wa.sendText(order.phone_number_id, order.access_token, resolveRecipient(order),
          `🚴 Your delivery is being arranged!\n\n📍 Track your order live:\n${task.trackingUrl}\n\nEstimated delivery: ${task.estimatedMins || '25-35'} minutes`
        );
      }
    }).catch(err => {
      log.error({ err, orderNumber: order.order_number }, 'Dispatch failed for order');
      notify.sendManagerNotification(order.restaurant_id || order.branch_id, order.branch_id,
        `⚠️ Auto-dispatch failed for Order #${order.order_number}: ${err.message}\nPlease dispatch manually from the dashboard.`
      ).catch(() => {});
    }),
    // POS push
    POS_INTEGRATIONS_ENABLED ? pushOrderToPOS(order) : Promise.resolve(),
  ]).then(() => log.info({ durationMs: Date.now() - _payStart }, 'Payment post-processing complete'))
    .catch(err => log.error({ err }, 'Post-payment tasks error'));

  logActivity({
    actorType: 'system', actorId: null, actorName: 'Razorpay',
    action: 'payment.confirmed', category: 'payment',
    description: `Payment confirmed for order #${order.order_number} — ₹${order.total_rs}`,
    restaurantId: order.restaurant_id, resourceType: 'order', resourceId: orderId, severity: 'info',
  });

  // Update conversation state to ORDER_ACTIVE so the bot knows payment is done
  if (order.conversation_id) {
    orderSvc.setState(order.conversation_id, 'ORDER_ACTIVE', {
      orderId,
      orderNumber: order.order_number,
      branchId: order.branch_id,
    }).catch(() => {}); // Non-critical
  }

  // Mark any abandoned cart as recovered
  try {
    const cartRecovery = require('../services/cart-recovery');
    const customerPhone = order.wa_phone || resolveRecipient(order);
    await cartRecovery.markRecovered(customerPhone, order.restaurant_id, orderId);
  } catch (_) {} // Non-critical

  // Confirm referral commission after payment
  try {
    const refAttr = require('../services/referralAttribution');
    await refAttr.confirmCommission(orderId);
  } catch (_) {} // Non-critical

  log.info({ orderNumber: order.order_number, totalRs: order.total_rs }, 'Order PAID');
};

async function pushOrderToPOS(order) {
  const integration = await col('restaurant_integrations').findOne({
    restaurant_id: order.restaurant_id,
    is_active: true,
    platform: { $in: ['urbanpiper', 'dotpe'] },
  });
  if (!integration) return; // No active POS integration

  const items = await col('order_items').find({ order_id: String(order._id) }).toArray();
  const svc = require(`../services/integrations/${integration.platform}`);
  if (!svc.pushOrder) return;

  const result = await svc.pushOrder(integration, order, items);
  if (result?.externalOrderId) {
    await col('orders').updateOne(
      { _id: order._id },
      { $set: { pos_external_id: result.externalOrderId, pos_platform: integration.platform } }
    );
  }
}

// ─── EVENT ROUTER ─────────────────────────────────────────────
const handleEvent = async (event) => {
  // Idempotency guard — deduplicate by Razorpay event ID or entity ID
  const { once } = require('../utils/idempotency');
  const entityId = event.payload?.payment?.entity?.id
    || event.payload?.order?.entity?.id
    || event.payload?.refund?.entity?.id
    || event.payload?.payout?.entity?.id
    || event.account_id;
  const eventKey = `${event.event}:${entityId || Date.now()}`;
  const isNew = await once('razorpay', eventKey, { eventType: event.event });
  if (!isNew) return;

  switch (event.event) {

    case 'order.paid':
    case 'payment.captured': {
      // Check if this is a wallet top-up payment
      const rpOrderId = event.payload?.order?.entity?.id || event.payload?.payment?.entity?.order_id;
      if (rpOrderId) {
        const walletPayment = await col('payments').findOne({ rp_order_id: rpOrderId, payment_type: 'wallet_topup' });
        if (walletPayment && walletPayment.status !== 'paid') {
          const walletSvc = require('../services/wallet');
          await walletSvc.credit(walletPayment.restaurant_id, walletPayment.amount_rs, `Razorpay top-up ₹${walletPayment.amount_rs}`, rpOrderId);
          await paymentSvc.updatePaymentWithAudit({ _id: walletPayment._id }, { status: 'paid', paid_at: new Date() }, 'razorpay:wallet_topup');
          logActivity({ actorType: 'restaurant', actorId: walletPayment.restaurant_id, action: 'wallet.topup', category: 'billing', description: `Wallet topped up ₹${walletPayment.amount_rs}`, restaurantId: walletPayment.restaurant_id, severity: 'info' });
          break;
        }
      }
      const orderId = await paymentSvc.handleOrderPaid(event);
      if (!orderId) break;
      await confirmPaidOrder(orderId);
      break;
    }

    case 'payment_link.paid': {
      const orderId = await paymentSvc.handlePaymentSuccess(event);
      if (!orderId) break;
      await confirmPaidOrder(orderId);
      break;
    }

    case 'payment.failed': {
      const orderId = await paymentSvc.handlePaymentFailed(event);
      if (!orderId) break;

      // Transition order to PAYMENT_FAILED (retryable state)
      try {
        await orderSvc.updateStatus(orderId, 'PAYMENT_FAILED', {
          cancelReason: 'Payment failed via Razorpay',
          metadata: { razorpay_event: event.event, entity_id: entityId },
        });
      } catch (stateErr) {
        // May fail if already in EXPIRED or CANCELLED — non-fatal
        log.warn({ err: stateErr, orderId }, 'Could not transition to PAYMENT_FAILED');
      }

      const order = await orderSvc.getOrderDetails(orderId);
      if (!order) break;

      await wa.sendButtons(
        order.phone_number_id, order.access_token, resolveRecipient(order),
        {
          body   : `❌ Payment failed for order #${order.order_number}.\n\nWould you like to try again?`,
          buttons: [
            { id: 'CONFIRM_ORDER', title: '🔄 Retry Payment' },
            { id: 'CANCEL_ORDER',  title: '❌ Cancel Order'  },
          ],
        }
      );

      // Track as payment_failed abandoned cart
      const { guard } = require('../utils/smartModule');
      await guard('CART_RECOVERY', {
        fn: async () => {
          const cartRecovery = require('../services/cart-recovery');
          const customer = await col('customers').findOne({ _id: order.customer_id });
          return cartRecovery.trackAbandonedCart({
            restaurantId: order.restaurant_id, branchId: order.branch_id,
            customerId: order.customer_id, customerPhone: customer?.wa_phone || resolveRecipient(order),
            customerName: customer?.name || order.customer_name,
            cartItems: (order.items || []).map(i => ({ product_retailer_id: i.retailer_id, quantity: i.quantity, item_price: i.unit_price_rs, currency: 'INR', item_name: i.item_name })),
            cartTotal: order.total_rs || 0, itemCount: (order.items || []).reduce((s, i) => s + i.quantity, 0),
            abandonmentStage: 'payment_failed', abandonmentReason: 'payment_failed',
            deliveryAddress: order.delivery_address ? { full_address: order.delivery_address } : null,
            lastCustomerMessageAt: new Date(),
          });
        },
        fallback: undefined,
        label: 'trackAbandonedCart:paymentFailed',
        context: { orderId },
      });

      logActivity({
        actorType: 'system', actorId: null, actorName: 'Razorpay',
        action: 'payment.failed', category: 'payment',
        description: `Payment failed for order #${order.order_number}`,
        restaurantId: order.restaurant_id, resourceType: 'order', resourceId: orderId, severity: 'warning',
      });
      break;
    }

    case 'payment_link.expired': {
      const orderId = await paymentSvc.handleLinkExpired(event);
      if (!orderId) break;

      // Transition to EXPIRED (missed sale) — NOT CANCELLED
      try {
        await orderSvc.updateStatus(orderId, 'EXPIRED', { cancelReason: 'Payment link expired' });
      } catch (stateErr) {
        log.warn({ err: stateErr, orderId }, 'Could not transition to EXPIRED on link expiry');
      }

      const order = await orderSvc.getOrderDetails(orderId);
      if (!order) break;

      await wa.sendText(
        order.phone_number_id, order.access_token, resolveRecipient(order),
        `⏱️ Payment for order #${order.order_number} expired.\n\nType *MENU* to start a new order anytime!`
      );
      break;
    }

    case 'order.expired': {
      // Razorpay order expired (default 30min) — mark as missed sale
      const rpOrderId = event.payload?.order?.entity?.id;
      if (!rpOrderId) break;

      const payment = await col('payments').findOne({ rp_order_id: rpOrderId });
      if (!payment?.order_id) break;

      await paymentSvc.updatePaymentWithAudit(
        { _id: payment._id, status: { $nin: ['paid', 'refunded'] } },
        { status: 'expired' },
        'razorpay:order.expired'
      );

      try {
        await orderSvc.updateStatus(payment.order_id, 'EXPIRED', { cancelReason: 'Razorpay order expired' });
      } catch (stateErr) {
        log.warn({ err: stateErr, orderId: payment.order_id }, 'Could not transition to EXPIRED on order expiry');
      }

      log.info({ orderId: payment.order_id, rpOrderId }, 'Order expired — missed sale');
      logActivity({
        actorType: 'system', actorId: null, actorName: 'Razorpay',
        action: 'order.expired', category: 'payment',
        description: `Order expired (missed sale) — Razorpay order ${rpOrderId}`,
        resourceType: 'order', resourceId: payment.order_id, severity: 'warning',
      });
      break;
    }

    case 'refund.processed': {
      const refund = event.payload?.refund?.entity;
      if (!refund) break;
      logActivity({
        actorType: 'system', actorId: null, actorName: 'Razorpay',
        action: 'payment.refund_processed', category: 'payment',
        description: `Refund ${refund.id} processed: ₹${refund.amount / 100}`,
        resourceType: 'refund', resourceId: refund.id, severity: 'info',
      });
      log.info({ refundId: refund.id, amountRs: refund.amount / 100 }, 'Refund processed');
      break;
    }

    case 'payout.processed':
    case 'payout.failed':
    case 'payout.reversed': {
      const payoutEntity = event.payload?.payout?.entity;
      if (!payoutEntity) break;

      // ─── v2 (per-order settlement) ─────────────────────────
      // The new payout engine handles per-order settlements with full idempotency.
      const payoutEngine = require('../services/payoutEngine');
      const v2Result = await payoutEngine.handlePayoutWebhook(eventKey, event.event, payoutEntity);

      // If v2 handled it (not a legacy payout), we're done.
      if (v2Result.success || v2Result.duplicate) {
        log.info({ rpPayoutId: payoutEntity.id, eventType: event.event, ...v2Result }, 'v2 payout webhook handled');
        break;
      }

      // ─── v1 (legacy weekly settlements) ─────────────────────
      // Fall through to legacy handler for backward compatibility.
      if (event.event === 'payout.processed') {
        const settleDoc = await col('settlements').findOneAndUpdate(
          { rp_payout_id: payoutEntity.id },
          { $set: { payout_status: 'completed', payout_completed_at: new Date() } },
          { returnDocument: 'after' }
        );
        log.info({ payoutId: payoutEntity.id, amountRs: payoutEntity.amount / 100 }, 'Legacy payout processed');
        if (settleDoc) {
          logActivity({
            actorType: 'system', actorId: null, actorName: 'Razorpay',
            action: 'settlement.payout_completed', category: 'billing',
            description: `Legacy payout ₹${payoutEntity.amount / 100} completed (${payoutEntity.id})`,
            restaurantId: settleDoc.restaurant_id, resourceType: 'settlement', resourceId: String(settleDoc._id), severity: 'info',
            metadata: { payout_id: payoutEntity.id, amount_rs: payoutEntity.amount / 100, utr: payoutEntity.utr },
          });
        }
      } else if (event.event === 'payout.failed') {
        const settleDoc2 = await col('settlements').findOneAndUpdate(
          { rp_payout_id: payoutEntity.id },
          { $set: { payout_status: 'failed' } },
          { returnDocument: 'after' }
        );
        log.error({ payoutId: payoutEntity.id, failureReason: payoutEntity.failure_reason }, 'Legacy payout failed');
        if (settleDoc2) {
          logActivity({
            actorType: 'system', actorId: null, actorName: 'Razorpay',
            action: 'settlement.payout_failed', category: 'billing',
            description: `Legacy payout failed: ${payoutEntity.failure_reason || 'unknown'}`,
            restaurantId: settleDoc2.restaurant_id, resourceType: 'settlement', resourceId: String(settleDoc2._id), severity: 'error',
            metadata: { payout_id: payoutEntity.id, failure_reason: payoutEntity.failure_reason },
          });
        }
      } else if (event.event === 'payout.reversed') {
        // Legacy doesn't have a reversal handler — log for manual review
        log.error({ payoutId: payoutEntity.id }, 'Legacy payout reversed — needs manual review');
        logActivity({
          actorType: 'system', actorName: 'Razorpay',
          action: 'settlement.payout_reversed', category: 'billing',
          description: `Legacy payout reversed: ${payoutEntity.id} — REQUIRES MANUAL REVIEW`,
          severity: 'critical',
          metadata: { payout_id: payoutEntity.id, amount_rs: payoutEntity.amount / 100 },
        });
      }
      break;
    }

    default:
      log.info({ event: event.event }, 'Unhandled event');
  }
};

module.exports = router;
module.exports.processRazorpayWebhook = processRazorpayWebhook;
module.exports.confirmPaidOrder = confirmPaidOrder;
