// src/queue/postPaymentJobs.js
// Phase 3: durable post-payment fan-out.
//
// Replaces the fire-and-forget Promise.allSettled([...]) block in the
// Razorpay payment-success path. Each downstream effect (customer
// notification, 3PL dispatch, POS push) becomes its own persisted job
// with its own retry budget. If the process restarts mid-fan-out, work
// resumes instead of being silently dropped.
//
// Storage: we reuse the existing `message_jobs` collection (same Mongo
// queue pattern as messageQueue.js) but filter by `name`. That lets us
// run a dedicated worker loop for these job types without touching the
// WhatsApp-send worker.
//
// Job types:
//   ORDER_DISPATCH         — 3PL / delivery partner handoff
//   CUSTOMER_NOTIFICATION  — "order confirmed" template + location/ETA
//   POS_SYNC               — UrbanPiper / DotPe push
//
// Payload is a thin { orderId, restaurantId } — handlers rehydrate the
// order from Mongo so the job never carries stale pricing or address
// data.

'use strict';

const { col, newId } = require('../config/database');
const log = require('../utils/logger').child({ component: 'postPaymentJobs' });

// Phase 4: canonical job type registry. Any new async side-effect must
// pick one of these (or add a new entry + handler below). Central list
// means ops tooling has a stable set of names to filter on.
const JOB_TYPES = {
  ORDER_DISPATCH: 'ORDER_DISPATCH',
  CUSTOMER_NOTIFICATION: 'CUSTOMER_NOTIFICATION',
  POS_SYNC: 'POS_SYNC',
  SETTLEMENT_TRIGGER: 'SETTLEMENT_TRIGGER',
  LOYALTY_AWARD: 'LOYALTY_AWARD',
  CATALOG_SYNC: 'CATALOG_SYNC',
  // Welcome journey for first-time customers — fires 2h after the first
  // paid order (durable replacement for the prior setTimeout in
  // webhooks/razorpay.js, which dropped the welcome on EC2 restart).
  WELCOME_JOURNEY: 'WELCOME_JOURNEY',
  // Rating-request ask — chained from LOYALTY_AWARD with a 30-min delay
  // so the customer gets the loyalty notification immediately after
  // delivery and the rating prompt only after they've eaten. Owned by
  // services/order.js → LOYALTY_AWARD; no other site enqueues this.
  FEEDBACK_REQUEST: 'FEEDBACK_REQUEST',
};

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 10_000;   // 10s, 40s, 160s, 640s, 2560s
const POLL_INTERVAL_MS = 2_000;
const CLAIM_LEASE_MS = 120_000;

function backoffDelayMs(attempts) {
  return BASE_BACKOFF_MS * Math.pow(4, Math.max(0, attempts - 1));
}

// ─── ENQUEUE ──────────────────────────────────────────────────
// Phase 4: `type` is the canonical field; `name` mirrors it so the
// legacy message_jobs indexes and any code that filters by `name`
// continue to work unchanged. `delayMs` is optional — schedules the
// job for future execution (e.g., LOYALTY_AWARD 30 min after delivery).
//
// Optional `jobId` provides BullMQ-style dedup: when supplied it's
// used as the row's _id so a duplicate enqueue (network retry,
// duplicate webhook) collapses into the same row via duplicate-key
// catch. The Mongo unique-index on _id is the dedup boundary; a row
// in any state (pending/processing/completed/failed) blocks new
// inserts with the same _id.
//
// Optional `maxAttempts` overrides MAX_ATTEMPTS for one-off jobs that
// should retry less aggressively than the default 5.
async function enqueue(type, payload, { delayMs = 0, jobId = null, maxAttempts = MAX_ATTEMPTS } = {}) {
  if (!JOB_TYPES[type]) throw new Error(`postPaymentJobs: unknown type ${type}`);
  const now = new Date();
  const runAt = delayMs > 0 ? new Date(now.getTime() + delayMs) : now;
  const job = {
    _id: jobId || newId(),
    name: type,
    type,                            // Phase 4: canonical field
    payload: payload || {},
    status: 'pending',
    attempts: 0,
    max_attempts: maxAttempts,
    next_attempt_at: runAt,
    last_error: null,
    created_at: now,
    updated_at: now,
  };
  try {
    await col('message_jobs').insertOne(job);
  } catch (err) {
    // Duplicate-key on jobId → enqueue is a no-op; the existing row
    // already covers this orderId/event. Mongo error code 11000.
    if (jobId && (err?.code === 11000 || /duplicate key/i.test(err?.message || ''))) {
      log.info({ type, jobId, payload }, 'enqueue: duplicate jobId — already queued, skipping');
      return { id: jobId, deduped: true };
    }
    throw err;
  }
  log.info({ type, jobId: job._id, runAt, payload }, 'job enqueued');
  return { id: job._id };
}

// Convenience: enqueue the full post-payment fan-out for a single order.
//
// ORDER_DISPATCH is deliberately NOT enqueued here — it now fires from
// the restaurant /accept handler so dispatch only runs after the
// restaurant confirms (acceptance state machine). _handleOrderDispatch
// below carries a stale-job status guard so any in-flight ORDER_DISPATCH
// job created by older code (pre-deploy) is skipped silently if the
// order isn't in CONFIRMED.
async function enqueueForOrder({ orderId, restaurantId, posEnabled }) {
  const payload = { orderId: String(orderId), restaurantId: restaurantId ? String(restaurantId) : null };
  const jobs = [
    enqueue(JOB_TYPES.CUSTOMER_NOTIFICATION, payload),
  ];
  if (posEnabled) jobs.push(enqueue(JOB_TYPES.POS_SYNC, payload));
  return Promise.all(jobs);
}

// ─── CLAIM ────────────────────────────────────────────────────
async function _claim() {
  const now = new Date();
  const leaseDeadline = new Date(now.getTime() - CLAIM_LEASE_MS);
  const res = await col('message_jobs').findOneAndUpdate(
    {
      name: { $in: Object.values(JOB_TYPES) },
      $or: [
        { status: 'pending',    next_attempt_at: { $lte: now } },
        { status: 'processing', updated_at:      { $lte: leaseDeadline } },
      ],
    },
    { $set: { status: 'processing', updated_at: now }, $inc: { attempts: 1 } },
    { sort: { next_attempt_at: 1 }, returnDocument: 'after' }
  );
  // mongodb v4 wraps the doc as { value: doc }; v5+ returns the doc directly. Handle both shapes.
  return res?.value ?? res ?? null;
}

// ─── HANDLERS ─────────────────────────────────────────────────
async function _handleCustomerNotification(payload) {
  const orderSvc = require('../services/order');
  const orderNotify = require('../services/orderNotify');
  const wa = require('../services/whatsapp');
  const { resolveRecipient } = require('../services/customerIdentity');
  const order = await orderSvc.getOrderDetails(payload.orderId);
  if (!order) throw new Error('order not found');
  const templateSent = await orderNotify.sendOrderTemplateMessage(payload.orderId, 'PAID').catch(() => false);
  if (!templateSent) {
    await wa.sendStatusUpdate(
      order.phone_number_id, order.access_token, resolveRecipient(order),
      'CONFIRMED', { orderNumber: order.order_number }
    );
  }
  const ws = require('../services/websocket');
  try { ws.broadcastOrder(order.restaurant_id, 'payment_received', { orderId: payload.orderId, orderNumber: order.order_number, amountRs: order.total_rs }); } catch (_) {}

  // Persistent-notification handshake: stamp notified_at ONCE so the
  // dashboard can distinguish never-shown vs already-shown orders, then
  // broadcast new_order for the looping modal + sound. Both side-effects
  // are best-effort — the order itself was already persisted upstream.
  try {
    const notifyAt = new Date();
    const stampRes = await col('orders').updateOne(
      { _id: payload.orderId, notified_at: { $exists: false } },
      { $set: { notified_at: notifyAt } }
    );
    // Only broadcast on the first stamp — prevents duplicate modals if
    // the job retries after a successful template send.
    if (stampRes.modifiedCount > 0) {
      ws.broadcastOrder(order.restaurant_id, 'new_paid_order', {
        orderId: payload.orderId,
        orderNumber: order.order_number,
        customerName: order.customer_name || '',
        customerPhone: order.wa_phone || '',
        totalRs: order.total_rs,
        itemCount: order.item_count || (order.items?.length || 0),
        items: (order.items || []).slice(0, 6).map(i => ({ name: i.name, quantity: i.quantity })),
        orderType: order.order_type || 'delivery',
        notifiedAt: notifyAt.toISOString(),
      });
    }
  } catch (err) { log.warn({ err, orderId: payload.orderId }, 'new_order broadcast failed'); }

  try { require('../services/notify').notifyNewOrder(order); } catch (_) {}
}

async function _handleOrderDispatch(payload) {
  log.info({ orderId: payload?.orderId }, 'ORDER_DISPATCH: handler entered');

  const orderSvc = require('../services/order');
  const deliveryService = require('../services/delivery');
  const wa = require('../services/whatsapp');
  const { resolveRecipient } = require('../services/customerIdentity');
  const notify = require('../services/notify');

  const order = await orderSvc.getOrderDetails(payload.orderId);
  log.info(
    {
      orderId: payload.orderId,
      found: !!order,
      status: order?.status || null,
      orderNumber: order?.order_number || null,
      branchId: order?.branch_id || null,
    },
    'ORDER_DISPATCH: order fetched',
  );
  if (!order) throw new Error('order not found');

  // Stale-job guard. Dispatch fires from the restaurant /accept
  // handler — only when the order has actually transitioned to
  // CONFIRMED. PREPARING is also accepted because the owner-dashboard
  // accept flow auto-advances CONFIRMED → PREPARING immediately after
  // /accept resolves (see app/dashboard/orders/page.tsx and
  // components/restaurant/NewOrderPopup.tsx). That second PATCH can
  // win the race against this job being picked up by a worker, so the
  // job legitimately sees PREPARING on a brand-new accept. PACKED and
  // beyond remain blocked — by then the kitchen has already advanced
  // the order and a fresh dispatch would be a duplicate.
  // Any in-flight pre-deploy ORDER_DISPATCH job created from the old
  // PAID-time fan-out lands here in PAID and is skipped silently.
  log.info(
    { orderId: payload.orderId, status: order.status },
    'ORDER_DISPATCH: evaluating status guard',
  );
  if (order.status !== 'CONFIRMED' && order.status !== 'PREPARING') {
    log.info({ orderId: payload.orderId, status: order.status },
      'ORDER_DISPATCH: order not in CONFIRMED/PREPARING — skipping (stale or out-of-order job)');
    return;
  }
  log.info(
    { orderId: payload.orderId, status: order.status },
    'ORDER_DISPATCH: status guard passed — proceeding to dispatch',
  );

  try {
    log.info(
      {
        orderId: payload.orderId,
        orderNumber: order.order_number,
        branchId: order.branch_id,
        restaurantId: order.restaurant_id,
        hasDeliveryLat: order.delivery_lat != null,
        hasDeliveryLng: order.delivery_lng != null,
        proroutingQuoteId: order.prorouting_quote_id || null,
      },
      'ORDER_DISPATCH: calling delivery provider',
    );
    const task = await deliveryService.dispatchDelivery(payload.orderId);
    log.info(
      {
        orderId: payload.orderId,
        orderNumber: order.order_number,
        taskId: task?.taskId || null,
        hasTrackingUrl: !!task?.trackingUrl,
        estimatedMins: task?.estimatedMins ?? null,
      },
      'ORDER_DISPATCH: delivery provider returned successfully',
    );
    if (task?.trackingUrl && order.phone_number_id && resolveRecipient(order)) {
      await wa.sendText(
        order.phone_number_id, order.access_token, resolveRecipient(order),
        `🚴 Your delivery is being arranged!\n\n📍 Track your order live:\n${task.trackingUrl}\n\nEstimated delivery: ${task.estimatedMins || '25-35'} minutes`
      );
    }
  } catch (err) {
    // Terminal failure here means the restaurant has to dispatch manually.
    // Notify the manager but mark the job succeeded — retries won't help.
    // Detailed error log: surface message + stack always, plus
    // err.response.data when this is an axios error from the 3PL —
    // that's where the actual upstream rejection text lives (e.g.
    // "lat/lng invalid", "quote expired"). Without it, the catch
    // would log "[object Object]" and the real cause stays buried.
    log.error(
      {
        orderId: payload.orderId,
        orderNumber: order?.order_number,
        errMessage: err?.message || String(err),
        errStack: err?.stack,
        errCode: err?.code,
        // axios-specific fields when the error originated upstream
        upstreamStatus: err?.response?.status,
        upstreamBody: err?.response?.data,
        // request shape for axios errors — useful when the 3PL rejects
        // a malformed body and the message alone doesn't pinpoint why
        upstreamUrl: err?.config?.url,
        upstreamMethod: err?.config?.method,
      },
      'ORDER_DISPATCH: dispatch failed',
    );
    try {
      // Resolve the customer phone the same way services/proroutingState.js
      // _resolveMessagingContext does — receiver_phone first, fall back to
      // the customer doc's wa_phone/bsuid. Passed to sendManagerNotification
      // so an "Auto-dispatch failed" alert never lands in the customer's
      // WhatsApp thread when manager_phone or notification_phones happen to
      // coincide with the customer's number.
      let customerPhone = order.receiver_phone || null;
      if (!customerPhone && order.customer_id) {
        const customer = await col('customers').findOne({ _id: order.customer_id });
        customerPhone = customer?.wa_phone || customer?.bsuid || null;
      }
      await notify.sendManagerNotification(
        order.restaurant_id || order.branch_id, order.branch_id,
        `⚠️ Auto-dispatch failed for Order #${order.order_number}: ${err.message}\nPlease dispatch manually from the dashboard.`,
        { excludePhones: customerPhone }
      );
    } catch (_) {}
    // Swallow — we don't want to retry 3PL calls on non-retryable errors.
    // The manager message is enough; re-raise only if you want the job
    // system to back off and retry (e.g., add err.retryable checks here).
  }
}

async function _handlePosSync(payload) {
  if (process.env.POS_ENABLED !== 'true') {
    console.warn('POS integration disabled');
    return;
  }
  const orderSvc = require('../services/order');
  const order = await orderSvc.getOrderDetails(payload.orderId);
  if (!order) throw new Error('order not found');

  const integration = await col('restaurant_integrations').findOne({
    restaurant_id: order.restaurant_id,
    is_active: true,
    platform: { $in: ['urbanpiper', 'dotpe'] },
  });
  if (!integration) return;

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

// Phase 4: delivery/settlement/loyalty/catalog handlers.
async function _handleSettlementTrigger(payload) {
  const payoutEngine = require('../services/payoutEngine');
  const settlement = await payoutEngine.createSettlementForOrder(payload.orderId);
  // Auto-payout disabled until PG provider onboarded — the v2 per-order
  // payout path stays dormant; the eligible row sits in order_settlements
  // and the Phase 5 ledger-based cycle (admin-triggered) handles all
  // actual payouts. AUTO_PAYOUT_ON_DELIVERY must remain unset in prod.
  if (settlement && settlement.status === 'eligible' && process.env.AUTO_PAYOUT_ON_DELIVERY === 'true') {
    await payoutEngine.processSettlement(String(settlement._id));
  }
}

async function _handleLoyaltyAward(payload) {
  const loyalty = require('../services/loyaltyEngine');
  const wa = require('../services/whatsapp');
  const { resolveRecipient } = require('../services/customerIdentity');
  const orderSvc = require('../services/order');
  const metaConfig = require('../config/meta');

  const order = await orderSvc.getOrderDetails(payload.orderId);
  if (!order) throw new Error('order not found');

  const customer = await col('customers').findOne({ _id: order.customer_id });
  const waAcc    = await col('whatsapp_accounts').findOne({ restaurant_id: order.restaurant_id, is_active: true });
  const waToken  = metaConfig.systemUserToken || waAcc?.access_token;
  const toId     = customer ? (customer.wa_phone || customer.bsuid) : resolveRecipient(order);

  // First-order + birthday-week multipliers come from the RFM profile,
  // same source the razorpay webhook used to consult. order_count=1
  // means this is the only paid order we've seen for the customer; the
  // profile is updated by the same payment.completed bus event, so by
  // the time the LOYALTY_AWARD job fires (30 min post-DELIVERED) the
  // count is stable.
  let isFirstOrder = false;
  let isBirthdayWeek = false;
  try {
    const profile = await col('customer_rfm_profiles').findOne(
      { restaurant_id: order.restaurant_id, customer_id: order.customer_id },
      { projection: { order_count: 1, birthday: 1 } },
    );
    isFirstOrder = Number(profile?.order_count || 0) === 1;
    if (profile?.birthday && /^\d{2}\/\d{2}$/.test(profile.birthday)) {
      const [dd, mm] = profile.birthday.split('/').map((x) => Number(x));
      const now = new Date();
      const bday = new Date(now.getFullYear(), mm - 1, dd);
      const diffDays = Math.abs(now - bday) / (24 * 60 * 60 * 1000);
      isBirthdayWeek = diffDays <= 3;
    }
  } catch (err) { log.warn({ err, orderId: payload.orderId }, 'rfm profile lookup failed for loyalty multipliers'); }

  const reward = await loyalty.earnPoints(order.customer_id, order.restaurant_id, payload.orderId, order.total_rs, isFirstOrder, isBirthdayWeek);
  if (reward?.pointsEarned > 0 && toId && waAcc?.phone_number_id && waToken) {
    let msg = `🎉 You earned *${reward.pointsEarned} loyalty points*!\n💰 Balance: ${reward.newBalance} points\n🏅 Tier: ${reward.newTier.charAt(0).toUpperCase() + reward.newTier.slice(1)}\n\nRedeem points on your next order!`;
    if (reward.tierUpgraded) {
      msg = `🎊 *Congratulations!* You've been upgraded to *${reward.newTier.charAt(0).toUpperCase() + reward.newTier.slice(1)}*!\n\n` + msg;
    }
    // Loyalty messaging is promotional — route via the restaurant's
    // marketing number when set. Rating request below stays transactional.
    const restaurant = await col('restaurants').findOne({ _id: order.restaurant_id });
    const loyaltyPid = wa.getOutboundNumberId({
      ...restaurant,
      phoneNumberId: waAcc.phone_number_id,
    });
    await wa.sendText(loyaltyPid, waToken, toId, msg);
  }

  // Rating ask — chained as a FEEDBACK_REQUEST job 30 min from now so
  // the customer has time to actually eat the food before being asked
  // to rate. The handler re-fetches the order to confirm DELIVERED +
  // rating_requested_at is null at fire time (defends against a state
  // change between LOYALTY_AWARD success and the FEEDBACK_REQUEST run).
  // Deterministic jobId dedupes against duplicate LOYALTY_AWARD fires
  // and the routes/cron.js rating-requests catcher.
  try {
    await enqueue(
      JOB_TYPES.FEEDBACK_REQUEST,
      { orderId: String(payload.orderId), waId: toId || null, restaurantId: order.restaurant_id ? String(order.restaurant_id) : null },
      { delayMs: 30 * 60 * 1000, jobId: `feedback-${payload.orderId}`, maxAttempts: 2 },
    );
    log.info({ orderId: payload.orderId }, `[LoyaltyAward] Feedback job queued for orderId ${payload.orderId} in 30 min`);
  } catch (e) { log.warn({ err: e, orderId: payload.orderId }, 'feedback enqueue failed'); }
}

// Feedback / rating request — fires 30 min after LOYALTY_AWARD
// completes (chained from _handleLoyaltyAward above). The handler
// re-fetches the order at fire time so any state change in the
// 30-minute window (e.g. order somehow rolls back from DELIVERED, or
// the routes/cron.js rating-requests catcher already sent the ask)
// short-circuits before we double-send.
//
// Idempotency layers:
//   1. jobId = `feedback-${orderId}` on enqueue — duplicate-key on
//      message_jobs._id collapses re-enqueues into one row.
//   2. order.rating_requested_at !== null short-circuit here — covers
//      the race where the cron catcher fired first.
//   3. order_ratings.findOne inside sendRatingRequest is the final
//      backstop — already-rated orders never re-prompt.
async function _handleFeedbackRequest(payload) {
  const orderId = payload?.orderId;
  if (!orderId) {
    log.warn({ payload }, 'FEEDBACK_REQUEST: missing orderId — skipping');
    return;
  }

  const order = await col('orders').findOne(
    { _id: orderId },
    { projection: {
        _id: 1, order_number: 1, status: 1, restaurant_id: 1, customer_id: 1,
        receiver_phone: 1, rating_requested_at: 1,
    } },
  );
  if (!order) {
    log.warn({ orderId }, 'FEEDBACK_REQUEST: order not found — skipping');
    return;
  }
  if (order.status !== 'DELIVERED') {
    log.info({ orderId, status: order.status }, 'FEEDBACK_REQUEST: order not in DELIVERED — skipping');
    return;
  }
  if (order.rating_requested_at) {
    log.info({ orderId, ratedAt: order.rating_requested_at }, 'FEEDBACK_REQUEST: rating already requested — skipping');
    return;
  }

  const metaConfig = require('../config/meta');
  const waAcc = await col('whatsapp_accounts').findOne({
    restaurant_id: order.restaurant_id, is_active: true,
  });
  const waToken = metaConfig.systemUserToken || waAcc?.access_token;
  if (!waAcc?.phone_number_id || !waToken) {
    log.warn({ orderId, restaurantId: order.restaurant_id }, 'FEEDBACK_REQUEST: no active WA account or token — skipping');
    return;
  }

  // Recipient — prefer payload.waId (snapshotted by LOYALTY_AWARD when
  // the customer was last seen), fall back to order.receiver_phone, then
  // to a fresh customer-doc lookup.
  let toId = payload.waId || order.receiver_phone || null;
  if (!toId && order.customer_id) {
    const customer = await col('customers').findOne({ _id: order.customer_id });
    toId = customer?.wa_phone || customer?.bsuid || null;
  }
  if (!toId) {
    log.warn({ orderId }, 'FEEDBACK_REQUEST: no recipient phone — skipping');
    return;
  }

  // Lazy-require to avoid circular import: webhooks/whatsapp.js → various
  // services → this queue file. sendRatingRequest itself tries the
  // WhatsApp Flow first (platform_settings.feedback_flow.flow_id or
  // process.env.RATING_FLOW_ID) and falls back to a 3-button rating list.
  const { sendRatingRequest } = require('../webhooks/whatsapp');
  await sendRatingRequest(orderId, waAcc.phone_number_id, waToken, toId);

  // Stamp rating_requested_at so the cron catcher + any duplicate
  // FEEDBACK_REQUEST job both skip on the next read. Conditional update
  // means a parallel send can't double-write.
  await col('orders').updateOne(
    { _id: orderId, rating_requested_at: null },
    { $set: { rating_requested_at: new Date() } },
  );
  log.info({ orderId, orderNumber: order.order_number }, 'FEEDBACK_REQUEST sent');
}

// Welcome journey — durable replacement for the 2h setTimeout in the
// Razorpay payment-success path. Idempotency: journeyExecutor.executeJourney
// checks for an existing journey row before sending; a duplicate fire after
// a worker retry is safely no-op.
async function _handleWelcomeJourney({ restaurantId, customerId }) {
  if (!restaurantId || !customerId) return;
  const journeyExecutor = require('../services/journeyExecutor');
  await journeyExecutor.executeJourney(restaurantId, customerId, 'welcome');
}

async function _handleCatalogSync(payload) {
  const catalog = require('../services/catalog');
  const { restaurantId, type, branchIds } = payload;
  if (type === 'branch' && Array.isArray(branchIds) && branchIds.length) {
    for (const branchId of branchIds) {
      try { await catalog.syncBranchCatalog(branchId); }
      catch (err) { log.warn({ err, branchId }, 'branch sync failed — continuing'); }
    }
    return;
  }
  // Default: full / compressed sync.
  const { guard } = require('../utils/smartModule');
  const compResult = await guard('CATALOG_COMPRESSION', {
    fn: () => catalog.syncCompressedCatalog(restaurantId),
    fallback: null,
    label: 'syncCompressedCatalog',
    context: { restaurantId },
  });
  if (compResult) return;
  // Fallback: branch-by-branch.
  const branches = await col('branches').find({ restaurant_id: restaurantId }).toArray();
  for (const b of branches) {
    try { await catalog.syncBranchCatalog(String(b._id)); }
    catch (err) { log.warn({ err, branchId: String(b._id) }, 'fallback branch sync failed'); }
  }
}

const HANDLERS = {
  [JOB_TYPES.CUSTOMER_NOTIFICATION]: _handleCustomerNotification,
  [JOB_TYPES.ORDER_DISPATCH]: _handleOrderDispatch,
  [JOB_TYPES.POS_SYNC]: _handlePosSync,
  [JOB_TYPES.SETTLEMENT_TRIGGER]: _handleSettlementTrigger,
  [JOB_TYPES.LOYALTY_AWARD]: _handleLoyaltyAward,
  [JOB_TYPES.CATALOG_SYNC]: _handleCatalogSync,
  [JOB_TYPES.WELCOME_JOURNEY]: _handleWelcomeJourney,
  [JOB_TYPES.FEEDBACK_REQUEST]: _handleFeedbackRequest,
};

// ─── WORKER LOOP ──────────────────────────────────────────────
let _running = false;
let _stopRequested = false;

async function _processOne(job) {
  log.info({ jobId: job._id, jobName: job.name }, '_processOne: invoked with job');
  const handler = HANDLERS[job.name];
  log.info({ jobName: job.name, handlerFound: !!handler }, '_processOne: handler lookup');
  if (!handler) {
    await col('message_jobs').updateOne({ _id: job._id }, { $set: { status: 'failed', failed_at: new Date(), last_error: { message: `no handler for ${job.name}` } } });
    return;
  }
  try {
    log.info({ jobId: job._id, jobName: job.name }, '_processOne: invoking handler');
    await handler(job.payload || {});
    log.info({ jobId: job._id, jobName: job.name }, '_processOne: handler returned');
    await col('message_jobs').updateOne(
      { _id: job._id },
      { $set: { status: 'done', finished_at: new Date(), updated_at: new Date(), last_error: null } }
    );
    log.info({ jobId: job._id, type: job.name, attempts: job.attempts }, 'job done');
  } catch (err) {
    const errInfo = { message: err?.message || String(err), at: new Date() };
    const exhausted = job.attempts >= MAX_ATTEMPTS;
    if (exhausted) {
      await col('message_jobs').updateOne(
        { _id: job._id },
        { $set: { status: 'failed', failed_at: new Date(), updated_at: new Date(), last_error: errInfo } }
      );
      try {
        await col('failed_jobs').insertOne({
          _id: newId(),
          original_job_id: job._id,
          name: job.name,
          payload: job.payload,
          attempts: job.attempts,
          last_error: errInfo,
          failed_at: new Date(),
        });
      } catch (_) {}
      log.error({ jobId: job._id, type: job.name, err }, 'job failed permanently');
    } else {
      const nextAt = new Date(Date.now() + backoffDelayMs(job.attempts));
      await col('message_jobs').updateOne(
        { _id: job._id },
        { $set: { status: 'pending', next_attempt_at: nextAt, updated_at: new Date(), last_error: errInfo } }
      );
      log.warn({ jobId: job._id, type: job.name, attempts: job.attempts, retryAt: nextAt }, 'job failed — scheduled retry');
    }
  }
}

function start({ pollMs = POLL_INTERVAL_MS } = {}) {
  if (_running) return;
  _running = true;
  _stopRequested = false;
  (async function loop() {
    log.info({ pollMs }, 'post-payment worker started');
    while (!_stopRequested) {
      try {
        const job = await _claim();
        log.info({ claimedJobId: job ? job._id : null }, 'worker loop: claim result');
        if (job) { await _processOne(job); continue; }
      } catch (err) {
        log.error({ err }, 'worker loop error');
      }
      await new Promise(r => setTimeout(r, pollMs));
    }
    _running = false;
    log.info('post-payment worker stopped');
  })();
}

function stop() { _stopRequested = true; }

module.exports = {
  JOB_TYPES,
  enqueue,
  enqueueForOrder,
  start,
  stop,
  _internals: { backoffDelayMs },
};
