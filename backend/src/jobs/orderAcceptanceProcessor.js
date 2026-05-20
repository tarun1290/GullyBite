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
const { QUEUE_NAME, removeAcceptanceTimeoutJob } = require('./orderAcceptanceQueue');
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
    { projection: { _id: 1, status: 1, acknowledged_at: 1, order_number: 1, restaurant_id: 1 } },
  );
  if (!order) {
    log.warn({ orderId }, 'acceptance-timeout: order not found — likely stale job');
    return { skipped: true, reason: 'order not found' };
  }

  // Idempotency guard — fault handling fires only for orders still
  // in PAID with no acknowledged_at stamp. status !== 'PAID' means
  // accept/decline/cancel/refund already landed and the job is stale.
  // The acknowledged_at check closes the race with the acceptance
  // paths (services/orderAcceptance.applyOrderAcceptance): the CAS
  // there stamps acknowledged_at BEFORE the state transition, so an
  // in-flight acceptance is visible to this worker even while the doc
  // still reads PAID. Without this second condition the worker could
  // fire between the CAS and the transition, book a RESTAURANT_TIMEOUT
  // fault-fee, and refund a customer on an order the restaurant
  // actually accepted (the documented Petpooja race).
  if (order.status !== 'PAID' || order.acknowledged_at) {
    log.info(
      { orderId, status: order.status, hasAck: !!order.acknowledged_at },
      'acceptance-timeout: order already accepted or past PAID — no-op',
    );
    return { skipped: true, reason: order.acknowledged_at ? 'acknowledged' : `status=${order.status}` };
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

// Cancel the in-flight acceptance-timeout job for a given order. Used
// by the petpooja inbound callback when the POS confirms an order on
// the restaurant's behalf — without this, the worker would still fault
// the order at the timeout boundary.
//
// jobId is stamped on the order doc by orderStateEngine.js's PAID
// side-effect block (acceptance_timeout_job_id). Resolving via the
// order doc instead of computing jobId === orderId means a future
// scheme change (e.g. multiple in-flight timeout jobs, salted ids)
// works without touching this caller.
//
// Wrapped end-to-end so a Mongo blip or Redis hiccup never bubbles
// into the petpooja webhook's outer error handler. Worker's existing
// idempotency guard (status !== 'PAID' → no-op) is the backstop if
// the cancel itself fails.
async function cancelTimeoutJob(orderId) {
  try {
    if (!orderId) return { cancelled: false, reason: 'no orderId' };
    const order = await col('orders').findOne(
      { _id: orderId },
      { projection: { acceptance_timeout_job_id: 1 } },
    );
    const jobId = order?.acceptance_timeout_job_id;
    if (!jobId) return { cancelled: false, reason: 'no acceptance_timeout_job_id on order' };
    return await removeAcceptanceTimeoutJob(jobId);
  } catch (err) {
    log.warn({ err: err.message, orderId }, 'cancelTimeoutJob failed (swallowed)');
    return { cancelled: false, reason: err.message };
  }
}

module.exports = { start, stop, processAcceptanceTimeout, cancelTimeoutJob, QUEUE_NAME };
