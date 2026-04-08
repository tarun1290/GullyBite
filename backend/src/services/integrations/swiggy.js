// src/services/integrations/swiggy.js
// Fetches menu from Swiggy's Partner/Order Management API
//
// NOTE: Swiggy's API requires official partnership registration.
// Apply at: https://partner.swiggy.com
// Once approved, Swiggy provides:
//   api_key    — your partner API key
//   outlet_id  — your restaurant's Swiggy outlet ID (from partner portal)
//
// Swiggy pushes order webhooks; we pull menu via REST.

const axios = require('axios');
const log = require('../../utils/logger').child({ component: 'Swiggy' });

const BASE    = 'https://partner.swiggy.com/api/v1';
const TIMEOUT = 20000;

async function fetchMenu(integration) {
  const { api_key, outlet_id } = integration;

  if (!api_key || !outlet_id) {
    throw new Error('Swiggy: api_key and outlet_id are required');
  }

  // ── STEP 1: Get menu from Swiggy partner API ───────────
  let rawMenu;
  try {
    const res = await axios.get(`${BASE}/menu`, {
      params : { restaurantId: outlet_id },
      headers: { Authorization: `Bearer ${api_key}`, 'Content-Type': 'application/json' },
      timeout: TIMEOUT,
    });
    rawMenu = res.data?.data || res.data;
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.error || err.message;
    throw new Error(`Swiggy menu fetch failed: ${msg}`);
  }

  // ── Normalize categories ───────────────────────────────
  const rawCategories = rawMenu?.categories || [];
  const categories = rawCategories.map((cat, i) => ({
    name       : cat.name || cat.category_name || `Category ${i + 1}`,
    sort_order : cat.position || i,
  }));

  // ── Normalize items ────────────────────────────────────
  const items = [];
  rawCategories.forEach(cat => {
    const catName = cat.name || cat.category_name || 'Menu';
    (cat.items || cat.dishes || []).forEach(item => {
      // Swiggy food type: 1 = veg, 2 = non-veg
      const foodType = item.is_veg === 1 || item.isVeg === true ? 'veg' : 'non_veg';
      items.push({
        external_id  : `sw_${item.id || item.item_id}`,
        name         : item.name || item.item_name,
        description  : item.description || item.name || '',
        price        : parseFloat(item.price || item.defaultPrice || 0),
        food_type    : foodType,
        category     : catName,
        image_url    : item.cloudinaryImageId
          ? `https://media-assets.swiggy.com/swiggy/image/upload/${item.cloudinaryImageId}`
          : item.image_url || null,
        is_available : item.inStock !== false && item.is_available !== false,
      });
    });
  });

  log.info({ categories: categories.length, items: items.length, outletId: outlet_id }, 'Menu fetched');

  return { categories, items };
}

module.exports = { fetchMenu };
