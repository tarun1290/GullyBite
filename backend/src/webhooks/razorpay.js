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

// ─── SHARED: CONFIRM PAID ORDER ───────────────────────────────
// Called by both WhatsApp Pay and payment link success paths.
// Updates status, notifies customer, logs the payment.
const confirmPaidOrder = async (orderId) => {
  await orderSvc.updateStatus(orderId, 'PAID');

  const order = await orderSvc.getOrderDetails(orderId);
  if (!order) return;

  // WhatsApp Pay shows its own in-app confirmation, but we send one too
  // so the customer has a clear record in their chat.
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

    // ── WHATSAPP PAY SUCCESS (primary flow) ──────────────────
    // Fires when the customer pays through native WhatsApp Pay (UPI).
    // Both events carry the Razorpay order ID used to match our record.
    case 'order.paid':
    case 'payment.captured': {
      const orderId = await paymentSvc.handleOrderPaid(event);
      if (!orderId) break;
      await confirmPaidOrder(orderId);
      break;
    }

    // ── PAYMENT LINK SUCCESS (fallback flow) ─────────────────
    // Fires when the customer pays via the Razorpay link sent as text.
    case 'payment_link.paid': {
      const orderId = await paymentSvc.handlePaymentSuccess(event);
      if (!orderId) break;
      await confirmPaidOrder(orderId);
      break;
    }

    // ── PAYMENT FAILED ───────────────────────────────────────
    // Covers both WhatsApp Pay and payment link failures.
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

    // ── PAYMENT LINK EXPIRED (fallback flow) ─────────────────
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

    // ── REFUND PROCESSED ─────────────────────────────────────
    case 'refund.processed': {
      const refund = event.payload?.refund?.entity;
      if (!refund) break;
      console.log(`✅ Refund ${refund.id} processed: ₹${refund.amount / 100}`);
      break;
    }

    // ── PAYOUT EVENTS (weekly settlement) ────────────────────
    case 'payout.processed': {
      const payout = event.payload?.payout?.entity;
      if (!payout) break;
      await db.query(
        "UPDATE settlements SET payout_status='completed', payout_at=NOW() WHERE rp_payout_id=$1",
        [payout.id]
      );
      console.log(`✅ Payout ${payout.id} processed: ₹${payout.amount / 100}`);
      break;
    }
    case 'payout.failed': {
      const payout = event.payload?.payout?.entity;
      if (!payout) break;
      await db.query(
        "UPDATE settlements SET payout_status='failed' WHERE rp_payout_id=$1",
        [payout.id]
      );
      console.error(`❌ Payout ${payout.id} failed:`, payout.failure_reason);
      break;
    }

    default:
      console.log('[Razorpay] Unhandled event:', event.event);
  }
};

module.exports = router;