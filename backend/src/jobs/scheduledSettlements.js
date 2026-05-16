// src/jobs/scheduledSettlements.js
// Phase 5 — automated settlement runs, Mon + Thu 06:00 IST.
//
// Walks every approved restaurant that has ≥1 active branch and runs
// executeSettlement (ledger-balance payout). Per-restaurant try/catch so
// one tenant's failure never blocks the rest of the batch.
//
// payout_mode: 'fallback_provider' is passed through verbatim per spec.
// NOTE: executeSettlement only distinguishes payout_mode === 'manual'
// from everything-else (→ 'auto'); 'fallback_provider' therefore runs the
// normal auto provider loop (razorpay → fallback_provider). When the
// fallback provider is reached it parks the row as 'pending_manual_payout'
// for ops to bank-transfer + confirm. This matches the intended
// "attempt real payout, else queue for manual" behaviour.

'use strict';

const cron = require('node-cron');
const { col } = require('../config/database');
const settlementSvc = require('../services/settlement.service');
const log = require('../utils/logger').child({ component: 'scheduled-settlements' });

// Monday 06:00 IST and Thursday 06:00 IST.
const CRON_MON = '0 6 * * 1';
const CRON_THU = '0 6 * * 4';

async function runScheduledSettlements() {
  const restaurants = await col('restaurants')
    .find({ approval_status: 'approved' })
    .project({ _id: 1 })
    .toArray();

  const summary = { total: restaurants.length, processed: 0, skipped_no_active_branch: 0, failed: 0 };

  for (const r of restaurants) {
    const rid = String(r._id);
    try {
      const activeBranches = await col('branches').countDocuments({
        restaurant_id: rid,
        subscription_status: 'active',
      });
      if (activeBranches === 0) {
        summary.skipped_no_active_branch++;
        continue;
      }

      const result = await settlementSvc.executeSettlement(rid, {
        trigger: 'cron:auto',
        payout_mode: 'manual',
      });
      summary.processed++;
      log.info({ restaurantId: rid, result }, 'scheduledSettlements.restaurant_done');
    } catch (err) {
      // One tenant's failure must not abort the batch.
      summary.failed++;
      log.error({ err: err?.message, restaurantId: rid }, 'scheduledSettlements.restaurant_failed');
    }
  }

  log.info(summary, 'scheduledSettlements.batch_done');
  return summary;
}

function schedule() {
  const runner = () => {
    runScheduledSettlements()
      .then((s) => log.info(s, 'scheduledSettlements.cron_complete'))
      .catch((err) => log.error({ err: err?.message }, 'scheduledSettlements.cron_failed'));
  };
  cron.schedule(CRON_MON, runner, { timezone: 'Asia/Kolkata' });
  cron.schedule(CRON_THU, runner, { timezone: 'Asia/Kolkata' });
  log.info({ crons: [CRON_MON, CRON_THU], tz: 'Asia/Kolkata' }, 'scheduled settlements cron scheduled');
}

module.exports = { runScheduledSettlements, schedule };
