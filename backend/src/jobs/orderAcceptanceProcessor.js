// src/jobs/orderAcceptanceProcessor.js
//
// BullMQ Worker for the `order-acceptance` queue. Fires when the
// acceptance window expires for a PAID order. The handler is idempotent:
// if the order has already moved past PAID (restaurant accepted, or
// some other terminal transition raced the worker), the job is a no-op.
//
// Real action: when status === 'PAID', delegate to
// orderCancellationService.handleRestaurantFault(orderId, 'restaurant_timeout')
// which transitions to RESTAURANT_TIMEOUT, refunds the customer, books
// the cancellation_fault_fee against the restaurant's settlement, and
// fires the customer WhatsApp notifications.
//
// Started from ec2-server.js alongside workers/orderWorker. EC2-only —
// Vercel must NEVER import this file (it would try to connect to a
// VPC-private ElastiCache instance and fail boot).

'use strict';

const { Worker } = require('bullmq');
const connection = require('../queue/redis');
const { col } = require('../config/database');
const { QUEUE_NAME } = require('./orderAcceptanceQueue');
const log = require('../utils/logger').child({ component: 'orderAcceptanceProcessor' });

let _worker = null;

async function processAcceptanceTimeout(job) {
  const { orderId } = job.data || {};
  if (!orderId) {
    log.warn({ jobId: job.id }, 'acceptance-timeout: missing orderId — discarding');
    return { skipped: true, reason: 'no orderId' };
  }

  const order = await col('orders').findOne(
    { _id: orderId },
    { projection: { _id: 1, status: 1, order_number: 1, restaurant_id: 1 } },
  );
  if (!order) {
    log.warn({ orderId }, 'acceptance-timeout: order not found — likely stale job');
    return { skipped: true, reason: 'order not found' };
  }

  // Idempotency guard — the only state that triggers fault handling is
  // PAID (restaurant never acted). Anything else means accept/decline/
  // cancel already happened and the job is stale.
  if (order.status !== 'PAID') {
    log.info({ orderId, status: order.status }, 'acceptance-timeout: order already past PAID — no-op');
    return { skipped: true, reason: `status=${order.status}` };
  }

  log.warn({ orderId, orderNumber: order.order_number, restaurantId: order.restaurant_id },
    'acceptance-timeout: restaurant did not respond — initiating fault refund');

  const cancellation = require('../services/orderCancellationService');
  await cancellation.handleRestaurantFault(orderId, 'restaurant_timeout');

  return { faulted: true };
}

function start() {
  if (_worker) return _worker;
  _worker = new Worker(QUEUE_NAME, processAcceptanceTimeout, {
    connection,
    prefix: '{bull}',
    concurrency: 4,
  });
  _worker.on('error', (err) => log.error({ err: err.message }, 'orderAcceptanceProcessor worker error'));
  _worker.on('failed', (job, err) => log.error({ jobId: job?.id, err: err.message }, 'acceptance-timeout job failed'));
  log.info({ queue: QUEUE_NAME }, 'orderAcceptanceProcessor started');
  return _worker;
}

async function stop() {
  if (_worker) {
    await _worker.close();
    _worker = null;
  }
}

module.exports = { start, stop, processAcceptanceTimeout, QUEUE_NAME };
