'use strict';

// Notification listener: restaurant-manager-facing alerts via notify.js.
// This is the single place that fans out manager alerts — routes and
// webhooks should NOT call notify.* directly anymore; they emit events
// and this listener picks them up.

const log = require('../../utils/logger').child({ component: 'notification-listener' });
const notify = require('../../services/notify');

async function onOrderCreated(payload) {
  const { orderId, _order } = payload;
  const started = Date.now();
  try {
    if (!_order) {
      log.warn({ orderId }, 'No _order in payload — skipping new-order alert');
      return;
    }
    await notify.notifyNewOrder(_order);
    log.info({ orderId, ms: Date.now() - started }, 'New-order alert sent');
  } catch (err) {
    log.error({ orderId, err: err.message, ms: Date.now() - started }, 'New-order alert failed');
  }
}

async function onOrderUpdated(payload) {
  const { orderId, oldStatus, newStatus, _order } = payload;
  const started = Date.now();
  try {
    if (!_order) {
      log.warn({ orderId }, 'No _order in payload — skipping status-change alert');
      return;
    }
    await notify.notifyOrderStatusChange(_order, oldStatus || '', newStatus);
    log.info({ orderId, oldStatus, newStatus, ms: Date.now() - started }, 'Status-change alert sent');
  } catch (err) {
    log.error({ orderId, err: err.message, ms: Date.now() - started }, 'Status-change alert failed');
  }
}

module.exports = { onOrderCreated, onOrderUpdated };
