// src/jobs/settlementPayout.js
// Phase 5 — Daily cron that walks active restaurants and triggers an
// on-demand balance-based settlement when the payable amount clears
// the MIN_PAYOUT_PAISE threshold.
//
// Coexists with jobs/settlement.js (the weekly legacy cycle):
//   • jobs/settlement.js      — weekly, reconstructs financials from
//                               orders/payments, writes rupee-shaped
//                               settlement rows, uses the legacy
//                               paymentSvc.createPayout path.
//   • jobs/settlementPayout.js (this file) — daily, drains the
//                               restaurant_ledger balance into a
//                               paise-shaped settlement row.
//
// Schedule: 10:00 IST every day. Override via SETTLEMENT_PAYOUT_CRON.
// Idempotency is enforced in settlement.service.executeSettlement;
// this job doesn't need its own lock.

'use strict';

const cron = require('node-cron');
const { col } = require('../config/database');
const settlementSvc = require('../services/settlement.service');
const log = require('../utils/logger').child({ component: 'settlementPayout' });

// Cron expression. SETTLEMENT_CRON is the canonical env (per spec);
// SETTLEMENT_PAYOUT_CRON stays as a back-compat alias. Default 10am IST.
const CRON_EXPR = process.env.SETTLEMENT_CRON || process.env.SETTLEMENT_PAYOUT_CRON || '0 10 * * *';

async function run() {
  log.info({ threshold: settlementSvc.MIN_PAYOUT_PAISE, retryLimit: settlementSvc.PAYOUT_RETRY_LIMIT }, 'settlement_payout.run.start');

  // (0) Time out any settlements stuck in 'processing' past the
  // threshold. Unreserves their pending ledger debit so the next pass
  // can compute a clean payable balance.
  const timeout = await settlementSvc.timeoutStaleSettlements().catch(err => {
    log.error({ err }, 'settlement_payout.timeout.error');
    return { found: 0, timedOut: 0 };
  });

  // (a) Retry previously-failed rows first so a transient provider
  // outage from yesterday is resolved before we open new settlements.
  const failedRows = await col('settlements').find({
    status: 'failed',
    payout_amount_paise: { $gt: 0 },
    $or: [
      { attempt_count: { $exists: false } },
      { attempt_count: { $lt: settlementSvc.PAYOUT_RETRY_LIMIT } },
    ],
  }).project({ _id: 1 }).toArray();
  let retried = 0, retrySkipped = 0, retryFailed = 0;
  for (const s of failedRows) {
    try {
      const r = await settlementSvc.retrySettlement(String(s._id));
      if (r.success) retried++;
      else if (r.skipped) retrySkipped++;
      else retryFailed++;
    } catch (err) {
      retryFailed++;
      log.error({ err, settlementId: String(s._id) }, 'settlement_payout.retry.error');
    }
  }

  // (b) Fresh settlements for tenants with a fund account.
  const restaurants = await col('restaurants').find(
    { approval_status: 'approved', razorpay_fund_acct_id: { $exists: true, $ne: null } },
    { projection: { _id: 1, business_name: 1 } },
  ).toArray();

  let triggered = 0, skipped = 0, failed = 0;
  for (const r of restaurants) {
    try {
      const result = await settlementSvc.executeSettlement(String(r._id), { trigger: 'cron:daily' });
      if (result.success) triggered++;
      else if (result.skipped) skipped++;
      else failed++;
    } catch (err) {
      failed++;
      log.error({ err, restaurantId: String(r._id) }, 'settlement_payout.tenant.error');
    }
  }

  log.info({
    total: restaurants.length, triggered, skipped, failed,
    retried, retrySkipped, retryFailed,
    timedOut: timeout.timedOut,
  }, 'settlement_payout.run.done');
  return {
    total: restaurants.length, triggered, skipped, failed,
    retried, retrySkipped, retryFailed, timedOut: timeout.timedOut,
  };
}

function schedule() {
  cron.schedule(CRON_EXPR, () => {
    run().catch(err => log.error({ err }, 'settlement_payout.cron.unhandled'));
  }, { timezone: 'Asia/Kolkata' });
  log.info({ cron: CRON_EXPR }, 'settlement payout cron scheduled');
}

module.exports = { schedule, run };
