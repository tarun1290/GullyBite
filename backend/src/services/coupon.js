// src/services/coupon.js
// Coupon validation, resolution, and lifecycle management.
//
// Supports:
//   - Restaurant coupons (restaurant_id scoped)
//   - Platform coupons (restaurant_id = null → applies to all)
//   - Campaign-linked coupons (campaign_id reference)
//   - Types: percent, flat, free_delivery
//   - Per-user usage limits (via coupon_redemptions collection)
//   - First-order-only coupons
//   - Outlet/branch scoping
//   - Best-offer auto-resolution

'use strict';

const { col, newId } = require('../config/database');
const { calculateCheckout } = require('../core/financialEngine');
const log = require('../utils/logger').child({ component: 'coupon' });

// ─── VALIDATE A SINGLE COUPON ────────────────────────────────
// Core validation: checks eligibility, calculates discount amount.
// Returns { valid, coupon, discountRs, message, reason }
const validateCoupon = async (code, restaurantId, subtotalRs, opts = {}) => {
  const { customerId = null, branchId = null, isFirstOrder = false } = opts;
  if (!code) return { valid: false, message: 'Invalid request', reason: 'no_code' };

  const now = new Date();
  const today = new Date(now.toISOString().slice(0, 10));

  // Match restaurant-specific OR platform-wide coupons
  const restaurantFilter = restaurantId
    ? { $or: [{ restaurant_id: restaurantId }, { restaurant_id: null }] }
    : { restaurant_id: null };

  const coupon = await col('coupons').findOne({
    ...restaurantFilter,
    code: code.trim().toUpperCase(),
    is_active: true,
    $or: [{ valid_from: null }, { valid_from: { $lte: today } }],
    $and: [
      { $or: [{ valid_until: null }, { valid_until: { $gte: today } }] },
    ],
  });

  if (!coupon) {
    return { valid: false, message: '❌ Invalid or expired coupon code. Please try again or type *SKIP* to continue without a coupon.', reason: 'not_found' };
  }

  // Global usage limit
  if (coupon.usage_limit != null && (coupon.usage_count || 0) >= coupon.usage_limit) {
    return { valid: false, message: '❌ This coupon has reached its usage limit.', reason: 'global_limit' };
  }

  // Per-user usage limit
  if (customerId && coupon.per_user_limit != null && coupon.per_user_limit > 0) {
    const userUses = await col('coupon_redemptions').countDocuments({
      coupon_id: String(coupon._id),
      customer_id: customerId,
    });
    if (userUses >= coupon.per_user_limit) {
      return { valid: false, message: '❌ You\'ve already used this coupon the maximum number of times.', reason: 'per_user_limit' };
    }
  }

  // First-order-only check
  if (coupon.first_order_only && !isFirstOrder) {
    return { valid: false, message: '❌ This coupon is for first orders only.', reason: 'first_order_only' };
  }

  // Branch/outlet scope
  if (coupon.branch_ids?.length && branchId) {
    if (!coupon.branch_ids.includes(branchId)) {
      return { valid: false, message: '❌ This coupon is not valid for this outlet.', reason: 'branch_scope' };
    }
  }

  // Minimum order amount
  if (subtotalRs < parseFloat(coupon.min_order_rs || 0)) {
    return {
      valid: false,
      message: `❌ This coupon requires a minimum order of ₹${parseFloat(coupon.min_order_rs).toFixed(0)}. Your subtotal is ₹${subtotalRs.toFixed(0)}.`,
      reason: 'min_order',
    };
  }

  // Calculate discount
  const discountRs = calculateDiscount(coupon, subtotalRs);

  const discountLabel = coupon.discount_type === 'percent'
    ? `${parseFloat(coupon.discount_value).toFixed(0)}% off`
    : coupon.discount_type === 'free_delivery'
      ? 'Free delivery'
      : `₹${parseFloat(coupon.discount_value).toFixed(0)} off`;

  return {
    valid: true,
    coupon: { ...coupon, id: String(coupon._id) },
    discountRs,
    freeDelivery: coupon.discount_type === 'free_delivery',
    message: `✅ Coupon *${coupon.code}* applied! You save ₹${discountRs.toFixed(0)} (${discountLabel}).`,
  };
};

// ─── CALCULATE DISCOUNT AMOUNT ───────────────────────────────
function calculateDiscount(coupon, subtotalRs) {
  let discountRs;
  if (coupon.discount_type === 'percent') {
    discountRs = subtotalRs * (parseFloat(coupon.discount_value) / 100);
    if (coupon.max_discount_rs) {
      discountRs = Math.min(discountRs, parseFloat(coupon.max_discount_rs));
    }
  } else if (coupon.discount_type === 'free_delivery') {
    discountRs = 0; // Delivery zeroed out separately in charge calculation
  } else {
    // flat
    discountRs = parseFloat(coupon.discount_value);
  }
  discountRs = Math.min(discountRs, subtotalRs);
  return parseFloat(discountRs.toFixed(2));
}

// ─── RESOLVE BEST OFFER ──────────────────────────────────────
// Simulates all eligible coupons against the current cart and returns
// the one that produces the LOWEST final payable total.
//
// Returns: { bestCoupon, allEligible[] } or { bestCoupon: null, allEligible: [] }
const resolveBestOffer = async (restaurantId, subtotalRs, deliveryFeeRs, restaurantConfig, opts = {}) => {
  const { customerId = null, branchId = null, isFirstOrder = false } = opts;

  const now = new Date();
  const today = new Date(now.toISOString().slice(0, 10));

  // Fetch all potentially eligible coupons (restaurant + platform)
  const restaurantFilter = restaurantId
    ? { $or: [{ restaurant_id: restaurantId }, { restaurant_id: null }] }
    : { restaurant_id: null };

  const candidates = await col('coupons').find({
    ...restaurantFilter,
    is_active: true,
    $or: [{ valid_from: null }, { valid_from: { $lte: today } }],
    $and: [
      { $or: [{ valid_until: null }, { valid_until: { $gte: today } }] },
    ],
  }).toArray();

  const eligible = [];

  for (const coupon of candidates) {
    // Global usage limit
    if (coupon.usage_limit != null && (coupon.usage_count || 0) >= coupon.usage_limit) continue;

    // Per-user limit
    if (customerId && coupon.per_user_limit != null && coupon.per_user_limit > 0) {
      const userUses = await col('coupon_redemptions').countDocuments({
        coupon_id: String(coupon._id),
        customer_id: customerId,
      });
      if (userUses >= coupon.per_user_limit) continue;
    }

    // First-order check
    if (coupon.first_order_only && !isFirstOrder) continue;

    // Branch scope
    if (coupon.branch_ids?.length && branchId && !coupon.branch_ids.includes(branchId)) continue;

    // Min order
    if (subtotalRs < parseFloat(coupon.min_order_rs || 0)) continue;

    // Simulate: what would the final total be with this coupon?
    const discountRs = calculateDiscount(coupon, subtotalRs);
    const effectiveDelivery = coupon.discount_type === 'free_delivery' ? 0 : deliveryFeeRs;
    const simulated = calculateCheckout(restaurantConfig, subtotalRs, effectiveDelivery, discountRs);

    eligible.push({
      coupon: { ...coupon, id: String(coupon._id) },
      discountRs,
      freeDelivery: coupon.discount_type === 'free_delivery',
      finalTotal: simulated.customer_total_rs,
      savings: subtotalRs + deliveryFeeRs - simulated.customer_total_rs + discountRs, // approximate user savings
      label: coupon.discount_type === 'percent'
        ? `${parseFloat(coupon.discount_value).toFixed(0)}% off${coupon.max_discount_rs ? ` (up to ₹${coupon.max_discount_rs})` : ''}`
        : coupon.discount_type === 'free_delivery'
          ? 'Free delivery'
          : `₹${parseFloat(coupon.discount_value).toFixed(0)} off`,
    });
  }

  // Sort by lowest final total (best for customer)
  eligible.sort((a, b) => a.finalTotal - b.finalTotal);

  return {
    bestCoupon: eligible.length > 0 ? eligible[0] : null,
    allEligible: eligible,
  };
};

// ─── CHECK IF FIRST ORDER ────────────────────────────────────
const isCustomerFirstOrder = async (customerId, restaurantId) => {
  if (!customerId) return true;
  const count = await col('orders').countDocuments({
    customer_id: customerId,
    restaurant_id: restaurantId,
    status: { $nin: ['CANCELLED'] },
  });
  return count === 0;
};

// ─── INCREMENT USAGE ──────────────────────────────────────────
// Called inside createOrder when a coupon is used.
const incrementUsage = async (couponId) => {
  await col('coupons').updateOne(
    { _id: couponId },
    { $inc: { usage_count: 1 }, $set: { updated_at: new Date() } }
  );
};

// ─── RECORD REDEMPTION ───────────────────────────────────────
// Tracks per-user coupon usage for per_user_limit enforcement.
const recordRedemption = async (couponId, customerId, orderId) => {
  if (!couponId || !customerId) return;
  await col('coupon_redemptions').insertOne({
    _id: newId(),
    coupon_id: couponId,
    customer_id: customerId,
    order_id: orderId,
    redeemed_at: new Date(),
  }).catch(e => log.warn({ err: e }, 'Redemption tracking failed'));
};

module.exports = {
  validateCoupon,
  calculateDiscount,
  resolveBestOffer,
  isCustomerFirstOrder,
  incrementUsage,
  recordRedemption,
};
