'use strict';

const { Queue } = require('bullmq');
const log = require('../utils/logger').child({ component: 'captainQueues' });

const QUEUE_NAME = 'menu-research';
let _queue = null;

function getMenuResearchQueue(redisClient) {
  if (_queue) return _queue;
  _queue = new Queue(QUEUE_NAME, {
    connection: redisClient,
    prefix: '{bull}',
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 60 * 60 * 24, count: 1000 },
      removeOnFail: { age: 60 * 60 * 24 * 7 },
    },
  });
  _queue.on('error', (err) => log.error({ err: err.message }, 'menuResearchQueue error'));
  return _queue;
}

async function enqueueMenuResearch(redisClient, listingId, cityId, priority) {
  if (!listingId) throw new Error('enqueueMenuResearch: listingId required');
  const queue = getMenuResearchQueue(redisClient);
  const bullPriority = priority === 'high' ? 1 : 10;
  return queue.add(
    'research-listing',
    { listingId, cityId },
    { jobId: String(listingId), priority: bullPriority },
  );
}

const REENGAGE_QUEUE_NAME = 'notify-reengagement';
let _reengageQueue = null;

function getNotifyReengagementQueue(redisClient) {
  if (_reengageQueue) return _reengageQueue;
  _reengageQueue = new Queue(REENGAGE_QUEUE_NAME, {
    connection: redisClient,
    prefix: '{bull}',
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 60 * 60 * 24, count: 1000 },
      removeOnFail: { age: 60 * 60 * 24 * 7 },
    },
  });
  _reengageQueue.on('error', (err) => log.error({ err: err.message }, 'notifyReengagementQueue error'));
  return _reengageQueue;
}

async function enqueueNotifyReengagement(redisClient, listingId, cityId) {
  if (!listingId) throw new Error('enqueueNotifyReengagement: listingId required');
  const queue = getNotifyReengagementQueue(redisClient);
  return queue.add(
    'reengage-listing',
    { listingId, cityId },
    { jobId: String(listingId), priority: 5 },
  );
}

module.exports = {
  getMenuResearchQueue,
  enqueueMenuResearch,
  QUEUE_NAME,
  getNotifyReengagementQueue,
  enqueueNotifyReengagement,
  REENGAGE_QUEUE_NAME,
};
