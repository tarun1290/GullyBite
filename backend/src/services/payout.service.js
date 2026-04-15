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

const { newId, col } = require('../config/database');
const paymentSvc = require('./payment');
const log = require('../utils/logger').child({ component: 'payout' });

// When true, non-Razorpay payouts are flagged for manual ops transfer
// instead of being silently stubbed. Ops moves the money out-of-band,
// then calls POST /admin/settlements/confirm to close the loop.
const MANUAL_PAYOUTS_ENABLED = String(process.env.MANUAL_PAYOUTS_ENABLED ?? 'true').toLowerCase() === 'true';

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
  if (!MANUAL_PAYOUTS_ENABLED) {
    throw new Error('Non-Razorpay payout provider not configured. Set MANUAL_PAYOUTS_ENABLED=true or wire a real provider.');
  }
  if (!referenceId) {
    throw new Error('fallback_provider: referenceId (settlementId) required for manual payout flagging');
  }

  // Manual-payout mode: flag the settlement for ops to transfer manually.
  // A synthetic payout_id (manual_<settlementId>) lets the outer settlement
  // flow debit the ledger as pending and keeps confirmPayout(payoutId)
  // working unchanged — ops calls POST /admin/settlements/confirm with the
  // external bank reference once the transfer clears.
  const payoutId = `manual_${referenceId}`;
  await col('settlements').updateOne(
    { _id: referenceId, status: { $nin: ['completed', 'pending_manual_payout'] } },
    { $set: {
        status: 'pending_manual_payout',
        manual_payout_flagged_at: new Date(),
    } },
  );
  log.warn({ settlementId: referenceId, amountPaise, idempotencyKey, payoutId },
    `Settlement ${referenceId} flagged for manual payout — transfer manually then confirm via admin panel`);
  return { provider: 'fallback_provider', payout_id: payoutId, raw: { manual: true } };
}

module.exports = { initiatePayout };
