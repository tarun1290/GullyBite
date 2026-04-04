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

// ─── POST: PAYMENT EVENTS ─────────────────────────────────────
router.post('/', express.raw({ type: '*/*' }), async (req, res) => {
  res.sendStatus(200);

  let logId = null;
  try {
    const signature = req.headers['x-razorpay-signature'];
    if (!paymentSvc.verifyWebhookSignature(req.body, signature)) {
      console.error('[Razorpay] ⚠️ Invalid signature — ignoring webhook');
      logActivity({
        actorType: 'system', actorId: null, actorName: 'Razorpay Webhook',
        action: 'payment.signature_invalid', category: 'payment',
        description: 'Razorpay webhook signature verification failed',
        resourceType: 'webhook', resourceId: null, severity: 'critical',
      });
      return;
    }

    const event = JSON.parse(req.body);
    console.log('[Razorpay] Event:', event.event);

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
    console.error('[Razorpay] Webhook error:', err.message);
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

// ─── SHARED: CONFIRM PAID ORDER ───────────────────────────────
// Guard against double-fire: Razorpay sends both order.paid and payment.captured
const confirmPaidOrder = async (orderId) => {
  const current = await col('orders').findOne({ _id: orderId }, { projection: { payment_status: 1 } });
  if (current?.payment_status === 'paid') {
    console.log(`[Razorpay] Order ${orderId} already confirmed — skipping duplicate event`);
    return;
  }

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
      console.log(`[3PL] Dispatched order ${order.order_number}: taskId=${task.taskId}`);
      if (task.trackingUrl && order.phone_number_id && resolveRecipient(order)) {
        await wa.sendText(order.phone_number_id, order.access_token, resolveRecipient(order),
          `🚴 Your delivery is being arranged!\n\n📍 Track your order live:\n${task.trackingUrl}\n\nEstimated delivery: ${task.estimatedMins || '25-35'} minutes`
        );
      }
    }).catch(err => {
      console.error(`[3PL] Dispatch failed for order ${order.order_number}:`, err.message);
      notify.sendManagerNotification(order.restaurant_id || order.branch_id, order.branch_id,
        `⚠️ Auto-dispatch failed for Order #${order.order_number}: ${err.message}\nPlease dispatch manually from the dashboard.`
      ).catch(() => {});
    }),
    // POS push
    POS_INTEGRATIONS_ENABLED ? pushOrderToPOS(order) : Promise.resolve(),
  ]).then(() => console.log(`[Perf] Payment post-processing: ${Date.now() - _payStart}ms`))
    .catch(err => console.error('[Razorpay] Post-payment tasks error:', err.message));

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

  console.log(`✅ Order ${order.order_number} PAID — ₹${order.total_rs}`);
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
          await col('payments').updateOne({ _id: walletPayment._id }, { $set: { status: 'paid', paid_at: new Date() } });
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
      try {
        const cartRecovery = require('../services/cart-recovery');
        const customer = await col('customers').findOne({ _id: order.customer_id });
        await cartRecovery.trackAbandonedCart({
          restaurantId: order.restaurant_id, branchId: order.branch_id,
          customerId: order.customer_id, customerPhone: customer?.wa_phone || resolveRecipient(order),
          customerName: customer?.name || order.customer_name,
          cartItems: (order.items || []).map(i => ({ product_retailer_id: i.retailer_id, quantity: i.quantity, item_price: i.unit_price_rs, currency: 'INR', item_name: i.item_name })),
          cartTotal: order.total_rs || 0, itemCount: (order.items || []).reduce((s, i) => s + i.quantity, 0),
          abandonmentStage: 'payment_failed', abandonmentReason: 'payment_failed',
          deliveryAddress: order.delivery_address ? { full_address: order.delivery_address } : null,
          lastCustomerMessageAt: new Date(),
        });
      } catch (e) { console.warn('[Cart Recovery] Track payment_failed:', e.message); }

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

      await orderSvc.updateStatus(orderId, 'CANCELLED', { cancelReason: 'Payment link expired' });

      const order = await orderSvc.getOrderDetails(orderId);
      if (!order) break;

      await wa.sendText(
        order.phone_number_id, order.access_token, resolveRecipient(order),
        `⏱️ Payment for order #${order.order_number} expired.\n\nType *MENU* to start a new order anytime!`
      );
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
      console.log(`✅ Refund ${refund.id} processed: ₹${refund.amount / 100}`);
      break;
    }

    case 'payout.processed': {
      const payout = event.payload?.payout?.entity;
      if (!payout) break;
      await col('settlements').updateOne(
        { rp_payout_id: payout.id },
        { $set: { payout_status: 'completed', payout_at: new Date() } }
      );
      console.log(`✅ Payout ${payout.id} processed: ₹${payout.amount / 100}`);
      break;
    }

    case 'payout.failed': {
      const payout = event.payload?.payout?.entity;
      if (!payout) break;
      await col('settlements').updateOne(
        { rp_payout_id: payout.id },
        { $set: { payout_status: 'failed' } }
      );
      console.error(`❌ Payout ${payout.id} failed:`, payout.failure_reason);
      break;
    }

    default:
      console.log('[Razorpay] Unhandled event:', event.event);
  }
};

module.exports = router;
module.exports.processRazorpayWebhook = processRazorpayWebhook;
module.exports.confirmPaidOrder = confirmPaidOrder;
