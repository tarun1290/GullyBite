// src/services/catalog.js
// Syncs branch-specific menu to Meta WhatsApp Catalog Batch API
// Each branch has its OWN catalog — menus stay separated by location

const axios = require('axios');
const { col } = require('../config/database');

const GRAPH = `https://graph.facebook.com/${process.env.WA_API_VERSION}`;

// ─── AUTO-CREATE CATALOG FOR A BRANCH ────────────────────────
const createBranchCatalog = async (branchId) => {
  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch) throw new Error('Branch not found');

  if (branch.catalog_id) {
    console.log(`[Catalog] Branch "${branch.name}" already has catalog: ${branch.catalog_id}`);
    return { alreadyExists: true, catalogId: branch.catalog_id };
  }

  const restaurant = await col('restaurants').findOne({ _id: branch.restaurant_id });
  const wa_acc = await col('whatsapp_accounts').findOne({ restaurant_id: branch.restaurant_id, is_active: true });

  // Reuse the WABA-level catalog if already provisioned — one catalog per WABA, not per branch
  if (wa_acc?.catalog_id) {
    await col('branches').updateOne({ _id: branchId }, { $set: { catalog_id: wa_acc.catalog_id } });
    console.log(`[Catalog] Branch "${branch.name}" inherited WABA catalog ${wa_acc.catalog_id}`);
    return { alreadyExists: false, catalogId: wa_acc.catalog_id, inherited: true };
  }

  const accessToken = restaurant?.meta_access_token || wa_acc?.access_token;
  if (!accessToken) throw new Error('No Meta access token found. Please reconnect your Meta account.');

  // ── STEP 0: FETCH EXISTING WABA CATALOG (avoids permission error) ──
  // The embedded-signup token often cannot CREATE catalogs but CAN read them.
  // If the WABA already owns one, inherit it rather than trying to create.
  if (wa_acc?.waba_id) {
    try {
      const existing = await axios.get(`${GRAPH}/${wa_acc.waba_id}/product_catalogs`, {
        params: { access_token: accessToken, fields: 'id,name' },
        timeout: 10000,
      });
      const catalogs = existing.data?.data || [];
      if (catalogs.length) {
        const catalogId = catalogs[0].id;
        await col('branches').updateOne({ _id: branchId }, { $set: { catalog_id: catalogId } });
        await col('whatsapp_accounts').updateOne(
          { restaurant_id: branch.restaurant_id, is_active: true },
          { $set: { catalog_id: catalogId } }
        );
        console.log(`[Catalog] Inherited existing WABA catalog ${catalogId} for branch "${branch.name}"`);
        return { success: true, catalogId, inherited: true };
      }
    } catch (e) {
      console.warn('[Catalog] Could not fetch WABA catalogs:', e.response?.data?.error?.message || e.message);
    }
  }

  // ── STEP A: GET BUSINESS ID ──────────────────────────────────
  let businessId;
  try {
    const meRes = await axios.get(`${GRAPH}/me/businesses`, {
      params: { access_token: accessToken, fields: 'id,name' },
    });
    const businesses = meRes.data?.data || [];
    if (!businesses.length) throw new Error('No Meta Business account found');
    businessId = businesses[0].id;
  } catch (err) {
    throw new Error(`Could not fetch business account: ${err.response?.data?.error?.message || err.message}`);
  }

  // ── STEP B: CREATE THE CATALOG ───────────────────────────────
  const catalogName = `${restaurant.business_name} - ${branch.name}`;
  let catalogId;
  try {
    const createRes = await axios.post(
      `${GRAPH}/${businessId}/owned_product_catalogs`,
      { name: catalogName, vertical: 'commerce' },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    catalogId = createRes.data.id;
    console.log(`[Catalog] Created catalog "${catalogName}" with ID: ${catalogId}`);
  } catch (err) {
    throw new Error(`Catalog creation failed: ${err.response?.data?.error?.message || err.message}`);
  }

  // ── STEP C: SAVE CATALOG ID TO DB ───────────────────────────
  await col('branches').updateOne({ _id: branchId }, { $set: { catalog_id: catalogId } });

  // ── STEP D: ASSOCIATE CATALOG WITH WHATSAPP ACCOUNT ─────────
  if (wa_acc?.waba_id && wa_acc?.access_token) {
    try {
      await axios.post(
        `${GRAPH}/${wa_acc.waba_id}/product_catalogs`,
        { catalog_id: catalogId },
        { headers: { Authorization: `Bearer ${wa_acc.access_token}`, 'Content-Type': 'application/json' }, timeout: 10000 }
      );
      console.log(`[Catalog] Linked catalog ${catalogId} to WABA ${wa_acc.waba_id}`);
    } catch (err) {
      console.warn(`[Catalog] Could not auto-link to WABA: ${err.response?.data?.error?.message || err.message}`);
    }
  }

  return { success: true, catalogId, catalogName, branchId };
};

// ─── SYNC ONE BRANCH CATALOG ──────────────────────────────────
const syncBranchCatalog = async (branchId) => {
  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch) throw new Error('Branch not found');

  const restaurant = await col('restaurants').findOne({ _id: branch.restaurant_id });
  const wa_acc = await col('whatsapp_accounts').findOne({ restaurant_id: branch.restaurant_id, is_active: true });

  // If branch has no catalog_id, inherit from the WABA-level catalog
  if (!branch.catalog_id && wa_acc?.catalog_id) {
    await col('branches').updateOne({ _id: branchId }, { $set: { catalog_id: wa_acc.catalog_id } });
    branch.catalog_id = wa_acc.catalog_id;
    console.log(`[Catalog] Branch "${branch.name}" inherited catalog ${wa_acc.catalog_id} from WABA`);
  }

  if (!branch.catalog_id) {
    throw new Error(
      `No catalog found for branch "${branch.name}". ` +
      `Connect your WhatsApp Business account — a catalog will be created automatically.`
    );
  }

  if (!wa_acc?.access_token) {
    throw new Error('No WhatsApp access token found. Please reconnect your Meta account.');
  }

  // Get all menu items for this branch with their category
  const items = await col('menu_items').find({ branch_id: branchId }).toArray();

  // Fetch category names
  const catIds = [...new Set(items.map(i => i.category_id).filter(Boolean))];
  const cats = catIds.length
    ? await col('menu_categories').find({ _id: { $in: catIds } }).toArray()
    : [];
  const catMap = Object.fromEntries(cats.map(c => [String(c._id), c]));

  if (!items.length) {
    return { success: false, message: 'No menu items found for this branch' };
  }

  // Sort: group variants together
  items.sort((a, b) => {
    const ga = a.item_group_id || String(a._id);
    const gb = b.item_group_id || String(b._id);
    if (ga !== gb) return ga < gb ? -1 : 1;
    const ca = catMap[a.category_id]?.sort_order ?? 999;
    const cb = catMap[b.category_id]?.sort_order ?? 999;
    if (ca !== cb) return ca - cb;
    return (a.sort_order || 0) - (b.sort_order || 0);
  });

  const requests = items
    .filter(item => item.retailer_id)
    .map(item => {
      if (!item.is_available) {
        return { method: 'DELETE', retailer_id: item.retailer_id };
      }

      const displayName = item.variant_value
        ? `${item.name} - ${item.variant_value}`
        : item.name;

      const variantFields = {};
      if (item.item_group_id) {
        variantFields.item_group_id = item.item_group_id;
        // Meta only groups variants by size/color/pattern/gender fields.
        // For food, always use 'size' so WhatsApp shows the variant picker.
        if (item.variant_value) {
          variantFields.size = item.variant_value;
        }
      }

      const categoryName = catMap[item.category_id]?.name || 'Menu';

      return {
        method      : 'UPDATE',
        retailer_id : item.retailer_id,
        data: {
          name        : displayName.substring(0, 100),
          description : (item.description || item.name).substring(0, 1000),
          price       : item.price_paise,
          currency    : 'INR',
          availability: 'in stock',
          url         : `${process.env.BASE_URL}/menu/${String(item._id)}`,
          image_url   : item.image_url || `${process.env.BASE_URL}/placeholder.jpg`,
          google_product_category: '1567',
          custom_label_0: item.food_type,
          custom_label_1: branch.name.substring(0, 100),
          custom_label_2: categoryName,
          custom_label_3: item.is_bestseller ? 'bestseller' : 'regular',
          ...variantFields,
        },
      };
    });

  const BATCH_SIZE = 100;
  const results = { updated: 0, deleted: 0, failed: 0, errors: [] };

  for (let i = 0; i < requests.length; i += BATCH_SIZE) {
    const batch    = requests.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(requests.length / BATCH_SIZE);

    console.log(`[Catalog] Branch "${branch.name}" — batch ${batchNum}/${totalBatches} (${batch.length} items)`);

    try {
      await axios.post(
        `${GRAPH}/${branch.catalog_id}/batch`,
        { requests: batch },
        { headers: { Authorization: `Bearer ${wa_acc.access_token}`, 'Content-Type': 'application/json' }, timeout: 30000 }
      );
      results.updated += batch.filter(r => r.method === 'UPDATE').length;
      results.deleted += batch.filter(r => r.method === 'DELETE').length;
    } catch (err) {
      const errMsg = err.response?.data?.error?.message || err.message;
      console.error(`[Catalog] Batch ${batchNum} failed:`, errMsg);
      results.failed += batch.length;
      results.errors.push(`Batch ${batchNum}: ${errMsg}`);
    }

    if (i + BATCH_SIZE < requests.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  await col('branches').updateOne({ _id: branchId }, { $set: { catalog_synced_at: new Date() } });

  syncCategoryProductSets(branchId).catch(err =>
    console.warn('[Catalog] Product set sync failed (non-fatal):', err.message)
  );

  const success = results.failed === 0;
  console.log(`[Catalog] Sync complete for "${branch.name}":`, results);

  return {
    success,
    branchName : branch.name,
    catalogId  : branch.catalog_id,
    total      : items.length,
    updated    : results.updated,
    deleted    : results.deleted,
    failed     : results.failed,
    errors     : results.errors,
  };
};

// ─── SYNC ALL BRANCHES OF A RESTAURANT ───────────────────────
const syncAllBranches = async (restaurantId) => {
  const branches = await col('branches').find({ restaurant_id: restaurantId, accepts_orders: true }).toArray();

  const results = [];
  for (const branch of branches) {
    try {
      const r = await syncBranchCatalog(String(branch._id));
      results.push(r);
    } catch (err) {
      results.push({ branchName: branch.name, success: false, error: err.message });
    }
  }
  return results;
};

// ─── TOGGLE SINGLE ITEM AVAILABILITY ─────────────────────────
const setItemAvailability = async (menuItemId, isAvailable) => {
  const item = await col('menu_items').findOne({ _id: menuItemId });
  if (!item) return;

  const branch = await col('branches').findOne({ _id: item.branch_id });
  const wa_acc = branch
    ? await col('whatsapp_accounts').findOne({ restaurant_id: branch.restaurant_id, is_active: true })
    : null;

  await col('menu_items').updateOne({ _id: menuItemId }, { $set: { is_available: isAvailable, updated_at: new Date() } });

  if (branch?.catalog_id && wa_acc?.access_token && item.retailer_id) {
    const variantFields = {};
    if (item.item_group_id) {
      variantFields.item_group_id = item.item_group_id;
      if (item.variant_value) {
        variantFields.size = item.variant_value;
      }
    }
    const displayName = item.variant_value ? `${item.name} - ${item.variant_value}` : item.name;

    const request = isAvailable
      ? {
          method      : 'UPDATE',
          retailer_id : item.retailer_id,
          data: {
            name        : displayName.substring(0, 100),
            price       : item.price_paise,
            currency    : 'INR',
            availability: 'in stock',
            url         : `${process.env.BASE_URL}/menu/${String(item._id)}`,
            image_url   : item.image_url || `${process.env.BASE_URL}/placeholder.jpg`,
            google_product_category: '1567',
            ...variantFields,
          },
        }
      : { method: 'DELETE', retailer_id: item.retailer_id };

    await axios.post(
      `${GRAPH}/${branch.catalog_id}/batch`,
      { requests: [request] },
      { headers: { Authorization: `Bearer ${wa_acc.access_token}` }, timeout: 10000 }
    ).catch(err => {
      console.error('[Catalog] Single item toggle failed:', err.response?.data?.error?.message || err.message);
    });
  }
};

// ─── SYNC CATEGORY PRODUCT SETS ──────────────────────────────
const syncCategoryProductSets = async (branchId) => {
  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch) throw new Error('Branch not found');

  const wa_acc = branch
    ? await col('whatsapp_accounts').findOne({ restaurant_id: branch.restaurant_id, is_active: true })
    : null;

  if (!branch.catalog_id || !wa_acc?.access_token) {
    return { skipped: true, reason: 'No catalog or access token' };
  }

  // Categories with at least one available item
  const availableItems = await col('menu_items').find({ branch_id: branchId, is_available: true, category_id: { $ne: null } }).toArray();
  const catIds = [...new Set(availableItems.map(i => i.category_id))];

  if (!catIds.length) return { skipped: true, reason: 'No categories with available items' };

  const cats = await col('menu_categories').find({ _id: { $in: catIds } }).sort({ sort_order: 1, name: 1 }).toArray();

  const results = { created: 0, updated: 0, failed: 0, sets: [] };

  for (const cat of cats) {
    const filter = JSON.stringify({
      and: [
        { custom_label_2: { eq: cat.name } },
        { custom_label_1: { eq: branch.name } },
      ],
    });

    try {
      if (cat.meta_set_id) {
        await axios.post(
          `${GRAPH}/${cat.meta_set_id}`,
          { name: cat.name, filter },
          { headers: { Authorization: `Bearer ${wa_acc.access_token}` }, timeout: 10000 }
        );
        results.updated++;
      } else {
        const res = await axios.post(
          `${GRAPH}/${branch.catalog_id}/product_sets`,
          { name: cat.name, filter },
          { headers: { Authorization: `Bearer ${wa_acc.access_token}` }, timeout: 10000 }
        );
        const setId = res.data.id;
        await col('menu_categories').updateOne({ _id: String(cat._id) }, { $set: { meta_set_id: setId } });
        results.sets.push({ name: cat.name, setId });
        results.created++;
      }
      console.log(`[Catalog] Product set "${cat.name}" synced for branch "${branch.name}"`);
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.error(`[Catalog] Product set failed for "${cat.name}":`, msg);
      results.failed++;
    }
  }

  return { success: results.failed === 0, ...results };
};

module.exports = { createBranchCatalog, syncBranchCatalog, syncAllBranches, setItemAvailability, syncCategoryProductSets };
