// src/utils/parallel.js
// Parallel execution helpers with concurrency control and error logging.

'use strict';

const log = require('./logger').child({ component: 'parallel' });

/**
 * Run async tasks concurrently, return all results. Throws if any fail.
 */
async function parallelAll(tasks) {
  return Promise.all(tasks);
}

/**
 * Run async tasks concurrently, never fails. Returns { fulfilled, rejected }.
 */
async function parallelSettled(tasks) {
  const results = await Promise.allSettled(tasks);
  return {
    fulfilled: results.filter(r => r.status === 'fulfilled').map(r => r.value),
    rejected: results.filter(r => r.status === 'rejected').map(r => r.reason),
  };
}

/**
 * Process items in batches with controlled concurrency.
 * @param {Array} items
 * @param {Function} processFn - async (item, index) => result
 * @param {number} concurrency - max parallel tasks (default 10)
 */
async function parallelBatch(items, processFn, concurrency = 10) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map((item, idx) => processFn(item, i + idx))
    );
    results.push(...batchResults);
  }
  return results;
}

/**
 * Fire-and-forget: execute without awaiting, with error logging.
 */
function fireAndForget(fn, label = 'unknown') {
  Promise.resolve().then(fn).catch(err => {
    log.error({ err, label }, 'Fire-and-forget task failed');
  });
}

module.exports = { parallelAll, parallelSettled, parallelBatch, fireAndForget };
