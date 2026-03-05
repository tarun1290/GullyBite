// src/webhooks/razorpay.js
// Handles payment events from Razorpay
// Razorpay calls this URL when: payment succeeds, fails, or link expires

const express = require('express');
const router = express.Router();
const db = require('../config/database');
const paymentSvc = require('../services/payment');
const orderSvc = require('../services/order');
const wa = require('../services/whatsapp');

// ─── POST: PAYMENT EVENTS ─────────────────────────────────────
// Razorpay sends signed POST requests here for every payment event
// raw body required for signature verification
router.post('/', express.raw({ type: '*/*' }), async (req, res) => {
  // 1. Respond immediately
  res.sendStatus(200);

  try {
    // 2. VERIFY SIGNATURE — critical security step!
    const signature = req.headers['x-razorpay-signature'];
    if (!paymentSvc.verifyWebhookSignature(req.body, signature)) {
      console.error('[Razorpay] ⚠️ Invalid signature — ignoring webhook');
      return;
    }

    const event = JSON.parse(req.body);
    console.log('[Razorpay] Event:', event.event);

    // 3. Log the webhook for analytics
    await db.query(
      "INSERT INTO webhook_logs (source, event_type, payload) VALUES ('razorpay', $1, $2)",
      [event.event, JSON.stringify(event)]
    ).catch(() => {});

    // 4. Handle different event types
    await handleEvent(event);
  } catch (err) {
    console.error('[Razorpay] Webhook error:', err.message);
  }
});

// ─── EVENT ROUTER ─────────────────────────────────────────────
const handleEvent = async (event) => {
  switch (event.event) {

    // ── PAYMENT SUCCESS ──────────────────────────────────────
    // Customer paid! Most important event.
    case 'payment_link.paid': {
      const orderId = await paymentSvc.handlePaymentSuccess(event);
      if (!orderId) break;

      // Update order status
      await orderSvc.updateStatus(orderId, 'PAID');

      // Get full order details to notify customer
      const order = await orderSvc.getOrderDetails(orderId);
      if (!order) break;

      // Notify customer on WhatsApp ✅
      await wa.sendStatusUpdate(
        order.phone_number_id, order.access_token, order.wa_phone,
        'CONFIRMED',
        { orderNumber: order.order_number }
      );

      // TODO: Notify restaurant owner (via WhatsApp or dashboard push)
      console.log(`✅ Order ${order.order_number} PAID — amount: ₹${order.total_rs}`);
      break;
    }

    // ── PAYMENT FAILED ───────────────────────────────────────
    case 'payment.failed': {
      const orderId = await paymentSvc.handlePaymentFailed(event);
      if (!orderId) break;

      const order = await orderSvc.getOrderDetails(orderId);
      if (!order) break;

      // Tell customer their payment failed
      await wa.sendButtons(
        order.phone_number_id, order.access_token, order.wa_phone,
        {
          body: `❌ Payment failed for order #${order.order_number}.\n\nWould you like to try again?`,
          buttons: [
            { id: 'CONFIRM_ORDER', title: '🔄 Retry Payment' },
            { id: 'CANCEL_ORDER', title: '❌ Cancel Order' },
          ],
        }
      );
      break;
    }

    // ── PAYMENT LINK EXPIRED ─────────────────────────────────
    case 'payment_link.expired': {
      const orderId = await paymentSvc.handleLinkExpired(event);
      if (!orderId) break;

      await orderSvc.updateStatus(orderId, 'CANCELLED', { cancelReason: 'Payment link expired' });

      const order = await orderSvc.getOrderDetails(orderId);
      if (!order) break;

      await wa.sendText(
        order.phone_number_id, order.access_token, order.wa_phone,
        `⏱️ Payment link for order #${order.order_number} expired.\n\nType *MENU* to start a new order anytime! 😊`
      );
      break;
    }

    // ── REFUND PROCESSED ─────────────────────────────────────
    case 'refund.processed': {
      const refund = event.payload?.refund?.entity;
      if (!refund) break;
      console.log(`✅ Refund ${refund.id} processed: ₹${refund.amount / 100}`);
      // Could notify customer here if needed
      break;
    }

    default:
      // Log unhandled events
      console.log('[Razorpay] Unhandled event:', event.event);
  }
};

module.exports = router;