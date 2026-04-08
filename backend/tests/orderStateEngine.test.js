// tests/orderStateEngine.test.js
// Tests for the strict order state transition engine.

'use strict';

const { ORDER_STATES, TRANSITIONS, isValidTransition } = require('../src/core/orderStateEngine');

describe('Order State Engine — States', () => {
  test('has all expected states', () => {
    expect(ORDER_STATES).toContain('PENDING_PAYMENT');
    expect(ORDER_STATES).toContain('PAID');
    expect(ORDER_STATES).toContain('CONFIRMED');
    expect(ORDER_STATES).toContain('PREPARING');
    expect(ORDER_STATES).toContain('PACKED');
    expect(ORDER_STATES).toContain('DISPATCHED');
    expect(ORDER_STATES).toContain('DELIVERED');
    expect(ORDER_STATES).toContain('CANCELLED');
    expect(ORDER_STATES).toContain('PAYMENT_FAILED');
    expect(ORDER_STATES).toContain('EXPIRED');
    expect(ORDER_STATES).toHaveLength(10);
  });

  test('DELIVERED, CANCELLED, and EXPIRED are terminal', () => {
    expect(TRANSITIONS.DELIVERED.size).toBe(0);
    expect(TRANSITIONS.CANCELLED.size).toBe(0);
    expect(TRANSITIONS.EXPIRED.size).toBe(0);
  });

  test('PAYMENT_FAILED allows retry to PAID or expiry to EXPIRED', () => {
    expect(TRANSITIONS.PAYMENT_FAILED.has('PAID')).toBe(true);
    expect(TRANSITIONS.PAYMENT_FAILED.has('EXPIRED')).toBe(true);
    expect(TRANSITIONS.PAYMENT_FAILED.has('CANCELLED')).toBe(true);
  });
});

describe('Order State Engine — Valid Transitions', () => {
  test('PENDING_PAYMENT → PAID', () => {
    expect(isValidTransition('PENDING_PAYMENT', 'PAID').valid).toBe(true);
  });

  test('PAID → CONFIRMED', () => {
    expect(isValidTransition('PAID', 'CONFIRMED').valid).toBe(true);
  });

  test('CONFIRMED → PREPARING', () => {
    expect(isValidTransition('CONFIRMED', 'PREPARING').valid).toBe(true);
  });

  test('PREPARING → PACKED', () => {
    expect(isValidTransition('PREPARING', 'PACKED').valid).toBe(true);
  });

  test('PACKED → DISPATCHED', () => {
    expect(isValidTransition('PACKED', 'DISPATCHED').valid).toBe(true);
  });

  test('DISPATCHED → DELIVERED', () => {
    expect(isValidTransition('DISPATCHED', 'DELIVERED').valid).toBe(true);
  });

  // Cancellation from any non-terminal state
  test('PENDING_PAYMENT → CANCELLED', () => {
    expect(isValidTransition('PENDING_PAYMENT', 'CANCELLED').valid).toBe(true);
  });
  test('PAID → CANCELLED', () => {
    expect(isValidTransition('PAID', 'CANCELLED').valid).toBe(true);
  });
  test('CONFIRMED → CANCELLED', () => {
    expect(isValidTransition('CONFIRMED', 'CANCELLED').valid).toBe(true);
  });
  test('PREPARING → CANCELLED', () => {
    expect(isValidTransition('PREPARING', 'CANCELLED').valid).toBe(true);
  });
  test('DISPATCHED → CANCELLED', () => {
    expect(isValidTransition('DISPATCHED', 'CANCELLED').valid).toBe(true);
  });
});

describe('Order State Engine — Invalid Transitions', () => {
  test('cannot skip: PENDING_PAYMENT → CONFIRMED', () => {
    expect(isValidTransition('PENDING_PAYMENT', 'CONFIRMED').valid).toBe(false);
  });

  test('cannot skip: PAID → PREPARING', () => {
    expect(isValidTransition('PAID', 'PREPARING').valid).toBe(false);
  });

  test('cannot go backward: DELIVERED → DISPATCHED', () => {
    expect(isValidTransition('DELIVERED', 'DISPATCHED').valid).toBe(false);
  });

  test('cannot go backward: PAID → PENDING_PAYMENT', () => {
    expect(isValidTransition('PAID', 'PENDING_PAYMENT').valid).toBe(false);
  });

  test('cannot transition from terminal DELIVERED', () => {
    expect(isValidTransition('DELIVERED', 'CANCELLED').valid).toBe(false);
  });

  test('cannot transition from terminal CANCELLED', () => {
    expect(isValidTransition('CANCELLED', 'PAID').valid).toBe(false);
  });

  test('unknown states rejected', () => {
    expect(isValidTransition('INVALID', 'PAID').valid).toBe(false);
    expect(isValidTransition('PAID', 'INVALID').valid).toBe(false);
  });
});

describe('Order State Engine — Idempotency', () => {
  test('same state transition returns idempotent flag', () => {
    const result = isValidTransition('PAID', 'PAID');
    expect(result.valid).toBe(false);
    expect(result.idempotent).toBe(true);
  });

  test('DELIVERED → DELIVERED is idempotent', () => {
    const result = isValidTransition('DELIVERED', 'DELIVERED');
    expect(result.valid).toBe(false);
    expect(result.idempotent).toBe(true);
  });
});
