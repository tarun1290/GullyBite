// src/core/financialEngine.js
// ════════════════════════════════════════════════════════════════
// SINGLE FINANCIAL TRUTH MODULE
// ════════════════════════════════════════════════════════════════
// ALL financial calculations in the platform MUST go through this module.
// No other file should contain independent financial math.
//
// This module centralizes:
//   1. Checkout calculations (customer-facing order total)
//   2. Referral commission calculations
//   3. Settlement calculations (restaurant payout)
//   4. Refund impact calculations
//   5. Platform revenue calculations
//
// IMPORTANT: Formulas here are the EXACT same as what existed before.
// This is a centralization, NOT a rewrite. Do NOT change numbers.

'use strict';

const { FINANCE_CONFIG, getPlatformFeePercent, shouldDeductPlatformFee, shouldDeductPlatformFeeGst, isFirstBillingMonth } = require('../config/financeConfig');

// ─── ROUNDING ───────────────────────────────────────────────
// All financial values rounded to 2 decimal places (paise precision)
const round2 = (n) => Math.round((n || 0) * 100) / 100;

// ════════════════════════════════════════════════════════════════
// 1. CHECKOUT CALCULATION
// ════════════════════════════════════════════════════════════════
// Calculates what the CUSTOMER pays for an order.
// Called when cart is finalized, before payment.
//
// Input: restaurant config, food subtotal, delivery fee, discount
// Output: full breakdown — GST, delivery split, packaging, customer total
//
// FORMULA (unchanged from charges.js):
//   customer_total = subtotal + food_gst + customer_delivery + customer_delivery_gst
//                    + packaging + packaging_gst - discount

function calculateCheckout(restaurantConfig, subtotalRs, deliveryFeeRs = 0, discountRs = 0) {
  const {
    delivery_fee_customer_pct = 100,   // % of delivery fee paid by customer (rest absorbed by restaurant)
    menu_gst_mode             = 'included', // 'included' = GST baked into price, 'extra' = added on top
    menu_gst_pct              = 5,     // Food GST rate (5% for restaurants in India)
    packaging_charge_rs       = 0,     // Fixed packaging charge
    packaging_gst_pct         = 18,    // GST on packaging (18%)
  } = restaurantConfig;

  // ── Food GST ──────────────────────────────────────────────
  // 'included': GST is baked into menu prices — no extra charge shown
  // 'extra': GST added on top of subtotal — shown as separate line
  const foodGstRs = menu_gst_mode === 'extra'
    ? round2(subtotalRs * (menu_gst_pct / 100))
    : 0;

  // ── Delivery fee split ────────────────────────────────────
  // Total delivery fee is split between customer and restaurant.
  // Customer pays delivery_fee_customer_pct%, restaurant absorbs the rest.
  const deliveryTotal      = round2(deliveryFeeRs);
  const customerDeliveryRs = round2(deliveryTotal * (delivery_fee_customer_pct / 100));
  const restaurantDeliveryRs = round2(deliveryTotal - customerDeliveryRs);

  // GST on each party's delivery share (18% — standard Indian GST on services)
  const DELIVERY_GST_PCT = 18;
  const customerDeliveryGstRs  = round2(customerDeliveryRs  * (DELIVERY_GST_PCT / 100));
  const restaurantDeliveryGstRs = round2(restaurantDeliveryRs * (DELIVERY_GST_PCT / 100));

  // ── Packaging ─────────────────────────────────────────────
  const packagingRs    = round2(Number(packaging_charge_rs) || 0);
  const packagingGstRs = round2(packagingRs * (packaging_gst_pct / 100));

  // ── Customer total ────────────────────────────────────────
  const discount  = round2(Number(discountRs) || 0);
  const customerTotal = round2(
    subtotalRs + foodGstRs
    + customerDeliveryRs + customerDeliveryGstRs
    + packagingRs + packagingGstRs
    - discount
  );

  // ── Restaurant delivery deduction ─────────────────────────
  // At settlement, restaurant's share of delivery + GST is deducted
  const restaurantDeductionRs = round2(restaurantDeliveryRs + restaurantDeliveryGstRs);

  return {
    subtotal_rs: round2(subtotalRs),
    discount_rs: discount,
    delivery_fee_total_rs: deliveryTotal,
    food_gst_rs: foodGstRs,
    customer_delivery_rs: customerDeliveryRs,
    customer_delivery_gst_rs: customerDeliveryGstRs,
    restaurant_delivery_rs: restaurantDeliveryRs,
    restaurant_delivery_gst_rs: restaurantDeliveryGstRs,
    packaging_rs: packagingRs,
    packaging_gst_rs: packagingGstRs,
    customer_total_rs: customerTotal,
    restaurant_delivery_deduction_rs: restaurantDeductionRs,
  };
}

// ════════════════════════════════════════════════════════════════
// 2. REFERRAL COMMISSION CALCULATION
// ════════════════════════════════════════════════════════════════
// Calculates platform commission on referred orders.
// Commission is ONLY on food subtotal — NOT on delivery, packaging, taxes, or total.
//
// FORMULA: commission = subtotal × referral_fee_pct (default 7.5%)

function calculateReferralCommission(subtotalRs) {
  const pct = FINANCE_CONFIG.referralFeePercent; // 7.5 by default
  const commission = round2(subtotalRs * (pct / 100));
  return {
    base_amount: round2(subtotalRs),
    commission_percent: pct,
    commission_amount: commission,
    // GST on referral commission (charged to restaurant at settlement)
    gst_percent: FINANCE_CONFIG.gstReferralFeePct, // 18%
    gst_amount: round2(commission * (FINANCE_CONFIG.gstReferralFeePct / 100)),
    total_deduction: round2(commission + commission * (FINANCE_CONFIG.gstReferralFeePct / 100)),
  };
}

// ════════════════════════════════════════════════════════════════
// 3. SETTLEMENT CALCULATION
// ════════════════════════════════════════════════════════════════
// Calculates restaurant payout for a settlement period.
// Deducts: platform fee + GST, referral fee + GST, delivery share,
//          discounts, refunds, messaging charges, TDS.
//
// FORMULA (unchanged from settlement.js):
//   gross = food_revenue + food_gst + packaging + packaging_gst + delivery_collected + delivery_gst
//   preTdsNet = gross - platformFee - platformFeeGst - deliveryRestShare - deliveryRestGst
//               - discounts - refunds - referralFee - referralFeeGst - messagingCharges - messagingGst
//   netPayout = preTdsNet - tds

function calculateSettlement(restaurant, agg, refundTotal = 0, messagingChargesRs = 0, messagingChargesGst = 0, tdsAmount = 0) {
  const commissionRate = getPlatformFeePercent(restaurant) / 100;
  const firstMonth = isFirstBillingMonth(restaurant);

  // ── Platform fee (commission on food subtotal) ────────────
  // Calculated amount (what would be charged normally)
  const platformFeeCalculated = round2(agg.food_revenue_rs * commissionRate);
  const platformFeeGstCalculated = round2(platformFeeCalculated * FINANCE_CONFIG.gstPlatformFeePct / 100);

  // First-month exception: platform fee already collected in advance at onboarding
  const platformFee = shouldDeductPlatformFee(restaurant) ? platformFeeCalculated : 0;
  const platformFeeGst = shouldDeductPlatformFeeGst(restaurant) ? platformFeeGstCalculated : 0;

  // ── Referral fee GST (always applies, even in first month) ──
  const referralFeeGst = round2(agg.referral_fee_rs * FINANCE_CONFIG.gstReferralFeePct / 100);

  // ── Gross revenue (what customer paid) ────────────────────
  const grossRevenue = round2(
    agg.food_revenue_rs + agg.food_gst_collected_rs +
    agg.packaging_collected_rs + agg.packaging_gst_rs +
    agg.delivery_fee_collected_rs + agg.delivery_fee_cust_gst_rs
  );

  // ── Pre-TDS net (payout before tax deduction) ─────────────
  const preTdsNet = round2(
    grossRevenue
    - platformFee - platformFeeGst
    - agg.delivery_fee_rest_share_rs - agg.delivery_fee_rest_gst_rs
    - agg.discount_total_rs - refundTotal
    - agg.referral_fee_rs - referralFeeGst
    - messagingChargesRs - messagingChargesGst
  );

  // ── Net payout (after TDS) ────────────────────────────────
  const netPayout = round2(preTdsNet - tdsAmount);

  return {
    // Config used
    commission_rate_pct: commissionRate * 100,
    is_first_billing_month: firstMonth,

    // Platform fee
    platform_fee_rs: platformFee,
    platform_fee_gst_rs: platformFeeGst,
    platform_fee_calculated_rs: platformFeeCalculated,
    platform_fee_gst_calculated_rs: platformFeeGstCalculated,
    platform_fee_waived_first_month: firstMonth && !shouldDeductPlatformFee(restaurant),

    // Referral fee
    referral_fee_rs: agg.referral_fee_rs,
    referral_fee_gst_rs: referralFeeGst,

    // Totals
    gross_revenue_rs: grossRevenue,
    pre_tds_net_rs: preTdsNet,
    tds_amount_rs: tdsAmount,
    net_payout_rs: netPayout,

    // Pass-through for settlement document
    refund_total_rs: refundTotal,
    messaging_charges_rs: messagingChargesRs,
    messaging_charges_gst_rs: messagingChargesGst,
  };
}

// ════════════════════════════════════════════════════════════════
// 4. PLATFORM REVENUE CALCULATION
// ════════════════════════════════════════════════════════════════
// Calculates total platform revenue from an order or settlement.
// Platform earns: platform fee + referral fee (before GST — GST is pass-through)

function calculatePlatformRevenue(platformFeeRs, referralFeeRs) {
  return {
    platform_fee_revenue: round2(platformFeeRs),
    referral_fee_revenue: round2(referralFeeRs),
    total_platform_revenue: round2(platformFeeRs + referralFeeRs),
  };
}

// ════════════════════════════════════════════════════════════════
// 5. REFUND IMPACT CALCULATION
// ════════════════════════════════════════════════════════════════
// Calculates the financial impact of a refund on settlement.
// Refund reduces the gross revenue and therefore the net payout.
// If the order had a referral, the referral commission should also be reversed.

function calculateRefundImpact(orderTotalRs, orderSubtotalRs, hadReferral = false) {
  const refundAmount = round2(orderTotalRs);

  // Referral commission that should be reversed
  let referralReversal = 0;
  let referralGstReversal = 0;
  if (hadReferral) {
    const ref = calculateReferralCommission(orderSubtotalRs);
    referralReversal = ref.commission_amount;
    referralGstReversal = ref.gst_amount;
  }

  return {
    refund_amount: refundAmount,
    // Impact on settlement: refund reduces gross, commission reversal reduces deductions
    settlement_impact: round2(refundAmount - referralReversal - referralGstReversal),
    referral_commission_reversed: referralReversal,
    referral_gst_reversed: referralGstReversal,
  };
}

module.exports = {
  // Core calculations
  calculateCheckout,
  calculateReferralCommission,
  calculateSettlement,
  calculatePlatformRevenue,
  calculateRefundImpact,
  // Utility
  round2,
};
