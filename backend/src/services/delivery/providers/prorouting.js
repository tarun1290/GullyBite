// src/services/delivery/providers/prorouting.js
// Prorouting 3PL adapter — wraps services/prorouting.js so the
// delivery-router (services/delivery/index.js) can drive it through
// the same interface as mock.js. Phase 1 of the
// multi-3PL refactor: services/prorouting.js stays as the canonical
// API client (used directly by webhooks for status / track / issue
// flows); this file is just a translation layer between the
// pickup/drop/orderDetails shape index.js builds and the
// pickupCoords/dropCoords/quoteId/pickupDetails/dropDetails shape
// services/prorouting.js expects.
//
// Interface (matches mock.js exactly):
//   name                                       — string
//   getQuote(pickup, drop, orderDetails)       → quote shape
//   createTask(pickup, drop, orderDetails, qid)→ task shape
//   cancelTask(taskId)                         → { success, refundable, message? }
//   getTaskStatus(taskId)                      → status shape
//
// Why a thin adapter rather than calling services/prorouting.js
// directly: index.js's PROVIDERS map needs a stable interface across
// every provider. Without this layer, index.js would have to special-
// case Prorouting's signature; that defeats the point of the router.

'use strict';

const prorouting = require('../../prorouting');
const log = require('../../../utils/logger').child({ component: 'ProroutingAdapter' });

const name = 'prorouting';

// Haversine — same formula used in mock.js. Inlined rather than
// imported because mock.js doesn't export its helper, and a future
// move of mock.js shouldn't ripple through here. distanceKm is
// returned to the index.js caller and stamped on the order doc, so
// matching mock's rounding (1 decimal) keeps the field consistent
// across providers.
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── GET QUOTE ───────────────────────────────────────────────────
// Maps the index.js-style pickup/drop ({lat,lng,address,...}) onto
// services/prorouting.js's getEstimate signature
// (pickupCoords, dropCoords, orderValue, city). City is the one field
// the underlying API requires that index.js doesn't currently pass —
// we read it from pickup.city / drop.city / orderDetails.city in
// that order, falling back to the PROROUTING_DEFAULT_CITY env var.
// services/prorouting.js throws if city ends up empty, which surfaces
// as a clean upstream-config error rather than silent (0,0) issuance.
async function getQuote(pickup, drop, orderDetails = {}) {
  const pickupCoords = {
    latitude: pickup.lat,
    longitude: pickup.lng,
    pincode: pickup.pincode || orderDetails.pickupPincode || '',
    city: pickup.city || orderDetails.pickupCity || '',
  };
  const dropCoords = {
    latitude: drop.lat,
    longitude: drop.lng,
    pincode: drop.pincode || orderDetails.dropPincode || orderDetails.deliveryPincode || '',
    city: drop.city || orderDetails.dropCity || orderDetails.deliveryCity || '',
  };

  const orderValue = Number(orderDetails.orderValue ?? orderDetails.totalRs ?? 0) || 0;
  const city = pickupCoords.city
    || dropCoords.city
    || orderDetails.city
    || process.env.PROROUTING_DEFAULT_CITY
    || '';

  const t0 = Date.now();
  const { estimated_price, quote_id } = await prorouting.getEstimate(
    pickupCoords, dropCoords, orderValue, city,
  );

  // distanceKm is not returned by Prorouting's /estimate response
  // (only the fare). Compute Haversine here so the index.js caller
  // and the order-doc field stays consistent across providers.
  const distanceKm = haversineKm(
    Number(pickup.lat), Number(pickup.lng),
    Number(drop.lat), Number(drop.lng),
  );

  log.info({ ms: Date.now() - t0, estimated_price, quote_id, city }, 'getQuote ok');
  return {
    deliveryFeeRs: parseFloat(Number(estimated_price).toFixed(2)),
    estimatedMins: parseInt(orderDetails.estimatedMins, 10) || 30,
    distanceKm: parseFloat(distanceKm.toFixed(1)),
    quoteId: quote_id,
    // Prorouting estimates are valid for ~10 min on their side;
    // 10-minute window keeps the index.js caller's expiry check
    // uniform across providers.
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    surgeActive: false,
    providerName: 'prorouting',
  };
}

// ─── CREATE TASK ─────────────────────────────────────────────────
// services/prorouting.js's createDeliveryOrder is keyed on
// gullybiteOrderId — that's what /webhook/prorouting echoes back as
// `client_order_id`, so we MUST pass it. orderDetails.orderId carries
// it (set by index.js's dispatchDelivery from the order row).
async function createTask(pickup, drop, orderDetails = {}, quoteId = null) {
  const gullybiteOrderId = orderDetails.orderId
    ?? orderDetails.gullybiteOrderId
    ?? orderDetails.orderNumber;
  if (!gullybiteOrderId) {
    throw new Error('prorouting adapter: orderDetails.orderId is required for createTask');
  }

  const pickupDetails = {
    latitude: pickup.lat,
    longitude: pickup.lng,
    name: pickup.contactName || '',
    phone: pickup.contactPhone || '',
    address_name: pickup.contactName || '',
    address_line1: pickup.address || '',
    address_line2: pickup.address_line2 || '',
    city: pickup.city || orderDetails.pickupCity || '',
    state: pickup.state || orderDetails.pickupState || '',
    pincode: pickup.pincode || orderDetails.pickupPincode || '',
  };

  const dropDetails = {
    latitude: drop.lat,
    longitude: drop.lng,
    name: drop.contactName || 'Customer',
    phone: drop.contactPhone || '',
    order_value: Number(orderDetails.orderValue ?? orderDetails.totalRs ?? 0) || 0,
    address_name: drop.contactName || 'Customer',
    address_line1: drop.address || '',
    address_line2: drop.address_line2 || '',
    city: drop.city || orderDetails.dropCity || orderDetails.deliveryCity || '',
    state: drop.state || orderDetails.dropState || '',
    pincode: drop.pincode || orderDetails.dropPincode || orderDetails.deliveryPincode || '',
  };

  const orderItems = Array.isArray(orderDetails.items)
    ? orderDetails.items.map((it) => ({
        name: it?.item_name ?? it?.name ?? '',
        qty: Number(it?.quantity ?? it?.qty ?? 1) || 1,
        price: Number(it?.line_total_rs ?? it?.price_rs ?? it?.price ?? 0) || 0,
      }))
    : [];

  const orderMeta = {
    orderAmount: Number(orderDetails.orderValue ?? orderDetails.totalRs ?? 0) || 0,
    orderItems,
  };

  const t0 = Date.now();
  const { prorouting_order_id, raw } = await prorouting.createDeliveryOrder(
    gullybiteOrderId, quoteId, pickupDetails, dropDetails, orderMeta,
  );
  log.info({ ms: Date.now() - t0, prorouting_order_id, gullybiteOrderId }, 'createTask ok');

  // /createasync is async upstream — the actual rider assignment +
  // tracking URL arrive via the status webhook (webhookProrouting.js)
  // minutes later. estimatedMins is best-effort from Prorouting's
  // response if present, else a sane default.
  return {
    taskId: prorouting_order_id,
    trackingUrl: raw?.tracking_url || raw?.tracking?.url || null,
    estimatedMins: parseInt(raw?.estimated_pickup_duration ?? raw?.eta ?? 30, 10),
    status: 'assigned',
    providerName: 'prorouting',
  };
}

// ─── CANCEL TASK ─────────────────────────────────────────────────
// services/prorouting.js's cancelDeliveryOrder NEVER throws — returns
// raw body on success or null on failure. Translate to the
// { success, refundable } shape the router expects. reasonId '005'
// (merchant-initiated) is the default cancel reason for restaurant
// declines; matches the existing webhooks/restaurant.js call site.
async function cancelTask(taskId, reasonId = '005', reasonText) {
  const t0 = Date.now();
  const result = await prorouting.cancelDeliveryOrder(taskId, reasonId, reasonText);
  if (!result) {
    log.warn({ ms: Date.now() - t0, taskId }, 'cancelTask: upstream returned null');
    return { success: false, refundable: false, message: 'Cancel failed upstream' };
  }
  // Prorouting returns status=0 with a message body when the LSP
  // refuses to cancel (e.g., already dispatched). Treat that as a
  // soft-failure rather than a hard error so the caller can still
  // proceed with manual ops handling.
  if (result.status === 0 || result.status === '0') {
    log.warn({ ms: Date.now() - t0, taskId, message: result.message }, 'cancelTask: LSP did not cancel');
    return { success: false, refundable: false, message: result.message || 'LSP refused cancel' };
  }
  log.info({ ms: Date.now() - t0, taskId }, 'cancelTask ok');
  return { success: true, refundable: true, providerName: 'prorouting' };
}

// ─── GET TASK STATUS ─────────────────────────────────────────────
// Composes services/prorouting.js's getOrderStatus (lifecycle state +
// agent details) with getTrackingInfo (live coordinates + tracking
// URL). Both calls can throw on transport failure — index.js's
// status path catches and falls back to the cached delivery row, so
// re-throwing here is safe.
async function getTaskStatus(taskId) {
  const t0 = Date.now();
  let state = null;
  let agent = null;
  let trackingUrl = null;
  let driverLat = null;
  let driverLng = null;

  try {
    const statusRes = await prorouting.getOrderStatus(taskId);
    state = statusRes.state;
    agent = statusRes.agent;
  } catch (err) {
    log.warn({ err: err.message, taskId }, 'getOrderStatus failed — continuing with tracking-only');
  }
  try {
    const tracking = await prorouting.getTrackingInfo(taskId);
    driverLat = tracking.rider_lat;
    driverLng = tracking.rider_lng;
    trackingUrl = tracking.tracking_url;
  } catch (err) {
    log.warn({ err: err.message, taskId }, 'getTrackingInfo failed — continuing with status-only');
  }

  log.info({ ms: Date.now() - t0, taskId, state, hasAgent: !!agent }, 'getTaskStatus ok');
  return {
    status: normalizeStatus(state),
    driverName: agent?.name || null,
    driverPhone: agent?.phone || agent?.mobile || null,
    driverLat,
    driverLng,
    estimatedMins: null,
    trackingUrl,
  };
}

// Map Prorouting state strings to the canonical
// pending/assigned/picked_up/in_transit/delivered/cancelled/failed
// vocabulary that index.js stamps on the deliveries collection.
// Mirrors mock.js's normalizeStatus shape.
function normalizeStatus(raw) {
  const s = String(raw || '').toUpperCase().replace(/-/g, '_');
  const map = {
    SEARCHING_AGENT: 'pending',
    AGENT_ASSIGNED: 'assigned',
    ASSIGNED: 'assigned',
    AT_PICKUP: 'assigned',
    REACHED_FOR_PICKUP: 'assigned',
    ORDER_PICKED_UP: 'picked_up',
    PICKED_UP: 'picked_up',
    AT_DELIVERY: 'picked_up',
    REACHED_FOR_DELIVERY: 'picked_up',
    ORDER_DELIVERED: 'delivered',
    DELIVERED: 'delivered',
    CANCELLED: 'cancelled',
    CANCELED: 'cancelled',
    RTO_INITIATED: 'failed',
    RTO_DELIVERED: 'failed',
    RTO_DISPOSED: 'failed',
    FAILED: 'failed',
  };
  return map[s] || 'assigned';
}

module.exports = {
  name,
  getQuote,
  createTask,
  cancelTask,
  getTaskStatus,
  normalizeStatus,
};
