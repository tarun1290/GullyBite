// src/services/eta.js
// Dynamic ETA calculation — no external APIs, uses Haversine formula

const { col } = require('../config/database');

// ─── HAVERSINE DISTANCE (km) ─────────────────────────────────
const getHaversineDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371; // Earth radius in km
  const toRad = (deg) => deg * (Math.PI / 180);
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// ─── CALCULATE ETA ───────────────────────────────────────────
const calculateETA = async (branchId, deliveryLat, deliveryLng) => {
  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch || !branch.latitude || !branch.longitude) {
    return { prepTimeMinutes: 20, deliveryTimeMinutes: 15, totalMinutes: 35, etaText: '30-40 min' };
  }

  // ── Prep time ──
  const basePrepMin   = branch.base_prep_time_min ?? 15;
  const perItemMin    = branch.avg_item_prep_min  ?? 0;

  // Kitchen queue load
  const activeOrders = await col('orders').countDocuments({
    branch_id: branchId,
    status: { $in: ['PAID', 'CONFIRMED', 'PREPARING'] },
  });
  let prepTimeMinutes = basePrepMin + (activeOrders * 5);

  // Add per-item time if we have item count context (optional)
  // This is handled at call site by passing itemCount
  prepTimeMinutes = Math.min(prepTimeMinutes, 60);

  // ── Delivery time ──
  let deliveryTimeMinutes = 15; // default
  if (deliveryLat && deliveryLng) {
    const straightLine = getHaversineDistance(
      branch.latitude, branch.longitude,
      deliveryLat, deliveryLng
    );
    const roadDistance = straightLine * 1.4;
    deliveryTimeMinutes = Math.round((roadDistance / 20) * 60); // 20 km/h avg
    deliveryTimeMinutes = Math.max(10, Math.min(45, deliveryTimeMinutes));
  }

  const totalMinutes = prepTimeMinutes + deliveryTimeMinutes;
  const lo = Math.max(5, totalMinutes - 5);
  const hi = totalMinutes + 5;
  const etaText = `${lo}-${hi} min`;

  return { prepTimeMinutes, deliveryTimeMinutes, totalMinutes, etaText };
};

// ─── UPDATE ETA ON STATUS CHANGE ─────────────────────────────
const updateETAOnStatusChange = async (orderId, newStatus) => {
  const order = await col('orders').findOne({ _id: orderId });
  if (!order) return null;

  const branch = await col('branches').findOne({ _id: order.branch_id });
  if (!branch) return null;

  let deliveryTimeMinutes = 15;
  if (order.delivery_lat && order.delivery_lng && branch.latitude && branch.longitude) {
    const roadDist = getHaversineDistance(
      branch.latitude, branch.longitude,
      order.delivery_lat, order.delivery_lng
    ) * 1.4;
    deliveryTimeMinutes = Math.max(10, Math.min(45, Math.round((roadDist / 20) * 60)));
  }

  const now = new Date();
  let remainingMin;

  switch (newStatus) {
    case 'CONFIRMED': {
      const full = await calculateETA(order.branch_id, order.delivery_lat, order.delivery_lng);
      remainingMin = full.totalMinutes;
      break;
    }
    case 'PREPARING': {
      const elapsed = order.confirmed_at
        ? Math.round((now - new Date(order.confirmed_at)) / 60000)
        : 0;
      const prepLeft = Math.max(5, (order.estimated_prep_min || 15) - elapsed);
      remainingMin = prepLeft + deliveryTimeMinutes;
      break;
    }
    case 'PACKED': {
      remainingMin = deliveryTimeMinutes;
      break;
    }
    case 'DISPATCHED': {
      const elapsed = order.dispatched_at
        ? Math.round((now - new Date(order.dispatched_at)) / 60000)
        : 0;
      remainingMin = Math.max(5, deliveryTimeMinutes - elapsed);
      break;
    }
    default:
      return null;
  }

  const lo = Math.max(5, remainingMin - 5);
  const hi = remainingMin + 5;
  const etaText = `${lo}-${hi} min`;

  await col('orders').updateOne({ _id: orderId }, {
    $set: {
      estimated_remaining_min: remainingMin,
      eta_text: etaText,
      eta_updated_at: now,
    },
  });

  return { remainingMin, etaText };
};

module.exports = { getHaversineDistance, calculateETA, updateETAOnStatusChange };
