'use strict';

// Bridges the in-process event bus to the BullMQ orders queue.
// Require this ONCE from ec2-server.js — NEVER from the Vercel server.
// ElastiCache lives in a private VPC subnet, so attempting to enqueue
// from Vercel would time out. Orders created on the Vercel side still
// fire synchronous listeners (whatsappListener, notificationListener,
// analyticsListener); they just don't go through the async worker.

const bus = require('../events');
const { addProcessOrder } = require('./orderQueue');
const log = require('../utils/logger').child({ component: 'orderProducer' });

function register() {
  if (global.__orderProducerBooted) return;
  bus.on('order.created', async (payload) => {
    const { orderId, restaurantId } = payload || {};
    if (!orderId) return;
    try {
      const job = await addProcessOrder({ orderId, restaurantId });
      log.info({ orderId, jobId: job.id }, 'Order enqueued');
    } catch (err) {
      log.error({ orderId, err: err.message }, 'Order enqueue failed');
    }
  });
  global.__orderProducerBooted = true;
  log.info('Order producer registered on event bus');
}

module.exports = { register };
