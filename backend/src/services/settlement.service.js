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
const { FINANCE_CONFIG, isFirstBillingMonth } = require('../config/financeConfig');
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
// Returns { gross, refunds, payouts, fees, net_balance, payable_amount } in paise.
//   gross          — Σ credits (payment + payout reversals, completed)
//   refunds        — Σ debits  (refund,  completed)
//   payouts        — Σ debits  (payout,  completed)
//   fees           — Σ debits  (platform_fee + platform_fee_gst + referral
//                    + referral_fee_gst + marketing + tds, completed)
//   net_balance    — gross − refunds − payouts − fees
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

  // Per-ref_type breakdown so the export / audit trail can show exactly
  // why a payable amount is what it is. `fees` rolls up every platform-side
  // deduction so net_balance matches the canonical credits − debits view
  // returned by ledger.balancePaise().
  let gross = 0, refunds = 0, payouts = 0, fees = 0;
  for (const row of agg) {
    const { type, ref_type } = row._id;
    if (type === 'credit' && ref_type === 'payment')          gross   += row.total;
    // includes payout reversal credits (failPayout compensating entries) so
    // a reversed payout restores the ledger balance instead of vanishing.
    if (type === 'credit' && ref_type === 'payout')           gross   += row.total;
    if (type === 'debit'  && ref_type === 'refund')           refunds += row.total;
    if (type === 'debit'  && ref_type === 'payout')           payouts += row.total;
    if (type === 'debit'  && ref_type === 'platform_fee')     fees    += row.total;
    if (type === 'debit'  && ref_type === 'platform_fee_gst') fees    += row.total;
    if (type === 'debit'  && ref_type === 'referral')         fees    += row.total;
    if (type === 'debit'  && ref_type === 'referral_fee_gst') fees    += row.total;
    if (type === 'debit'  && ref_type === 'marketing')        fees    += row.total;
    if (type === 'debit'  && ref_type === 'tds')              fees    += row.total;
    // Symmetric reversal credits restore the balance (e.g. cancelled GBREF
    // order writes credits with refType='referral'/'referral_fee_gst' and
    // refId '...:reversal'). Counting them as credits keeps net_balance
    // consistent with ledger.balancePaise().
    if (type === 'credit' && ref_type === 'referral')         gross   += row.total;
    if (type === 'credit' && ref_type === 'referral_fee_gst') gross   += row.total;
  }
  const net_balance = gross - refunds - payouts - fees;

  // In-flight settlement rows haven't written their ledger debit yet
  // (that happens on successful payout), so we reserve their amount
  // so two concurrent runs can't both pay out the same balance.
  // 'pending_manual_payout' is included so a row stuck awaiting an ops
  // bank transfer still reserves its balance — without it, a fresh
  // settlement could double-pay the same money (W1 from spot-check).
  const inflightAgg = await col(COLLECTION).aggregate([
    { $match: {
        restaurant_id: rid,
        status: { $in: ['pending', 'processing', 'pending_manual_payout'] },
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

  return { gross, refunds, payouts, fees, net_balance, payable_amount };
}

// ─── 1b. META MARKETING COST ────────────────────────────────
// Sum unsettled marketing_messages cost for a restaurant and return the
// frozen list of message _ids to deduct from the current settlement.
// `cost` on marketing_messages is stored in rupees (Number) — converted
// to paise here with round-half-up so totals are deterministic across runs.
async function _aggregateUnsettledMeta(restaurantId) {
  const rows = await col('marketing_messages').find({
    restaurant_id: String(restaurantId),
    settled: { $ne: true },
    cost: { $gt: 0 },
    status: { $in: ['sent', 'delivered'] },
  }).project({ _id: 1, cost: 1 }).toArray();

  let totalPaise = 0;
  const ids = [];
  for (const r of rows) {
    totalPaise += Math.round(Number(r.cost || 0) * 100);
    ids.push(r._id);
  }
  return { totalPaise, ids, count: ids.length };
}

// ─── 2. EXECUTE ─────────────────────────────────────────────
async function executeSettlement(restaurantId, { trigger = 'manual', payout_mode = 'auto' } = {}) {
  if (!restaurantId) throw new Error('executeSettlement: restaurantId required');
  const rid = String(restaurantId);
  const mode = payout_mode === 'manual' ? 'manual' : 'auto';
  log.info({ restaurantId: rid, trigger, payout_mode: mode }, 'settlement.start');

  // (14) Idempotency — one in-flight settlement at a time per tenant.
  const inflight = await col(COLLECTION).findOne({
    restaurant_id: rid,
    status: { $in: ['pending', 'processing'] },
  });
  if (inflight) {
    log.warn({ restaurantId: rid, settlementId: inflight._id, status: inflight.status }, 'settlement.skip.inflight');
    return { skipped: true, reason: 'inflight', settlement_id: inflight._id };
  }

  // Restaurant doc is needed up-front for first-month check + fund account
  // gating. Projection includes the three timestamps isFirstBillingMonth()
  // consults (billing_start_date → approved_at → created_at).
  const restaurant = await col('restaurants').findOne(
    { _id: rid },
    { projection: {
        business_name: 1, razorpay_fund_acct_id: 1,
        created_at: 1, approved_at: 1, billing_start_date: 1,
    } }
  );
  if (!restaurant) {
    log.warn({ restaurantId: rid }, 'settlement.skip.restaurant_not_found');
    return { skipped: true, reason: 'restaurant_not_found' };
  }

  const calc = await calculateSettlement(rid);

  // ── Monthly platform fee + GST (₹3,000/month + 18% = ₹3,540) ──
  // Deducted from the SECOND billing month onward. First month waives
  // BOTH (collected upfront at onboarding, GST-inclusive). Two separate
  // ledger debits — fee and GST — keyed for monthly idempotency:
  //   platform_fee     → ref_id '<rid>:YYYY-MM'
  //   platform_fee_gst → ref_id '<rid>:YYYY-MM:gst'
  // The unique (restaurant_id, ref_type, ref_id) ledger index means a
  // re-run within the same calendar month no-ops on both writes.
  // Each debit is the FULL amount even when the balance is short — the
  // ledger goes negative, the remainder is "carried" automatically into
  // next month's payout. The actual payout is clamped to >= 0 below.
  // IST month key — the platform's billing periods follow IST, not UTC.
  const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const monthKey = istNow.toISOString().slice(0, 7); // 'YYYY-MM'
  const platformFeePaise = FINANCE_CONFIG.subscriptionPricePaise;
  const platformFeeGstPaise = Math.round(platformFeePaise * FINANCE_CONFIG.gstRate);
  const platformFeeWaived = isFirstBillingMonth(restaurant);

  if (platformFeeWaived) {
    log.info({ restaurantId: rid, monthKey, platformFeePaise, platformFeeGstPaise },
      'platform_fee_gst: first month — both fee and GST waived');
  } else if (platformFeePaise > 0) {
    const monthRefId = `${rid}:${monthKey}`;
    try {
      await ledger.debit({
        restaurantId: rid,
        amountPaise: platformFeePaise,
        refType: 'platform_fee',
        refId: monthRefId,
        status: 'completed',
        notes: `Monthly platform subscription ₹${FINANCE_CONFIG.monthlyPlatformFeeRs} for ${monthKey}`,
      });
    } catch (err) {
      log.error({ err: err?.message, restaurantId: rid, monthKey }, 'settlement.platform_fee.debit_failed');
      // Continue — fee reconciliation can be done later. We'd rather
      // pay the merchant than block a settlement on a ledger blip.
    }
    if (platformFeeGstPaise > 0) {
      try {
        await ledger.debit({
          restaurantId: rid,
          amountPaise: platformFeeGstPaise,
          refType: 'platform_fee_gst',
          refId: `${monthRefId}:gst`,
          status: 'completed',
          notes: `GST ${FINANCE_CONFIG.gstPlatformFeePct}% on platform subscription for ${monthKey}`,
        });
      } catch (err) {
        log.error({ err: err?.message, restaurantId: rid, monthKey }, 'settlement.platform_fee_gst.debit_failed');
      }
    }
  }

  // Re-read the balance now that the platform fee debit (if any) has
  // landed. ledger.debit is idempotent per month, so a replay returns the
  // existing entry without changing balance — recalc is still correct.
  const postFeeCalc = await calculateSettlement(rid);

  // Meta (WhatsApp marketing) cost deduction. Frozen at settlement-row
  // creation so retries/confirm always reference the same message_ids.
  // Platform fee is already netted in the ledger balance — meta cost is
  // a separate, additive deduction (does NOT touch platform fee logic).
  const meta = await _aggregateUnsettledMeta(rid);
  let amount = Math.max(0, postFeeCalc.payable_amount - meta.totalPaise);

  // ── TDS withholding (Section 194O) ─────────────────────────────
  // Computed against the FY-cumulative net payouts: 1% with PAN, 5%
  // without, only on the portion above ₹5L threshold. financials.calculateTDS
  // reads previous settlements (period_end within current FY) and decides
  // whether and how much TDS applies to THIS settlement's net.
  // Pass the post-fee post-meta amount in rupees — that's the figure the
  // merchant would otherwise receive, which is what TDS is calculated on.
  // Idempotency: keyed by '<rid>:tds:YYYY-MM' (one TDS debit per restaurant
  // per calendar month, same monthKey as platform fee).
  const { calculateTDS } = require('./financials');
  const round2 = (n) => Math.round((n || 0) * 100) / 100;
  const netRsForTDS = round2(amount / 100);
  let tds = { applicable: false, rate: 0, amount: 0, section: null, hasPAN: false };
  if (amount > 0) {
    try {
      tds = await calculateTDS(rid, netRsForTDS);
    } catch (err) {
      log.error({ err: err?.message, restaurantId: rid }, 'settlement.tds.calc_failed');
      // Continue with tds.applicable=false. Better to under-withhold than
      // to block a settlement on a transient compute failure.
    }
  }
  if (tds.applicable && tds.amount > 0) {
    const tdsPaise = Math.round(tds.amount * 100);
    try {
      await ledger.debit({
        restaurantId: rid,
        amountPaise: tdsPaise,
        refType: 'tds',
        refId: `${rid}:tds:${monthKey}`,
        status: 'completed',
        notes: `TDS ${tds.rate}% u/s ${tds.section || '194O'} — FY cumulative ₹${tds.cumulative}`,
      });
    } catch (err) {
      log.error({ err: err?.message, restaurantId: rid, tdsAmount: tds.amount }, 'settlement.tds.debit_failed');
      // If the debit failed, do NOT subtract from amount — otherwise we'd
      // under-pay the merchant without a corresponding ledger entry.
      tds.applicable = false;
      tds.amount = 0;
    }
    if (tds.applicable) {
      amount = Math.max(0, amount - tdsPaise);
    }
  }

  if (amount < MIN_PAYOUT_PAISE) {
    log.info({
      restaurantId: rid, amount, threshold: MIN_PAYOUT_PAISE,
      payable: postFeeCalc.payable_amount,
      payable_pre_fee: calc.payable_amount,
      meta_cost_paise: meta.totalPaise, meta_count: meta.count,
      tds_amount_rs: tds.amount,
    }, 'settlement.skip.below_threshold');
    return {
      skipped: true, reason: 'below_threshold',
      payable_amount_paise: amount, threshold: MIN_PAYOUT_PAISE,
      meta_cost_paise: meta.totalPaise, meta_message_count: meta.count,
      tds_amount_rs: tds.amount,
    };
  }

  // Manual mode skips the payout API entirely — no fund account needed.
  if (mode === 'auto' && !restaurant?.razorpay_fund_acct_id) {
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
    // Rupee mirror of net_amount_paise — calculateTDS aggregates
    // settlements.net_payout_rs across the FY to detect the ₹5L threshold.
    // Without this field, Phase 5 rows are invisible to TDS computation
    // and the threshold is never crossed.
    net_payout_rs:        round2(amount / 100),
    total_amount_paise:   amount,     // alias, back-compat with prior turn
    // Platform fee snapshot — captured at settlement-row creation so the
    // export and audit trail show the exact amounts debited this cycle.
    // Both paise (canonical) and rs (display) forms — settlement-export
    // already reads platform_fee_rs / platform_fee_gst_rs.
    platform_fee_paise:     platformFeeWaived ? 0 : platformFeePaise,
    platform_fee_gst_paise: platformFeeWaived ? 0 : platformFeeGstPaise,
    platform_fee_rs:        platformFeeWaived ? 0 : (platformFeePaise / 100),
    platform_fee_gst_rs:    platformFeeWaived ? 0 : (platformFeeGstPaise / 100),
    platform_fee_month:     monthKey,
    platform_fee_waived:    platformFeeWaived,
    // TDS snapshot — captured at settlement-row creation. Settlement-export
    // already reads tds_amount_rs / tds_rate_pct / tds_section.
    tds_applicable:         tds.applicable,
    tds_rate:               tds.rate,
    tds_rate_pct:           tds.rate,            // alias for legacy export key
    tds_amount_rs:          tds.amount,
    tds_section:            tds.section,
    tds_pan_based:          tds.hasPAN ?? false,
    status: 'processing',
    payout_id: null,
    payout_provider: null,
    payout_mode: mode,
    external_reference: null,
    attempt_count: 0,
    last_attempt_at: null,
    trigger,
    // Meta marketing cost — frozen snapshot of unsettled message_ids and
    // their paise total at the moment this settlement row was created.
    // marketing_messages rows get settled=true + settlement_id only once
    // the payout succeeds (confirmPayout). A failed payout leaves them
    // unsettled so the next settlement picks them up again.
    meta_cost_total_paise: meta.totalPaise,
    meta_message_count: meta.count,
    meta_message_ids: meta.ids,
    created_at: now,
    processed_at: null,
    failure_reason: null,
  });

  // Manual mode: skip the provider loop. Reserve a synthetic payout_id
  // so confirmPayout/failPayout (keyed by payout_id) can address this
  // row, and write a pending ledger debit so balance stays reserved.
  if (mode === 'manual') {
    const manualPayoutId = `manual_${settlementId}`;
    await col(COLLECTION).updateOne(
      { _id: settlementId },
      { $set: { payout_id: manualPayoutId, payout_provider: 'manual', attempt_count: 1, last_attempt_at: now } },
    );
    try {
      await ledger.debit({
        restaurantId: rid,
        amountPaise: amount,
        refType: 'payout',
        refId: manualPayoutId,
        status: 'pending',
        notes: `Manual settlement ${settlementId}`,
      });
    } catch (ledgerErr) {
      log.error({ err: ledgerErr, settlementId, payoutId: manualPayoutId }, 'settlement.manual.ledger_debit_failed');
    }
    log.info({ settlementId, payoutId: manualPayoutId, amount }, 'settlement.manual.opened');
    return {
      success: true,
      confirmed: false,
      manual: true,
      settlement_id: settlementId,
      payout_id: manualPayoutId,
      payout_mode: 'manual',
      amount_paise: amount,
    };
  }

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
async function confirmPayout(payoutId, { externalReference = null } = {}) {
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

  const set = { status: 'completed', processed_at: new Date(), failure_reason: null };
  if (externalReference) set.external_reference = String(externalReference);
  await col(COLLECTION).updateOne(
    { _id: settlement._id, status: { $ne: 'completed' } },
    { $set: set },
  );

  // Mark the frozen marketing_messages as settled. Scoped to the
  // pre-computed message_ids so a concurrent send after row-creation
  // can't be accidentally swept in. Fire-and-forget — a failure here
  // must not flip the settlement back to non-completed; the row already
  // records meta_message_ids for manual reconciliation if needed.
  if (Array.isArray(settlement.meta_message_ids) && settlement.meta_message_ids.length) {
    try {
      await col('marketing_messages').updateMany(
        { _id: { $in: settlement.meta_message_ids }, settled: { $ne: true } },
        { $set: {
            settled: true,
            settlement_id: settlement._id,
            settled_at: new Date(),
        } },
      );
    } catch (mmErr) {
      log.error({
        err: mmErr, settlementId: settlement._id, count: settlement.meta_message_ids.length,
      }, 'settlement.mark_marketing_settled_failed');
    }
  }

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
