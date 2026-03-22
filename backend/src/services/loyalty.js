// src/services/loyalty.js
// Customer Loyalty / Rewards Program

const { col, newId } = require('../config/database');

const TIERS = [
  { name: 'bronze',   min: 0 },
  { name: 'silver',   min: 500 },
  { name: 'gold',     min: 1500 },
  { name: 'platinum', min: 5000 },
];

const TIER_BENEFITS = {
  bronze:   '🥉 Bronze — 1 point per ₹10 spent',
  silver:   '🥈 Silver — 1 point per ₹10 + priority support',
  gold:     '🥇 Gold — 1 point per ₹10 + free delivery on orders over ₹500',
  platinum: '💎 Platinum — 1 point per ₹10 + free delivery + exclusive offers',
};

// ─── GET OR CREATE LOYALTY ───────────────────────────────────
const getOrCreateLoyalty = async (customerId, restaurantId) => {
  let doc = await col('loyalty_points').findOne({ customer_id: customerId, restaurant_id: restaurantId });
  if (doc) return doc;

  doc = {
    _id: newId(),
    customer_id: customerId,
    restaurant_id: restaurantId,
    points_balance: 0,
    lifetime_points: 0,
    tier: 'bronze',
    tier_updated_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
  };
  await col('loyalty_points').insertOne(doc);
  return doc;
};

// ─── CALCULATE TIER ──────────────────────────────────────────
const calcTier = (lifetimePoints) => {
  let tier = 'bronze';
  for (const t of TIERS) {
    if (lifetimePoints >= t.min) tier = t.name;
  }
  return tier;
};

// ─── EARN POINTS ─────────────────────────────────────────────
const earnPoints = async (customerId, restaurantId, orderId, orderTotalRs) => {
  const loyalty = await getOrCreateLoyalty(customerId, restaurantId);
  const pointsEarned = Math.floor(parseFloat(orderTotalRs) / 10);
  if (pointsEarned <= 0) return { pointsEarned: 0, newBalance: loyalty.points_balance, tierUpgraded: false, newTier: loyalty.tier };

  // Record transaction
  await col('loyalty_transactions').insertOne({
    _id: newId(),
    customer_id: customerId,
    restaurant_id: restaurantId,
    order_id: orderId,
    type: 'earn',
    points: pointsEarned,
    description: `Earned from order (₹${parseFloat(orderTotalRs).toFixed(0)})`,
    created_at: new Date(),
  });

  const newBalance = loyalty.points_balance + pointsEarned;
  const newLifetime = loyalty.lifetime_points + pointsEarned;
  const newTier = calcTier(newLifetime);
  const tierUpgraded = newTier !== loyalty.tier;

  const $set = {
    points_balance: newBalance,
    lifetime_points: newLifetime,
    tier: newTier,
    updated_at: new Date(),
  };
  if (tierUpgraded) $set.tier_updated_at = new Date();

  await col('loyalty_points').updateOne(
    { _id: loyalty._id },
    { $set }
  );

  return { pointsEarned, newBalance, tierUpgraded, newTier };
};

// ─── REDEEM POINTS ───────────────────────────────────────────
const redeemPoints = async (customerId, restaurantId, pointsToRedeem) => {
  const loyalty = await getOrCreateLoyalty(customerId, restaurantId);

  if (pointsToRedeem < 100) {
    return { error: 'Minimum 100 points required to redeem.' };
  }
  if (pointsToRedeem > loyalty.points_balance) {
    return { error: `You only have ${loyalty.points_balance} points. Not enough to redeem ${pointsToRedeem}.` };
  }

  const discountRs = Math.floor(pointsToRedeem / 10);

  await col('loyalty_transactions').insertOne({
    _id: newId(),
    customer_id: customerId,
    restaurant_id: restaurantId,
    order_id: null,
    type: 'redeem',
    points: -pointsToRedeem,
    description: `Redeemed for ₹${discountRs} discount`,
    created_at: new Date(),
  });

  await col('loyalty_points').updateOne(
    { _id: loyalty._id },
    { $set: { points_balance: loyalty.points_balance - pointsToRedeem, updated_at: new Date() } }
  );

  return { discountRs, pointsRedeemed: pointsToRedeem };
};

// ─── GET BALANCE ─────────────────────────────────────────────
const getBalance = async (customerId, restaurantId) => {
  const loyalty = await getOrCreateLoyalty(customerId, restaurantId);
  return {
    balance: loyalty.points_balance,
    tier: loyalty.tier,
    lifetimePoints: loyalty.lifetime_points,
  };
};

// ─── GET TIER BENEFITS ───────────────────────────────────────
const getTierBenefits = (tier) => TIER_BENEFITS[tier] || TIER_BENEFITS.bronze;

module.exports = { getOrCreateLoyalty, earnPoints, redeemPoints, getBalance, getTierBenefits, calcTier };
