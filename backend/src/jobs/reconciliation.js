// src/jobs/reconciliation.js
// Phase 3.1: reconciliation job — STUB.
//
// Goal: compare Razorpay's source-of-truth settlement records against
// our restaurant_ledger and flag drift (missing payments, amount
// mismatches, unaccounted fees). Runs daily; writes a summary row per
// restaurant so ops can drill in without re-running the whole job.
//
// This file is intentionally a placeholder — the real fetch loop will
// land once the Razorpay settlements API is wired into src/services/
// payment.js. For now it demonstrates the shape so cron wiring,
// logging, and ledger read-side work can be exercised end-to-end.

'use strict';

const { col, newId } = require('../config/database');
const ledger = require('../services/ledger.service');
const settlementSvc = require('../services/settlement.service');
const log = require('../utils/logger').child({ component: 'reconciliation' });

const COLLECTION = 'reconciliation_runs';

// FUTURE FEATURE: replace with live Razorpay payout-status lookup.
//   const rp = getRzp();
//   return rp.payouts.fetch(payoutId);  // → { status: 'processed' | 'reversed' | ... }
// The returned shape must include { status, failure_reason? }.
async function _fetchRazorpayPayoutStatus(payoutId) {
  log.info({ payoutId }, 'reconciliation: _fetchRazorpayPayoutStatus STUB — returning null');
  return null;
}

// Walk pending payout ledger entries. For each, ask Razorpay what the
// payout actually did; promote/fail the settlement accordingly. Kept
// best-effort — per-entry failure never aborts the run.
async function _reconcilePendingPayouts() {
  const pending = await col('restaurant_ledger').find({
    ref_type: 'payout',
    status: 'pending',
  }).project({ ref_id: 1, restaurant_id: 1 }).toArray();

  let confirmed = 0, failed = 0, unknown = 0;
  for (const entry of pending) {
    try {
      const rp = await _fetchRazorpayPayoutStatus(entry.ref_id);
      if (!rp) { unknown++; continue; }
      if (['processed', 'success', 'completed'].includes(rp.status)) {
        await settlementSvc.confirmPayout(entry.ref_id);
        confirmed++;
      } else if (['reversed', 'failed', 'rejected', 'cancelled'].includes(rp.status)) {
        await settlementSvc.failPayout(entry.ref_id, rp.failure_reason || rp.status);
        failed++;
      } else {
        unknown++;
      }
    } catch (err) {
      log.warn({ err, payoutId: entry.ref_id }, 'reconciliation.payout.error');
    }
  }
  if (pending.length) log.info({ pending: pending.length, confirmed, failed, unknown }, 'reconciliation.payouts.swept');
  return { pending: pending.length, confirmed, failed, unknown };
}

// FUTURE FEATURE: replace with live Razorpay API call.
//   const razorpay = getRzp();
//   const settlements = await razorpay.settlements.all({
//     from: Math.floor(fromDate.getTime()/1000),
//     to:   Math.floor(toDate.getTime()/1000),
//   });
async function _fetchRazorpaySettlements({ fromDate, toDate }) {
  log.info({ fromDate, toDate }, 'reconciliation: _fetchRazorpaySettlements STUB — returning []');
  return [];
}

// Compare the Razorpay-reported totals for a tenant against our ledger
// balance. Returns a diff row — same shape regardless of whether the
// tenant is in sync or not, so downstream summaries are consistent.
async function _compareTenant(restaurantId, rpSettlements) {
  const ledgerBalancePaise = await ledger.balancePaise(restaurantId);
  const rpTotalPaise = (rpSettlements || [])
    .filter((s) => String(s.restaurant_id || s.notes?.restaurant_id) === String(restaurantId))
    .reduce((acc, s) => acc + (Number(s.amount) || 0), 0);

  return {
    restaurant_id: String(restaurantId),
    ledger_paise: ledgerBalancePaise,
    razorpay_paise: rpTotalPaise,
    diff_paise: ledgerBalancePaise - rpTotalPaise,
    // `in_sync` tolerates ₹1 rounding — matches the webhook validator.
    in_sync: Math.abs(ledgerBalancePaise - rpTotalPaise) <= 100,
  };
}

async function run({ fromDate, toDate } = {}) {
  const to = toDate || new Date();
  const from = fromDate || new Date(to.getTime() - 24 * 60 * 60 * 1000);
  const runId = newId();
  log.info({ runId, from, to }, 'reconciliation run started');

  const rpSettlements = await _fetchRazorpaySettlements({ fromDate: from, toDate: to });

  // Resolve any in-flight payouts before comparing balances — otherwise
  // a pending debit would show up as an apparent ledger/Razorpay gap.
  const payoutSweep = await _reconcilePendingPayouts();

  const tenantIds = (await col('restaurants')
    .find({ status: 'active' })
    .project({ _id: 1 })
    .toArray()
  ).map((r) => String(r._id));

  const diffs = [];
  for (const rid of tenantIds) {
    try {
      diffs.push(await _compareTenant(rid, rpSettlements));
    } catch (err) {
      log.warn({ err, restaurantId: rid }, 'tenant reconciliation failed');
    }
  }
  const outOfSync = diffs.filter((d) => !d.in_sync);

  await col(COLLECTION).insertOne({
    _id: runId,
    from_date: from,
    to_date: to,
    tenant_count: diffs.length,
    out_of_sync_count: outOfSync.length,
    payout_sweep: payoutSweep,
    diffs,
    status: 'completed',
    created_at: new Date(),
  }).catch((err) => log.warn({ err }, 'reconciliation summary write failed'));

  log.info({ runId, tenants: diffs.length, outOfSync: outOfSync.length }, 'reconciliation run complete');
  return { runId, diffs, outOfSync };
}

// Cron entry point — call from server.js alongside schedulePosSync /
// scheduleRecovery. Default: daily at 03:30 IST.
function schedule() {
  const cron = require('node-cron');
  const expr = process.env.RECONCILIATION_CRON || '30 3 * * *';
  cron.schedule(expr, () => {
    run().catch((err) => log.error({ err }, 'reconciliation run crashed'));
  }, { timezone: 'Asia/Kolkata' });
  log.info({ expr }, 'reconciliation scheduled');
}

module.exports = { run, schedule, COLLECTION };
