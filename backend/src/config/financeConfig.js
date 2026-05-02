// src/config/financeConfig.js
// Centralized finance configuration — single source of truth for all billing,
// settlement, fee, and tax calculations. All finance logic must read from here.
//
// Values can be overridden via environment variables. Change one value here
// to update ALL calculations across the platform.

'use strict';

const FINANCE_CONFIG = {
  // ── Settlement Cycle ──────────────────────────────────────
  settlementCycle: process.env.SETTLEMENT_CYCLE || 'weekly',       // 'weekly' | 'biweekly' | 'monthly'
  settlementDayOfWeek: parseInt(process.env.SETTLEMENT_DAY || '1'), // 0=Sun, 1=Mon, ..., 6=Sat

  // ── Platform Fee (commission on food revenue) ─────────────
  // Business model: ZERO commission on regular orders. Restaurants pay a
  // flat ₹3,000/month subscription instead (₹3,540/month all-in with 18%
  // GST). Per-restaurant override via restaurant.commission_pct still
  // takes priority for legacy / bespoke deals.
  defaultPlatformFeePercent: parseFloat(process.env.PLATFORM_FEE_PCT || '0'),

  // ── Monthly Platform Fee (flat subscription) ──────────────
  // ₹3,000/month per restaurant (+ 18% GST = ₹3,540 all-in). Deducted
  // from settlement starting the SECOND billing month — first month is
  // collected upfront at onboarding, see shouldDeductPlatformFee() /
  // isFirstBillingMonth() below.
  monthlyPlatformFeeRs: parseFloat(process.env.MONTHLY_PLATFORM_FEE_RS || '3000'),

  // ── Referral Fee ──────────────────────────────────────────
  // 7.5% commission ONLY on GBREF-referred orders, plus 18% GST on the
  // commission. NOT charged on regular orders. Untouched by the
  // zero-commission switch above.
  referralFeePercent: parseFloat(process.env.REFERRAL_FEE_PCT || '7.5'),

  // ── GST Rates ─────────────────────────────────────────────
  gstPlatformFeePct: parseFloat(process.env.GST_PLATFORM_FEE_PCT || '18'),
  gstReferralFeePct: parseFloat(process.env.GST_REFERRAL_FEE_PCT || '18'),
  gstFoodPct: parseFloat(process.env.GST_FOOD_PCT || '5'),
  gstPackagingPct: parseFloat(process.env.GST_PACKAGING_PCT || '18'),
  gstDeliveryPct: parseFloat(process.env.GST_DELIVERY_PCT || '18'),

  // ── TDS ───────────────────────────────────────────────────
  tdsRateWithPan: parseFloat(process.env.TDS_RATE_WITH_PAN || '1'),     // 194O
  tdsRateNoPan: parseFloat(process.env.TDS_RATE_NO_PAN || '5'),
  tdsThresholdRs: parseFloat(process.env.TDS_THRESHOLD_RS || '500000'), // ₹5 lakh annual
  tdsSection: '194O',

  // ── First-Month Exception ─────────────────────────────────
  // When true: first-month settlements skip platform fee + platform fee GST
  // (assumed collected in advance at onboarding)
  firstMonthAdvancePlatformFee: process.env.FIRST_MONTH_ADVANCE_PLATFORM_FEE !== 'false', // default true
  firstMonthAdvancePlatformFeeGst: process.env.FIRST_MONTH_ADVANCE_PLATFORM_FEE_GST !== 'false',
};

// ── Derived constants (do not override directly) ───────────────
// Alternate-unit aliases for the two values most commonly referenced
// outside this file. Derived from monthlyPlatformFeeRs and
// gstPlatformFeePct so an env override of either source value flows
// through without a second variable to keep in sync.
//   subscriptionPricePaise — paise form of the monthly subscription
//                            (default 300000 ↔ ₹3,000). Used by
//                            settlement.service for ledger entries.
//   gstRate                — decimal form of gstPlatformFeePct
//                            (default 0.18 ↔ 18%). Drop-in for any
//                            multiplier-style GST math.
FINANCE_CONFIG.subscriptionPricePaise = Math.round(FINANCE_CONFIG.monthlyPlatformFeeRs * 100);
FINANCE_CONFIG.gstRate = FINANCE_CONFIG.gstPlatformFeePct / 100;

/**
 * Get the effective platform fee percentage for a restaurant.
 * Per-restaurant override takes priority over default.
 */
function getPlatformFeePercent(restaurant) {
  if (restaurant?.commission_pct != null) return parseFloat(restaurant.commission_pct);
  return FINANCE_CONFIG.defaultPlatformFeePercent;
}

/**
 * Determine if a restaurant is in its first billing month.
 * Uses the restaurant's created_at or onboarded_at timestamp.
 */
function isFirstBillingMonth(restaurant) {
  const onboardDate = restaurant.billing_start_date || restaurant.approved_at || restaurant.created_at;
  if (!onboardDate) return false;

  const onboard = new Date(onboardDate);
  const now = new Date();

  // Same calendar month = first month
  return onboard.getFullYear() === now.getFullYear() && onboard.getMonth() === now.getMonth();
}

/**
 * Check if platform fee should be deducted for this settlement.
 * Returns false during first month if advance collection is configured.
 */
function shouldDeductPlatformFee(restaurant) {
  if (isFirstBillingMonth(restaurant) && FINANCE_CONFIG.firstMonthAdvancePlatformFee) {
    return false; // Already collected in advance
  }
  return true;
}

/**
 * Check if platform fee GST should be deducted for this settlement.
 */
function shouldDeductPlatformFeeGst(restaurant) {
  if (isFirstBillingMonth(restaurant) && FINANCE_CONFIG.firstMonthAdvancePlatformFeeGst) {
    return false;
  }
  return true;
}

module.exports = {
  FINANCE_CONFIG,
  getPlatformFeePercent,
  isFirstBillingMonth,
  shouldDeductPlatformFee,
  shouldDeductPlatformFeeGst,
};
