// src/jobs/orderAcceptanceQueue.js
//
// BullMQ producer for the `order-acceptance` queue. One job per PAID
// order, fired with `delayMs` = ORDER_ACCEPTANCE_TIMEOUT_MS (default
// 4 minutes). The processor (orderAcceptanceProcessor.js) checks the
// order's status when the job fires and only takes action if it's still
// PAID — which means the restaurant never accepted in time.
//
// The accept and reject endpoints both cancel the job by calling
// removeAcceptanceTimeoutJob(jobId) so a customer accepted-then-rejected
// race doesn't double-fire the timeout.
//
// Connection reuses the shared ioredis instance from queue/redis.js —
// see the comment block there about ElastiCache + maxRetriesPerRequest.

'use strict';

const { Queue } = require('bullmq');
const connection = require('../queue/redis');
const log = require('../utils/logger').child({ component: 'orderAcceptanceQueue' });

const QUEUE_NAME = 'order-acceptance';

const DEFAULT_TIMEOUT_MS = 240_000; // 4 minutes
function getTimeoutMs() {
  const env = parseInt(process.env.ORDER_ACCEPTANCE_TIMEOUT_MS || '', 10);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_TIMEOUT_MS;
}

const orderAcceptanceQueue = new Queue(QUEUE_NAME, {
  connection,
  prefix: '{bull}',
  defaultJobOptions: {
    // Single shot — we don't want a transient Mongo blip to fire the
    // timeout twice. The processor itself is idempotent (status guard)
    // so attempts: 2 would be safe, but 1 keeps the semantics simple.
    attempts: 1,
    removeOnComplete: { age: 60 * 60 * 24, count: 2000 },
    removeOnFail: { age: 60 * 60 * 24 * 7 },
  },
});

orderAcceptanceQueue.on('error', (err) => log.error({ err: err.message }, 'orderAcceptanceQueue error'));

/**
 * Schedule the acceptance timeout job for an order.
 * @param {string} orderId
 * @param {number} [delayMs] — overrides the env/default timeout
 * @returns {Promise<{ jobId: string }>}
 */
async function addAcceptanceTimeoutJob(orderId, delayMs) {
  if (!orderId) throw new Error('addAcceptanceTimeoutJob: orderId required');
  const delay = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : getTimeoutMs();
  // jobId = orderId so a duplicate enqueue (Razorpay webhook + checkout
  // webhook both firing for the same order) collapses into one job.
  const job = await orderAcceptanceQueue.add(
    'acceptance-timeout',
    { orderId: String(orderId) },
    { jobId: String(orderId), delay },
  );
  log.info({ orderId, jobId: job.id, delayMs: delay }, 'acceptance timeout scheduled');
  return { jobId: job.id };
}

/**
 * Cancel a scheduled timeout job. Safe to call when the job no longer
 * exists (already fired, already removed) — BullMQ returns null in that
 * case and we swallow it.
 * @param {string} jobId
 */
async function removeAcceptanceTimeoutJob(jobId) {
  if (!jobId) return { removed: false, reason: 'no jobId' };
  try {
    const job = await orderAcceptanceQueue.getJob(String(jobId));
    if (!job) return { removed: false, reason: 'not found' };
    await job.remove();
    log.info({ jobId }, 'acceptance timeout cancelled');
    return { removed: true };
  } catch (err) {
    log.warn({ err: err.message, jobId }, 'removeAcceptanceTimeoutJob failed (non-fatal)');
    return { removed: false, reason: err.message };
  }
}

module.exports = {
  orderAcceptanceQueue,
  addAcceptanceTimeoutJob,
  removeAcceptanceTimeoutJob,
  QUEUE_NAME,
  getTimeoutMs,
};
