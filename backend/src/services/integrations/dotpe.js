// src/services/integrations/dotpe.js
// DotPe POS integration — menu pull + order push
// DotPe is widely used by Indian restaurants for dine-in + delivery POS
//
// Credentials needed:
//   api_key      — DotPe partner API key
//   access_token — Restaurant-specific access token from DotPe
//   outlet_id    — DotPe store/outlet ID

const axios = require('axios');

const BASE = 'https://api.dotpe.in/api/merchant/v2';
const TIMEOUT = 20000;

function authHeaders(apiKey, accessToken) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    Authorization: `Bearer ${accessToken}`,
  };
}

// ─── MENU PULL ──────────────────────────────────────────────────
async function fetchMenu(integration) {
  const { api_key, access_token, outlet_id } = integration;
  if (!api_key || !access_token || !outlet_id) {
    throw new Error('DotPe: api_key, access_token and outlet_id are all required');
  }

  const headers = authHeaders(api_key, access_token);

  // Fetch full menu (categories + items come together in DotPe)
  let menuData;
  try {
    const res = await axios.get(`${BASE}/stores/${outlet_id}/menu`, {
      headers, timeout: TIMEOUT,
    });
    menuData = res.data?.data || res.data || {};
  } catch (err) {
    throw new Error(`DotPe menu fetch failed: ${err.response?.data?.message || err.message}`);
  }

  const rawCategories = menuData.categories || menuData.menu_categories || [];
  const rawItems = menuData.items || menuData.menu_items || [];

  // Build category map
  const catNameById = {};
  rawCategories.forEach(c => {
    catNameById[c.id || c.category_id] = c.name || c.category_name;
  });

  const categories = rawCategories.map((c, i) => ({
    name: c.name || c.category_name,
    sort_order: c.sort_order ?? c.position ?? i,
  }));

  const FOOD_MAP = { 0: 'veg', 1: 'non_veg', 2: 'egg' };

  const items = rawItems.map(item => ({
    external_id: `dp_${item.id || item.item_id}`,
    name: item.name || item.item_name,
    description: item.description || item.item_description || '',
    price: parseFloat(item.price || item.selling_price || 0),
    food_type: FOOD_MAP[item.food_type] || FOOD_MAP[item.veg_nonveg] || 'veg',
    category: catNameById[item.category_id] || 'Menu',
    image_url: item.image || item.image_url || null,
    is_available: item.in_stock !== false && item.is_available !== false,
  }));

  console.log(`[DotPe] Fetched ${categories.length} categories, ${items.length} items for outlet ${outlet_id}`);
  return { categories, items };
}

// ─── ORDER PUSH ─────────────────────────────────────────────────
async function pushOrder(integration, order, items) {
  const { api_key, access_token, outlet_id } = integration;
  if (!api_key || !access_token) {
    throw new Error('DotPe: api_key and access_token required for order push');
  }

  const headers = authHeaders(api_key, access_token);

  const payload = {
    store_id: outlet_id,
    external_order_id: String(order._id),
    source: 'whatsapp',
    order_type: order.order_type === 'pickup' ? 'takeaway' : 'delivery',
    payment_mode: 'prepaid',
    customer: {
      name: order.customer_name || '',
      phone: order.customer_phone || '',
      address: order.delivery_address || '',
    },
    items: items.map(item => ({
      item_id: item.external_id?.replace('dp_', '') || String(item._id),
      name: item.name || item.item_name,
      quantity: item.quantity || item.qty || 1,
      price: parseFloat(item.price_rs || (item.price_paise ? item.price_paise / 100 : 0)),
    })),
    order_amount: {
      subtotal: parseFloat(order.subtotal_rs) || 0,
      total: parseFloat(order.total_rs) || 0,
      tax: parseFloat(order.food_gst_rs) || 0,
      delivery_charge: parseFloat(order.customer_delivery_rs) || 0,
      discount: parseFloat(order.discount_rs) || 0,
      packaging: parseFloat(order.packaging_rs) || 0,
    },
  };

  try {
    const res = await axios.post(`${BASE}/orders/external`, payload, {
      headers, timeout: TIMEOUT,
    });
    console.log(`[DotPe] Order ${order._id} pushed successfully`);
    return { success: true, externalOrderId: res.data?.order_id || res.data?.data?.id };
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    console.error(`[DotPe] Order push failed: ${msg}`);
    throw new Error(`DotPe order push failed: ${msg}`);
  }
}

// ─── STATUS UPDATE ──────────────────────────────────────────────
async function updateOrderStatus(integration, orderId, status) {
  const { api_key, access_token } = integration;
  const headers = authHeaders(api_key, access_token);

  const statusMap = {
    CONFIRMED: 'accepted',
    PREPARING: 'preparing',
    DISPATCHED: 'dispatched',
    DELIVERED: 'delivered',
    CANCELLED: 'cancelled',
  };

  const dpStatus = statusMap[status];
  if (!dpStatus) return;

  try {
    await axios.put(`${BASE}/orders/external/${orderId}/status`, {
      status: dpStatus,
    }, { headers, timeout: TIMEOUT });
  } catch (err) {
    console.error(`[DotPe] Status update failed for ${orderId}: ${err.message}`);
  }
}

module.exports = { fetchMenu, pushOrder, updateOrderStatus };
