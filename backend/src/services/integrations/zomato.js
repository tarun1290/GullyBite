// src/services/integrations/zomato.js
// Fetches menu from Zomato for Business / Order Management API
//
// NOTE: Zomato's restaurant API requires official Zomato for Business registration.
// Apply at: https://www.zomato.com/business
// Once approved, Zomato provides:
//   api_key    — partner API key
//   api_secret — partner API secret
//   outlet_id  — your restaurant's Zomato res_id (visible in Zomato business dashboard URL)
//
// Authentication: Bearer token obtained from client credentials exchange.

const axios = require('axios');

const BASE    = 'https://api.zomato.com/v2.1';
const TIMEOUT = 20000;

// Zomato category type → our food_type
function mapFoodType(item) {
  if (item.is_veg === 1 || item.vegetarian === true) return 'veg';
  if (item.is_vegan === 1) return 'vegan';
  return 'non_veg';
}

async function fetchMenu(integration) {
  const { api_key, api_secret, outlet_id } = integration;

  if (!api_key || !outlet_id) {
    throw new Error('Zomato: api_key and outlet_id (res_id) are required');
  }

  // ── STEP 1: Authenticate (client-credentials style if secret present) ─
  let authHeader = `Bearer ${api_key}`;
  if (api_secret) {
    try {
      const tokenRes = await axios.post(`${BASE}/auth/token`, {
        client_id    : api_key,
        client_secret: api_secret,
        grant_type   : 'client_credentials',
      }, { timeout: 10000 });
      authHeader = `Bearer ${tokenRes.data.access_token}`;
    } catch (err) {
      // Fall back to using api_key directly as bearer token
      console.warn('[Zomato] Token exchange failed, using api_key as bearer:', err.message);
    }
  }

  // ── STEP 2: Fetch restaurant menu ─────────────────────
  let rawMenu;
  try {
    const res = await axios.get(`${BASE}/menu`, {
      params : { res_id: outlet_id },
      headers: { 'user-key': api_key, Authorization: authHeader },
      timeout: TIMEOUT,
    });
    rawMenu = res.data?.daily_menu?.[0] || res.data?.menu || res.data;
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.code || err.message;
    throw new Error(`Zomato menu fetch failed: ${msg}`);
  }

  // ── Normalize categories ───────────────────────────────
  const rawSections = rawMenu?.categories || rawMenu?.sections || [];
  const categories = rawSections.map((sec, i) => ({
    name       : sec.name || sec.category_name || `Section ${i + 1}`,
    sort_order : i,
  }));

  // ── Normalize items ────────────────────────────────────
  const items = [];
  rawSections.forEach(sec => {
    const catName = sec.name || sec.category_name || 'Menu';
    (sec.items || sec.dishes || []).forEach(item => {
      items.push({
        external_id  : `zm_${item.id || item.dish_id}`,
        name         : item.name || item.dish_name,
        description  : item.desc || item.description || '',
        price        : parseFloat(item.price || item.dish_price || 0),
        food_type    : mapFoodType(item),
        category     : catName,
        image_url    : item.thumb || item.image_url || null,
        is_available : item.available !== false,
      });
    });
  });

  console.log(`[Zomato] Fetched ${categories.length} categories, ${items.length} items for res_id ${outlet_id}`);

  return { categories, items };
}

module.exports = { fetchMenu };
