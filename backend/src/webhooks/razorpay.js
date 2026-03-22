// src/webhooks/razorpay.js
// Handles payment events from Razorpay

const express = require('express');
const router = express.Router();
const { col, newId } = require('../config/database');
const paymentSvc = require('../services/payment');
const orderSvc = require('../services/order');
const wa = require('../services/whatsapp');
const notify = require('../services/notify');
const { getNextRetryAt, retryDefaults } = require('../utils/retry');

// ─── POST: PAYMENT EVENTS ─────────────────────────────────────
router.post('/', express.raw({ type: '*/*' }), async (req, res) => {
  res.sendStatus(200);

  let logId = null;
  try {
    const signature = req.headers['x-razorpay-signature'];
    if (!paymentSvc.verifyWebhookSignature(req.body, signature)) {
      console.error('[Razorpay] ⚠️ Invalid signature — ignoring webhook');
      return;
    }

    const event = JSON.parse(req.body);
    console.log('[Razorpay] Event:', event.event);

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

  await wa.sendStatusUpdate(
    order.phone_number_id, order.access_token, order.wa_phone,
    'CONFIRMED',
    { orderNumber: order.order_number }
  );

  // Fire-and-forget manager notification
  notify.notifyNewOrder(order).catch(err => console.error('[Notify] Failed:', err.message));

  // Auto-dispatch to 3PL delivery partner (fire-and-forget — NEVER block payment flow)
  const deliveryService = require('../services/delivery');
  deliveryService.dispatchDelivery(orderId)
    .then(async (task) => {
      console.log(`[3PL] Dispatched order ${order.order_number}: taskId=${task.taskId}`);
      // Send tracking link to customer via WhatsApp
      if (task.trackingUrl && order.phone_number_id && order.wa_phone) {
        await wa.sendText(order.phone_number_id, order.access_token, order.wa_phone,
          `🚴 Your delivery is being arranged!\n\n` +
          `📍 Track your order live:\n${task.trackingUrl}\n\n` +
          `Estimated delivery: ${task.estimatedMins || '25-35'} minutes`
        );
      }
    })
    .catch(err => {
      console.error(`[3PL] Dispatch failed for order ${order.order_number}:`, err.message);
      // Notify manager about dispatch failure — order is PAID regardless
      notify.sendManagerNotification(order.restaurant_id || order.branch_id, order.branch_id,
        `⚠️ Auto-dispatch failed for Order #${order.order_number}: ${err.message}\nPlease dispatch manually from the dashboard.`
      ).catch(() => {});
    });

  // Fire-and-forget POS order push (UrbanPiper / DotPe)
  pushOrderToPOS(order).catch(err =>
    console.error(`[POS] Order push failed for ${order.order_number}:`, err.message)
  );

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
        order.phone_number_id, order.access_token, order.wa_phone,
        {
          body   : `❌ Payment failed for order #${order.order_number}.\n\nWould you like to try again?`,
          buttons: [
            { id: 'CONFIRM_ORDER', title: '🔄 Retry Payment' },
            { id: 'CANCEL_ORDER',  title: '❌ Cancel Order'  },
          ],
        }
      );
      break;
    }

    case 'payment_link.expired': {
      const orderId = await paymentSvc.handleLinkExpired(event);
      if (!orderId) break;

      await orderSvc.updateStatus(orderId, 'CANCELLED', { cancelReason: 'Payment link expired' });

      const order = await orderSvc.getOrderDetails(orderId);
      if (!order) break;

      await wa.sendText(
        order.phone_number_id, order.access_token, order.wa_phone,
        `⏱️ Payment for order #${order.order_number} expired.\n\nType *MENU* to start a new order anytime!`
      );
      break;
    }

    case 'refund.processed': {
      const refund = event.payload?.refund?.entity;
      if (!refund) break;
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
