// src/utils/retry.js
// Exponential backoff calculator for webhook retries

// Delays in seconds: 30s, 2min, 8min, 30min, 2hr
const RETRY_DELAYS = [30, 120, 480, 1800, 7200];
const MAX_RETRIES = 5;

function getNextRetryDelay(retryCount) {
  const delay = RETRY_DELAYS[Math.min(retryCount, RETRY_DELAYS.length - 1)];
  // Add jitter: ±20%
  const jitter = delay * 0.2 * (Math.random() * 2 - 1);
  return Math.round(delay + jitter);
}

function getNextRetryAt(retryCount) {
  const delaySec = getNextRetryDelay(retryCount);
  return new Date(Date.now() + delaySec * 1000);
}

// Default fields to add when inserting a new webhook log
function retryDefaults() {
  return {
    retry_count: 0,
    max_retries: MAX_RETRIES,
    next_retry_at: null,
    retry_status: 'none',       // 'none' | 'pending' | 'retrying' | 'exhausted' | 'success'
    moved_to_dlq: false,
    dlq_at: null,
    last_error: null,
    error_history: [],
  };
}

module.exports = { getNextRetryDelay, getNextRetryAt, retryDefaults, MAX_RETRIES };
