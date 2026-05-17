// src/webhooks/petpoojaCallback.js
//
// Inbound Petpooja POS callback. The restaurant accepts / rejects the
// order in their Petpooja terminal and Petpooja POSTs us the result.
// We reflect the outcome back into our order state machine so the
// dashboard, customer notifications, and 3PL dispatch all advance
// without the operator clicking Accept twice.
//
// Mounted at /webhooks/petpooja/callback (mount in ec2-server.js is a
// separate change). On an AUTHENTICATED request it responds 200
// immediately then processes asynchronously — Petpooja retries on
// non-200, so processing failures must NOT propagate as HTTP errors.
// The one intentional exception is auth: an unauthenticated request is
// rejected with a real non-2xx (401/500) BEFORE the 200 ack, so a
// spoofed callback is never treated as accepted.
//
// Payload (per Petpooja docs):
//   { restID, orderID, status, cancel_reason,
//     minimum_prep_time, minimum_delivery_time,
//     rider_name, rider_phone_number, is_modified }
//
// status: '-1' = Cancelled, '1'|'2'|'3' = Accepted,
//         '4' = Dispatched, '5' = Food Ready, '10' = Delivered
//
// Inbound auth (now present — formerly absent): requests are
// authenticated by a shared secret. verifyPetpoojaAuth requires the
// raw Authorization header to equal PETPOOJA_CALLBACK_SECRET
// (constant-time compare, fail-closed if the secret is unset),
// enforced as the first statement in the handler before the 200 ack
// and any order-state-machine processing.

'use strict';

const express = require('express');
const router = express.Router();

const { col } = require('../config/database');
const orderStateEngine = require('../core/orderStateEngine');
const orderCancellationService = require('../services/orderCancellationService');
const log = require('../utils/logger').child({ component: 'PetpoojaCallback' });

// Inbound auth guard. Petpooja sends the shared secret as the raw
// Authorization header value (NO "Bearer " prefix). File-local by
// design — same logic/contract as petpoojaIntegration.js but this
// webhook has no {code,status,message} error contract of its own
// (it only ever emitted {received:true}), so reject with a real
// non-2xx status so Petpooja sees the failure and does not treat a
// spoofed call as accepted.
function verifyPetpoojaAuth(req, res) {
  const expected = process.env.PETPOOJA_CALLBACK_SECRET;
  const provided = req.headers['authorization'];

  if (!expected) {
    console.error('[petpooja] FATAL: PETPOOJA_CALLBACK_SECRET not set');
    res.status(500).json({ code: '500', status: 'failed', message: 'Server configuration error' });
    return false;
  }
  if (!provided) {
    res.status(401).json({ code: '401', status: 'failed', message: 'Unauthorized' });
    return false;
  }
  // Length guard BEFORE timingSafeEqual — it throws on length mismatch.
  if (Buffer.byteLength(provided) !== Buffer.byteLength(expected)) {
    res.status(401).json({ code: '401', status: 'failed', message: 'Unauthorized' });
    return false;
  }
  const crypto = require('crypto');
  if (!crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    res.status(401).json({ code: '401', status: 'failed', message: 'Unauthorized' });
    return false;
  }
  return true;
}

// Petpooja sends accept under one of three numeric codes depending on
// where in their UI flow the restaurant tapped Accept. Treat all three
// as a PAID → CONFIRMED transition.
const ACCEPTED_STATUSES = new Set(['1', '2', '3']);

// Already-terminal guard for the cancel path so a duplicate Petpooja
// retry can't move a long-closed order into REJECTED_BY_RESTAURANT.
const TERMINAL_STATES = new Set([
  'REJECTED_BY_RESTAURANT', 'RESTAURANT_TIMEOUT', 'CANCELLED', 'DELIVERED',
]);

router.post('/callback', express.json({ limit: '64kb' }), (req, res) => {
  // Inbound auth FIRST — before the 200 ack, before any order lookup
  // or state-machine call. A spoofed/unauthenticated call must get a
  // non-2xx rejection, never {received:true}.
  if (!verifyPetpoojaAuth(req, res)) return;

  // Respond 200 first so Petpooja never retries on a slow handler.
  res.json({ received: true });

  // Fire-and-forget audit row. webhook_logs is undeclared in
  // schemas/collections.js so no _id field is required — driver
  // generates an ObjectId automatically.
  try {
    col('webhook_logs').insertOne({
      source: 'petpooja',
      event_type: 'order_callback',
      payload: req.body,
      received_at: new Date(),
    }).catch(() => { /* swallow — logging failure must not bubble */ });
  } catch (_) { /* swallow — col() throws if Mongo not connected */ }

  setImmediate(async () => {
    try {
      const body = req.body || {};
      const orderID = body.orderID;
      const restID = body.restID;
      const cancelReason = body.cancel_reason;

      if (!orderID) {
        log.warn({ body }, 'petpooja callback: missing orderID');
        return;
      }

      // Petpooja's `orderID` echoes the `clientorderID` we sent on
      // /save_order — that's our human-readable order_number, NOT the
      // internal UUID _id. Same gotcha that bit the prorouting webhook.
      const order = await col('orders').findOne({ order_number: orderID });
      if (!order) {
        log.warn({ orderID, restID }, 'petpooja callback: order not found');
        return;
      }

      const statusStr = String(body.status ?? '').trim();
      log.info({
        orderId: order._id,
        orderNumber: orderID,
        petpooja_status: statusStr,
      }, 'petpooja callback received');

      // ─── ACCEPTED path (PAID → CONFIRMED) ──────────────────
      if (ACCEPTED_STATUSES.has(statusStr)) {
        if (order.status === 'CONFIRMED') {
          log.info({ orderId: order._id }, 'petpooja callback: already confirmed, skip');
          return;
        }
        if (order.status !== 'PAID') {
          log.warn(
            { orderId: order._id, currentStatus: order.status },
            'petpooja accepted but order not in PAID state',
          );
          return;
        }

        await orderStateEngine.transitionOrder(order._id, 'CONFIRMED', {
          actor: 'petpooja_pos',
          note: 'Accepted via Petpooja POS callback',
        });

        await col('orders').updateOne(
          { _id: order._id },
          { $set: {
              petpooja_accepted_at: new Date(),
              minimum_prep_time: body.minimum_prep_time || null,
              updated_at: new Date(),
            } },
        );

        // Cancel the in-flight acceptance-timeout BullMQ job so the
        // worker doesn't fault the order at the timeout boundary now
        // that the POS confirmed on the restaurant's behalf. Soft
        // dependency — if cancelTimeoutJob isn't exported yet, the
        // worker's idempotency guard (status !== 'PAID' → no-op) is
        // the backstop.
        try {
          const processor = require('../jobs/orderAcceptanceProcessor');
          if (typeof processor.cancelTimeoutJob === 'function') {
            await processor.cancelTimeoutJob(order._id);
          }
        } catch (err) {
          log.warn(
            { err: err?.message, orderId: order._id },
            'petpooja: cancelTimeoutJob failed (swallowed)',
          );
        }

        log.info({ orderId: order._id }, 'petpooja: order confirmed');
        return;
      }

      // ─── CANCELLED path (PAID → REJECTED_BY_RESTAURANT) ────
      if (statusStr === '-1') {
        if (TERMINAL_STATES.has(order.status)) {
          log.info(
            { orderId: order._id, currentStatus: order.status },
            'petpooja callback: already terminal, skip',
          );
          return;
        }
        if (order.status !== 'PAID') {
          log.warn(
            { orderId: order._id, currentStatus: order.status },
            'petpooja cancelled but order not in PAID state',
          );
          return;
        }

        await orderCancellationService.handleRestaurantFault(
          order._id,
          'rejected_by_restaurant',
        );

        log.info(
          { orderId: order._id, cancel_reason: cancelReason || null },
          'petpooja: order rejected',
        );
        return;
      }

      // ─── Lifecycle stamp (4 = Dispatched, 5 = Food Ready, 10 = Delivered) ─
      // Informational only — no state-machine transition. The Prorouting
      // webhook owns DISPATCHED / DELIVERED on our side; this column
      // surfaces the POS-side view alongside it for ops debugging.
      await col('orders').updateOne(
        { _id: order._id },
        { $set: {
            petpooja_pos_status: statusStr,
            updated_at: new Date(),
          } },
      );
      log.info(
        { orderId: order._id, petpooja_status: statusStr },
        'petpooja: lifecycle status stamped',
      );
    } catch (err) {
      log.error(
        {
          err: err?.message,
          stack: err?.stack,
          orderID: req.body?.orderID,
        },
        'petpooja callback handler failed',
      );
    }
  });
});

module.exports = router;
