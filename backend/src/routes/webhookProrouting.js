// src/routes/webhookProrouting.js
//
// Prorouting (3PL) webhook. Receives lifecycle events for dispatched
// orders. Two payload shapes:
//
//   STATUS CALLBACK
//     { status: 1, order: { id, client_order_id, state, lsp, price, distance,
//                           rider, tracking_url, ...timestamps, cancellation? } }
//   TRACK CALLBACK
//     { status: 1, orders: [{ id, network_order_id, client_order_id, rider,
//                             url }] }
//
// `body.status` is the success/failure ACK (1=ok, 0=rejected). The real
// lifecycle state for a status callback lives in `body.order.state` —
// reading `body.status` as the state was the long-standing bug behind
// "webhook arrived but nothing happened".
//
// State transitions and customer notifications are delegated to
// services/proroutingState.js (applyProroutingState). The handler here
// only does payload shape detection, the upfront ingest of informational
// fields (rider, lsp, distance, proofs, tracking_url), and the call to
// applyProroutingState. Track callbacks bypass the state machine — they
// only refresh rider.last_location + tracking_url.
//
// Contract:
//   - Auth: `x-pro-api-key` header must equal PROROUTING_API_KEY.
//     Mismatch → 401. No key configured → 500 (misconfiguration, not a
//     client error — Prorouting shouldn't retry into a misconfigured
//     endpoint).
//   - Response: ALWAYS 200 OK once auth passes. Prorouting retries on
//     any non-200, so internal failures are swallowed and logged.

'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const { col } = require('../config/database');
const { applyProroutingState } = require('../services/proroutingState');
const log = require('../utils/logger').child({ component: 'prorouting-webhook' });

// Constant-time API-key comparison. Plain string `===` leaks information
// through response timing (early-exit on first mismatched byte), so use
// crypto.timingSafeEqual on equal-length buffers. timingSafeEqual throws
// when buffer lengths differ — wrap in try/catch and treat any throw as
// "not equal" (mirrors services/payment.js verifyWebhookSignature).
function timingSafeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  try {
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

router.post('/', express.json({ limit: '64kb' }), async (req, res) => {
  // TEMPORARY diagnostic — fires before auth so we capture even
  // unauthenticated probes. Remove once the upstream payload shape
  // has been fully characterised.
  log.info({ headers: req.headers, body: req.body, ip: req.ip }, 'prorouting webhook: incoming raw request');

  // ─── AUTH ────────────────────────────────────────────────────
  const expectedKey = process.env.PROROUTING_API_KEY;
  if (!expectedKey) {
    log.error('PROROUTING_API_KEY not configured — rejecting webhook');
    return res.status(500).send('not configured');
  }
  const providedKey = req.get('x-pro-api-key');
  if (!timingSafeStringEqual(providedKey, expectedKey)) {
    log.warn({ ip: req.ip }, 'prorouting webhook: invalid api key');
    return res.status(401).send('unauthorized');
  }

  // Auth passed — from here on, always 200. Prorouting retries on
  // non-200 so we must not propagate internal failures as HTTP errors.
  res.status(200).json({ ok: true });

  const body = req.body || {};

  // body.status is Prorouting's success flag, NOT a lifecycle state.
  // Reject anything other than 1 with a clear log entry.
  if (body.status !== 1 && body.status !== '1') {
    log.warn({ status: body.status, message: body.message, body }, 'prorouting webhook: status != 1, skipping');
    return;
  }

  // Detect payload shape. Track callbacks are an array under `orders`;
  // status callbacks are a single object under `order`.
  if (Array.isArray(body.orders)) {
    await _handleTrackCallback(body.orders);
    return;
  }
  if (body.order && typeof body.order === 'object') {
    await _handleStatusCallback(body);
    return;
  }
  log.warn({ body }, 'prorouting webhook: unrecognised payload shape (neither order nor orders[])');
});

// ─── STATUS CALLBACK ──────────────────────────────────────────
// Persists ingest-only informational fields (lsp, rider, distance,
// price, proofs, tracking_url, cancellation) onto the order doc, then
// hands the lifecycle state to applyProroutingState which owns
// state-transition side effects (DISPATCHED / DELIVERED / RTO_*) and
// customer notifications. These are split because the informational
// fields are safe to write on every callback regardless of state, but
// state transitions must run exactly once per state change.
async function _handleStatusCallback(body) {
  const orderBlock = body.order || {};
  const clientOrderId = orderBlock.client_order_id || null;
  const state = orderBlock.state || null;

  log.info({ clientOrderId, state, body }, 'prorouting status callback');

  if (!clientOrderId || !state) {
    log.warn({ clientOrderId, state }, 'prorouting status callback: missing client_order_id or state, nothing to do');
    return;
  }

  try {
    const order = await col('orders').findOne({ _id: clientOrderId });
    if (!order) {
      log.warn({ clientOrderId }, 'prorouting status callback: order not found');
      return;
    }

    // Upfront $set of ingest-only fields. Each guarded with `!= null` so
    // partial callbacks (e.g. price not yet known at Agent-assigned)
    // don't blow away previously-persisted values with undefined.
    const $set = { updated_at: new Date() };
    if (orderBlock.id != null)            $set.prorouting_order_id      = String(orderBlock.id);
    if (orderBlock.state)                 $set.prorouting_state          = String(orderBlock.state);
    if (orderBlock.lsp)                   $set.lsp                       = orderBlock.lsp;
    if (orderBlock.price != null)         $set.prorouting_actual_price   = Number(orderBlock.price) || 0;
    if (orderBlock.distance != null)      $set.prorouting_distance       = Number(orderBlock.distance) || 0;
    if (orderBlock.rider)                 $set.rider                     = orderBlock.rider;
    if (orderBlock.tracking_url)          $set.prorouting_tracking_url   = String(orderBlock.tracking_url);
    if (orderBlock.pickup_proof)          $set.prorouting_pickup_proof   = orderBlock.pickup_proof;
    if (orderBlock.delivery_proof)        $set.prorouting_delivery_proof = orderBlock.delivery_proof;
    if (orderBlock.cancellation && typeof orderBlock.cancellation === 'object') {
      if (orderBlock.cancellation.reason_id != null)
        $set.cancellation_reason_id   = String(orderBlock.cancellation.reason_id);
      if (orderBlock.cancellation.reason_desc != null)
        $set.cancellation_reason_desc = String(orderBlock.cancellation.reason_desc);
    }

    if (Object.keys($set).length > 1) {
      await col('orders').updateOne({ _id: clientOrderId }, { $set }).catch((err) => {
        log.warn({ err: err?.message, clientOrderId }, 'prorouting ingest $set failed (continuing to state handler)');
      });
    }

    // applyProroutingState owns its own $set for state-driven fields
    // (status, dispatched_at, delivered_at, etc) and customer messaging.
    // Pass the original body so its handlers see Prorouting's IST
    // timestamps and other state-specific fields.
    await applyProroutingState(order, state, body);
  } catch (err) {
    log.error({ err: err?.message, stack: err?.stack, clientOrderId, state }, 'prorouting status callback handler failed');
  }
}

// ─── TRACK CALLBACK ───────────────────────────────────────────
// Position-only updates. Refreshes rider.last_location + tracking URL
// for each order in the batch. Does NOT drive state transitions —
// position pings can arrive interleaved with status callbacks and
// applying them as state would cause spurious flips.
async function _handleTrackCallback(orders) {
  for (const o of orders || []) {
    const clientOrderId = o?.client_order_id;
    if (!clientOrderId) {
      log.warn({ entry: o }, 'prorouting track callback: entry missing client_order_id');
      continue;
    }

    const $set = { updated_at: new Date() };
    if (o.rider?.last_location && typeof o.rider.last_location === 'object') {
      // Use a dotted path so we update the nested location WITHOUT
      // overwriting the rider name / phone / etc that arrived via the
      // status callback.
      $set['rider.last_location'] = o.rider.last_location;
    }
    const url = o.url || o.tracking_url;
    if (url) $set.prorouting_tracking_url = String(url);

    if (Object.keys($set).length > 1) {
      try {
        await col('orders').updateOne({ _id: clientOrderId }, { $set });
      } catch (err) {
        log.warn({ err: err?.message, clientOrderId }, 'prorouting track callback update failed');
      }
    }
  }
}

// ─── POST /webhook/prorouting/track ───────────────────────────
// Dedicated Track Callback endpoint. Prorouting POSTs a bulk array of
// rider position updates here (configured via the Track Callback URL
// field in their dashboard, separate from createasync's callback_url
// which is for status events). Position updates are write-heavy and
// volatile — we land them in Redis with a 10-minute TTL instead of the
// orders collection so the dashboard's tracking-page poll can read them
// cheaply without bloating Mongo. The status-callback endpoint at `/`
// continues to handle lifecycle state separately.
//
// Body shape (per Prorouting spec):
//   { status: 1, orders: [{ id, network_order_id, client_order_id,
//                           rider: { last_location: { lat, lng, updated_at } },
//                           url }] }
//
// Auth, no-state-transitions, fire-and-forget. Always 200 once auth
// passes — never block Prorouting on internal failures.
router.post('/track', express.json({ limit: '256kb' }), async (req, res) => {
  const expectedKey = process.env.PROROUTING_API_KEY;
  if (!expectedKey) {
    log.error('PROROUTING_API_KEY not configured — rejecting track webhook');
    return res.status(500).send('not configured');
  }
  const providedKey = req.get('x-pro-api-key');
  if (!timingSafeStringEqual(providedKey, expectedKey)) {
    log.warn({ ip: req.ip }, 'prorouting track webhook: invalid api key');
    return res.status(401).send('unauthorized');
  }

  res.status(200).json({ ok: true });

  const body = req.body || {};
  if (body.status !== 1 && body.status !== '1') {
    log.warn({ status: body.status, message: body.message }, 'prorouting track webhook: status != 1, skipping');
    return;
  }
  const orders = Array.isArray(body.orders) ? body.orders : [];
  if (!orders.length) {
    log.warn('prorouting track webhook: empty orders array, nothing to do');
    return;
  }

  let written = 0;
  let sseEmitted = 0;
  let socketEmitted = 0;
  try {
    const redis = require('../config/redis');
    const sse = require('../services/sseConnections');
    const { emitToRestaurant } = require('../utils/socketEmit');
    const rc = await redis.getClient();

    // Per-batch cache so the same client_order_id appearing twice in a
    // batch (rare but possible during catch-up retries) doesn't trigger
    // two findOne calls. Keyed by client_order_id; value is null when the
    // lookup didn't find an order so we don't retry.
    const orderCtxCache = new Map();
    const ordersDb = (globalThis._mongoClient
      ? globalThis._mongoClient.db('gullybite').collection('orders')
      : null);

    for (const o of orders) {
      const cid = o?.client_order_id;
      const lat = Number(o?.rider?.last_location?.lat);
      const lng = Number(o?.rider?.last_location?.lng);
      if (!cid) continue;
      // Reject NaN, ±Infinity, AND the (0, 0) sentinel that Prorouting
      // sometimes sends as a placeholder before the rider's GPS locks.
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (lat === 0 && lng === 0) continue;

      const updatedAt = o?.rider?.last_location?.updated_at || new Date().toISOString();
      const trackingUrl = o?.url ? String(o.url) : undefined;

      const value = JSON.stringify({
        lat,
        lng,
        updated_at: updatedAt,
        ...(o?.id ? { prorouting_order_id: String(o.id) } : {}),
        ...(trackingUrl ? { tracking_url: trackingUrl } : {}),
      });
      try {
        await rc.set(`prorouting:rider:${cid}`, value, { EX: 600 });
        written += 1;
      } catch (err) {
        log.warn({ err: err?.message, cid }, 'prorouting track: redis set failed');
      }

      // Resolve order → branch_id + restaurant_id, then push via SSE
      // through the existing pushToRestaurant channel. Keyed per
      // restaurant; sseConnections internally branch-filters by
      // matching payload.branch_id against each connection's
      // branchIds[] (see services/sseConnections.js:108-123). Failures
      // here MUST NOT block Prorouting — wrap and warn only.
      if (!ordersDb) continue;
      try {
        let ctx = orderCtxCache.get(cid);
        if (ctx === undefined) {
          const orderDoc = await ordersDb.findOne(
            { _id: String(cid) },
            { projection: { branch_id: 1, restaurant_id: 1 } }
          );
          ctx = orderDoc ? {
            branch_id: orderDoc.branch_id ? String(orderDoc.branch_id) : null,
            restaurant_id: orderDoc.restaurant_id ? String(orderDoc.restaurant_id) : null,
          } : null;
          orderCtxCache.set(cid, ctx);
        }
        if (!ctx) {
          log.debug({ cid }, 'prorouting track: order not found, skipping SSE push');
          continue;
        }
        if (!ctx.restaurant_id) {
          log.debug({ cid }, 'prorouting track: order has no restaurant_id, skipping SSE push');
          continue;
        }

        const ssePayload = {
          order_id: String(cid),
          branch_id: ctx.branch_id || undefined,
          lat,
          lng,
          updated_at: updatedAt,
          ...(trackingUrl ? { tracking_url: trackingUrl } : {}),
        };
        const delivered = sse.pushToRestaurant(ctx.restaurant_id, 'rider_location', ssePayload);
        if (delivered > 0) sseEmitted += 1;

        // Socket.io emit to the restaurant room — this is the channel
        // the dashboard's SocketProvider actually subscribes to (the SSE
        // push above lands in services/sseConnections, which only the
        // staff app consumes today). emitToRestaurant is internally
        // fail-silent and fire-and-forget per the canonical pattern at
        // utils/socketEmit.js:25-34, matching every other emit site
        // (orderStateEngine, webhooks/checkout, jobs/postPaymentJobs).
        // Same ssePayload is reused — both channels see identical data.
        emitToRestaurant(ctx.restaurant_id, 'rider_location', ssePayload);
        socketEmitted += 1;
      } catch (sseErr) {
        log.warn({ err: sseErr?.message, cid }, 'prorouting track: SSE / socket push failed (continuing)');
      }
    }
    log.debug({ count: orders.length, written, sseEmitted, socketEmitted }, 'prorouting track callback batch processed');
  } catch (err) {
    log.error({ err: err?.message, stack: err?.stack }, 'prorouting track callback handler failed');
  }
});

module.exports = router;
