'use strict';

// BullMQ worker for 'menu-research'. EC2-only.

const { Worker } = require('bullmq');
const connection = require('../queue/redis');
const { col, connect, newId } = require('../config/database');
const { runResearchJob } = require('../services/menuResearchAgent');
const log = require('../utils/logger').child({ component: 'menuResearchWorker' });

const QUEUE_NAME = 'menu-research';

async function processResearchJob(job) {
  const { listingId } = job.data || {};
  log.info({ jobId: job.id, listingId, attempt: job.attemptsMade + 1 }, 'Processing research job');
  if (!listingId) return { skipped: true, reason: 'no listingId' };
  const db = await connect();
  await runResearchJob(db, connection, listingId);
  return { success: true };
}

let _worker = null;

function start() {
  if (_worker) return _worker;
  const concurrency = Number(process.env.RESEARCH_AGENT_CONCURRENCY || 3);
  _worker = new Worker(QUEUE_NAME, processResearchJob, {
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
      // Mark listing as research_failed so the dashboard knows.
      try {
        await col('city_listings').updateOne(
          { _id: job.data.listingId },
          { $set: { research_status: 'research_failed', last_research_error: err.message, last_researched_at: new Date() } },
        );
      } catch (e) {
        log.warn({ err: e.message }, 'mark research_failed failed');
      }
      // Mirror to failed_jobs for ops.
      col('failed_jobs').insertOne({
        _id: newId(),
        source: 'menuResearchWorker',
        job_id: String(job.id),
        listing_id: job.data.listingId,
        attempts: job.attemptsMade,
        last_error: { message: err.message, at: new Date() },
        failed_at: new Date(),
      }).catch((e) => log.warn({ err: e.message }, 'failed_jobs mirror insert failed'));
    }
  });
  _worker.on('error', (err) => log.error({ err: err.message }, 'Worker runtime error'));
  log.info({ queue: QUEUE_NAME, concurrency }, 'menuResearchWorker started');
  return _worker;
}

async function stop() {
  if (_worker) {
    await _worker.close();
    _worker = null;
    log.info('menuResearchWorker stopped');
  }
}

module.exports = { start, stop, processResearchJob, QUEUE_NAME };
