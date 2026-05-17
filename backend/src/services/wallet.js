// src/services/wallet.js
// Per-restaurant WABA messaging wallet — prepaid balance for Meta conversation charges.
// Order lifecycle messages are NEVER blocked by wallet balance.

'use strict';

const { col, newId } = require('../config/database');
const { logActivity } = require('./activityLog');
const log = require('../utils/logger').child({ component: 'Wallet' });

const GST_RATE = 0.18;

// ─── ENSURE WALLET EXISTS ────────────────────────────────────
async function ensureWallet(restaurantId) {
  const existing = await col('waba_wallets').findOne({ restaurant_id: restaurantId });
  if (existing) return existing;

  const now = new Date();
  const wallet = {
    _id: newId(),
    restaurant_id: restaurantId,
    balance_rs: 0,
    total_topped_up_rs: 0,
    total_consumed_rs: 0,
    low_balance_threshold_rs: 100,
    low_balance_alerted: false,
    status: 'active',
    created_at: now,
    updated_at: now,
  };
  await col('waba_wallets').insertOne(wallet);
  return wallet;
}

// ─── GET WALLET ──────────────────────────────────────────────
async function getWallet(restaurantId) {
  return col('waba_wallets').findOne({ restaurant_id: restaurantId });
}

// ─── CREDIT (ORDER PAYOUT) ──────────────────────────────────
// Credits the restaurant's share of a paid order to the same WABA
// wallet used for messaging charges. The event listener computes
// restaurant share = gross × (1 − commission_pct/100) and passes
// it here in rupees. Reuses the atomic $inc serialization point
// — concurrent webhooks can't race. Separate from `credit` (top-up)
// because we want a dedicated ledger type and do NOT reset
// `low_balance_alerted` here (an order_payout bringing balance
// above threshold will naturally re-arm the alert on the next dip).
async function creditOrderPayout(restaurantId, amountRs, orderId, description) {
  const amt = Number(amountRs);
  if (!restaurantId || !Number.isFinite(amt) || amt <= 0) return null;

  await ensureWallet(restaurantId);

  const result = await col('waba_wallets').findOneAndUpdate(
    { restaurant_id: restaurantId },
    {
      $inc: { balance_rs: amt },
      $set: { updated_at: new Date() },
    },
    { returnDocument: 'after' }
  );
  if (!result) return null;

  await col('wallet_transactions').insertOne({
    _id: newId(),
    restaurant_id: restaurantId,
    type: 'order_payout',
    amount_rs: amt,
    balance_after_rs: result.balance_rs,
    description: description || `Order payout ${orderId || ''}`.trim(),
    reference_id: orderId || null,
    created_at: new Date(),
  });

  // Arm the next low-balance alert if this credit pulls us back over
  // the threshold — matches the reset done in `credit`/top-up.
  if (result.low_balance_alerted && result.balance_rs >= result.low_balance_threshold_rs) {
    col('waba_wallets').updateOne(
      { restaurant_id: restaurantId },
      { $set: { low_balance_alerted: false } }
    ).catch(() => {});
  }

  return result;
}

// ─── CREDIT (TOP-UP) ────────────────────────────────────────
async function credit(restaurantId, amountRs, description, referenceId = null) {
  const result = await col('waba_wallets').findOneAndUpdate(
    { restaurant_id: restaurantId },
    {
      $inc: { balance_rs: amountRs, total_topped_up_rs: amountRs },
      $set: { low_balance_alerted: false, status: 'active', updated_at: new Date() },
    },
    { returnDocument: 'after' }
  );

  if (!result) return null;

  await col('wallet_transactions').insertOne({
    _id: newId(),
    restaurant_id: restaurantId,
    type: 'topup',
    amount_rs: amountRs,
    balance_after_rs: result.balance_rs,
    description,
    reference_id: referenceId,
    created_at: new Date(),
  });

  return result;
}

// ─── DEBIT (MESSAGING CHARGE) ────────────────────────────────
// Returns { charged, wallet } — charged is false only for marketing blocks
async function debit(restaurantId, amountRs, description, referenceId = null, { isOrderLifecycle = false } = {}) {
  // ── Atomic conditional debit ─────────────────────────────────
  // Previously this was findOne → JS-side balance check → separate
  // $inc. Two concurrent debits could both pass the stale-read
  // check and both $inc, overdrawing the wallet negative. Now the
  // balance guard lives inside the same atomic findOneAndUpdate so
  // the read-decrement is a single serialized op (mongodb v6 driver
  // returns the updated doc directly — null if the filter missed —
  // with NO `.value` wrapper).
  //
  // Order-lifecycle carve-out (UNCHANGED behavior): order lifecycle
  // messages are NEVER blocked by balance and are intentionally
  // allowed to drive the wallet negative (recovered later via
  // settleNegativeBalance). For that path we keep an UNCONDITIONAL
  // $inc — no `$gte` floor — so it still succeeds into negative.
  // Only the blockable (non-order-lifecycle) path gets the
  // `balance_rs >= amountRs` filter.
  const now = new Date();
  let result;

  if (isOrderLifecycle) {
    // Allowed to go negative — unconditional atomic $inc (no floor).
    result = await col('waba_wallets').findOneAndUpdate(
      { restaurant_id: restaurantId },
      {
        $inc: { balance_rs: -amountRs, total_consumed_rs: amountRs },
        $set: { updated_at: now },
      },
      { returnDocument: 'after' }
    );

    // null only when the wallet document does not exist.
    if (!result) return { charged: false, reason: 'no_wallet' };
  } else {
    // Blockable path — only debit if balance can cover it. The
    // `$gte: amountRs` filter makes the insufficient-balance check
    // atomic with the decrement.
    result = await col('waba_wallets').findOneAndUpdate(
      { restaurant_id: restaurantId, balance_rs: { $gte: amountRs } },
      {
        $inc: { balance_rs: -amountRs, total_consumed_rs: amountRs },
        $set: { updated_at: now },
      },
      { returnDocument: 'after' }
    );

    if (!result) {
      // Filter missed: either wallet missing OR balance < amountRs.
      // Preserve the EXACT pre-existing external contract — callers
      // (e.g. marketingCampaigns.js) branch on `debit?.charged` and
      // surface `reason: 'insufficient_balance'` + the balance. We
      // re-read to report the current balance, matching the old
      // `balance: wallet?.balance_rs || 0` shape (0 if no wallet).
      const wallet = await col('waba_wallets').findOne({ restaurant_id: restaurantId });
      if (!wallet) return { charged: false, reason: 'no_wallet' };
      return { charged: false, reason: 'insufficient_balance', balance: wallet?.balance_rs || 0 };
    }
  }

  await col('wallet_transactions').insertOne({
    _id: newId(),
    restaurant_id: restaurantId,
    type: 'deduction',
    amount_rs: -amountRs,
    balance_after_rs: result.balance_rs,
    description,
    reference_id: referenceId,
    created_at: new Date(),
  });

  // Check low balance threshold
  if (result.balance_rs < result.low_balance_threshold_rs && !result.low_balance_alerted) {
    col('waba_wallets').updateOne(
      { restaurant_id: restaurantId },
      { $set: { low_balance_alerted: true } }
    ).catch(() => {});

    // Fire-and-forget low balance alert
    sendLowBalanceAlert(restaurantId, result.balance_rs).catch(() => {});
  }

  return { charged: true, wallet: result };
}

// ─── SETTLEMENT DEDUCTION ────────────────────────────────────
// Recovers negative balance from settlement payout
async function settleNegativeBalance(restaurantId) {
  const wallet = await col('waba_wallets').findOne({ restaurant_id: restaurantId });
  if (!wallet || wallet.balance_rs >= 0) return { deducted: 0 };

  const observedNeg = wallet.balance_rs;          // negative, e.g. -42.50
  const negativeAmount = Math.abs(observedNeg);   // 42.50

  // ── Atomic conditional recovery (no clobber of concurrent credit) ──
  // Previously: findOne → updateOne({ $set: { balance_rs: 0 } }).
  // A top-up landing between the findOne and the absolute $set was
  // overwritten to 0 → the restaurant silently lost the top-up.
  //
  // Approach chosen: conditional `$inc` of +|observedNeg| guarded by
  // `balance_rs: { $lt: 0 }`, NOT an aggregation-pipeline
  // `$set: { balance_rs: 0 }`. Rationale: `$inc` composes additively
  // and therefore can NEVER clobber a concurrent credit:
  //   • If a credit lands AFTER our $inc → its own atomic $inc adds
  //     on top; net balance = credit amount. Correct.
  //   • If a credit lands BEFORE our $inc and the balance is now
  //     >= 0 → the `$lt: 0` filter misses, we do nothing, and the
  //     credit is fully preserved. We then re-derive the true
  //     recovered amount from the post-update doc so the audit row
  //     and return value never over-report.
  //   • If a credit lands BEFORE our $inc but balance is still < 0
  //     → filter matches; result = creditedBalance + |observedNeg|.
  //     The credit is NOT lost (it is part of the new balance); we
  //     report the amount actually moved by this op
  //     (post − pre), not the stale |observedNeg|.
  // An aggregation `$set: { balance_rs: 0 }` was rejected because in
  // the "credit landed but balance still < 0" case it would discard
  // that credit (overwrite to 0) — exactly the clobber we are fixing.
  const now = new Date();
  const updated = await col('waba_wallets').findOneAndUpdate(
    { restaurant_id: restaurantId, balance_rs: { $lt: 0 } },
    {
      $inc: { balance_rs: negativeAmount },
      $set: { updated_at: now },
    },
    { returnDocument: 'after' }
  );

  // Filter missed → a concurrent credit already lifted balance to
  // >= 0 between our read and write. Nothing recovered here; the
  // credit is fully intact. Preserve the existing "nothing to do"
  // return contract.
  if (!updated) return { deducted: 0 };

  // Report the amount THIS op actually moved (post − pre = the
  // applied $inc) so a concurrent credit is neither clobbered nor
  // double-counted. Equals negativeAmount in the no-race case.
  const recovered = parseFloat((updated.balance_rs - observedNeg).toFixed(2));
  const gst = parseFloat((recovered * GST_RATE).toFixed(2));

  await col('wallet_transactions').insertOne({
    _id: newId(),
    restaurant_id: restaurantId,
    type: 'settlement_deduction',
    amount_rs: -recovered,
    balance_after_rs: updated.balance_rs,
    description: `Settlement recovery of negative balance ₹${recovered.toFixed(2)}`,
    reference_id: null,
    created_at: new Date(),
  });

  return { deducted: recovered, gst };
}

// ─── GET TRANSACTIONS ────────────────────────────────────────
async function getTransactions(restaurantId, { limit = 50, offset = 0, type = null } = {}) {
  const filter = { restaurant_id: restaurantId };
  if (type) filter.type = type;
  const transactions = await col('wallet_transactions')
    .find(filter)
    .sort({ created_at: -1 })
    .skip(offset)
    .limit(limit)
    .toArray();
  return transactions;
}

// ─── GET MONTHLY SPEND ──────────────────────────────────────
async function getMonthlySpend(restaurantId) {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const result = await col('wallet_transactions').aggregate([
    { $match: { restaurant_id: restaurantId, type: 'deduction', created_at: { $gte: startOfMonth } } },
    { $group: { _id: null, total: { $sum: { $abs: '$amount_rs' } } } },
  ]).toArray();

  return result[0]?.total || 0;
}

// ─── BREAKDOWN TOTALS (for unified wallet UI) ───────────────
// Lifetime + current-month splits so the dashboard can show
// Earnings / Messages / Campaigns / Referrals without each widget
// doing its own aggregation. Debit types are summed in absolute
// rupees; credit types keep their natural positive sign.
const DEBIT_TYPES  = ['deduction', 'settlement_deduction', 'meta_marketing_charge', 'referral_commission'];
const CREDIT_TYPES = ['topup', 'refund', 'order_payout'];

async function getBreakdownTotals(restaurantId) {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const rows = await col('wallet_transactions').aggregate([
    { $match: { restaurant_id: restaurantId } },
    {
      $group: {
        _id: '$type',
        lifetime: { $sum: { $abs: '$amount_rs' } },
        month: {
          $sum: {
            $cond: [
              { $gte: ['$created_at', startOfMonth] },
              { $abs: '$amount_rs' },
              0,
            ],
          },
        },
      },
    },
  ]).toArray();

  const byType = Object.fromEntries(rows.map((r) => [r._id, r]));
  const sum = (types, key) => types.reduce((s, t) => s + (byType[t]?.[key] || 0), 0);

  return {
    total_order_payouts_rs:     byType.order_payout?.lifetime || 0,
    total_message_charges_rs:   sum(['deduction', 'settlement_deduction'], 'lifetime'),
    total_campaign_charges_rs:  byType.meta_marketing_charge?.lifetime || 0,
    total_referral_charges_rs:  byType.referral_commission?.lifetime || 0,
    total_topups_rs:            byType.topup?.lifetime || 0,
    total_refunds_rs:           byType.refund?.lifetime || 0,
    current_month_earnings_rs:  byType.order_payout?.month || 0,
    current_month_charges_rs:   sum(DEBIT_TYPES, 'month'),
    current_month_message_charges_rs:  sum(['deduction', 'settlement_deduction'], 'month'),
    current_month_campaign_charges_rs: byType.meta_marketing_charge?.month || 0,
    current_month_referral_charges_rs: byType.referral_commission?.month || 0,
  };
}

// Used by docs/tests — not exported as API but handy for consumers
// that want to know valid type buckets.
const TXN_TYPES = { CREDIT: CREDIT_TYPES, DEBIT: DEBIT_TYPES };

// ─── LOW BALANCE ALERT ──────────────────────────────────────
async function sendLowBalanceAlert(restaurantId, balanceRs) {
  try {
    const wa_acc = await col('whatsapp_accounts').findOne({ restaurant_id: restaurantId, is_active: true });
    if (!wa_acc?.manager_phone) return;

    const wa = require('./whatsapp');
    await wa.sendText(
      wa_acc.phone_number_id, wa_acc.access_token, wa_acc.manager_phone,
      `⚠️ Your GullyBite messaging wallet balance is low: ₹${balanceRs.toFixed(2)}\n\n` +
      `Top up from your dashboard to ensure uninterrupted service.\n` +
      `Log in → Payments → Wallet → Top Up`
    );
    logActivity({ actorType: 'system', action: 'wallet.low_balance_alert', category: 'billing', description: `Low balance alert sent (₹${balanceRs.toFixed(2)})`, restaurantId, severity: 'warning' });
  } catch (err) {
    log.error({ err }, 'Low balance alert failed');
  }
}

// ─── ADMIN: GET ALL WALLETS ─────────────────────────────────
async function getAllWallets() {
  return col('waba_wallets').find({}).sort({ balance_rs: 1 }).toArray();
}

// ─── ADMIN: REFUND ──────────────────────────────────────────
async function refund(restaurantId, amountRs, description) {
  const result = await col('waba_wallets').findOneAndUpdate(
    { restaurant_id: restaurantId },
    { $inc: { balance_rs: amountRs }, $set: { updated_at: new Date() } },
    { returnDocument: 'after' }
  );

  if (!result) return null;

  await col('wallet_transactions').insertOne({
    _id: newId(),
    restaurant_id: restaurantId,
    type: 'refund',
    amount_rs: amountRs,
    balance_after_rs: result.balance_rs,
    description,
    reference_id: null,
    created_at: new Date(),
  });

  return result;
}

module.exports = {
  ensureWallet,
  getWallet,
  credit,
  creditOrderPayout,
  debit,
  settleNegativeBalance,
  getTransactions,
  getMonthlySpend,
  getBreakdownTotals,
  TXN_TYPES,
  sendLowBalanceAlert,
  getAllWallets,
  refund,
};
