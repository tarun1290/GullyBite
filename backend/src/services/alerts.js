// src/services/alerts.js
// Platform alert detector + writer.
//
// Currently only emits `META_SYNC_FAILURE` when a sync rollup shows
// more than 30% of products were skipped. Detection is side-effectful
// but ALWAYS fire-and-forget — callers must never await or branch on
// the alert write, because the sync path must not be slowed or broken.

'use strict';

const { col, newId } = require('../config/database');
const log = require('../utils/logger').child({ component: 'alerts' });

const ALERT_TYPES = {
  META_SYNC_FAILURE: 'META_SYNC_FAILURE',
};

// Threshold constants so future tuning is one-line.
const META_SYNC_FAILURE_THRESHOLD = 0.3; // >30% skipped trips the alert.

/**
 * Given a sync summary, return an alert payload if the failure-rate
 * threshold is exceeded. Pure decision function — no DB writes.
 *
 * @param {{ restaurant_id, branch_id?, total, synced, skipped, failure_rate?, mode? }} summary
 * @returns {{ shouldAlert: boolean, alert?: object }}
 */
function checkFailureAlert(summary) {
  if (!summary || !Number.isFinite(summary.total) || summary.total <= 0) {
    return { shouldAlert: false };
  }
  const failureRate = Number.isFinite(summary.failure_rate)
    ? summary.failure_rate
    : (Number(summary.skipped) || 0) / summary.total;

  if (failureRate <= META_SYNC_FAILURE_THRESHOLD) return { shouldAlert: false };

  const pct = Math.round(failureRate * 100);
  return {
    shouldAlert: true,
    alert: {
      restaurant_id: summary.restaurant_id,
      type:          ALERT_TYPES.META_SYNC_FAILURE,
      message:       `High Meta sync failure rate detected (${pct}%). Check missing mappings or compliance.`,
      failure_rate:  failureRate,
      context: {
        branch_id: summary.branch_id || null,
        total:     summary.total,
        synced:    summary.synced,
        skipped:   summary.skipped,
        mode:      summary.mode || null,
      },
    },
  };
}

/**
 * Persist an alert row. Fire-and-forget by design — the returned
 * promise is only for tests; production callers should NOT await.
 */
async function writeAlert(payload) {
  try {
    await col('alerts').insertOne({
      _id:           newId(),
      restaurant_id: String(payload.restaurant_id),
      type:          payload.type,
      message:       payload.message,
      failure_rate:  Number.isFinite(payload.failure_rate) ? payload.failure_rate : null,
      context:       payload.context || {},
      status:        'active',
      timestamp:     new Date(),
    });
  } catch (e) {
    log.warn({ err: e.message, type: payload.type }, 'alert write failed (non-fatal)');
  }
}

/**
 * Convenience: run the detector on a summary and write the alert if
 * triggered. Always resolves; never throws. Safe to call without await.
 */
async function maybeAlertFromSummary(summary) {
  const verdict = checkFailureAlert(summary);
  if (!verdict.shouldAlert) return null;
  await writeAlert(verdict.alert);
  log.warn({
    restaurant_id: summary.restaurant_id,
    branch_id:     summary.branch_id,
    failure_rate:  verdict.alert.failure_rate,
  }, 'META_SYNC_FAILURE alert raised');
  return verdict.alert;
}

module.exports = {
  ALERT_TYPES,
  META_SYNC_FAILURE_THRESHOLD,
  checkFailureAlert,
  writeAlert,
  maybeAlertFromSummary,
};
