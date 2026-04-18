'use strict';

// BullMQ worker for the 'orders' queue. EC2-only — Vercel must NEVER
// import this file. The handler is idempotent: orders with a
// `queue_processed_at` timestamp are skipped so retries after partial
// failure don't re-notify the restaurant or double-touch the DB.
//
// BullMQ retries are governed by the queue's defaultJobOptions
// (3 attempts, exponential backoff). Permanent failures are also
// mirrored into the existing `failed_jobs` collection so ops dashboards
// that already surface that collection pick them up without changes.

const { Worker } = require('bullmq');
const connection = require('../queue/redis');
const { col, newId } = require('../config/database');
const log = require('../utils/logger').child({ component: 'orderWorker' });

const QUEUE_NAME = 'orders';

async function processOrder(job) {
  const { orderId, restaurantId } = job.data || {};
  log.info({ jobId: job.id, orderId, attempt: job.attemptsMade + 1 }, 'Processing order');

  const order = await col('orders').findOne({ _id: orderId });
  if (!order) throw new Error(`Order ${orderId} not found`);

  if (order.queue_processed_at) {
    log.info({ orderId }, 'Order already processed — skipping (idempotent)');
    return { skipped: true };
  }

  // Send restaurant-manager WhatsApp alert.
  const notify = require('../services/notify');
  await notify.notifyNewOrder(order);

  // Update DB: atomic stamp + compound-and check so concurrent workers
  // (if we ever scale concurrency) don't double-process.
  const stamp = await col('orders').updateOne(
    { _id: orderId, queue_processed_at: { $exists: false } },
    { $set: { queue_processed_at: new Date() } }
  );
  if (stamp.modifiedCount === 0) {
    log.info({ orderId }, 'Another worker already stamped — no-op');
    return { raced: true };
  }

  log.info({ orderId, restaurantId }, 'Order processed successfully');
  return { success: true };
}

let _worker = null;

function start() {
  if (_worker) return _worker;

  _worker = new Worker(QUEUE_NAME, processOrder, {
    connection,
    concurrency: 5,
  });

  _worker.on('completed', (job, result) => {
    log.info({ jobId: job.id, orderId: job.data?.orderId, result }, 'Job completed');
  });

  _worker.on('failed', (job, err) => {
    const exhausted = job && job.attemptsMade >= (job.opts?.attempts || 1);
    log.error(
      { jobId: job?.id, orderId: job?.data?.orderId, attempt: job?.attemptsMade, exhausted, err: err.message },
      'Job failed'
    );

    // Mirror terminal failures into failed_jobs for ops visibility.
    if (exhausted && job?.data?.orderId) {
      col('failed_jobs').insertOne({
        _id: newId(),
        source: 'orderWorker',
        job_id: String(job.id),
        order_id: job.data.orderId,
        attempts: job.attemptsMade,
        last_error: { message: err.message, at: new Date() },
        failed_at: new Date(),
      }).catch((e) => log.warn({ err: e.message }, 'failed_jobs mirror insert failed'));
    }
  });

  _worker.on('error', (err) => {
    log.error({ err: err.message }, 'Worker runtime error');
  });

  log.info({ queue: QUEUE_NAME, concurrency: 5 }, 'Order worker started');
  return _worker;
}

async function stop() {
  if (_worker) {
    await _worker.close();
    _worker = null;
    log.info('Order worker stopped');
  }
}

module.exports = { start, stop, processOrder, QUEUE_NAME };
