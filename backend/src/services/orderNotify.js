// src/services/orderNotify.js
// Sends WhatsApp template messages for order lifecycle events
// Fire-and-forget — failures must NEVER break order flow
// Deduplicates via order_notifications collection

const { col, newId } = require('../config/database');
const templateSvc = require('./template');
const { resolveRecipient } = require('./customerIdentity');
const { logActivity } = require('./activityLog');
const log = require('../utils/logger').child({ component: 'OrderNotify' });

// Map order status → event name used in template_mappings.
// Fault statuses (REJECTED_BY_RESTAURANT, RESTAURANT_TIMEOUT,
// NO_DELIVERY_AVAILABLE) reuse the `order_cancelled` template — the
// caller writes order.cancellation_reason with the spec-defined reason
// text before invoking sendOrderTemplateMessage so {{3}} resolves
// correctly (template variable maps to order.cancellation_reason via
// predefined-templates.js).
const STATUS_TO_EVENT = {
  PAID:       'payment_received',
  CONFIRMED:  'order_confirmed',
  PREPARING:  'order_preparing',
  PACKED:     'order_packed',
  DISPATCHED: 'order_dispatched',
  DELIVERED:  'order_delivered',
  CANCELLED:  'order_cancelled',
  REJECTED_BY_RESTAURANT: 'order_cancelled',
  RESTAURANT_TIMEOUT:     'order_cancelled',
  NO_DELIVERY_AVAILABLE:  'order_cancelled',
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
      // Override `order_number` with the per-restaurant display id so
      // every template variable that maps to {{order.order_number}}
      // (predefined-templates.js: order_confirmed, order_packed,
      // order_dispatched, order_delivered, order_cancelled,
      // refund_processed, etc.) automatically renders the
      // ABBR-MMDD-NNN form. Falls back to the legacy ZM-YYYYMMDD-NNNN
      // when display_order_id wasn't written (pre-deploy orders, or
      // orders where restaurantId wasn't resolvable at creation).
      order_number: fullOrder.display_order_id || fullOrder.order_number,
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

// ─── SEND REFUND PROCESSED MESSAGE ──────────────────────────
// Standalone event (not status-bound) that fires after a refund has been
// initiated for a fault cancellation. Uses the existing `refund_processed`
// template (predefined-templates.js: id 'refund_processed', variables:
// {{1}}=customer name, {{2}}=refund amount in rupees, {{3}}=order number).
// Caller writes order.refund_amount_rs onto the order doc first so the
// template variable resolves correctly.
//
// Returns true if the template was sent, false on dedup/skip/failure.
// Fire-and-forget — never throws.
const sendRefundProcessedMessage = async (orderId, orderContext = null) => {
  const event = 'refund_processed';
  try {
    const existing = await col('order_notifications').findOne({
      order_id: orderId, event, status: 'sent',
    });
    if (existing) {
      log.info({ event, orderId }, 'refund_processed already sent, skipping');
      return false;
    }

    const context = orderContext || await buildOrderContext(orderId);
    if (!context) {
      log.warn({ orderId }, 'refund_processed: could not build context');
      return false;
    }

    const toIdentifier = context.order.wa_phone || context.order.bsuid;
    if (!context.order.phone_number_id || !toIdentifier) {
      log.warn({ orderId }, 'refund_processed: missing WA details');
      return false;
    }

    const mapping = await templateSvc.getMappingForEvent(event);
    if (!mapping || !mapping.is_active) {
      log.info({ event }, 'refund_processed: no active mapping, skipping template');
      return false;
    }

    const componentParams = templateSvc.resolveTemplateVariables(mapping.variables, context);

    let sent = false;
    try {
      await templateSvc.sendTemplateMessage(
        context.order.phone_number_id,
        toIdentifier,
        mapping.template_name,
        'en',
        componentParams,
      );
      sent = true;
      logActivity({ actorType: 'system', action: 'notification.template_sent', category: 'notification', description: `Template "${mapping.template_name}" sent for order ${orderId} (${event})`, resourceType: 'order', resourceId: orderId, severity: 'info' });
    } catch (err) {
      const metaErr = err.response?.data?.error;
      log.error({ err, event, orderId }, 'refund_processed: template send failed');
      logActivity({ actorType: 'system', action: 'notification.template_failed', category: 'notification', description: `Template send failed for order ${orderId} (${event}): ${metaErr?.message || err.message}`, resourceType: 'order', resourceId: orderId, severity: 'error', metadata: { error: metaErr?.message || err.message } });
    }

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
    log.error({ err, event, orderId }, 'refund_processed notification error');
    return false;
  }
};

module.exports = {
  sendOrderTemplateMessage,
  sendRefundProcessedMessage,
  buildOrderContext,
  STATUS_TO_EVENT,
};
