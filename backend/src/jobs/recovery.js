// src/jobs/recovery.js
// Periodic recovery jobs — reconcile stuck states from partial failures.
//
// Every job here is IDEMPOTENT and SAFE TO RUN REPEATEDLY. That's
// essential: the jobs race with live webhooks (a payment may be verified
// by the recovery job seconds before Razorpay's webhook arrives), so the
// state transitions go through the strict state engines which reject
// duplicate moves cleanly.
//
// Schedule (all IST):
//   */5 * * * *   stuck payments — reconcile PENDING_PAYMENT > 10 min
//   */10 * * * *  stuck settlements — retry PROCESSING > 30 min
//   */15 * * * *  cleanup expired orders — past their expires_at window
//
// ─── DESIGN NOTES ───────────────────────────────────────────────
//
// 1. Each job runs under withLock so two instances (autoscaled API boxes,
//    overlapping cron fires) can't both reconcile the same row. The lock
//    TTL is generous — we'd rather skip a tick than double-process.
//
// 2. Razorpay verification failures are logged and the row is LEFT in its
//    current state. A transient Razorpay 5xx shouldn't cascade into
//    false FAILED markings — the next tick will try again.
//
// 3. Stuck-settlement retry is gated by a max_retries counter to avoid an
//    infinite loop when Razorpay permanently rejects (KYC issue, closed
//    account). After max_retries the row is marked FAILED terminally and
//    surfaced to ops via activity log.

'use strict';

const cron = require('node-cron');
const { col } = require('../config/database');
const { transitionOrder } = require('../core/orderStateEngine');
const { transitionSettlement } = require('../core/settlementStateEngine');
const { withLock } = require('../utils/withLock');
const log = require('../utils/logger').child({ component: 'recovery' });

const STUCK_PAYMENT_MINUTES = 10;
const STUCK_SETTLEMENT_MINUTES = 30;
const MAX_SETTLEMENT_RETRIES = 5;
const BATCH_SIZE = 50;

// ─── JOB 1: Stuck payments ───────────────────────────────────────
// Orders sitting in PENDING_PAYMENT past STUCK_PAYMENT_MINUTES. Causes:
//   - user never completed payment (most common → EXPIRED)
//   - Razorpay webhook was lost (rare → we verify and promote to PAID)
//   - Customer paid but our server crashed between callback and DB write
//     (the case this job exists for)
//
// We ALWAYS ask Razorpay for ground truth rather than assuming the order
// has expired. Missed-payment recoveries are rare but when they happen
// they're worth hundreds of ₹ per order.
async function recoverStuckPayments() {
  const cutoff = new Date(Date.now() - STUCK_PAYMENT_MINUTES * 60 * 1000);
  const stuck = await col('orders').find({
    status: 'PENDING_PAYMENT',
    created_at: { $lt: cutoff },
  }).limit(BATCH_SIZE).toArray();

  if (!stuck.length) return { scanned: 0, recovered: 0, expired: 0 };

  log.info({ count: stuck.length }, 'reconciling stuck payments');
  let recovered = 0, expired = 0, errors = 0;

  for (const order of stuck) {
    try {
      const payment = await col('payments').findOne({ order_id: String(order._id) });
      if (!payment || !payment.rp_order_id) {
        // No Razorpay row to check — expire it (order abandoned before
        // payment was initiated).
        await transitionOrder(String(order._id), 'EXPIRED', { actor: 'recovery', actorType: 'system', cancelReason: 'Abandoned before payment initiation' }).catch(() => {});
        expired++;
        continue;
      }
      const rzp = require('../services/payment')._getRzp ? require('../services/payment')._getRzp() : null;
      if (!rzp) { log.warn({ orderId: order._id }, 'Razorpay not configured — skipping'); continue; }

      // Fetch the Razorpay order and inspect its latest payment(s).
      // If any payment is `captured` we promote; otherwise EXPIRED.
      let payments;
      try {
        payments = await rzp.orders.fetchPayments(payment.rp_order_id);
      } catch (rzpErr) {
        log.warn({ orderId: order._id, err: rzpErr.message }, 'Razorpay fetchPayments failed — will retry next tick');
        errors++;
        continue;
      }
      const captured = (payments?.items || []).find(p => p.status === 'captured');
      if (captured) {
        await col('payments').updateOne(
          { _id: payment._id },
          { $set: { status: 'paid', paid_at: new Date(captured.created_at * 1000), rp_payment_id: captured.id, recovered_by: 'cron' } }
        );
        await transitionOrder(String(order._id), 'PAID', { actor: 'recovery', actorType: 'system', metadata: { recovered: true, rp_payment_id: captured.id } });
        log.warn({ orderId: order._id, rpPaymentId: captured.id }, 'recovered stuck PAID order from Razorpay');
        recovered++;
      } else {
        await transitionOrder(String(order._id), 'EXPIRED', { actor: 'recovery', actorType: 'system', cancelReason: 'Payment window exceeded, no captured payment on Razorpay' }).catch(() => {});
        expired++;
      }
    } catch (err) {
      errors++;
      log.error({ orderId: order._id, err: err.message }, 'recoverStuckPayments: row failed');
    }
  }

  log.info({ scanned: stuck.length, recovered, expired, errors }, 'stuck-payment recovery done');
  return { scanned: stuck.length, recovered, expired, errors };
}

// ─── JOB 2: Stuck settlements ───────────────────────────────────
// Settlement rows stuck in 'processing' past STUCK_SETTLEMENT_MINUTES.
// Delegates to Phase 5's timeoutStaleSettlements() — the canonical
// stuck-settlement sweeper. Earlier versions of this job queried the
// orphaned `state` field on the settlements collection (no production
// path ever wrote it) and called transitionSettlement (the orphaned
// state engine), so it found and acted on zero rows. The Phase 5
// sweeper queries `status: 'processing'` on settlement_type:'new' rows,
// which is what the live system actually writes.
async function recoverStuckSettlements() {
  const settlementSvc = require('../services/settlement.service');
  try {
    const out = await settlementSvc.timeoutStaleSettlements({
      thresholdMs: STUCK_SETTLEMENT_MINUTES * 60 * 1000,
    });
    if (out.found > 0) {
      log.warn({ found: out.found, timedOut: out.timedOut }, 'stuck-settlement recovery done');
    }
    return { scanned: out.found, timedOut: out.timedOut };
  } catch (err) {
    log.error({ err: err.message }, 'recoverStuckSettlements: timeoutStaleSettlements failed');
    return { scanned: 0, timedOut: 0, error: err.message };
  }
}

// ─── JOB 3: Cleanup expired orders ───────────────────────────────
// Orders with explicit `expires_at` in the past still in PENDING_PAYMENT
// or PAYMENT_FAILED — mark EXPIRED so they stop showing up in active
// carts and stop blocking new orders from the same customer.
async function cleanupExpiredOrders() {
  const now = new Date();
  const expired = await col('orders').find({
    status: { $in: ['PENDING_PAYMENT', 'PAYMENT_FAILED'] },
    expires_at: { $lt: now },
  }).limit(BATCH_SIZE).toArray();

  if (!expired.length) return { scanned: 0, expired: 0 };
  let done = 0;
  for (const o of expired) {
    try {
      await transitionOrder(String(o._id), 'EXPIRED', {
        actor: 'recovery',
        actorType: 'system',
        cancelReason: 'Payment window elapsed',
      });
      done++;
    } catch (err) {
      log.warn({ orderId: o._id, err: err.message }, 'cleanupExpiredOrders: transition failed (likely raced)');
    }
  }
  log.info({ scanned: expired.length, expired: done }, 'expired-order cleanup done');
  return { scanned: expired.length, expired: done };
}

// ─── SCHEDULER ──────────────────────────────────────────────────
function scheduleRecovery() {
  cron.schedule('*/5 * * * *',  () => withLock('recover:payments',    recoverStuckPayments).catch(err => log.error({ err: err.message }, 'recoverStuckPayments failed')),    { timezone: 'Asia/Kolkata' });
  cron.schedule('*/10 * * * *', () => withLock('recover:settlements', recoverStuckSettlements).catch(err => log.error({ err: err.message }, 'recoverStuckSettlements failed')), { timezone: 'Asia/Kolkata' });
  cron.schedule('*/15 * * * *', () => withLock('recover:expired',     cleanupExpiredOrders).catch(err => log.error({ err: err.message }, 'cleanupExpiredOrders failed')),     { timezone: 'Asia/Kolkata' });
  log.info('recovery crons scheduled (payments 5m / settlements 10m / expired 15m)');
}

module.exports = {
  scheduleRecovery,
  recoverStuckPayments,
  recoverStuckSettlements,
  cleanupExpiredOrders,
  // exported for tests
  _internals: { STUCK_PAYMENT_MINUTES, STUCK_SETTLEMENT_MINUTES, MAX_SETTLEMENT_RETRIES },
};
