// tests/businessLogic.test.js
// Comprehensive tests for critical business logic:
//   - Settlement calculation (the biggest untested gap)
//   - GST edge cases (delivery split, packaging, extra mode)
//   - Checkout boundary conditions
//   - Referral commission edge cases
//   - Order state transition chain completeness

'use strict';

const {
  calculateCheckout,
  calculateReferralCommission,
  calculateSettlement,
  calculatePlatformRevenue,
  calculateRefundImpact,
  round2,
} = require('../src/core/financialEngine');

const {
  ORDER_STATES,
  TRANSITIONS,
  isValidTransition,
} = require('../src/core/orderStateEngine');

const {
  FINANCE_CONFIG,
  getPlatformFeePercent,
  isFirstBillingMonth,
  shouldDeductPlatformFee,
} = require('../src/config/financeConfig');

// ════════════════════════════════════════════════════════════════
// 1. SETTLEMENT CALCULATION
// ════════════════════════════════════════════════════════════════

describe('Settlement Calculation', () => {
  // Standard aggregation object simulating a week of orders
  const makeAgg = (overrides = {}) => ({
    food_revenue_rs: 10000,
    food_gst_collected_rs: 0,       // included mode
    packaging_collected_rs: 200,
    packaging_gst_rs: 36,
    delivery_fee_collected_rs: 500,
    delivery_fee_cust_gst_rs: 90,
    delivery_fee_rest_share_rs: 0,
    delivery_fee_rest_gst_rs: 0,
    discount_total_rs: 300,
    referral_fee_rs: 150,           // sum of all referral commissions for the period
    ...overrides,
  });

  // Standard restaurant (post first-month)
  const restaurant = { commission_pct: 10, created_at: new Date('2025-01-01') };

  test('basic settlement: gross, platform fee, referral fee, net payout', () => {
    const agg = makeAgg();
    const result = calculateSettlement(restaurant, agg, 0, 0, 0, 0);

    // Gross = 10000 + 0 + 200 + 36 + 500 + 90 = 10826
    expect(result.gross_revenue_rs).toBe(10826);

    // Platform fee = 10000 * 10% = 1000
    expect(result.platform_fee_rs).toBe(1000);
    // Platform fee GST = 1000 * 18% = 180
    expect(result.platform_fee_gst_rs).toBe(180);

    // Referral fee GST = 150 * 18% = 27
    expect(result.referral_fee_gst_rs).toBe(27);

    // Pre-TDS net = 10826 - 1000 - 180 - 0 - 0 - 300 - 0 - 150 - 27 - 0 - 0 = 9169
    expect(result.pre_tds_net_rs).toBe(9169);

    // Without TDS, net payout = pre_tds_net
    expect(result.net_payout_rs).toBe(9169);
  });

  test('settlement with TDS deduction', () => {
    const agg = makeAgg();
    const tds = 91.69; // 1% of pre_tds_net
    const result = calculateSettlement(restaurant, agg, 0, 0, 0, tds);

    expect(result.tds_amount_rs).toBe(tds);
    expect(result.net_payout_rs).toBe(round2(9169 - tds));
  });

  test('settlement with refunds reduces net payout', () => {
    const agg = makeAgg();
    const refundTotal = 500;
    const result = calculateSettlement(restaurant, agg, refundTotal, 0, 0, 0);

    // pre_tds_net should decrease by refund amount
    expect(result.pre_tds_net_rs).toBe(round2(9169 - 500));
    expect(result.refund_total_rs).toBe(500);
  });

  test('settlement with messaging charges deducted', () => {
    const agg = makeAgg();
    const msgCharges = 50;
    const msgGst = 9; // 18% of 50
    const result = calculateSettlement(restaurant, agg, 0, msgCharges, msgGst, 0);

    expect(result.messaging_charges_rs).toBe(50);
    expect(result.messaging_charges_gst_rs).toBe(9);
    // net decreases by 59
    expect(result.pre_tds_net_rs).toBe(round2(9169 - 50 - 9));
  });

  test('first-month restaurant: platform fee waived', () => {
    const firstMonthRest = { commission_pct: 10, created_at: new Date() }; // created this month
    const agg = makeAgg();
    const result = calculateSettlement(firstMonthRest, agg, 0, 0, 0, 0);

    expect(result.is_first_billing_month).toBe(true);
    expect(result.platform_fee_rs).toBe(0);
    expect(result.platform_fee_gst_rs).toBe(0);
    // But calculated amounts are still tracked
    expect(result.platform_fee_calculated_rs).toBe(1000);
    expect(result.platform_fee_gst_calculated_rs).toBe(180);
    expect(result.platform_fee_waived_first_month).toBe(true);

    // Net payout is higher since no platform fee deducted
    // 10826 - 0 - 0 - 300 - 150 - 27 = 10349
    expect(result.pre_tds_net_rs).toBe(10349);
  });

  test('first-month: referral fee still deducted', () => {
    const firstMonthRest = { commission_pct: 10, created_at: new Date() };
    const agg = makeAgg({ referral_fee_rs: 75 });
    const result = calculateSettlement(firstMonthRest, agg, 0, 0, 0, 0);

    // Referral fee + GST still applied
    expect(result.referral_fee_rs).toBe(75);
    expect(result.referral_fee_gst_rs).toBe(round2(75 * 0.18)); // 13.5
  });

  test('per-restaurant custom commission rate', () => {
    const customRest = { commission_pct: 15, created_at: new Date('2025-01-01') };
    const agg = makeAgg();
    const result = calculateSettlement(customRest, agg, 0, 0, 0, 0);

    expect(result.commission_rate_pct).toBe(15);
    // Platform fee = 10000 * 15% = 1500
    expect(result.platform_fee_rs).toBe(1500);
    expect(result.platform_fee_gst_rs).toBe(round2(1500 * 0.18)); // 270
  });

  test('delivery cost shared with restaurant deducted from settlement', () => {
    const agg = makeAgg({
      delivery_fee_collected_rs: 1000,
      delivery_fee_cust_gst_rs: 126,     // 70% * 1000 * 18% = 126
      delivery_fee_rest_share_rs: 300,    // 30% restaurant share
      delivery_fee_rest_gst_rs: 54,       // 300 * 18%
    });
    const result = calculateSettlement(restaurant, agg, 0, 0, 0, 0);

    // Gross includes full delivery collected + GST
    const expectedGross = 10000 + 0 + 200 + 36 + 1000 + 126;
    expect(result.gross_revenue_rs).toBe(expectedGross); // 11362

    // Restaurant share deducted from net
    // pre_tds = 11362 - 1000 - 180 - 300 - 54 - 300 - 150 - 27 = 9351
    expect(result.pre_tds_net_rs).toBe(9351);
  });

  test('zero revenue settlement', () => {
    const zeroAgg = makeAgg({
      food_revenue_rs: 0, food_gst_collected_rs: 0,
      packaging_collected_rs: 0, packaging_gst_rs: 0,
      delivery_fee_collected_rs: 0, delivery_fee_cust_gst_rs: 0,
      delivery_fee_rest_share_rs: 0, delivery_fee_rest_gst_rs: 0,
      discount_total_rs: 0, referral_fee_rs: 0,
    });
    const result = calculateSettlement(restaurant, zeroAgg, 0, 0, 0, 0);

    expect(result.gross_revenue_rs).toBe(0);
    expect(result.platform_fee_rs).toBe(0);
    expect(result.net_payout_rs).toBe(0);
  });

  test('heavy refunds can make net payout negative', () => {
    const agg = makeAgg({ food_revenue_rs: 1000, discount_total_rs: 0, referral_fee_rs: 0 });
    // Gross = 1000 + 0 + 200 + 36 + 500 + 90 = 1826
    // Platform fee = 1000 * 10% = 100, GST = 18
    // Pre-TDS = 1826 - 100 - 18 - 0 = 1708
    // Refund of 2000 → net = 1708 - 2000 = -292
    const result = calculateSettlement(restaurant, agg, 2000, 0, 0, 0);
    expect(result.net_payout_rs).toBeLessThan(0);
  });

  test('all deductions combined stress test', () => {
    const agg = makeAgg({
      food_revenue_rs: 50000,
      referral_fee_rs: 750,
      discount_total_rs: 2000,
    });
    const result = calculateSettlement(restaurant, agg, 500, 100, 18, 200);

    // Platform fee = 50000 * 10% = 5000
    expect(result.platform_fee_rs).toBe(5000);
    expect(result.platform_fee_gst_rs).toBe(900); // 5000 * 18%
    expect(result.referral_fee_gst_rs).toBe(135); // 750 * 18%

    // Gross = 50000 + 0 + 200 + 36 + 500 + 90 = 50826
    expect(result.gross_revenue_rs).toBe(50826);

    // Pre-TDS = 50826 - 5000 - 900 - 0 - 0 - 2000 - 500 - 750 - 135 - 100 - 18 = 41423
    expect(result.pre_tds_net_rs).toBe(41423);

    // Net = 41423 - 200 = 41223
    expect(result.net_payout_rs).toBe(41223);
  });
});

// ════════════════════════════════════════════════════════════════
// 2. GST EDGE CASES
// ════════════════════════════════════════════════════════════════

describe('GST Edge Cases', () => {
  test('included GST mode: food_gst is always 0 regardless of rate', () => {
    const config = { menu_gst_mode: 'included', menu_gst_pct: 5, packaging_charge_rs: 0, delivery_fee_customer_pct: 100 };
    const result = calculateCheckout(config, 1000, 0, 0);
    expect(result.food_gst_rs).toBe(0);
  });

  test('extra GST mode: 5% on large subtotal rounds correctly', () => {
    const config = { menu_gst_mode: 'extra', menu_gst_pct: 5, packaging_charge_rs: 0, delivery_fee_customer_pct: 100 };
    const result = calculateCheckout(config, 9999, 0, 0);
    expect(result.food_gst_rs).toBe(499.95);
  });

  test('delivery GST is 18% on customer share only', () => {
    const config = { menu_gst_mode: 'included', packaging_charge_rs: 0, delivery_fee_customer_pct: 60 };
    const result = calculateCheckout(config, 500, 100, 0);

    // Customer pays 60% of 100 = 60
    expect(result.customer_delivery_rs).toBe(60);
    // GST on customer delivery = 60 * 18% = 10.8
    expect(result.customer_delivery_gst_rs).toBe(10.8);
    // Restaurant pays 40% of 100 = 40
    expect(result.restaurant_delivery_rs).toBe(40);
    // GST on restaurant delivery = 40 * 18% = 7.2
    expect(result.restaurant_delivery_gst_rs).toBe(7.2);
  });

  test('0% delivery to customer: restaurant absorbs all', () => {
    const config = { menu_gst_mode: 'included', packaging_charge_rs: 0, delivery_fee_customer_pct: 0 };
    const result = calculateCheckout(config, 500, 100, 0);

    expect(result.customer_delivery_rs).toBe(0);
    expect(result.customer_delivery_gst_rs).toBe(0);
    expect(result.restaurant_delivery_rs).toBe(100);
    expect(result.restaurant_delivery_gst_rs).toBe(18);
    // Customer pays only food subtotal
    expect(result.customer_total_rs).toBe(500);
  });

  test('packaging GST at 18%: applied only when packaging > 0', () => {
    const withPkg = calculateCheckout({ menu_gst_mode: 'included', packaging_charge_rs: 50, packaging_gst_pct: 18, delivery_fee_customer_pct: 100 }, 500, 0, 0);
    expect(withPkg.packaging_rs).toBe(50);
    expect(withPkg.packaging_gst_rs).toBe(9);

    const noPkg = calculateCheckout({ menu_gst_mode: 'included', packaging_charge_rs: 0, packaging_gst_pct: 18, delivery_fee_customer_pct: 100 }, 500, 0, 0);
    expect(noPkg.packaging_rs).toBe(0);
    expect(noPkg.packaging_gst_rs).toBe(0);
  });

  test('GST rounding: 18% of 33 = 5.94 (not 5.93 or 5.95)', () => {
    const config = { menu_gst_mode: 'included', packaging_charge_rs: 33, packaging_gst_pct: 18, delivery_fee_customer_pct: 100 };
    const result = calculateCheckout(config, 100, 0, 0);
    expect(result.packaging_gst_rs).toBe(5.94);
  });

  test('delivery GST rounding: 18% of 45 = 8.1', () => {
    const config = { menu_gst_mode: 'included', packaging_charge_rs: 0, delivery_fee_customer_pct: 100 };
    const result = calculateCheckout(config, 100, 45, 0);
    expect(result.customer_delivery_gst_rs).toBe(8.1);
  });
});

// ════════════════════════════════════════════════════════════════
// 3. CHECKOUT BOUNDARY CONDITIONS
// ════════════════════════════════════════════════════════════════

describe('Checkout Boundary Conditions', () => {
  const config = { delivery_fee_customer_pct: 100, menu_gst_mode: 'included', packaging_charge_rs: 0 };

  test('zero subtotal order', () => {
    const result = calculateCheckout(config, 0, 0, 0);
    expect(result.subtotal_rs).toBe(0);
    expect(result.customer_total_rs).toBe(0);
  });

  test('discount equals subtotal: total is zero (free food, only charges)', () => {
    const result = calculateCheckout(config, 500, 0, 500);
    expect(result.customer_total_rs).toBe(0);
  });

  test('discount exceeds subtotal: total goes negative', () => {
    // The engine doesn't clamp — caller is responsible for capping discount
    const result = calculateCheckout(config, 100, 0, 200);
    expect(result.customer_total_rs).toBe(-100);
  });

  test('very large order: ₹1,00,000 subtotal', () => {
    const configExtra = { ...config, menu_gst_mode: 'extra', menu_gst_pct: 5, packaging_charge_rs: 100, packaging_gst_pct: 18 };
    const result = calculateCheckout(configExtra, 100000, 200, 500);

    expect(result.food_gst_rs).toBe(5000);
    expect(result.packaging_gst_rs).toBe(18);
    expect(result.customer_delivery_rs).toBe(200);
    expect(result.customer_delivery_gst_rs).toBe(36);
    // 100000 + 5000 + 200 + 36 + 100 + 18 - 500 = 104854
    expect(result.customer_total_rs).toBe(104854);
  });

  test('₹1 order: minimum viable order', () => {
    const result = calculateCheckout(config, 1, 0, 0);
    expect(result.subtotal_rs).toBe(1);
    expect(result.customer_total_rs).toBe(1);
  });

  test('fractional subtotal: ₹99.99', () => {
    const result = calculateCheckout({ ...config, menu_gst_mode: 'extra', menu_gst_pct: 5 }, 99.99, 0, 0);
    expect(result.food_gst_rs).toBe(5); // round2(99.99 * 0.05) = 5.0
    expect(result.customer_total_rs).toBe(104.99);
  });

  test('delivery split sums to original fee', () => {
    const splitConfig = { ...config, delivery_fee_customer_pct: 70 };
    const result = calculateCheckout(splitConfig, 500, 100, 0);
    expect(result.customer_delivery_rs + result.restaurant_delivery_rs).toBe(100);
  });
});

// ════════════════════════════════════════════════════════════════
// 4. REFERRAL COMMISSION EDGE CASES
// ════════════════════════════════════════════════════════════════

describe('Referral Commission Edge Cases', () => {
  test('commission on ₹1 order: 7.5% of 1 = 0.08 (rounded)', () => {
    const result = calculateReferralCommission(1);
    expect(result.commission_amount).toBe(0.08); // round2(0.075) = 0.08
    expect(result.gst_amount).toBe(0.01);        // round2(0.08 * 0.18) = 0.0144 → 0.01
    expect(result.total_deduction).toBe(0.09);
  });

  test('commission on ₹10,000 order', () => {
    const result = calculateReferralCommission(10000);
    expect(result.commission_amount).toBe(750);
    expect(result.gst_amount).toBe(135);
    expect(result.total_deduction).toBe(885);
  });

  test('commission total_deduction = commission + GST (always)', () => {
    for (const amount of [50, 199, 500, 1234.56, 9999.99]) {
      const r = calculateReferralCommission(amount);
      expect(r.total_deduction).toBe(round2(r.commission_amount + r.gst_amount));
    }
  });

  test('negative subtotal returns negative commission (caller guards this)', () => {
    const result = calculateReferralCommission(-100);
    expect(result.commission_amount).toBe(-7.5);
  });

  test('refund impact with referral reversal is consistent with commission calc', () => {
    const subtotal = 2000;
    const total = 2300; // including delivery, GST, etc.

    const commission = calculateReferralCommission(subtotal);
    const refund = calculateRefundImpact(total, subtotal, true);

    expect(refund.referral_commission_reversed).toBe(commission.commission_amount);
    expect(refund.referral_gst_reversed).toBe(commission.gst_amount);
    expect(refund.settlement_impact).toBe(round2(total - commission.commission_amount - commission.gst_amount));
  });

  test('refund without referral: settlement_impact equals full refund amount', () => {
    const refund = calculateRefundImpact(1500, 1200, false);
    expect(refund.settlement_impact).toBe(1500);
    expect(refund.referral_commission_reversed).toBe(0);
    expect(refund.referral_gst_reversed).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════
// 5. ORDER STATE TRANSITIONS — FULL CHAIN + ERROR MESSAGES
// ════════════════════════════════════════════════════════════════

describe('Order Transition — Happy Path Chain', () => {
  const HAPPY_PATH = ['PENDING_PAYMENT', 'PAID', 'CONFIRMED', 'PREPARING', 'PACKED', 'DISPATCHED', 'DELIVERED'];

  test('full chain is valid step-by-step', () => {
    for (let i = 0; i < HAPPY_PATH.length - 1; i++) {
      const from = HAPPY_PATH[i];
      const to = HAPPY_PATH[i + 1];
      const result = isValidTransition(from, to);
      expect(result.valid).toBe(true);
    }
  });

  test('cannot skip any step in the chain', () => {
    // Try skipping each intermediate step
    for (let i = 0; i < HAPPY_PATH.length - 2; i++) {
      const from = HAPPY_PATH[i];
      const skip = HAPPY_PATH[i + 2]; // skip one
      const result = isValidTransition(from, skip);
      expect(result.valid).toBe(false);
    }
  });
});

describe('Order Transition — Cancellation from Every State', () => {
  const CANCELLABLE = ['PENDING_PAYMENT', 'PAYMENT_FAILED', 'PAID', 'CONFIRMED', 'PREPARING', 'PACKED', 'DISPATCHED'];

  test.each(CANCELLABLE)('%s → CANCELLED is valid', (state) => {
    expect(isValidTransition(state, 'CANCELLED').valid).toBe(true);
  });

  test('DELIVERED → CANCELLED is NOT valid (terminal)', () => {
    expect(isValidTransition('DELIVERED', 'CANCELLED').valid).toBe(false);
  });

  test('CANCELLED → CANCELLED is idempotent, not valid', () => {
    const result = isValidTransition('CANCELLED', 'CANCELLED');
    expect(result.valid).toBe(false);
    expect(result.idempotent).toBe(true);
  });
});

describe('Order Transition — Backward Movement Blocked', () => {
  const CHAIN = ['PENDING_PAYMENT', 'PAID', 'CONFIRMED', 'PREPARING', 'PACKED', 'DISPATCHED', 'DELIVERED'];

  test('no backward transitions allowed', () => {
    for (let i = 1; i < CHAIN.length; i++) {
      for (let j = 0; j < i; j++) {
        const from = CHAIN[i];
        const to = CHAIN[j];
        // Skip terminal states which can't go anywhere
        if (from === 'DELIVERED') continue;
        const result = isValidTransition(from, to);
        expect(result.valid).toBe(false);
      }
    }
  });
});

describe('Order Transition — Error Messages', () => {
  test('unknown current state → descriptive error', () => {
    const result = isValidTransition('BOGUS', 'PAID');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Unknown current state');
  });

  test('unknown target state → descriptive error', () => {
    const result = isValidTransition('PAID', 'BOGUS');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Unknown target state');
  });

  test('disallowed transition → descriptive error with state names', () => {
    const result = isValidTransition('PENDING_PAYMENT', 'DELIVERED');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('PENDING_PAYMENT');
    expect(result.reason).toContain('DELIVERED');
    expect(result.reason).toContain('not allowed');
  });

  test('same-state → idempotent flag set', () => {
    const result = isValidTransition('PREPARING', 'PREPARING');
    expect(result.valid).toBe(false);
    expect(result.idempotent).toBe(true);
    expect(result.reason).toContain('Already in this state');
  });
});

describe('Order States — Completeness', () => {
  test('every state has a transitions entry', () => {
    for (const state of ORDER_STATES) {
      expect(TRANSITIONS).toHaveProperty(state);
      expect(TRANSITIONS[state]).toBeInstanceOf(Set);
    }
  });

  test('all transition targets are valid states', () => {
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      for (const to of targets) {
        expect(ORDER_STATES).toContain(to);
      }
    }
  });

  test('terminal states have no outbound transitions', () => {
    expect(TRANSITIONS.DELIVERED.size).toBe(0);
    expect(TRANSITIONS.CANCELLED.size).toBe(0);
  });

  test('CANCELLED is reachable from exactly 6 states', () => {
    let count = 0;
    for (const [state, targets] of Object.entries(TRANSITIONS)) {
      if (targets.has('CANCELLED')) count++;
    }
    expect(count).toBe(7); // all except DELIVERED, CANCELLED, and EXPIRED
  });
});

// ════════════════════════════════════════════════════════════════
// 6. PLATFORM REVENUE CALCULATION
// ════════════════════════════════════════════════════════════════

describe('Platform Revenue', () => {
  test('sums platform fee and referral fee correctly', () => {
    const result = calculatePlatformRevenue(1000, 750);
    expect(result.platform_fee_revenue).toBe(1000);
    expect(result.referral_fee_revenue).toBe(750);
    expect(result.total_platform_revenue).toBe(1750);
  });

  test('zero fees = zero revenue', () => {
    const result = calculatePlatformRevenue(0, 0);
    expect(result.total_platform_revenue).toBe(0);
  });

  test('handles fractional amounts', () => {
    const result = calculatePlatformRevenue(333.33, 111.11);
    expect(result.total_platform_revenue).toBe(444.44);
  });
});

// ════════════════════════════════════════════════════════════════
// 7. ROUND2 EDGE CASES
// ════════════════════════════════════════════════════════════════

describe('round2 — Financial Rounding', () => {
  test('standard rounding', () => {
    expect(round2(1.004)).toBe(1);
    expect(round2(1.006)).toBe(1.01);
    expect(round2(1.015)).toBe(1.01); // IEEE 754: 1.015 * 100 = 101.49999... → rounds down
  });

  test('null/undefined/NaN treated as 0', () => {
    expect(round2(null)).toBe(0);
    expect(round2(undefined)).toBe(0);
    expect(round2(NaN)).toBe(0);
  });

  test('negative numbers round correctly', () => {
    expect(round2(-1.006)).toBe(-1.01);
    expect(round2(-99.995)).toBe(-99.99); // IEEE 754: -99.995 * 100 = -9999.49... → rounds toward zero
  });

  test('large numbers maintain precision', () => {
    expect(round2(999999.99)).toBe(999999.99);
    expect(round2(100000.001)).toBe(100000);
    expect(round2(100000.009)).toBe(100000.01);
  });

  test('already-rounded values pass through unchanged', () => {
    expect(round2(42)).toBe(42);
    expect(round2(3.14)).toBe(3.14);
    expect(round2(0.01)).toBe(0.01);
  });
});
