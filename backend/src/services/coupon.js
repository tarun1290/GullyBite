// src/services/coupon.js
// Coupon validation and application logic for WhatsApp order flow

const db = require('../config/database');

// ─── VALIDATE COUPON ──────────────────────────────────────────
// Returns { valid, coupon, discountRs, message }
// Called when customer enters a coupon code during ORDER_REVIEW state.
const validateCoupon = async (code, restaurantId, subtotalRs) => {
  if (!code || !restaurantId) return { valid: false, message: 'Invalid request' };

  const { rows } = await db.query(
    `SELECT * FROM coupons
     WHERE restaurant_id = $1
       AND UPPER(code)   = UPPER($2)
       AND is_active     = TRUE
       AND (valid_from  IS NULL OR valid_from  <= CURRENT_DATE)
       AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)
       AND (usage_limit IS NULL OR used_count   < usage_limit)`,
    [restaurantId, code.trim()]
  );

  if (!rows.length) {
    return { valid: false, message: '❌ Invalid or expired coupon code. Please try again or type *SKIP* to continue without a coupon.' };
  }

  const coupon = rows[0];

  if (subtotalRs < parseFloat(coupon.min_order_rs)) {
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
    // flat discount
    discountRs = parseFloat(coupon.discount_value);
  }

  // Can't discount more than the subtotal
  discountRs = Math.min(discountRs, subtotalRs);
  discountRs = parseFloat(discountRs.toFixed(2));

  const discountLabel = coupon.discount_type === 'percent'
    ? `${parseFloat(coupon.discount_value).toFixed(0)}% off`
    : `₹${parseFloat(coupon.discount_value).toFixed(0)} off`;

  return {
    valid: true,
    coupon,
    discountRs,
    message: `✅ Coupon *${coupon.code}* applied! You save ₹${discountRs.toFixed(0)} (${discountLabel}).`,
  };
};

// ─── INCREMENT USAGE ──────────────────────────────────────────
// Called inside createOrder transaction when a coupon is used.
const incrementUsage = async (client, couponId) => {
  await client.query(
    'UPDATE coupons SET used_count = used_count + 1, updated_at = NOW() WHERE id = $1',
    [couponId]
  );
};

module.exports = { validateCoupon, incrementUsage };
