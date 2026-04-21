'use strict';

// Unified loyalty engine. Owns loyalty_config + loyalty_points +
// loyalty_transactions.
//
//   - loyalty_config       — merchant-tunable knobs, gates is_active
//   - loyalty_points       — per-customer balance + lifetime +
//                            last_redemption_date (hot-path lookup)
//   - loyalty_transactions — append-only ledger; earn rows carry
//                            expires_at + remaining for FIFO expiry
//
// Earn rate is driven by config.points_per_rupee (default 0.1 —
// equivalent to the legacy "1pt per ₹10"). Points are awarded by
// the LOYALTY_AWARD durable job 30 min after DELIVERED; redemption
// is committed from the razorpay webhook after payment confirmation.

const { col, newId } = require('../config/database');
const log = require('../utils/logger').child({ component: 'loyalty-engine' });

// ─── CONFIG ──────────────────────────────────────────────────
// points_per_rupee=0.1 matches the legacy 1pt per ₹10 behaviour so
// existing lifetime balances continue to accrue at the same rate when
// a merchant flips is_active on.
const DEFAULT_CONFIG = Object.freeze({
  is_active: false,
  program_name: 'Loyalty Rewards',
  points_per_rupee: 0.1,
  first_order_multiplier: 2,
  birthday_week_multiplier: 3,
  referral_bonus_points: 50,
  min_points_to_redeem: 100,
  max_redemption_percent: 20,
  points_to_rupee_ratio: 10,
  max_redemptions_per_day: 1,
  points_expiry_days: 90,
  expiry_warning_days: 5,
});

const TXN_TYPES = ['earn', 'redeem', 'expire', 'manual_credit', 'referral_bonus'];

async function getConfig(restaurantId) {
  const doc = await col('loyalty_config').findOne({ restaurant_id: String(restaurantId) });
  if (!doc) return null;
  return { ...DEFAULT_CONFIG, ...doc };
}

async function ensureConfig(restaurantId) {
  const rid = String(restaurantId);
  const existing = await col('loyalty_config').findOne({ restaurant_id: rid });
  if (existing) return { ...DEFAULT_CONFIG, ...existing };
  const doc = {
    _id: newId(),
    restaurant_id: rid,
    ...DEFAULT_CONFIG,
    created_at: new Date(),
    updated_at: new Date(),
  };
  try {
    await col('loyalty_config').insertOne(doc);
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const after = await col('loyalty_config').findOne({ restaurant_id: rid });
    return { ...DEFAULT_CONFIG, ...after };
  }
  return doc;
}

async function updateConfig(restaurantId, patch) {
  const rid = String(restaurantId);
  await ensureConfig(rid);
  const $set = { updated_at: new Date() };
  const allowedKeys = Object.keys(DEFAULT_CONFIG);
  for (const k of allowedKeys) {
    if (!(k in patch)) continue;
    $set[k] = patch[k];
  }
  await col('loyalty_config').updateOne({ restaurant_id: rid }, { $set });
  return getConfig(rid);
}

// ─── CUSTOMER DOC ACCESS ─────────────────────────────────────

async function getOrCreateLoyalty(customerId, restaurantId) {
  const rid = String(restaurantId);
  const cid = String(customerId);
  let doc = await col('loyalty_points').findOne({ restaurant_id: rid, customer_id: cid });
  if (doc) return doc;
  doc = {
    _id: newId(),
    customer_id: cid,
    restaurant_id: rid,
    points_balance: 0,
    lifetime_points: 0,
    last_redemption_date: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
  try {
    await col('loyalty_points').insertOne(doc);
  } catch (err) {
    if (err?.code !== 11000) throw err;
    return col('loyalty_points').findOne({ restaurant_id: rid, customer_id: cid });
  }
  return doc;
}

// ─── BALANCE LOOKUP ──────────────────────────────────────────
async function getBalance(customerId, restaurantId) {
  const loyalty = await getOrCreateLoyalty(customerId, restaurantId);
  return {
    balance: Number(loyalty.points_balance) || 0,
  };
}

// ─── EARN ────────────────────────────────────────────────────
// Called from the durable LOYALTY_AWARD job (30 min after DELIVERED),
// NOT from the payment webhook. Idempotent on order_id + type='earn'.
async function earnPoints(customerId, restaurantId, orderId, orderTotalRs, isFirstOrder = false, isBirthdayWeek = false) {
  const cfg = await getConfig(restaurantId);
  if (!cfg || !cfg.is_active) {
    const loyalty = await getOrCreateLoyalty(customerId, restaurantId);
    return { points: 0, newBalance: loyalty.points_balance, skipped: 'program_inactive' };
  }

  const amount = Number(orderTotalRs) || 0;
  if (amount <= 0) {
    const loyalty = await getOrCreateLoyalty(customerId, restaurantId);
    return { points: 0, newBalance: loyalty.points_balance, skipped: 'zero_amount' };
  }

  // Idempotency: bail if we already logged an earn for this order.
  if (orderId) {
    const existing = await col('loyalty_transactions').findOne({
      restaurant_id: String(restaurantId),
      customer_id: String(customerId),
      order_id: String(orderId),
      type: 'earn',
    }, { projection: { _id: 1 } });
    if (existing) {
      const loyalty = await getOrCreateLoyalty(customerId, restaurantId);
      return { points: 0, newBalance: loyalty.points_balance, skipped: 'duplicate' };
    }
  }

  const base = Math.floor(amount * (Number(cfg.points_per_rupee) || 0));
  let multiplier = 1;
  if (isBirthdayWeek) multiplier = Math.max(multiplier, Number(cfg.birthday_week_multiplier) || 1);
  if (isFirstOrder)   multiplier = Math.max(multiplier, Number(cfg.first_order_multiplier) || 1);
  const points = Math.floor(base * multiplier);
  if (points <= 0) {
    const loyalty = await getOrCreateLoyalty(customerId, restaurantId);
    return { points: 0, newBalance: loyalty.points_balance, skipped: 'no_points' };
  }

  const loyalty = await getOrCreateLoyalty(customerId, restaurantId);
  const newBalance  = (Number(loyalty.points_balance) || 0) + points;
  const newLifetime = (Number(loyalty.lifetime_points) || 0) + points;
  const expiresAt = new Date(Date.now() + (Number(cfg.points_expiry_days) || 90) * 24 * 60 * 60 * 1000);
  const description = isFirstOrder
    ? `First-order bonus (x${multiplier}) on ₹${amount.toFixed(0)}`
    : isBirthdayWeek
      ? `Birthday-week bonus (x${multiplier}) on ₹${amount.toFixed(0)}`
      : `Earned from order (₹${amount.toFixed(0)})`;

  await col('loyalty_transactions').insertOne({
    _id: newId(),
    restaurant_id: String(restaurantId),
    customer_id: String(customerId),
    order_id: orderId ? String(orderId) : null,
    type: 'earn',
    points,
    balance_after: newBalance,
    remaining: points,
    expires_at: expiresAt,
    description,
    created_at: new Date(),
  });

  await col('loyalty_points').updateOne(
    { _id: loyalty._id },
    { $set: {
        points_balance: newBalance,
        lifetime_points: newLifetime,
        updated_at: new Date(),
      } },
  );

  return { points, newBalance };
}

// ─── REDEMPTION OFFER ────────────────────────────────────────
async function getRedemptionOffer({ restaurantId, customerId, cartTotalRs }) {
  const cfg = await getConfig(restaurantId);
  if (!cfg || !cfg.is_active) return null;

  const cart = Number(cartTotalRs) || 0;
  if (cart <= 0) return null;

  const loyalty = await col('loyalty_points').findOne({
    restaurant_id: String(restaurantId),
    customer_id: String(customerId),
  });
  if (!loyalty) return null;

  const balance = Number(loyalty.points_balance) || 0;
  if (balance < (Number(cfg.min_points_to_redeem) || 0)) {
    return { eligible: false, reason: 'below_minimum', balance };
  }

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  if (loyalty.last_redemption_date && new Date(loyalty.last_redemption_date) >= todayStart) {
    const redeemedToday = await col('loyalty_transactions').countDocuments({
      restaurant_id: String(restaurantId),
      customer_id: String(customerId),
      type: 'redeem',
      created_at: { $gte: todayStart },
    });
    if (redeemedToday >= (Number(cfg.max_redemptions_per_day) || 1)) {
      return { eligible: false, reason: 'daily_cap', balance };
    }
  }

  const maxDiscountPct = Math.max(0, Math.min(100, Number(cfg.max_redemption_percent) || 0));
  const maxDiscountRs  = Math.floor(cart * maxDiscountPct / 100);
  if (maxDiscountRs <= 0) return { eligible: false, reason: 'no_discount_available', balance };

  const ratio = Math.max(1, Number(cfg.points_to_rupee_ratio) || 1);
  const maxPointsByCart    = maxDiscountRs * ratio;
  const maxPointsByBalance = balance;
  const pointsToRedeem = Math.min(maxPointsByCart, maxPointsByBalance);
  const discountRs     = Math.floor(pointsToRedeem / ratio);

  if (pointsToRedeem < (Number(cfg.min_points_to_redeem) || 0) || discountRs <= 0) {
    return { eligible: false, reason: 'below_minimum', balance };
  }

  return {
    eligible: true,
    balance,
    points_to_redeem: pointsToRedeem,
    discount_rs: discountRs,
    max_redemption_percent: maxDiscountPct,
  };
}

// ─── REDEEM ──────────────────────────────────────────────────
async function redeemPoints(customerId, restaurantId, orderId, pointsToDeduct, discountRs) {
  const points = Number(pointsToDeduct) || 0;
  if (points <= 0) return { ok: false, reason: 'invalid_points' };

  const cfg = await getConfig(restaurantId);
  if (!cfg || !cfg.is_active) return { ok: false, reason: 'program_inactive' };

  const loyalty = await getOrCreateLoyalty(customerId, restaurantId);
  if ((Number(loyalty.points_balance) || 0) < points) {
    return { ok: false, reason: 'insufficient_balance' };
  }

  const earnRows = await col('loyalty_transactions').find({
    restaurant_id: String(restaurantId),
    customer_id: String(customerId),
    type: { $in: ['earn', 'manual_credit', 'referral_bonus'] },
    remaining: { $gt: 0 },
  }).sort({ expires_at: 1, created_at: 1 }).toArray();

  let toTake = points;
  const writes = [];
  for (const row of earnRows) {
    if (toTake <= 0) break;
    const available = Number(row.remaining) || 0;
    if (available <= 0) continue;
    const take = Math.min(toTake, available);
    toTake -= take;
    writes.push({ _id: row._id, nextRemaining: available - take });
  }
  if (toTake > 0) return { ok: false, reason: 'insufficient_remaining' };

  for (const w of writes) {
    await col('loyalty_transactions').updateOne(
      { _id: w._id },
      { $set: { remaining: w.nextRemaining } },
    );
  }

  const ratio = Math.max(1, Number(cfg.points_to_rupee_ratio) || 1);
  const discountValueRs = Number(discountRs) > 0 ? Math.floor(Number(discountRs)) : Math.floor(points / ratio);
  const newBalance = (Number(loyalty.points_balance) || 0) - points;

  await col('loyalty_transactions').insertOne({
    _id: newId(),
    restaurant_id: String(restaurantId),
    customer_id: String(customerId),
    order_id: orderId ? String(orderId) : null,
    type: 'redeem',
    points: -points,
    balance_after: newBalance,
    description: `Redeemed ${points} pts for ₹${discountValueRs} discount`,
    created_at: new Date(),
  });

  await col('loyalty_points').updateOne(
    { _id: loyalty._id },
    {
      $set: {
        points_balance: newBalance,
        last_redemption_date: new Date(),
        updated_at: new Date(),
      },
    },
  );

  return { ok: true, discount_rs: discountValueRs, discountRs: discountValueRs, points_redeemed: points, pointsRedeemed: points, balance: newBalance };
}

// ─── MANUAL CREDIT ───────────────────────────────────────────

async function manualCredit({ restaurantId, customerId, points, description, actor }) {
  const p = Math.floor(Number(points) || 0);
  if (p <= 0) return { ok: false, reason: 'invalid_points' };

  const cfg = await getConfig(restaurantId);
  if (!cfg) return { ok: false, reason: 'no_config' };

  const loyalty = await getOrCreateLoyalty(customerId, restaurantId);
  const newBalance  = (Number(loyalty.points_balance) || 0) + p;
  const newLifetime = (Number(loyalty.lifetime_points) || 0) + p;
  const expiresAt = new Date(Date.now() + (Number(cfg.points_expiry_days) || 90) * 24 * 60 * 60 * 1000);

  await col('loyalty_transactions').insertOne({
    _id: newId(),
    restaurant_id: String(restaurantId),
    customer_id: String(customerId),
    order_id: null,
    type: 'manual_credit',
    points: p,
    balance_after: newBalance,
    remaining: p,
    expires_at: expiresAt,
    description: description || 'Manual credit',
    actor: actor || null,
    created_at: new Date(),
  });

  await col('loyalty_points').updateOne(
    { _id: loyalty._id },
    { $set: {
        points_balance: newBalance,
        lifetime_points: newLifetime,
        updated_at: new Date(),
      } },
  );

  return { ok: true, awarded: p, balance: newBalance };
}

// ─── REFERRAL BONUS ──────────────────────────────────────────

async function referralBonus({ restaurantId, customerId, description }) {
  const cfg = await getConfig(restaurantId);
  if (!cfg || !cfg.is_active) return { ok: false, reason: 'program_inactive' };
  const p = Math.floor(Number(cfg.referral_bonus_points) || 0);
  if (p <= 0) return { ok: false, reason: 'no_bonus' };

  const loyalty = await getOrCreateLoyalty(customerId, restaurantId);
  const newBalance  = (Number(loyalty.points_balance) || 0) + p;
  const newLifetime = (Number(loyalty.lifetime_points) || 0) + p;
  const expiresAt = new Date(Date.now() + (Number(cfg.points_expiry_days) || 90) * 24 * 60 * 60 * 1000);

  await col('loyalty_transactions').insertOne({
    _id: newId(),
    restaurant_id: String(restaurantId),
    customer_id: String(customerId),
    order_id: null,
    type: 'referral_bonus',
    points: p,
    balance_after: newBalance,
    remaining: p,
    expires_at: expiresAt,
    description: description || 'Referral bonus',
    created_at: new Date(),
  });

  await col('loyalty_points').updateOne(
    { _id: loyalty._id },
    { $set: {
        points_balance: newBalance,
        lifetime_points: newLifetime,
        updated_at: new Date(),
      } },
  );

  return { ok: true, awarded: p, balance: newBalance };
}

// ─── EXPIRE ──────────────────────────────────────────────────
async function expirePoints(restaurantId) {
  const now = new Date();
  const query = {
    type: { $in: ['earn', 'manual_credit', 'referral_bonus'] },
    remaining: { $gt: 0 },
    expires_at: { $lte: now },
  };
  if (restaurantId) query.restaurant_id = String(restaurantId);

  const expiredRows = await col('loyalty_transactions').find(query).toArray();
  if (expiredRows.length === 0) return { customers: 0, total_expired: 0 };

  const perCustomer = new Map();
  for (const row of expiredRows) {
    const key = `${row.restaurant_id}::${row.customer_id}`;
    const remaining = Number(row.remaining) || 0;
    if (remaining <= 0) continue;
    perCustomer.set(key, (perCustomer.get(key) || 0) + remaining);
  }

  await col('loyalty_transactions').updateMany(query, { $set: { remaining: 0 } });

  let totalExpired = 0;
  for (const [key, expired] of perCustomer.entries()) {
    const [rid, cid] = key.split('::');
    const loyalty = await col('loyalty_points').findOne({ restaurant_id: rid, customer_id: cid });
    if (!loyalty) continue;
    const newBalance = Math.max(0, (Number(loyalty.points_balance) || 0) - expired);

    await col('loyalty_transactions').insertOne({
      _id: newId(),
      restaurant_id: rid,
      customer_id: cid,
      order_id: null,
      type: 'expire',
      points: -expired,
      balance_after: newBalance,
      description: `Expired ${expired} pts`,
      created_at: now,
    });

    await col('loyalty_points').updateOne(
      { _id: loyalty._id },
      { $set: { points_balance: newBalance, updated_at: now } },
    );
    totalExpired += expired;
  }

  return { customers: perCustomer.size, total_expired: totalExpired };
}

// ─── LEDGER SUMMARY ──────────────────────────────────────────
async function getLedgerSummary({ restaurantId, customerId }) {
  const loyalty = await col('loyalty_points').findOne({
    restaurant_id: String(restaurantId),
    customer_id: String(customerId),
  });
  if (!loyalty) {
    return {
      balance: 0, lifetime_points: 0,
      total_earned: 0, total_redeemed: 0, total_expired: 0,
      transactions: [], last_redemption_date: null,
    };
  }

  const txns = await col('loyalty_transactions').find({
    restaurant_id: String(restaurantId),
    customer_id: String(customerId),
  }).sort({ created_at: -1 }).limit(50).toArray();

  const totals = await col('loyalty_transactions').aggregate([
    { $match: { restaurant_id: String(restaurantId), customer_id: String(customerId) } },
    { $group: { _id: '$type', points: { $sum: '$points' } } },
  ]).toArray();
  let total_earned = 0, total_redeemed = 0, total_expired = 0;
  for (const t of totals) {
    if (t._id === 'earn' || t._id === 'manual_credit' || t._id === 'referral_bonus') total_earned += Math.max(0, t.points);
    else if (t._id === 'redeem') total_redeemed += Math.abs(t.points);
    else if (t._id === 'expire') total_expired  += Math.abs(t.points);
  }

  return {
    balance: Number(loyalty.points_balance) || 0,
    lifetime_points: Number(loyalty.lifetime_points) || 0,
    total_earned, total_redeemed, total_expired,
    last_redemption_date: loyalty.last_redemption_date || null,
    transactions: txns,
  };
}

// ─── JOURNEY HELPER: EXPIRING POINTS ─────────────────────────
async function findCustomersWithExpiringPoints({ restaurantId, daysBeforeExpiry }) {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + (Number(daysBeforeExpiry) || 5) * 24 * 60 * 60 * 1000);

  const rows = await col('loyalty_transactions').find({
    restaurant_id: String(restaurantId),
    type: { $in: ['earn', 'manual_credit', 'referral_bonus'] },
    remaining: { $gt: 0 },
    expires_at: { $gt: now, $lte: windowEnd },
  }).toArray();

  const perCustomer = new Map();
  for (const row of rows) {
    const cid = row.customer_id;
    const prev = perCustomer.get(cid) || 0;
    perCustomer.set(cid, prev + (Number(row.remaining) || 0));
  }
  if (perCustomer.size === 0) return [];

  const cids = Array.from(perCustomer.keys());
  const loyalties = await col('loyalty_points').find({
    restaurant_id: String(restaurantId),
    customer_id: { $in: cids },
  }).toArray();
  const balanceByCid = Object.fromEntries(loyalties.map((l) => [l.customer_id, Number(l.points_balance) || 0]));

  const out = [];
  for (const [cid, expiring] of perCustomer.entries()) {
    if (expiring <= 0) continue;
    out.push({
      customer_id: cid,
      expiring_points: expiring,
      balance: balanceByCid[cid] || 0,
    });
  }
  return out;
}

// ─── PROGRAM STATS ───────────────────────────────────────────
// Program-level rollups consumed by the Loyalty tab.
async function getStats(restaurantId) {
  const rid = String(restaurantId);

  const loyalties = await col('loyalty_points').find({ restaurant_id: rid }).toArray();
  let totalBalance = 0;
  let totalLifetime = 0;
  for (const l of loyalties) {
    totalBalance  += Number(l.points_balance) || 0;
    totalLifetime += Number(l.lifetime_points) || 0;
  }

  const allTimeRedeemed = await col('loyalty_transactions').aggregate([
    { $match: { restaurant_id: rid, type: 'redeem' } },
    { $group: { _id: null, points: { $sum: '$points' } } },
  ]).toArray();
  const totalRedeemed = Math.abs(allTimeRedeemed[0]?.points || 0);

  const cfg = await getConfig(rid);
  const ratio = Math.max(1, Number(cfg?.points_to_rupee_ratio) || 10);
  const estimatedLiabilityRs = Math.floor(totalBalance / ratio);
  const redemptionRate = totalLifetime > 0
    ? Math.round((totalRedeemed / totalLifetime) * 1000) / 10
    : 0;

  return {
    total_members: loyalties.length,
    total_points_issued: totalLifetime,
    total_points_redeemed: totalRedeemed,
    total_points_balance: totalBalance,
    estimated_liability_rs: estimatedLiabilityRs,
    redemption_rate: redemptionRate,
  };
}

module.exports = {
  DEFAULT_CONFIG,
  TXN_TYPES,
  getConfig,
  ensureConfig,
  updateConfig,
  getOrCreateLoyalty,
  getBalance,
  earnPoints,
  getRedemptionOffer,
  redeemPoints,
  manualCredit,
  referralBonus,
  expirePoints,
  getLedgerSummary,
  findCustomersWithExpiringPoints,
  getStats,
};
