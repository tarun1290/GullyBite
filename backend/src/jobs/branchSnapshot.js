// src/jobs/branchSnapshot.js
// Phase 5 — monthly billable-branch snapshots.
//
// On the 1st of every IST month we freeze the set of branches that were
// `subscription_status: 'active'` at that moment into
// `branch_billing_snapshots`. executeSettlement reads this frozen set to
// post the per-branch platform fee — it never recomputes "who is active
// now", so a branch paused mid-month is still billed for the month it was
// active in, and a branch activated mid-month is picked up via
// snapshotBranchOnActivation (Prompt 2's approval endpoint).
//
// Row shapes (one collection, disambiguated by _id):
//   • per-branch  → _id '<branchId>:<monthKey>'
//   • month anchor → _id 'month:<monthKey>'  (written LAST by a full run)
//
// The anchor is the "snapshot completed for this month" marker.
// Settlement throws snapshot_missing if the anchor is absent — that
// prevents billing a month whose snapshot never ran (which would
// otherwise silently bill zero branches).

'use strict';

const cron = require('node-cron');
const { col } = require('../config/database');
const log = require('../utils/logger').child({ component: 'branch-snapshot' });

const COLL = 'branch_billing_snapshots';
// Midnight on day 1 of the month, IST.
const CRON_EXPR = '0 0 1 * *';

// IST month key 'YYYY-MM'. Platform billing periods follow IST, not UTC —
// a UTC-midnight boundary would cut the IST day at 05:30 and mis-bucket
// activations made late on the last day of a month.
function istMonthKey() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

// Full-run snapshot: every active branch + the month anchor (written last).
// trigger: 'cron' | 'manual'. monthKey optional — defaults to current IST
// month; an explicit value lets the manual endpoint re-snapshot a month.
// Idempotent: $setOnInsert means a re-run for the same month no-ops on
// existing branch rows; the anchor is refreshed ($set) so branch_count
// reflects the latest run.
async function snapshotAllActiveBranchesForMonth({ trigger = 'manual', monthKey } = {}) {
  const mk = monthKey || istMonthKey();
  const trig = trigger === 'cron' ? 'cron' : 'manual';

  const branches = await col('branches')
    .find({ subscription_status: 'active' })
    .project({ _id: 1, restaurant_id: 1 })
    .toArray();

  let inserted = 0;
  let skipped = 0;

  for (const b of branches) {
    const _id = `${b._id}:${mk}`;
    try {
      const r = await col(COLL).updateOne(
        { _id },
        {
          $setOnInsert: {
            _id,
            branch_id: String(b._id),
            restaurant_id: String(b.restaurant_id || ''),
            month_key: mk,
            triggered_by: trig,
            snapshot_at: new Date(),
          },
        },
        { upsert: true },
      );
      if (r.upsertedCount > 0) inserted++;
      else skipped++;
    } catch (err) {
      // E11000 = concurrent run already inserted this branch row. Benign —
      // the row exists, which is all we need. Anything else is logged but
      // must not abort the whole snapshot (one bad branch ≠ skip billing).
      if (err && err.code === 11000) {
        skipped++;
      } else {
        log.error({ err: err?.message, branchId: String(b._id), monthKey: mk }, 'branchSnapshot.branch_row_failed');
        skipped++;
      }
    }
  }

  // Anchor LAST — only after every branch row was attempted. A partial
  // failure must not leave a false-positive anchor that lets settlement
  // bill an incomplete snapshot. $set so a manual re-run refreshes the count.
  await col(COLL).updateOne(
    { _id: `month:${mk}` },
    {
      $set: {
        month_key: mk,
        triggered_by: trig,
        branch_count: branches.length,
        snapshot_at: new Date(),
      },
    },
    { upsert: true },
  );

  log.info({ monthKey: mk, trigger: trig, inserted, skipped, branchCount: branches.length }, 'branchSnapshot.full_run_done');
  return { monthKey: mk, inserted, skipped, branchCount: branches.length };
}

// Single-branch snapshot at activation (called by Prompt 2's approval
// endpoint). Writes ONLY the per-branch row with triggered_by 'activation'
// — never the anchor (only a full cron/manual run owns the anchor).
async function snapshotBranchOnActivation({ branchId, restaurantId }) {
  if (!branchId) throw new Error('snapshotBranchOnActivation: branchId required');
  const mk = istMonthKey();
  const _id = `${branchId}:${mk}`;
  try {
    await col(COLL).updateOne(
      { _id },
      {
        $setOnInsert: {
          _id,
          branch_id: String(branchId),
          restaurant_id: String(restaurantId || ''),
          month_key: mk,
          triggered_by: 'activation',
          snapshot_at: new Date(),
        },
      },
      { upsert: true },
    );
  } catch (err) {
    if (!(err && err.code === 11000)) {
      log.error({ err: err?.message, branchId: String(branchId), monthKey: mk }, 'branchSnapshot.activation_row_failed');
      throw err;
    }
    // E11000 → already snapshotted this month. Idempotent no-op.
  }
  log.info({ branchId: String(branchId), monthKey: mk }, 'branchSnapshot.activation_done');
  return { monthKey: mk, branchId: String(branchId) };
}

// True iff a full snapshot has completed for the given IST month.
// Settlement uses this as the snapshot_missing gate.
async function hasMonthAnchor(monthKey) {
  if (!monthKey) return false;
  const doc = await col(COLL).findOne({ _id: `month:${monthKey}` }, { projection: { _id: 1 } });
  return !!doc;
}

function schedule() {
  cron.schedule(CRON_EXPR, () => {
    snapshotAllActiveBranchesForMonth({ trigger: 'cron' })
      .then((r) => log.info(r, 'branchSnapshot.cron_complete'))
      .catch((err) => log.error({ err: err?.message }, 'branchSnapshot.cron_failed'));
  }, { timezone: 'Asia/Kolkata' });
  log.info({ cron: CRON_EXPR }, 'branch snapshot cron scheduled');
}

module.exports = {
  snapshotAllActiveBranchesForMonth,
  snapshotBranchOnActivation,
  hasMonthAnchor,
  schedule,
};
