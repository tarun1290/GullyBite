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
const catalogGuard = require('./catalog.service');
const features = require('../config/features');
const alertsSvc = require('./alerts');
const log = require('../utils/logger').child({ component: 'catalog' });

// Maps the catalog.service guard's internal reason codes onto the
// user-facing codes the spec requires for skipped sync entries.
const SYNC_SKIP_CODE = {
  product_unassigned:                 'UNASSIGNED_PRODUCT',
  product_not_assigned_to_this_branch:'UNASSIGNED_PRODUCT',
  branch_not_found:                   'BRANCH_INACTIVE',
  branch_inactive:                    'BRANCH_INACTIVE',
  branch_missing_fssai:               'FSSAI_MISSING',
  no_price_configured:                'PRICE_MISSING',
  meta_incomplete:                    'META_INCOMPLETE',
};

// Per-product audit row writer. Fire-and-forget — never blocks the
// sync. Used for both eligible (status=synced) and skipped products
// so the admin "Sync Logs" page has a complete attempt history.
// Per-product audit row writer for `sync_logs`. Delegates to the
// canonical model-layer function so the schema lives in one place.
function _writeSyncLog(restaurantId, branchId, productId, status, reason) {
  return catalogGuard.writeSyncLog({
    restaurantId, branchId, productId, status, reason,
  });
}

// Per-sync aggregate writer for `sync_summary`. One row per
// syncBranchCatalog invocation — coarse rollup over sync_logs.
// Fire-and-forget; errors here must never break the sync response.
async function _writeSyncSummary({ restaurantId, branchId, total, synced, skipped, successRate, mode }) {
  const failureRate = total > 0 ? (Number(skipped) || 0) / total : 0;
  try {
    await col('sync_summary').insertOne({
      _id: newId(),
      restaurant_id: String(restaurantId),
      branch_id:     branchId ? String(branchId) : null,
      total:         Number(total) || 0,
      synced:        Number(synced) || 0,
      skipped:       Number(skipped) || 0,
      success_rate:  Number.isFinite(successRate) ? successRate : 0,
      failure_rate:  failureRate,
      mode:          mode || null,
      timestamp:     new Date(),
    });
  } catch (_) { /* audit only */ }

  // Fire-and-forget alert check. Runs AFTER the summary is persisted
  // so the alert row references the same numbers the rollup stores.
  // Never awaited by the sync path — alerting must not slow syncs.
  alertsSvc.maybeAlertFromSummary({
    restaurant_id: restaurantId,
    branch_id:     branchId,
    total:         Number(total) || 0,
    synced:        Number(synced) || 0,
    skipped:       Number(skipped) || 0,
    failure_rate:  failureRate,
    mode:          mode || null,
  }).catch(() => { /* alerts are best-effort */ });
}

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

  const { token, wa_acc } = await _getAccessToken(restaurantId);

  // Already have a main catalog — verify it still exists on Meta
  if (restaurant.meta_catalog_id) {
    try {
      await axios.get(`${GRAPH}/${restaurant.meta_catalog_id}`, {
        params: { access_token: token, fields: 'id' }, timeout: 8000,
      });
      log.info({ catalogId: restaurant.meta_catalog_id }, 'ensureMainCatalog: using stored catalog (verified on Meta)');
      return { catalogId: restaurant.meta_catalog_id, alreadyExists: true };
    } catch (checkErr) {
      const code = checkErr.response?.status;
      if (code === 400 || code === 404) {
        log.warn({ catalogId: restaurant.meta_catalog_id, httpStatus: code }, 'Stored catalog no longer exists on Meta — clearing and rediscovering');
        await col('restaurants').updateOne({ _id: restaurantId }, { $unset: { meta_catalog_id: '', meta_catalog_name: '', catalog_created_at: '' } });
        await col('branches').updateMany({ restaurant_id: restaurantId }, { $unset: { catalog_id: '' } });
      } else {
        // Network error or timeout — trust the stored ID
        log.warn({ err: checkErr, catalogId: restaurant.meta_catalog_id }, 'Could not verify catalog — using stored ID');
        return { catalogId: restaurant.meta_catalog_id, alreadyExists: true };
      }
    }
  }

  // Helper: pick the best catalog from a list (prefer name match, then highest product_count)
  function _pickBestCatalog(catalogs, businessName) {
    if (catalogs.length === 1) return catalogs[0];
    const nameMatch = catalogs.find(c => c.name && businessName && c.name.toLowerCase().includes(businessName.toLowerCase()));
    if (nameMatch) return nameMatch;
    const sorted = [...catalogs].sort((a, b) => (b.product_count || 0) - (a.product_count || 0));
    if (catalogs.length > 1) {
      log.warn({ catalogCount: catalogs.length, pickedId: sorted[0].id }, 'Multiple catalogs found — picked based on product_count');
    }
    return sorted[0];
  }

  // Helper: validate a catalog ID is accessible before adopting
  async function _validateCatalog(catId) {
    try {
      const check = await axios.get(`${GRAPH}/${catId}`, { params: { access_token: token, fields: 'id,name,product_count' }, timeout: 10000 });
      log.info({ catalogId: catId, name: check.data.name, productCount: check.data.product_count }, 'Validated catalog');
      return check.data;
    } catch (valErr) {
      log.error({ err: valErr, catalogId: catId }, 'Chosen catalog is not accessible');
      return null;
    }
  }

  // Check WABA-level catalog first
  if (wa_acc?.catalog_id) {
    const valid = await _validateCatalog(wa_acc.catalog_id);
    if (valid) {
      await col('restaurants').updateOne({ _id: restaurantId }, {
        $set: { meta_catalog_id: wa_acc.catalog_id, meta_catalog_name: valid.name || `${restaurant.business_name} Menu`, catalog_created_at: new Date() }
      });
      log.info({ businessName: restaurant.business_name, catalogId: wa_acc.catalog_id }, 'Restaurant inherited WABA catalog');
      return { catalogId: wa_acc.catalog_id, inherited: true };
    }
  }

  initSdk(token);

  // Check existing WABA catalogs via API
  if (wa_acc?.waba_id) {
    try {
      const existing = await axios.get(`${GRAPH}/${wa_acc.waba_id}/product_catalogs`, {
        params: { access_token: token, fields: 'id,name,product_count' }, timeout: 10000,
      });
      const catalogs = existing.data?.data || [];
      if (catalogs.length) {
        const chosen = _pickBestCatalog(catalogs, restaurant.business_name);
        const valid = await _validateCatalog(chosen.id);
        if (valid) {
          await col('restaurants').updateOne({ _id: restaurantId }, {
            $set: { meta_catalog_id: chosen.id, meta_catalog_name: valid.name, catalog_created_at: new Date() }
          });
          await col('whatsapp_accounts').updateOne(
            { restaurant_id: restaurantId, is_active: true },
            { $set: { catalog_id: chosen.id, catalog_linked: true, catalog_linked_at: new Date() } }
          );
          log.info({ catalogId: chosen.id, businessName: restaurant.business_name }, 'ensureMainCatalog: using discovered catalog from WABA');
          return { catalogId: chosen.id, inherited: true };
        }
      }
    } catch (e) {
      log.warn({ err: e }, 'Could not fetch WABA catalogs');
    }
  }

  // Get business ID
  let businessId = metaConfig.businessId;
  if (!businessId) {
    try {
      log.info('META_BUSINESS_ID not set — querying /me/businesses');
      const meRes = await axios.get(`${GRAPH}/me/businesses`, {
        params: { access_token: token, fields: 'id,name' }, timeout: 10000,
      });
      const businesses = meRes.data?.data || [];
      if (!businesses.length) throw new Error('No Meta Business account found. Set META_BUSINESS_ID in environment variables.');
      businessId = businesses[0].id;
      log.info({ businessId }, 'Discovered business ID');
    } catch (err) {
      throw new Error(`Could not fetch business account: ${err.response?.data?.error?.message || err.message}`);
    }
  }

  // Check existing business catalogs
  let catalogId;
  try {
    const biz = new Business(businessId);
    const bizCatalogs = await biz.getOwnedProductCatalogs(['id', 'name', 'product_count']);
    if (bizCatalogs.length) {
      const chosen = _pickBestCatalog(bizCatalogs, restaurant.business_name);
      const valid = await _validateCatalog(chosen.id);
      if (valid) {
        catalogId = chosen.id;
        log.info({ catalogId }, 'Found existing business catalog — using as main catalog');
      }
    }
  } catch (e) {
    log.warn({ err: e }, 'Could not read business catalogs');
  }

  // Create new catalog if none exist or none validated
  if (!catalogId) {
    const catalogName = `${restaurant.business_name} Menu`;
    try {
      const biz = new Business(businessId);
      const created = await biz.createOwnedProductCatalog([], {
        name: catalogName,
        vertical: 'commerce',
      });
      catalogId = created.id;
      log.info({ catalogId, catalogName }, 'Created main catalog');
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
        { $set: { catalog_id: catalogId, catalog_linked: true, catalog_linked_at: new Date() } }
      );
      log.info({ catalogId, wabaId: wa_acc.waba_id }, 'ensureMainCatalog: created and linked to WABA');
    } catch (err) {
      log.warn({ err }, 'Could not auto-link to WABA');
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
      log.info({ catalogId, phoneNumberId: wa_acc.phone_number_id }, 'Auto-linked catalog to phone (cart + visibility ON)');
    } catch (err) {
      log.warn({ err }, 'Auto-link to phone failed (can be done manually)');
    }
  }

  return { success: true, catalogId };
};

// ─── ENSURE BRANCH PRODUCT SET WITHIN MAIN CATALOG ──────────
// Each branch gets a product set that filters to its items via retailer_id prefix
const ensureBranchProductSet = async (branchId) => {
  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch) throw new Error('Branch not found');

  // Ensure main catalog exists
  const { catalogId } = await ensureMainCatalog(branch.restaurant_id);

  // Set catalog_id on the branch (for backwards compat)
  if (!branch.catalog_id || branch.catalog_id !== catalogId) {
    await col('branches').updateOne({ _id: branchId }, { $set: { catalog_id: catalogId } });
    branch.catalog_id = catalogId;
  }

  // Check branch has items before creating a product set
  const itemCount = await col('menu_items').countDocuments({ branch_id: branchId, retailer_id: { $exists: true, $ne: null } });
  if (!itemCount) {
    log.warn({ branchId, branchName: branch.name }, 'No items for branch — skipping product set');
    return { productSetId: null, skipped: true, reason: 'no items' };
  }

  const setName = branch.name || `Branch ${branchId.slice(0, 6)}`;
  // Dynamic filter: matches any item whose custom_label_0 equals this branch slug
  const branchSlug = (branch.branch_slug || branch.name || '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const filter = JSON.stringify({ custom_label_0: { is_any: [branchSlug] } });
  const token = _getCatalogToken();

  try {
    if (branch.meta_product_set_id) {
      // UPDATE existing product set with refreshed retailer_id list
      await axios.post(
        `${GRAPH}/${branch.meta_product_set_id}`,
        { name: setName, filter },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
      );
      log.info({ setName, branchSlug, itemCount }, 'Updated branch product set');
      return { productSetId: branch.meta_product_set_id, updated: true };
    }

    // CREATE new product set
    const res = await axios.post(
      `${GRAPH}/${catalogId}/product_sets`,
      { name: setName, filter },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );
    const productSetId = res.data.id;
    await col('branches').updateOne({ _id: branchId }, { $set: { meta_product_set_id: productSetId } });
    log.info({ setName, productSetId, branchSlug, itemCount }, 'Created branch product set');
    return { productSetId, created: true };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    log.error({ err, setName }, 'ensureBranchProductSet failed');
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
    log.warn({ err }, 'Branch product set creation deferred')
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

  // Use trust-enriched meta description if available, else fallback to base description
  let desc = (item.meta_description_generated || item.description || '').trim();
  if (desc.length < 10) {
    desc = `${item.name || 'Menu item'} — Fresh from ${brandName}`;
  }

  // Sanitize retailer_id: only alphanumeric, hyphens, underscores (Meta requirement)
  const safeRetailerId = (item.retailer_id || String(item._id)).replace(/[^a-zA-Z0-9_-]/g, '-').substring(0, 100);

  // ── India compliance fields ──
  const manufacturerInfo = `${restaurant?.business_name || 'Restaurant'} - ${branch?.address || branch?.name || ''}`.substring(0, 200);

  // ── Category / product type ──
  const productType = (item.product_type || tags[1] || item.category_name || 'Food').substring(0, 750);

  // ── Branch identification ──
  const branchLabel = (branch?.branch_slug || branch?.name || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').substring(0, 100);

  // ── Dietary classification (from food_type field) ──
  const dietMap = { veg: 'veg', non_veg: 'non-veg', egg: 'egg', vegan: 'vegan' };
  const dietLabel = dietMap[item.food_type] || '';

  // ── Internal label for filtering (does NOT trigger product review on update) ──
  const internalLabels = [branchLabel, productType.toLowerCase(), dietLabel, item.is_available ? 'available' : 'unavailable']
    .filter(Boolean)
    .map(l => l.replace(/[^a-z0-9_-]/g, '-').substring(0, 110));
  const internalLabel = '[' + internalLabels.map(l => "'" + l + "'").join(',') + ']';

  // ── Variant attribute ──
  const variantAttr = (item.variant_type && item.variant_value)
    ? `${item.variant_type}:${item.variant_value}`.substring(0, 200)
    : '';

  return {
    id: safeRetailerId,
    title: (item.name || 'Menu Item').substring(0, 200),
    description: desc.substring(0, 1000),
    availability: item.is_available ? 'in stock' : 'out of stock',
    condition: 'new',
    price: priceFormatted,
    link: productLink,
    // Use medium (600x600) for Meta catalog; fall back to original or placeholder
    image_link: (() => {
      const imgUrl = item.image_url;
      if (imgUrl) {
        const { getMediumUrl } = require('./imageUpload');
        return getMediumUrl(imgUrl) || imgUrl;
      }
      const { IMAGE_PIPELINE_ENABLED, } = require('../config/features');
      if (IMAGE_PIPELINE_ENABLED) {
        return require('./imageUpload').getPlaceholderUrl(item) || process.env.DEFAULT_FOOD_IMAGE_URL || '';
      }
      return process.env.DEFAULT_FOOD_IMAGE_URL || 'https://gullybite.com/img/food-placeholder.png';
    })(),
    brand: brandName,
    google_product_category: item.google_product_category || 'Food, Beverages & Tobacco > Food Items',
    fb_product_category: item.fb_product_category || 'Food & Beverages > Prepared Food',
    quantity_to_sell_on_facebook: item.quantity_to_sell_on_facebook != null ? String(item.quantity_to_sell_on_facebook) : '',
    sale_price: salePriceFormatted,
    sale_price_effective_date: item.sale_price_effective_date || '',
    item_group_id: item.item_group_id || '',
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
    // India compliance
    origin_country: 'IN',
    wa_compliance_category: 'COUNTRY_ORIGIN_EXEMPT',
    manufacturer_info: manufacturerInfo,
    // Categorization
    product_type: productType,
    custom_label_0: branchLabel,
    custom_label_1: dietLabel,
    // Filtering (no product review trigger)
    internal_label: internalLabel,
    // Variant enhancement
    additional_variant_attribute: variantAttr,
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
    log.warn({ itemName: item.name, retailerId: item.retailer_id, errors: validation.errors }, 'Item failed validation');
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
// Concurrency lock for per-branch sync. Uses `catalog_sync_locks` with
// branch_id as the key; lock_expires_at is a safety net for crashed workers
// (not a sync timeout), checked inline in the acquire filter — no TTL index.
const BRANCH_SYNC_LOCK_TTL_MS = 2 * 60 * 1000;
const BRANCH_SYNC_ITEM_CAP    = 5000;

const syncBranchCatalog = async (branchId) => {
  const LOCK_KEY = `branch:${String(branchId)}`;
  const lockAcquiredAt = new Date();
  const lockExpiresAt  = new Date(lockAcquiredAt.getTime() + BRANCH_SYNC_LOCK_TTL_MS);

  // Acquire the lock. findOneAndUpdate with upsert:true and a filter that
  // only matches "no doc" or "expired doc". If a live lock exists, the
  // upsert collides on _id and Mongo throws E11000 — we treat that as
  // "held by another worker" and bail.
  try {
    await col('catalog_sync_locks').findOneAndUpdate(
      {
        _id: LOCK_KEY,
        $or: [
          { lock_expires_at: { $exists: false } },
          { lock_expires_at: { $lte: lockAcquiredAt } },
        ],
      },
      {
        $set: {
          branch_id:       String(branchId),
          locked_at:       lockAcquiredAt,
          lock_expires_at: lockExpiresAt,
        },
      },
      { upsert: true }
    );
  } catch (err) {
    if (err && err.code === 11000) {
      log.info({ branchId }, 'Branch sync skipped: another worker holds the lock');
      return {
        success: false, skipped: true,
        branchName: null, catalogId: null,
        total_products: 0, synced_count: 0, skipped_count: 0, skipped_reasons: [],
        total: 0, updated: 0, deleted: 0, failed: 0,
        errors: ['SYNC_IN_PROGRESS'],
        success_rate: 0,
      };
    }
    throw err;
  }

  try {
    return await _syncBranchCatalogLocked(branchId);
  } finally {
    // Only release if our own lock timestamp is still there — don't clobber
    // a lock taken over by another worker after ours expired mid-run.
    await col('catalog_sync_locks')
      .deleteOne({ _id: LOCK_KEY, locked_at: lockAcquiredAt })
      .catch(() => { /* best-effort release */ });
  }
};

const _syncBranchCatalogLocked = async (branchId) => {
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

  // Get all menu items for this branch — include both legacy scalar
  // (branch_id) AND the new branch_ids[] membership, so branch-first
  // products are picked up without breaking pre-migration rows.
  const items = await col('menu_items').find({
    $or: [{ branch_id: branchId }, { branch_ids: branchId }],
  }).toArray();

  const totalProducts = items.length;
  if (!totalProducts) {
    return { success: false, message: 'No menu items found for this branch',
             total_products: 0, synced_count: 0, skipped_count: 0, skipped_reasons: [],
             success_rate: 0 };
  }

  // ── META VALIDATION (LOG-ONLY AUDIT PASS) ──
  // Independent observability pass — runs on every sync regardless of
  // mode so we always have a structured verdict log per product.
  try {
    await catalogGuard.logValidateForMeta(branchId, items);
  } catch (e) {
    log.warn({ err: e.message, branchId }, 'meta validation wrapper failed (non-fatal)');
  }

  // ── MODE-GATED VALIDATION WRAPPER ──
  // strict    → filterForSync drops invalid products; only eligible ones go to Meta.
  // log_only  → filterForSync still runs so we can write accurate audit rows,
  //             BUT the eligible set is expanded back to ALL products — every
  //             item is still forwarded to Meta, matching the existing
  //             non-blocking behaviour.
  // disabled  → skip the guard entirely; every product is forwarded.
  const strictMode = features.ENABLE_META_VALIDATION
                  && features.META_VALIDATION_MODE === 'strict';
  const runValidation = features.ENABLE_META_VALIDATION;

  let eligible = [], skipped = [];
  if (runValidation) {
    ({ eligible, skipped } = await catalogGuard.filterForSync(branchId, items));
  } else {
    eligible = items.map(p => ({ product: p }));
  }

  const skippedReasonsOut = skipped.map(s => {
    const code = SYNC_SKIP_CODE[s.reason] || s.reason;
    const auditStatus = strictMode ? 'skipped' : 'synced'; // log_only still sends, but flag it
    log.warn({
      product_id: s.product_id, branch_id: branchId,
      status: auditStatus, reason: code, mode: features.META_VALIDATION_MODE,
    }, strictMode ? 'catalog sync: product skipped (strict)' : 'catalog sync: product flagged (log_only, still sent)');
    _writeSyncLog(branch.restaurant_id, branchId, s.product_id,
      strictMode ? 'skipped' : 'synced', code);
    return { product_id: s.product_id, branch_id: branchId, reason: code };
  });

  // In log_only (or disabled) mode, keep the full item list so every
  // product still reaches Meta. In strict mode, only eligible IDs survive.
  const eligibleIds = new Set(eligible.map(e => String(e.product._id)));
  const syncItems   = strictMode
    ? items.filter(it => eligibleIds.has(String(it._id)))
    : items.slice();

  if (!syncItems.length) {
    log.warn({ branchId, total_products: totalProducts, skipped_count: skipped.length },
             'catalog sync: nothing eligible after validation');
    _writeSyncSummary({
      restaurantId: branch.restaurant_id, branchId,
      total: totalProducts, synced: 0, skipped: skipped.length,
      successRate: 0,
      mode: features.ENABLE_META_VALIDATION ? features.META_VALIDATION_MODE : 'disabled',
    });
    return {
      success: true, branchName: branch.name, catalogId: branch.catalog_id,
      total_products: totalProducts, synced_count: 0,
      skipped_count: skipped.length, skipped_reasons: skippedReasonsOut,
      total: 0, updated: 0, deleted: 0, failed: 0, errors: [],
      success_rate: 0,
    };
  }

  // Sort: group variants together
  syncItems.sort((a, b) => {
    const ga = a.item_group_id || String(a._id);
    const gb = b.item_group_id || String(b._id);
    if (ga !== gb) return ga < gb ? -1 : 1;
    return (a.sort_order || 0) - (b.sort_order || 0);
  });

  // Reassign so the rest of this function (which references `items`)
  // operates on the eligible-only set.
  items.length = 0;
  items.push(...syncItems);

  // ── META CATALOG ITEM CAP ──
  // Meta enforces a hard 5000-product-per-catalog limit. Guard here so we
  // never ship a partial batch that would leave the catalog in an
  // inconsistent state. NOT the batch chunk size (BATCH_SIZE) — that caps
  // requests per batch endpoint call, which is a different thing.
  if (items.length > BRANCH_SYNC_ITEM_CAP) {
    log.warn(
      { branchId, itemCount: items.length, cap: BRANCH_SYNC_ITEM_CAP },
      'catalog sync: branch exceeds Meta 5000-item cap — aborting before push'
    );
    try {
      await col('sync_logs').insertOne({
        _id:            newId(),
        restaurant_id:  String(branch.restaurant_id),
        branch_id:      String(branchId),
        product_id:     null,
        status:         'failed',
        reason:         'ITEM_CAP_EXCEEDED',
        item_count:     items.length,
        cap:            BRANCH_SYNC_ITEM_CAP,
        created_at:     new Date(),
      });
    } catch (_) { /* audit-only */ }
    _writeSyncSummary({
      restaurantId: branch.restaurant_id,
      branchId,
      total:        totalProducts,
      synced:       0,
      skipped:      skipped.length,
      successRate:  0,
      mode:         features.ENABLE_META_VALIDATION ? features.META_VALIDATION_MODE : 'disabled',
    });
    return {
      success:         false,
      branchName:      branch.name,
      catalogId:       branch.catalog_id,
      total_products:  totalProducts,
      synced_count:    0,
      skipped_count:   skipped.length,
      skipped_reasons: skippedReasonsOut,
      total:           items.length,
      updated:         0,
      deleted:         0,
      failed:          items.length,
      errors:          [`ITEM_CAP_EXCEEDED: ${items.length} items exceeds Meta catalog cap of ${BRANCH_SYNC_ITEM_CAP}`],
      success_rate:    0,
    };
  }

  // Avoid double-writing audit rows: in log_only mode, invalid products
  // were already logged above as status='synced' with a reason code.
  // Only write the clean 'synced' row for items that weren't already
  // audited by the skipped-reasons loop.
  const alreadyLogged = new Set(skippedReasonsOut.map(r => String(r.product_id)));
  syncItems.forEach(it => {
    if (alreadyLogged.has(String(it._id))) return;
    log.info({ product_id: it._id, branch_id: branchId, status: 'synced' }, 'catalog sync entry');
    _writeSyncLog(branch.restaurant_id, branchId, it._id, 'synced', null);
  });

  const requests = items.map(item => _buildItemRequest(item, restaurant, branch)).filter(Boolean);

  log.info({ itemCount: requests.length, catalogId: branch.catalog_id, branchName: branch.name }, 'Syncing items to catalog');
  if (requests.length && requests[0]) {
    log.info({ retailerId: requests[0].retailer_id, hasImage: !!requests[0].data?.image_link, price: requests[0].data?.price }, 'Sample item');
  }

  const BATCH_SIZE = 4999;
  const results = { updated: 0, deleted: 0, failed: 0, errors: [] };
  let catalogFixed = false;

  for (let i = 0; i < requests.length; i += BATCH_SIZE) {
    const batch      = requests.slice(i, i + BATCH_SIZE);
    const batchNum   = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(requests.length / BATCH_SIZE);

    log.info({ branchName: branch.name, batchNum, totalBatches, batchSize: batch.length }, 'Processing batch');

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
        const errMsg = err._error?.error?.message || err.response?.data?.error?.message || err.message;
        log.error({ err, batchNum, attempt: attempt + 1 }, 'Batch error');
        if (err._error?.error) log.error({ metaError: err._error.error }, 'Full Meta error');

        const isStale = attempt === 0 && !catalogFixed && (
          errMsg.includes('does not exist') ||
          errMsg.includes('missing permissions') ||
          errMsg.includes('Unsupported post request')
        );

        if (isStale) {
          log.warn({ catalogId: branch.catalog_id }, 'Stale catalog_id — clearing and re-discovering');
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
            log.info({ catalogId: branch.catalog_id, batchNum }, 'Re-discovered catalog — retrying batch');
          } catch (fixErr) {
            log.error({ err: fixErr }, 'Re-discovery failed');
            results.failed += batch.length;
            results.errors.push(`Batch ${batchNum}: catalog re-discovery failed — ${fixErr.message}`);
            batchDone = true;
          }
        } else {
          log.error({ batchNum, errMsg }, 'Batch failed');
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
    .catch(err => log.warn({ err }, 'Product set / Collection sync failed (non-fatal)'));

  log.info({ branchName: branch.name, updated: results.updated, deleted: results.deleted, failed: results.failed }, 'Sync complete');

  ws.broadcastToRestaurant(branch.restaurant_id, 'catalog_sync_complete', { branchName: branch.name, itemCount: results.updated, errorCount: results.failed, syncedAt: new Date().toISOString() });

  if (results.failed === 0) {
    logActivity({ actorType: 'system', action: 'catalog.sync_completed', category: 'catalog', description: `Catalog sync completed for "${branch.name}" (${results.updated} updated, ${results.deleted} deleted)`, restaurantId: branch.restaurant_id, resourceType: 'branch', resourceId: branchId, severity: 'info', metadata: { updated: results.updated, deleted: results.deleted, catalogId: branch.catalog_id } });
  }
  if (results.errors.length > 0) {
    logActivity({ actorType: 'system', action: 'catalog.batch_errors', category: 'catalog', description: `Catalog batch had ${results.errors.length} error(s) for "${branch.name}"`, restaurantId: branch.restaurant_id, resourceType: 'branch', resourceId: branchId, severity: 'warning', metadata: { errors: results.errors, failed: results.failed } });
  }

  // ── SYNC METRICS ROLLUP ──
  // Persist a coarse per-sync summary + return success_rate alongside
  // the existing shape. Fire-and-forget — never blocks the response.
  const syncedCount  = results.updated;
  const skippedCount = skippedReasonsOut.length;
  const successRate  = totalProducts > 0 ? syncedCount / totalProducts : 0;
  _writeSyncSummary({
    restaurantId: branch.restaurant_id,
    branchId,
    total: totalProducts,
    synced: syncedCount,
    skipped: skippedCount,
    successRate,
    mode: features.ENABLE_META_VALIDATION ? features.META_VALIDATION_MODE : 'disabled',
  });

  return {
    success         : results.failed === 0,
    branchName      : branch.name,
    catalogId       : branch.catalog_id,
    total           : items.length,
    updated         : results.updated,
    deleted         : results.deleted,
    failed          : results.failed,
    errors          : results.errors,
    // Spec-mandated branch-validation summary
    total_products  : totalProducts,
    synced_count    : syncedCount,
    skipped_count   : skippedCount,
    skipped_reasons : skippedReasonsOut,
    success_rate    : successRate,
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
      log.warn({ err, branchName: b.name }, 'Branch product set sync failed')
    ))
  );

  // Sync branch-level Collections (fire-and-forget)
  syncAllBranchCollections(restaurantId).catch(err =>
    log.warn({ err }, 'Branch Collections sync failed (non-fatal)')
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
    log.info({ retailerId: item.retailer_id }, 'addProduct synced');
    return { success: true, retailer_id: item.retailer_id };
  } catch (err) {
    const errMsg = err._error?.error?.message || err.message;
    log.error({ err }, 'addProduct failed');
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
// Retries up to 3 times with a 1-second gap on Meta API failure. If all
// attempts fail, a delete_failed row is written to sync_logs so the item
// can be reconciled later (Meta keeps the stale product otherwise).
const deleteProduct = async (menuItem, branchId) => {
  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch || !menuItem?.retailer_id) return { skipped: true };

  const restaurant = await col('restaurants').findOne({ _id: branch.restaurant_id });
  const catalogId = restaurant?.meta_catalog_id || branch.catalog_id;
  if (!catalogId) return { skipped: true };

  const { token } = await _getAccessToken(branch.restaurant_id);
  initSdk(token);

  const MAX_ATTEMPTS = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const catalogObj = new ProductCatalog(catalogId);
      await catalogObj.createItemsBatch([], {
        allow_upsert: true,
        item_type: 'PRODUCT_ITEM',
        requests: [{ method: 'DELETE', retailer_id: menuItem.retailer_id, item_type: 'PRODUCT_ITEM' }],
      });
      return { success: true, retailer_id: menuItem.retailer_id, attempts: attempt };
    } catch (err) {
      lastErr = err;
      const errMsg = err._error?.error?.message || err.message;
      log.warn({ err, attempt, retailerId: menuItem.retailer_id }, 'deleteProduct attempt failed');
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        log.error({ err, retailerId: menuItem.retailer_id }, 'deleteProduct failed after retries');
        try {
          await col('sync_logs').insertOne({
            _id:            newId(),
            restaurant_id:  String(branch.restaurant_id),
            branch_id:      String(branchId),
            product_id:     menuItem._id ? String(menuItem._id) : null,
            retailer_id:    menuItem.retailer_id,
            status:         'failed',
            reason:         'DELETE_FAILED',
            error:          errMsg,
            delete_failed:  true,
            attempts:       MAX_ATTEMPTS,
            created_at:     new Date(),
          });
        } catch (_) { /* audit-only */ }
        return { success: false, error: errMsg, attempts: MAX_ATTEMPTS };
      }
    }
  }
  // Unreachable — the loop either returns success or returns after MAX_ATTEMPTS.
  return { success: false, error: lastErr?.message || 'unknown', attempts: MAX_ATTEMPTS };
};

// ─── BULK DELETE PRODUCTS FROM CATALOG ───────────────────────
// Called after menu_items.deleteMany() in the bulk-delete route. Sends
// explicit DELETE batch requests to Meta so removed items disappear from
// the catalog immediately, without a full branch re-sync. Any chunk that
// fails is recorded in sync_logs with delete_failed=true for later reconcile.
const bulkDeleteProducts = async (items, branchId) => {
  if (!Array.isArray(items) || !items.length) return { skipped: true };

  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch) return { skipped: true, reason: 'Branch not found' };

  const restaurant = await col('restaurants').findOne({ _id: branch.restaurant_id });
  const catalogId = restaurant?.meta_catalog_id || branch.catalog_id;
  if (!catalogId) return { skipped: true, reason: 'No catalog for branch' };

  const eligible = items.filter(i => i && i.retailer_id);
  if (!eligible.length) return { skipped: true, reason: 'No items with retailer_id' };

  const token = _getCatalogToken();
  const BATCH_SIZE = 4999;
  const results = { deleted: 0, failed: 0, errors: [] };

  for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
    const chunk = eligible.slice(i, i + BATCH_SIZE);
    const requests = chunk.map(it => ({
      method: 'DELETE',
      retailer_id: it.retailer_id,
      item_type: 'PRODUCT_ITEM',
    }));

    try {
      await axios.post(
        `${GRAPH}/${catalogId}/items_batch`,
        {
          item_type: 'PRODUCT_ITEM',
          requests: JSON.stringify(requests),
        },
        { params: { access_token: token }, timeout: 30000 }
      );
      results.deleted += chunk.length;
      log.info({ branchId, catalogId, count: chunk.length }, 'bulkDeleteProducts chunk succeeded');
    } catch (err) {
      const errMsg = err.response?.data?.error?.message || err.message;
      log.error({ err, branchId, chunkSize: chunk.length }, 'bulkDeleteProducts chunk failed');
      results.failed += chunk.length;
      results.errors.push(errMsg);
      try {
        await col('sync_logs').insertOne({
          _id:              newId(),
          restaurant_id:    String(branch.restaurant_id),
          branch_id:        String(branchId),
          product_id:       null,
          retailer_ids:     chunk.map(it => it.retailer_id),
          status:           'failed',
          reason:           'BULK_DELETE_FAILED',
          error:            errMsg,
          delete_failed:    true,
          count:            chunk.length,
          created_at:       new Date(),
        });
      } catch (_) { /* audit-only */ }
    }
  }

  return { success: results.failed === 0, ...results };
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

  // Lightweight availability-only sync to Meta
  await syncItemAvailability(branch.restaurant_id, { ...item, is_available: isAvailable });
};

// ─── LIGHTWEIGHT SINGLE-ITEM AVAILABILITY SYNC ──────────────
// Sends ONLY the availability field to Meta — much faster than full item sync.
// Called fire-and-forget from the toggle route.
const syncItemAvailability = async (restaurantId, menuItem) => {
  try {
    const restaurant = await col('restaurants').findOne({ _id: restaurantId });
    const catalogId = restaurant?.meta_catalog_id;
    if (!catalogId) {
      log.warn({ restaurantId }, 'syncItemAvailability: no catalog for restaurant');
      return null;
    }
    if (!menuItem?.retailer_id) return null;

    const token = _getCatalogToken();
    const avail = menuItem.is_available ? 'in stock' : 'out of stock';

    const resp = await axios.post(
      `${GRAPH}/${catalogId}/items_batch`,
      {
        item_type: 'PRODUCT_ITEM',
        requests: JSON.stringify([{
          method: 'UPDATE',
          retailer_id: menuItem.retailer_id,
          data: { availability: avail },
        }]),
      },
      { params: { access_token: token }, timeout: 15000 }
    );

    const handle = resp.data?.handles?.[0] || null;
    log.info({ retailerId: menuItem.retailer_id, availability: avail, handle }, 'Availability update queued');

    // Log for debugging
    col('catalog_sync_logs').insertOne({
      _id: newId(), restaurant_id: restaurantId, handle, type: 'availability_update',
      retailer_id: menuItem.retailer_id, new_status: avail, created_at: new Date(), status: 'pending',
    }).catch(() => {});

    if (menuItem._id) {
      await col('menu_items').updateOne(
        { _id: menuItem._id },
        { $set: { catalog_sync_status: 'synced', catalog_synced_at: new Date() } }
      );
    }
    return handle;
  } catch (err) {
    log.error({ err, retailerId: menuItem.retailer_id }, 'Availability sync failed');
    if (menuItem._id) {
      await col('menu_items').updateOne({ _id: menuItem._id }, { $set: { catalog_sync_status: 'error' } }).catch(() => {});
    }
    return null;
  }
};

// ─── BULK AVAILABILITY SYNC ─────────────────────────────────
// Syncs availability for many items at once (e.g., restaurant closing for the day).
// items: array of { retailer_id, is_available }
const syncBulkAvailability = async (restaurantId, items) => {
  try {
    const restaurant = await col('restaurants').findOne({ _id: restaurantId });
    const catalogId = restaurant?.meta_catalog_id;
    if (!catalogId) {
      log.warn({ restaurantId }, 'Bulk availability: no catalog for restaurant');
      return [];
    }
    if (!items.length) return [];

    const token = _getCatalogToken();
    const BATCH_SIZE = 4999;
    const handles = [];

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      const requests = batch.map(it => ({
        method: 'UPDATE',
        retailer_id: it.retailer_id,
        data: { availability: it.is_available ? 'in stock' : 'out of stock' },
      }));

      try {
        const resp = await axios.post(
          `${GRAPH}/${catalogId}/items_batch`,
          { item_type: 'PRODUCT_ITEM', requests: JSON.stringify(requests) },
          { params: { access_token: token }, timeout: 30000 }
        );
        const handle = resp.data?.handles?.[0] || null;
        if (handle) handles.push(handle);
      } catch (batchErr) {
        log.error({ err: batchErr, batchNum: Math.floor(i / BATCH_SIZE) + 1 }, 'Bulk availability batch failed');
      }
    }

    log.info({ itemCount: items.length, batchCount: Math.ceil(items.length / BATCH_SIZE), handles }, 'Bulk availability update complete');

    // Log summary
    col('catalog_sync_logs').insertOne({
      _id: newId(), catalog_id: catalogId, handles, type: 'bulk_availability_update',
      item_count: items.length, created_at: new Date(), status: 'pending', restaurant_id: restaurantId,
    }).catch(() => {});

    return handles;
  } catch (err) {
    log.error({ err }, 'Bulk availability sync error');
    return [];
  }
};

// ─── CHECK BATCH REQUEST STATUS ─────────────────────────────
const checkSyncStatus = async (catalogId, handle) => {
  try {
    const token = _getCatalogToken();
    const resp = await axios.get(
      `${GRAPH}/${catalogId}/check_batch_request_status`,
      { params: { handle, access_token: token }, timeout: 10000 }
    );
    const data = resp.data?.data?.[0] || resp.data || {};
    return {
      status: data.status || 'unknown',
      processed: data.num_handled || 0,
      errors: (data.errors || []).map(e => ({ retailer_id: e.retailer_id, message: e.message })),
    };
  } catch (err) {
    log.error({ err, catalogId, handle }, 'Batch status check failed');
    return { status: 'error', processed: 0, errors: [{ message: err.message }] };
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
      log.error({ err, catalogId }, 'getProducts (branch) failed');
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
    log.error({ err, catalogId }, 'getProducts (catalogId) failed');
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

// Build Meta filter JSON from product_set document.
//
// Meta's Catalog filter rules are a thin Elastic Search-style DSL keyed
// on top-level field names (retailer_id, product_tags, etc.) with
// operators like is_any, contains, eq, i_contains. Two shapes Meta
// rejects with "Param filter must be a valid Elastic Search rule":
//   - Bracket-indexed paths like 'product_tags[0]' — invalid syntax
//   - {} — empty filters cannot be persisted
// Returning null here lets the caller skip the API call entirely
// instead of POSTing a filter we know Meta will refuse.
function _buildSetFilter(set) {
  // Manual: explicit list of retailer_ids — keep as-is, this shape is correct
  if (set.type === 'manual' && set.manual_retailer_ids?.length) {
    return JSON.stringify({ retailer_id: { is_any: set.manual_retailer_ids } });
  }
  // Tag- and category-based filters: use product_tags with i_contains
  // (case-insensitive contains). Bracket-indexed paths are not supported.
  if (set.type === 'tag' && set.filter_value) {
    return JSON.stringify({ product_tags: { i_contains: set.filter_value } });
  }
  if (set.type === 'category' && set.filter_value) {
    return JSON.stringify({ product_tags: { i_contains: set.filter_value } });
  }
  // No usable filter — return null so caller can skip the API call entirely
  // (Meta rejects empty/missing filters with the same error).
  return null;
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
    log.info({ name, productSetId: res.data.id }, 'Created product set');
    return res.data;
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    log.error({ err, name }, 'createProductSet failed');
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
    log.info({ name, metaProductSetId }, 'Updated product set');
    return { success: true };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    log.error({ err, name, metaProductSetId }, 'updateProductSet failed');
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
    log.info({ metaProductSetId }, 'Deleted product set');
    return { success: true };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    log.error({ err, metaProductSetId }, 'deleteProductSet failed');
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
    // _buildSetFilter returns null when there's no usable filter
    // (e.g. a tag-typed set with no filter_value). Posting a null/empty
    // filter triggers Meta's "Param filter must be a valid Elastic
    // Search rule" error and would just bump results.failed without
    // surfacing a meaningful error to ops, so skip cleanly.
    if (!filter) {
      log.warn({ setName: set.name, branchId }, 'Skipping product set — no usable filter');
      continue;
    }
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
      log.error({ err, setName: set.name }, 'Product set sync failed');
      results.failed++;
      // 'synced_orphan' = product live in Meta catalog but no product set covers it,
      // so MPM cannot send it. Resolved automatically on the next successful sync.
      // Items get downgraded only when we can deterministically identify which
      // products this failed set was meant to cover (manual list, or a
      // tag/category filter_value).
      try {
        let coveredFilter = null;
        if (set.type === 'manual' && set.manual_retailer_ids?.length) {
          coveredFilter = { retailer_id: { $in: set.manual_retailer_ids } };
        } else if ((set.type === 'tag' || set.type === 'category') && set.filter_value) {
          coveredFilter = { product_tags: set.filter_value };
        }
        if (coveredFilter) {
          await col('menu_items').updateMany(
            { branch_id: branchId, catalog_sync_status: 'synced', ...coveredFilter },
            { $set: { catalog_sync_status: 'synced_orphan' } }
          );
        }
      } catch (orphanErr) {
        log.warn({ err: orphanErr.message, setName: set.name }, 'Failed to downgrade items to synced_orphan');
      }
    }
  }

  log.info({ branchName: branch.name, created: results.created, updated: results.updated, failed: results.failed }, 'syncProductSets complete');

  // Chain: sync collections after product sets
  await syncCollections(branchId).catch(err =>
    log.error({ err }, 'Collection sync failed')
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
    log.info({ setName: tagVal, branchName: branch.name }, 'Auto-created product set');
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
      log.info({ categoryName: cat.name, branchName: branch.name }, 'Auto-created product set from category');
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
      log.info({ itemCount: bestsellers.length, branchName: branch.name }, 'Auto-created Bestsellers set');
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
    log.warn({ err }, 'Auto-create collections after sets failed')
  );

  log.info({ branchName: branch.name, created, skipped }, 'autoCreateProductSets complete');
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
      `${GRAPH}/${catalogId}/collections`,
      body,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );
    log.info({ name, collectionId: res.data.id }, 'Created collection');
    return res.data;
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    log.error({ err, name }, 'createCollection failed');
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
    log.info({ metaCollectionId }, 'Updated collection');
    return { success: true };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    log.error({ err, metaCollectionId }, 'updateCollection failed');
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
    log.info({ metaCollectionId }, 'Deleted collection');
    return { success: true };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    log.error({ err, metaCollectionId }, 'deleteCollection failed');
    throw new Error(msg);
  }
};

// List collections on Meta for a catalog
const listCollections = async (catalogId) => {
  const token = _getCatalogToken();
  try {
    const res = await axios.get(
      `${GRAPH}/${catalogId}/collections`,
      { params: { access_token: token, fields: 'id,name,description,product_set_ids' }, timeout: 15000 }
    );
    return res.data?.data || [];
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    log.error({ err, catalogId }, 'listCollections failed');
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
      log.warn({ collectionName: coll.name }, 'Collection has zero synced product sets — skipping');
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
      log.error({ err, collectionName: coll.name }, 'Collection sync failed');
      results.failed++;
    }
  }

  log.info({ branchName: branch.name, created: results.created, updated: results.updated, failed: results.failed, skipped: results.skipped }, 'syncCollections complete');
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
    log.info({ collectionName: name, setCount: setIds.length, branchName: branch.name }, 'Auto-created collection');
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

  log.info({ branchName: branch.name, created, skipped }, 'autoCreateCollections complete');
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
    log.warn({ branchName: branch.name }, 'No synced product sets for branch — skipping Collection');
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
      log.info({ collectionName, setCount: metaSetIds.length }, 'Updated branch Collection');
      return { success: true, updated: true, collectionId: branch.meta_collection_id };
    } else {
      // Create new Collection
      const created = await createCollection(branch.catalog_id, collectionName, metaSetIds, description);
      await col('branches').updateOne(
        { _id: branchId },
        { $set: { meta_collection_id: created.id, collection_updated_at: new Date() } }
      );
      log.info({ collectionName, collectionId: created.id, setCount: metaSetIds.length }, 'Created branch Collection');
      return { success: true, created: true, collectionId: created.id };
    }
  } catch (err) {
    log.error({ err, branchName: branch.name }, 'ensureBranchCollection failed');
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
      log.error({ err, branchName: branch.name }, 'syncAllBranchCollections failed for branch');
      results.failed++;
    }
  }

  log.info({ restaurantId, created: results.created, updated: results.updated, skipped: results.skipped, failed: results.failed }, 'syncAllBranchCollections complete');
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
    log.error({ err, branchId }, 'deleteBranchCollection failed');
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
  log.info({ oldCatalogId: oldId, restaurantId: branch.restaurant_id }, 'Cleared stale catalog_id — re-discovering main catalog');
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
    log.info({ businessId, catalogCount: res.data.data?.length || 0 }, 'Found business catalogs');
    return res.data.data || [];
  } catch (err) {
    log.error({ err, businessId }, 'Failed to fetch business catalogs');
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
    log.error({ err, wabaId }, 'Failed to fetch WABA catalogs');
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
      log.info({ catalogId, phoneNumberId: wa.phone_number_id }, 'Unlinked catalog from phone');
      await new Promise(r => setTimeout(r, 2000)); // wait for Meta to process
    } catch (err) {
      log.warn({ err, catalogId }, 'Unlink before delete failed');
    }
  }

  // Step 1.5: Delete all feeds attached to this catalog
  try {
    const feeds = await listFeeds(catalogId);
    for (const feed of feeds) {
      try { await deleteFeed(feed.id); } catch (feedErr) { log.warn({ err: feedErr, feedId: feed.id }, 'Pre-delete feed failed'); }
    }
    if (feeds.length) {
      log.info({ feedCount: feeds.length, catalogId }, 'Deleted feeds from catalog before deletion');
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (feedListErr) {
    log.warn({ err: feedListErr, catalogId }, 'Could not list feeds before delete');
  }

  // Step 2: Delete the catalog
  try {
    await axios.delete(`${GRAPH}/${catalogId}`, {
      params: { access_token: token }, timeout: 15000,
    });
    log.info({ catalogId }, 'Deleted catalog');
  } catch (err) {
    throw new Error(`Catalog deletion failed: ${err.response?.data?.error?.message || err.message}`);
  }

  // Step 3: Clean up DB
  await col('restaurants').updateOne(
    { _id: restaurantId },
    { $unset: { meta_catalog_id: '', meta_catalog_name: '', catalog_created_at: '', meta_feed_id: '', catalog_feed_url: '', catalog_feed_token: '' } }
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

// ─── FEED MANAGEMENT ─────────────────────────────────────
const deleteFeed = async (feedId) => {
  const token = _getCatalogToken();
  try {
    await axios.delete(`${GRAPH}/${feedId}`, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
    });
    log.info({ feedId }, 'Deleted feed');
    return { success: true };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    log.error({ err, feedId }, 'deleteFeed failed');
    throw new Error(`Feed deletion failed: ${msg}`);
  }
};

const listFeeds = async (catalogId) => {
  const token = _getCatalogToken();
  try {
    const resp = await axios.get(`${GRAPH}/${catalogId}/product_feeds`, {
      params: { access_token: token, fields: 'id,name,schedule,latest_upload{end_time,num_detected_items,num_invalid_items}', limit: 50 },
      timeout: 15000,
    });
    return resp.data?.data || [];
  } catch (err) {
    log.warn({ err, catalogId }, 'listFeeds failed');
    return [];
  }
};

// ─── CATALOG DIAGNOSTICS ─────────────────────────────────
const getCatalogDiagnostics = async (catalogId) => {
  const token = _getCatalogToken();
  try {
    const resp = await axios.get(`${GRAPH}/${catalogId}/diagnostics`, {
      params: { access_token: token, fields: 'diagnostics_type,num_items,sample_urls' },
      timeout: 15000,
    });
    return resp.data?.data || [];
  } catch (err) {
    log.warn({ err, catalogId }, 'getCatalogDiagnostics failed');
    return [];
  }
};

// ─── ATOMIC CATALOG SWITCH ───────────────────────────────
const switchCatalog = async (restaurantId, newCatalogId) => {
  const restaurant = await col('restaurants').findOne({ _id: restaurantId });
  if (!restaurant) throw new Error('Restaurant not found');
  const wa = await col('whatsapp_accounts').findOne({ restaurant_id: restaurantId, is_active: true });
  if (!wa?.waba_id) throw new Error('No WhatsApp account connected');
  const token = _getCatalogToken();

  // 1. Validate new catalog is accessible
  let newCatalogName;
  try {
    const check = await axios.get(`${GRAPH}/${newCatalogId}`, { params: { access_token: token, fields: 'id,name,product_count' }, timeout: 10000 });
    newCatalogName = check.data.name || 'Catalog';
    log.info({ newCatalogId, newCatalogName, productCount: check.data.product_count }, 'switchCatalog: validated new catalog');
  } catch (e) {
    throw new Error(`New catalog ${newCatalogId} is not accessible: ${e.response?.data?.error?.message || e.message}`);
  }

  const oldCatalogId = wa.catalog_id || restaurant.meta_catalog_id;

  // 2. Disconnect old catalog from WABA
  if (oldCatalogId) {
    try {
      await axios.delete(`${GRAPH}/${wa.waba_id}/product_catalogs`, { data: { catalog_id: oldCatalogId }, headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
      log.info({ oldCatalogId }, 'switchCatalog: disconnected old catalog from WABA');
    } catch (_) { /* may already be disconnected */ }
  }

  // 3. Connect new catalog to WABA
  try {
    await axios.post(`${GRAPH}/${wa.waba_id}/product_catalogs`, { catalog_id: newCatalogId }, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
  } catch (connErr) {
    // Rollback: try to reconnect old catalog
    if (oldCatalogId) {
      try { await axios.post(`${GRAPH}/${wa.waba_id}/product_catalogs`, { catalog_id: oldCatalogId }, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }); } catch (_) {}
    }
    throw new Error(`Failed to connect new catalog: ${connErr.response?.data?.error?.message || connErr.message}`);
  }

  // 4. Link to phone number — surface success/failure to the caller so
  // the route response can flag a partial-success to the dashboard.
  // Previously failures were only logged at warn level, so the dashboard
  // toast showed "switched" while Commerce Manager remained unlinked.
  let metaSyncOk = false;
  let metaSyncError = null;
  if (!wa.phone_number_id) {
    metaSyncError = 'WhatsApp phone number not registered yet — catalog saved in DB but Meta commerce settings not updated. Re-run after the phone number is approved.';
    console.error('[catalog-switch] phone_number_id missing on WABA — Meta sync skipped', {
      restaurantId, wabaId: wa.waba_id, newCatalogId,
    });
    log.warn({ restaurantId, wabaId: wa.waba_id }, 'switchCatalog: phone_number_id missing — Meta commerce_settings sync skipped');
  } else {
    try {
      await axios.post(
        `${GRAPH}/${wa.phone_number_id}/whatsapp_commerce_settings`,
        { catalog_id: newCatalogId, is_catalog_visible: true, is_cart_enabled: true },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
      );
      metaSyncOk = true;
    } catch (phoneErr) {
      const apiErr = phoneErr.response?.data?.error;
      metaSyncError = apiErr?.message || phoneErr.message || 'Meta commerce_settings update failed';
      console.error('[catalog-switch] whatsapp_commerce_settings failed', {
        restaurantId,
        phoneNumberId: wa.phone_number_id,
        catalogId: newCatalogId,
        error: metaSyncError,
        metaResponse: apiErr || phoneErr.response?.data || null,
      });
      log.warn({ err: phoneErr, metaResponse: apiErr }, 'switchCatalog: phone link failed (non-fatal)');
    }
  }

  // 5. Update MongoDB atomically
  await col('restaurants').updateOne({ _id: restaurantId }, { $set: { meta_catalog_id: newCatalogId, meta_catalog_name: newCatalogName, updated_at: new Date() } });
  await col('whatsapp_accounts').updateOne({ _id: wa._id }, { $set: { catalog_id: newCatalogId, catalog_linked: true, cart_enabled: true, catalog_visible: true, updated_at: new Date() } });
  await col('branches').updateMany({ restaurant_id: restaurantId }, { $set: { catalog_id: newCatalogId, updated_at: new Date() } });

  log.info({ businessName: restaurant.business_name, oldCatalogId, newCatalogId, metaSyncOk }, 'Switched restaurant catalog');
  return {
    success: true,
    oldCatalogId,
    newCatalogId,
    catalogName: newCatalogName,
    catalog_saved: true,
    meta_sync: metaSyncOk,
    ...(metaSyncError ? { meta_error: metaSyncError } : {}),
  };
};

// ─── SYNC COMPRESSED CATALOG ────────────────────────────────
// Syncs the compressed catalog layer to Meta instead of raw menu items.
// Flow: compressed SKUs → mapMenuItemToMetaProduct() → Meta batch upload
// Falls back to raw branch-by-branch sync if compression fails.
const syncCompressedCatalog = async (restaurantId) => {
  const compression = require('./catalogCompression');
  const startTime = Date.now();

  log.info({ restaurantId }, 'Starting compressed sync');

  // 1. Rebuild compression (ensures it's fresh)
  const { guard } = require('../utils/smartModule');
  const rebuildResult = await guard('CATALOG_COMPRESSION', {
    fn: () => compression.rebuildCompressedCatalog(restaurantId),
    fallbackFn: () => null, // null signals fallback below
    label: 'rebuildCompressedCatalog',
    context: { restaurantId },
  });
  if (!rebuildResult) {
    log.warn({ restaurantId }, 'Compression disabled or failed, falling back to raw sync');
    return syncRestaurantCatalog(restaurantId);
  }

  if (!rebuildResult.totalCompressedSkusCreated) {
    log.info('No compressed SKUs created — nothing to sync');
    return { success: true, compressed: true, skus: 0 };
  }

  // 2. Ensure catalog exists
  let catalogId;
  try {
    const result = await ensureMainCatalog(restaurantId);
    catalogId = result.catalogId;
  } catch (e) {
    throw new Error(`Catalog setup failed: ${e.message}`);
  }

  const restaurant = await col('restaurants').findOne({ _id: restaurantId });
  const { token } = await _getAccessToken(restaurantId);
  initSdk(token);

  // 3. Get compressed items shaped for the existing pipeline
  const compressedItems = await compression.getCompressedItemsForMetaSync(restaurantId);

  if (!compressedItems.length) {
    return { success: true, compressed: true, skus: 0 };
  }

  // 4. Get a representative branch for compliance fields (manufacturer_info)
  const branch = await col('branches').findOne({ restaurant_id: restaurantId, accepts_orders: true });
  if (!branch) {
    log.warn({ restaurantId }, 'No active branch for compliance fields');
    return { success: false, error: 'No active branch found' };
  }

  // Ensure branch has catalog_id
  if (!branch.catalog_id || branch.catalog_id !== catalogId) {
    await col('branches').updateOne({ _id: branch._id }, { $set: { catalog_id: catalogId } });
    branch.catalog_id = catalogId;
  }

  // 5. Build Meta requests using the EXISTING mapMenuItemToMetaProduct pipeline
  const requests = compressedItems.map(item => _buildItemRequest(item, restaurant, branch)).filter(Boolean);

  log.info({ skuCount: compressedItems.length, requestCount: requests.length, catalogId }, 'Compressed sync: building requests');

  // 6. Batch upload using EXISTING batch logic
  const BATCH_SIZE = 4999;
  const results = { updated: 0, failed: 0, errors: [] };

  for (let i = 0; i < requests.length; i += BATCH_SIZE) {
    const batch = requests.slice(i, i + BATCH_SIZE);
    try {
      const catalogObj = new ProductCatalog(catalogId);
      await catalogObj.createItemsBatch([], {
        allow_upsert: true,
        item_type: 'PRODUCT_ITEM',
        requests: batch,
      });
      results.updated += batch.length;
    } catch (err) {
      const errMsg = err._error?.error?.message || err.message;
      log.error({ err, catalogId }, 'Compressed batch error');
      results.failed += batch.length;
      results.errors.push(errMsg);
    }
  }

  // 7. Update sync state on compressed SKUs
  const syncedAt = new Date();
  await col('catalog_compressed_skus').updateMany(
    { restaurantId, active: true },
    { $set: { syncState: results.failed ? 'partial' : 'synced', lastSyncedAt: syncedAt, updated_at: syncedAt } }
  );
  await col('restaurants').updateOne({ _id: restaurantId }, { $set: { last_catalog_sync: syncedAt, last_compressed_sync: syncedAt } });

  const elapsed = Date.now() - startTime;
  log.info({ synced: results.updated, failed: results.failed, elapsedMs: elapsed }, 'Compressed sync complete');

  return {
    success: results.failed === 0,
    compressed: true,
    totalCompressedSkus: compressedItems.length,
    synced: results.updated,
    failed: results.failed,
    compressionRatio: rebuildResult.compressionRatio,
    elapsed,
    errors: results.errors,
  };
};

module.exports = {
  // Main catalog architecture
  ensureMainCatalog,
  ensureBranchProductSet,
  syncRestaurantCatalog,
  syncCompressedCatalog,
  deleteCatalogSafe,
  // Branch-level (uses main catalog internally)
  createBranchCatalog,
  syncBranchCatalog,
  syncAllBranches,
  addProduct,
  updateProduct,
  deleteProduct,
  bulkDeleteProducts,
  setItemAvailability,
  syncItemAvailability,
  syncBulkAvailability,
  checkSyncStatus,
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
  // Feed management
  deleteFeed,
  listFeeds,
  // Diagnostics
  getCatalogDiagnostics,
  // Lifecycle
  switchCatalog,
};
