// src/services/payment.js
// Razorpay payment integration — TWO payment flows:
//
//   1. WhatsApp Pay (primary)
//      createRazorpayOrder() → send order_details WhatsApp message →
//      customer pays inside WhatsApp (UPI) → Razorpay fires order.paid webhook
//
//   2. Payment Link (fallback — for non-WhatsApp-Pay regions or errors)
//      createPaymentLink() → send URL via WhatsApp text →
//      customer opens browser → Razorpay fires payment_link.paid webhook
//
// Settlements → GullyBite collects all money → weekly payout to restaurants
//   registerPayoutAccount() registers restaurant's bank account with Razorpay X
//   createPayout() transfers the net settlement amount to their account

const Razorpay = require('razorpay');
const crypto  = require('crypto');
const db       = require('../config/database');

// Lazy init — avoid crashing on startup if env vars aren't set yet
let _rzp = null;
const getRzp = () => {
  if (!_rzp) {
    if (!process.env.RAZORPAY_KEY_ID) throw new Error('RAZORPAY_KEY_ID env var is not set');
    _rzp = new Razorpay({
      key_id    : process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return _rzp;
};

// ─── 1. CREATE RAZORPAY ORDER (WhatsApp Pay) ──────────────────
// Creates a Razorpay Order that powers the native WhatsApp Pay flow.
// The order ID is referenced in the WhatsApp order_details message.
// When the customer pays, Razorpay fires order.paid webhook.
const createRazorpayOrder = async (order, customer) => {
  const expiryMins = parseInt(process.env.PAYMENT_LINK_EXPIRY_MINS) || 15;

  const rzpOrder = await getRzp().orders.create({
    amount  : Math.round(order.total_rs * 100), // paise
    currency: 'INR',
    receipt : order.order_number,               // shows on Razorpay dashboard
    // notes come back verbatim in every webhook — used to match our order
    notes: {
      order_id    : order.id,
      order_number: order.order_number,
      customer_wa : customer.wa_phone,
    },
  });

  const expiresAt = new Date(Date.now() + expiryMins * 60 * 1000);

  await db.query(
    `INSERT INTO payments
       (order_id, rp_order_id, amount_rs, status, payment_type, expires_at)
     VALUES ($1, $2, $3, 'sent', 'whatsapp_pay', $4)`,
    [order.id, rzpOrder.id, order.total_rs, expiresAt]
  );

  return rzpOrder;
};

// ─── 2. CREATE PAYMENT LINK (fallback) ────────────────────────
// Used when WhatsApp Pay is unavailable or sendPaymentRequest fails.
// Sends a short Razorpay URL the customer opens in a browser.
const createPaymentLink = async (order, customer) => {
  const expiryMins = parseInt(process.env.PAYMENT_LINK_EXPIRY_MINS) || 15;
  const expiresAt  = Math.floor(Date.now() / 1000) + expiryMins * 60;

  const link = await getRzp().paymentLink.create({
    amount        : Math.round(order.total_rs * 100),
    currency      : 'INR',
    accept_partial: false,
    description   : `Order ${order.order_number} — ${order.business_name}`,
    customer: {
      name   : customer.name || 'Customer',
      contact: customer.wa_phone.startsWith('+') ? customer.wa_phone : `+${customer.wa_phone}`,
    },
    notify         : { sms: false, email: false },
    reminder_enable: false,
    notes: {
      order_id    : order.id,
      order_number: order.order_number,
      customer_wa : customer.wa_phone,
    },
    callback_url   : `${process.env.BASE_URL}/payment-success`,
    callback_method: 'get',
    expire_by      : expiresAt,
  });

  await db.query(
    `INSERT INTO payments
       (order_id, rp_link_id, rp_link_url, amount_rs, status, payment_type, expires_at)
     VALUES ($1, $2, $3, $4, 'sent', 'link', to_timestamp($5))`,
    [order.id, link.id, link.short_url, order.total_rs, expiresAt]
  );

  return { id: link.id, url: link.short_url, expiryMins };
};

// ─── VERIFY WEBHOOK SIGNATURE ─────────────────────────────────
// CRITICAL SECURITY CHECK — both Razorpay webhooks call this.
// Razorpay signs every webhook with HMAC-SHA256 using your secret.
const verifyWebhookSignature = (rawBody, signature) => {
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
};

// ─── HANDLE ORDER PAID (WhatsApp Pay) ─────────────────────────
// Triggered by Razorpay webhook events: order.paid / payment.captured
// These fire when a customer pays through native WhatsApp Pay or Razorpay.
const handleOrderPaid = async (event) => {
  // order.paid gives us the order entity; payment.captured gives payment entity
  const rzpOrderId    = event.payload?.order?.entity?.id
                     || event.payload?.payment?.entity?.order_id;
  const paymentEntity = event.payload?.payment?.entity;

  if (!rzpOrderId) {
    console.warn('[Payment] handleOrderPaid: no order ID in event');
    return null;
  }

  const { rows } = await db.query(
    'SELECT * FROM payments WHERE rp_order_id = $1',
    [rzpOrderId]
  );
  if (!rows.length) {
    console.error('[Payment] No payment record for Razorpay order:', rzpOrderId);
    return null;
  }

  await db.query(
    `UPDATE payments SET
       status         = 'paid',
       rp_payment_id  = $1,
       payment_method = $2,
       paid_at        = NOW()
     WHERE rp_order_id = $3`,
    [paymentEntity?.id, paymentEntity?.method, rzpOrderId]
  );

  return rows[0].order_id;
};

// ─── HANDLE PAYMENT LINK PAID (fallback flow) ─────────────────
const handlePaymentSuccess = async (event) => {
  const linkId        = event.payload?.payment_link?.entity?.id;
  const paymentEntity = event.payload?.payment?.entity;

  const { rows } = await db.query(
    'SELECT * FROM payments WHERE rp_link_id = $1',
    [linkId]
  );
  if (!rows.length) {
    console.error('[Payment] No payment record for link:', linkId);
    return null;
  }

  await db.query(
    `UPDATE payments SET
       status         = 'paid',
       rp_payment_id  = $1,
       rp_order_id    = $2,
       payment_method = $3,
       paid_at        = NOW()
     WHERE rp_link_id = $4`,
    [paymentEntity?.id, paymentEntity?.order_id, paymentEntity?.method, linkId]
  );

  return rows[0].order_id;
};

// ─── HANDLE PAYMENT FAILED ────────────────────────────────────
const handlePaymentFailed = async (event) => {
  const linkId    = event.payload?.payment_link?.entity?.id;
  const rzpOrderId = event.payload?.payment?.entity?.order_id;

  if (linkId) {
    await db.query("UPDATE payments SET status='failed' WHERE rp_link_id=$1", [linkId]);
    const { rows } = await db.query('SELECT order_id FROM payments WHERE rp_link_id=$1', [linkId]);
    return rows[0]?.order_id;
  }
  if (rzpOrderId) {
    await db.query("UPDATE payments SET status='failed' WHERE rp_order_id=$1", [rzpOrderId]);
    const { rows } = await db.query('SELECT order_id FROM payments WHERE rp_order_id=$1', [rzpOrderId]);
    return rows[0]?.order_id;
  }
  return null;
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
// Called when a paid order is cancelled.
// Works for both WhatsApp Pay and payment link flows
// (both result in a rp_payment_id we can refund against).
const issueRefund = async (orderId, reason = 'Order cancelled') => {
  const { rows } = await db.query(
    "SELECT * FROM payments WHERE order_id=$1 AND status='paid'",
    [orderId]
  );
  if (!rows.length) return null;

  const payment = rows[0];
  const refund = await getRzp().payments.refund(payment.rp_payment_id, {
    amount: Math.round(payment.amount_rs * 100),
    notes : { reason, order_id: orderId },
  });

  await db.query("UPDATE payments SET status='refunded' WHERE id=$1", [payment.id]);
  return refund;
};

// ─── REGISTER RESTAURANT PAYOUT ACCOUNT ───────────────────────
// Called once when a restaurant adds their bank details.
// Creates a Razorpay Contact + Fund Account so we can pay them weekly.
// Requires Razorpay X account (razorpay.com → Razorpay X).
const registerPayoutAccount = async (restaurantId) => {
  const { rows } = await db.query(
    `SELECT id, business_name, email, phone, bank_name,
            bank_account_number, bank_ifsc, razorpay_fund_acct_id
     FROM restaurants WHERE id = $1`,
    [restaurantId]
  );
  if (!rows.length) throw new Error('Restaurant not found');
  const restaurant = rows[0];

  if (!restaurant.bank_account_number || !restaurant.bank_ifsc) {
    throw new Error('Bank account number and IFSC are required');
  }
  if (restaurant.razorpay_fund_acct_id) {
    return { alreadyRegistered: true, fundAccountId: restaurant.razorpay_fund_acct_id };
  }

  // Step 1: Create Razorpay Contact
  const contact = await getRzp().contacts.create({
    name        : restaurant.business_name,
    email       : restaurant.email       || undefined,
    contact     : restaurant.phone       || undefined,
    type        : 'vendor',               // 'vendor' = business payout recipient
    reference_id: restaurant.id,
  });

  // Step 2: Create Fund Account (bank account linked to the contact)
  const fundAccount = await getRzp().fundAccount.create({
    contact_id  : contact.id,
    account_type: 'bank_account',
    bank_account: {
      name          : restaurant.business_name,
      ifsc          : restaurant.bank_ifsc,
      account_number: restaurant.bank_account_number,
    },
  });

  // Save fund account ID — used every week during settlement
  await db.query(
    'UPDATE restaurants SET razorpay_fund_acct_id = $1 WHERE id = $2',
    [fundAccount.id, restaurantId]
  );

  console.log(`[Payment] Registered payout account for "${restaurant.business_name}": ${fundAccount.id}`);
  return { fundAccountId: fundAccount.id };
};

// ─── CREATE PAYOUT (used by weekly settlement job) ────────────
// Transfers the net settlement amount to the restaurant's bank account.
// Requires Razorpay X + RAZORPAY_ACCOUNT_NUMBER in .env.
const createPayout = async (restaurant, amountRs, settlementId) => {
  const payout = await getRzp().payouts.create({
    account_number   : process.env.RAZORPAY_ACCOUNT_NUMBER, // GullyBite's RazorpayX account
    fund_account_id  : restaurant.razorpay_fund_acct_id,
    amount           : Math.round(amountRs * 100),           // paise
    currency         : 'INR',
    mode             : 'IMPS',    // instant bank transfer
    purpose          : 'payout',
    queue_if_low_balance: true,   // don't fail if balance dips briefly
    reference_id     : settlementId,
    narration        : `GullyBite Settlement - ${restaurant.business_name}`,
  });
  return payout;
};

module.exports = {
  createRazorpayOrder,
  createPaymentLink,
  verifyWebhookSignature,
  handleOrderPaid,
  handlePaymentSuccess,
  handlePaymentFailed,
  handleLinkExpired,
  issueRefund,
  registerPayoutAccount,
  createPayout,
};
