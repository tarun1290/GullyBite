// src/services/batchProcess.js
// Utility for batching async operations with concurrency control and rate limiting.
// Used for bulk Meta API calls, catalog syncs, etc.

/**
 * Process items in batches with concurrency control.
 * @param {Array} items - Items to process
 * @param {Function} processFn - Async function(item) → result
 * @param {Object} opts - Options
 * @param {number} opts.batchSize - Max concurrent items per batch (default 5)
 * @param {number} opts.delayMs - Delay between batches in ms (default 200)
 * @param {Function} opts.onProgress - Optional callback(completed, total)
 * @returns {Array} Results with { status, value?, reason? } per item
 */
async function batchProcess(items, processFn, opts = {}) {
  const { batchSize = 5, delayMs = 200, onProgress } = opts;
  const results = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(processFn));
    results.push(...batchResults);

    if (onProgress) onProgress(results.length, items.length);

    // Delay between batches (not after the last one)
    if (i + batchSize < items.length && delayMs > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  return results;
}

/**
 * Summarize batch results.
 * @param {Array} results - From Promise.allSettled
 * @returns {{ succeeded: number, failed: number, errors: Array }}
 */
function summarizeBatch(results) {
  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;
  const errors = results
    .filter(r => r.status === 'rejected')
    .map((r, i) => ({ index: i, error: r.reason?.message || String(r.reason) }));
  return { succeeded, failed, errors };
}

module.exports = { batchProcess, summarizeBatch };
