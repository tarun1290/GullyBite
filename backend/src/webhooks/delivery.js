// src/webhooks/delivery.js
// Receives status updates from 3PL delivery partners (Dunzo, Shadowfax, etc.)
// Always returns 200 immediately, then processes asynchronously.

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { col, newId, connect } = require('../config/database');
const { isWithinCSW } = require('../utils/csw');
const orderSvc = require('../services/order');
const wa = require('../services/whatsapp');
const orderNotify = require('../services/orderNotify');
const { resolveRecipient } = require('../services/customerIdentity');
const { logActivity } = require('../services/activityLog');
const ws = require('../services/websocket');
const log = require('../utils/logger').child({ component: 'delivery' });

// POST /webhooks/delivery — 3PL status updates
router.post('/', express.json({ limit: '256kb' }), async (req, res) => {
  // Always respond 200 immediately (3PL expects fast response)
  res.sendStatus(200);

  try {
    // Signature check is mandatory. If DELIVERY_WEBHOOK_SECRET is unset we
    // drop the payload — an unconfigured secret used to make this endpoint
    // effectively public.
    const secret = process.env.DELIVERY_WEBHOOK_SECRET;
    if (!secret) {
      req.log.error('DELIVERY_WEBHOOK_SECRET not configured — dropping webhook');
      return;
    }
    // Header-only — never read the secret from the query string (it would
    // leak into proxy/CDN/access logs). Both header forms providers may
    // already use are still honored.
    const authHeader = req.headers['x-webhook-secret'] || req.headers['authorization'] || '';
    // Normalize: accept either the raw secret or `Bearer <secret>`.
    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    // Constant-time compare. timingSafeEqual throws on length mismatch, so
    // length-check first (a mismatched length is itself an invalid secret).
    const ok = Buffer.byteLength(provided) === Buffer.byteLength(secret)
      && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
    if (!ok) {
      req.log.warn('Invalid webhook secret — dropping');
      return;
    }

    const payload = req.body;

    // Log to webhook_logs
    await col('webhook_logs').insertOne({
      _id: newId(),
      source: '3pl',
      event_type: payload.event || payload.status || 'status_update',
      payload,
      processed: false,
      retry_count: 0,
      retry_status: 'none',
      received_at: new Date(),
    });
    ws.broadcastToAdmin('webhook_received', { source: '3pl', eventType: payload.event || payload.status || 'status_update' });

    // Extract task ID and status — adapt to provider's webhook format
    const taskId = payload.order_id || payload.task_id || payload.request_id;
    const newStatus = normalizeStatus(payload.status || payload.event_type);

    if (!taskId) {
      req.log.warn('No task ID in payload');
      return;
    }

    // Idempotency: deduplicate by taskId + normalized status
    const { once } = require('../utils/idempotency');
    const isNew = await once('delivery', `${taskId}:${newStatus}`, { taskId, status: newStatus });
    if (!isNew) return;

    // Find the delivery record
    const delivery = await col('deliveries').findOne({ provider_order_id: taskId });
    if (!delivery) {
      req.log.warn({ taskId }, 'No delivery found for task');
      return;
    }

    // Update delivery record
    const $set = {
      status: newStatus,
      updated_at: new Date(),
    };

    if (payload.driver_name || payload.partner_name)  $set.driver_name  = payload.driver_name || payload.partner_name;
    if (payload.driver_phone || payload.partner_phone) $set.driver_phone = payload.driver_phone || payload.partner_phone;

    // driver_lat / driver_lng come straight from the (attacker-controllable)
    // 3PL webhook payload. parseFloat happily yields NaN for garbage and
    // doesn't range-check, which would poison the delivery doc / live map.
    // Validate BOTH together: a lone valid coordinate is meaningless on a
    // map, so if either is bad we drop both. These fields are non-essential
    // (the doc + downstream broadcast/notifications are valid without them),
    // so we SKIP the field and keep processing the status transition rather
    // than rejecting an otherwise-legitimate webhook.
    const rawLat = payload.driver_lat || payload.lat;
    const rawLng = payload.driver_lng || payload.lng;
    if (rawLat != null || rawLng != null) {
      const lat = parseFloat(rawLat);
      const lng = parseFloat(rawLng);
      const latOk = Number.isFinite(lat) && lat >= -90 && lat <= 90;
      const lngOk = Number.isFinite(lng) && lng >= -180 && lng <= 180;
      if (rawLat != null && rawLng != null && latOk && lngOk) {
        $set.driver_lat = lat;
        $set.driver_lng = lng;
      } else {
        req.log.warn(
          { taskId, field: 'driver_lat/driver_lng', rawLat, rawLng },
          'Invalid driver coordinates in delivery webhook — skipping lat/lng',
        );
      }
    }

    if (payload.tracking_url)                          $set.tracking_url = payload.tracking_url;

    // estimated_time is attacker-controllable too. parseInt → NaN for
    // garbage and no upper bound. estimated_mins is purely informational
    // (tracking ETA / broadcast), so on a bad value we SKIP the field and
    // keep processing rather than rejecting the webhook.
    // Bound: 0 .. 1440 minutes (24h) — any 3PL ETA beyond a day is bogus.
    if (payload.estimated_time != null) {
      const estMins = parseInt(payload.estimated_time, 10);
      if (Number.isFinite(estMins) && estMins >= 0 && estMins <= 1440) {
        $set.estimated_mins = estMins;
      } else {
        req.log.warn(
          { taskId, field: 'estimated_time', rawEstimatedTime: payload.estimated_time },
          'Invalid estimated_time in delivery webhook — skipping estimated_mins',
        );
      }
    }
    if (newStatus === 'picked_up')                     $set.picked_up_at = new Date();
    if (newStatus === 'delivered')                     $set.delivered_at = new Date();

    await col('deliveries').updateOne({ _id: delivery._id }, { $set });

    // Broadcast delivery update
    const restId = delivery.restaurant_id || (await col('orders').findOne({ _id: delivery.order_id }, { projection: { restaurant_id: 1 } }))?.restaurant_id;
    if (restId) ws.broadcastOrder(restId, 'delivery_update', { orderId: String(delivery.order_id), status: newStatus, driverName: $set.driver_name, driverPhone: $set.driver_phone, trackingUrl: $set.tracking_url, estimatedMins: $set.estimated_mins });

    // Map 3PL status → order status and notify customer
    const order = await col('orders').findOne({ _id: delivery.order_id });
    if (!order) return;

    const branch = await col('branches').findOne({ _id: order.branch_id });
    const customer = await col('customers').findOne({ _id: order.customer_id });
    const wa_acc = await col('whatsapp_accounts').findOne({ restaurant_id: branch?.restaurant_id, is_active: true });

    if (newStatus === 'assigned') {
      logActivity({ actorType: 'webhook', action: 'delivery.rider_assigned', category: 'delivery', description: `Rider assigned for order`, resourceType: 'delivery', resourceId: String(delivery._id), severity: 'info' });
    }

    const db = await connect();

    if (newStatus === 'assigned' && $set.driver_name) {
      // Rider assigned — notify customer
      if (wa_acc && customer) {
        if (!(await isWithinCSW(order.customer_id, db))) {
          log.info({ event: 'delivery_update_csw_blocked', orderId: delivery.order_id, deliveryStatus: newStatus }, 'rider-assigned notification skipped — outside CSW');
        } else {
          await wa.sendText(wa_acc.phone_number_id, wa_acc.access_token, resolveRecipient(customer),
            `🏍️ *Rider assigned!*\n\n` +
            `👤 ${$set.driver_name}\n` +
            `📞 ${$set.driver_phone || 'Contact via app'}\n` +
            ($set.tracking_url || delivery.tracking_url ? `📍 Track: ${$set.tracking_url || delivery.tracking_url}` : '')
          );
        }
      }
    }

    if (newStatus === 'picked_up') {
      logActivity({ actorType: 'webhook', action: 'delivery.picked_up', category: 'delivery', description: `Order picked up by rider`, resourceType: 'delivery', resourceId: String(delivery._id), severity: 'info' });
      await orderSvc.updateStatus(delivery.order_id, 'DISPATCHED');
      // Customer notification — canonical lifecycle copy from
      // STATUS_MESSAGES.DISPATCHED in services/whatsapp.js. The map
      // already guards trackingUrl via `${trackingUrl ? \`Track: ${trackingUrl}\` : ''}`,
      // so passing null when no URL is present renders cleanly.
      if (wa_acc && customer) {
        if (!(await isWithinCSW(order.customer_id, db))) {
          log.info({ event: 'delivery_update_csw_blocked', orderId: delivery.order_id, deliveryStatus: newStatus }, 'DISPATCHED sendStatusUpdate skipped — outside CSW');
        } else {
          const trackingUrl = $set.tracking_url || delivery.tracking_url || null;
          try {
            await wa.sendStatusUpdate(
              wa_acc.phone_number_id, wa_acc.access_token, resolveRecipient(customer),
              'DISPATCHED',
              { orderNumber: order.order_number, trackingUrl },
            );
          } catch (e) {
            log.warn({ err: e?.message, orderId: delivery.order_id }, 'DISPATCHED sendStatusUpdate failed');
          }
        }
      }
    }

    if (newStatus === 'delivered') {
      logActivity({ actorType: 'webhook', action: 'delivery.delivered', category: 'delivery', description: `Order delivered successfully`, resourceType: 'delivery', resourceId: String(delivery._id), severity: 'info' });
      await orderSvc.updateStatus(delivery.order_id, 'DELIVERED');
      // Customer notification — STATUS_MESSAGES.DELIVERED renders
      // "✅ Order #{n} delivered. Enjoy your meal! 🍽️" (added 2026-05-09).
      // Fire-and-forget; rating request + loyalty points are queued by
      // the DELIVERED transition inside orderSvc.updateStatus above.
      if (wa_acc && customer) {
        if (!(await isWithinCSW(order.customer_id, db))) {
          log.info({ event: 'delivery_update_csw_blocked', orderId: delivery.order_id, deliveryStatus: newStatus }, 'DELIVERED sendStatusUpdate skipped — outside CSW');
        } else {
          wa.sendStatusUpdate(
            wa_acc.phone_number_id, wa_acc.access_token, resolveRecipient(customer),
            'DELIVERED',
            { orderNumber: order.order_number },
          ).catch((e) => {
            log.warn({ err: e?.message, orderId: delivery.order_id }, 'DELIVERED sendStatusUpdate failed');
          });
        }
      }
    }

    if (newStatus === 'cancelled' || newStatus === 'failed') {
      logActivity({ actorType: 'webhook', action: 'delivery.failed', category: 'delivery', description: `Delivery failed/cancelled`, resourceType: 'delivery', resourceId: String(delivery._id), severity: 'error' });
      // 3PL cancelled/failed — order is NOT auto-cancelled here (kept as a
      // surfaced-to-dashboard fault so the restaurant can re-dispatch or
      // reach out to the customer). Manager WhatsApp alerts removed.
    }

    // Mark webhook as processed
    await col('webhook_logs').updateOne(
      { source: '3pl', 'payload.order_id': taskId, processed: false },
      { $set: { processed: true, processed_at: new Date(), retry_status: 'success' } }
    );

  } catch (err) {
    req.log.error({ err }, 'Error processing delivery webhook');
    logActivity({ actorType: 'webhook', action: 'delivery.dispatch_failed', category: 'delivery', description: `Delivery webhook error: ${err.message}`, severity: 'error', metadata: { error: err.message } });
  }
});

// ─── NORMALIZE STATUS ────────────────────────────────────────────
function normalizeStatus(raw) {
  const s = (raw || '').toLowerCase().replace(/[^a-z_]/g, '');
  const map = {
    'assigned': 'assigned', 'allotted': 'assigned', 'accepted': 'assigned',
    'arrived_for_pickup': 'assigned', 'reached_pickup': 'assigned',
    'picked_up': 'picked_up', 'pickedup': 'picked_up', 'in_transit': 'picked_up',
    'out_for_delivery': 'picked_up', 'started': 'picked_up',
    'delivered': 'delivered', 'completed': 'delivered', 'dropped': 'delivered',
    'cancelled': 'cancelled', 'canceled': 'cancelled', 'rejected': 'cancelled',
    'failed': 'failed', 'rto': 'failed', 'returned': 'failed',
  };
  return map[s] || 'assigned';
}

module.exports = router;
