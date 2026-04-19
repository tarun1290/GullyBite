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
const log = require('../utils/logger').child({ component: 'prorouting-state' });

const RATING_FLOW_ID = process.env.RATING_FLOW_ID || '941765451575098';

function _normaliseStatus(raw) {
  if (!raw) return null;
  return String(raw).toLowerCase().replace(/[\s_]+/g, '-').trim();
}

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
  const previousStatus = order?.prorouting_status || null;
  if (!order || !status) {
    return { previousStatus, currentStatus: previousStatus, updated: false };
  }

  const isNewStatus = previousStatus !== statusRaw && _normaliseStatus(previousStatus) !== status;

  // Always mirror the latest raw state onto the order row — the state
  // column on the dashboard should reflect what Prorouting is saying
  // right now, even when the change is a no-op from our side.
  await col('orders').updateOne(
    { _id: order._id },
    { $set: { prorouting_status: statusRaw || status, updated_at: new Date() } }
  );

  if (!isNewStatus) {
    log.info({ orderId: order._id, status }, 'prorouting state: unchanged — no side effects');
    return { previousStatus, currentStatus: statusRaw || status, updated: false };
  }

  const ctx = await _resolveMessagingContext(order);

  // ─── HAPPY PATH ────────────────────────────────────────────
  if (status === 'agent-assigned') {
    // Dual-write: populate the logistics subdocument for analytics
    // alongside the existing flat prorouting_status mirror above.
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

    try { await orderSvc.updateStatus(order._id, 'DISPATCHED'); } catch (e) { log.warn({ err: e?.message, orderId: order._id }, 'updateStatus DISPATCHED failed'); }
    if (ctx) {
      const riderName = eventBody.rider_name || eventBody.agent_name || eventBody.driver_name || null;
      const riderPhone = eventBody.rider_phone || eventBody.agent_phone || eventBody.driver_phone || null;
      const riderLine = riderName || riderPhone
        ? `Your rider${riderName ? ` ${riderName}` : ''}${riderPhone ? ` (${riderPhone})` : ''} is on the way.`
        : 'A delivery rider has been assigned to your order.';
      await wa.sendText(ctx.pid, ctx.token, ctx.to,
        `🛵 ${riderLine}\n\nOrder #${order.order_number} will reach you shortly.`
      ).catch((e) => log.warn({ err: e?.message }, 'agent-assigned sendText failed'));
    }
    return { previousStatus, currentStatus: statusRaw, updated: true };
  }

  if (status === 'order-picked-up') {
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

  if (status === 'order-delivered') {
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

    try { await orderSvc.updateStatus(order._id, 'DELIVERED'); } catch (e) { log.warn({ err: e?.message, orderId: order._id }, 'updateStatus DELIVERED failed'); }
    if (ctx) {
      await wa.sendText(ctx.pid, ctx.token, ctx.to,
        `✅ Order #${order.order_number} delivered. Enjoy your meal! 🍽️`
      ).catch((e) => log.warn({ err: e?.message }, 'order-delivered sendText failed'));

      await wa.sendFlow(ctx.pid, ctx.token, ctx.to, {
        flowId: RATING_FLOW_ID,
        flowToken: `rating_${order._id}`,
        flowCta: '⭐ Rate Order',
        screenId: 'RATING_SCREEN',
        flowData: {
          body: `How was your order #${order.order_number}?`,
          footer: 'Your feedback helps improve quality',
          screenData: {
            order_number: order.order_number,
            order_id: String(order._id),
            flow_token: `rating_${order._id}`,
          },
        },
      }).catch((e) => log.warn({ err: e?.message }, 'rating flow send failed'));
    }
    return { previousStatus, currentStatus: statusRaw, updated: true };
  }

  // ─── RTO PATH ──────────────────────────────────────────────
  if (status === 'rto-initiated') {
    try { await orderSvc.updateStatus(order._id, 'RTO_IN_PROGRESS'); } catch (e) { log.warn({ err: e?.message, orderId: order._id }, 'updateStatus RTO_IN_PROGRESS failed'); }
    await col('orders').updateOne({ _id: order._id }, { $set: { is_rto: true, updated_at: new Date() } });

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
    return { previousStatus, currentStatus: statusRaw, updated: true };
  }

  if (status === 'rto-delivered') {
    try { await orderSvc.updateStatus(order._id, 'RTO_COMPLETE'); } catch (e) { log.warn({ err: e?.message, orderId: order._id }, 'updateStatus RTO_COMPLETE failed'); }
    await _sendRtoAlert(order,
      `📦 RTO complete for Order #${order.order_number}. Package has been returned to the restaurant.`
    );
    return { previousStatus, currentStatus: statusRaw, updated: true };
  }

  if (status === 'rto-disposed') {
    try { await orderSvc.updateStatus(order._id, 'RTO_COMPLETE'); } catch (e) { log.warn({ err: e?.message, orderId: order._id }, 'updateStatus RTO_COMPLETE failed'); }
    await _sendRtoAlert(order,
      `⚠️ RTO disposed for Order #${order.order_number}. Package could not be returned and has been disposed by the LSP. Please raise a dispute if needed.`
    );
    return { previousStatus, currentStatus: statusRaw, updated: true };
  }

  // ─── LSP CANCELLED ─────────────────────────────────────────
  // Prorouting reports the delivery was cancelled on their side (rider
  // dropped, zone closed, manual ops intervention, etc). We mirror the
  // logistics state but do NOT transition the GullyBite order — the
  // restaurant/customer cancel paths own that transition. If the order
  // has already reached a terminal state we no-op so duplicate callbacks
  // don't re-alert.
  if (status === 'cancelled') {
    const TERMINAL_ORDER_STATES = ['CANCELLED', 'DELIVERED', 'EXPIRED', 'RTO_COMPLETE'];
    if (TERMINAL_ORDER_STATES.includes(order.status)) {
      log.info({ orderId: order._id, orderStatus: order.status }, 'cancelled callback: GullyBite order already terminal — no-op');
      return { previousStatus, currentStatus: statusRaw, updated: false };
    }

    const cancelledAt = eventBody?.order?.cancelled_at || null;
    const reasonDesc  = eventBody?.order?.cancellation?.reason_desc || null;

    const logisticsSet = {};
    if (cancelledAt) logisticsSet['logistics.cancelledAt']        = cancelledAt;
    if (reasonDesc)  logisticsSet['logistics.cancellationReason'] = reasonDesc;
    if (Object.keys(logisticsSet).length) {
      logisticsSet.updated_at = new Date();
      await col('orders').updateOne({ _id: order._id }, { $set: logisticsSet });
    }

    log.warn({ orderId: order._id, clientOrderId: order._id, reasonDesc }, 'prorouting cancelled — LSP dropped delivery, manual reassignment needed');

    await _sendRtoAlert(order,
      `⚠️ Delivery cancelled by LSP for Order #${order.order_number}${reasonDesc ? ` — Reason: ${reasonDesc}` : ''}. Please reassign the delivery manually.`
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
