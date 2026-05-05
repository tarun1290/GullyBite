// src/services/delivery/index.js
// 3PL delivery provider router — abstracts multiple delivery partners
// Currently supports Prorouting; mock kept for tests / dev. Designed
// for adding Dunzo, Shadowfax, Borzo behind the same interface.

const { col, newId } = require('../../config/database');
const prorouting = require('./providers/prorouting');
const mock = require('./providers/mock');
const log = require('../../utils/logger').child({ component: 'Delivery' });

const PROVIDERS = {
  prorouting,
  mock,
  // dunzo,       // future
  // shadowfax,   // future
  // borzo,       // future
};

// ─── GET PROVIDER ────────────────────────────────────────────────
function getProvider(providerName) {
  const name = providerName || process.env.DEFAULT_DELIVERY_PROVIDER || 'mock';
  const provider = PROVIDERS[name];
  if (!provider) {
    log.warn({ providerName: name }, 'Unknown provider — falling back to mock');
    return PROVIDERS.mock;
  }
  return provider;
}

// ─── GET DELIVERY QUOTE ──────────────────────────────────────────
// Called during cart building to get real 3PL pricing. Internally
// delegates to dispatcher.getBestQuote — that function fans the request
// out to every enabled provider in parallel and applies the
// scoring rule (cheapest under 3 km, fastest at or above). Wrapper
// shape (providerName / providerFeeRs / platformMarkupRs / etc.) is
// preserved so existing callers don't change.
//
// Lazy require for ./dispatcher avoids the circular dep that would
// otherwise form (index → dispatcher → index for PROVIDERS).
async function getDeliveryQuote(branchId, deliveryLat, deliveryLng, orderDetails = {}) {
  const dispatcher = require('./dispatcher');
  const { chosen, estimates } = await dispatcher.getBestQuote(branchId, deliveryLat, deliveryLng, orderDetails);

  // Flat per-order GullyBite handling fee. GST is computed downstream
  // in financialEngine on the full delivery_fee_total which includes
  // this markup, so we don't compute markup GST here. Switched from a
  // pct-of-3PL model so the merchant-visible delivery fee doesn't swing
  // when 3PL surge pricing fires — the markup stays steady at ₹5.
  const platformMarkupRs = parseFloat(process.env.DELIVERY_PLATFORM_MARKUP_FLAT_RS || 0);

  return {
    providerName: chosen.providerName,
    providerFeeRs: chosen.deliveryFeeRs,
    platformMarkupRs,
    totalFeeRs: Math.round((chosen.deliveryFeeRs + platformMarkupRs) * 100) / 100,
    estimatedMins: chosen.estimatedMins,
    distanceKm: chosen.distanceKm,
    quoteId: chosen.quoteId,
    quoteExpiresAt: chosen.expiresAt,
    surgeActive: chosen.surgeActive,
    // Phase 1 Part 3 audit field — full snapshot of every provider's
    // quote with `won` flag. Callers (services/order.js order-creation
    // path) persist this onto the deliveries row at order creation so
    // dispatchDelivery can copy it forward to orders.delivery_estimates
    // after the partner accepts the dispatch task.
    estimates,
  };
}

// ─── DISPATCH DELIVERY ───────────────────────────────────────────
// Called after payment confirmed — creates the actual 3PL delivery task
async function dispatchDelivery(orderId) {
  const order = await col('orders').findOne({ _id: orderId });
  if (!order) throw new Error('Order not found');

  const branch = await col('branches').findOne({ _id: order.branch_id });
  const customer = await col('customers').findOne({ _id: order.customer_id });
  const restaurant = branch ? await col('restaurants').findOne({ _id: branch.restaurant_id }) : null;
  const delivery = await col('deliveries').findOne({ order_id: orderId });

  const pickup = {
    lat: parseFloat(branch.latitude),
    lng: parseFloat(branch.longitude),
    address: branch.address || '',
    contactName: branch.name,
    contactPhone: branch.manager_phone || restaurant?.phone || '',
  };

  const drop = {
    lat: parseFloat(order.delivery_lat),
    lng: parseFloat(order.delivery_lng),
    address: order.delivery_address || '',
    contactName: customer?.name || 'Customer',
    // [BSUID] 3PL requires phone — use wa_phone if available, otherwise empty (manager handles manually)
    contactPhone: customer?.wa_phone || '',
  };

  const provider = getProvider(delivery?.provider || null);
  const quoteId = delivery?.quote_id || null;

  const items = await col('order_items').find({ order_id: orderId }).toArray();

  const task = await provider.createTask(pickup, drop, {
    orderNumber: order.order_number,
    orderValue: order.total_rs,
    items,
  }, quoteId);

  // Update or create delivery record. Resolve the canonical provider
  // name from the deliveries row (set at order creation from the
  // chosen quote) — that's the source of truth for which partner
  // actually quoted, and works correctly for mock too (mock's quote
  // returns providerName:'mock', stamped onto delivery.provider at
  // creation; provider.name would be undefined and fall back to a
  // wrong default).
  const now = new Date();
  const resolvedProvider = delivery?.provider
    || provider.name
    || process.env.DEFAULT_DELIVERY_PROVIDER
    || 'prorouting';
  await col('deliveries').updateOne(
    { order_id: orderId },
    {
      $set: {
        provider: resolvedProvider,
        provider_order_id: task.taskId,
        tracking_url: task.trackingUrl,
        estimated_mins: task.estimatedMins,
        status: 'assigned',
        updated_at: now,
      },
      $setOnInsert: {
        _id: delivery?._id || newId(),
        order_id: orderId,
        created_at: now,
      },
    },
    { upsert: true }
  );

  // Phase 1 Part 3: stamp the audit fields on the order doc itself.
  // delivery_provider mirrors deliveries.provider; delivery_estimates
  // is copied from the deliveries row where it was persisted at
  // order-creation time (services/order.js — see comment there).
  // delivery_estimates may be null on legacy orders that pre-date the
  // multi-3PL refactor; we leave the field absent in that case rather
  // than fabricating a single-entry array, so analytics can
  // distinguish "we didn't have estimates" from "we ran a real
  // multi-provider auction".
  const orderUpdate = { delivery_provider: resolvedProvider, updated_at: now };
  if (Array.isArray(delivery?.estimates) && delivery.estimates.length > 0) {
    orderUpdate.delivery_estimates = delivery.estimates;
  }
  await col('orders').updateOne({ _id: orderId }, { $set: orderUpdate });

  log.info({ orderNumber: order.order_number, taskId: task.taskId, provider: resolvedProvider }, 'Order dispatched');
  return task;
}

// ─── CANCEL DELIVERY ─────────────────────────────────────────────
async function cancelDelivery(orderId) {
  const delivery = await col('deliveries').findOne({ order_id: orderId });
  if (!delivery?.provider_order_id) return { success: true, message: 'No active delivery' };

  const provider = getProvider(delivery.provider);
  const result = await provider.cancelTask(delivery.provider_order_id);

  if (result.success) {
    await col('deliveries').updateOne(
      { _id: delivery._id },
      { $set: { status: 'cancelled', updated_at: new Date() } }
    );
  }

  return result;
}

// ─── GET DELIVERY STATUS ─────────────────────────────────────────
async function getDeliveryStatus(orderId) {
  const delivery = await col('deliveries').findOne({ order_id: orderId });
  if (!delivery) return null;

  // If we have a provider task, fetch live status
  if (delivery.provider_order_id && delivery.status !== 'delivered' && delivery.status !== 'cancelled') {
    try {
      const provider = getProvider(delivery.provider);
      const live = await provider.getTaskStatus(delivery.provider_order_id);
      // Update our record with live data
      const $set = { updated_at: new Date() };
      if (live.status) $set.status = live.status;
      if (live.driverName) $set.driver_name = live.driverName;
      if (live.driverPhone) $set.driver_phone = live.driverPhone;
      if (live.driverLat) $set.driver_lat = live.driverLat;
      if (live.driverLng) $set.driver_lng = live.driverLng;
      if (live.estimatedMins) $set.estimated_mins = live.estimatedMins;
      await col('deliveries').updateOne({ _id: delivery._id }, { $set });
      return { ...delivery, ...live };
    } catch (err) {
      log.error({ err, providerOrderId: delivery.provider_order_id }, 'Failed to fetch live status');
    }
  }

  return delivery;
}

module.exports = { getProvider, getDeliveryQuote, dispatchDelivery, cancelDelivery, getDeliveryStatus, PROVIDERS };
