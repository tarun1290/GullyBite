// src/services/eta.js
// ETA calculation — uses 3PL delivery estimates + kitchen queue

const { col } = require('../config/database');
const deliveryService = require('./delivery');

// ─── CALCULATE ETA ───────────────────────────────────────────────
// Uses 3PL quote for delivery time, adds kitchen prep on top
const calculateETA = async (branchId, deliveryLat, deliveryLng) => {
  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch) {
    return { prepTimeMinutes: 20, deliveryTimeMinutes: 15, totalMinutes: 35, etaText: '30-40 min', distanceKm: null };
  }

  // ── Prep time ──
  const basePrepMin = branch.base_prep_time_min ?? 15;
  const activeOrders = await col('orders').countDocuments({
    branch_id: branchId,
    status: { $in: ['PAID', 'CONFIRMED', 'PREPARING'] },
  });
  // 3 min per active order, capped at 45 min queue
  const queueMin = Math.min(activeOrders * 3, 45);
  const prepTimeMinutes = Math.min(basePrepMin + queueMin, 60);

  // ── Delivery time from 3PL ──
  let deliveryTimeMinutes = 25; // safe default
  let distanceKm = null;

  if (deliveryLat && deliveryLng) {
    try {
      const quote = await deliveryService.getDeliveryQuote(branchId, deliveryLat, deliveryLng);
      deliveryTimeMinutes = quote.estimatedMins || 25;
      distanceKm = quote.distanceKm || null;
    } catch (err) {
      console.error(`[ETA] 3PL quote failed, using default:`, err.message);
      // Fall back to 25 min default
    }
  }

  const totalMinutes = prepTimeMinutes + deliveryTimeMinutes;
  const lo = Math.max(5, totalMinutes - 5);
  const hi = totalMinutes + 5;
  const etaText = `${lo}-${hi} min`;

  return { prepTimeMinutes, deliveryTimeMinutes, totalMinutes, etaText, distanceKm };
};

// ─── UPDATE ETA ON STATUS CHANGE ─────────────────────────────────
// Uses live 3PL ETA when available, falls back to elapsed-time subtraction
const updateETAOnStatusChange = async (orderId, newStatus) => {
  const order = await col('orders').findOne({ _id: orderId });
  if (!order) return null;

  const now = new Date();
  let remainingMin;

  // Try to get live ETA from 3PL
  let liveDeliveryMins = null;
  try {
    const delivery = await col('deliveries').findOne({ order_id: orderId });
    if (delivery?.provider_order_id && delivery.status !== 'delivered' && delivery.status !== 'cancelled') {
      const provider = deliveryService.getProvider(delivery.provider);
      const status = await provider.getTaskStatus(delivery.provider_order_id);
      if (status.estimatedMins) liveDeliveryMins = status.estimatedMins;
    }
  } catch (err) {
    console.error(`[ETA] Live status fetch failed for order ${orderId}:`, err.message);
  }

  const deliveryTimeMinutes = liveDeliveryMins || order.estimated_delivery_min || 25;

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

module.exports = { calculateETA, updateETAOnStatusChange };
