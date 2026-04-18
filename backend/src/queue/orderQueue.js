'use strict';

// BullMQ Queue for orders. Producer-side only — workers live under
// backend/src/workers/. Default job options enforce the project-wide
// retry policy (3 attempts, exponential backoff) so callers don't have
// to pass them on every add().

const { Queue } = require('bullmq');
const connection = require('./redis');
const log = require('../utils/logger').child({ component: 'orderQueue' });

const QUEUE_NAME = 'orders';

const orderQueue = new Queue(QUEUE_NAME, {
  connection,
  prefix: '{bull}',
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 }, // 5s, 10s, 20s
    removeOnComplete: { age: 60 * 60 * 24, count: 1000 }, // keep 24h / 1k recent
    removeOnFail: { age: 60 * 60 * 24 * 7 },              // keep 7 days for forensics
  },
});

orderQueue.on('error', (err) => log.error({ err: err.message }, 'orderQueue error'));

// Idempotent enqueue: jobId = orderId means duplicate emits (retries,
// bus double-fires) collapse into a single job. BullMQ discards adds
// with an existing jobId while that job is in the queue.
async function addProcessOrder({ orderId, restaurantId }) {
  if (!orderId) throw new Error('addProcessOrder: orderId required');
  return orderQueue.add(
    'process-order',
    { orderId, restaurantId },
    { jobId: String(orderId) }
  );
}

module.exports = { orderQueue, addProcessOrder, QUEUE_NAME };
