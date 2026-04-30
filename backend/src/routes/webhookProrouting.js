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

module.exports = router;
