// src/services/integrations/petpooja.js
// Fetches menu from PetPooja POS and normalizes it to our schema
// PetPooja API docs: https://api.petpooja.com
//
// Credentials needed:
//   api_key      — your app's API key from PetPooja developer account
//   access_token — restaurant-specific token
//   outlet_id    — PetPooja restaurantid (shown in PetPooja dashboard)

const axios = require('axios');

const BASE = 'https://api.petpooja.com/V1/restaurant';
const TIMEOUT = 20000;

// PetPooja food type → our food_type enum
const FOOD_TYPE_MAP = {
  '1': 'veg',
  '2': 'non_veg',
  '3': 'egg',
  '4': 'vegan',
};

async function fetchMenu(integration) {
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

  // ── Normalize items ────────────────────────────────────
  const items = rawItems.map(item => ({
    external_id  : `pp_${item.itemid}`,      // prefix to avoid collisions with other POS
    name         : item.itemname,
    description  : item.item_description || item.itemname,
    price        : parseFloat(item.price || item.itemallowvariation === '1' ? item.variations?.[0]?.price : item.price) || 0,
    food_type    : FOOD_TYPE_MAP[item.item_type] || 'veg',
    category     : catNameById[item.categoryid] || 'Menu',
    image_url    : item.item_image_url || null,
    is_available : item.item_active === '1',
  }));

  console.log(`[PetPooja] Fetched ${categories.length} categories, ${items.length} items for outlet ${outlet_id}`);

  return { categories, items };
}

module.exports = { fetchMenu };
