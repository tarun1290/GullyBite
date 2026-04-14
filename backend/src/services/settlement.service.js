// src/services/settlement.service.js
// Phase 5 — On-demand balance-based settlements. Pays out the tenant's
// outstanding ledger balance to their Razorpay fund account, with
// fallback_provider as a second rail if the primary fails.
//
// Source of truth: `restaurant_ledger`. We never recompute from orders;
// all credits/debits are already journaled there by the payment and
// refund webhooks.
//
// Flow (executeSettlement):
//   1. Idempotency — skip if another row is pending/processing.
//   2. calculateSettlement → if payable < MIN_PAYOUT_PAISE, skip.
//   3. Insert row (status='processing', attempt_count=1).
//   4. Try primary provider ('razorpay'). On failure, retry with
//      'fallback_provider'. attempt_count increments on each try.
//   5. On success → status='completed', write ledger debit keyed by
//      the payout_id. On all-providers-failed → status='failed',
//      alert admin, leave the row claimable by retry API / cron.
//
// retrySettlement(settlementId) re-runs the payout on a failed row
// without creating a new row; attempt_count keeps climbing until
// PAYOUT_RETRY_LIMIT is reached.

'use strict';

const { col, newId } = require('../config/database');
const ledger = require('./ledger.service');
const payoutSvc = require('./payout.service');
const log = require('../utils/logger').child({ component: 'settlement' });

const COLLECTION = 'settlements';

// ─── CONFIG ─────────────────────────────────────────────────
const MIN_PAYOUT_PAISE    = Number(process.env.MIN_PAYOUT_PAISE) || 100000;   // ₹1,000
const PAYOUT_RETRY_LIMIT  = Number(process.env.PAYOUT_RETRY_LIMIT) || 3;
const PAYOUT_PROVIDERS    = ['razorpay', 'fallback_provider'];
// Settlement rows in 'processing' longer than this are treated as dead
// and flipped to 'failed' by timeoutStaleSettlements(). Default 24h.
const SETTLEMENT_TIMEOUT_MS = Number(process.env.SETTLEMENT_TIMEOUT_MS) || 24 * 60 * 60 * 1000;

// ─── 1. CALCULATE ───────────────────────────────────────────
// Returns { gross, refunds, payouts, net_balance, payable_amount } in paise.
//   gross          — Σ credits (payment, completed)
//   refunds        — Σ debits  (refund,  completed)
//   payouts        — Σ debits  (payout,  completed)
//   net_balance    — gross − refunds − payouts
//   payable_amount — net_balance − Σ (pending/processing settlement rows
//                    not yet reflected in the ledger). Clamped to ≥ 0.
async function calculateSettlement(restaurantId) {
  if (!restaurantId) throw new Error('calculateSettlement: restaurantId required');
  const rid = String(restaurantId);

  const agg = await col('restaurant_ledger').aggregate([
    { $match: { restaurant_id: rid, status: 'completed' } },
    { $group: {
        _id: { type: '$type', ref_type: '$ref_type' },
        total: { $sum: '$amount_paise' },
    } },
  ]).toArray();

  let gross = 0, refunds = 0, payouts = 0;
  for (const row of agg) {
    const { type, ref_type } = row._id;
    if (type === 'credit' && ref_type === 'payment') gross   += row.total;
    if (type === 'debit'  && ref_type === 'refund')  refunds += row.total;
    if (type === 'debit'  && ref_type === 'payout')  payouts += row.total;
  }
  const net_balance = gross - refunds - payouts;

  // In-flight settlement rows haven't written their ledger debit yet
  // (that happens on successful payout), so we reserve their amount
  // so two concurrent runs can't both pay out the same balance.
  const inflightAgg = await col(COLLECTION).aggregate([
    { $match: {
        restaurant_id: rid,
        status: { $in: ['pending', 'processing'] },
        payout_amount_paise: { $gt: 0 },
        // Restrict to Phase 5 rows; legacy weekly rows use a different
        // reservation model (orders.settlement_id) and must not be
        // double-counted here.
        $or: [{ settlement_type: 'new' }, { settlement_type: { $exists: false }, total_amount_paise: { $exists: true } }],
    } },
    { $group: { _id: null, total: { $sum: '$payout_amount_paise' } } },
  ]).toArray();
  const inflight = inflightAgg[0]?.total || 0;

  const payable_amount = Math.max(0, net_balance - inflight);

  return { gross, refunds, payouts, net_balance, payable_amount };
}

// ─── 2. EXECUTE ─────────────────────────────────────────────
async function executeSettlement(restaurantId, { trigger = 'manual' } = {}) {
  if (!restaurantId) throw new Error('executeSettlement: restaurantId required');
  const rid = String(restaurantId);
  log.info({ restaurantId: rid, trigger }, 'settlement.start');

  // (14) Idempotency — one in-flight settlement at a time per tenant.
  const inflight = await col(COLLECTION).findOne({
    restaurant_id: rid,
    status: { $in: ['pending', 'processing'] },
  });
  if (inflight) {
    log.warn({ restaurantId: rid, settlementId: inflight._id, status: inflight.status }, 'settlement.skip.inflight');
    return { skipped: true, reason: 'inflight', settlement_id: inflight._id };
  }

  const calc = await calculateSettlement(rid);
  const amount = calc.payable_amount;

  if (amount < MIN_PAYOUT_PAISE) {
    log.info({ restaurantId: rid, amount, threshold: MIN_PAYOUT_PAISE }, 'settlement.skip.below_threshold');
    return { skipped: true, reason: 'below_threshold', payable_amount_paise: amount, threshold: MIN_PAYOUT_PAISE };
  }

  const restaurant = await col('restaurants').findOne(
    { _id: rid },
    { projection: { business_name: 1, razorpay_fund_acct_id: 1 } }
  );
  if (!restaurant?.razorpay_fund_acct_id) {
    log.warn({ restaurantId: rid }, 'settlement.skip.no_fund_account');
    return { skipped: true, reason: 'no_fund_account' };
  }

  // Insert the settlement row up-front so idempotency is enforced
  // by the next concurrent caller even mid-flight.
  const settlementId = newId();
  const now = new Date();
  await col(COLLECTION).insertOne({
    _id: settlementId,
    restaurant_id: rid,
    settlement_type: 'new',           // disambiguates from legacy weekly rows
    gross_amount_paise:   calc.gross,
    refund_amount_paise:  calc.refunds,
    payout_amount_paise:  amount,
    fee_amount_paise:     0,          // Razorpay fee arrives via webhook; 0 until then
    net_amount_paise:     amount,     // amount actually payable now
    total_amount_paise:   amount,     // alias, back-compat with prior turn
    status: 'processing',
    payout_id: null,
    payout_provider: null,
    attempt_count: 0,
    last_attempt_at: null,
    trigger,
    created_at: now,
    processed_at: null,
    failure_reason: null,
  });

  return _attemptPayout(settlementId, restaurant.razorpay_fund_acct_id, amount);
}

// ─── 3. RETRY ───────────────────────────────────────────────
// Manual retry (admin API / cron). Picks up a 'failed' row and
// re-attempts the payout across providers. attempt_count continues
// from where it stopped; PAYOUT_RETRY_LIMIT caps total tries.
async function retrySettlement(settlementId) {
  const row = await col(COLLECTION).findOne({ _id: String(settlementId) });
  if (!row) return { error: 'not_found' };
  if (row.status === 'completed') return { skipped: true, reason: 'already_completed', settlement_id: row._id };
  if (row.status === 'processing') return { skipped: true, reason: 'inflight', settlement_id: row._id };
  if ((row.attempt_count || 0) >= PAYOUT_RETRY_LIMIT) {
    return { skipped: true, reason: 'retry_limit_exceeded', attempt_count: row.attempt_count };
  }

  const restaurant = await col('restaurants').findOne(
    { _id: row.restaurant_id },
    { projection: { razorpay_fund_acct_id: 1 } },
  );
  if (!restaurant?.razorpay_fund_acct_id) return { error: 'no_fund_account' };

  // Flip back to processing under a CAS so two retries can't race.
  const flip = await col(COLLECTION).updateOne(
    { _id: row._id, status: 'failed' },
    { $set: { status: 'processing', failure_reason: null } },
  );
  if (flip.matchedCount !== 1) return { skipped: true, reason: 'race', settlement_id: row._id };

  return _attemptPayout(row._id, restaurant.razorpay_fund_acct_id, row.payout_amount_paise);
}

// ─── SHARED: attempt providers in order, write outcome ──────
async function _attemptPayout(settlementId, fundAccountId, amountPaise) {
  const row = await col(COLLECTION).findOne({ _id: settlementId });
  let attempts = row?.attempt_count || 0;
  let lastErr = null;

  for (const provider of PAYOUT_PROVIDERS) {
    if (attempts >= PAYOUT_RETRY_LIMIT) {
      log.warn({ settlementId, attempts }, 'settlement.retry_limit_reached');
      break;
    }
    attempts++;

    // idempotencyKey is derived so Razorpay sees each distinct attempt
    // as a distinct request — prevents a retry from being silently
    // no-op'd by a prior provider's idempotency cache.
    const idempotencyKey = `${settlementId}:${attempts}`;
    const attemptAt = new Date();
    await col(COLLECTION).updateOne(
      { _id: settlementId },
      { $set: { attempt_count: attempts, last_attempt_at: attemptAt, payout_provider: provider } },
    );
    log.info({ settlementId, provider, attempt: attempts, amountPaise }, 'settlement.payout.attempt');

    try {
      const out = await payoutSvc.initiatePayout(provider, {
        fundAccountId,
        amountPaise,
        idempotencyKey,
        referenceId: settlementId,
        narration: 'GullyBite Settlement',
      });

      // Razorpay call returned an id — but the payout itself is still
      // in flight at the provider. We keep the settlement in 'processing'
      // until confirmPayout() is invoked (by reconciliation / webhook).
      await col(COLLECTION).updateOne(
        { _id: settlementId },
        { $set: {
            payout_id: out.payout_id,
            payout_provider: out.provider,
            failure_reason: null,
        } },
      );

      // Ledger debit keyed by payout_id, status='pending'. The balance
      // calculator ignores pending entries; reservation is enforced by
      // the settlement row (status='processing') via calculateSettlement's
      // in-flight subtraction. confirmPayout() promotes this to completed.
      try {
        const restaurantId = row?.restaurant_id || (await col(COLLECTION).findOne({ _id: settlementId }))?.restaurant_id;
        await ledger.debit({
          restaurantId,
          amountPaise,
          refType: 'payout',
          refId: out.payout_id,
          status: 'pending',
          notes: `Settlement ${settlementId} via ${out.provider}`,
        });
      } catch (ledgerErr) {
        log.error({ err: ledgerErr, settlementId, payoutId: out.payout_id }, 'settlement.ledger_debit_failed');
      }

      log.info({ settlementId, provider: out.provider, payoutId: out.payout_id, attempt: attempts, amountPaise }, 'settlement.payout.initiated');
      return {
        success: true,                    // Razorpay accepted the payout request
        confirmed: false,                 // not yet confirmed by provider
        settlement_id: settlementId,
        payout_id: out.payout_id,
        provider: out.provider,
        attempt_count: attempts,
        amount_paise: amountPaise,
      };
    } catch (err) {
      lastErr = err;
      log.warn({ err: err?.message || err, settlementId, provider, attempt: attempts }, 'settlement.payout.provider_failed');
      // continue to next provider
    }
  }

  // All providers exhausted (or retry limit hit).
  const reason = lastErr?.error?.description || lastErr?.message || 'all_providers_failed';
  await col(COLLECTION).updateOne(
    { _id: settlementId },
    { $set: {
        status: 'failed',
        failure_reason: reason,
        processed_at: new Date(),
    } },
  );
  log.error({ settlementId, reason, attempts }, 'settlement.payout.failed');

  // (17) Admin alert hook — fire-and-forget so a notifier blip
  // doesn't flip the settlement back to success.
  try { await _alertAdminOnFailure(settlementId, reason); }
  catch (alertErr) { log.warn({ err: alertErr, settlementId }, 'settlement.alert_failed'); }

  return { success: false, settlement_id: settlementId, error: reason, attempt_count: attempts };
}

// ─── ALERT HOOK ─────────────────────────────────────────────
// Writes to the existing `alerts` collection so the admin dashboard's
// alerts page surfaces it. Replace with Slack/PagerDuty when ops is ready.
async function _alertAdminOnFailure(settlementId, reason) {
  await col('alerts').insertOne({
    _id: newId(),
    type: 'settlement_payout_failed',
    status: 'open',
    severity: 'high',
    settlement_id: String(settlementId),
    reason: String(reason).slice(0, 500),
    timestamp: new Date(),
  });
}

// ─── 4. CONFIRM ─────────────────────────────────────────────
// Called by reconciliation / webhook when Razorpay reports the payout
// as successful. Flips the ledger entry pending→completed AND the
// settlement row processing→completed. Both updates are idempotent
// (no-op if already completed).
async function confirmPayout(payoutId) {
  if (!payoutId) throw new Error('confirmPayout: payoutId required');
  const pid = String(payoutId);

  const settlement = await col(COLLECTION).findOne({ payout_id: pid });
  if (!settlement) {
    log.warn({ payoutId: pid }, 'confirmPayout.settlement_not_found');
    return { error: 'settlement_not_found' };
  }
  if (settlement.status === 'completed') {
    return { skipped: true, reason: 'already_completed', settlement_id: settlement._id };
  }

  // Flip ledger pending → completed. Uses the public markCompleted
  // helper so the write goes through the same code path as refunds.
  const ledgerUpdated = await ledger.markCompleted({
    restaurantId: settlement.restaurant_id,
    refType: 'payout',
    refId: pid,
  });
  if (!ledgerUpdated) {
    log.warn({ payoutId: pid, settlementId: settlement._id }, 'confirmPayout.ledger_entry_missing');
  }

  await col(COLLECTION).updateOne(
    { _id: settlement._id, status: { $ne: 'completed' } },
    { $set: { status: 'completed', processed_at: new Date(), failure_reason: null } },
  );

  log.info({ payoutId: pid, settlementId: settlement._id }, 'settlement.payout.confirmed');
  return { success: true, settlement_id: settlement._id, payout_id: pid };
}

// ─── 5. FAIL ────────────────────────────────────────────────
// Called when Razorpay reports the payout failed / reversed.
//   • If the ledger entry is still 'pending' → flip it to 'failed'.
//     No compensating entry needed; balance was never reduced.
//   • If the ledger entry is already 'completed' (race, or a reversal
//     after a prior confirm) → write a compensating credit keyed by
//     `${payoutId}:reversal` so the unique (restaurant_id, ref_type,
//     ref_id) index prevents double-compensation on replay.
async function failPayout(payoutId, reason = 'provider_failed') {
  if (!payoutId) throw new Error('failPayout: payoutId required');
  const pid = String(payoutId);

  const settlement = await col(COLLECTION).findOne({ payout_id: pid });
  if (!settlement) {
    log.warn({ payoutId: pid }, 'failPayout.settlement_not_found');
    return { error: 'settlement_not_found' };
  }
  const rid = settlement.restaurant_id;
  const amount = settlement.payout_amount_paise;

  const entry = await col('restaurant_ledger').findOne({
    restaurant_id: rid, ref_type: 'payout', ref_id: pid,
  });

  if (entry?.status === 'completed') {
    // Compensating credit — restores balance, keyed for idempotency.
    try {
      await ledger.credit({
        restaurantId: rid,
        amountPaise: amount,
        refType: 'payout',
        refId: `${pid}:reversal`,
        status: 'completed',
        notes: `Reversal of failed payout ${pid}: ${reason}`,
      });
    } catch (err) {
      log.error({ err, payoutId: pid }, 'failPayout.compensating_credit_failed');
    }
  } else if (entry) {
    // Pending debit — just flip to failed so it stays out of the balance.
    await col('restaurant_ledger').updateOne(
      { _id: entry._id, status: 'pending' },
      { $set: { status: 'failed', updated_at: new Date(), notes: `Payout failed: ${reason}` } },
    );
  }

  await col(COLLECTION).updateOne(
    { _id: settlement._id, status: { $ne: 'completed' } },
    { $set: { status: 'failed', failure_reason: String(reason).slice(0, 500), processed_at: new Date() } },
  );

  log.warn({ payoutId: pid, settlementId: settlement._id, reason }, 'settlement.payout.failed_confirmed');
  return { success: true, settlement_id: settlement._id, payout_id: pid, reason };
}

// ─── 5b. TIMEOUT ────────────────────────────────────────────
// Flip settlements stuck in 'processing' beyond SETTLEMENT_TIMEOUT_MS
// to 'failed'. Un-reserves the pending ledger debit via failPayout.
// Called by the daily cron before fresh settlements are opened.
async function timeoutStaleSettlements({ thresholdMs = SETTLEMENT_TIMEOUT_MS } = {}) {
  const cutoff = new Date(Date.now() - thresholdMs);
  const stale = await col(COLLECTION).find({
    status: 'processing',
    settlement_type: 'new',
    created_at: { $lt: cutoff },
  }).project({ _id: 1, payout_id: 1, restaurant_id: 1 }).toArray();

  let timedOut = 0;
  for (const s of stale) {
    try {
      if (s.payout_id) {
        await failPayout(s.payout_id, 'timeout');
      } else {
        // No payout ever reached Razorpay — just flip the row.
        await col(COLLECTION).updateOne(
          { _id: s._id, status: 'processing' },
          { $set: { status: 'failed', failure_reason: 'timeout', processed_at: new Date() } },
        );
      }
      timedOut++;
    } catch (err) {
      log.error({ err, settlementId: s._id }, 'settlement.timeout.error');
    }
  }

  if (stale.length) log.warn({ found: stale.length, timedOut, thresholdMs }, 'settlement.timeout.swept');
  return { found: stale.length, timedOut };
}

module.exports = {
  MIN_PAYOUT_PAISE,
  PAYOUT_RETRY_LIMIT,
  SETTLEMENT_TIMEOUT_MS,
  calculateSettlement,
  executeSettlement,
  retrySettlement,
  confirmPayout,
  failPayout,
  timeoutStaleSettlements,
};
