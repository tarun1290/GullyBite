// src/utils/smartModule.js
// Reusable error boundary for smart modules.
//
// Wraps any async function with:
//  1. Feature flag check  — if disabled, return fallback immediately
//  2. Try/catch boundary  — on error, log + return fallback (never throw)
//  3. Structured logging  — module name, duration, success/failure
//
// Usage:
//   const { guard } = require('../utils/smartModule');
//
//   // Simple — returns fallback on error or flag-off
//   const mpms = await guard('MPM_STRATEGY', {
//     fn: () => buildStrategyMPMs(branchId, restaurantId, ctx),
//     fallback: null,
//     label: 'buildStrategyMPMs',
//     context: { branchId },
//   });
//
//   // With fallback function (called on error or flag-off)
//   const mpms = await guard('MPM_STRATEGY', {
//     fn: () => buildStrategyMPMs(branchId, restaurantId, ctx),
//     fallbackFn: () => buildBranchMPMs(branchId),
//     label: 'buildStrategyMPMs',
//     context: { branchId },
//   });

'use strict';

const log = require('./logger').child({ component: 'smartModule' });

/**
 * @param {string} flagKey  — key in SMART_MODULES (e.g. 'MPM_STRATEGY')
 * @param {object} opts
 * @param {Function} opts.fn          — the smart module call (async OK)
 * @param {*}        [opts.fallback]  — static value returned on error/disabled
 * @param {Function} [opts.fallbackFn]— function called on error/disabled (overrides opts.fallback)
 * @param {string}   [opts.label]     — human label for logs
 * @param {object}   [opts.context]   — extra fields merged into log context
 * @param {boolean}  [opts.rethrow]   — if true, rethrow instead of returning fallback (for callers that handle errors themselves)
 * @returns {Promise<*>}
 */
async function guard(flagKey, opts) {
  const { fn, fallback = null, fallbackFn, label = flagKey, context = {}, rethrow = false } = opts;

  // Lazy-require to avoid circular dependency (features.js → logger → … → features.js)
  const { SMART_MODULES } = require('../config/features');

  const enabled = SMART_MODULES[flagKey];

  // ── Flag disabled ──────────────────────────────────────────
  if (enabled === false) {
    log.info({ module: label, ...context }, `${label} disabled by feature flag`);
    return fallbackFn ? fallbackFn() : fallback;
  }

  // ── Execute with error boundary ────────────────────────────
  const start = Date.now();
  try {
    const result = await fn();
    const durationMs = Date.now() - start;
    if (durationMs > 3000) {
      log.warn({ module: label, durationMs, ...context }, `${label} slow execution`);
    }
    return result;
  } catch (err) {
    const durationMs = Date.now() - start;
    log.error({ module: label, err, durationMs, ...context }, `${label} failed — using fallback`);

    if (rethrow) throw err;
    return fallbackFn ? fallbackFn() : fallback;
  }
}

module.exports = { guard };
