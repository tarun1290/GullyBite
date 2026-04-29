// src/services/payment.js
// Razorpay payment integration — single payment flow:
//
//   WhatsApp Pay (sole flow)
//   createRazorpayOrder() → send order_details WhatsApp interactive
//   message → customer reviews and pays inside WhatsApp (UPI) →
//   Razorpay fires order.paid / payment.captured webhook.
//
// Payment links (Razorpay paymentLink.create) are not used. The link-based
// fallback was retired in c887ca4 (2026-04-05) when every order flow was
// migrated to interactive checkout; the dead handlers/validator branches
// were removed in a follow-up cleanup.
//
// Settlements → GullyBite collects all money → weekly payout to restaurants
//   registerPayoutAccount() registers restaurant's bank account with Razorpay X
//   createPayout() transfers the net settlement amount to their account

const Razorpay = require('razorpay');
const crypto  = require('crypto');
const { col, newId } = require('../config/database');
const log = require('../utils/logger').child({ component: 'Payment' });

// ─── PAYMENT AUDIT HELPER ────────────────────────────────────
// Every payment status change appends to an embedded status_history array.
// This preserves the full trail without a separate collection.
// Two-step: read previous state, then update with history entry.
const updatePaymentWithAudit = async (filter, $set, actor = 'system') => {
  const prev = await col('payments').findOne(filter, { projection: { status: 1, order_id: 1 } });
  if (!prev) return null;

  const historyEntry = {
    from_status: prev.status,
    to_status: $set.status,
    actor,
    changed_at: new Date(),
    fields_changed: Object.keys($set).filter(k => k !== 'status'),
  };

  const updated = await col('payments').findOneAndUpdate(
    filter,
    { $set, $push: { status_history: historyEntry } },
    { returnDocument: 'after' }
  );

  log.info({ orderId: prev.order_id, from: prev.status, to: $set.status, actor }, 'Payment status changed');
  return updated;
};

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
const createRazorpayOrder = async (order, customer) => {
  const expiryMins = parseInt(process.env.PAYMENT_LINK_EXPIRY_MINS) || 15;

  const expireByUnix = Math.floor(Date.now() / 1000) + expiryMins * 60;
  const rzpOrder = await getRzp().orders.create({
    amount  : Math.round(order.total_rs * 100),
    currency: 'INR',
    receipt : order.order_number,
    expire_by: expireByUnix,
    notes: {
      order_id    : order.id,
      order_number: order.order_number,
      customer_wa : customer.wa_phone || customer.bsuid || '',
    },
  });

  const expiresAt = new Date(Date.now() + expiryMins * 60 * 1000);
  await col('payments').insertOne({
    _id: newId(),
    order_id: order.id,
    rp_order_id: rzpOrder.id,
    rp_link_id: null,
    rp_link_url: null,
    rp_payment_id: null,
    payment_method: null,
    amount_rs: order.total_rs,
    status: 'sent',
    payment_type: 'whatsapp_pay',
    expires_at: expiresAt,
    paid_at: null,
    created_at: new Date(),
  });

  return rzpOrder;
};

// ─── 1b. CREATE RAZORPAY ORDER — RAW (Self-Service) ───────────
// Pure Razorpay /orders POST with NO side effects (no payments insert,
// no DB writes). Used by the WhatsApp self-service order_details flow
// (_sendOrderCheckout in webhooks/whatsapp.js), which needs the
// rp_order_id BEFORE sending the interactive message so it can be
// embedded in payment_settings.payment_gateway.order_id — that's what
// makes the inbound webhook resolvable to a payments row by rp_order_id.
//
// We deliberately don't reuse createRazorpayOrder above because that
// helper writes the payments row internally; the self-service caller
// inserts its own payments doc (with reference_id + checkout_order
// payment_type) right after sendPaymentRequest succeeds. Sharing the
// function would double-insert.
//
// Throws on Razorpay API errors so the caller can decide whether to
// degrade gracefully (continue without rp_order_id) or fail the flow.
const createRazorpayOrderRaw = async ({ amountRs, currency = 'INR', receipt, notes = {} } = {}) => {
  if (!amountRs || amountRs <= 0) throw new Error('createRazorpayOrderRaw: amountRs must be > 0');
  const rzpOrder = await getRzp().orders.create({
    amount: Math.round(Number(amountRs) * 100), // paise
    currency,
    // Razorpay caps receipt at 40 chars — clamp defensively in case
    // a caller hands us something longer.
    ...(receipt ? { receipt: String(receipt).slice(0, 40) } : {}),
    notes: notes || {},
  });
  return rzpOrder; // { id: 'order_…', amount, currency, status, ... }
};

// ─── VERIFY WEBHOOK SIGNATURE ─────────────────────────────────
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
const handleOrderPaid = async (event) => {
  const rzpOrderId    = event.payload?.order?.entity?.id
                     || event.payload?.payment?.entity?.order_id;
  const paymentEntity = event.payload?.payment?.entity;

  if (!rzpOrderId) {
    log.warn('handleOrderPaid: no order ID in event');
    return null;
  }

  let payment = await col('payments').findOne({ rp_order_id: rzpOrderId });

  // Fallback: checkout template payments — match by reference_id (Razorpay receipt)
  if (!payment) {
    const receipt = event.payload?.order?.entity?.receipt
                 || event.payload?.payment?.entity?.notes?.reference_id;
    if (receipt) {
      payment = await col('payments').findOne({ reference_id: receipt, payment_type: 'checkout_template' });
      if (payment) log.info({ referenceId: receipt }, 'Matched checkout template payment by reference_id');
    }
  }

  if (!payment) {
    log.error({ rzpOrderId }, 'No payment record for Razorpay order');
    return null;
  }

  await updatePaymentWithAudit(
    { _id: payment._id },
    { status: 'paid', rp_order_id: rzpOrderId, rp_payment_id: paymentEntity?.id, payment_method: paymentEntity?.method, paid_at: new Date() },
    'razorpay:order.paid'
  );

  return payment.order_id;
};

// ─── HANDLE PAYMENT FAILED ────────────────────────────────────
const handlePaymentFailed = async (event) => {
  const rzpOrderId = event.payload?.payment?.entity?.order_id;
  if (!rzpOrderId) return null;

  let payment = await updatePaymentWithAudit(
    { rp_order_id: rzpOrderId },
    { status: 'failed' },
    'razorpay:payment.failed'
  );
  if (payment) return payment.order_id;

  // Fallback: checkout template payments — match by reference_id
  const receipt = event.payload?.order?.entity?.receipt
               || event.payload?.payment?.entity?.notes?.reference_id;
  if (receipt) {
    payment = await updatePaymentWithAudit(
      { reference_id: receipt, payment_type: 'checkout_template' },
      { status: 'failed', rp_order_id: rzpOrderId },
      'razorpay:payment.failed'
    );
    if (payment) return payment.order_id;
  }
  return null;
};

// ─── ISSUE REFUND ─────────────────────────────────────────────
// Phase 3.1: two-phase ledger debit. We post a 'pending' debit
// immediately (keyed by rp_refund_id) so the liability shows up in
// reporting the moment we call Razorpay. The refund.processed webhook
// flips this entry to 'completed'. If the webhook never arrives (e.g.,
// Razorpay failure), the pending row stays visible to ops for manual
// reconciliation rather than silently disappearing.
const issueRefund = async (orderId, reason = 'Order cancelled') => {
  const payment = await col('payments').findOne({ order_id: orderId, status: 'paid' });
  if (!payment) return null;

  const amountPaise = Math.round(payment.amount_rs * 100);
  const refund = await getRzp().payments.refund(payment.rp_payment_id, {
    amount: amountPaise,
    notes : { reason, order_id: orderId },
  });

  await updatePaymentWithAudit(
    { _id: payment._id },
    { status: 'refunded', refunded_at: new Date() },
    `system:refund:${reason}`
  );

  // Best-effort pending debit. Never fails the refund call — Razorpay
  // already owes the customer; a missed ledger entry is an ops issue,
  // not a customer-facing one.
  try {
    const ord = await col('orders').findOne(
      { _id: String(orderId) },
      { projection: { restaurant_id: 1 } }
    );
    if (ord?.restaurant_id && refund?.id) {
      const ledger = require('./ledger.service');
      await ledger.debit({
        restaurantId: ord.restaurant_id,
        amountPaise,
        refType: 'refund',
        refId: String(refund.id),
        status: 'pending',
        notes: `Refund initiated: ${reason}`,
      });
    }
  } catch (err) {
    log.warn({ err, orderId, refundId: refund?.id }, 'pending refund ledger debit failed');
  }

  return refund;
};

// ─── REGISTER RESTAURANT PAYOUT ACCOUNT ───────────────────────
const registerPayoutAccount = async (restaurantId) => {
  const restaurant = await col('restaurants').findOne({ _id: restaurantId });
  if (!restaurant) throw new Error('Restaurant not found');

  if (!restaurant.bank_account_number || !restaurant.bank_ifsc) {
    throw new Error('Bank account number and IFSC are required');
  }
  if (restaurant.razorpay_fund_acct_id) {
    return { alreadyRegistered: true, fundAccountId: restaurant.razorpay_fund_acct_id };
  }

  const contact = await getRzp().contacts.create({
    name        : restaurant.business_name,
    email       : restaurant.email || undefined,
    contact     : restaurant.phone || undefined,
    type        : 'vendor',
    reference_id: restaurantId,
  });

  const fundAccount = await getRzp().fundAccount.create({
    contact_id  : contact.id,
    account_type: 'bank_account',
    bank_account: {
      name          : restaurant.business_name,
      ifsc          : restaurant.bank_ifsc,
      account_number: restaurant.bank_account_number,
    },
  });

  await col('restaurants').updateOne(
    { _id: restaurantId },
    { $set: { razorpay_fund_acct_id: fundAccount.id } }
  );

  log.info({ businessName: restaurant.business_name, fundAccountId: fundAccount.id }, 'Registered payout account');
  return { fundAccountId: fundAccount.id };
};

// ─── CREATE PAYOUT (used by weekly settlement job — legacy) ─
const createPayout = async (restaurant, amountRs, settlementId) => {
  const payout = await getRzp().payouts.create({
    account_number   : process.env.RAZORPAY_ACCOUNT_NUMBER,
    fund_account_id  : restaurant.razorpay_fund_acct_id,
    amount           : Math.round(amountRs * 100),
    currency         : 'INR',
    mode             : 'IMPS',
    purpose          : 'payout',
    queue_if_low_balance: true,
    reference_id     : settlementId,
    narration        : `GullyBite Settlement - ${restaurant.business_name}`,
  });
  return payout;
};

// ─── CREATE PAYOUT V2 — with idempotency key (per-order) ────
// Uses an idempotency key to prevent duplicate payouts on retry.
// Razorpay supports the X-Payout-Idempotency header on payout creation.
const createPayoutV2 = async ({ fundAccountId, amountRs, idempotencyKey, referenceId, narration, mode = 'IMPS' }) => {
  if (!fundAccountId) throw new Error('fundAccountId required');
  if (!amountRs || amountRs <= 0) throw new Error('amountRs must be positive');
  if (!idempotencyKey) throw new Error('idempotencyKey required');
  if (!process.env.RAZORPAY_ACCOUNT_NUMBER) throw new Error('RAZORPAY_ACCOUNT_NUMBER env var missing');

  const payout = await getRzp().payouts.create({
    account_number      : process.env.RAZORPAY_ACCOUNT_NUMBER,
    fund_account_id     : fundAccountId,
    amount              : Math.round(amountRs * 100),
    currency            : 'INR',
    mode,
    purpose             : 'payout',
    queue_if_low_balance: true,
    reference_id        : referenceId,
    narration           : narration?.substring(0, 30) || 'GullyBite Payout',
  }, { 'X-Payout-Idempotency': idempotencyKey });

  return payout;
};

module.exports = {
  createRazorpayOrder,
  createRazorpayOrderRaw,
  verifyWebhookSignature,
  handleOrderPaid,
  handlePaymentFailed,
  issueRefund,
  registerPayoutAccount,
  createPayout,
  createPayoutV2,
  updatePaymentWithAudit,
  // Exposed for recovery job — lets it reconcile stuck payments by
  // fetching ground truth from Razorpay. Kept underscore-prefixed to
  // signal it's not part of the public API surface.
  _getRzp: getRzp,
};
