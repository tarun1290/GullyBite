// src/services/integrations/petpooja.js
// Fetches menu from PetPooja POS and normalizes to full Meta-ready menu_items schema.
// Variant explosion: POS size/portion variants → separate menu_items rows with shared item_group_id.
//
// Credentials needed:
//   api_key      — your app's API key from PetPooja developer account
//   access_token — restaurant-specific token
//   outlet_id    — PetPooja restaurantid (shown in PetPooja dashboard)

// POS_DISABLED — this module is disabled. Remove this guard to re-enable.
module.exports = {};
return;

const axios = require('axios');
const { POS_INTEGRATIONS_ENABLED } = require('../../config/features');
const log = require('../../utils/logger').child({ component: 'PetPooja' });

const BASE = 'https://api.petpooja.com/V1/restaurant';
const TIMEOUT = 10000;

// PetPooja food type → display label for product_tags
const FOOD_TYPE_MAP = {
  '1': 'Veg',
  '2': 'Non-Veg',
  '3': 'Egg',
  '4': 'Vegan',
};

const slugify = require('../../utils/slugify');

async function fetchMenu(integration) {
  if (!POS_INTEGRATIONS_ENABLED) {
    log.info('fetchMenu skipped — POS integrations disabled');
    return { categories: [], items: [] };
  }
  const { api_key, access_token, outlet_id } = integration;

  if (!api_key || !access_token || !outlet_id) {
    throw new Error('PetPooja: api_key, access_token and outlet_id are all required');
  }

  const payload = {
    app_key      : api_key,
    access_token : access_token,
    restaurantid : outlet_id,
  };

  // ── STEP 1: Fetch categories ───────────────────────────
  let rawCategories = [];
  try {
    const catRes = await axios.post(`${BASE}/getRestaurantCategories`, payload, {
      timeout: TIMEOUT,
    });
    rawCategories = catRes.data?.categories || [];
  } catch (err) {
    throw new Error(`PetPooja categories fetch failed: ${err.response?.data?.message || err.message}`);
  }

  // ── STEP 2: Fetch items ────────────────────────────────
  let rawItems = [];
  try {
    const itemRes = await axios.post(`${BASE}/getRestaurantItems`, payload, {
      timeout: TIMEOUT,
    });
    rawItems = itemRes.data?.items || [];
  } catch (err) {
    throw new Error(`PetPooja items fetch failed: ${err.response?.data?.message || err.message}`);
  }

  // ── Build category id → name map ──────────────────────
  const catNameById = {};
  rawCategories.forEach(c => {
    catNameById[c.categoryid] = c.categoryname;
  });

  // ── Normalize categories ───────────────────────────────
  const categories = rawCategories.map((c, i) => ({
    name       : c.categoryname,
    sort_order : i,
  }));

  // ── Normalize items with variant explosion ─────────────
  const now = new Date();
  const items = [];
  let variantCount = 0;

  for (const item of rawItems) {
    const foodTag = FOOD_TYPE_MAP[item.item_type] || 'Veg';
    const category = catNameById[item.categoryid] || 'Menu';
    const tags = [foodTag, category];
    if (item.bestseller === '1' || item.is_bestseller) tags.push('Bestseller');
    if (item.is_new === '1') tags.push('New');

    const base = {
      name         : item.itemname,
      description  : item.item_description || '',
      image_url    : item.item_image_url || null,
      is_available : item.item_active === '1',
      pos_item_id  : String(item.itemid),
      pos_platform : 'petpooja',
      food_type    : foodTag.toLowerCase().replace('-', '_'),
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

    const variations = Array.isArray(item.variations) ? item.variations : [];
    const hasVariants = item.itemallowvariation === '1' && variations.length > 1;

    if (hasVariants) {
      const groupId = `PP-${item.itemid}`;
      for (const v of variations) {
        const size = v.name || v.variationname || 'Regular';
        items.push({
          ...base,
          price_paise    : Math.round((parseFloat(v.price) || 0) * 100),
          retailer_id    : `PP-${item.itemid}-${slugify(size)}`,
          item_group_id  : groupId,
          size,
        });
        variantCount++;
      }
    } else {
      const price = variations.length === 1
        ? parseFloat(variations[0].price) || parseFloat(item.price) || 0
        : parseFloat(item.price) || 0;
      items.push({
        ...base,
        price_paise    : Math.round(price * 100),
        retailer_id    : `PP-${item.itemid}`,
        item_group_id  : null,
        size           : null,
      });
    }
  }

  log.info({ posItems: rawItems.length, menuRows: items.length, variantRows: variantCount, outletId: outlet_id }, 'Menu fetched');

  return { categories, items };
}

// ─── WEBHOOK PARSERS ─────────────────────────────────────
function parseWebhookEvent(payload) {
  try {
    const eventType = (payload.eventtype || payload.event_type || payload.type || '').toLowerCase();
    const outletId = payload.restaurantid || payload.restaurant_id || payload.outlet_id || null;
    if (eventType.includes('stock') || eventType.includes('itemstock')) {
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
    const items = (payload.items || payload.data?.items || []).map(i => ({
      pos_item_id: String(i.itemid || i.item_id || i.id || ''),
      is_available: i.item_active === '1' || i.status === 'active' || i.in_stock === true || i.active === 1,
    }));
    return { items, outletId: payload.restaurantid || payload.restaurant_id || null };
  } catch (e) {
    log.warn({ err: e }, 'parseStockUpdate failed');
    return { items: [], outletId: null };
  }
}

module.exports = { fetchMenu, parseWebhookEvent, parseStockUpdate };
