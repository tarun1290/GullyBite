'use strict';

// WhatsApp listener: customer-facing WhatsApp messaging only. Restaurant
// manager alerts live in notificationListener. Keeping these two channels
// split keeps each listener's failure blast-radius small and makes BullMQ
// migration straightforward (each becomes its own queue/worker).

const log = require('../../utils/logger').child({ component: 'wa-listener' });
const { col } = require('../../config/database');

async function onOrderCreated(payload) {
  const { orderId, restaurantId, customerPhone, _order } = payload;
  const started = Date.now();
  try {
    if (!customerPhone || !_order?.order_number) {
      log.warn({ orderId }, 'Missing customerPhone or order_number — skipping confirmation');
      return;
    }
    const waAccount = await col('whatsapp_accounts').findOne({
      restaurant_id: restaurantId,
      is_active: true,
    });
    if (!waAccount?.phone_number_id || !waAccount?.access_token) {
      log.warn({ orderId, restaurantId }, 'No active whatsapp_account — skipping confirmation');
      return;
    }
    const wa = require('../../services/whatsapp');
    await wa.sendStatusUpdate(
      waAccount.phone_number_id,
      waAccount.access_token,
      customerPhone,
      'CONFIRMED',
      { orderNumber: _order.order_number }
    );
    log.info({ orderId, ms: Date.now() - started }, 'Customer confirmation sent');
  } catch (err) {
    log.error({ orderId, err: err.message, ms: Date.now() - started }, 'Customer confirmation failed');
  }
}

module.exports = { onOrderCreated };
