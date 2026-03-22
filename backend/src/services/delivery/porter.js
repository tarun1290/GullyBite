// src/services/delivery/porter.js
// Porter 3PL integration — India's primary restaurant delivery partner
// API docs: https://porter.in/api-docs

const axios = require('axios');

const BASE_URL = process.env.PORTER_BASE_URL || 'https://pfe-apigw-uat.porter.in';
const API_KEY = process.env.PORTER_API_KEY;

const name = 'porter';

const ensureApiKey = () => {
  if (!API_KEY) throw new Error('PORTER_API_KEY is not configured');
};

const client = () => {
  ensureApiKey();
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    timeout: 10000,
  });
};

// ─── FORMAT PHONE ────────────────────────────────────────────────
// Porter expects { country_code: '+91', number: '9876543210' }
const formatPhone = (phone) => {
  const cleaned = String(phone || '').replace(/[^0-9]/g, '');
  // Remove leading 91 if 12 digits
  const number = cleaned.length === 12 && cleaned.startsWith('91')
    ? cleaned.slice(2)
    : cleaned;
  return { country_code: '+91', number: number || '0000000000' };
};

// ─── GET QUOTE ───────────────────────────────────────────────────
const getQuote = async (pickup, drop, orderDetails = {}) => {
  ensureApiKey();

  const res = await client().post('/v1/get_quote', {
    pickup_details: {
      lat: pickup.lat,
      lng: pickup.lng,
    },
    drop_details: {
      lat: drop.lat,
      lng: drop.lng,
    },
    customer: {
      name: drop.contactName || 'Customer',
      mobile: formatPhone(drop.contactPhone),
    },
  });

  const data = res.data;

  // Porter returns vehicles array — pick the cheapest/fastest bike option
  const vehicles = data.vehicles || [];
  const bike = vehicles.find(v => v.type === 'bike' || v.type === '2wheeler')
    || vehicles[0]
    || {};

  const fareEstimate = bike.fare?.minor_amount
    ? bike.fare.minor_amount / 100
    : parseFloat(bike.fare?.amount || bike.estimated_fare || data.estimated_fare || 0);

  return {
    deliveryFeeRs: Math.round(fareEstimate * 100) / 100,
    estimatedMins: parseInt(bike.eta?.duration || data.estimated_pickup_duration || 25, 10),
    distanceKm: parseFloat(bike.distance?.value_in_meters ? bike.distance.value_in_meters / 1000 : data.distance_in_km || 0),
    quoteId: data.request_id || data.quote_id || data.estimate_id || null,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 min validity
    surgeActive: !!(bike.fare?.is_surge || data.is_surge),
    providerName: 'porter',
  };
};

// ─── CREATE TASK ─────────────────────────────────────────────────
const createTask = async (pickup, drop, orderDetails = {}, quoteId = null) => {
  ensureApiKey();

  const payload = {
    pickup_details: {
      lat: pickup.lat,
      lng: pickup.lng,
      address: pickup.address ? { apartment_address: '', street_address1: pickup.address } : undefined,
      contact_details: {
        name: pickup.contactName || 'Restaurant',
        phone_number: formatPhone(pickup.contactPhone).number,
      },
    },
    drop_details: {
      lat: drop.lat,
      lng: drop.lng,
      address: drop.address ? { apartment_address: '', street_address1: drop.address } : undefined,
      contact_details: {
        name: drop.contactName || 'Customer',
        phone_number: formatPhone(drop.contactPhone).number,
      },
    },
    delivery_instructions: {
      instructions_list: [
        { type: 'text', description: `Order #${orderDetails.orderNumber || 'N/A'}` },
      ],
    },
  };

  if (quoteId) payload.request_id = quoteId;

  const res = await client().post('/v1/orders/create', payload);
  const data = res.data;

  return {
    taskId: data.order_id || data.request_id || data.id,
    trackingUrl: data.tracking_url || data.tracking_link || null,
    estimatedMins: parseInt(data.estimated_pickup_duration || data.eta || 25, 10),
    status: 'assigned',
  };
};

// ─── CANCEL TASK ─────────────────────────────────────────────────
const cancelTask = async (taskId) => {
  ensureApiKey();
  try {
    await client().post(`/v1/orders/${taskId}/cancel`, {
      reason: 'Order cancelled by restaurant',
    });
    return { success: true, refundable: true };
  } catch (err) {
    // If already delivered/cancelled, ignore
    if (err.response?.status === 400 || err.response?.status === 409) {
      return { success: false, refundable: false, message: err.response?.data?.message || 'Cannot cancel' };
    }
    throw err;
  }
};

// ─── GET TASK STATUS ─────────────────────────────────────────────
const getTaskStatus = async (taskId) => {
  ensureApiKey();

  const res = await client().get(`/v1/orders/${taskId}`);
  const data = res.data;

  const partner = data.partner_info || data.driver || {};
  return {
    status: normalizePorterStatus(data.status),
    driverName: partner.name || null,
    driverPhone: partner.mobile?.number || partner.phone || null,
    driverLat: parseFloat(partner.location?.lat) || null,
    driverLng: parseFloat(partner.location?.lng) || null,
    estimatedMins: parseInt(data.eta?.duration || data.estimated_delivery_time, 10) || null,
  };
};

// ─── NORMALIZE PORTER STATUS ─────────────────────────────────────
const normalizePorterStatus = (raw) => {
  const s = (raw || '').toLowerCase().replace(/[^a-z_]/g, '');
  const map = {
    'open': 'pending',
    'accepted': 'assigned',
    'allotted': 'assigned',
    'arrived_for_pickup': 'assigned',
    'reached_for_pickup': 'assigned',
    'dispatched': 'picked_up',
    'started': 'picked_up',
    'in_transit': 'picked_up',
    'reached_for_delivery': 'picked_up',
    'completed': 'delivered',
    'delivered': 'delivered',
    'cancelled': 'cancelled',
    'canceled': 'cancelled',
    'failed': 'failed',
  };
  return map[s] || 'assigned';
};

module.exports = { name, getQuote, createTask, cancelTask, getTaskStatus };
