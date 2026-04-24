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

// ─── SHARED: PAYMENT EVENT VALIDATION ─────────────────────────
// Defense-in-depth: before we flip an order to PAID, confirm the
// Razorpay event we received actually corresponds to this order.
// paymentSvc.handleOrderPaid already resolves event → orderId via our
// `payments` mapping, but the mapping table itself can drift (manual
// edits, restored backups, shared test/live Razorpay accounts hitting
// the same webhook). Three checks:
//
//   1. The event's rp_order_id matches the `payments` row keyed by our
//      order_id. Guards against events routed to the wrong order.
//   2. The event's amount matches orders.total_rs (paise → rupees,
//      ₹1 rounding tolerance matches revalidateOrderForPayment).
//   3. The payment entity's status === 'captured'. Guards against
//      authorized-but-not-captured and failure-replayed-as-success.
//
// Returns { valid: true } OR { valid: false, reason }. The caller is
// responsible for logging + early-exiting when invalid.
const validatePaymentEvent = async (orderId, event) => {
  if (!event) return { valid: true, skipped: 'no_event' };  // backwards-compat — callers may pass undefined

  const paymentEntity = event.payload?.payment?.entity || null;
  const orderEntity   = event.payload?.order?.entity || null;

  // 1. Event → order mapping check.
  const eventRpOrderId = orderEntity?.id || paymentEntity?.order_id || null;
  if (eventRpOrderId) {
    const paymentRow = await col('payments').findOne(
      { order_id: String(orderId), rp_order_id: String(eventRpOrderId) },
      { projection: { _id: 1 } }
    );
    if (!paymentRow) {
      return { valid: false, reason: `rp_order_id mismatch: event=${eventRpOrderId} does not map to order=${orderId}` };
    }
  }

  // 2. Amount check (in paise on the event; rupees on our row).
  const order = await col('orders').findOne({ _id: String(orderId) }, { projection: { total_rs: 1 } });
  if (!order) return { valid: false, reason: 'order_not_found_during_validation' };
  const eventAmountPaise = paymentEntity?.amount ?? orderEntity?.amount ?? null;
  if (eventAmountPaise != null) {
    const eventAmountRs = Number(eventAmountPaise) / 100;
    const expectedRs = Number(order.total_rs) || 0;
    if (Math.abs(eventAmountRs - expectedRs) > 1) {
      return { valid: false, reason: `amount mismatch: event=₹${eventAmountRs} vs order=₹${expectedRs}` };
    }
  }

  // 3. Status check. payment.captured / order.paid carry a payment
  // entity with status 'captured'. Anything else is rejected.
  if (!paymentEntity) {
    return { valid: false, reason: 'event_missing_payment_entity' };
  }
  if (paymentEntity.status !== 'captured') {
    return { valid: false, reason: `payment.status=${paymentEntity.status} (not captured)` };
  }

  return { valid: true };
};

// ─── SHARED: CONFIRM PAID ORDER ───────────────────────────────
// Guard against double-fire: Razorpay sends both order.paid and payment.captured
// Now includes revalidation for delayed payments.
// When called from the event router, pass the original event so the
// validator can reject mis-routed / uncaptured / amount-mismatch events
// BEFORE the order is flipped to PAID.
const confirmPaidOrder = async (orderId, event) => {
  // Phase 3: duplicate-payment guard. `payment_status === 'paid'` is the
  // authoritative "already processed" signal — written atomically below
  // after validation. Any replay (Razorpay retries, webhook resends,
  // manual re-trigger) short-circuits here BEFORE any side effects run.
  const current = await col('orders').findOne({ _id: orderId }, { projection: { status: 1, payment_status: 1 } });
  if (current?.payment_status === 'paid') {
    log.info({ orderId }, 'Order already confirmed — skipping duplicate event');
    return;
  }

  // Phase 2 fix: validate the Razorpay event itself before trusting it.
  // If the event mapping, amount, or capture status doesn't line up,
  // reject and do NOT flip the order to PAID. The event is logged and
  // an activity row is written for ops follow-up (manual refund).
  const eventValidation = await validatePaymentEvent(orderId, event);
  if (!eventValidation.valid) {
    log.warn({ orderId, reason: eventValidation.reason }, 'Payment event validation failed — order NOT marked paid');
    logActivity({
      actorType: 'system', actorId: null, actorName: 'Razorpay',
      action: 'payment.event_validation_failed', category: 'payment',
      description: `Payment event rejected for order ${orderId}: ${eventValidation.reason}`,
      resourceType: 'order', resourceId: orderId, severity: 'warning',
      metadata: { reason: eventValidation.reason, event_type: event?.event || null },
    });
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

  // Phase 3.1: atomic "flip + credit". The orders row is the lock — we
  // only credit the ledger when THIS process is the one that flips
  // payment_status from not-paid to 'paid'. Any concurrent webhook
  // delivery that races us gets matchedCount=0 and bails out. Mongo
  // multi-document transactions aren't used here (single-node fallback
  // friendly); the conditional update is the serialization point.
  const paymentEntity = event?.payload?.payment?.entity || null;
  let _flippedByUs = false;
  try {
    const flip = await col('orders').updateOne(
      { _id: orderId, payment_status: { $ne: 'paid' } },
      { $set: { payment_status: 'paid', updated_at: new Date() } }
    );
    _flippedByUs = flip.matchedCount === 1;
  } catch (_) { /* best-effort — never fail confirmation on a denorm write */ }

  if (!_flippedByUs) {
    log.info({ orderId }, 'payment_status already paid — skipping ledger credit (race lost)');
    return;
  }

  // Fan out payment.completed — ONCE, only for the process that won the
  // flip. Idempotency guaranteed by the conditional updateOne above.
  try {
    const ord = await col('orders').findOne({ _id: String(orderId) }, { projection: { restaurant_id: 1, order_number: 1 } });
    const bus = require('../events');
    bus.emit('payment.completed', {
      orderId: String(orderId),
      restaurantId: ord?.restaurant_id || null,
      orderNumber: ord?.order_number || null,
      amountRs: paymentEntity ? (Number(paymentEntity.amount) || 0) / 100 : null,
      method: paymentEntity?.method || null,
      provider: 'razorpay',
      paymentRef: paymentEntity?.id || null,
    });
  } catch (_) { /* never block payment confirmation on bus failure */ }

  // Loyalty redemption commit (only) — fire-and-forget.
  // If the customer tapped YES on the pre-checkout redemption prompt,
  // the flow stamped loyalty_points_redeemed + loyalty_discount_rs on
  // the order before requesting payment. We debit their points here,
  // once the payment has confirmed.
  //
  // Earn is NOT done here. Points are awarded by the LOYALTY_AWARD
  // durable job that services/order.js enqueues 30 min after the order
  // transitions to DELIVERED — crediting on payment would double-pay
  // because that job still runs.
  try {
    const ordL = await col('orders').findOne(
      { _id: String(orderId) },
      { projection: {
          restaurant_id: 1, customer_id: 1,
          loyalty_points_redeemed: 1, loyalty_discount_rs: 1,
        } },
    );
    if (ordL?.restaurant_id && ordL?.customer_id) {
      const pointsToDeduct = Number(ordL.loyalty_points_redeemed) || 0;
      const discountRs     = Number(ordL.loyalty_discount_rs) || 0;
      if (pointsToDeduct > 0) {
        const loyaltyEngine = require('../services/loyaltyEngine');
        loyaltyEngine.redeemPoints(
          String(ordL.customer_id),
          String(ordL.restaurant_id),
          String(orderId),
          pointsToDeduct,
          discountRs,
        ).catch(() => {});
      }
    }
  } catch (_) { /* never block payment confirmation on loyalty failure */ }

  // Manual-blast campaign conversion attribution — fire-and-forget.
  // Increments stats.converted + stats.revenue_attributed_rs on any
  // marketing_campaigns row sent to this customer's segment within
  // the last 48 hours. Never affects order flow.
  try {
    const ord2 = await col('orders').findOne(
      { _id: String(orderId) },
      { projection: { restaurant_id: 1, customer_id: 1, subtotal_rs: 1, total_rs: 1, amount_paise: 1 } },
    );
    if (ord2?.restaurant_id && ord2?.customer_id) {
      const amountRs = paymentEntity
        ? (Number(paymentEntity.amount) || 0) / 100
        : (Number(ord2.total_rs) || Number(ord2.subtotal_rs) || ((Number(ord2.amount_paise) || 0) / 100));
      const marketingCampaigns = require('../services/marketingCampaigns');
      marketingCampaigns.attributeOrderConversion({
        orderId: String(orderId),
        restaurantId: String(ord2.restaurant_id),
        customerId: String(ord2.customer_id),
        amountRs,
      }).catch(() => {}); // non-blocking
    }
  } catch (_) { /* never block payment confirmation on attribution failure */ }

  // Auto-journey event triggers — welcome (first order, delayed 2h) and
  // milestone (5th/10th/25th etc). Fire-and-forget; never blocks payment.
  // Reads order_count from customer_rfm_profiles — the profile is
  // rebuilt nightly, so the first-order check can lag by up to a day.
  // Acceptable trade-off at current scale; tighter accuracy would require
  // a real-time order_count $inc in the payment path.
  try {
    const ord3 = await col('orders').findOne(
      { _id: String(orderId) },
      { projection: { restaurant_id: 1, customer_id: 1 } },
    );
    if (ord3?.restaurant_id && ord3?.customer_id) {
      const restaurantIdStr = String(ord3.restaurant_id);
      const customerIdStr   = String(ord3.customer_id);
      const profile = await col('customer_rfm_profiles').findOne({
        restaurant_id: restaurantIdStr,
        customer_id: customerIdStr,
      });
      const orderCount = Number(profile?.order_count || 0);
      const journeyExecutor = require('../services/journeyExecutor');

      // Welcome — only on first order. Delayed by 2h so the message
      // doesn't collide with the order confirmation. Persisted via the
      // postPaymentJobs queue so an EC2 restart within the 2h window
      // does NOT drop the welcome (the previous setTimeout-based version
      // did — replaced per the P-W2 audit fix).
      if (orderCount === 1) {
        const { enqueue, JOB_TYPES: JOBS } = require('../queue/postPaymentJobs');
        enqueue(JOBS.WELCOME_JOURNEY, {
          restaurantId: restaurantIdStr,
          customerId: customerIdStr,
        }, { delayMs: 2 * 60 * 60 * 1000 }).catch(() => {});
      }

      // Milestone — fires immediately on the configured order count.
      // trigger_orders is per-restaurant; default [5, 10, 25].
      if (orderCount > 0) {
        const cfg = await col('auto_journey_config').findOne({ restaurant_id: restaurantIdStr });
        const milestones = Array.isArray(cfg?.milestone?.trigger_orders)
          ? cfg.milestone.trigger_orders
          : [5, 10, 25];
        if (milestones.includes(orderCount)) {
          journeyExecutor.executeJourney(
            restaurantIdStr,
            customerIdStr,
            'milestone',
            { order_count: String(orderCount) },
          ).catch(() => {});
        }
      }
    }
  } catch (_) { /* never block payment confirmation on journey failure */ }

  // Phase 3: capture Razorpay fee breakdown on the payments row and
  // credit the NET amount to the restaurant's ledger.
  // Phase 3.1: net = amount - fee - tax (per updated spec). If Razorpay
  // stops rolling tax into fee in future, this stays correct.
  try {
    if (paymentEntity) {
      const amountPaise = Number(paymentEntity.amount) || 0;
      const feePaise    = Number(paymentEntity.fee) || 0;
      const taxPaise    = Number(paymentEntity.tax) || 0;
      const netPaise    = Math.max(0, amountPaise - feePaise - taxPaise);
      await col('payments').updateOne(
        { order_id: String(orderId), rp_payment_id: String(paymentEntity.id) },
        { $set: {
            fee_paise: feePaise,
            tax_paise: taxPaise,
            net_paise: netPaise,
            method: paymentEntity.method || null,
            updated_at: new Date(),
          } }
      );

      // Credit ledger keyed by rp_payment_id (Phase 3.1 convention).
      try {
        const ledger = require('../services/ledger.service');
        const ord = await col('orders').findOne({ _id: String(orderId) }, { projection: { restaurant_id: 1 } });
        if (ord?.restaurant_id && netPaise > 0) {
          await ledger.credit({
            restaurantId: ord.restaurant_id,
            amountPaise: netPaise,
            refType: 'payment',
            refId: String(paymentEntity.id),  // rp_payment_id
            status: 'completed',
            notes: `Razorpay payment ${paymentEntity.id} (gross ${amountPaise}p − fee ${feePaise}p − tax ${taxPaise}p)`,
          });
        }
      } catch (ledgerErr) {
        log.warn({ err: ledgerErr, orderId }, 'ledger credit failed — payment still marked paid');
      }
    }
  } catch (feeErr) {
    log.warn({ err: feeErr, orderId }, 'fee capture failed — non-fatal');
  }

  // Phase 1 flow hook. Fire-and-forget; onPaymentConfirmed is a no-op
  // for conversations not currently in AWAIT_PAYMENT (legacy flow
  // customers won't be bothered). Gated by the same flag that gates
  // the flow handler inside the WhatsApp webhook.
  if (process.env.PHASE1_FLOW_ENABLED === 'true') {
    try {
      const phase1Flow = require('../whatsapp/flowHandler');
      phase1Flow.onPaymentConfirmed({ orderId }).catch((err) =>
        log.warn({ err, orderId }, 'phase1 onPaymentConfirmed failed')
      );
    } catch (err) {
      log.warn({ err, orderId }, 'phase1 onPaymentConfirmed dispatch failed');
    }
  }

  const order = await orderSvc.getOrderDetails(orderId);
  if (!order) return;

  // ─── PROROUTING /createasync (fire-and-forget) ──────────────
  // Dispatch the 3PL order. Pinned to the estimate quote_id so the
  // customer pays exactly what was shown at checkout. Any failure flags
  // `needs_manual_dispatch` for ops — MUST NOT throw, MUST NOT block the
  // rest of the post-payment flow.
  if (order.prorouting_quote_id) {
    setImmediate(async () => {
      try {
        const prorouting = require('../services/prorouting');
        const branch = await col('branches').findOne({ _id: order.branch_id });
        if (!branch) {
          log.warn({ orderId, branchId: order.branch_id }, 'prorouting createasync: branch not found');
          await col('orders').updateOne({ _id: orderId }, { $set: { needs_manual_dispatch: true, updated_at: new Date() } });
          return;
        }
        const pickupDetails = {
          latitude: branch.latitude,
          longitude: branch.longitude,
          address: branch.address || '',
          pincode: branch.pincode || '',
          name: branch.name || '',
          phone: branch.manager_phone || branch.phone || '',
        };
        const dropDetails = {
          latitude: order.delivery_lat,
          longitude: order.delivery_lng,
          address: order.delivery_address || '',
          pincode: order.structured_address?.pincode || '',
          name: order.receiver_name || order.customer_name || '',
          phone: order.receiver_phone || order.customer_phone || '',
          order_value: Number(order.total_rs) || 0,
        };
        const orderMeta = {
          orderAmount: Number(order.total_rs) || 0,
          orderItems: Array.isArray(order.items) ? order.items.map((it) => ({
            name: it.item_name || '',
            qty: Number(it.quantity) || 0,
            price: Number(it.unit_price_rs) || 0,
          })) : [],
        };
        const { prorouting_order_id } = await prorouting.createDeliveryOrder(
          String(order.id || order._id),
          order.prorouting_quote_id,
          pickupDetails,
          dropDetails,
          orderMeta
        );
        await col('orders').updateOne(
          { _id: orderId },
          { $set: {
              prorouting_order_id: prorouting_order_id || null,
              prorouting_status: 'UnFulfilled',
              updated_at: new Date(),
            } }
        );
        log.info({ orderId, prorouting_order_id }, 'prorouting createasync ok');
      } catch (proErr) {
        log.warn({ err: proErr?.message, status: proErr?.response?.status, orderId }, 'prorouting createasync failed — flagging manual dispatch');
        try {
          await col('orders').updateOne(
            { _id: orderId },
            { $set: { needs_manual_dispatch: true, updated_at: new Date() } }
          );
        } catch (_) { /* swallow */ }
      }
    });
  }

  // Phase 3: replace fire-and-forget Promise.allSettled with durable
  // queue jobs. Each side effect (customer notification, 3PL dispatch,
  // POS push) gets its own retry budget and survives process restarts.
  // Handlers live in src/queue/postPaymentJobs.js.
  try {
    const { POS_INTEGRATIONS_ENABLED } = require('../config/features');
    const postPayment = require('../queue/postPaymentJobs');
    await postPayment.enqueueForOrder({
      orderId,
      restaurantId: order.restaurant_id,
      posEnabled: !!POS_INTEGRATIONS_ENABLED,
    });
  } catch (enqueueErr) {
    log.error({ err: enqueueErr, orderId }, 'failed to enqueue post-payment jobs');
  }

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

// @deprecated Phase 3 — POS sync moved into queue/postPaymentJobs.js
// (POS_SYNC job). This function is no longer called from the webhook
// path; kept only as a reference for the migrated logic. Do NOT call
// from new code.
// FUTURE FEATURE: may be removed once postPaymentJobs POS_SYNC handler
// is in production and confirmed stable across all tenants.
// eslint-disable-next-line no-unused-vars
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
      await confirmPaidOrder(orderId, event);
      break;
    }

    case 'payment.failed': {
      const orderId = await paymentSvc.handlePaymentFailed(event);
      if (!orderId) break;
      // Trust: -5 for a failed payment. A single miss won't shift tiers;
      // the impact compounds when a card-tester retries in a loop, which
      // is exactly the signal we want the trust system to pick up on.
      try {
        const ord = await col('orders').findOne({ _id: orderId }, { projection: { customer_id: 1 } });
        if (ord?.customer_id) require('../services/trustScore').recordEvent(String(ord.customer_id), 'payment_failed').catch(() => {});
      } catch (_) {}

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

      // Phase 3.1: refund accounting is two-phase. issueRefund() writes
      // a 'pending' debit keyed by rp_refund_id at the moment we call
      // Razorpay. This webhook promotes that entry to 'completed'. If
      // we never saw the 'pending' row (e.g., Razorpay dashboard-issued
      // refund with no issueRefund call), we insert a fresh 'completed'
      // debit.
      try {
        const rpPaymentId = refund.payment_id;
        const rpRefundId  = String(refund.id);
        if (rpPaymentId) {
          const paymentRow = await col('payments').findOne(
            { rp_payment_id: String(rpPaymentId) },
            { projection: { order_id: 1 } }
          );
          if (paymentRow?.order_id) {
            const ord = await col('orders').findOne(
              { _id: String(paymentRow.order_id) },
              { projection: { restaurant_id: 1 } }
            );
            if (ord?.restaurant_id) {
              const ledger = require('../services/ledger.service');
              const promoted = await ledger.markCompleted({
                restaurantId: ord.restaurant_id,
                refType: 'refund',
                refId: rpRefundId,
              });
              if (!promoted) {
                await ledger.debit({
                  restaurantId: ord.restaurant_id,
                  amountPaise: Number(refund.amount) || 0,
                  refType: 'refund',
                  refId: rpRefundId,
                  status: 'completed',
                  notes: `Razorpay refund ${rpRefundId} for payment ${rpPaymentId} (webhook-only)`,
                });
              }
            }
          }
        }
      } catch (ledgerErr) {
        log.warn({ err: ledgerErr, refundId: refund.id }, 'refund ledger debit failed');
      }
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
