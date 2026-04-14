// src/services/payout.service.js
// Phase 5 — Provider abstraction for settlement payouts. The caller
// (settlement.service.js) doesn't know which rail moved the money —
// it asks initiatePayout('razorpay', {...}) and gets back a normalised
// { provider, payout_id } envelope, or throws.
//
// Providers:
//   • 'razorpay'          — live. Wraps paymentSvc.createPayoutV2,
//                           which already handles idempotency keys
//                           via the X-Payout-Idempotency header.
//   • 'fallback_provider' — stub. Not wired to any real rail yet.
//                           Returns a synthetic payout_id so the
//                           settlement flow can be exercised end-to-end
//                           until a second gateway is provisioned.
//                           Override behaviour via env:
//                             FALLBACK_PAYOUT_MODE = 'stub' | 'fail'

'use strict';

const { newId } = require('../config/database');
const paymentSvc = require('./payment');
const log = require('../utils/logger').child({ component: 'payout' });

// data: { fundAccountId, amountPaise, idempotencyKey, referenceId, narration, mode? }
async function initiatePayout(provider, data) {
  if (!data || !data.amountPaise || data.amountPaise <= 0) {
    throw new Error('payout: amountPaise must be > 0');
  }
  if (!data.idempotencyKey) throw new Error('payout: idempotencyKey required');

  if (provider === 'razorpay') return _razorpayPayout(data);
  if (provider === 'fallback_provider') return _fallbackPayout(data);
  throw new Error(`payout: unknown provider '${provider}'`);
}

async function _razorpayPayout({ fundAccountId, amountPaise, idempotencyKey, referenceId, narration, mode }) {
  if (!fundAccountId) throw new Error('payout.razorpay: fundAccountId required');
  const payout = await paymentSvc.createPayoutV2({
    fundAccountId,
    amountRs: amountPaise / 100,
    idempotencyKey,
    referenceId,
    narration: narration || 'GullyBite Settlement',
    mode: mode || 'IMPS',
  });
  return { provider: 'razorpay', payout_id: payout.id, raw: payout };
}

async function _fallbackPayout({ amountPaise, idempotencyKey, referenceId }) {
  const mode = (process.env.FALLBACK_PAYOUT_MODE || 'stub').toLowerCase();
  if (mode === 'fail') {
    throw new Error('fallback_provider: not configured');
  }
  // Stub — emit a synthetic payout id so the downstream write path
  // (settlement row update + ledger debit) behaves exactly as it
  // would with a live rail. Swap this body when a real provider
  // (Cashfree / ICICI / etc.) is integrated.
  const payoutId = `fb_${newId()}`;
  log.warn({ amountPaise, referenceId, idempotencyKey, payoutId },
    'fallback_provider: STUB payout — no real money moved');
  return { provider: 'fallback_provider', payout_id: payoutId, raw: { stub: true } };
}

module.exports = { initiatePayout };
