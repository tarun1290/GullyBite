// src/services/coupon.js
// Coupon validation and application logic for WhatsApp order flow

const { col } = require('../config/database');

// ─── VALIDATE COUPON ──────────────────────────────────────────
// Returns { valid, coupon, discountRs, message }
const validateCoupon = async (code, restaurantId, subtotalRs) => {
  if (!code || !restaurantId) return { valid: false, message: 'Invalid request' };

  const now = new Date();
  const today = new Date(now.toISOString().slice(0, 10)); // midnight UTC

  const coupon = await col('coupons').findOne({
    restaurant_id: restaurantId,
    code: code.trim().toUpperCase(),
    is_active: true,
    $or: [{ valid_from: null }, { valid_from: { $lte: today } }],
    $and: [
      { $or: [{ valid_until: null }, { valid_until: { $gte: today } }] },
      { $or: [{ usage_limit: null }, { $expr: { $lt: ['$usage_count', '$usage_limit'] } }] },
    ],
  });

  if (!coupon) {
    return { valid: false, message: '❌ Invalid or expired coupon code. Please try again or type *SKIP* to continue without a coupon.' };
  }

  // Check usage limit manually since $expr may not work on all Atlas tiers
  if (coupon.usage_limit != null && (coupon.usage_count || 0) >= coupon.usage_limit) {
    return { valid: false, message: '❌ Invalid or expired coupon code. Please try again or type *SKIP* to continue without a coupon.' };
  }

  if (subtotalRs < parseFloat(coupon.min_order_rs || 0)) {
    return {
      valid: false,
      message: `❌ This coupon requires a minimum order of ₹${parseFloat(coupon.min_order_rs).toFixed(0)}. Your subtotal is ₹${subtotalRs.toFixed(0)}.`,
    };
  }

  let discountRs;
  if (coupon.discount_type === 'percent') {
    discountRs = subtotalRs * (parseFloat(coupon.discount_value) / 100);
    if (coupon.max_discount_rs) {
      discountRs = Math.min(discountRs, parseFloat(coupon.max_discount_rs));
    }
  } else {
    discountRs = parseFloat(coupon.discount_value);
  }

  discountRs = Math.min(discountRs, subtotalRs);
  discountRs = parseFloat(discountRs.toFixed(2));

  const discountLabel = coupon.discount_type === 'percent'
    ? `${parseFloat(coupon.discount_value).toFixed(0)}% off`
    : `₹${parseFloat(coupon.discount_value).toFixed(0)} off`;

  return {
    valid: true,
    coupon: { ...coupon, id: String(coupon._id) },
    discountRs,
    message: `✅ Coupon *${coupon.code}* applied! You save ₹${discountRs.toFixed(0)} (${discountLabel}).`,
  };
};

// ─── INCREMENT USAGE ──────────────────────────────────────────
// Called inside createOrder when a coupon is used.
const incrementUsage = async (couponId) => {
  await col('coupons').updateOne(
    { _id: couponId },
    { $inc: { usage_count: 1 }, $set: { updated_at: new Date() } }
  );
};

module.exports = { validateCoupon, incrementUsage };
