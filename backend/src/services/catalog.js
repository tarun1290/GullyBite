// src/services/catalog.js
// Syncs branch-specific menu to Meta WhatsApp Catalog via facebook-nodejs-business-sdk
// Each branch has its OWN catalog — menus stay separated by location

const bizSdk = require('facebook-nodejs-business-sdk');
const axios   = require('axios');
const { col } = require('../config/database');

const Business       = bizSdk.Business;
const ProductCatalog = bizSdk.ProductCatalog;
const ProductItem    = bizSdk.ProductItem;

const GRAPH = `https://graph.facebook.com/${process.env.WA_API_VERSION}`;

// ── SDK init helper — uses per-restaurant token or platform token ────
function initSdk(accessToken) {
  bizSdk.FacebookAdsApi.init(accessToken);
  return bizSdk.FacebookAdsApi.getDefaultApi();
}

// ── Get the best available access token for a restaurant ──
async function _getAccessToken(restaurantId) {
  const wa_acc = await col('whatsapp_accounts').findOne({ restaurant_id: restaurantId, is_active: true });
  const restaurant = await col('restaurants').findOne({ _id: restaurantId });
  const token = wa_acc?.access_token || restaurant?.meta_access_token || process.env.WA_CATALOG_TOKEN;
  if (!token) throw new Error('No Meta access token found. Please reconnect your Meta account.');
  return { token, wa_acc, restaurant };
}

// ─── AUTO-CREATE CATALOG FOR A BRANCH ────────────────────────
const createBranchCatalog = async (branchId) => {
  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch) throw new Error('Branch not found');

  if (branch.catalog_id) {
    console.log(`[Catalog] Branch "${branch.name}" already has catalog: ${branch.catalog_id}`);
    return { alreadyExists: true, catalogId: branch.catalog_id };
  }

  const { token, wa_acc, restaurant } = await _getAccessToken(branch.restaurant_id);

  // Reuse the WABA-level catalog if already provisioned
  if (wa_acc?.catalog_id) {
    await col('branches').updateOne({ _id: branchId }, { $set: { catalog_id: wa_acc.catalog_id } });
    console.log(`[Catalog] Branch "${branch.name}" inherited WABA catalog ${wa_acc.catalog_id}`);
    return { alreadyExists: false, catalogId: wa_acc.catalog_id, inherited: true };
  }

  initSdk(token);

  // STEP 0: Fetch existing WABA catalog
  if (wa_acc?.waba_id) {
    try {
      const existing = await axios.get(`${GRAPH}/${wa_acc.waba_id}/product_catalogs`, {
        params: { access_token: token, fields: 'id,name' }, timeout: 10000,
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

  // STEP A: Get business ID via SDK
  let businessId;
  try {
    const meRes = await axios.get(`${GRAPH}/me/businesses`, {
      params: { access_token: token, fields: 'id,name' },
    });
    const businesses = meRes.data?.data || [];
    if (!businesses.length) throw new Error('No Meta Business account found');
    businessId = businesses[0].id;
  } catch (err) {
    throw new Error(`Could not fetch business account: ${err.response?.data?.error?.message || err.message}`);
  }

  // STEP A.5: Check existing business catalogs via SDK
  let catalogId;
  try {
    const biz = new Business(businessId);
    const bizCatalogs = await biz.getOwnedProductCatalogs(['id', 'name']);
    if (bizCatalogs.length) {
      catalogId = bizCatalogs[0].id;
      console.log(`[Catalog] Found existing business catalog ${catalogId} — inheriting`);
    }
  } catch (e) {
    console.warn('[Catalog] Could not read business catalogs:', e.message);
  }

  // STEP B: Create catalog via SDK
  if (!catalogId) {
    const catalogName = `${restaurant.business_name} - ${branch.name}`;
    try {
      const biz = new Business(businessId);
      const created = await biz.createOwnedProductCatalog([], {
        name: catalogName,
        vertical: 'commerce',
      });
      catalogId = created.id;
      console.log(`[Catalog] Created catalog "${catalogName}" with ID: ${catalogId}`);
    } catch (err) {
      throw new Error(`Catalog creation failed: ${err.message}`);
    }
  }

  // STEP C: Save catalog ID
  await col('branches').updateOne({ _id: branchId }, { $set: { catalog_id: catalogId } });

  // STEP D: Associate catalog with WhatsApp account
  if (wa_acc?.waba_id && wa_acc?.access_token) {
    try {
      await axios.post(
        `${GRAPH}/${wa_acc.waba_id}/product_catalogs`,
        { catalog_id: catalogId },
        { headers: { Authorization: `Bearer ${wa_acc.access_token}` }, timeout: 10000 }
      );
      await col('whatsapp_accounts').updateOne(
        { restaurant_id: branch.restaurant_id, is_active: true },
        { $set: { catalog_id: catalogId } }
      );
      console.log(`[Catalog] Linked catalog ${catalogId} to WABA ${wa_acc.waba_id}`);
    } catch (err) {
      console.warn(`[Catalog] Could not auto-link to WABA: ${err.response?.data?.error?.message || err.message}`);
    }
  }

  return { success: true, catalogId, branchId };
};

// ─── BUILD BATCH REQUEST FOR A MENU ITEM ─────────────────────
function _buildItemRequest(item, branch, catMap) {
  if (!item.retailer_id) return null;

  if (!item.is_available) {
    return { method: 'DELETE', retailer_id: item.retailer_id, item_type: 'PRODUCT_ITEM' };
  }

  const displayName = item.variant_value
    ? `${item.name} - ${item.variant_value}`
    : item.name;

  const variantFields = {};
  if (item.item_group_id) {
    variantFields.item_group_id = item.item_group_id;
    if (item.variant_value) variantFields.size = item.variant_value;
  }

  const categoryName = catMap[item.category_id]?.name || 'Menu';

  return {
    method      : 'UPDATE',
    retailer_id : item.retailer_id,
    item_type   : 'PRODUCT_ITEM',
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
}

// ─── SYNC ONE BRANCH CATALOG ──────────────────────────────────
const syncBranchCatalog = async (branchId) => {
  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch) throw new Error('Branch not found');

  const { token, wa_acc } = await _getAccessToken(branch.restaurant_id);

  // Inherit catalog from WABA if branch doesn't have one
  if (!branch.catalog_id && wa_acc?.catalog_id) {
    await col('branches').updateOne({ _id: branchId }, { $set: { catalog_id: wa_acc.catalog_id } });
    branch.catalog_id = wa_acc.catalog_id;
    console.log(`[Catalog] Branch "${branch.name}" inherited catalog ${wa_acc.catalog_id} from WABA`);
  }

  if (!branch.catalog_id) {
    try {
      const created = await createBranchCatalog(branchId);
      branch.catalog_id = created.catalogId;
      console.log(`[Catalog] Auto-created catalog ${branch.catalog_id} for "${branch.name}" on first sync`);
    } catch (createErr) {
      throw new Error(
        `Could not create WhatsApp catalog for "${branch.name}": ${createErr.message}. ` +
        `If you see "Missing Permission", reconnect your Meta account.`
      );
    }
  }

  initSdk(token);

  // Get all menu items for this branch
  const items = await col('menu_items').find({ branch_id: branchId }).toArray();
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
    return (a.sort_order || 0) - (b.sort_order || 0);
  });

  const requests = items.map(item => _buildItemRequest(item, branch, catMap)).filter(Boolean);

  const BATCH_SIZE = 100;
  const results = { updated: 0, deleted: 0, failed: 0, errors: [] };
  let catalogFixed = false;

  for (let i = 0; i < requests.length; i += BATCH_SIZE) {
    const batch      = requests.slice(i, i + BATCH_SIZE);
    const batchNum   = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(requests.length / BATCH_SIZE);

    console.log(`[Catalog] Branch "${branch.name}" — batch ${batchNum}/${totalBatches} (${batch.length} items)`);

    let batchDone = false;
    for (let attempt = 0; attempt < 2 && !batchDone; attempt++) {
      try {
        // Use SDK createItemsBatch
        const catalogObj = new ProductCatalog(branch.catalog_id);
        await catalogObj.createItemsBatch([], {
          allow_upsert: true,
          item_type: 'PRODUCT_ITEM',
          requests: batch,
        });
        results.updated += batch.filter(r => r.method === 'UPDATE').length;
        results.deleted += batch.filter(r => r.method === 'DELETE').length;
        batchDone = true;

        // Update sync status on items
        const syncedIds = batch
          .filter(r => r.method === 'UPDATE')
          .map(r => items.find(it => it.retailer_id === r.retailer_id)?._id)
          .filter(Boolean);
        if (syncedIds.length) {
          await col('menu_items').updateMany(
            { _id: { $in: syncedIds } },
            { $set: { catalog_sync_status: 'synced', catalog_synced_at: new Date() } }
          );
        }
      } catch (err) {
        const errMsg = err._error?.error?.message || err.message;

        const isStale = attempt === 0 && !catalogFixed && (
          errMsg.includes('does not exist') ||
          errMsg.includes('missing permissions') ||
          errMsg.includes('Unsupported post request')
        );

        if (isStale) {
          console.warn(`[Catalog] Stale catalog_id "${branch.catalog_id}" — clearing and re-discovering…`);
          try {
            await col('branches').updateOne({ _id: branchId }, { $unset: { catalog_id: '' } });
            await col('whatsapp_accounts').updateMany(
              { restaurant_id: branch.restaurant_id }, { $unset: { catalog_id: '' } }
            );
            branch.catalog_id = null;
            const rediscovered = await createBranchCatalog(branchId);
            branch.catalog_id = rediscovered.catalogId;
            catalogFixed = true;
            console.log(`[Catalog] Re-discovered catalog: ${branch.catalog_id} — retrying batch ${batchNum}…`);
          } catch (fixErr) {
            console.error(`[Catalog] Re-discovery failed:`, fixErr.message);
            results.failed += batch.length;
            results.errors.push(`Batch ${batchNum}: catalog re-discovery failed — ${fixErr.message}`);
            batchDone = true;
          }
        } else {
          console.error(`[Catalog] Batch ${batchNum} failed:`, errMsg);
          results.failed += batch.length;
          results.errors.push(`Batch ${batchNum}: ${errMsg}`);

          // Mark failed items
          const failedIds = batch
            .map(r => items.find(it => it.retailer_id === r.retailer_id)?._id)
            .filter(Boolean);
          if (failedIds.length) {
            await col('menu_items').updateMany(
              { _id: { $in: failedIds } },
              { $set: { catalog_sync_status: 'error' } }
            ).catch(() => {});
          }
          batchDone = true;
        }
      }
    }

    if (i + BATCH_SIZE < requests.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  await col('branches').updateOne({ _id: branchId }, { $set: { catalog_synced_at: new Date() } });

  syncCategoryProductSets(branchId).catch(err =>
    console.warn('[Catalog] Product set sync failed (non-fatal):', err.message)
  );

  console.log(`[Catalog] Sync complete for "${branch.name}":`, results);

  return {
    success   : results.failed === 0,
    branchName: branch.name,
    catalogId : branch.catalog_id,
    total     : items.length,
    updated   : results.updated,
    deleted   : results.deleted,
    failed    : results.failed,
    errors    : results.errors,
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

  // Update restaurant-level last sync timestamp
  await col('restaurants').updateOne(
    { _id: restaurantId },
    { $set: { last_catalog_sync: new Date() } }
  );

  return results;
};

// ─── ADD SINGLE PRODUCT TO CATALOG ───────────────────────────
const addProduct = async (menuItemId) => {
  const item = await col('menu_items').findOne({ _id: menuItemId });
  if (!item || !item.retailer_id) return { skipped: true };

  const branch = await col('branches').findOne({ _id: item.branch_id });
  if (!branch?.catalog_id) return { skipped: true, reason: 'No catalog' };

  const { token } = await _getAccessToken(branch.restaurant_id);
  initSdk(token);

  const catMap = {};
  if (item.category_id) {
    const cat = await col('menu_categories').findOne({ _id: item.category_id });
    if (cat) catMap[String(cat._id)] = cat;
  }

  const request = _buildItemRequest(item, branch, catMap);
  if (!request) return { skipped: true };

  try {
    const catalogObj = new ProductCatalog(branch.catalog_id);
    await catalogObj.createItemsBatch([], {
      allow_upsert: true,
      item_type: 'PRODUCT_ITEM',
      requests: [request],
    });
    await col('menu_items').updateOne(
      { _id: menuItemId },
      { $set: { catalog_sync_status: 'synced', catalog_synced_at: new Date() } }
    );
    return { success: true, retailer_id: item.retailer_id };
  } catch (err) {
    const errMsg = err._error?.error?.message || err.message;
    console.error('[Catalog] addProduct failed:', errMsg);
    await col('menu_items').updateOne({ _id: menuItemId }, { $set: { catalog_sync_status: 'error' } });
    return { success: false, error: errMsg };
  }
};

// ─── UPDATE SINGLE PRODUCT IN CATALOG ────────────────────────
const updateProduct = async (menuItemId) => {
  // Same as addProduct — batch UPDATE creates or updates
  return addProduct(menuItemId);
};

// ─── DELETE SINGLE PRODUCT FROM CATALOG ──────────────────────
const deleteProduct = async (menuItem, branchId) => {
  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch?.catalog_id || !menuItem?.retailer_id) return { skipped: true };

  const { token } = await _getAccessToken(branch.restaurant_id);
  initSdk(token);

  try {
    const catalogObj = new ProductCatalog(branch.catalog_id);
    await catalogObj.createItemsBatch([], {
      allow_upsert: true,
      item_type: 'PRODUCT_ITEM',
      requests: [{ method: 'DELETE', retailer_id: menuItem.retailer_id, item_type: 'PRODUCT_ITEM' }],
    });
    return { success: true, retailer_id: menuItem.retailer_id };
  } catch (err) {
    const errMsg = err._error?.error?.message || err.message;
    console.error('[Catalog] deleteProduct failed:', errMsg);
    return { success: false, error: errMsg };
  }
};

// ─── TOGGLE SINGLE ITEM AVAILABILITY ─────────────────────────
const setItemAvailability = async (menuItemId, isAvailable) => {
  const item = await col('menu_items').findOne({ _id: menuItemId });
  if (!item) return;

  const branch = await col('branches').findOne({ _id: item.branch_id });

  await col('menu_items').updateOne(
    { _id: menuItemId },
    { $set: { is_available: isAvailable, updated_at: new Date(), catalog_sync_status: 'pending' } }
  );

  if (!branch?.catalog_id || !item.retailer_id) return;

  const { token } = await _getAccessToken(branch.restaurant_id);
  initSdk(token);

  const catMap = {};
  if (item.category_id) {
    const cat = await col('menu_categories').findOne({ _id: item.category_id });
    if (cat) catMap[String(cat._id)] = cat;
  }

  const request = isAvailable
    ? _buildItemRequest({ ...item, is_available: true }, branch, catMap)
    : { method: 'DELETE', retailer_id: item.retailer_id, item_type: 'PRODUCT_ITEM' };

  if (!request) return;

  try {
    const catalogObj = new ProductCatalog(branch.catalog_id);
    await catalogObj.createItemsBatch([], {
      allow_upsert: true,
      item_type: 'PRODUCT_ITEM',
      requests: [request],
    });
    await col('menu_items').updateOne(
      { _id: menuItemId },
      { $set: { catalog_sync_status: 'synced', catalog_synced_at: new Date() } }
    );
  } catch (err) {
    console.error('[Catalog] Availability toggle failed:', err._error?.error?.message || err.message);
    await col('menu_items').updateOne({ _id: menuItemId }, { $set: { catalog_sync_status: 'error' } });
  }
};

// ─── GET ALL PRODUCTS IN A CATALOG (via SDK) ─────────────────
const getCatalogProducts = async (branchId) => {
  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch?.catalog_id) return { products: [], catalogId: null };

  const { token } = await _getAccessToken(branch.restaurant_id);
  initSdk(token);

  try {
    const catalogObj = new ProductCatalog(branch.catalog_id);
    const products = await catalogObj.getProducts(
      ['id', 'retailer_id', 'name', 'description', 'price', 'currency', 'availability', 'image_url', 'url'],
      { limit: 250 }
    );
    return {
      catalogId: branch.catalog_id,
      products: products.map(p => p._data),
      total: products.length,
    };
  } catch (err) {
    console.error('[Catalog] getProducts failed:', err._error?.error?.message || err.message);
    return { catalogId: branch.catalog_id, products: [], error: err._error?.error?.message || err.message };
  }
};

// ─── GET SYNC STATUS FOR A RESTAURANT ────────────────────────
const getSyncStatus = async (restaurantId) => {
  const branches = await col('branches').find({ restaurant_id: restaurantId }).toArray();
  const restaurant = await col('restaurants').findOne({ _id: restaurantId });

  const branchStatuses = [];
  for (const branch of branches) {
    const totalItems = await col('menu_items').countDocuments({ branch_id: String(branch._id) });
    const syncedItems = await col('menu_items').countDocuments({ branch_id: String(branch._id), catalog_sync_status: 'synced' });
    const errorItems = await col('menu_items').countDocuments({ branch_id: String(branch._id), catalog_sync_status: 'error' });
    const pendingItems = totalItems - syncedItems - errorItems;

    branchStatuses.push({
      branchId  : String(branch._id),
      branchName: branch.name,
      catalogId : branch.catalog_id || null,
      lastSync  : branch.catalog_synced_at || null,
      totalItems,
      syncedItems,
      pendingItems,
      errorItems,
    });
  }

  return {
    catalogSyncEnabled: restaurant?.catalog_sync_enabled || false,
    lastFullSync      : restaurant?.last_catalog_sync || null,
    branches          : branchStatuses,
  };
};

// ─── SYNC CATEGORY PRODUCT SETS ──────────────────────────────
const syncCategoryProductSets = async (branchId) => {
  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch) throw new Error('Branch not found');

  const { token } = await _getAccessToken(branch.restaurant_id);

  if (!branch.catalog_id || !token) {
    return { skipped: true, reason: 'No catalog or access token' };
  }

  initSdk(token);

  const availableItems = await col('menu_items').find({
    branch_id: branchId, is_available: true, category_id: { $ne: null },
  }).toArray();
  const catIds = [...new Set(availableItems.map(i => i.category_id))];

  if (!catIds.length) return { skipped: true, reason: 'No categories with available items' };

  const cats = await col('menu_categories').find({ _id: { $in: catIds } }).sort({ sort_order: 1, name: 1 }).toArray();
  const results = { created: 0, updated: 0, failed: 0, sets: [] };

  const catalogObj = new ProductCatalog(branch.catalog_id);

  for (const cat of cats) {
    const filter = JSON.stringify({
      and: [
        { custom_label_2: { eq: cat.name } },
        { custom_label_1: { eq: branch.name } },
      ],
    });

    try {
      if (cat.meta_set_id) {
        // Update existing set via raw API (SDK ProductSet.update works too)
        await axios.post(
          `${GRAPH}/${cat.meta_set_id}`,
          { name: cat.name, filter },
          { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
        );
        results.updated++;
      } else {
        const created = await catalogObj.createProductSet([], { name: cat.name, filter });
        const setId = created.id;
        await col('menu_categories').updateOne({ _id: String(cat._id) }, { $set: { meta_set_id: setId } });
        results.sets.push({ name: cat.name, setId });
        results.created++;
      }
      console.log(`[Catalog] Product set "${cat.name}" synced for branch "${branch.name}"`);
    } catch (err) {
      const msg = err._error?.error?.message || err.response?.data?.error?.message || err.message;
      console.error(`[Catalog] Product set failed for "${cat.name}":`, msg);
      results.failed++;
    }
  }

  return { success: results.failed === 0, ...results };
};

// ─── CLEAR STALE CATALOG & RE-DISCOVER ───────────────────────
const rediscoverCatalog = async (branchId) => {
  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch) throw new Error('Branch not found');
  const oldId = branch.catalog_id;
  await col('branches').updateOne({ _id: branchId }, { $unset: { catalog_id: '' } });
  await col('whatsapp_accounts').updateMany({ restaurant_id: branch.restaurant_id }, { $unset: { catalog_id: '' } });
  console.log(`[Catalog] Cleared stale catalog_id "${oldId}" for branch "${branch.name}"`);
  return await createBranchCatalog(branchId);
};

module.exports = {
  createBranchCatalog,
  syncBranchCatalog,
  syncAllBranches,
  addProduct,
  updateProduct,
  deleteProduct,
  setItemAvailability,
  getCatalogProducts,
  getSyncStatus,
  syncCategoryProductSets,
  rediscoverCatalog,
};
