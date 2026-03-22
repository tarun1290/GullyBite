// src/services/integrations/urbanpiper.js
// UrbanPiper aggregator integration — menu pull + order push
// UrbanPiper connects Swiggy, Zomato, and others via a single API
//
// Credentials needed:
//   api_key      — UrbanPiper API key
//   api_secret   — UrbanPiper API secret (used for HMAC auth header)
//   outlet_id    — UrbanPiper store/location ID

const axios = require('axios');
const crypto = require('crypto');

const BASE = 'https://pos-api.urbanpiper.com/external/api/v1';
const TIMEOUT = 20000;

function authHeaders(apiKey, apiSecret) {
  return {
    'Content-Type': 'application/json',
    'X-API-Key': apiKey,
    'X-API-Secret': apiSecret,
  };
}

// ─── MENU PULL ──────────────────────────────────────────────────
async function fetchMenu(integration) {
  const { api_key, api_secret, outlet_id } = integration;
  if (!api_key || !api_secret || !outlet_id) {
    throw new Error('UrbanPiper: api_key, api_secret and outlet_id are all required');
  }

  const headers = authHeaders(api_key, api_secret);

  // Fetch categories
  let rawCategories = [];
  try {
    const res = await axios.get(`${BASE}/inventory/locations/${outlet_id}/categories/`, {
      headers, timeout: TIMEOUT,
    });
    rawCategories = res.data?.categories || [];
  } catch (err) {
    throw new Error(`UrbanPiper categories fetch failed: ${err.response?.data?.message || err.message}`);
  }

  // Fetch items
  let rawItems = [];
  try {
    const res = await axios.get(`${BASE}/inventory/locations/${outlet_id}/`, {
      headers, timeout: TIMEOUT,
    });
    rawItems = res.data?.items || [];
  } catch (err) {
    throw new Error(`UrbanPiper items fetch failed: ${err.response?.data?.message || err.message}`);
  }

  // Build category ref_id → name map
  const catNameById = {};
  rawCategories.forEach(c => {
    catNameById[c.ref_id || c.id] = c.name || c.title;
  });

  const categories = rawCategories.map((c, i) => ({
    name: c.name || c.title,
    sort_order: c.sort_order ?? i,
  }));

  const items = rawItems.map(item => ({
    external_id: `up_${item.ref_id || item.id}`,
    name: item.title || item.name,
    description: item.description || item.title || '',
    price: parseFloat(item.price || item.current_stock?.price || 0),
    food_type: item.food_type === 2 ? 'non_veg' : item.food_type === 3 ? 'egg' : 'veg',
    category: catNameById[item.category_ref_id] || 'Menu',
    image_url: item.img_url || item.image_url || null,
    is_available: item.available !== false && item.current_stock?.in_stock !== false,
  }));

  console.log(`[UrbanPiper] Fetched ${categories.length} categories, ${items.length} items for outlet ${outlet_id}`);
  return { categories, items };
}

// ─── ORDER PUSH ─────────────────────────────────────────────────
// Push a confirmed GullyBite order to UrbanPiper for POS reconciliation
async function pushOrder(integration, order, items) {
  const { api_key, api_secret, outlet_id } = integration;
  if (!api_key || !api_secret) {
    throw new Error('UrbanPiper: api_key and api_secret required for order push');
  }

  const headers = authHeaders(api_key, api_secret);

  const payload = {
    store: { ref_id: outlet_id },
    order: {
      ext_id: String(order._id),
      channel: 'whatsapp',
      details: {
        order_type: order.order_type === 'pickup' ? 'pickup' : 'delivery',
        order_subtotal: parseFloat(order.subtotal_rs) || 0,
        order_total: parseFloat(order.total_rs) || 0,
        taxes: parseFloat(order.food_gst_rs) || 0,
        delivery_charge: parseFloat(order.customer_delivery_rs) || 0,
        discount: parseFloat(order.discount_rs) || 0,
        packaging_charge: parseFloat(order.packaging_rs) || 0,
      },
      items: items.map(item => ({
        ref_id: item.external_id?.replace('up_', '') || String(item._id),
        title: item.name || item.item_name,
        quantity: item.quantity || item.qty || 1,
        price: parseFloat(item.price_rs || (item.price_paise ? item.price_paise / 100 : 0)),
        total: parseFloat(item.price_rs || (item.price_paise ? item.price_paise / 100 : 0)) * (item.quantity || item.qty || 1),
      })),
      customer: {
        name: order.customer_name || '',
        phone: order.customer_phone || '',
        address: order.delivery_address || '',
      },
      payment: {
        type: 'prepaid',
        option: 'online',
        amount: parseFloat(order.total_rs) || 0,
      },
    },
  };

  try {
    const res = await axios.post(`${BASE}/orders/`, payload, {
      headers, timeout: TIMEOUT,
    });
    console.log(`[UrbanPiper] Order ${order._id} pushed successfully`);
    return { success: true, externalOrderId: res.data?.order_id || res.data?.id };
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    console.error(`[UrbanPiper] Order push failed: ${msg}`);
    throw new Error(`UrbanPiper order push failed: ${msg}`);
  }
}

// ─── STATUS UPDATE ──────────────────────────────────────────────
// Sync GullyBite order status to UrbanPiper
async function updateOrderStatus(integration, orderId, status) {
  const { api_key, api_secret } = integration;
  const headers = authHeaders(api_key, api_secret);

  const statusMap = {
    CONFIRMED: 'Acknowledged',
    PREPARING: 'Food Ready',
    DISPATCHED: 'Dispatched',
    DELIVERED: 'Completed',
    CANCELLED: 'Cancelled',
  };

  const upStatus = statusMap[status];
  if (!upStatus) return; // Not a mappable status

  try {
    await axios.put(`${BASE}/orders/${orderId}/status/`, {
      new_status: upStatus,
    }, { headers, timeout: TIMEOUT });
  } catch (err) {
    console.error(`[UrbanPiper] Status update failed for ${orderId}: ${err.message}`);
  }
}

module.exports = { fetchMenu, pushOrder, updateOrderStatus };
