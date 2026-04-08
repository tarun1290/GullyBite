// src/services/orderNotify.js
// Sends WhatsApp template messages for order lifecycle events
// Fire-and-forget — failures must NEVER break order flow
// Deduplicates via order_notifications collection

const { col, newId } = require('../config/database');
const templateSvc = require('./template');
const { resolveRecipient } = require('./customerIdentity');
const { logActivity } = require('./activityLog');
const log = require('../utils/logger').child({ component: 'OrderNotify' });

// Map order status → event name used in template_mappings
const STATUS_TO_EVENT = {
  PAID:       'payment_received',
  CONFIRMED:  'order_confirmed',
  PREPARING:  'order_preparing',
  PACKED:     'order_packed',
  DISPATCHED: 'order_dispatched',
  DELIVERED:  'order_delivered',
  CANCELLED:  'order_cancelled',
};

// ─── SEND ORDER TEMPLATE MESSAGE ────────────────────────────
// Main entry point — call this after any order status change
// Returns true if template sent, false if fell back to text or skipped
const sendOrderTemplateMessage = async (orderId, newStatus, orderContext = null) => {
  const event = STATUS_TO_EVENT[newStatus];
  if (!event) {
    log.warn({ status: newStatus }, 'No event mapping for status');
    return false;
  }

  try {
    // Dedup check — don't send same event twice for same order
    const existing = await col('order_notifications').findOne({
      order_id: orderId,
      event,
      status: 'sent',
    });
    if (existing) {
      log.info({ event, orderId }, 'Already sent, skipping');
      return false;
    }

    // Build context if not provided
    const context = orderContext || await buildOrderContext(orderId);
    if (!context) {
      log.warn({ orderId }, 'Could not build context');
      return false;
    }

    // [BSUID] Need phone_number_id and a reachable identifier to send
    const toIdentifier = context.order.wa_phone || context.order.bsuid;
    if (!context.order.phone_number_id || !toIdentifier) {
      log.warn({ orderId }, 'Missing WA details');
      return false;
    }

    // Get the template mapping for this event
    const mapping = await templateSvc.getMappingForEvent(event);
    if (!mapping || !mapping.is_active) {
      log.info({ event }, 'No active mapping, skipping template');
      return false;
    }

    // Resolve variables from context
    const componentParams = templateSvc.resolveTemplateVariables(mapping.variables, context);

    // Try sending template
    let sent = false;
    try {
      await templateSvc.sendTemplateMessage(
        context.order.phone_number_id,
        toIdentifier,
        mapping.template_name,
        'en',
        componentParams
      );
      sent = true;
      logActivity({ actorType: 'system', action: 'notification.template_sent', category: 'notification', description: `Template "${mapping.template_name}" sent for order ${orderId} (${event})`, resourceType: 'order', resourceId: orderId, severity: 'info' });
    } catch (err) {
      const metaErr = err.response?.data?.error;
      log.error({ err, event, orderId }, 'Template send failed');
      logActivity({ actorType: 'system', action: 'notification.template_failed', category: 'notification', description: `Template send failed for order ${orderId} (${event}): ${metaErr?.message || err.message}`, resourceType: 'order', resourceId: orderId, severity: 'error', metadata: { error: metaErr?.message || err.message } });
      // Don't record as sent — will fall back to text in caller
    }

    // Record in audit log
    await col('order_notifications').insertOne({
      _id: newId(),
      order_id: orderId,
      event,
      template_name: mapping.template_name,
      status: sent ? 'sent' : 'failed',
      error: sent ? null : 'Template send failed',
      sent_at: new Date(),
    });

    return sent;
  } catch (err) {
    log.error({ err, event, orderId }, 'Order notification error');
    return false;
  }
};

// ─── BUILD ORDER CONTEXT ────────────────────────────────────
// Assembles the full context object used for variable resolution
const buildOrderContext = async (orderId) => {
  const orderSvc = require('./order');
  const fullOrder = await orderSvc.getOrderDetails(orderId);
  if (!fullOrder) return null;

  // Get delivery info if exists
  const delivery = await col('deliveries').findOne({ order_id: orderId });

  // Get branch & restaurant
  const branch = fullOrder.branch_id
    ? await col('branches').findOne({ _id: fullOrder.branch_id })
    : null;

  return {
    order: {
      ...fullOrder,
      business_name: fullOrder.business_name || branch?.name || '',
    },
    delivery: delivery ? {
      driver_name: delivery.driver_name,
      driver_phone: delivery.driver_phone,
      tracking_url: delivery.tracking_url,
      estimated_mins: delivery.estimated_mins,
      status: delivery.status,
    } : {},
    branch: branch ? {
      name: branch.name,
      address: branch.address,
      phone: branch.manager_phone,
    } : {},
  };
};

module.exports = {
  sendOrderTemplateMessage,
  buildOrderContext,
  STATUS_TO_EVENT,
};
