// src/queue/messageQueue.js
// MongoDB-backed job queue for outbound WhatsApp messages.
//
// Why Mongo (and not Redis/BullMQ): this codebase already has MongoDB
// as its primary store and no Redis dependency is required for core
// flows. Keeping the queue in Mongo avoids adding an external broker
// for a single producer/consumer pattern. If throughput outgrows this,
// swap the storage layer — the public API (enqueue/startWorker) is
// stable and narrow.
//
// Collections:
//   message_jobs   — pending / in-flight / succeeded jobs
//   failed_jobs    — terminal failures after MAX_ATTEMPTS
//
// Semantics:
//   • enqueue  → insert { status: 'pending', attempts: 0, next_attempt_at: now }
//   • worker   → atomically claim (findOneAndUpdate) status=pending with
//                next_attempt_at <= now → status='processing'
//   • on success → status='done'
//   • on failure → attempts+=1; if under MAX_ATTEMPTS, reschedule with
//                  exponential backoff; else mark failed + copy into
//                  failed_jobs for ops visibility.

'use strict';

const { col, newId } = require('../config/database');
const log = require('../utils/logger').child({ component: 'messageQueue' });

const JOB_NAME = 'send_message';
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 5_000;    // 5s, 20s, 80s … (4^n)
const POLL_INTERVAL_MS = 1_000;
const CLAIM_LEASE_MS = 60_000;    // processing rows older than this are re-claimable

// ─── INDEXES ──────────────────────────────────────────────────
// Ensure on first import. Idempotent — safe under hot reload.
let _indexesEnsured = false;
async function ensureIndexes() {
  if (_indexesEnsured) return;
  try {
    await col('message_jobs').createIndex({ status: 1, next_attempt_at: 1 }, { background: true });
    await col('message_jobs').createIndex({ name: 1, status: 1 }, { background: true });
    await col('message_jobs').createIndex({ created_at: -1 }, { background: true });
    await col('failed_jobs').createIndex({ name: 1, failed_at: -1 }, { background: true });
    _indexesEnsured = true;
  } catch (err) {
    log.warn({ err }, 'ensureIndexes failed — worker may still function, queries will be slow');
  }
}

// ─── ENQUEUE ──────────────────────────────────────────────────
// Matches the payload shape of services/whatsapp.sendMessage:
//   { brand_id, business_id, phone_number_id, access_token, to, body,
//     allow_default_fallback }
async function enqueue(name, payload) {
  await ensureIndexes();
  const now = new Date();
  const job = {
    _id: newId(),
    name: name || JOB_NAME,
    payload: payload || {},
    status: 'pending',
    attempts: 0,
    max_attempts: MAX_ATTEMPTS,
    next_attempt_at: now,
    last_error: null,
    created_at: now,
    updated_at: now,
  };
  await col('message_jobs').insertOne(job);
  return { id: job._id, enqueued_at: now };
}

// Convenience: the queue.add('send_message', payload) shape.
const queue = { add: (name, payload) => enqueue(name, payload) };

// ─── CLAIM (atomic) ───────────────────────────────────────────
async function claimNextJob(name = JOB_NAME) {
  const now = new Date();
  const leaseDeadline = new Date(now.getTime() - CLAIM_LEASE_MS);
  const res = await col('message_jobs').findOneAndUpdate(
    {
      name,
      $or: [
        { status: 'pending',    next_attempt_at: { $lte: now } },
        { status: 'processing', updated_at:      { $lte: leaseDeadline } },  // stuck lease
      ],
    },
    { $set: { status: 'processing', updated_at: now }, $inc: { attempts: 1 } },
    { sort: { next_attempt_at: 1 }, returnDocument: 'after' }
  );
  return res?.value || null;
}

function backoffDelayMs(attempts) {
  // 4^n * base: 5s → 20s → 80s (n = 1, 2, 3)
  return BASE_BACKOFF_MS * Math.pow(4, Math.max(0, attempts - 1));
}

// ─── PROCESS ONE JOB ──────────────────────────────────────────
async function processJob(job, handler) {
  try {
    await handler(job.payload);
    await col('message_jobs').updateOne(
      { _id: job._id },
      { $set: { status: 'done', finished_at: new Date(), updated_at: new Date(), last_error: null } }
    );
    log.info({ jobId: job._id, attempts: job.attempts }, 'job succeeded');
  } catch (err) {
    const errInfo = { message: err?.message || String(err), code: err?.code || null, at: new Date() };
    const exhausted = job.attempts >= MAX_ATTEMPTS;
    if (exhausted) {
      await col('message_jobs').updateOne(
        { _id: job._id },
        { $set: { status: 'failed', failed_at: new Date(), updated_at: new Date(), last_error: errInfo } }
      );
      try {
        await col('failed_jobs').insertOne({
          _id: newId(),
          original_job_id: job._id,
          name: job.name,
          payload: job.payload,
          attempts: job.attempts,
          last_error: errInfo,
          failed_at: new Date(),
        });
      } catch (e) { /* audit-only insert — never mask primary failure */ }
      log.error({ jobId: job._id, err, attempts: job.attempts }, 'job failed permanently');
    } else {
      const nextAt = new Date(Date.now() + backoffDelayMs(job.attempts));
      await col('message_jobs').updateOne(
        { _id: job._id },
        { $set: { status: 'pending', next_attempt_at: nextAt, updated_at: new Date(), last_error: errInfo } }
      );
      log.warn({ jobId: job._id, attempts: job.attempts, retryAt: nextAt, err }, 'job failed — scheduled retry');
    }
  }
}

// ─── WORKER LOOP ──────────────────────────────────────────────
// Singleton polling loop. Call once at startup (e.g., from server.js).
let _workerRunning = false;
let _stopRequested = false;

function startWorker({ handler, name = JOB_NAME, pollMs = POLL_INTERVAL_MS } = {}) {
  if (!handler || typeof handler !== 'function') {
    throw new Error('startWorker: handler(payload) function is required');
  }
  if (_workerRunning) return;
  _workerRunning = true;
  _stopRequested = false;

  (async function loop() {
    await ensureIndexes();
    log.info({ name, pollMs }, 'message queue worker started');
    while (!_stopRequested) {
      try {
        const job = await claimNextJob(name);
        if (job) {
          await processJob(job, handler);
          continue;  // drain quickly when busy
        }
      } catch (err) {
        log.error({ err }, 'worker loop error — continuing after poll interval');
      }
      await new Promise(r => setTimeout(r, pollMs));
    }
    _workerRunning = false;
    log.info('message queue worker stopped');
  })();
}

function stopWorker() { _stopRequested = true; }

module.exports = {
  queue,
  enqueue,
  startWorker,
  stopWorker,
  JOB_NAME,
  MAX_ATTEMPTS,
  // exposed for tests / ops tooling
  _internals: { claimNextJob, processJob, backoffDelayMs },
};
