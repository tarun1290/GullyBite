'use strict';

// BullMQ worker for 'notify-reengagement'. EC2-only.

const { Worker } = require('bullmq');
const connection = require('../queue/redis');
const { col, connect, newId } = require('../config/database');
const { runReengagementJob } = require('../services/captainReengagement');
const log = require('../utils/logger').child({ component: 'notifyReengagementWorker' });

const QUEUE_NAME = 'notify-reengagement';

async function processReengagementJob(job) {
  const { listingId, cityId } = job.data || {};
  log.info({ jobId: job.id, listingId, attempt: job.attemptsMade + 1 }, 'Processing reengagement job');
  if (!listingId) return { skipped: true, reason: 'no listingId' };
  const db = await connect();
  await runReengagementJob(db, connection, listingId, cityId);
  return { success: true };
}

let _worker = null;

function start() {
  if (_worker) return _worker;
  const concurrency = 2;
  _worker = new Worker(QUEUE_NAME, processReengagementJob, {
    connection,
    prefix: '{bull}',
    concurrency,
  });
  _worker.on('completed', (job, result) => {
    log.info({ jobId: job.id, listingId: job.data?.listingId, result }, 'Job completed');
  });
  _worker.on('failed', async (job, err) => {
    const exhausted = job && job.attemptsMade >= (job.opts?.attempts || 1);
    log.error(
      { jobId: job?.id, listingId: job?.data?.listingId, attempt: job?.attemptsMade, exhausted, err: err.message },
      'Job failed',
    );
    if (exhausted && job?.data?.listingId) {
      // Mirror terminal failure to failed_jobs for ops. Skip the
      // listing.research_status flip — that's a research-only concern.
      col('failed_jobs').insertOne({
        _id: newId(),
        source: 'notifyReengagementWorker',
        job_id: String(job.id),
        listing_id: job.data.listingId,
        attempts: job.attemptsMade,
        last_error: { message: err.message, at: new Date() },
        failed_at: new Date(),
      }).catch((e) => log.warn({ err: e.message }, 'failed_jobs mirror insert failed'));
    }
  });
  _worker.on('error', (err) => log.error({ err: err.message }, 'Worker runtime error'));
  log.info({ queue: QUEUE_NAME, concurrency }, 'notifyReengagementWorker started');
  return _worker;
}

async function stop() {
  if (_worker) {
    await _worker.close();
    _worker = null;
    log.info('notifyReengagementWorker stopped');
  }
}

module.exports = { start, stop, processReengagementJob, QUEUE_NAME };
