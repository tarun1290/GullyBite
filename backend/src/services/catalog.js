// src/services/catalog.js
// Syncs restaurant menu to Meta WhatsApp Catalog via facebook-nodejs-business-sdk
// Architecture: ONE main catalog per restaurant, each branch is a product set within it
//
// TOKEN ARCHITECTURE:
// ALL catalog operations across ALL restaurants use the platform's System User Token
// via metaConfig.getCatalogToken(). Individual restaurant tokens from Embedded Signup
// are NOT used here. The System User Token never expires and has access to all WABAs
// shared with the platform's Meta Business account during Embedded Signup.
// If catalog operations fail with permission errors, check the System User Token scopes
// in Meta Business Manager — do NOT generate per-restaurant tokens.

const bizSdk = require('facebook-nodejs-business-sdk');
const axios   = require('axios');
const { col, newId } = require('../config/database');
const { logActivity } = require('./activityLog');
const ws = require('./websocket');
const metaConfig = require('../config/meta');

const Business       = bizSdk.Business;
const ProductCatalog = bizSdk.ProductCatalog;

const GRAPH = metaConfig.graphUrl;

// ── SDK init helper — always uses platform catalog token ────
function initSdk(accessToken) {
  bizSdk.FacebookAdsApi.init(accessToken);
  return bizSdk.FacebookAdsApi.getDefaultApi();
}

// ── Get the catalog token via centralized metaConfig ──
function _getCatalogToken() {
  return metaConfig.getCatalogToken();
}

// ── Get catalog context for a restaurant (token + related docs) ──
async function _getAccessToken(restaurantId) {
  const wa_acc = await col('whatsapp_accounts').findOne({ restaurant_id: restaurantId, is_active: true });
  const restaurant = await col('restaurants').findOne({ _id: restaurantId });
  const token = _getCatalogToken();
  return { token, wa_acc, restaurant };
}

// ─── ENSURE MAIN CATALOG FOR A RESTAURANT ───────────────────
// Every restaurant gets ONE main catalog. All branches share it.
// Branch separation is handled via product sets within this catalog.
const ensureMainCatalog = async (restaurantId) => {
  const restaurant = await col('restaurants').findOne({ _id: restaurantId });
  if (!restaurant) throw new Error('Restaurant not found');

  // Already have a main catalog
  if (restaurant.meta_catalog_id) {
    return { catalogId: restaurant.meta_catalog_id, alreadyExists: true };
  }

  const { token, wa_acc } = await _getAccessToken(restaurantId);

  // Check WABA-level catalog first
  if (wa_acc?.catalog_id) {
    await col('restaurants').updateOne({ _id: restaurantId }, {
      $set: { meta_catalog_id: wa_acc.catalog_id, meta_catalog_name: `${restaurant.business_name} Menu`, catalog_created_at: new Date() }
    });
    console.log(`[Catalog] Restaurant "${restaurant.business_name}" inherited WABA catalog ${wa_acc.catalog_id}`);
    return { catalogId: wa_acc.catalog_id, inherited: true };
  }

  initSdk(token);

  // Check existing WABA catalogs via API
  if (wa_acc?.waba_id) {
    try {
      const existing = await axios.get(`${GRAPH}/${wa_acc.waba_id}/product_catalogs`, {
        params: { access_token: token, fields: 'id,name' }, timeout: 10000,
      });
      const catalogs = existing.data?.data || [];
      if (catalogs.length) {
        const catalogId = catalogs[0].id;
        await col('restaurants').updateOne({ _id: restaurantId }, {
          $set: { meta_catalog_id: catalogId, meta_catalog_name: catalogs[0].name, catalog_created_at: new Date() }
        });
        await col('whatsapp_accounts').updateOne(
          { restaurant_id: restaurantId, is_active: true },
          { $set: { catalog_id: catalogId } }
        );
        console.log(`[Catalog] Inherited existing WABA catalog ${catalogId} for "${restaurant.business_name}"`);
        return { catalogId, inherited: true };
      }
    } catch (e) {
      console.warn('[Catalog] Could not fetch WABA catalogs:', e.response?.data?.error?.message || e.message);
    }
  }

  // Get business ID
  let businessId = metaConfig.businessId;
  if (!businessId) {
    try {
      console.log('[Catalog] META_BUSINESS_ID not set — querying /me/businesses...');
      const meRes = await axios.get(`${GRAPH}/me/businesses`, {
        params: { access_token: token, fields: 'id,name' }, timeout: 10000,
      });
      const businesses = meRes.data?.data || [];
      if (!businesses.length) throw new Error('No Meta Business account found. Set META_BUSINESS_ID in environment variables.');
      businessId = businesses[0].id;
      console.log('[Catalog] Discovered business ID:', businessId);
    } catch (err) {
      throw new Error(`Could not fetch business account: ${err.response?.data?.error?.message || err.message}`);
    }
  }

  // Check existing business catalogs
  let catalogId;
  try {
    const biz = new Business(businessId);
    const bizCatalogs = await biz.getOwnedProductCatalogs(['id', 'name']);
    if (bizCatalogs.length) {
      catalogId = bizCatalogs[0].id;
      console.log(`[Catalog] Found existing business catalog ${catalogId} — using as main catalog`);
    }
  } catch (e) {
    console.warn('[Catalog] Could not read business catalogs:', e.message);
  }

  // Create new catalog if none exist
  if (!catalogId) {
    const catalogName = `${restaurant.business_name} Menu`;
    try {
      const biz = new Business(businessId);
      const created = await biz.createOwnedProductCatalog([], {
        name: catalogName,
        vertical: 'commerce',
      });
      catalogId = created.id;
      console.log(`[Catalog] Created main catalog "${catalogName}" with ID: ${catalogId}`);
    } catch (err) {
      throw new Error(`Catalog creation failed: ${err.message}`);
    }
  }

  // Save to restaurant
  const catalogName = `${restaurant.business_name} Menu`;
  await col('restaurants').updateOne({ _id: restaurantId }, {
    $set: { meta_catalog_id: catalogId, meta_catalog_name: catalogName, catalog_created_at: new Date() }
  });

  // Link to WABA
  if (wa_acc?.waba_id) {
    try {
      await axios.post(
        `${GRAPH}/${wa_acc.waba_id}/product_catalogs`,
        { catalog_id: catalogId },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
      );
      await col('whatsapp_accounts').updateOne(
        { restaurant_id: restaurantId, is_active: true },
        { $set: { catalog_id: catalogId } }
      );
      console.log(`[Catalog] Linked main catalog ${catalogId} to WABA ${wa_acc.waba_id}`);
    } catch (err) {
      console.warn(`[Catalog] Could not auto-link to WABA: ${err.response?.data?.error?.message || err.message}`);
    }
  }

  // Auto-link to phone number: enable cart + visibility
  if (wa_acc?.phone_number_id) {
    try {
      await axios.post(
        `${GRAPH}/${wa_acc.phone_number_id}/whatsapp_commerce_settings`,
        { catalog_id: catalogId, is_catalog_visible: true, is_cart_enabled: true },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
      );
      await col('whatsapp_accounts').updateOne(
        { restaurant_id: restaurantId, is_active: true },
        { $set: { catalog_linked: true, catalog_linked_at: new Date(), cart_enabled: true, catalog_visible: true } }
      );
      console.log(`[Catalog] Auto-linked catalog ${catalogId} to phone ${wa_acc.phone_number_id} (cart + visibility ON)`);
    } catch (err) {
      console.warn(`[Catalog] Auto-link to phone failed (can be done manually): ${err.response?.data?.error?.message || err.message}`);
    }
  }

  return { success: true, catalogId };
};

// ─── ENSURE BRANCH PRODUCT SET WITHIN MAIN CATALOG ──────────
// Each branch gets a product set that filters to its items via retailer_id prefix
const ensureBranchProductSet = async (branchId) => {
  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch) throw new Error('Branch not found');

  // Already has a product set
  if (branch.meta_product_set_id) {
    return { productSetId: branch.meta_product_set_id, alreadyExists: true };
  }

  // Ensure main catalog exists
  const { catalogId } = await ensureMainCatalog(branch.restaurant_id);

  // Also set catalog_id on the branch (for backwards compat with existing code)
  if (!branch.catalog_id || branch.catalog_id !== catalogId) {
    await col('branches').updateOne({ _id: branchId }, { $set: { catalog_id: catalogId } });
    branch.catalog_id = catalogId;
  }

  // Build a filter: match items whose retailer_id starts with this branch's prefix
  // We use a tag-based filter on product_tags[1] which contains the branch name
  const setName = branch.name || `Branch ${branchId.slice(0, 6)}`;

  try {
    const filter = JSON.stringify({ 'product_tags[1]': { contains: branch.name } });
    const res = await axios.post(
      `${GRAPH}/${catalogId}/product_sets`,
      { name: setName, filter },
      { headers: { Authorization: `Bearer ${_getCatalogToken()}` }, timeout: 15000 }
    );
    const productSetId = res.data.id;
    await col('branches').updateOne({ _id: branchId }, { $set: { meta_product_set_id: productSetId } });
    console.log(`[Catalog] Created branch product set "${setName}" → ${productSetId}`);
    return { productSetId, created: true };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.error(`[Catalog] ensureBranchProductSet failed for "${setName}":`, msg);
    throw new Error(`Failed to create branch product set: ${msg}`);
  }
};

// ─── AUTO-CREATE CATALOG FOR A BRANCH (uses main catalog) ────
// Creates the main catalog if needed and assigns it to the branch
const createBranchCatalog = async (branchId) => {
  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch) throw new Error('Branch not found');

  // Use main catalog
  const { catalogId, alreadyExists } = await ensureMainCatalog(branch.restaurant_id);

  // Set catalog_id on branch (for backwards compat)
  if (branch.catalog_id !== catalogId) {
    await col('branches').updateOne({ _id: branchId }, { $set: { catalog_id: catalogId } });
  }

  // Create branch product set in the background (non-blocking)
  ensureBranchProductSet(branchId).catch(err =>
    console.warn(`[Catalog] Branch product set creation deferred:`, err.message)
  );

  return { success: true, catalogId, branchId, alreadyExists };
};

// ─── MAP MENU ITEM → META COMMERCE MANAGER 29-COLUMN FORMAT ──
function mapMenuItemToMetaProduct(item, restaurant, branch) {
  const brandName = item.brand || restaurant?.business_name || 'Restaurant';
  const priceFormatted = (item.price_paise / 100).toFixed(2) + ' INR';
  const salePriceFormatted = item.sale_price_paise
    ? (item.sale_price_paise / 100).toFixed(2) + ' INR'
    : '';
  const productLink = item.link || `${process.env.BASE_URL || 'https://gullybite.com'}/menu/${String(item._id)}`;
  const tags = item.product_tags || [];

  // Ensure description meets Meta's 10-char minimum
  let desc = (item.description || '').trim();
  if (desc.length < 10) {
    desc = `${item.name || 'Menu item'} — Fresh from ${brandName}`;
  }

  // Sanitize retailer_id: only alphanumeric, hyphens, underscores (Meta requirement)
  const safeRetailerId = (item.retailer_id || String(item._id)).replace(/[^a-zA-Z0-9_-]/g, '-').substring(0, 100);

  return {
    id: safeRetailerId,
    title: (item.name || 'Menu Item').substring(0, 200),
    description: desc.substring(0, 1000),
    availability: item.is_available ? 'in stock' : 'out of stock',
    condition: 'new',
    price: priceFormatted,
    link: productLink,
    // FUTURE FEATURE: Re-enable placeholder fallback when image pipeline is active:
    // image_link: item.image_url || require('./imageUpload').getPlaceholderUrl(item) || '',
    image_link: item.image_url || process.env.DEFAULT_FOOD_IMAGE_URL || '',
    brand: brandName,
    google_product_category: item.google_product_category || 'Food, Beverages & Tobacco > Food Items',
    fb_product_category: item.fb_product_category || 'Food & Beverages > Prepared Food',
    quantity_to_sell_on_facebook: item.quantity_to_sell_on_facebook != null ? String(item.quantity_to_sell_on_facebook) : '',
    sale_price: salePriceFormatted,
    sale_price_effective_date: item.sale_price_effective_date || '',
    item_group_id: item.item_group_id || item.retailer_id || '', // standalone items use retailer_id as group
    gender: item.gender || '',
    color: item.color || '',
    size: item.size || item.variant_value || '',
    age_group: item.age_group || '',
    material: item.material || '',
    pattern: item.pattern || '',
    shipping: item.shipping || '',
    shipping_weight: item.shipping_weight || '',
    'video[0].url': item.video_url || '',
    'video[0].tag[0]': item.video_tag || '',
    gtin: item.gtin || '',
    'product_tags[0]': tags[0] || '',
    'product_tags[1]': tags[1] || '',
    'style[0]': item.style || '',
  };
}

// ─── VALIDATE ITEM FOR META COMPLIANCE ──────────────────────
function validateItemForMeta(item) {
  const errors = [];
  if (!item.retailer_id) errors.push('Missing retailer_id');
  else if (/[^a-zA-Z0-9_-]/.test(item.retailer_id)) errors.push('retailer_id contains invalid characters');
  else if (item.retailer_id.length > 100) errors.push('retailer_id exceeds 100 chars');
  if (!item.name || item.name.trim().length === 0) errors.push('Missing name');
  if (!item.price_paise || item.price_paise <= 0) errors.push('Invalid price');
  if (typeof item.price_paise === 'number' && !Number.isInteger(item.price_paise)) errors.push('Price must be integer (paise)');
  return { valid: errors.length === 0, errors };
}

// ─── BUILD BATCH REQUEST FOR A MENU ITEM (uses 29-column mapper) ──
function _buildItemRequest(item, restaurant, branch) {
  if (!item.retailer_id) return null;

  const validation = validateItemForMeta(item);
  if (!validation.valid) {
    console.warn(`[Catalog] Item "${item.name}" (${item.retailer_id}) failed validation:`, validation.errors.join(', '));
    // Still attempt to sync — Meta may accept with auto-fixes from mapMenuItemToMetaProduct
  }

  const retailerId = item.retailer_id;
  const data = mapMenuItemToMetaProduct(item, restaurant, branch);

  return {
    method: 'UPDATE',
    retailer_id: retailerId,
    data,
  };
}

// ─── SYNC ONE BRANCH CATALOG ──────────────────────────────────
// Syncs branch items to the restaurant's MAIN catalog
const syncBranchCatalog = async (branchId) => {
  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch) throw new Error('Branch not found');

  const { token } = await _getAccessToken(branch.restaurant_id);

  // Ensure main catalog exists and branch is linked to it
  try {
    const { catalogId } = await ensureMainCatalog(branch.restaurant_id);
    if (!branch.catalog_id || branch.catalog_id !== catalogId) {
      await col('branches').updateOne({ _id: branchId }, { $set: { catalog_id: catalogId } });
      branch.catalog_id = catalogId;
    }
  } catch (createErr) {
    throw new Error(
      `Could not create WhatsApp catalog for "${branch.name}": ${createErr.message}. ` +
      `If you see "Missing Permission", reconnect your Meta account.`
    );
  }

  const restaurant = await col('restaurants').findOne({ _id: branch.restaurant_id });

  initSdk(token);

  // Get all menu items for this branch
  const items = await col('menu_items').find({ branch_id: branchId }).toArray();

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

  const requests = items.map(item => _buildItemRequest(item, restaurant, branch)).filter(Boolean);

  console.log(`[Catalog] Syncing ${requests.length} items to catalog ${branch.catalog_id} for "${branch.name}"`);

  const BATCH_SIZE = 4999;
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
            await col('restaurants').updateOne({ _id: branch.restaurant_id }, { $unset: { meta_catalog_id: '', meta_catalog_name: '' } });
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

  syncCategoryProductSets(branchId)
    .then(() => ensureBranchCollection(branchId))
    .catch(err => console.warn('[Catalog] Product set / Collection sync failed (non-fatal):', err.message));

  console.log(`[Catalog] Sync complete for "${branch.name}":`, results);

  ws.broadcastToRestaurant(branch.restaurant_id, 'catalog_sync_complete', { branchName: branch.name, itemCount: results.updated, errorCount: results.failed, syncedAt: new Date().toISOString() });

  if (results.failed === 0) {
    logActivity({ actorType: 'system', action: 'catalog.sync_completed', category: 'catalog', description: `Catalog sync completed for "${branch.name}" (${results.updated} updated, ${results.deleted} deleted)`, restaurantId: branch.restaurant_id, resourceType: 'branch', resourceId: branchId, severity: 'info', metadata: { updated: results.updated, deleted: results.deleted, catalogId: branch.catalog_id } });
  }
  if (results.errors.length > 0) {
    logActivity({ actorType: 'system', action: 'catalog.batch_errors', category: 'catalog', description: `Catalog batch had ${results.errors.length} error(s) for "${branch.name}"`, restaurantId: branch.restaurant_id, resourceType: 'branch', resourceId: branchId, severity: 'warning', metadata: { errors: results.errors, failed: results.failed } });
  }

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

// ─── SYNC ENTIRE RESTAURANT CATALOG ─────────────────────────
// Syncs ALL items across ALL branches to the main catalog, then updates branch product sets
const syncRestaurantCatalog = async (restaurantId) => {
  const { catalogId } = await ensureMainCatalog(restaurantId);
  const branches = await col('branches').find({ restaurant_id: restaurantId, accepts_orders: true }).toArray();
  const results = { branches: [], totalItems: 0, totalSynced: 0, totalFailed: 0 };

  // Sync branches in parallel (allSettled — one failure doesn't block others)
  const syncResults = await Promise.allSettled(
    branches.map(branch => syncBranchCatalog(String(branch._id)))
  );
  syncResults.forEach((result, idx) => {
    if (result.status === 'fulfilled') {
      const r = result.value;
      results.branches.push(r);
      results.totalItems += r.total || 0;
      results.totalSynced += r.updated || 0;
      results.totalFailed += r.failed || 0;
    } else {
      results.branches.push({ branchName: branches[idx].name, success: false, error: result.reason?.message || 'Unknown error' });
      results.totalFailed++;
    }
  });

  // Ensure all branches have product sets in parallel
  await Promise.allSettled(
    branches.map(b => ensureBranchProductSet(String(b._id)).catch(err =>
      console.warn(`[Catalog] Branch product set for "${b.name}":`, err.message)
    ))
  );

  // Sync branch-level Collections (fire-and-forget)
  syncAllBranchCollections(restaurantId).catch(err =>
    console.warn('[Catalog] Branch Collections sync failed (non-fatal):', err.message)
  );

  await col('restaurants').updateOne({ _id: restaurantId }, { $set: { last_catalog_sync: new Date() } });

  return { catalogId, ...results };
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
      logActivity({ actorType: 'system', action: 'catalog.sync_failed', category: 'catalog', description: `Catalog sync failed for "${branch.name}": ${err.message}`, restaurantId, resourceType: 'branch', resourceId: String(branch._id), severity: 'error', metadata: { error: err.message } });
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
  if (!branch) return { skipped: true, reason: 'Branch not found' };

  // Use main catalog (auto-create if needed)
  const restaurant = await col('restaurants').findOne({ _id: branch.restaurant_id });
  const catalogId = restaurant?.meta_catalog_id || branch.catalog_id;
  if (!catalogId) {
    try {
      const { catalogId: newCatId } = await ensureMainCatalog(branch.restaurant_id);
      if (!newCatId) return { skipped: true, reason: 'No catalog' };
      return addProduct(menuItemId); // retry with new catalog
    } catch { return { skipped: true, reason: 'No catalog' }; }
  }

  const { token } = await _getAccessToken(branch.restaurant_id);
  initSdk(token);

  const request = _buildItemRequest(item, restaurant, branch);
  if (!request) return { skipped: true };

  try {
    const catalogObj = new ProductCatalog(catalogId);
    await catalogObj.createItemsBatch([], {
      allow_upsert: true,
      item_type: 'PRODUCT_ITEM',
      requests: [request],
    });
    await col('menu_items').updateOne(
      { _id: menuItemId },
      { $set: { catalog_sync_status: 'synced', catalog_synced_at: new Date() } }
    );
    console.log(`[Catalog] addProduct synced: ${item.retailer_id}`);
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
  if (!branch || !menuItem?.retailer_id) return { skipped: true };

  const restaurant = await col('restaurants').findOne({ _id: branch.restaurant_id });
  const catalogId = restaurant?.meta_catalog_id || branch.catalog_id;
  if (!catalogId) return { skipped: true };

  const { token } = await _getAccessToken(branch.restaurant_id);
  initSdk(token);

  try {
    const catalogObj = new ProductCatalog(catalogId);
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

  const restaurant = await col('restaurants').findOne({ _id: branch?.restaurant_id });
  const catalogId = restaurant?.meta_catalog_id || branch?.catalog_id;
  if (!catalogId || !item.retailer_id) return;

  const { token } = await _getAccessToken(branch.restaurant_id);
  initSdk(token);

  // Use the 29-column mapper — availability is encoded as "in stock" / "out of stock"
  const request = _buildItemRequest({ ...item, is_available: isAvailable }, restaurant, branch);
  if (!request) return;

  try {
    const catalogObj = new ProductCatalog(catalogId);
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
const getCatalogProducts = async (idOrCatalogId) => {
  // Try as branch ID first
  const branch = await col('branches').findOne({ _id: idOrCatalogId });

  if (branch) {
    // Found a branch — use existing SDK-based logic
    const restaurant = await col('restaurants').findOne({ _id: branch.restaurant_id });
    const catalogId = restaurant?.meta_catalog_id || branch.catalog_id;
    if (!catalogId) return { products: [], catalogId: null };

    const { token } = await _getAccessToken(branch.restaurant_id);
    initSdk(token);

    try {
      const catalogObj = new ProductCatalog(catalogId);
      const products = await catalogObj.getProducts(
        ['id', 'retailer_id', 'name', 'description', 'price', 'currency', 'availability', 'image_url', 'url'],
        { limit: 250 }
      );
      return { catalogId, products: products.map(p => p._data), total: products.length };
    } catch (err) {
      console.error('[Catalog] getProducts (branch) failed:', err._error?.error?.message || err.message);
      return { catalogId, products: [], error: err._error?.error?.message || err.message };
    }
  }

  // Not a branch — treat as a Meta catalog ID and fetch via Graph API
  const catalogId = idOrCatalogId;
  const token = _getCatalogToken();
  const allProducts = [];
  try {
    let url = `${GRAPH}/${catalogId}/products?fields=id,retailer_id,name,description,price,availability,image_url,brand&limit=500&access_token=${token}`;
    while (url) {
      const { data } = await axios.get(url, { timeout: 15000 });
      allProducts.push(...(data.data || []));
      url = data.paging?.next || null;
    }
    return { catalogId, products: allProducts, total: allProducts.length };
  } catch (err) {
    console.error('[Catalog] getProducts (catalogId) failed:', err.response?.data?.error?.message || err.message);
    return { catalogId, products: [], error: err.response?.data?.error?.message || err.message };
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
    mainCatalogId     : restaurant?.meta_catalog_id || null,
    mainCatalogName   : restaurant?.meta_catalog_name || null,
    catalogSyncEnabled: restaurant?.catalog_sync_enabled || false,
    lastFullSync      : restaurant?.last_catalog_sync || null,
    branches          : branchStatuses,
  };
};

// ─── PRODUCT SETS — CRUD + SYNC ─────────────────────────────

// Build Meta filter JSON from product_set document
function _buildSetFilter(set) {
  if (set.type === 'manual' && set.manual_retailer_ids?.length) {
    return JSON.stringify({ retailer_id: { is_any: set.manual_retailer_ids } });
  }
  if (set.type === 'tag' && set.filter_value) {
    return JSON.stringify({ 'product_tags[0]': { contains: set.filter_value } });
  }
  if (set.type === 'category' && set.filter_value) {
    return JSON.stringify({ 'product_tags[1]': { contains: set.filter_value } });
  }
  // Fallback: empty filter matches all products
  return JSON.stringify({});
}

// Create a product set on Meta
const createProductSet = async (catalogId, name, filter) => {
  const token = _getCatalogToken();
  try {
    const res = await axios.post(
      `${GRAPH}/${catalogId}/product_sets`,
      { name, filter },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );
    console.log(`[Catalog] Created product set "${name}" → ${res.data.id}`);
    return res.data;
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.error(`[Catalog] createProductSet "${name}" failed:`, msg);
    throw new Error(msg);
  }
};

// Update a product set on Meta
const updateProductSet = async (metaProductSetId, name, filter) => {
  const token = _getCatalogToken();
  try {
    await axios.post(
      `${GRAPH}/${metaProductSetId}`,
      { name, filter },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );
    console.log(`[Catalog] Updated product set "${name}" (${metaProductSetId})`);
    return { success: true };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.error(`[Catalog] updateProductSet "${name}" failed:`, msg);
    throw new Error(msg);
  }
};

// Delete a product set from Meta
const deleteProductSet = async (metaProductSetId) => {
  const token = _getCatalogToken();
  try {
    await axios.delete(`${GRAPH}/${metaProductSetId}`, {
      params: { access_token: token },
      timeout: 15000,
    });
    console.log(`[Catalog] Deleted product set ${metaProductSetId}`);
    return { success: true };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.error(`[Catalog] deleteProductSet failed:`, msg);
    throw new Error(msg);
  }
};

// Sync all product_sets for a branch to Meta
const syncProductSets = async (branchId) => {
  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch) throw new Error('Branch not found');
  if (!branch.catalog_id) return { skipped: true, reason: 'No catalog' };

  const sets = await col('product_sets').find({
    branch_id: branchId,
    is_active: true,
  }).sort({ sort_order: 1 }).toArray();

  if (!sets.length) return { skipped: true, reason: 'No product sets' };

  const results = { created: 0, updated: 0, failed: 0 };

  for (const set of sets) {
    const filter = _buildSetFilter(set);
    try {
      if (set.meta_product_set_id) {
        await updateProductSet(set.meta_product_set_id, set.name, filter);
        results.updated++;
      } else {
        const created = await createProductSet(branch.catalog_id, set.name, filter);
        await col('product_sets').updateOne(
          { _id: set._id },
          { $set: { meta_product_set_id: created.id, updated_at: new Date() } }
        );
        results.created++;
      }
    } catch (err) {
      console.error(`[Catalog] Product set "${set.name}" sync failed:`, err.message);
      results.failed++;
    }
  }

  console.log(`[Catalog] syncProductSets for "${branch.name}": created=${results.created}, updated=${results.updated}, failed=${results.failed}`);

  // Chain: sync collections after product sets
  await syncCollections(branchId).catch(err =>
    console.error('[Catalog] Collection sync failed:', err.message)
  );

  return { success: results.failed === 0, ...results };
};

// ─── AUTO-CREATE PRODUCT SETS FROM MENU TAGS/CATEGORIES ──────
const autoCreateProductSets = async (branchId) => {
  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch) throw new Error('Branch not found');

  const items = await col('menu_items').find({ branch_id: branchId, is_available: true }).toArray();
  if (!items.length) return { created: 0, skipped: 0, message: 'No menu items' };

  const now = new Date();
  let created = 0;
  let skipped = 0;

  // 1. Extract unique product_tags[1] values → category-based sets
  const tagValues = new Set();
  for (const item of items) {
    const tags = item.product_tags || [];
    if (tags[1]) tagValues.add(tags[1]);
  }

  for (const tagVal of tagValues) {
    const existing = await col('product_sets').findOne({ branch_id: branchId, name: tagVal });
    if (existing) { skipped++; continue; }

    await col('product_sets').insertOne({
      _id: newId(),
      branch_id: branchId,
      restaurant_id: branch.restaurant_id,
      catalog_id: branch.catalog_id || null,
      meta_product_set_id: null,
      name: tagVal,
      type: 'category',
      filter_value: tagVal,
      manual_retailer_ids: [],
      is_active: true,
      sort_order: created + 1,
      created_at: now,
      updated_at: now,
    });
    created++;
    console.log(`[Catalog] Auto-created product set "${tagVal}" for branch "${branch.name}"`);
  }

  // 2. Also create sets from menu_categories if no tag-based sets exist for them
  const catIds = [...new Set(items.map(i => i.category_id).filter(Boolean))];
  if (catIds.length) {
    const cats = await col('menu_categories').find({ _id: { $in: catIds } }).sort({ sort_order: 1 }).toArray();
    for (const cat of cats) {
      const existing = await col('product_sets').findOne({ branch_id: branchId, name: cat.name });
      if (existing) { skipped++; continue; }

      await col('product_sets').insertOne({
        _id: newId(),
        branch_id: branchId,
        restaurant_id: branch.restaurant_id,
        catalog_id: branch.catalog_id || null,
        meta_product_set_id: null,
        name: cat.name,
        type: 'tag',
        filter_value: cat.name,
        manual_retailer_ids: [],
        is_active: true,
        sort_order: created + 1,
        created_at: now,
        updated_at: now,
      });
      created++;
      console.log(`[Catalog] Auto-created product set from category "${cat.name}" for branch "${branch.name}"`);
    }
  }

  // 3. Create "Bestsellers" set from bestseller items
  const bestsellers = items.filter(i => i.is_bestseller && i.retailer_id);
  if (bestsellers.length) {
    const existing = await col('product_sets').findOne({ branch_id: branchId, name: 'Bestsellers' });
    if (!existing) {
      await col('product_sets').insertOne({
        _id: newId(),
        branch_id: branchId,
        restaurant_id: branch.restaurant_id,
        catalog_id: branch.catalog_id || null,
        meta_product_set_id: null,
        name: 'Bestsellers',
        type: 'manual',
        filter_value: null,
        manual_retailer_ids: bestsellers.map(i => i.retailer_id),
        is_active: true,
        sort_order: -1, // show first
        created_at: now,
        updated_at: now,
      });
      created++;
      console.log(`[Catalog] Auto-created "Bestsellers" set (${bestsellers.length} items) for branch "${branch.name}"`);
    } else {
      // Update existing Bestsellers set with current bestseller items
      await col('product_sets').updateOne(
        { _id: existing._id },
        { $set: { manual_retailer_ids: bestsellers.map(i => i.retailer_id), updated_at: now } }
      );
      skipped++;
    }
  }

  // 4. Sync all sets to Meta
  if (created > 0 && branch.catalog_id) {
    await syncProductSets(branchId);
  }

  // 5. Auto-create collections from the new product sets
  await autoCreateCollections(branchId).catch(err =>
    console.warn('[Catalog] Auto-create collections after sets failed:', err.message)
  );

  console.log(`[Catalog] autoCreateProductSets for "${branch.name}": created=${created}, skipped=${skipped}`);
  return { created, skipped };
};

// Legacy wrapper — backwards compat with existing syncBranchCatalog call
const syncCategoryProductSets = async (branchId) => {
  return syncProductSets(branchId);
};

// ─── CATALOG COLLECTIONS — CRUD + SYNC ──────────────────────
// Collections are the customer-facing storefront tabs that group product sets.
// Chain: Menu Items → Product Sets → Collections → What customers see in WhatsApp

// Create a collection on Meta
const createCollection = async (catalogId, name, productSetIds, description, coverImageUrl) => {
  const token = _getCatalogToken();
  try {
    const body = { name, product_set_ids: productSetIds };
    if (description) body.description = description;
    if (coverImageUrl) body.cover_image_url = coverImageUrl;
    const res = await axios.post(
      `${GRAPH}/${catalogId}/product_set_collections`,
      body,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );
    console.log(`[Catalog] Created collection "${name}" → ${res.data.id}`);
    return res.data;
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.error(`[Catalog] createCollection "${name}" failed:`, msg);
    throw new Error(msg);
  }
};

// Update a collection on Meta
const updateCollection = async (metaCollectionId, updates) => {
  const token = _getCatalogToken();
  try {
    const body = {};
    if (updates.name !== undefined)           body.name = updates.name;
    if (updates.productSetIds !== undefined)   body.product_set_ids = updates.productSetIds;
    if (updates.description !== undefined)     body.description = updates.description;
    if (updates.coverImageUrl !== undefined)   body.cover_image_url = updates.coverImageUrl;
    await axios.post(
      `${GRAPH}/${metaCollectionId}`,
      body,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );
    console.log(`[Catalog] Updated collection ${metaCollectionId}`);
    return { success: true };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.error(`[Catalog] updateCollection failed:`, msg);
    throw new Error(msg);
  }
};

// Delete a collection from Meta
const deleteCollection = async (metaCollectionId) => {
  const token = _getCatalogToken();
  try {
    await axios.delete(`${GRAPH}/${metaCollectionId}`, {
      params: { access_token: token },
      timeout: 15000,
    });
    console.log(`[Catalog] Deleted collection ${metaCollectionId}`);
    return { success: true };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.error(`[Catalog] deleteCollection failed:`, msg);
    throw new Error(msg);
  }
};

// List collections on Meta for a catalog
const listCollections = async (catalogId) => {
  const token = _getCatalogToken();
  try {
    const res = await axios.get(
      `${GRAPH}/${catalogId}/product_set_collections`,
      { params: { access_token: token, fields: 'id,name,description,product_set_ids' }, timeout: 15000 }
    );
    return res.data?.data || [];
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.error(`[Catalog] listCollections failed:`, msg);
    return [];
  }
};

// Sync all catalog_collections for a branch to Meta
const syncCollections = async (branchId) => {
  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch) throw new Error('Branch not found');
  if (!branch.catalog_id) return { skipped: true, reason: 'No catalog' };

  const collections = await col('catalog_collections').find({
    branch_id: branchId,
    is_active: true,
  }).sort({ sort_order: 1 }).toArray();

  if (!collections.length) return { skipped: true, reason: 'No collections' };

  const results = { created: 0, updated: 0, failed: 0, skipped: 0 };

  for (const coll of collections) {
    // Resolve product_set_ids → only include sets that have been synced to Meta
    const sets = await col('product_sets').find({
      _id: { $in: coll.product_set_ids },
      meta_product_set_id: { $exists: true, $ne: null },
    }).toArray();

    const metaSetIds = sets.map(s => s.meta_product_set_id);

    if (!metaSetIds.length) {
      console.warn(`[Catalog] Collection "${coll.name}" has zero synced product sets — skipping`);
      results.skipped++;
      continue;
    }

    try {
      if (coll.meta_collection_id) {
        await updateCollection(coll.meta_collection_id, {
          name: coll.name,
          productSetIds: metaSetIds,
          description: coll.description,
          coverImageUrl: coll.cover_image_url,
        });
        results.updated++;
      } else {
        const created = await createCollection(
          branch.catalog_id,
          coll.name,
          metaSetIds,
          coll.description,
          coll.cover_image_url
        );
        await col('catalog_collections').updateOne(
          { _id: coll._id },
          { $set: { meta_collection_id: created.id, updated_at: new Date() } }
        );
        results.created++;
      }
    } catch (err) {
      console.error(`[Catalog] Collection "${coll.name}" sync failed:`, err.message);
      results.failed++;
    }
  }

  console.log(`[Catalog] syncCollections for "${branch.name}": created=${results.created}, updated=${results.updated}, failed=${results.failed}, skipped=${results.skipped}`);
  return { success: results.failed === 0, ...results };
};

// ─── AUTO-CREATE COLLECTIONS FROM PRODUCT SETS ──────────────
// Groups product sets into customer-friendly collections
const autoCreateCollections = async (branchId) => {
  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch) throw new Error('Branch not found');

  const sets = await col('product_sets').find({
    branch_id: branchId,
    is_active: true,
  }).sort({ sort_order: 1 }).toArray();

  if (!sets.length) return { created: 0, skipped: 0, message: 'No product sets' };

  const now = new Date();
  let created = 0;
  let skipped = 0;

  // Known groupings: keyword → { emoji, collectionName }
  const KNOWN_GROUPS = {
    momo:       { emoji: '🥟', name: 'Momos' },
    coffee:     { emoji: '☕', name: 'Coffee' },
    matcha:     { emoji: '🍵', name: 'Matcha' },
    tea:        { emoji: '🍵', name: 'Tea' },
    sushi:      { emoji: '🍣', name: 'Sushi' },
    maki:       { emoji: '🍣', name: 'Sushi' },
    nigiri:     { emoji: '🍣', name: 'Sushi' },
    dessert:    { emoji: '🍰', name: 'Desserts' },
    cake:       { emoji: '🍰', name: 'Desserts' },
    pastry:     { emoji: '🥐', name: 'Viennoiserie' },
    croissant:  { emoji: '🥐', name: 'Viennoiserie' },
    viennoiserie: { emoji: '🥐', name: 'Viennoiserie' },
    mocktail:   { emoji: '🍹', name: 'Mocktails' },
    milkshake:  { emoji: '🥤', name: 'Milkshakes' },
    shake:      { emoji: '🥤', name: 'Milkshakes' },
    smoothie:   { emoji: '🥤', name: 'Smoothies' },
    biryani:    { emoji: '🍚', name: 'Biryani' },
    pizza:      { emoji: '🍕', name: 'Pizza' },
    burger:     { emoji: '🍔', name: 'Burgers' },
    noodle:     { emoji: '🍜', name: 'Noodles' },
    wrap:       { emoji: '🌯', name: 'Wraps' },
    salad:      { emoji: '🥗', name: 'Salads' },
    sandwich:   { emoji: '🥪', name: 'Sandwiches' },
    beverage:   { emoji: '🥤', name: 'Beverages' },
    drink:      { emoji: '🥤', name: 'Beverages' },
    starter:    { emoji: '🍢', name: 'Starters' },
    appetizer:  { emoji: '🍢', name: 'Starters' },
    bread:      { emoji: '🍞', name: 'Breads' },
    naan:       { emoji: '🍞', name: 'Breads' },
    roti:       { emoji: '🍞', name: 'Breads' },
    rice:       { emoji: '🍚', name: 'Rice' },
    thali:      { emoji: '🍽️', name: 'Thali' },
    snack:      { emoji: '🍿', name: 'Snacks' },
  };

  // Group sets into collections
  const collectionGroups = new Map(); // collectionName → { emoji, setIds[] }
  const comboSets = [];
  const bestsellerSets = [];

  for (const set of sets) {
    const nameLower = set.name.toLowerCase();

    // Bestsellers → special collection
    if (nameLower.includes('bestseller') || nameLower.includes('best seller')) {
      bestsellerSets.push(String(set._id));
      continue;
    }

    // Combos & Deals → special collection
    if (nameLower.includes('combo') || nameLower.includes('deal')) {
      comboSets.push(String(set._id));
      continue;
    }

    // Try known groupings
    let matched = false;
    for (const [keyword, group] of Object.entries(KNOWN_GROUPS)) {
      if (nameLower.includes(keyword)) {
        const key = group.name;
        if (!collectionGroups.has(key)) {
          collectionGroups.set(key, { emoji: group.emoji, setIds: [] });
        }
        collectionGroups.get(key).setIds.push(String(set._id));
        matched = true;
        break;
      }
    }

    // Fallback: group by first word of set name
    if (!matched) {
      const firstWord = set.name.split(/\s+/)[0];
      if (firstWord && firstWord.length > 1) {
        const key = firstWord;
        if (!collectionGroups.has(key)) {
          collectionGroups.set(key, { emoji: '', setIds: [] });
        }
        collectionGroups.get(key).setIds.push(String(set._id));
      }
    }
  }

  // Helper to create a collection if it doesn't exist
  async function _ensureCollection(name, setIds, sortOrder) {
    if (!setIds.length) return;
    const existing = await col('catalog_collections').findOne({ branch_id: branchId, name });
    if (existing) { skipped++; return; }
    await col('catalog_collections').insertOne({
      _id: newId(),
      branch_id: branchId,
      restaurant_id: branch.restaurant_id,
      catalog_id: branch.catalog_id || null,
      meta_collection_id: null,
      name,
      description: null,
      product_set_ids: setIds,
      cover_image_url: null,
      is_active: true,
      sort_order: sortOrder,
      created_at: now,
      updated_at: now,
    });
    created++;
    console.log(`[Catalog] Auto-created collection "${name}" (${setIds.length} sets) for branch "${branch.name}"`);
  }

  // 1. Bestsellers at sort_order 0
  await _ensureCollection('⭐ Bestsellers', bestsellerSets, 0);

  // 2. Regular collections
  let order = 1;
  for (const [name, group] of collectionGroups) {
    const displayName = group.emoji ? `${group.emoji} ${name}` : name;
    await _ensureCollection(displayName, group.setIds, order++);
  }

  // 3. Combos & Deals last
  await _ensureCollection('🎁 Combos & Deals', comboSets, order);

  // Sync to Meta
  if (created > 0 && branch.catalog_id) {
    await syncCollections(branchId);
  }

  console.log(`[Catalog] autoCreateCollections for "${branch.name}": created=${created}, skipped=${skipped}`);
  return { created, skipped };
};

// ─── BRANCH-LEVEL COLLECTION (one Collection per branch) ─────
// Creates/updates a single master Collection per branch that contains
// ALL of that branch's product sets. Stored as meta_collection_id on the branch doc.
const ensureBranchCollection = async (branchId) => {
  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch) throw new Error('Branch not found');
  if (!branch.catalog_id) return { skipped: true, reason: 'No catalog' };

  // Gather all synced product sets for this branch
  const sets = await col('product_sets').find({
    branch_id: branchId,
    is_active: true,
    meta_product_set_id: { $exists: true, $ne: null },
  }).toArray();

  const metaSetIds = sets.map(s => s.meta_product_set_id);

  // Also include the branch-level product set if it exists
  if (branch.meta_product_set_id && !metaSetIds.includes(branch.meta_product_set_id)) {
    metaSetIds.unshift(branch.meta_product_set_id);
  }

  if (!metaSetIds.length) {
    console.warn(`[Catalog] No synced product sets for branch "${branch.name}" — skipping Collection`);
    return { skipped: true, reason: 'No synced product sets' };
  }

  const restaurant = await col('restaurants').findOne({ _id: branch.restaurant_id });
  const collectionName = `${branch.name} Menu`;
  const description = restaurant?.business_name
    ? `Menu items available at ${restaurant.business_name} — ${branch.name}`
    : `Menu items available at ${branch.name}`;

  try {
    if (branch.meta_collection_id) {
      // Update existing Collection
      await updateCollection(branch.meta_collection_id, {
        name: collectionName,
        productSetIds: metaSetIds,
        description,
      });
      console.log(`[Catalog] Updated branch Collection "${collectionName}" (${metaSetIds.length} sets)`);
      return { success: true, updated: true, collectionId: branch.meta_collection_id };
    } else {
      // Create new Collection
      const created = await createCollection(branch.catalog_id, collectionName, metaSetIds, description);
      await col('branches').updateOne(
        { _id: branchId },
        { $set: { meta_collection_id: created.id, collection_updated_at: new Date() } }
      );
      console.log(`[Catalog] Created branch Collection "${collectionName}" → ${created.id} (${metaSetIds.length} sets)`);
      return { success: true, created: true, collectionId: created.id };
    }
  } catch (err) {
    console.error(`[Catalog] ensureBranchCollection failed for "${branch.name}":`, err.message);
    return { success: false, error: err.message };
  }
};

// Sync branch-level Collections for all branches of a restaurant
const syncAllBranchCollections = async (restaurantId) => {
  const branches = await col('branches').find({ restaurant_id: restaurantId }).toArray();
  const results = { created: 0, updated: 0, skipped: 0, failed: 0 };

  for (const branch of branches) {
    try {
      const r = await ensureBranchCollection(String(branch._id));
      if (r.skipped) results.skipped++;
      else if (r.created) results.created++;
      else if (r.updated) results.updated++;
    } catch (err) {
      console.error(`[Catalog] syncAllBranchCollections — "${branch.name}" failed:`, err.message);
      results.failed++;
    }
  }

  console.log(`[Catalog] syncAllBranchCollections for restaurant ${restaurantId}:`, results);
  return results;
};

// Delete branch Collection from Meta and clear from DB
const deleteBranchCollection = async (branchId) => {
  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch?.meta_collection_id) return { skipped: true };

  try {
    await deleteCollection(branch.meta_collection_id);
    await col('branches').updateOne(
      { _id: branchId },
      { $set: { meta_collection_id: null, collection_updated_at: new Date() } }
    );
    return { success: true };
  } catch (err) {
    console.error(`[Catalog] deleteBranchCollection failed:`, err.message);
    return { success: false, error: err.message };
  }
};

// ─── CLEAR STALE CATALOG & RE-DISCOVER ───────────────────────
const rediscoverCatalog = async (branchId) => {
  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch) throw new Error('Branch not found');
  const oldId = branch.catalog_id;
  await col('branches').updateMany({ restaurant_id: branch.restaurant_id }, { $unset: { catalog_id: '' } });
  await col('restaurants').updateOne({ _id: branch.restaurant_id }, { $unset: { meta_catalog_id: '', meta_catalog_name: '' } });
  await col('whatsapp_accounts').updateMany({ restaurant_id: branch.restaurant_id }, { $unset: { catalog_id: '' } });
  console.log(`[Catalog] Cleared stale catalog_id "${oldId}" for restaurant — re-discovering main catalog`);
  return await createBranchCatalog(branchId);
};

// ─── FETCH CATALOGS FROM META API ────────────────────────────
const fetchBusinessCatalogs = async (businessId) => {
  const token = _getCatalogToken();
  try {
    const res = await axios.get(`${GRAPH}/${businessId}/owned_product_catalogs`, {
      params: { fields: 'id,name,product_count,vertical', access_token: token },
      timeout: 10000,
    });
    console.log(`[Catalog] Found ${res.data.data?.length || 0} catalogs for business ${businessId}`);
    return res.data.data || [];
  } catch (err) {
    console.error('[Catalog] Failed to fetch business catalogs:', err.response?.data?.error?.message || err.message);
    return [];
  }
};

const fetchWabaCatalogs = async (wabaId) => {
  const token = _getCatalogToken();
  try {
    const res = await axios.get(`${GRAPH}/${wabaId}/product_catalogs`, {
      params: { fields: 'id,name,product_count', access_token: token },
      timeout: 10000,
    });
    return res.data.data || [];
  } catch (err) {
    console.error('[Catalog] Failed to fetch WABA catalogs:', err.response?.data?.error?.message || err.message);
    return [];
  }
};

// ─── DELETE CATALOG (unlink first, then delete) ─────────────
// Must unlink from phone before deleting to avoid Meta error 1798233
const deleteCatalogSafe = async (catalogId, restaurantId) => {
  const token = _getCatalogToken();
  const wa = await col('whatsapp_accounts').findOne({ restaurant_id: restaurantId, is_active: true });

  // Step 1: Unlink from phone
  if (wa?.phone_number_id) {
    try {
      await axios.post(
        `${GRAPH}/${wa.phone_number_id}/whatsapp_commerce_settings`,
        { is_catalog_visible: false, is_cart_enabled: false },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
      );
      await col('whatsapp_accounts').updateOne(
        { _id: wa._id },
        { $set: { catalog_linked: false, cart_enabled: false, catalog_visible: false } }
      );
      console.log(`[Catalog] Unlinked catalog ${catalogId} from phone ${wa.phone_number_id}`);
      await new Promise(r => setTimeout(r, 2000)); // wait for Meta to process
    } catch (err) {
      console.warn('[Catalog] Unlink before delete failed:', err.response?.data?.error?.message || err.message);
    }
  }

  // Step 2: Delete the catalog
  try {
    await axios.delete(`${GRAPH}/${catalogId}`, {
      params: { access_token: token }, timeout: 15000,
    });
    console.log(`[Catalog] Deleted catalog ${catalogId}`);
  } catch (err) {
    throw new Error(`Catalog deletion failed: ${err.response?.data?.error?.message || err.message}`);
  }

  // Step 3: Clean up DB
  await col('restaurants').updateOne(
    { _id: restaurantId },
    { $unset: { meta_catalog_id: '', meta_catalog_name: '', catalog_created_at: '' } }
  );
  await col('branches').updateMany(
    { restaurant_id: restaurantId },
    { $unset: { catalog_id: '' } }
  );
  await col('whatsapp_accounts').updateMany(
    { restaurant_id: restaurantId },
    { $unset: { catalog_id: '' } }
  );

  return { success: true };
};

module.exports = {
  // Main catalog architecture
  ensureMainCatalog,
  ensureBranchProductSet,
  syncRestaurantCatalog,
  deleteCatalogSafe,
  // Branch-level (uses main catalog internally)
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
  syncProductSets,
  createProductSet,
  updateProductSet,
  deleteProductSet,
  autoCreateProductSets,
  mapMenuItemToMetaProduct,
  rediscoverCatalog,
  fetchBusinessCatalogs,
  fetchWabaCatalogs,
  // Collections
  createCollection,
  updateCollection,
  deleteCollection,
  listCollections,
  syncCollections,
  autoCreateCollections,
  // Branch-level Collections
  ensureBranchCollection,
  syncAllBranchCollections,
  deleteBranchCollection,
  // Compliance
  validateItemForMeta,
};
