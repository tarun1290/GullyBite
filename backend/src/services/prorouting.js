// src/services/prorouting.js
//
// Prorouting (3PL) integration. Thin wrapper around the Prorouting
// logistics-buyer API. Three operations live here:
//
//   getEstimate(pickupCoords, dropCoords, orderValue)
//     → { estimated_price, quote_id }
//   createDeliveryOrder(gullybiteOrderId, quoteId, pickupDetails, dropDetails, orderMeta)
//     → { prorouting_order_id, raw }
//   cancelDeliveryOrder(mp2OrderId, reasonId, reasonText)
//     → raw response body on success, null on failure (never throws)
//
// Base URL and API key come from env. Auth header is `x-pro-api-key`.
// All requests carry a 10s timeout; callers are responsible for falling back
// to a default fee (getEstimate) or flagging `needs_manual_dispatch`
// (createDeliveryOrder) when we throw.
//
// Spec uses `lat`/`lng`; our DB stores `latitude`/`longitude`. The coord
// normaliser below accepts either shape so callers can pass native rows.

'use strict';

const axios = require('axios');
const log = require('../utils/logger').child({ component: 'prorouting' });

const BASE_URL = process.env.PROROUTING_BASE_URL || 'https://preprod.logistics-buyer.prorouting.in';
const API_KEY = process.env.PROROUTING_API_KEY || '';
const CALLBACK_URL = process.env.PROROUTING_CALLBACK_URL
  || 'https://gullybite.duckdns.org/webhook/prorouting';
const TIMEOUT_MS = 10_000;

function client() {
  if (!API_KEY) {
    const err = new Error('PROROUTING_API_KEY not configured');
    err.code = 'PROROUTING_NOT_CONFIGURED';
    throw err;
  }
  return axios.create({
    baseURL: BASE_URL,
    timeout: TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      'x-pro-api-key': API_KEY,
    },
  });
}

// Accept either { latitude, longitude } (our DB shape) or { lat, lng }
// (Prorouting spec). Returns the spec shape.
function toLatLng(point) {
  if (!point) return null;
  const lat = point.lat ?? point.latitude;
  const lng = point.lng ?? point.longitude;
  if (lat == null || lng == null) return null;
  return { lat: Number(lat), lng: Number(lng) };
}

// ─── GET ESTIMATE ─────────────────────────────────────────────
// Called during checkout (before payment) to quote the delivery fee.
// pickupCoords / dropCoords: { latitude, longitude, address?, pincode? }
// orderValue: rupees (number), used by Prorouting for insurance/category tier.
async function getEstimate(pickupCoords, dropCoords, orderValue) {
  const pickupLatLng = toLatLng(pickupCoords);
  const dropLatLng = toLatLng(dropCoords);
  if (!pickupLatLng || !dropLatLng) {
    throw new Error('prorouting.getEstimate: pickup and drop must have lat/lng');
  }

  const payload = {
    pickup: {
      ...pickupLatLng,
      address: pickupCoords.address || pickupCoords.full_address || '',
      pincode: pickupCoords.pincode || '',
    },
    drop: {
      ...dropLatLng,
      address: dropCoords.address || dropCoords.full_address || '',
      pincode: dropCoords.pincode || '',
    },
    order_value: Number(orderValue) || 0,
  };

  const t0 = Date.now();
  try {
    const { data } = await client().post('/partner/estimate', payload);
    const estimated_price = Number(data?.estimated_price ?? data?.price ?? 0);
    const quote_id = data?.quote_id || data?.quoteId || null;
    log.info({ ms: Date.now() - t0, estimated_price, quote_id }, 'estimate ok');
    return { estimated_price, quote_id };
  } catch (e) {
    log.warn({ ms: Date.now() - t0, err: e.message, status: e.response?.status, body: e.response?.data }, 'estimate failed');
    throw e;
  }
}

// ─── CREATE DELIVERY ORDER ────────────────────────────────────
// Fire after Razorpay payment confirmed. mode=estimated_price pins the
// fare to the quote returned from getEstimate — required because the
// upstream financial engine (financialEngine.calculateCheckout in
// _sendOrderCheckout) re-runs against this exact quote to derive the
// customer/restaurant delivery-fee split the customer agreed to pay.
// fastest_agent would let the LSP re-derive the fare at dispatch and
// break that contract.
//
// callback_url receives lifecycle events at /webhook/prorouting on our
// side; client_order_id is the value the webhook will echo back so we
// can resolve our order row.
//
// Address shape: nested {name, line1, line2, city, state, pincode} per
// Prorouting Postman docs (Apr 2026 — Create Order async).
//
// gullybiteOrderId: our orders._id (string)
// quoteId:          prorouting_quote_id from getEstimate; pinned via
//                   select_criteria so the live fare matches the quote
// pickupDetails:    {
//   latitude, longitude, name, phone,
//   address_name, address_line1, address_line2, city, state, pincode
// }
// dropDetails:      {
//   latitude, longitude, name, phone, order_value,
//   address_name, address_line1, address_line2, city, state, pincode
// }
// orderMeta:        { orderAmount: number, orderItems: [{name, qty, price}, ...] }
async function createDeliveryOrder(gullybiteOrderId, quoteId, pickupDetails, dropDetails, orderMeta = {}) {
  const pickupLatLng = toLatLng(pickupDetails);
  const dropLatLng = toLatLng(dropDetails);
  if (!pickupLatLng || !dropLatLng) {
    throw new Error('prorouting.createDeliveryOrder: pickup and drop must have lat/lng');
  }

  const orderAmount = Number(
    orderMeta.orderAmount ?? dropDetails.order_value ?? 0
  ) || 0;
  const orderItems = Array.isArray(orderMeta.orderItems)
    ? orderMeta.orderItems.map((it) => ({
        name: String(it?.name ?? ''),
        qty: Number(it?.qty ?? 0) || 0,
        price: Number(it?.price ?? 0) || 0,
      }))
    : [];

  const payload = {
    client_order_id: String(gullybiteOrderId),
    callback_url: CALLBACK_URL,
    order_amount: orderAmount,
    order_category: 'F&B',
    search_category: 'Immediate Delivery',
    ready_to_ship: 'yes',
    order_items: orderItems,
    select_criteria: { mode: 'estimated_price', quote_id: quoteId || null },
    pickup: {
      ...pickupLatLng,
      address: {
        name: pickupDetails.address_name || '',
        line1: pickupDetails.address_line1 || '',
        line2: pickupDetails.address_line2 || '',
        city: pickupDetails.city || '',
        state: pickupDetails.state || '',
        pincode: pickupDetails.pincode || '',
      },
      name: pickupDetails.name || '',
      phone: pickupDetails.phone || '',
    },
    drop: {
      ...dropLatLng,
      address: {
        name: dropDetails.address_name || '',
        line1: dropDetails.address_line1 || '',
        line2: dropDetails.address_line2 || '',
        city: dropDetails.city || '',
        state: dropDetails.state || '',
        pincode: dropDetails.pincode || '',
      },
      name: dropDetails.name || '',
      phone: dropDetails.phone || '',
      order_value: Number(dropDetails.order_value) || 0,
    },
  };

  const t0 = Date.now();
  try {
    const { data } = await client().post('/partner/order/createasync', payload);
    const prorouting_order_id = data?.order_id || data?.orderId || data?.prorouting_order_id || null;
    log.info({ ms: Date.now() - t0, prorouting_order_id, client_order_id: payload.client_order_id }, 'createasync ok');
    return { prorouting_order_id, raw: data };
  } catch (e) {
    log.warn({ ms: Date.now() - t0, err: e.message, status: e.response?.status, body: e.response?.data, client_order_id: payload.client_order_id }, 'createasync failed');
    throw e;
  }
}

// ─── CANCEL DELIVERY ORDER ────────────────────────────────────
// POST /partner/order/cancel. Called fire-and-forget from the
// restaurant decline flow so the 3PL rider doesn't stay en route
// after a GullyBite cancellation. Valid reasonIds for our side:
//   '005' merchant rejected (default — restaurant decline)
//   '012' buyer does not want product any more
//   '006' order not shipped per SLA
// This function NEVER throws: a failed cancel must not block the
// GullyBite order cancellation. Logs on both the status-0 body
// response and the network error paths; returns the raw body on
// success, null on error.
async function cancelDeliveryOrder(mp2OrderId, reasonId = '005', reasonText) {
  if (!mp2OrderId) {
    log.warn('cancelDeliveryOrder: missing mp2OrderId — no-op');
    return null;
  }
  const payload = {
    order: {
      id: String(mp2OrderId),
      cancellation_reason_id: String(reasonId || '005'),
      ...(reasonText ? { cancellation_reason_text: String(reasonText) } : {}),
    },
  };
  const t0 = Date.now();
  try {
    const { data } = await client().post('/partner/order/cancel', payload);
    const status = data?.status;
    if (status === 0 || status === '0') {
      log.warn({ ms: Date.now() - t0, mp2_order_id: mp2OrderId, message: data?.message, body: data }, 'cancel returned status 0 — LSP did not cancel');
      return data;
    }
    log.info({ ms: Date.now() - t0, mp2_order_id: mp2OrderId, reasonId }, 'cancel ok');
    return data;
  } catch (e) {
    log.warn({ ms: Date.now() - t0, err: e.message, status: e.response?.status, body: e.response?.data, mp2_order_id: mp2OrderId }, 'cancel failed — continuing');
    return null;
  }
}

// ─── TRACKING / STATUS / ISSUE MANAGEMENT ─────────────────────
// Part 2 additions. Keep the same shape as above: inner client(), spec
// URL + body, pick canonical fields from the response (with defensive
// fallbacks), rethrow on failure so callers can decide the fallback.

// Thrown by raiseIssue when Prorouting reports that an open issue is
// already attached to the delivery order. Callers treat it as a
// soft-idempotent success (no new issue created, original still live).
class DuplicateIssueError extends Error {
  constructor(message) {
    super(message || 'Open issue already present for this order');
    this.name = 'DuplicateIssueError';
    this.code = 'PROROUTING_DUPLICATE_ISSUE';
  }
}

// POST /track. Polled from the restaurant dashboard to draw the rider
// on a map. Prorouting's preprod response nests coords under
// `order.fulfillments[0].agent.location` (lat/lng as strings), with the
// Nomad tracking page URL at `order.fulfillments[0].tracking.url`.
// Fall back through a few alias paths so minor spec drift doesn't kill us.
async function getTrackingInfo(proroutingOrderId) {
  if (!proroutingOrderId) throw new Error('prorouting.getTrackingInfo: proroutingOrderId is required');
  const t0 = Date.now();
  try {
    const { data } = await client().post('/partner/order/track', { order: { id: String(proroutingOrderId) } });
    const fulfilment = data?.order?.fulfillments?.[0] || data?.fulfillments?.[0] || data?.order || data || {};
    const agentLoc = fulfilment?.agent?.location || fulfilment?.agent_location || data?.agent?.location || {};
    const trackingBlock = fulfilment?.tracking || data?.tracking || {};

    const rider_lat = agentLoc.lat != null ? Number(agentLoc.lat) : (agentLoc.latitude != null ? Number(agentLoc.latitude) : null);
    const rider_lng = agentLoc.lng != null ? Number(agentLoc.lng) : (agentLoc.longitude != null ? Number(agentLoc.longitude) : null);
    const tracking_url = trackingBlock.url || trackingBlock.tracking_url || data?.tracking_url || null;

    log.info({ ms: Date.now() - t0, prorouting_order_id: proroutingOrderId, has_coords: rider_lat != null, has_url: !!tracking_url }, 'track ok');
    return { rider_lat, rider_lng, tracking_url };
  } catch (e) {
    log.warn({ ms: Date.now() - t0, err: e.message, status: e.response?.status, body: e.response?.data }, 'track failed');
    throw new Error(e.response?.data?.message || e.message);
  }
}

// POST /status. Polling fallback when we suspect a webhook was missed.
// Returns the canonical state string (Agent-assigned, Order-picked-up,
// Order-delivered, RTO-Initiated, etc.) plus the agent details when the
// rider is assigned. Shape mirrors the webhook body so callers can reuse
// the same state-transition handler.
async function getOrderStatus(proroutingOrderId) {
  if (!proroutingOrderId) throw new Error('prorouting.getOrderStatus: proroutingOrderId is required');
  const t0 = Date.now();
  try {
    const { data } = await client().post('/partner/order/status', { order: { id: String(proroutingOrderId) } });
    const fulfilment = data?.order?.fulfillments?.[0] || data?.fulfillments?.[0] || data?.order || data || {};
    const state = fulfilment?.state?.descriptor?.code
      || fulfilment?.state?.code
      || fulfilment?.state
      || data?.state
      || null;
    const agent = fulfilment?.agent || data?.agent || null;

    log.info({ ms: Date.now() - t0, prorouting_order_id: proroutingOrderId, state }, 'status ok');
    return { state, agent };
  } catch (e) {
    log.warn({ ms: Date.now() - t0, err: e.message, status: e.response?.status, body: e.response?.data }, 'status failed');
    throw new Error(e.response?.data?.message || e.message);
  }
}

// POST /partner/order/issue. Category is always FULFILLMENT; subCategory
// identifies the specific complaint (FLM02 wrong-item, FLM03 RTO,
// FLM08 damaged). Returns the Prorouting issue id + initial state so
// we can link the issue back to the order row.
async function raiseIssue(proroutingOrderId, subCategory, shortDesc, longDesc) {
  if (!proroutingOrderId) throw new Error('prorouting.raiseIssue: proroutingOrderId is required');
  if (!subCategory) throw new Error('prorouting.raiseIssue: subCategory is required');

  const payload = {
    context: {
      domain: 'nic2004:60232',
      action: 'issue',
      timestamp: new Date().toISOString(),
    },
    message: {
      issue: {
        category: 'FULFILLMENT',
        sub_category: subCategory,
        complainant_info: {},
        order_details: {
          id: String(proroutingOrderId),
        },
        description: {
          short_desc: shortDesc || '',
          long_desc: longDesc || shortDesc || '',
        },
        source: {
          network_participant_id: 'gullybite',
          type: 'CONSUMER',
        },
        issue_type: 'ISSUE',
        status: 'OPEN',
      },
    },
  };

  const t0 = Date.now();
  try {
    const { data } = await client().post('/partner/order/issue', payload);
    const issueBlock = data?.message?.issue || data?.issue || data || {};
    const issue_id = issueBlock.id || issueBlock.issue_id || data?.issue_id || null;
    const issue_state = issueBlock.status || issueBlock.state || data?.issue_state || 'OPEN';

    log.info({ ms: Date.now() - t0, prorouting_order_id: proroutingOrderId, sub_category: subCategory, issue_id, issue_state }, 'raiseIssue ok');
    return { issue_id, issue_state };
  } catch (e) {
    const body = e.response?.data || {};
    const msg = body?.message || body?.error?.message || e.message || '';
    if (/open issue already present/i.test(msg)) {
      log.info({ prorouting_order_id: proroutingOrderId, sub_category: subCategory }, 'raiseIssue duplicate — issue already open');
      throw new DuplicateIssueError(msg);
    }
    log.warn({ ms: Date.now() - t0, err: msg, status: e.response?.status, body }, 'raiseIssue failed');
    throw new Error(msg || 'raiseIssue failed');
  }
}

// POST /partner/order/issue_status. Returns the full issue block so
// callers (admin dashboard) can render resolution text, LSP response,
// and timestamps.
async function getIssueStatus(issueId) {
  if (!issueId) throw new Error('prorouting.getIssueStatus: issueId is required');
  const t0 = Date.now();
  try {
    const { data } = await client().post('/partner/order/issue_status', { issue: { id: String(issueId) } });
    const issue = data?.message?.issue || data?.issue || data || {};
    log.info({ ms: Date.now() - t0, issue_id: issueId, state: issue.status || issue.state }, 'getIssueStatus ok');
    return issue;
  } catch (e) {
    log.warn({ ms: Date.now() - t0, err: e.message, status: e.response?.status, body: e.response?.data }, 'getIssueStatus failed');
    throw new Error(e.response?.data?.message || e.message);
  }
}

// POST /partner/order/issue_close. Closes the dispute with a rating
// (THUMBS-UP / THUMBS-DOWN) and final refund disposition. Returns the
// acknowledgement message from Prorouting.
async function closeIssue(issueId, rating, refundByLsp, refundToClient) {
  if (!issueId) throw new Error('prorouting.closeIssue: issueId is required');
  if (!rating || !['THUMBS-UP', 'THUMBS-DOWN'].includes(rating)) {
    throw new Error("prorouting.closeIssue: rating must be 'THUMBS-UP' or 'THUMBS-DOWN'");
  }

  const payload = {
    issue: {
      id: String(issueId),
      rating,
      resolution: {
        refund_by_lsp: !!refundByLsp,
        refund_to_client: !!refundToClient,
      },
      status: 'CLOSED',
    },
  };

  const t0 = Date.now();
  try {
    const { data } = await client().post('/partner/order/issue_close', payload);
    const message = data?.message?.message || data?.message || 'closed';
    log.info({ ms: Date.now() - t0, issue_id: issueId, rating }, 'closeIssue ok');
    return { message };
  } catch (e) {
    log.warn({ ms: Date.now() - t0, err: e.message, status: e.response?.status, body: e.response?.data }, 'closeIssue failed');
    throw new Error(e.response?.data?.message || e.message);
  }
}

module.exports = {
  getEstimate,
  createDeliveryOrder,
  cancelDeliveryOrder,
  getTrackingInfo,
  getOrderStatus,
  raiseIssue,
  getIssueStatus,
  closeIssue,
  DuplicateIssueError,
};
