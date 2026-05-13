// src/services/proroutingState.js
//
// Shared Prorouting state machine. Both the Prorouting webhook
// (routes/webhookProrouting.js) and the restaurant dashboard's
// /sync-status poll (routes/restaurant.js) feed raw Prorouting state
// strings through `applyProroutingState` so the customer messages,
// order.status transitions, and dispute auto-raise all behave
// identically regardless of origin.
//
// Returns { updated, previousStatus, currentStatus, orderStatusChanged }
// so the caller can shape its response.

'use strict';

const { col } = require('../config/database');
const wa = require('../services/whatsapp');
const orderSvc = require('../services/order');
const prorouting = require('../services/prorouting');
const metaConfig = require('../config/meta');
const { emitToRestaurant } = require('../utils/socketEmit');
const log = require('../utils/logger').child({ component: 'prorouting-state' });

// Socket fan-out for the dashboard DeliveryTimeline. Called after every
// $set that writes prorouting_state (or its companion *_at timestamp
// fields) so the timeline updates live without a page refresh. The
// socketEmit helper is itself fail-silent — this wrapper just adds the
// re-fetch step so the emit always carries the post-update doc state
// (the callers use updateOne, not findOneAndUpdate, so the in-scope
// `order` is stale by the time we'd emit). One catch on the re-fetch
// keeps a misbehaving socket layer from crashing the webhook handler.
async function _emitDeliveryUpdate(orderId) {
  try {
    const updatedOrder = await col('orders').findOne({ _id: orderId });
    if (!updatedOrder) return;
    emitToRestaurant(
      updatedOrder.restaurant_id,
      'delivery_update',
      {
        orderId: updatedOrder._id,
        orderNumber: updatedOrder.order_number,
        prorouting_state: updatedOrder.prorouting_state,
        prorouting_assigned_at:      updatedOrder.prorouting_assigned_at      ?? null,
        prorouting_pickedup_at:      updatedOrder.prorouting_pickedup_at      ?? null,
        prorouting_delivered_at:     updatedOrder.prorouting_delivered_at     ?? null,
        prorouting_at_pickup_at:     updatedOrder.prorouting_at_pickup_at     ?? null,
        prorouting_at_delivery_at:   updatedOrder.prorouting_at_delivery_at   ?? null,
        prorouting_cancelled_at:     updatedOrder.prorouting_cancelled_at     ?? null,
        prorouting_rto_initiated_at: updatedOrder.prorouting_rto_initiated_at ?? null,
        prorouting_rto_delivered_at: updatedOrder.prorouting_rto_delivered_at ?? null,
      }
    );
  } catch (err) {
    log.warn({ err: err?.message, orderId }, '_emitDeliveryUpdate failed');
  }
}

function _normaliseStatus(raw) {
  if (!raw) return null;
  return String(raw).toLowerCase().replace(/[\s_]+/g, '-').trim();
}

// Order statuses for which any inbound dispatch / pickup / delivered
// callback is "late" — the order has already moved past the lifecycle
// stage the event would advance. Used as an idempotent early-return
// gate in the dispatch-bound branches below so a duplicate webhook
// never tries (and fails) a transitionOrder() call from a terminal
// state. DELIVERED is the most common case (Meta's at-delivery and
// delivered events sometimes both fire); the rest cover edge cases
// where a refund / RTO / cancellation already finalised the order.
const POST_DISPATCH_TERMINAL = new Set([
  'DELIVERED',
  'CANCELLED',
  'RTO_IN_PROGRESS',
  'RTO_COMPLETE',
  'EXPIRED',
  'EXPIRED_PAYMENT',
  'REJECTED_BY_RESTAURANT',
  'RESTAURANT_TIMEOUT',
  'NO_DELIVERY_AVAILABLE',
]);

// Prorouting callback timestamps arrive as IST strings like
// "YYYY-MM-DD HH:MM:SS". Parse as UTC+5:30 so diffs are accurate
// regardless of where this process runs.
function parseISTTimestamp(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+05:30`);
  return isNaN(d.getTime()) ? null : d;
}

// Minutes between two IST timestamp strings, rounded to 1dp.
// Returns null if either is missing/unparseable — callers use this
// to decide whether to omit the field from the $set entirely.
function _minutesBetween(startStr, endStr) {
  const s = parseISTTimestamp(startStr);
  const e = parseISTTimestamp(endStr);
  if (!s || !e) return null;
  const mins = (e.getTime() - s.getTime()) / 60000;
  if (!isFinite(mins)) return null;
  return Math.round(mins * 10) / 10;
}

async function _resolveMessagingContext(order) {
  if (!order) return null;
  const waAccount = await col('whatsapp_accounts').findOne({
    restaurant_id: order.restaurant_id,
    is_active: true,
  });
  if (!waAccount) return null;

  let customerPhone = order.receiver_phone || null;
  if (!customerPhone && order.customer_id) {
    const customer = await col('customers').findOne({ _id: order.customer_id });
    customerPhone = customer?.wa_phone || customer?.bsuid || null;
  }
  if (!customerPhone) return null;

  return {
    pid: waAccount.phone_number_id,
    token: waAccount.access_token || metaConfig.systemUserToken,
    to: customerPhone,
  };
}

// Phone numbers to blast RTO alerts to — branch manager (so the
// kitchen knows a parcel is coming back) plus the GullyBite ops
// number from env. Deduped and trimmed.
async function _rtoAlertTargets(order) {
  const targets = new Set();
  try {
    const branch = await col('branches').findOne({ _id: order.branch_id });
    if (branch?.manager_phone) targets.add(String(branch.manager_phone).trim());
  } catch (_) { /* best-effort */ }
  if (process.env.ADMIN_NOTIFY_NUMBER) {
    targets.add(String(process.env.ADMIN_NOTIFY_NUMBER).trim());
  }
  return [...targets].filter(Boolean);
}

async function _sendRtoAlert(order, message) {
  const targets = await _rtoAlertTargets(order);
  if (!targets.length) return;
  const waAccount = await col('whatsapp_accounts').findOne({
    restaurant_id: order.restaurant_id,
    is_active: true,
  });
  if (!waAccount) {
    log.warn({ orderId: order._id }, 'rto alert: no active wa_account for restaurant');
    return;
  }
  const token = waAccount.access_token || metaConfig.systemUserToken;
  await Promise.all(targets.map((to) =>
    wa.sendText(waAccount.phone_number_id, token, to, message).catch((e) =>
      log.warn({ err: e?.message, to }, 'rto alert sendText failed')
    )
  ));
}

// Core entry point.
//
// order        — the full orders row.
// statusRaw    — the Prorouting state string ('Agent-assigned', 'RTO-Initiated', …).
// eventBody    — optional extras from the webhook body (rider_name, rider_phone).
//                Safe to pass {} when we only have the polled state.
//
// Returns { previousStatus, currentStatus, updated }.
async function applyProroutingState(order, statusRaw, eventBody = {}) {
  const status = _normaliseStatus(statusRaw);
  const previousStatus = order?.prorouting_state || null;
  if (!order || !status) {
    return { previousStatus, currentStatus: previousStatus, updated: false };
  }

  const isNewStatus = previousStatus !== statusRaw && _normaliseStatus(previousStatus) !== status;

  // Always mirror the latest raw state onto the order row — the state
  // column on the dashboard should reflect what Prorouting is saying
  // right now, even when the change is a no-op from our side.
  await col('orders').updateOne(
    { _id: order._id },
    { $set: { prorouting_state: statusRaw || status, updated_at: new Date() } }
  );
  await _emitDeliveryUpdate(order._id);

  if (!isNewStatus) {
    log.info({ orderId: order._id, status }, 'prorouting state: unchanged — no side effects');
    return { previousStatus, currentStatus: statusRaw || status, updated: false };
  }

  const ctx = await _resolveMessagingContext(order);

  // ─── HAPPY PATH ────────────────────────────────────────────
  if (status === 'agent-assigned') {
    // Dual-write: populate the logistics subdocument for analytics
    // alongside the existing flat prorouting_state mirror above.
    // Every field is omitted when absent — analytics treats missing
    // as "no data" (null) rather than zero.
    const o = eventBody?.order || {};
    const logisticsSet = {};
    const lspName     = o?.lsp?.name;
    const rName       = o?.rider?.name       ?? eventBody.rider_name ?? eventBody.agent_name ?? eventBody.driver_name;
    const rPhone      = o?.rider?.phone      ?? eventBody.rider_phone ?? eventBody.agent_phone ?? eventBody.driver_phone;
    const trackingUrl = o?.tracking_url;
    const lspFee      = o?.price != null ? Number(o.price) : null;
    const distanceKm  = o?.distance != null ? Number(o.distance) : null;
    const assignMin   = _minutesBetween(o?.created_at, o?.assigned_at);

    if (lspName)                         logisticsSet['logistics.lspName']     = String(lspName);
    if (rName)                           logisticsSet['logistics.riderName']   = String(rName);
    if (rPhone)                          logisticsSet['logistics.riderPhone']  = String(rPhone);
    if (trackingUrl)                     logisticsSet['logistics.trackingUrl'] = String(trackingUrl);
    if (lspFee != null && isFinite(lspFee))         logisticsSet['logistics.lspFee']     = lspFee;
    if (distanceKm != null && isFinite(distanceKm)) logisticsSet['logistics.distanceKm'] = distanceKm;
    if (assignMin != null)                          logisticsSet['logistics.agentAssignMinutes'] = assignMin;

    if (Object.keys(logisticsSet).length) {
      logisticsSet.updated_at = new Date();
      await col('orders').updateOne({ _id: order._id }, { $set: logisticsSet });
    }

    // Canonical state + assignment timestamp. Mirrors the structure of
    // the at-pickup / at-delivery handlers below (canonical UPPERCASE
    // state alongside the matching *_at stamp). The line-150 mirror
    // above writes the raw Prorouting string ('Agent-assigned'); this
    // overrides it with 'ASSIGNED' which is what the dashboard
    // DeliveryTimeline matches on. prorouting_assigned_at is parsed via
    // the existing IST helper so it stays consistent with the other
    // timestamp stamps in this file.
    const assignedAt = parseISTTimestamp(eventBody?.order?.assigned_at) || new Date();
    await col('orders').updateOne(
      { _id: order._id },
      { $set: {
          prorouting_state: 'ASSIGNED',
          prorouting_assigned_at: assignedAt,
          updated_at: new Date(),
      } }
    );
    await _emitDeliveryUpdate(order._id);

    // Late-webhook guard. If the order has already moved past the
    // dispatch lifecycle (DELIVERED, terminal cancellations, RTO),
    // skip the transition attempt + customer notification entirely.
    // Returning early here avoids a noisy "transition not allowed"
    // warn on every duplicate / out-of-order Prorouting callback.
    if (POST_DISPATCH_TERMINAL.has(order.status)) {
      log.info({ orderId: order._id, orderStatus: order.status },
        `late webhook ignored — order already in ${order.status}`);
      return { previousStatus, currentStatus: statusRaw, updated: true, late: true };
    }
    // Customer notification gates on updateStatus success. The order's
    // state machine rejects DISPATCHED transitions from terminal states
    // (EXPIRED, CANCELLED, DELIVERED, RTO_*) by throwing; the late-
    // webhook guard above handles the common cases — this catch covers
    // anything else (e.g. PAID without CONFIRMED) where a misleading
    // "rider on the way" message would otherwise go out.
    let dispatchedOk = false;
    try {
      await orderSvc.updateStatus(order._id, 'DISPATCHED');
      dispatchedOk = true;
    } catch (e) {
      log.warn({ err: e?.message, orderId: order._id, orderStatus: order.status }, 'updateStatus DISPATCHED failed — skipping customer notification');
    }
    if (dispatchedOk && ctx) {
      const riderName = eventBody.rider_name || eventBody.agent_name || eventBody.driver_name || null;
      const riderPhone = eventBody.rider_phone || eventBody.agent_phone || eventBody.driver_phone || null;
      const riderLine = riderName || riderPhone
        ? `Your rider${riderName ? ` ${riderName}` : ''}${riderPhone ? ` (${riderPhone})` : ''} is on the way.`
        : 'A delivery rider has been assigned to your order.';
      // When Prorouting supplies a tracking_url, surface it as a
      // native CTA button rather than an inline link — the in-app
      // browser launch is more tap-target-friendly and the message
      // body stays uncluttered. Fall back to the plain-text send
      // when the LSP omits tracking_url (some 3PLs at the
      // pre-assignment cusp).
      if (trackingUrl) {
        await wa.sendCtaUrl(ctx.pid, ctx.token, ctx.to, {
          body: `🛵 ${riderLine}\n\nOrder #${order.order_number} will reach you shortly.`,
          buttonText: 'Track Order',
          url: trackingUrl,
        }).catch((e) => log.warn({ err: e?.message }, 'agent-assigned sendCtaUrl failed'));
      } else {
        await wa.sendText(ctx.pid, ctx.token, ctx.to,
          `🛵 ${riderLine}\n\nOrder #${order.order_number} will reach you shortly.`
        ).catch((e) => log.warn({ err: e?.message }, 'agent-assigned sendText failed'));
      }
    }
    return { previousStatus, currentStatus: statusRaw, updated: true };
  }

  // ─── SEARCHING / AT-PICKUP / AT-DELIVERY ────────────────────
  // Intermediate Prorouting states. No GullyBite order-status flip and
  // no customer notification — those are the loud signals (agent
  // assigned / picked up / delivered). These cases just normalise the
  // state string onto the order doc so the dashboard's logistics column
  // and any future timeline view can read a stable constant.
  if (status === 'searching-for-agent') {
    await col('orders').updateOne(
      { _id: order._id },
      { $set: { prorouting_state: 'SEARCHING_AGENT', updated_at: new Date() } }
    );
    await _emitDeliveryUpdate(order._id);
    return { previousStatus, currentStatus: statusRaw, updated: true };
  }

  if (status === 'at-pickup') {
    const atPickupAt = parseISTTimestamp(eventBody?.order?.at_pickup_at) || new Date();
    await col('orders').updateOne(
      { _id: order._id },
      { $set: { prorouting_state: 'AT_PICKUP', prorouting_at_pickup_at: atPickupAt, updated_at: new Date() } }
    );
    await _emitDeliveryUpdate(order._id);
    return { previousStatus, currentStatus: statusRaw, updated: true };
  }

  if (status === 'at-delivery') {
    const atDeliveryAt = parseISTTimestamp(eventBody?.order?.at_delivery_at) || new Date();
    await col('orders').updateOne(
      { _id: order._id },
      { $set: { prorouting_state: 'AT_DELIVERY', prorouting_at_delivery_at: atDeliveryAt, updated_at: new Date() } }
    );
    await _emitDeliveryUpdate(order._id);
    return { previousStatus, currentStatus: statusRaw, updated: true };
  }

  // Prorouting's canonical state name is "Order-picked-up" (lowercased
  // to "order-picked-up" by _normaliseStatus). Pre-fix code matched
  // "picked-up" only and silently dropped every real callback. The
  // legacy short form is kept on the right of the OR for fixtures and
  // any future doc tweak that shortens the name back.
  if (status === 'order-picked-up' || status === 'picked-up') {
    // Late-webhook guard — same shape as agent-assigned above.
    if (POST_DISPATCH_TERMINAL.has(order.status)) {
      log.info({ orderId: order._id, orderStatus: order.status },
        `late webhook ignored — order already in ${order.status}`);
      return { previousStatus, currentStatus: statusRaw, updated: true, late: true };
    }
    // Self-heal: if the order missed the agent-assigned transition (rare in
    // production, common on staging where createasync fails), pulling
    // ourselves into DISPATCHED first lets the delivered branch close out
    // cleanly. Idempotent — if already DISPATCHED or further, this no-ops.
    if (order.status === 'PACKED') {
      try {
        await orderSvc.updateStatus(order._id, 'DISPATCHED');
        log.info({ orderId: order._id }, 'picked-up: self-healed PACKED → DISPATCHED');
      } catch (e) {
        log.warn({ err: e?.message, orderId: order._id, orderStatus: order.status }, 'picked-up: self-heal updateStatus DISPATCHED failed');
      }
    }

    // Dual-write logistics timings for analytics. Skip any field we
    // can't compute — null writes would poison the "no data" checks.
    const o = eventBody?.order || {};
    const logisticsSet = {};
    const reachPickupMin = _minutesBetween(o?.assigned_at, o?.reached_pickup_at || o?.pickedup_at);
    const pickupWaitMin  = _minutesBetween(o?.reached_pickup_at, o?.pickedup_at);
    if (reachPickupMin != null) logisticsSet['logistics.reachPickupMinutes'] = reachPickupMin;
    if (pickupWaitMin != null)  logisticsSet['logistics.pickupWaitMinutes']  = pickupWaitMin;
    if (Object.keys(logisticsSet).length) {
      logisticsSet.updated_at = new Date();
      await col('orders').updateOne({ _id: order._id }, { $set: logisticsSet });
    }

    if (ctx) {
      await wa.sendText(ctx.pid, ctx.token, ctx.to,
        `📦 Your order #${order.order_number} has been picked up and is on its way to you!`
      ).catch((e) => log.warn({ err: e?.message }, 'order-picked-up sendText failed'));
    }
    return { previousStatus, currentStatus: statusRaw, updated: true };
  }

  // Same normalization gotcha as the picked-up branch above —
  // Prorouting sends "Order-delivered". Accept both for fixture compat.
  if (status === 'order-delivered' || status === 'delivered') {
    // Dual-write final logistics totals. totalFee mirrors lspFee since
    // the callback doesn't break out GST. codCollected defaults to 0
    // when the field is absent (prepaid orders don't surface cod_amount).
    const o = eventBody?.order || {};
    const logisticsSet = {};
    const reachDeliveryMin = _minutesBetween(o?.pickedup_at, o?.reached_delivery_at || o?.delivered_at);
    const deliveryTotalMin = _minutesBetween(o?.created_at, o?.delivered_at);
    const totalFee         = o?.price != null ? Number(o.price) : null;
    const codCollected     = o?.cod_amount != null ? Number(o.cod_amount) : 0;
    if (reachDeliveryMin != null) logisticsSet['logistics.reachDeliveryMinutes'] = reachDeliveryMin;
    if (deliveryTotalMin != null) logisticsSet['logistics.deliveryTotalMinutes'] = deliveryTotalMin;
    if (totalFee != null && isFinite(totalFee))         logisticsSet['logistics.totalFee']     = totalFee;
    if (codCollected != null && isFinite(codCollected)) logisticsSet['logistics.codCollected'] = codCollected;
    if (Object.keys(logisticsSet).length) {
      logisticsSet.updated_at = new Date();
      await col('orders').updateOne({ _id: order._id }, { $set: logisticsSet });
    }

    // Late-webhook guard. DELIVERED arriving when the order is already
    // DELIVERED is the hot-path duplicate (Meta's at-delivery and
    // delivered events fire close together). The other terminal
    // states are the same edge cases as in agent-assigned above.
    if (POST_DISPATCH_TERMINAL.has(order.status)) {
      log.info({ orderId: order._id, orderStatus: order.status },
        `late webhook ignored — order already in ${order.status}`);
      return { previousStatus, currentStatus: statusRaw, updated: true, late: true };
    }
    // PACKED → DELIVERED self-heal path. Prorouting occasionally drops
    // the agent-assigned + picked-up callbacks but does fire delivered;
    // without this branch the order would be stuck in PACKED. The
    // TRANSITIONS map permits the jump (orderStateEngine.js); we log
    // the skip here at warn-level so ops can spot the missing events.
    if (order.status === 'PACKED') {
      log.warn({ orderId: order._id }, `self-heal: skipped DISPATCHED state for order ${order._id}`);
    }
    // Customer notifications gate on updateStatus success — same
    // reasoning as Agent-assigned. A DELIVERED transition rejected by
    // the state machine (e.g. order was already CANCELLED / EXPIRED /
    // RTO_COMPLETE) means the order didn't actually deliver from
    // GullyBite's perspective; we must not tell the customer it did or
    // ask them to rate it.
    let deliveredOk = false;
    try {
      await orderSvc.updateStatus(order._id, 'DELIVERED');
      deliveredOk = true;
    } catch (e) {
      log.warn({ err: e?.message, orderId: order._id, orderStatus: order.status }, 'updateStatus DELIVERED failed — skipping customer notification + rating flow');
    }
    if (deliveredOk && ctx) {
      // Customer-facing delivered notification. Wording lives in
      // services/whatsapp.js's STATUS_MESSAGES.DELIVERED so the
      // CONFIRMED → PREPARING → PACKED → DISPATCHED → DELIVERED
      // sequence is owned by a single map.
      await wa.sendStatusUpdate(ctx.pid, ctx.token, ctx.to, 'DELIVERED', {
        orderNumber: order.display_order_id || order.order_number,
      }).catch((e) => log.warn({ err: e?.message }, 'order-delivered sendStatusUpdate failed'));

      // Rating ask is owned end-to-end by the LOYALTY_AWARD →
      // FEEDBACK_REQUEST chain in queue/postPaymentJobs.js, scheduled
      // by services/order.js at every DELIVERED transition (regardless
      // of payment path). No feedback fan-out from this Prorouting
      // handler — the order.js path is the single canonical pipeline.
    }
    return { previousStatus, currentStatus: statusRaw, updated: true };
  }

  // ─── RTO PATH ──────────────────────────────────────────────
  if (status === 'rto-initiated') {
    try { await orderSvc.updateStatus(order._id, 'RTO_IN_PROGRESS'); } catch (e) { log.warn({ err: e?.message, orderId: order._id }, 'updateStatus RTO_IN_PROGRESS failed'); }
    const rtoInitiatedAt = parseISTTimestamp(eventBody?.order?.rto_initiated_at) || new Date();
    await col('orders').updateOne(
      { _id: order._id },
      { $set: {
          is_rto: true,
          delivery_status: 'RTO_INITIATED',
          prorouting_state:  'RTO_INITIATED',
          prorouting_rto_initiated_at: rtoInitiatedAt,
          updated_at: new Date(),
      } }
    );
    await _emitDeliveryUpdate(order._id);
    log.warn({ orderId: order._id, orderNumber: order.order_number }, 'prorouting RTO initiated');

    // Auto-raise a FULFILLMENT / FLM03 issue so ops has a dispute
    // thread queued before the kitchen + customer start asking.
    if (!order.prorouting_issue_id && order.prorouting_order_id) {
      try {
        const { issue_id, issue_state } = await prorouting.raiseIssue(
          order.prorouting_order_id,
          'FLM03',
          'RTO Initiated for order',
          `Order could not be delivered and RTO has been initiated. GullyBite Order ID: ${order._id}`
        );
        await col('orders').updateOne(
          { _id: order._id },
          { $set: { prorouting_issue_id: issue_id, prorouting_issue_state: issue_state, updated_at: new Date() } }
        );
      } catch (issueErr) {
        if (issueErr?.name === 'DuplicateIssueError') {
          log.info({ orderId: order._id }, 'rto-initiated: issue already open, skipping');
        } else {
          log.warn({ err: issueErr?.message, orderId: order._id }, 'rto-initiated: raiseIssue failed');
        }
      }
    }

    await _sendRtoAlert(order,
      `⚠️ RTO initiated for Order #${order.order_number}. The rider could not deliver and is returning the order. Our team has been notified.`
    );

    // Customer-facing notification — RTO initiated means delivery
    // failed and a refund/resolution path has started. Routes through
    // the order_cancelled template (CANCELLED keyword in
    // STATUS_MESSAGES) since the framing — order won't reach you,
    // payment will be refunded — is identical to a cancellation.
    // Fire-and-forget, same shape as the LSP-cancelled handler below.
    if (ctx) {
      await wa.sendStatusUpdate(ctx.pid, ctx.token, ctx.to, 'CANCELLED', {
        orderNumber: order.display_order_id || order.order_number,
      }).catch((e) => log.warn({ err: e?.message }, 'rto-initiated sendStatusUpdate failed'));
    }

    return { previousStatus, currentStatus: statusRaw, updated: true };
  }

  if (status === 'rto-delivered') {
    try { await orderSvc.updateStatus(order._id, 'RTO_COMPLETE'); } catch (e) { log.warn({ err: e?.message, orderId: order._id }, 'updateStatus RTO_COMPLETE failed'); }
    const rtoDeliveredAt = parseISTTimestamp(eventBody?.order?.rto_delivered_at) || new Date();
    await col('orders').updateOne(
      { _id: order._id },
      { $set: {
          delivery_status: 'RTO_DELIVERED',
          prorouting_state: 'RTO_DELIVERED',
          prorouting_rto_delivered_at: rtoDeliveredAt,
          updated_at: new Date(),
      } }
    );
    await _emitDeliveryUpdate(order._id);
    log.warn({ orderId: order._id, orderNumber: order.order_number }, 'prorouting RTO delivered (returned to restaurant)');
    await _sendRtoAlert(order,
      `📦 RTO complete for Order #${order.order_number}. Package has been returned to the restaurant.`
    );

    // Customer-facing notification — order was returned to the
    // restaurant. Distinct from rto-initiated (refund framing) — here
    // the resolution path depends on the restaurant's follow-up
    // (re-attempt delivery, partial refund, full refund, etc.) so we
    // explicitly avoid the canned CANCELLED text which presupposes a
    // refund. Custom sendText keeps the framing accurate.
    if (ctx) {
      await wa.sendText(ctx.pid, ctx.token, ctx.to,
        `📦 Order #${order.order_number}: We couldn't deliver your order and it's been returned to the restaurant. Our team will reach out to you shortly for resolution.`
      ).catch((e) => log.warn({ err: e?.message }, 'rto-delivered sendText failed'));
    }

    return { previousStatus, currentStatus: statusRaw, updated: true };
  }

  if (status === 'rto-disposed') {
    try { await orderSvc.updateStatus(order._id, 'RTO_COMPLETE'); } catch (e) { log.warn({ err: e?.message, orderId: order._id }, 'updateStatus RTO_COMPLETE failed'); }
    await col('orders').updateOne(
      { _id: order._id },
      { $set: {
          delivery_status: 'RTO_DISPOSED',
          prorouting_state: 'RTO_DISPOSED',
          updated_at: new Date(),
      } }
    );
    await _emitDeliveryUpdate(order._id);
    // ERROR-level: RTO disposed means the food is lost — neither delivered
    // to customer nor returned to restaurant. Surfaces in error dashboards.
    log.error({ orderId: order._id, orderNumber: order.order_number }, 'prorouting RTO DISPOSED — food lost, package neither delivered nor returned');
    await _sendRtoAlert(order,
      `⚠️ RTO disposed for Order #${order.order_number}. Package could not be returned and has been disposed by the LSP. Please raise a dispute if needed.`
    );

    // Customer-facing notification — food was lost in transit
    // (neither delivered to the customer nor returned to the
    // restaurant). Full-refund framing, routed through the
    // order_cancelled template path same as rto-initiated and the
    // LSP-cancelled handler — refund text fits because the
    // customer's payment IS being returned in this terminal state.
    if (ctx) {
      await wa.sendStatusUpdate(ctx.pid, ctx.token, ctx.to, 'CANCELLED', {
        orderNumber: order.display_order_id || order.order_number,
      }).catch((e) => log.warn({ err: e?.message }, 'rto-disposed sendStatusUpdate failed'));
    }

    return { previousStatus, currentStatus: statusRaw, updated: true };
  }

  // ─── LSP CANCELLED ─────────────────────────────────────────
  // Prorouting reports the delivery was cancelled on their side (rider
  // dropped, zone closed, manual ops intervention, etc). We mirror the
  // logistics state but do NOT transition the GullyBite order — the
  // restaurant/customer cancel paths own that transition. If the order
  // has already reached a terminal state we no-op so duplicate callbacks
  // don't re-alert.
  //
  // EXCEPTION: when the cancellation reason indicates Prorouting could
  // not allocate a rider (no riders available, all unreachable, zone
  // unsupported, etc.) the GullyBite order goes to NO_DELIVERY_AVAILABLE
  // and we refund the customer in full — platform absorbs the Razorpay
  // fee per business policy.
  if (status === 'cancelled') {
    const TERMINAL_ORDER_STATES = ['CANCELLED', 'DELIVERED', 'EXPIRED', 'RTO_COMPLETE',
      'REJECTED_BY_RESTAURANT', 'RESTAURANT_TIMEOUT', 'NO_DELIVERY_AVAILABLE'];
    if (TERMINAL_ORDER_STATES.includes(order.status)) {
      log.info({ orderId: order._id, orderStatus: order.status }, 'cancelled callback: GullyBite order already terminal — no-op');
      return { previousStatus, currentStatus: statusRaw, updated: false };
    }

    const cancelledAt = eventBody?.order?.cancelled_at || null;
    const reasonDesc  = eventBody?.order?.cancellation?.reason_desc || null;
    const reasonCode  = eventBody?.order?.cancellation?.reason_code || null;

    const logisticsSet = {};
    if (cancelledAt) logisticsSet['logistics.cancelledAt']        = cancelledAt;
    if (reasonDesc)  logisticsSet['logistics.cancellationReason'] = reasonDesc;
    if (reasonCode)  logisticsSet['logistics.cancellationReasonCode'] = reasonCode;
    if (Object.keys(logisticsSet).length) {
      logisticsSet.updated_at = new Date();
      await col('orders').updateOne({ _id: order._id }, { $set: logisticsSet });
    }

    // No-rider detection. Prorouting's reason taxonomy isn't fully
    // documented for our integration; match common substrings and
    // codes. Anything else falls through to the manual-reassignment
    // alert below (existing behavior — preserved).
    const reasonBlob = `${reasonDesc || ''} ${reasonCode || ''}`.toLowerCase();
    const isNoRider = /no[\s_-]*rider|no[\s_-]*delivery|no[\s_-]*agent|unable[\s_-]*to[\s_-]*allocate|allocation[\s_-]*fail|rider[\s_-]*unavailable|no[\s_-]*executive/.test(reasonBlob);

    if (isNoRider) {
      log.warn({ orderId: order._id, reasonDesc, reasonCode }, 'prorouting cancelled — no rider available, initiating refund');
      // Fire-and-forget: webhook contract is "always 200"; refund
      // failures must not propagate as HTTP errors back to Prorouting.
      setImmediate(() => {
        const cancellation = require('./orderCancellationService');
        cancellation.handleNoRiderFault(order._id)
          .catch((err) => log.error({ err: err?.message, orderId: order._id }, 'handleNoRiderFault failed'));
      });
      return { previousStatus, currentStatus: statusRaw, updated: true };
    }

    // Auto re-dispatch on LSP drop. Most non-no-rider cancellations are
    // transient (zone glitch, rider unreachable, momentary outage) and a
    // fresh ORDER_DISPATCH job tends to succeed on the second try.
    // Budget: 2 retries (configurable later via env if needed) before
    // we give up and escalate to ops + customer.
    //
    // The customer notification deliberately fires only on the give-up
    // path — telling them "order cancelled" while a retry is in flight
    // would confuse them when the rider eventually shows up.
    //
    // The retry enqueue below passes `isRetry: true` so the
    // ORDER_DISPATCH handler's CONFIRMED/PREPARING status guard is
    // skipped — orders past PACKED at LSP-cancellation time would
    // otherwise no-op silently.
    const attempts = Number(order.prorouting_dispatch_attempts) || 0;

    if (attempts >= 2) {
      // Retry budget exhausted. Counter still increments for
      // observability — third+ callback (rare) won't double-notify
      // the customer because the order will hit a terminal state
      // (manual ops cancel or RTO) before then.
      await col('orders').updateOne(
        { _id: order._id },
        { $inc: { prorouting_dispatch_attempts: 1 }, $set: { updated_at: new Date() } }
      );
      log.error(
        { orderId: order._id, orderNumber: order.order_number, reasonDesc, attempts: attempts + 1 },
        'prorouting cancelled — retry budget exhausted, manual reassignment needed',
      );
      // Customer-facing cancellation. Fire-and-forget, same contract
      // as the order-delivered sendStatusUpdate — never awaited beyond
      // the .catch and never thrown. The CANCELLED keyword resolves to
      // the canned text in services/whatsapp.js STATUS_MESSAGES; the
      // order_cancelled Meta template is the underlying approved
      // template path.
      if (ctx) {
        await wa.sendStatusUpdate(ctx.pid, ctx.token, ctx.to, 'CANCELLED', {
          orderNumber: order.display_order_id || order.order_number,
        }).catch((e) => log.warn({ err: e?.message }, 'cancelled sendStatusUpdate failed'));
      }
      await _sendRtoAlert(order,
        `⚠️ Delivery cancelled by LSP for Order #${order.order_number}${reasonDesc ? ` — Reason: ${reasonDesc}` : ''}. Auto re-dispatch exhausted (${attempts + 1} attempts). Please reassign the delivery manually.`
      );
      return { previousStatus, currentStatus: statusRaw, updated: true };
    }

    // Retry available — bump counter then enqueue a fresh
    // ORDER_DISPATCH job. Call shape mirrors the /accept site at
    // routes/restaurant.js:6080 (setImmediate + lazy require + .catch).
    // Always goes through the queue — never call dispatchDelivery
    // directly — so retry/error handling stays consistent with the
    // primary dispatch path.
    await col('orders').updateOne(
      { _id: order._id },
      { $inc: { prorouting_dispatch_attempts: 1 }, $set: { updated_at: new Date() } }
    );
    log.info(
      { orderId: order._id, orderNumber: order.order_number, reasonDesc, attempt: attempts + 1 },
      'prorouting cancelled — auto re-dispatching',
    );
    setImmediate(() => {
      const { enqueue, JOB_TYPES } = require('../queue/postPaymentJobs');
      // isRetry: true tells _handleOrderDispatch's status guard to
      // skip the CONFIRMED/PREPARING check — orders at this point are
      // already past PACKED (the original dispatch ran before the LSP
      // cancellation) and would otherwise no-op silently. See the
      // matching `if (!payload.isRetry && ...)` block in postPaymentJobs.js.
      enqueue(JOB_TYPES.ORDER_DISPATCH, {
        orderId: String(order._id),
        restaurantId: String(order.restaurant_id),
        isRetry: true,
      }).catch((err) => log.warn({ err: err?.message, orderId: order._id }, 'enqueue ORDER_DISPATCH retry failed (non-fatal)'));
    });
    await _sendRtoAlert(order,
      `🔄 Delivery dropped by LSP for Order #${order.order_number}${reasonDesc ? ` — Reason: ${reasonDesc}` : ''}. Auto-retry queued (attempt ${attempts + 1}/2).`
    );

    return { previousStatus, currentStatus: statusRaw, updated: true };
  }

  log.info({ status, orderId: order._id }, 'prorouting state: not actionable — state mirrored only');
  return { previousStatus, currentStatus: statusRaw, updated: false };
}

module.exports = {
  applyProroutingState,
  _normaliseStatus,
};
