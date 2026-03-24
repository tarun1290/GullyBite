// src/webhooks/delivery.js
// Receives status updates from 3PL delivery partners (Porter, Dunzo, etc.)
// Always returns 200 immediately, then processes asynchronously.

const express = require('express');
const router = express.Router();
const { col, newId } = require('../config/database');
const orderSvc = require('../services/order');
const wa = require('../services/whatsapp');
const notify = require('../services/notify');
const orderNotify = require('../services/orderNotify');
const { resolveRecipient } = require('../services/customerIdentity');
const { logActivity } = require('../services/activityLog');

// POST /webhooks/delivery — 3PL status updates
router.post('/', express.json(), async (req, res) => {
  // Always respond 200 immediately (3PL expects fast response)
  res.sendStatus(200);

  try {
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

    // Extract task ID and status — adapt to provider's webhook format
    const taskId = payload.order_id || payload.task_id || payload.request_id;
    const newStatus = normalizeStatus(payload.status || payload.event_type);

    if (!taskId) {
      console.warn('[3PL Webhook] No task ID in payload');
      return;
    }

    // Find the delivery record
    const delivery = await col('deliveries').findOne({ provider_order_id: taskId });
    if (!delivery) {
      console.warn(`[3PL Webhook] No delivery found for task: ${taskId}`);
      return;
    }

    // Update delivery record
    const $set = {
      status: newStatus,
      updated_at: new Date(),
    };

    if (payload.driver_name || payload.partner_name)  $set.driver_name  = payload.driver_name || payload.partner_name;
    if (payload.driver_phone || payload.partner_phone) $set.driver_phone = payload.driver_phone || payload.partner_phone;
    if (payload.driver_lat || payload.lat)             $set.driver_lat   = parseFloat(payload.driver_lat || payload.lat);
    if (payload.driver_lng || payload.lng)             $set.driver_lng   = parseFloat(payload.driver_lng || payload.lng);
    if (payload.tracking_url)                          $set.tracking_url = payload.tracking_url;
    if (payload.estimated_time)                        $set.estimated_mins = parseInt(payload.estimated_time, 10);
    if (newStatus === 'picked_up')                     $set.picked_up_at = new Date();
    if (newStatus === 'delivered')                     $set.delivered_at = new Date();

    await col('deliveries').updateOne({ _id: delivery._id }, { $set });

    // Map 3PL status → order status and notify customer
    const order = await col('orders').findOne({ _id: delivery.order_id });
    if (!order) return;

    const branch = await col('branches').findOne({ _id: order.branch_id });
    const customer = await col('customers').findOne({ _id: order.customer_id });
    const wa_acc = await col('whatsapp_accounts').findOne({ restaurant_id: branch?.restaurant_id, is_active: true });

    if (newStatus === 'assigned') {
      logActivity({ actorType: 'webhook', action: 'delivery.rider_assigned', category: 'delivery', description: `Rider assigned for order`, resourceType: 'delivery', resourceId: String(delivery._id), severity: 'info' });
    }

    if (newStatus === 'assigned' && $set.driver_name) {
      // Rider assigned — notify customer
      if (wa_acc && customer) {
        await wa.sendText(wa_acc.phone_number_id, wa_acc.access_token, resolveRecipient(customer),
          `🏍️ *Rider assigned!*\n\n` +
          `👤 ${$set.driver_name}\n` +
          `📞 ${$set.driver_phone || 'Contact via app'}\n` +
          ($set.tracking_url || delivery.tracking_url ? `📍 Track: ${$set.tracking_url || delivery.tracking_url}` : '')
        );
      }
    }

    if (newStatus === 'picked_up') {
      logActivity({ actorType: 'webhook', action: 'delivery.picked_up', category: 'delivery', description: `Order picked up by rider`, resourceType: 'delivery', resourceId: String(delivery._id), severity: 'info' });
      await orderSvc.updateStatus(delivery.order_id, 'DISPATCHED');
      // Try template, fall back to plain text
      const dispatched = await orderNotify.sendOrderTemplateMessage(delivery.order_id, 'DISPATCHED').catch(() => false);
      if (!dispatched && wa_acc && customer) {
        const eta = $set.estimated_mins || delivery.estimated_mins;
        await wa.sendText(wa_acc.phone_number_id, wa_acc.access_token, resolveRecipient(customer),
          `📦 *Your order has been picked up!*\n\n` +
          `🏍️ ${$set.driver_name || delivery.driver_name || 'Your rider'} is on the way.\n` +
          (eta ? `⏱ ETA: ~${eta} minutes\n` : '') +
          ($set.tracking_url || delivery.tracking_url ? `📍 Track: ${$set.tracking_url || delivery.tracking_url}` : '')
        );
      }
    }

    if (newStatus === 'delivered') {
      logActivity({ actorType: 'webhook', action: 'delivery.delivered', category: 'delivery', description: `Order delivered successfully`, resourceType: 'delivery', resourceId: String(delivery._id), severity: 'info' });
      await orderSvc.updateStatus(delivery.order_id, 'DELIVERED');
      // Try template for delivered notification
      orderNotify.sendOrderTemplateMessage(delivery.order_id, 'DELIVERED').catch(() => {});
      // DELIVERED handler in order service triggers rating request + loyalty points
    }

    if (newStatus === 'cancelled' || newStatus === 'failed') {
      logActivity({ actorType: 'webhook', action: 'delivery.failed', category: 'delivery', description: `Delivery failed/cancelled`, resourceType: 'delivery', resourceId: String(delivery._id), severity: 'error' });
      // 3PL cancelled/failed — notify manager, DON'T auto-cancel the order
      if (branch?.restaurant_id) {
        notify.sendManagerNotification(branch.restaurant_id, order.branch_id,
          `⚠️ *Delivery ${newStatus}* for Order #${order.order_number}\n` +
          `Reason: ${payload.reason || payload.cancellation_reason || 'Not specified'}\n` +
          `Please re-dispatch or contact customer.`
        ).catch(() => {});
      }
    }

    // Mark webhook as processed
    await col('webhook_logs').updateOne(
      { source: '3pl', 'payload.order_id': taskId, processed: false },
      { $set: { processed: true, processed_at: new Date(), retry_status: 'success' } }
    );

  } catch (err) {
    console.error('[3PL Webhook] Error processing:', err.message);
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
