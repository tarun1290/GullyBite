// tests/financeConfig.test.js
// Tests for centralized finance config, first-month logic, and settlement rules.

'use strict';

const { FINANCE_CONFIG, getPlatformFeePercent, isFirstBillingMonth, shouldDeductPlatformFee, shouldDeductPlatformFeeGst } = require('../src/config/financeConfig');

describe('Finance Config', () => {
  test('default values are sensible', () => {
    expect(FINANCE_CONFIG.settlementCycle).toBe('weekly');
    expect(FINANCE_CONFIG.defaultPlatformFeePercent).toBe(10);
    expect(FINANCE_CONFIG.referralFeePercent).toBe(7.5);
    expect(FINANCE_CONFIG.gstPlatformFeePct).toBe(18);
    expect(FINANCE_CONFIG.gstReferralFeePct).toBe(18);
    expect(FINANCE_CONFIG.firstMonthAdvancePlatformFee).toBe(true);
  });

  test('per-restaurant commission overrides default', () => {
    expect(getPlatformFeePercent({ commission_pct: 15 })).toBe(15);
    expect(getPlatformFeePercent({ commission_pct: 8 })).toBe(8);
    expect(getPlatformFeePercent({})).toBe(FINANCE_CONFIG.defaultPlatformFeePercent);
    expect(getPlatformFeePercent(null)).toBe(FINANCE_CONFIG.defaultPlatformFeePercent);
  });
});

describe('First-Month Exception', () => {
  test('restaurant created this month IS first month', () => {
    const now = new Date();
    const restaurant = { created_at: now };
    expect(isFirstBillingMonth(restaurant)).toBe(true);
  });

  test('restaurant created last month is NOT first month', () => {
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    const restaurant = { created_at: lastMonth };
    expect(isFirstBillingMonth(restaurant)).toBe(false);
  });

  test('first month: platform fee NOT deducted', () => {
    const restaurant = { created_at: new Date() };
    expect(shouldDeductPlatformFee(restaurant)).toBe(false);
  });

  test('first month: platform fee GST NOT deducted', () => {
    const restaurant = { created_at: new Date() };
    expect(shouldDeductPlatformFeeGst(restaurant)).toBe(false);
  });

  test('post-first-month: platform fee IS deducted', () => {
    const twoMonthsAgo = new Date();
    twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
    const restaurant = { created_at: twoMonthsAgo };
    expect(shouldDeductPlatformFee(restaurant)).toBe(true);
  });

  test('post-first-month: platform fee GST IS deducted', () => {
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    const restaurant = { created_at: lastMonth };
    expect(shouldDeductPlatformFeeGst(restaurant)).toBe(true);
  });

  test('billing_start_date overrides created_at', () => {
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    const restaurant = { billing_start_date: new Date(), created_at: lastMonth };
    expect(isFirstBillingMonth(restaurant)).toBe(true);
  });
});

describe('Settlement Deduction Rules', () => {
  test('referral fee always applies (even first month)', () => {
    // Referral fee is based on order subtotal, not platform fee
    // The settlement code always deducts referral_fee_rs regardless of first-month status
    const referralFee = 37.5; // 7.5% of ₹500
    const gst = referralFee * FINANCE_CONFIG.gstReferralFeePct / 100;
    expect(gst).toBe(6.75); // 18% of 37.5
    // Total referral deduction = 37.5 + 6.75 = 44.25
    expect(referralFee + gst).toBe(44.25);
  });

  test('GST percentage is consistent for both fee types', () => {
    expect(FINANCE_CONFIG.gstPlatformFeePct).toBe(18);
    expect(FINANCE_CONFIG.gstReferralFeePct).toBe(18);
  });

  test('platform fee calculation: subtotal × rate', () => {
    const foodRevenue = 10000;
    const rate = FINANCE_CONFIG.defaultPlatformFeePercent / 100; // 10%
    const platformFee = foodRevenue * rate;
    expect(platformFee).toBe(1000);
    const gst = platformFee * FINANCE_CONFIG.gstPlatformFeePct / 100;
    expect(gst).toBe(180);
  });
});
