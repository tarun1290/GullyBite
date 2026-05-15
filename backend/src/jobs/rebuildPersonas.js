// src/jobs/rebuildPersonas.js
// Daily persona rebuild. Finds every customer with recent activity in
// the last 30d (either a user_signals row or an order) and recomputes
// their persona via services/personaComputer.upsertPersona. Per-customer
// errors are swallowed and logged so a single bad row can never abort
// the batch — same posture as rebuildCustomerProfiles.js.

'use strict';

const { col, getDb } = require('../config/database');
const { upsertPersona } = require('../services/personaComputer');
const log = require('../utils/logger').child({ component: 'persona-rebuild' });

const ACTIVITY_WINDOW_DAYS = 30;
const THROTTLE_MS = 25;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runDailyPersonaRebuild() {
  const started = Date.now();
  const since = new Date(Date.now() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // Union of distinct customer_ids touched in the activity window. Two
  // separate distinct() calls because user_signals and orders index on
  // different fields and a $or aggregation across collections needs
  // $unionWith — simpler to merge in JS.
  const [signalIds, orderIds] = await Promise.all([
    col('user_signals').distinct('customer_id', { ts: { $gte: since } }),
    col('orders').distinct('customer_id', { created_at: { $gte: since } }),
  ]);

  const ids = new Set();
  for (const id of signalIds) if (id) ids.add(id);
  for (const id of orderIds) if (id) ids.add(id);

  const total = ids.size;
  log.info({ total, windowDays: ACTIVITY_WINDOW_DAYS }, 'persona rebuild starting');

  const db = getDb();
  let processed = 0;
  let updated = 0;
  let failed = 0;

  for (const customerId of ids) {
    processed++;
    try {
      await upsertPersona(db, customerId);
      updated++;
    } catch (err) {
      failed++;
      log.warn({ err, customerId }, 'persona rebuild per-customer failed');
    }
    if (THROTTLE_MS > 0) await sleep(THROTTLE_MS);
  }

  const durationMs = Date.now() - started;
  log.info({ processed, updated, failed, durationMs }, 'persona rebuild complete');
  return { processed, updated, failed };
}

module.exports = { runDailyPersonaRebuild };
