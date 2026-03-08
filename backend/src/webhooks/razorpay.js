// src/webhooks/razorpay.js
// Handles payment events from Razorpay

const express = require('express');
const router = express.Router();
const { col, newId } = require('../config/database');
const paymentSvc = require('../services/payment');
const orderSvc = require('../services/order');
const wa = require('../services/whatsapp');

// ─── POST: PAYMENT EVENTS ─────────────────────────────────────
router.post('/', express.raw({ type: '*/*' }), async (req, res) => {
  res.sendStatus(200);

  try {
    const signature = req.headers['x-razorpay-signature'];
    if (!paymentSvc.verifyWebhookSignature(req.body, signature)) {
      console.error('[Razorpay] ⚠️ Invalid signature — ignoring webhook');
      return;
    }

    const event = JSON.parse(req.body);
    console.log('[Razorpay] Event:', event.event);

    await col('webhook_logs').insertOne({
      _id: newId(),
      source: 'razorpay',
      event_type: event.event,
      phone_number_id: null,
      payload: event,
      processed: false,
      error_message: null,
      received_at: new Date(),
      processed_at: null,
    }).catch(() => {});

    await handleEvent(event);
  } catch (err) {
    console.error('[Razorpay] Webhook error:', err.message);
  }
});

// ─── SHARED: CONFIRM PAID ORDER ───────────────────────────────
const confirmPaidOrder = async (orderId) => {
  await orderSvc.updateStatus(orderId, 'PAID');

  const order = await orderSvc.getOrderDetails(orderId);
  if (!order) return;

  await wa.sendStatusUpdate(
    order.phone_number_id, order.access_token, order.wa_phone,
    'CONFIRMED',
    { orderNumber: order.order_number }
  );

  console.log(`✅ Order ${order.order_number} PAID — ₹${order.total_rs}`);
};

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
