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
// Called during cart building to get real 3PL pricing
async function getDeliveryQuote(branchId, deliveryLat, deliveryLng, orderDetails = {}) {
  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch) throw new Error('Branch not found');

  const restaurant = await col('restaurants').findOne({ _id: branch.restaurant_id });

  const pickup = {
    lat: parseFloat(branch.latitude),
    lng: parseFloat(branch.longitude),
    address: branch.address || '',
    contactName: branch.name,
    contactPhone: branch.manager_phone || restaurant?.phone || '',
  };

  const drop = {
    lat: parseFloat(deliveryLat),
    lng: parseFloat(deliveryLng),
    address: orderDetails.deliveryAddress || '',
    contactName: orderDetails.customerName || 'Customer',
    contactPhone: orderDetails.customerPhone || '',
  };

  const provider = getProvider();
  const quote = await provider.getQuote(pickup, drop, orderDetails);

  // Apply GullyBite platform markup if configured
  const platformMarkupPct = parseFloat(process.env.DELIVERY_PLATFORM_MARKUP_PCT || 0);
  const platformMarkupRs = Math.round(quote.deliveryFeeRs * (platformMarkupPct / 100) * 100) / 100;

  return {
    providerName: quote.providerName,
    providerFeeRs: quote.deliveryFeeRs,
    platformMarkupRs,
    totalFeeRs: Math.round((quote.deliveryFeeRs + platformMarkupRs) * 100) / 100,
    estimatedMins: quote.estimatedMins,
    distanceKm: quote.distanceKm,
    quoteId: quote.quoteId,
    quoteExpiresAt: quote.expiresAt,
    surgeActive: quote.surgeActive,
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

  // Update or create delivery record
  const now = new Date();
  await col('deliveries').updateOne(
    { order_id: orderId },
    {
      $set: {
        provider: provider.name || process.env.DEFAULT_DELIVERY_PROVIDER || 'prorouting',
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

  log.info({ orderNumber: order.order_number, taskId: task.taskId }, 'Order dispatched');
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

module.exports = { getProvider, getDeliveryQuote, dispatchDelivery, cancelDelivery, getDeliveryStatus };
