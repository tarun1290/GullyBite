// src/services/catalog.js
// WhatsApp Catalog Batch API — syncs your restaurant menu to Meta
//
// HOW WHATSAPP CATALOG WORKS:
// 1. You create a catalog in Meta Business Manager (Commerce Manager)
// 2. You upload your menu items to the catalog via this Batch API
// 3. When a customer orders, you send a "catalog_message" to them
// 4. They see a mini-shop inside WhatsApp: browse menu, add to cart, checkout
// 5. When they checkout, Meta sends us an "order" webhook with items + quantities
//
// The Batch API lets you update 100 items per request efficiently

const axios = require('axios');
const db = require('../config/database');

const GRAPH_BASE = `https://graph.facebook.com/${process.env.WA_API_VERSION}`;

// ─── SYNC BRANCH MENU TO WHATSAPP CATALOG ────────────────────
// Pushes all available menu items for a branch to its WhatsApp Catalog
// Call this when: menu items are added/updated, prices change, items go unavailable
const syncBranchCatalog = async (branchId) => {
  // Get branch + WhatsApp account info
  const { rows: branches } = await db.query(`
    SELECT
      b.*,
      r.business_name,
      wa.catalog_id,
      wa.access_token,
      wa.id AS wa_account_id
    FROM branches b
    JOIN restaurants r ON b.restaurant_id = r.id
    JOIN whatsapp_accounts wa ON wa.restaurant_id = r.id AND wa.is_active = TRUE
    WHERE b.id = $1
  `, [branchId]);

  if (!branches.length) throw new Error('Branch not found or no active WhatsApp account');

  const branch = branches[0];

  if (!branch.catalog_id) {
    throw new Error(
      'No catalog_id set for this branch\'s WhatsApp account. ' +
      'Create a catalog in Meta Business Manager → Commerce Manager, ' +
      'then update the catalog_id in whatsapp_accounts table.'
    );
  }

  // Get all menu items for this branch
  const { rows: items } = await db.query(`
    SELECT mi.*, mc.name AS category_name
    FROM menu_items mi
    LEFT JOIN menu_categories mc ON mi.category_id = mc.id
    WHERE mi.branch_id = $1
    ORDER BY mc.sort_order, mi.sort_order, mi.name
  `, [branchId]);

  if (!items.length) return { success: false, message: 'No menu items to sync' };

  // ── FORMAT ITEMS FOR META CATALOG BATCH API ───────────────
  // Meta requires specific fields. Image URL must be public HTTPS.
  // Price must be in smallest currency unit (paise for INR).
  const requests = items.map((item) => ({
    method: item.is_available ? 'UPDATE' : 'DELETE', // DELETE removes from catalog
    retailer_id: item.retailer_id, // Your unique SKU
    data: item.is_available ? {
      name: item.name.substring(0, 100),
      description: (item.description || '').substring(0, 1000) || item.name,
      price: item.price_paise,  // Price in paise (e.g. Rs 280 = 28000)
      currency: 'INR',
      availability: 'in stock',
      // This URL must be accessible publicly (Meta crawls it)
      url: `${process.env.BASE_URL}/menu/${item.id}`,
      // Image must be HTTPS, at least 500x500px
      image_url: item.image_url || `${process.env.BASE_URL}/placeholder.jpg`,
      // Category (Google product category ID for restaurants: 1567)
      google_product_category: '1567',
      // Custom labels for filtering
      custom_label_0: item.food_type,
      custom_label_1: item.is_bestseller ? 'bestseller' : '',
      custom_label_2: item.category_name || '',
    } : undefined, // For DELETE, no data needed
  }));

  // ── SEND IN BATCHES OF 100 ────────────────────────────────
  // Meta's batch API allows max 100 items per request
  const batchSize = 100;
  const results = { updated: 0, failed: 0, errors: [] };

  for (let i = 0; i < requests.length; i += batchSize) {
    const batch = requests.slice(i, i + batchSize);
    try {
      await axios.post(
        `${GRAPH_BASE}/${branch.catalog_id}/batch`,
        { requests: batch },
        {
          headers: {
            Authorization: `Bearer ${branch.access_token}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );
      results.updated += batch.length;
    } catch (err) {
      const errMsg = err.response?.data?.error?.message || err.message;
      console.error(`[Catalog] Batch ${Math.ceil(i / batchSize) + 1} failed:`, errMsg);
      results.failed += batch.length;
      results.errors.push(errMsg);
    }
  }

  // Update sync timestamp
  await db.query(
    'UPDATE whatsapp_accounts SET catalog_synced_at = NOW() WHERE id = $1',
    [branch.wa_account_id]
  );

  console.log(`[Catalog] Sync done for branch ${branch.name}: ${results.updated} updated, ${results.failed} failed`);
  return { success: results.failed === 0, total: items.length, ...results };
};

// ─── TOGGLE SINGLE ITEM AVAILABILITY ─────────────────────────
// Quick way to mark one item as available/unavailable
// Sends a single-item batch update without resyncing everything
const setItemAvailability = async (menuItemId, isAvailable) => {
  const { rows } = await db.query(`
    SELECT mi.*, wa.catalog_id, wa.access_token
    FROM menu_items mi
    JOIN branches b ON mi.branch_id = b.id
    JOIN restaurants r ON b.restaurant_id = r.id
    JOIN whatsapp_accounts wa ON wa.restaurant_id = r.id AND wa.is_active = TRUE
    WHERE mi.id = $1
  `, [menuItemId]);

  if (!rows.length) return;

  const item = rows[0];

  if (item.catalog_id && item.access_token) {
    const req = isAvailable
      ? {
          method: 'UPDATE',
          retailer_id: item.retailer_id,
          data: {
            name: item.name,
            price: item.price_paise,
            currency: 'INR',
            availability: 'in stock',
            url: `${process.env.BASE_URL}/menu/${item.id}`,
            image_url: item.image_url || `${process.env.BASE_URL}/placeholder.jpg`,
          },
        }
      : { method: 'DELETE', retailer_id: item.retailer_id };

    await axios.post(
      `${GRAPH_BASE}/${item.catalog_id}/batch`,
      { requests: [req] },
      { headers: { Authorization: `Bearer ${item.access_token}` } }
    ).catch((e) => console.error('[Catalog] Toggle failed:', e.message));
  }

  await db.query('UPDATE menu_items SET is_available=$1 WHERE id=$2', [isAvailable, menuItemId]);
};

module.exports = { syncBranchCatalog, setItemAvailability };