// src/services/integrations/dotpe.js
// DotPe POS integration — menu pull + order push
// DotPe is widely used by Indian restaurants for dine-in + delivery POS
// Variant explosion: variants/customizations with size-like entries → separate menu_items rows
//
// Credentials needed:
//   api_key      — DotPe partner API key
//   access_token — Restaurant-specific access token from DotPe
//   outlet_id    — DotPe store/outlet ID

// POS_DISABLED — this module is disabled. Remove this guard to re-enable.
module.exports = {};
return;

const axios = require('axios');
const { POS_INTEGRATIONS_ENABLED } = require('../../config/features');
const log = require('../../utils/logger').child({ component: 'DotPe' });

const BASE = 'https://api.dotpe.in/api/merchant/v2';
const TIMEOUT = 10000;

// Keywords that indicate a size/portion variant (vs an add-on/modifier)
const SIZE_KEYWORDS = ['size', 'portion', 'quantity', 'pack', 'serves', 'type', 'variant', 'piece', 'pcs'];

// DotPe food type → display label
const FOOD_TAG_MAP = { 0: 'Veg', 1: 'Non-Veg', 2: 'Egg' };
const FOOD_TYPE_MAP = { 0: 'veg', 1: 'non_veg', 2: 'egg' };

function authHeaders(apiKey, accessToken) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    Authorization: `Bearer ${accessToken}`,
  };
}

const slugify = require('../../utils/slugify');

function isSizeVariant(variant) {
  // DotPe variants can have a group_name or just be flat name/price entries.
  // If there's a group_name, check it. Otherwise treat as size variant by default.
  const groupName = (variant.group_name || variant.customization_group_name || '').toLowerCase();
  if (!groupName) return true; // flat variants without group → treat as size
  return SIZE_KEYWORDS.some(k => groupName.includes(k));
}

// ─── MENU PULL ──────────────────────────────────────────────────
async function fetchMenu(integration) {
  if (!POS_INTEGRATIONS_ENABLED) {
    log.info('fetchMenu skipped — POS integrations disabled');
    return { categories: [], items: [] };
  }
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

  // ── Normalize items with variant explosion ─────────────
  const now = new Date();
  const items = [];
  let variantCount = 0;

  for (const item of rawItems) {
    const itemId = String(item.id || item.item_id);
    const rawFoodType = item.food_type ?? item.veg_nonveg ?? 0;
    const foodTag = FOOD_TAG_MAP[rawFoodType] || 'Veg';
    const category = catNameById[item.category_id] || 'Menu';
    const tags = [foodTag, category];
    if (item.bestseller || item.is_bestseller) tags.push('Bestseller');
    if (item.is_new) tags.push('New');
    if (item.is_spicy) tags.push('Spicy');

    const basePrice = parseFloat(item.price || item.selling_price || 0);

    const base = {
      name         : item.name || item.item_name,
      description  : item.description || item.item_description || '',
      image_url    : item.image || item.image_url || null,
      is_available : item.in_stock !== false && item.is_available !== false,
      pos_item_id  : itemId,
      pos_platform : 'dotpe',
      food_type    : FOOD_TYPE_MAP[rawFoodType] || 'veg',
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

    // DotPe may use "variants" or "customizations" array
    const rawVariants = item.variants || item.customizations || [];
    // Filter to only size-like variants
    const sizeVariants = rawVariants.filter(v => isSizeVariant(v));
    const hasVariants = sizeVariants.length > 1;

    if (hasVariants) {
      const groupId = `DP-${itemId}`;
      for (const v of sizeVariants) {
        const size = v.name || v.variant_name || 'Regular';
        const vPrice = parseFloat(v.price || v.selling_price) || basePrice;
        items.push({
          ...base,
          price_paise    : Math.round(vPrice * 100),
          retailer_id    : `DP-${itemId}-${slugify(size)}`,
          item_group_id  : groupId,
          size,
        });
        variantCount++;
      }
    } else {
      // Single item or single variant → no group
      const price = sizeVariants.length === 1
        ? parseFloat(sizeVariants[0].price || sizeVariants[0].selling_price) || basePrice
        : basePrice;
      items.push({
        ...base,
        price_paise    : Math.round(price * 100),
        retailer_id    : `DP-${itemId}`,
        item_group_id  : null,
        size           : null,
      });
    }
  }

  log.info({ posItems: rawItems.length, menuRows: items.length, variantRows: variantCount, outletId: outlet_id }, 'Menu fetched');
  return { categories, items };
}

// ─── ORDER PUSH ─────────────────────────────────────────────────
async function pushOrder(integration, order, items) {
  if (!POS_INTEGRATIONS_ENABLED) {
    return { success: false, skipped: true, reason: 'POS integrations disabled' };
  }
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
      item_id: item.external_id?.replace('dp_', '') || item.pos_item_id || String(item._id),
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
    log.info({ orderId: order._id }, 'Order pushed successfully');
    return { success: true, externalOrderId: res.data?.order_id || res.data?.data?.id };
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    log.error({ errorMsg: msg }, 'Order push failed');
    throw new Error(`DotPe order push failed: ${msg}`);
  }
}

// ─── STATUS UPDATE ──────────────────────────────────────────────
async function updateOrderStatus(integration, orderId, status) {
  if (!POS_INTEGRATIONS_ENABLED) {
    return { success: false, skipped: true };
  }
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
    log.error({ err, orderId }, 'Status update failed');
  }
}

// ─── WEBHOOK PARSERS ─────────────────────────────────────
function parseWebhookEvent(payload) {
  try {
    const eventType = (payload.event || payload.event_type || payload.type || '').toLowerCase();
    const outletId = payload.outlet_id || payload.store_id || payload.data?.outlet_id || null;
    if (eventType.includes('stock')) {
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
    const rawItems = payload.payload?.items || payload.items || payload.data?.items || [];
    const items = rawItems.map(i => ({
      pos_item_id: String(i.item_id || i.id || ''),
      is_available: i.in_stock === true || i.available === true || i.status === 'active',
    }));
    return { items, outletId: payload.outlet_id || null };
  } catch (e) {
    log.warn({ err: e }, 'parseStockUpdate failed');
    return { items: [], outletId: null };
  }
}

module.exports = { fetchMenu, pushOrder, updateOrderStatus, parseWebhookEvent, parseStockUpdate };
