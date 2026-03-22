// src/services/dynamicPricing.js
// Calculates dynamic delivery fees based on distance, time-of-day, and surge.
// Outputs TOTAL (GROSS) delivery fee — does NOT know about delivery_fee_customer_pct.
// The split is handled downstream by calculateOrderCharges().

const { col } = require('../config/database');

// ─── HAVERSINE ───────────────────────────────────────────────────
const toRad = (deg) => (deg * Math.PI) / 180;

const haversineKm = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const round2 = (n) => Math.round(n * 100) / 100;

// ─── DEFAULT CONFIG ──────────────────────────────────────────────
const DEFAULTS = {
  dynamic_pricing_enabled: false,
  base_delivery_fee_rs:    30,    // flat base fee
  per_km_fee_rs:           7,     // per-km charge
  free_delivery_within_km: 0,     // 0 = no free zone
  max_delivery_fee_rs:     150,   // fee cap
  min_delivery_fee_rs:     20,    // floor
  surge_multiplier:        1.0,   // 1.0 = no surge (set dynamically or via admin)
  surge_reason:            null,
  // Time-of-day multipliers (hour ranges, IST)
  time_multipliers: [
    // { start_hour: 12, end_hour: 14, multiplier: 1.2, label: 'Lunch rush' },
    // { start_hour: 19, end_hour: 22, multiplier: 1.3, label: 'Dinner rush' },
  ],
};

// ─── GET BRANCH PRICING CONFIG ───────────────────────────────────
const getBranchPricingConfig = async (branchId) => {
  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch) return { ...DEFAULTS };

  return {
    dynamic_pricing_enabled: branch.dynamic_pricing_enabled ?? DEFAULTS.dynamic_pricing_enabled,
    base_delivery_fee_rs:    parseFloat(branch.base_delivery_fee_rs)    || DEFAULTS.base_delivery_fee_rs,
    per_km_fee_rs:           parseFloat(branch.per_km_fee_rs)           || DEFAULTS.per_km_fee_rs,
    free_delivery_within_km: parseFloat(branch.free_delivery_within_km) || DEFAULTS.free_delivery_within_km,
    max_delivery_fee_rs:     parseFloat(branch.max_delivery_fee_rs)     || DEFAULTS.max_delivery_fee_rs,
    min_delivery_fee_rs:     parseFloat(branch.min_delivery_fee_rs)     || DEFAULTS.min_delivery_fee_rs,
    surge_multiplier:        parseFloat(branch.surge_multiplier)        || DEFAULTS.surge_multiplier,
    surge_reason:            branch.surge_reason                        || DEFAULTS.surge_reason,
    time_multipliers:        Array.isArray(branch.time_multipliers) ? branch.time_multipliers : DEFAULTS.time_multipliers,
    // Branch location for distance calc
    latitude:  parseFloat(branch.latitude)  || null,
    longitude: parseFloat(branch.longitude) || null,
    // Fallback flat fee (existing field)
    delivery_fee_rs: parseFloat(branch.delivery_fee_rs) || null,
  };
};

// ─── GET TIME-OF-DAY MULTIPLIER ──────────────────────────────────
const getTimeMultiplier = (timeMultipliers) => {
  if (!timeMultipliers?.length) return { multiplier: 1.0, label: null };

  // Current hour in IST (UTC+5:30)
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istTime = new Date(now.getTime() + istOffset);
  const hour = istTime.getUTCHours();

  for (const slot of timeMultipliers) {
    const start = parseInt(slot.start_hour);
    const end = parseInt(slot.end_hour);
    const mult = parseFloat(slot.multiplier) || 1.0;

    // Handle overnight ranges (e.g., 22 to 2)
    if (start <= end) {
      if (hour >= start && hour < end) return { multiplier: mult, label: slot.label || null };
    } else {
      if (hour >= start || hour < end) return { multiplier: mult, label: slot.label || null };
    }
  }

  return { multiplier: 1.0, label: null };
};

// ─── CALCULATE DYNAMIC DELIVERY FEE ─────────────────────────────
// Returns: { deliveryFeeRs, breakdown }
// breakdown has: { distanceKm, baseFee, distanceFee, surgeMultiplier, timeMultiplier, effectiveMultiplier, reason, feeBeforeMultiplier, feeAfterMultiplier, capped }
const calculateDynamicDeliveryFee = async (branchId, deliveryLat, deliveryLng) => {
  const config = await getBranchPricingConfig(branchId);

  // If dynamic pricing is disabled, return the flat fee
  if (!config.dynamic_pricing_enabled) {
    const flatFee = config.delivery_fee_rs
      || parseFloat(process.env.DEFAULT_DELIVERY_FEE)
      || 40;
    return {
      deliveryFeeRs: flatFee,
      dynamic: false,
      breakdown: {
        distanceKm: null,
        baseFee: flatFee,
        distanceFee: 0,
        surgeMultiplier: 1.0,
        timeMultiplier: 1.0,
        effectiveMultiplier: 1.0,
        reason: null,
        feeBeforeMultiplier: flatFee,
        feeAfterMultiplier: flatFee,
        capped: false,
      },
    };
  }

  // Calculate distance
  let distanceKm = null;
  if (deliveryLat && deliveryLng && config.latitude && config.longitude) {
    distanceKm = round2(haversineKm(
      config.latitude, config.longitude,
      parseFloat(deliveryLat), parseFloat(deliveryLng)
    ));
  }

  // Free delivery zone
  if (distanceKm !== null && config.free_delivery_within_km > 0 && distanceKm <= config.free_delivery_within_km) {
    return {
      deliveryFeeRs: 0,
      dynamic: true,
      breakdown: {
        distanceKm,
        baseFee: 0,
        distanceFee: 0,
        surgeMultiplier: 1.0,
        timeMultiplier: 1.0,
        effectiveMultiplier: 1.0,
        reason: 'Free delivery zone',
        feeBeforeMultiplier: 0,
        feeAfterMultiplier: 0,
        capped: false,
      },
    };
  }

  // Base fee + distance fee
  const baseFee = config.base_delivery_fee_rs;
  const chargeableKm = distanceKm !== null
    ? Math.max(0, distanceKm - config.free_delivery_within_km)
    : 0;
  const distanceFee = round2(chargeableKm * config.per_km_fee_rs);
  const feeBeforeMultiplier = round2(baseFee + distanceFee);

  // Surge multiplier (admin-set or programmatic)
  const surgeMultiplier = Math.max(1.0, config.surge_multiplier);

  // Time-of-day multiplier
  const timeInfo = getTimeMultiplier(config.time_multipliers);
  const timeMultiplier = Math.max(1.0, timeInfo.multiplier);

  // Effective multiplier = surge × time (compounding)
  const effectiveMultiplier = round2(surgeMultiplier * timeMultiplier);

  let feeAfterMultiplier = round2(feeBeforeMultiplier * effectiveMultiplier);

  // Apply cap and floor
  let capped = false;
  if (feeAfterMultiplier > config.max_delivery_fee_rs) {
    feeAfterMultiplier = config.max_delivery_fee_rs;
    capped = true;
  }
  if (feeAfterMultiplier < config.min_delivery_fee_rs) {
    feeAfterMultiplier = config.min_delivery_fee_rs;
  }

  // Build reason string
  const reasons = [];
  if (surgeMultiplier > 1.0) reasons.push(config.surge_reason || `${surgeMultiplier}x surge`);
  if (timeMultiplier > 1.0) reasons.push(timeInfo.label || `${timeMultiplier}x time charge`);
  const reason = reasons.length ? reasons.join(' + ') : null;

  return {
    deliveryFeeRs: feeAfterMultiplier,
    dynamic: true,
    breakdown: {
      distanceKm,
      baseFee,
      distanceFee,
      surgeMultiplier,
      timeMultiplier,
      effectiveMultiplier,
      reason,
      feeBeforeMultiplier,
      feeAfterMultiplier,
      capped,
    },
  };
};

// ─── GET SURGE INFO (for dashboard / API) ────────────────────────
const getSurgeInfo = async (branchId) => {
  const config = await getBranchPricingConfig(branchId);
  const timeInfo = getTimeMultiplier(config.time_multipliers);

  return {
    dynamic_pricing_enabled: config.dynamic_pricing_enabled,
    surge_multiplier:        config.surge_multiplier,
    surge_reason:            config.surge_reason,
    time_multiplier:         timeInfo.multiplier,
    time_label:              timeInfo.label,
    effective_multiplier:    round2(Math.max(1.0, config.surge_multiplier) * Math.max(1.0, timeInfo.multiplier)),
    config: {
      base_delivery_fee_rs:    config.base_delivery_fee_rs,
      per_km_fee_rs:           config.per_km_fee_rs,
      free_delivery_within_km: config.free_delivery_within_km,
      max_delivery_fee_rs:     config.max_delivery_fee_rs,
      min_delivery_fee_rs:     config.min_delivery_fee_rs,
    },
  };
};

module.exports = {
  calculateDynamicDeliveryFee,
  getSurgeInfo,
  getBranchPricingConfig,
  haversineKm,
  DEFAULTS,
};
