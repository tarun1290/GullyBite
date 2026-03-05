// src/services/catalog.js
// Syncs branch-specific menu to Meta WhatsApp Catalog Batch API
// Each branch has its OWN catalog — menus stay separated by location

const axios = require('axios');
const db    = require('../config/database');

const GRAPH = `https://graph.facebook.com/${process.env.WA_API_VERSION}`;

// ─── AUTO-CREATE CATALOG FOR A BRANCH ────────────────────────
// Called automatically when a new branch is added
// Creates a Meta Commerce Catalog via API and saves catalog_id to DB
const createBranchCatalog = async (branchId) => {

  // Get branch + restaurant + WA account details
  const { rows } = await db.query(`
    SELECT
      b.id              AS branch_id,
      b.name            AS branch_name,
      b.catalog_id,
      r.id              AS restaurant_id,
      r.business_name,
      r.meta_access_token,
      wa.access_token   AS wa_access_token,
      wa.waba_id
    FROM branches b
    JOIN restaurants r ON b.restaurant_id = r.id
    LEFT JOIN whatsapp_accounts wa
      ON wa.restaurant_id = r.id AND wa.is_active = TRUE
    WHERE b.id = $1
  `, [branchId]);

  if (!rows.length) throw new Error('Branch not found');

  const branch = rows[0];

  // If catalog already exists skip creation
  if (branch.catalog_id) {
    console.log(`[Catalog] Branch "${branch.branch_name}" already has catalog: ${branch.catalog_id}`);
    return { alreadyExists: true, catalogId: branch.catalog_id };
  }

  // Use restaurant's Meta access token
  const accessToken = branch.meta_access_token || branch.wa_access_token;
  if (!accessToken) throw new Error('No Meta access token found. Please reconnect your Meta account.');

  // ── STEP A: GET BUSINESS ID ──────────────────────────────────
  // We need the Meta Business ID to create a catalog under it
  let businessId;
  try {
    const meRes = await axios.get(`${GRAPH}/me/businesses`, {
      params: {
        access_token: accessToken,
        fields: 'id,name',
      },
    });
    const businesses = meRes.data?.data || [];
    if (!businesses.length) throw new Error('No Meta Business account found');
    businessId = businesses[0].id; // Use first business account
  } catch (err) {
    throw new Error(`Could not fetch business account: ${err.response?.data?.error?.message || err.message}`);
  }

  // ── STEP B: CREATE THE CATALOG ───────────────────────────────
  // Catalog name format: "Restaurant Name - Branch Name"
  // Makes it easy to identify in Commerce Manager
  const catalogName = `${branch.business_name} - ${branch.branch_name}`;

  let catalogId;
  try {
    const createRes = await axios.post(
      `${GRAPH}/${businessId}/owned_product_catalogs`,
      {
        name        : catalogName,
        vertical    : 'commerce', // closest to food/restaurant
      },
      {
        headers: {
          Authorization : `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );
    catalogId = createRes.data.id;
    console.log(`[Catalog] Created catalog "${catalogName}" with ID: ${catalogId}`);
  } catch (err) {
    throw new Error(`Catalog creation failed: ${err.response?.data?.error?.message || err.message}`);
  }

  // ── STEP C: SAVE CATALOG ID TO DB ───────────────────────────
  await db.query(
    'UPDATE branches SET catalog_id = $1 WHERE id = $2',
    [catalogId, branchId]
  );

  // ── STEP D: ASSOCIATE CATALOG WITH WHATSAPP ACCOUNT ─────────
  // This links the catalog to the restaurant's WhatsApp Business Account
  // Required so customers can browse it inside WhatsApp
  if (branch.waba_id && branch.wa_access_token) {
    try {
      await axios.post(
        `${GRAPH}/${branch.waba_id}/product_catalogs`,
        { catalog_id: catalogId },
        {
          headers: {
            Authorization : `Bearer ${branch.wa_access_token}`,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        }
      );
      console.log(`[Catalog] Linked catalog ${catalogId} to WABA ${branch.waba_id}`);
    } catch (err) {
      // Non-fatal — catalog created, just needs manual linking
      console.warn(`[Catalog] Could not auto-link to WABA: ${err.response?.data?.error?.message || err.message}`);
    }
  }

  return {
    success   : true,
    catalogId,
    catalogName,
    branchId,
  };
};

// ─── SYNC ONE BRANCH CATALOG ──────────────────────────────────
// Call this whenever:
//   - Menu items are added / edited / deleted
//   - Prices change
//   - Item availability is toggled
//   - Restaurant owner clicks "Sync" in dashboard
const syncBranchCatalog = async (branchId) => {

  // Get branch + its catalog_id + restaurant WA access token
  const { rows } = await db.query(`
    SELECT
      b.id              AS branch_id,
      b.name            AS branch_name,
      b.catalog_id,                        -- per-branch catalog
      r.business_name,
      wa.access_token,
      wa.id             AS wa_account_id
    FROM branches b
    JOIN restaurants r  ON b.restaurant_id = r.id
    JOIN whatsapp_accounts wa
      ON wa.restaurant_id = r.id AND wa.is_active = TRUE
    WHERE b.id = $1
  `, [branchId]);

  if (!rows.length) throw new Error('Branch not found');

  const branch = rows[0];

  if (!branch.catalog_id) {
    throw new Error(
      `No catalog_id set for branch "${branch.branch_name}". ` +
      `Create a catalog in Meta Commerce Manager and paste the ID in your dashboard.`
    );
  }

  if (!branch.access_token) {
    throw new Error('No WhatsApp access token found. Please reconnect your Meta account.');
  }

  // Get all menu items for this branch with their category
  // Order variant groups together so Meta sees them as a set
  const { rows: items } = await db.query(`
    SELECT
      mi.*,
      mc.name AS category_name,
      mc.sort_order AS category_sort
    FROM menu_items mi
    LEFT JOIN menu_categories mc ON mi.category_id = mc.id
    WHERE mi.branch_id = $1
    ORDER BY
      COALESCE(mi.item_group_id, mi.id::TEXT),
      mc.sort_order NULLS LAST,
      mi.sort_order,
      mi.name
  `, [branchId]);

  if (!items.length) {
    return { success: false, message: 'No menu items found for this branch' };
  }

  // ── FORMAT FOR META CATALOG BATCH API ─────────────────────
  // Rules:
  //   UPDATE — adds or updates item in catalog
  //   DELETE — removes unavailable items from catalog
  //   price  — must be in smallest currency unit (paise for INR)
  //   image_url — must be public HTTPS, min 500x500px
  const requests = items
    .filter(item => item.retailer_id)   // skip items missing retailer_id
    .map(item => {
    if (!item.is_available) {
      // Remove unavailable items from the catalog entirely
      return {
        method      : 'DELETE',
        retailer_id : item.retailer_id,
      };
    }

    // Build the name: append variant value so each variant is distinct
    // e.g. "Butter Chicken" + "Small" → "Butter Chicken - Small"
    const displayName = item.variant_value
      ? `${item.name} - ${item.variant_value}`
      : item.name;

    // Map our variant_type to the Meta Catalog field name.
    // Meta supports: size, color, gender, material, age_group, pattern.
    // For food we only use 'size'. Other types fall back to custom_label_4.
    const variantFields = {};
    if (item.item_group_id) {
      variantFields.item_group_id = item.item_group_id;
      if (item.variant_type === 'size' || item.variant_type === 'portion') {
        variantFields.size = item.variant_value;
      } else if (item.variant_value) {
        // Non-standard variant type — store in custom label
        variantFields.custom_label_4 = `${item.variant_type}:${item.variant_value}`;
      }
    }

    return {
      method      : 'UPDATE',
      retailer_id : item.retailer_id,
      data: {
        // Required fields
        name        : displayName.substring(0, 100),
        description : (item.description || item.name).substring(0, 1000),
        price       : item.price_paise,   // paise (Rs 280 = 28000)
        currency    : 'INR',
        availability: 'in stock',
        url         : `${process.env.BASE_URL}/menu/${item.id}`,
        image_url   : item.image_url || `${process.env.BASE_URL}/placeholder.jpg`,

        // Category (Google product category 1567 = Food & Beverages)
        google_product_category: '1567',

        // Custom labels for filtering inside WhatsApp
        // label_0 = food type (veg/non_veg/vegan)
        // label_1 = branch name (so items stay branch-specific)
        // label_2 = category name (Starters, Mains etc.)
        // label_3 = bestseller flag
        custom_label_0: item.food_type,
        custom_label_1: branch.branch_name.substring(0, 100),
        custom_label_2: item.category_name || 'Menu',
        custom_label_3: item.is_bestseller ? 'bestseller' : 'regular',

        // Variant fields (only present when item is part of a group)
        ...variantFields,
      },
    };
  });

  // ── SEND IN BATCHES OF 100 ─────────────────────────────────
  // Meta allows max 100 items per batch request
  const BATCH_SIZE = 100;
  const results = { updated: 0, deleted: 0, failed: 0, errors: [] };

  for (let i = 0; i < requests.length; i += BATCH_SIZE) {
    const batch     = requests.slice(i, i + BATCH_SIZE);
    const batchNum  = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(requests.length / BATCH_SIZE);

    console.log(`[Catalog] Branch "${branch.branch_name}" — batch ${batchNum}/${totalBatches} (${batch.length} items)`);

    try {
      await axios.post(
        `${GRAPH}/${branch.catalog_id}/batch`,
        { requests: batch },
        {
          headers: {
            Authorization : `Bearer ${branch.access_token}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );

      // Count updates vs deletes
      results.updated += batch.filter(r => r.method === 'UPDATE').length;
      results.deleted += batch.filter(r => r.method === 'DELETE').length;

    } catch (err) {
      const errMsg = err.response?.data?.error?.message || err.message;
      console.error(`[Catalog] Batch ${batchNum} failed:`, errMsg);
      results.failed += batch.length;
      results.errors.push(`Batch ${batchNum}: ${errMsg}`);
    }

    // Small delay between batches to avoid rate limiting
    if (i + BATCH_SIZE < requests.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Update sync timestamp on the branch
  await db.query(
    'UPDATE branches SET catalog_synced_at = NOW() WHERE id = $1',
    [branchId]
  );

  const success = results.failed === 0;
  console.log(`[Catalog] Sync complete for "${branch.branch_name}":`, results);

  return {
    success,
    branchName : branch.branch_name,
    catalogId  : branch.catalog_id,
    total      : items.length,
    updated    : results.updated,
    deleted    : results.deleted,
    failed     : results.failed,
    errors     : results.errors,
  };
};

// ─── SYNC ALL BRANCHES OF A RESTAURANT ───────────────────────
// Useful when restaurant changes something global (price policy etc.)
const syncAllBranches = async (restaurantId) => {
  const { rows: branches } = await db.query(
    'SELECT id, name FROM branches WHERE restaurant_id = $1 AND accepts_orders = TRUE',
    [restaurantId]
  );

  const results = [];
  for (const branch of branches) {
    try {
      const r = await syncBranchCatalog(branch.id);
      results.push(r);
    } catch (err) {
      results.push({ branchName: branch.name, success: false, error: err.message });
    }
  }
  return results;
};

// ─── TOGGLE SINGLE ITEM AVAILABILITY ─────────────────────────
// Quick update without resyncing everything
// Called when restaurant toggles an item on/off in dashboard
const setItemAvailability = async (menuItemId, isAvailable) => {
  // Get item + its branch catalog details
  const { rows } = await db.query(`
    SELECT
      mi.*,
      b.catalog_id,
      wa.access_token
    FROM menu_items mi
    JOIN branches b ON mi.branch_id = b.id
    JOIN restaurants r ON b.restaurant_id = r.id
    JOIN whatsapp_accounts wa ON wa.restaurant_id = r.id AND wa.is_active = TRUE
    WHERE mi.id = $1
  `, [menuItemId]);

  if (!rows.length) return;
  const item = rows[0];

  // Update our DB first
  await db.query(
    'UPDATE menu_items SET is_available = $1 WHERE id = $2',
    [isAvailable, menuItemId]
  );

  // Push single-item update to Meta catalog
  if (item.catalog_id && item.access_token && item.retailer_id) {
    const request = isAvailable
      ? {
          method      : 'UPDATE',
          retailer_id : item.retailer_id,
          data: {
            name        : item.name,
            price       : item.price_paise,
            currency    : 'INR',
            availability: 'in stock',
            url         : `${process.env.BASE_URL}/menu/${item.id}`,
            image_url   : item.image_url || `${process.env.BASE_URL}/placeholder.jpg`,
            google_product_category: '1567',
          },
        }
      : {
          method      : 'DELETE',
          retailer_id : item.retailer_id,
        };

    await axios.post(
      `${GRAPH}/${item.catalog_id}/batch`,
      { requests: [request] },
      { headers: { Authorization: `Bearer ${item.access_token}` }, timeout: 10000 }
    ).catch(err => {
      console.error('[Catalog] Single item toggle failed:', err.response?.data?.error?.message || err.message);
    });
  }
};

module.exports = { createBranchCatalog, syncBranchCatalog, syncAllBranches, setItemAvailability };