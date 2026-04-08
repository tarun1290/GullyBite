// src/services/dynamicPricing.js
// Wraps the 3PL delivery quote to produce the TOTAL delivery fee (GROSS).
// Does NOT know about delivery_fee_customer_pct — the split is handled
// downstream by calculateOrderCharges().
//
// The 3PL quote is the base. DELIVERY_PLATFORM_MARKUP_PCT is GullyBite's margin.

const { col } = require('../config/database');
const deliveryService = require('./delivery');
const log = require('../utils/logger').child({ component: 'DynamicPricing' });

// ─── CALCULATE DYNAMIC DELIVERY FEE ─────────────────────────────
// Returns the 3PL-based delivery fee. totalFeeRs goes into calculateOrderCharges().
const calculateDynamicDeliveryFee = async (branchId, deliveryLat, deliveryLng, orderDetails = {}) => {
  // If coordinates are missing, return a safe default
  if (!deliveryLat || !deliveryLng) {
    const fallback = parseFloat(process.env.DEFAULT_DELIVERY_FEE) || 40;
    return {
      deliveryFeeRs: fallback,
      dynamic: false,
      breakdown: {
        baseFeeRs: fallback,
        distanceSurchargeRs: 0,
        surgeFeeRs: 0,
        timeChargeFeeRs: 0,
        surgeMultiplier: 1.0,
        surgeReason: null,
        distanceKm: null,
        totalFeeRs: fallback,
        platformMarkupRs: 0,
        providerName: null,
        quoteId: null,
        estimatedMins: null,
      },
    };
  }

  try {
    const quote = await deliveryService.getDeliveryQuote(branchId, deliveryLat, deliveryLng, orderDetails);

    return {
      deliveryFeeRs: quote.totalFeeRs,
      dynamic: true,
      breakdown: {
        baseFeeRs: quote.providerFeeRs,
        distanceSurchargeRs: 0,
        surgeFeeRs: quote.surgeActive ? Math.round(quote.providerFeeRs * 0.2 * 100) / 100 : 0,
        timeChargeFeeRs: 0,
        surgeMultiplier: quote.surgeActive ? 1.2 : 1.0,
        surgeReason: quote.surgeActive ? '3PL high demand' : null,
        distanceKm: quote.distanceKm,
        totalFeeRs: quote.totalFeeRs,
        platformMarkupRs: quote.platformMarkupRs,
        providerName: quote.providerName,
        quoteId: quote.quoteId,
        estimatedMins: quote.estimatedMins,
      },
    };
  } catch (err) {
    // 3PL API error — fall back to safe default
    log.error({ err, branchId }, '3PL quote failed');
    const fallback = parseFloat(process.env.DEFAULT_DELIVERY_FEE) || 40;
    return {
      deliveryFeeRs: fallback,
      dynamic: false,
      breakdown: {
        baseFeeRs: fallback,
        distanceSurchargeRs: 0,
        surgeFeeRs: 0,
        timeChargeFeeRs: 0,
        surgeMultiplier: 1.0,
        surgeReason: null,
        distanceKm: null,
        totalFeeRs: fallback,
        platformMarkupRs: 0,
        providerName: null,
        quoteId: null,
        estimatedMins: null,
        error: err.message,
      },
    };
  }
};

// ─── GET SURGE INFO (for dashboard / API) ────────────────────────
const getSurgeInfo = async (branchId) => {
  try {
    const branch = await col('branches').findOne({ _id: branchId });
    if (!branch?.latitude || !branch?.longitude) {
      return { surgeActive: false, providerName: null, message: 'Branch coordinates not set' };
    }

    // Get a quote to the branch's own location as a proxy for current surge status
    const quote = await deliveryService.getDeliveryQuote(branchId, branch.latitude, branch.longitude);

    return {
      surgeActive: quote.surgeActive,
      providerName: quote.providerName,
      providerFeeRs: quote.providerFeeRs,
      platformMarkupRs: quote.platformMarkupRs,
      message: quote.surgeActive ? '3PL surge pricing active' : 'Normal pricing',
    };
  } catch (err) {
    return { surgeActive: false, providerName: null, message: `Quote unavailable: ${err.message}` };
  }
};

module.exports = { calculateDynamicDeliveryFee, getSurgeInfo };
