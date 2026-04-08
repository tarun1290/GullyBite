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
  const wallet = await col('waba_wallets').findOne({ restaurant_id: restaurantId });

  // For non-order messages, block if insufficient balance
  if (!isOrderLifecycle && wallet && wallet.balance_rs < amountRs) {
    return { charged: false, reason: 'insufficient_balance', balance: wallet?.balance_rs || 0 };
  }

  // Charge — even if it goes negative for order lifecycle
  const result = await col('waba_wallets').findOneAndUpdate(
    { restaurant_id: restaurantId },
    {
      $inc: { balance_rs: -amountRs, total_consumed_rs: amountRs },
      $set: { updated_at: new Date() },
    },
    { returnDocument: 'after' }
  );

  if (!result) return { charged: false, reason: 'no_wallet' };

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

  const negativeAmount = Math.abs(wallet.balance_rs);
  const gst = parseFloat((negativeAmount * GST_RATE).toFixed(2));

  // Reset balance to zero
  await col('waba_wallets').updateOne(
    { restaurant_id: restaurantId },
    { $set: { balance_rs: 0, updated_at: new Date() } }
  );

  await col('wallet_transactions').insertOne({
    _id: newId(),
    restaurant_id: restaurantId,
    type: 'settlement_deduction',
    amount_rs: -negativeAmount,
    balance_after_rs: 0,
    description: `Settlement recovery of negative balance ₹${negativeAmount.toFixed(2)}`,
    reference_id: null,
    created_at: new Date(),
  });

  return { deducted: negativeAmount, gst };
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
  debit,
  settleNegativeBalance,
  getTransactions,
  getMonthlySpend,
  sendLowBalanceAlert,
  getAllWallets,
  refund,
};
