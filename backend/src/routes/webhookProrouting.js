// src/routes/webhookProrouting.js
//
// Prorouting (3PL) webhook. Receives lifecycle events for dispatched
// orders. The request body carries `client_order_id` (our orders._id)
// and a status string; all state-transition logic lives in
// services/proroutingState.js so the restaurant dashboard's
// /sync-status poll can reuse the exact same side effects.
//
// Contract:
//   - Auth: `x-pro-api-key` header must equal PROROUTING_API_KEY.
//     Mismatch → 401. No key configured → 500 (misconfiguration, not a
//     client error — Prorouting shouldn't retry into a misconfigured
//     endpoint).
//   - Response: ALWAYS 200 on auth success. Prorouting retries on any
//     non-200, so we swallow internal errors and log them.
//   - Handled states (active logic):
//       Agent-assigned   → DISPATCHED + customer "rider on the way"
//       Order-picked-up  → customer pickup message
//       Order-delivered  → DELIVERED + customer thanks + rating flow
//       RTO-Initiated    → RTO_IN_PROGRESS + is_rto=true + auto-raise
//                          FULFILLMENT/FLM03 issue + restaurant + admin alert
//       RTO-Delivered    → RTO_COMPLETE + restaurant + admin alert
//       RTO-Disposed     → RTO_COMPLETE + restaurant + admin alert
//     Every other Prorouting status is log-only and mirrored onto
//     prorouting_status.

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
  res.status(200).send('ok');

  const body = req.body || {};
  const clientOrderId = body.client_order_id || body.clientOrderId || null;
  const statusRaw = body.status || body.event || body.state || null;

  log.info({ clientOrderId, status: statusRaw, body }, 'prorouting webhook received');

  if (!clientOrderId || !statusRaw) {
    log.warn({ clientOrderId, status: statusRaw }, 'missing client_order_id or status — nothing to do');
    return;
  }

  try {
    const order = await col('orders').findOne({ _id: clientOrderId });
    if (!order) {
      log.warn({ clientOrderId }, 'prorouting webhook: order not found');
      return;
    }
    await applyProroutingState(order, statusRaw, body);
  } catch (err) {
    log.error({ err: err?.message, stack: err?.stack, clientOrderId, status: statusRaw }, 'prorouting webhook handler failed');
  }
});

module.exports = router;
