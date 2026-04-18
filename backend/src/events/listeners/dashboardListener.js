'use strict';

// Listener: order.created → dashboard real-time update.
// Delegates to services/websocket.js which already handles the EC2 (local
// WebSocket) vs. Vercel (Lambda fallback) split. When no transport is
// configured the broadcast is a silent no-op and the event is just logged —
// the pipeline still works, the dashboard simply won't update live.

const log = require('../../utils/logger').child({ component: 'dashboard-listener' });

function onOrderCreated(payload) {
  const { orderId, restaurantId } = payload;
  try {
    const ws = require('../../services/websocket');
    ws.broadcastOrder(restaurantId, 'order.created', {
      orderId: payload.orderId,
      orderNumber: payload._order?.order_number,
      customerPhone: payload.customerPhone,
      items: payload.items,
      total: payload.total,
      createdAt: new Date().toISOString(),
    });
    log.info({ orderId, restaurantId }, 'Dashboard broadcast dispatched');
  } catch (err) {
    log.error({ orderId, err: err.message }, 'Dashboard broadcast failed');
  }
}

module.exports = { onOrderCreated };
