'use strict';

// Wallet listener — credits the restaurant's payout share to the
// unified WABA wallet on each paid order.
//
// Fires on 'payment.completed'. Payload shape (see webhooks/razorpay.js:280):
//   { orderId, restaurantId, orderNumber, amountRs, method, provider, paymentRef }
//
// The restaurant's share = gross × (1 − commission_pct/100). This is
// the same calculation the old payoutWalletListener used; only the
// destination function changed (services/wallet.creditOrderPayout
// instead of a separate payout wallet).

const { col } = require('../../config/database');
const walletSvc = require('../../services/wallet');
const log = require('../../utils/logger').child({ component: 'WalletListener' });

// Zero default — flat ₹3,000/month subscription, no per-order commission.
// Per-restaurant override via restaurants.commission_pct still wins.
const DEFAULT_COMMISSION_PCT = 0;

async function onPaymentCompleted(payload) {
  const { orderId, restaurantId, orderNumber, amountRs, paymentRef } = payload || {};
  if (!restaurantId || !Number.isFinite(Number(amountRs)) || Number(amountRs) <= 0) {
    return;
  }

  try {
    const r = await col('restaurants').findOne(
      { _id: restaurantId },
      { projection: { commission_pct: 1 } }
    );
    const commissionPct = Number(r?.commission_pct ?? DEFAULT_COMMISSION_PCT);
    const restaurantShareRs = Number((Number(amountRs) * (1 - commissionPct / 100)).toFixed(2));
    if (restaurantShareRs <= 0) return;

    const result = await walletSvc.creditOrderPayout(
      restaurantId,
      restaurantShareRs,
      String(orderId || paymentRef || ''),
      `Order #${orderNumber || orderId} payout`
    );
    if (!result) {
      log.warn({ orderId, restaurantId }, 'order-payout credit skipped (no wallet)');
    }
  } catch (err) {
    // Fire-and-forget: never block payment confirmation on wallet write.
    log.error({ err, orderId, restaurantId }, 'order-payout credit failed');
  }
}

module.exports = { onPaymentCompleted };
