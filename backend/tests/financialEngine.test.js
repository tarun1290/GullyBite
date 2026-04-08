// tests/financialEngine.test.js
// Tests for the centralized financial engine.

'use strict';

const { calculateCheckout, calculateReferralCommission, calculatePlatformRevenue, calculateRefundImpact, round2 } = require('../src/core/financialEngine');

describe('Financial Engine — Checkout', () => {
  const config = {
    delivery_fee_customer_pct: 100,
    menu_gst_mode: 'included',
    menu_gst_pct: 5,
    packaging_charge_rs: 20,
    packaging_gst_pct: 18,
  };

  test('basic order with no delivery, no discount', () => {
    const result = calculateCheckout(config, 500, 0, 0);
    expect(result.subtotal_rs).toBe(500);
    expect(result.food_gst_rs).toBe(0); // included mode
    expect(result.packaging_rs).toBe(20);
    expect(result.packaging_gst_rs).toBe(3.6);
    expect(result.customer_total_rs).toBe(523.6); // 500 + 20 + 3.6
  });

  test('extra GST mode adds food GST', () => {
    const extraConfig = { ...config, menu_gst_mode: 'extra' };
    const result = calculateCheckout(extraConfig, 500, 0, 0);
    expect(result.food_gst_rs).toBe(25); // 5% of 500
    expect(result.customer_total_rs).toBe(548.6); // 500 + 25 + 20 + 3.6
  });

  test('delivery fee split: 100% customer', () => {
    const result = calculateCheckout(config, 500, 50, 0);
    expect(result.customer_delivery_rs).toBe(50);
    expect(result.restaurant_delivery_rs).toBe(0);
    expect(result.customer_delivery_gst_rs).toBe(9); // 18% of 50
  });

  test('delivery fee split: 70% customer, 30% restaurant', () => {
    const splitConfig = { ...config, delivery_fee_customer_pct: 70 };
    const result = calculateCheckout(splitConfig, 500, 100, 0);
    expect(result.customer_delivery_rs).toBe(70);
    expect(result.restaurant_delivery_rs).toBe(30);
  });

  test('discount reduces customer total', () => {
    const result = calculateCheckout(config, 500, 0, 50);
    expect(result.discount_rs).toBe(50);
    expect(result.customer_total_rs).toBe(473.6); // 523.6 - 50
  });
});

describe('Financial Engine — Referral Commission', () => {
  test('7.5% of subtotal', () => {
    const result = calculateReferralCommission(200);
    expect(result.commission_percent).toBe(7.5);
    expect(result.commission_amount).toBe(15);
  });

  test('GST on commission (18%)', () => {
    const result = calculateReferralCommission(200);
    expect(result.gst_percent).toBe(18);
    expect(result.gst_amount).toBe(2.7); // 18% of 15
    expect(result.total_deduction).toBe(17.7); // 15 + 2.7
  });

  test('zero subtotal = zero commission', () => {
    const result = calculateReferralCommission(0);
    expect(result.commission_amount).toBe(0);
  });
});

describe('Financial Engine — Platform Revenue', () => {
  test('sums platform fee and referral fee', () => {
    const result = calculatePlatformRevenue(100, 37.5);
    expect(result.total_platform_revenue).toBe(137.5);
  });
});

describe('Financial Engine — Refund Impact', () => {
  test('refund without referral', () => {
    const result = calculateRefundImpact(500, 400, false);
    expect(result.refund_amount).toBe(500);
    expect(result.referral_commission_reversed).toBe(0);
    expect(result.settlement_impact).toBe(500);
  });

  test('refund with referral reverses commission', () => {
    const result = calculateRefundImpact(500, 400, true);
    expect(result.refund_amount).toBe(500);
    expect(result.referral_commission_reversed).toBe(30); // 7.5% of 400
    expect(result.referral_gst_reversed).toBe(5.4); // 18% of 30
    expect(result.settlement_impact).toBe(464.6); // 500 - 30 - 5.4
  });
});

describe('Financial Engine — round2', () => {
  test('rounds to 2 decimal places', () => {
    expect(round2(1.006)).toBe(1.01);
    expect(round2(1.004)).toBe(1);
    expect(round2(99.999)).toBe(100);
    expect(round2(0)).toBe(0);
    expect(round2(null)).toBe(0);
  });
});
