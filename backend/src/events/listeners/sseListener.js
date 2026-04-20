'use strict';

// SSE listener — fire-and-forget fan-out of order.created to connected
// staff tablets. Fires off the event bus so the order creation path
// itself never awaits or blocks on SSE delivery.

const log = require('../../utils/logger').child({ component: 'sse-listener' });
const sse = require('../../services/sseConnections');
const expoPush = require('../../services/expoPush');
const { col } = require('../../config/database');

function _pickCustomerName(order) {
  return order?._customer?.name || order?.customer_name || order?.receiver_name || 'Customer';
}

function _maskedPhone(order) {
  const phone = order?._customer?.wa_phone || order?.customer_phone || order?.receiver_phone;
  if (!phone) return 'Hidden';
  try {
    const { maskPhone } = require('../../utils/maskPhone');
    return maskPhone(phone);
  } catch { return 'Hidden'; }
}

function onOrderCreated(payload) {
  try {
    const { restaurantId, orderId, _order } = payload || {};
    if (!restaurantId) return;
    const o = _order || {};
    const orderNumber = o.order_number || null;
    const totalRs = o.total_rs ?? payload?.total ?? null;

    sse.pushOrderToRestaurant(restaurantId, {
      id: String(o._id || orderId || ''),
      order_number: orderNumber,
      customer_name: _pickCustomerName(o),
      customer_phone_masked: _maskedPhone(o),
      total_rs: totalRs,
      status: o.status || 'PENDING_PAYMENT',
      payment_status: o.payment_status || null,
      created_at: o.created_at || new Date().toISOString(),
      items: Array.isArray(o.items) ? o.items : (payload?.items || []),
      event_type: 'new_order',
    });

    // Fire-and-forget Expo push to any registered staff tablets.
    // Event listeners already run outside the response path; still
    // detach with setImmediate + .catch() so errors can't propagate up.
    setImmediate(async () => {
      try {
        const r = await col('restaurants').findOne(
          { _id: restaurantId },
          { projection: { push_tokens: 1 } }
        );
        const tokens = (r?.push_tokens || []).map(e => e?.token).filter(Boolean);
        if (!tokens.length) return;
        const totalLabel = totalRs != null ? `₹${totalRs}` : '';
        expoPush.sendPush(tokens, {
          title: 'New Order!',
          body: `Order #${orderNumber || ''} just came in${totalLabel ? ` — ${totalLabel}` : ''}`,
          data: { type: 'new_order', order_id: String(o._id || orderId || '') },
        }).catch(() => {});
      } catch (err) {
        log.warn({ err: err.message }, 'expo push on order.created failed');
      }
    });
  } catch (err) {
    log.warn({ err: err.message }, 'SSE push on order.created failed');
  }
}

module.exports = { onOrderCreated };
