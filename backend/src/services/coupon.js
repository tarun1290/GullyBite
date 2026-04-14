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
// session (optional) — when called from a multi-doc transaction, pass the
// session so the usage bump rolls back with the parent txn on failure.
const incrementUsage = async (couponId, session = null) => {
  const opts = session ? { session } : {};
  await col('coupons').updateOne(
    { _id: couponId },
    { $inc: { usage_count: 1 }, $set: { updated_at: new Date() } },
    opts
  );
};

// ─── RECORD REDEMPTION ───────────────────────────────────────
// Tracks per-user coupon usage for per_user_limit enforcement.
const recordRedemption = async (couponId, customerId, orderId, session = null) => {
  if (!couponId || !customerId) return;
  const opts = session ? { session } : {};
  await col('coupon_redemptions').insertOne({
    _id: newId(),
    coupon_id: couponId,
    customer_id: customerId,
    order_id: orderId,
    redeemed_at: new Date(),
  }, opts).catch(e => log.warn({ err: e }, 'Redemption tracking failed'));
};

// ─── PAISE-NATIVE CHECKOUT-ENDPOINT HELPERS ──────────────────
// These back the WhatsApp Checkout endpoint (routes/checkout-endpoint.js).
// They operate in paise so the Meta Checkout response can be built
// without rupee→paise rounding at the edge.

const CODE_RE = /^[A-Z0-9_-]{1,20}$/;

// Create a coupon document. Accepts paise-denominated fields (preferred)
// and/or rupee-denominated fields for back-compat with the conversational
// flow. Both shapes are persisted so either reader keeps working.
async function createCoupon(input) {
  const {
    restaurant_id, code, coupon_id, description,
    discount_type, discount_value,
    min_order_paise, max_discount_paise,
    min_order_rs, max_discount_rs,
    valid_from, valid_until,
    is_active = true, usage_limit,
    per_user_limit, first_order_only = false, branch_ids,
  } = input || {};

  const normCode = String(code || '').toUpperCase().trim();
  if (!CODE_RE.test(normCode)) throw new Error('code must be uppercase alphanumeric (A-Z, 0-9, _, -), ≤20 chars');
  if (!['flat', 'percent', 'free_delivery'].includes(discount_type)) throw new Error('discount_type must be flat|percent|free_delivery');
  if (discount_type !== 'free_delivery' && !(Number(discount_value) > 0)) throw new Error('discount_value must be > 0');

  // Normalize both shapes so the conversational flow + checkout endpoint
  // both read the right amount regardless of which form the admin gave.
  const minRs = min_order_paise != null ? Number(min_order_paise) / 100 : (min_order_rs != null ? Number(min_order_rs) : null);
  const minPaise = minRs != null ? Math.round(minRs * 100) : null;
  const maxRs = max_discount_paise != null ? Number(max_discount_paise) / 100 : (max_discount_rs != null ? Number(max_discount_rs) : null);
  const maxPaise = maxRs != null ? Math.round(maxRs * 100) : null;

  const doc = {
    _id: newId(),
    restaurant_id: restaurant_id ? String(restaurant_id) : null,
    code: normCode,
    coupon_id: coupon_id || normCode.toLowerCase(),
    description: description || '',
    discount_type,
    discount_value: Number(discount_value) || 0,
    min_order_paise: minPaise,
    max_discount_paise: maxPaise,
    min_order_rs: minRs,
    max_discount_rs: maxRs,
    valid_from: valid_from ? new Date(valid_from) : null,
    valid_until: valid_until ? new Date(valid_until) : null,
    is_active: !!is_active,
    usage_limit: usage_limit != null ? Number(usage_limit) : null,
    usage_count: 0,
    per_user_limit: per_user_limit != null ? Number(per_user_limit) : null,
    first_order_only: !!first_order_only,
    branch_ids: Array.isArray(branch_ids) ? branch_ids.map(String) : null,
    created_at: new Date(),
    updated_at: new Date(),
  };

  await col('coupons').insertOne(doc);
  return { ...doc, id: String(doc._id) };
}

// Active coupons for a restaurant, respecting validity window. Used by
// the get_coupons sub_action to populate the WhatsApp coupon picker.
async function getActiveCouponsForRestaurant(restaurantId) {
  if (!restaurantId) return [];
  const now = new Date();
  const rows = await col('coupons').find({
    restaurant_id: String(restaurantId),
    is_active: true,
    $or: [{ valid_from: null }, { valid_from: { $lte: now } }],
    $and: [{ $or: [{ valid_until: null }, { valid_until: { $gte: now } }] }],
  }).toArray();
  return rows.filter(c => c.usage_limit == null || (c.usage_count || 0) < c.usage_limit);
}

async function getCouponByCode(restaurantId, code) {
  if (!restaurantId || !code) return null;
  return col('coupons').findOne({
    restaurant_id: String(restaurantId),
    code: String(code).toUpperCase().trim(),
  });
}

// Validate and compute discount in PAISE against a paise subtotal.
// Returns { valid, coupon, discountPaise, description, error? }.
// Does NOT mutate usage_count — that's incrementUsage() on successful payment.
async function applyCoupon({ restaurantId, code, subtotalPaise, customerId = null, branchId = null }) {
  if (!restaurantId) return { valid: false, error: 'restaurant required' };
  if (!code)         return { valid: false, error: 'code required' };
  if (!(subtotalPaise > 0)) return { valid: false, error: 'subtotal required' };

  const coupon = await getCouponByCode(restaurantId, code);
  if (!coupon || !coupon.is_active) return { valid: false, error: 'Invalid or inactive coupon' };

  const now = new Date();
  if (coupon.valid_from  && now < new Date(coupon.valid_from))  return { valid: false, error: 'Coupon not yet active' };
  if (coupon.valid_until && now > new Date(coupon.valid_until)) return { valid: false, error: 'Coupon has expired' };
  if (coupon.usage_limit != null && (coupon.usage_count || 0) >= coupon.usage_limit) {
    return { valid: false, error: 'Coupon usage limit reached' };
  }

  // Per-user limit (optional — only enforced when caller supplies customerId).
  if (customerId && coupon.per_user_limit != null && coupon.per_user_limit > 0) {
    const uses = await col('coupon_redemptions').countDocuments({ coupon_id: String(coupon._id), customer_id: customerId });
    if (uses >= coupon.per_user_limit) return { valid: false, error: 'You have already used this coupon' };
  }

  if (coupon.branch_ids?.length && branchId && !coupon.branch_ids.includes(String(branchId))) {
    return { valid: false, error: 'Coupon not valid for this outlet' };
  }

  const minPaise = coupon.min_order_paise != null
    ? coupon.min_order_paise
    : (coupon.min_order_rs != null ? Math.round(Number(coupon.min_order_rs) * 100) : 0);
  if (subtotalPaise < minPaise) {
    return { valid: false, error: `Minimum order ₹${(minPaise / 100).toFixed(0)} required` };
  }

  let discountPaise;
  if (coupon.discount_type === 'percent') {
    discountPaise = Math.round(subtotalPaise * (Number(coupon.discount_value) / 100));
    const capPaise = coupon.max_discount_paise != null
      ? coupon.max_discount_paise
      : (coupon.max_discount_rs != null ? Math.round(Number(coupon.max_discount_rs) * 100) : null);
    if (capPaise != null) discountPaise = Math.min(discountPaise, capPaise);
  } else if (coupon.discount_type === 'flat') {
    discountPaise = Math.round(Number(coupon.discount_value) * 100);
  } else {
    // free_delivery: no line-item discount; delivery is zeroed at the order layer.
    discountPaise = 0;
  }
  discountPaise = Math.min(discountPaise, subtotalPaise);

  return {
    valid: true,
    coupon: { ...coupon, id: String(coupon._id) },
    discountPaise,
    description: coupon.description || coupon.code,
  };
}

module.exports = {
  validateCoupon,
  calculateDiscount,
  resolveBestOffer,
  isCustomerFirstOrder,
  incrementUsage,
  recordRedemption,
  // Checkout-endpoint additions:
  createCoupon,
  getActiveCouponsForRestaurant,
  getCouponByCode,
  applyCoupon,
};
