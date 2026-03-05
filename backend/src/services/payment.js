// src/services/payment.js
// Razorpay payment integration
// Creates payment links → customer pays → webhook confirms

const Razorpay = require('razorpay');
const crypto = require('crypto');
const db = require('../config/database');

const rzp = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ─── CREATE PAYMENT LINK ──────────────────────────────────────
// Generates a short Razorpay URL and saves to DB
// We send this URL to the customer via WhatsApp
// When they pay, Razorpay calls our webhook at /webhooks/razorpay
const createPaymentLink = async (order, customer) => {
  const expiryMins = parseInt(process.env.PAYMENT_LINK_EXPIRY_MINS) || 15;
  const expiresAt = Math.floor(Date.now() / 1000) + expiryMins * 60; // Unix timestamp

  const linkData = {
    amount: Math.round(order.total_rs * 100), // Razorpay needs paise (rupees × 100)
    currency: 'INR',
    accept_partial: false,
    description: `Order ${order.order_number} — ${order.business_name}`,
    customer: {
      name: customer.name || 'Customer',
      contact: customer.wa_phone.startsWith('+') ? customer.wa_phone : `+${customer.wa_phone}`,
    },
    notify: { sms: false, email: false }, // We handle notifications via WhatsApp
    reminder_enable: false,
    // IMPORTANT: These notes come back in the webhook payload
    // We use order_id to match the payment to our order
    notes: {
      order_id: order.id,
      order_number: order.order_number,
      customer_wa: customer.wa_phone,
    },
    callback_url: `${process.env.BASE_URL}/payment-success`,
    callback_method: 'get',
    expire_by: expiresAt,
  };

  const link = await rzp.paymentLink.create(linkData);

  // Save to our DB
  await db.query(
    `INSERT INTO payments (order_id, rp_link_id, rp_link_url, amount_rs, status, expires_at)
     VALUES ($1, $2, $3, $4, 'sent', to_timestamp($5))`,
    [order.id, link.id, link.short_url, order.total_rs, expiresAt]
  );

  return { id: link.id, url: link.short_url, expiryMins };
};

// ─── VERIFY WEBHOOK SIGNATURE ─────────────────────────────────
// CRITICAL SECURITY CHECK — always do this first!
// Razorpay signs every webhook with HMAC-SHA256 using your webhook secret
// If signature doesn't match → someone is trying to fake a payment confirmation!
const verifyWebhookSignature = (rawBody, signature) => {
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  // Use timingSafeEqual to prevent timing attacks (comparing strings character by character)
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
};

// ─── HANDLE PAYMENT CAPTURED ──────────────────────────────────
// Called when Razorpay webhook confirms successful payment
// Updates our payment record and returns the order ID
const handlePaymentSuccess = async (event) => {
  const linkId = event.payload?.payment_link?.entity?.id;
  const paymentEntity = event.payload?.payment?.entity;

  // Find our payment record using the link ID
  const { rows } = await db.query(
    'SELECT * FROM payments WHERE rp_link_id = $1',
    [linkId]
  );
  if (!rows.length) {
    console.error('[Payment] No payment record found for link:', linkId);
    return null;
  }

  // Update payment with full details
  await db.query(
    `UPDATE payments SET
       status = 'paid',
       rp_payment_id = $1,
       rp_order_id = $2,
       payment_method = $3,
       paid_at = NOW()
     WHERE rp_link_id = $4`,
    [paymentEntity?.id, paymentEntity?.order_id, paymentEntity?.method, linkId]
  );

  return rows[0].order_id;
};

// ─── HANDLE PAYMENT FAILURE ───────────────────────────────────
const handlePaymentFailed = async (event) => {
  const linkId = event.payload?.payment_link?.entity?.id;
  if (!linkId) return null;

  await db.query('UPDATE payments SET status=$1 WHERE rp_link_id=$2', ['failed', linkId]);

  const { rows } = await db.query('SELECT order_id FROM payments WHERE rp_link_id=$1', [linkId]);
  return rows[0]?.order_id;
};

// ─── HANDLE PAYMENT LINK EXPIRED ──────────────────────────────
const handleLinkExpired = async (event) => {
  const linkId = event.payload?.payment_link?.entity?.id;
  if (!linkId) return null;

  await db.query(
    "UPDATE payments SET status='expired' WHERE rp_link_id=$1 AND status != 'paid'",
    [linkId]
  );

  const { rows } = await db.query('SELECT order_id FROM payments WHERE rp_link_id=$1', [linkId]);
  return rows[0]?.order_id;
};

// ─── ISSUE REFUND ─────────────────────────────────────────────
// Called when an already-paid order is cancelled
const issueRefund = async (orderId, reason = 'Order cancelled') => {
  const { rows } = await db.query(
    "SELECT * FROM payments WHERE order_id=$1 AND status='paid'",
    [orderId]
  );
  if (!rows.length) return null;

  const payment = rows[0];
  const refund = await rzp.payments.refund(payment.rp_payment_id, {
    amount: Math.round(payment.amount_rs * 100),
    notes: { reason, order_id: orderId },
  });

  await db.query("UPDATE payments SET status='refunded' WHERE id=$1", [payment.id]);
  return refund;
};

module.exports = {
  createPaymentLink,
  verifyWebhookSignature,
  handlePaymentSuccess,
  handlePaymentFailed,
  handleLinkExpired,
  issueRefund,
};