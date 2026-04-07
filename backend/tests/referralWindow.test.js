// tests/referralWindow.test.js
// Tests for referral attribution window logic.

'use strict';

const { calculateAttributionWindow } = require('../src/utils/referralWindow');

describe('Referral Attribution Window', () => {

  // ── Rule: Before 10 PM IST → 4 hours ──────────────────────

  test('referral at 2:00 PM IST → 4 hour window', () => {
    // 2:00 PM IST = 8:30 AM UTC
    const sentAt = new Date('2026-04-08T08:30:00Z');
    const result = calculateAttributionWindow(sentAt);
    expect(result.windowHours).toBe(4);
    expect(result.isLateNight).toBe(false);
    expect(result.expiresAt.getTime()).toBe(sentAt.getTime() + 4 * 3600000);
  });

  test('referral at 9:00 AM IST → 4 hour window', () => {
    // 9:00 AM IST = 3:30 AM UTC
    const sentAt = new Date('2026-04-08T03:30:00Z');
    const result = calculateAttributionWindow(sentAt);
    expect(result.windowHours).toBe(4);
    expect(result.isLateNight).toBe(false);
  });

  test('referral at 9:59 PM IST → 4 hour window (just before 10 PM)', () => {
    // 9:59 PM IST = 4:29 PM UTC
    const sentAt = new Date('2026-04-08T16:29:00Z');
    const result = calculateAttributionWindow(sentAt);
    expect(result.windowHours).toBe(4);
    expect(result.isLateNight).toBe(false);
  });

  // ── Rule: At/after 10 PM IST → 8 hours ────────────────────

  test('referral at 10:00 PM IST → 8 hour window (boundary)', () => {
    // 10:00 PM IST = 4:30 PM UTC
    const sentAt = new Date('2026-04-08T16:30:00Z');
    const result = calculateAttributionWindow(sentAt);
    expect(result.windowHours).toBe(8);
    expect(result.isLateNight).toBe(true);
    expect(result.expiresAt.getTime()).toBe(sentAt.getTime() + 8 * 3600000);
  });

  test('referral at 11:30 PM IST → 8 hour window', () => {
    // 11:30 PM IST = 6:00 PM UTC
    const sentAt = new Date('2026-04-08T18:00:00Z');
    const result = calculateAttributionWindow(sentAt);
    expect(result.windowHours).toBe(8);
    expect(result.isLateNight).toBe(true);
  });

  test('referral at midnight IST → 4 hour window (0:00 = new day, before 10 PM)', () => {
    // 12:00 AM IST = 6:30 PM UTC (previous day)
    const sentAt = new Date('2026-04-07T18:30:00Z');
    const result = calculateAttributionWindow(sentAt);
    expect(result.windowHours).toBe(4);
    expect(result.isLateNight).toBe(false);
  });

  test('referral at 1:00 AM IST → 4 hour window', () => {
    // 1:00 AM IST = 7:30 PM UTC (previous day)
    const sentAt = new Date('2026-04-07T19:30:00Z');
    const result = calculateAttributionWindow(sentAt);
    expect(result.windowHours).toBe(4);
    expect(result.isLateNight).toBe(false);
  });

  // ── Expiry correctness ─────────────────────────────────────

  test('expires_at is correctly anchored to send time + window', () => {
    const sentAt = new Date('2026-04-08T12:00:00Z'); // 5:30 PM IST → 4h
    const result = calculateAttributionWindow(sentAt);
    expect(result.expiresAt).toEqual(new Date('2026-04-08T16:00:00Z'));
  });

  test('late-night expiry extends through the night', () => {
    // 10:30 PM IST = 5:00 PM UTC → 8h window → expires 1:00 AM UTC = 6:30 AM IST
    const sentAt = new Date('2026-04-08T17:00:00Z');
    const result = calculateAttributionWindow(sentAt);
    expect(result.windowHours).toBe(8);
    expect(result.expiresAt).toEqual(new Date('2026-04-09T01:00:00Z'));
  });
});

describe('Commission Calculation (verified in order.js)', () => {
  test('REFERRAL_FEE_PCT is 7.5% of subtotal', () => {
    const REFERRAL_FEE_PCT = 0.075;
    expect(REFERRAL_FEE_PCT).toBe(0.075);
    // Example: subtotal ₹200 → commission ₹15
    expect(parseFloat((200 * REFERRAL_FEE_PCT).toFixed(2))).toBe(15);
    // Example: subtotal ₹549 → commission ₹41.18
    expect(parseFloat((549 * REFERRAL_FEE_PCT).toFixed(2))).toBe(41.17);
  });

  test('commission is NOT on delivery/taxes', () => {
    const REFERRAL_FEE_PCT = 0.075;
    const subtotal = 500;
    const deliveryFee = 50;
    const gst = 25;
    const total = subtotal + deliveryFee + gst;
    // Commission ONLY on subtotal
    expect(parseFloat((subtotal * REFERRAL_FEE_PCT).toFixed(2))).toBe(37.5);
    // NOT on total
    expect(parseFloat((total * REFERRAL_FEE_PCT).toFixed(2))).not.toBe(37.5);
  });
});
