// src/services/integrations/urbanpiper.js
// UrbanPiper aggregator integration — menu pull + order push
// UrbanPiper connects Swiggy, Zomato, and others via a single API
// Variant explosion: option_groups with size-like titles → separate menu_items rows
//
// Credentials needed:
//   api_key      — UrbanPiper API key
//   api_secret   — UrbanPiper API secret (used for HMAC auth header)
//   outlet_id    — UrbanPiper store/location ID

const axios = require('axios');
const { POS_INTEGRATIONS_ENABLED } = require('../../config/features');
const log = require('../../utils/logger').child({ component: 'UrbanPiper' });

const BASE = 'https://pos-api.urbanpiper.com/external/api/v1';
const TIMEOUT = 10000;

// Keywords that indicate a size/portion variant (vs an add-on/modifier)
const SIZE_KEYWORDS = ['size', 'portion', 'quantity', 'pack', 'serves', 'type', 'variant', 'piece', 'pcs'];

function authHeaders(apiKey, apiSecret) {
  return {
    'Content-Type': 'application/json',
    'X-API-Key': apiKey,
    'X-API-Secret': apiSecret,
  };
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function isSizeGroup(group) {
  const title = (group.title || group.name || '').toLowerCase();
  return SIZE_KEYWORDS.some(k => title.includes(k));
}

// ─── MENU PULL ──────────────────────────────────────────────────
async function fetchMenu(integration) {
  if (!POS_INTEGRATIONS_ENABLED) {
    log.info('fetchMenu skipped — POS integrations disabled');
    return { categories: [], items: [] };
  }
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

  // ── Normalize items with variant explosion ─────────────
  const now = new Date();
  const items = [];
  let variantCount = 0;

  for (const item of rawItems) {
    const refId = String(item.ref_id || item.id);
    const foodType = item.food_type === 2 ? 'Non-Veg' : item.food_type === 3 ? 'Egg' : 'Veg';
    const category = catNameById[item.category_ref_id] || 'Menu';
    const tags = [foodType, category];
    if (item.recommended || item.bestseller) tags.push('Bestseller');

    const basePrice = parseFloat(item.price || item.current_stock?.price || 0);

    const base = {
      name         : item.title || item.name,
      description  : item.description || '',
      image_url    : item.img_url || item.image_url || null,
      is_available : item.available !== false && item.current_stock?.in_stock !== false,
      pos_item_id  : refId,
      pos_platform : 'urbanpiper',
      food_type    : foodType.toLowerCase().replace('-', '_'),
      category,
      google_product_category : 'Food, Beverages & Tobacco > Food Items',
      fb_product_category     : 'Food & Beverages > Prepared Food',
      product_tags : tags,
      brand        : null,
      sale_price_paise : null,
      quantity_to_sell_on_facebook : null,
      condition    : 'new',
      pos_synced_at        : now,
      catalog_sync_status  : 'pending',
    };

    // Find size variant group (if any)
    const optionGroups = item.option_groups || item.options_groups || [];
    const sizeGroup = optionGroups.find(g => isSizeGroup(g));
    const sizeOptions = sizeGroup?.options || [];
    const hasVariants = sizeOptions.length > 1;

    if (hasVariants) {
      const groupId = `UP-${refId}`;
      for (const opt of sizeOptions) {
        const size = opt.title || opt.name || 'Regular';
        const optPrice = parseFloat(opt.price) || 0;
        items.push({
          ...base,
          price_paise    : Math.round((basePrice + optPrice) * 100),
          retailer_id    : `UP-${refId}-${slugify(size)}`,
          item_group_id  : groupId,
          size,
        });
        variantCount++;
      }
    } else {
      items.push({
        ...base,
        price_paise    : Math.round(basePrice * 100),
        retailer_id    : `UP-${refId}`,
        item_group_id  : null,
        size           : null,
      });
    }
  }

  log.info({ posItems: rawItems.length, menuRows: items.length, variantRows: variantCount, outletId: outlet_id }, 'Menu fetched');
  return { categories, items };
}

// ─── ORDER PUSH ─────────────────────────────────────────────────
// Push a confirmed GullyBite order to UrbanPiper for POS reconciliation
async function pushOrder(integration, order, items) {
  if (!POS_INTEGRATIONS_ENABLED) {
    return { success: false, skipped: true, reason: 'POS integrations disabled' };
  }
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
        ref_id: item.external_id?.replace('up_', '') || item.pos_item_id || String(item._id),
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
    log.info({ orderId: order._id }, 'Order pushed successfully');
    return { success: true, externalOrderId: res.data?.order_id || res.data?.id };
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    log.error({ errorMsg: msg }, 'Order push failed');
    throw new Error(`UrbanPiper order push failed: ${msg}`);
  }
}

// ─── STATUS UPDATE ──────────────────────────────────────────────
async function updateOrderStatus(integration, orderId, status) {
  if (!POS_INTEGRATIONS_ENABLED) {
    return { success: false, skipped: true };
  }
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
  if (!upStatus) return;

  try {
    await axios.put(`${BASE}/orders/${orderId}/status/`, {
      new_status: upStatus,
    }, { headers, timeout: TIMEOUT });
  } catch (err) {
    log.error({ err, orderId }, 'Status update failed');
  }
}

// ─── WEBHOOK PARSERS ─────────────────────────────────────
function parseWebhookEvent(payload) {
  try {
    const eventType = (payload.event_type || payload.type || '').toLowerCase();
    const outletId = payload.store_id || payload.outlet_id || payload.data?.store_id || null;
    if (eventType.includes('stock') || eventType.includes('item.stock')) {
      return { type: 'stock_update', outletId, items: parseStockUpdate(payload).items };
    }
    if (eventType.includes('menu')) {
      return { type: 'menu_update', outletId };
    }
    return { type: 'unknown', outletId };
  } catch (e) {
    log.warn({ err: e }, 'parseWebhookEvent failed');
    return { type: 'unknown' };
  }
}

function parseStockUpdate(payload) {
  try {
    const rawItems = payload.data?.items || payload.items || [];
    const items = rawItems.map(i => ({
      pos_item_id: String(i.ref_id || i.item_ref_id || i.id || ''),
      is_available: i.current_stock > 0 || i.in_stock === true || i.available === true,
    }));
    return { items, outletId: payload.store_id || payload.data?.store_id || null };
  } catch (e) {
    log.warn({ err: e }, 'parseStockUpdate failed');
    return { items: [], outletId: null };
  }
}

module.exports = { fetchMenu, pushOrder, updateOrderStatus, parseWebhookEvent, parseStockUpdate };
