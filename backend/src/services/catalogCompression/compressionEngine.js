// src/services/catalogCompression/compressionEngine.js
// Catalog Compression Engine — compresses raw multi-branch menu items into
// a minimal set of Meta-publishable SKUs.
//
// Architecture:
//   RAW menu_items → compression engine → compressed collections → existing mapMenuItemToMetaProduct() → Meta API
//
// The compressed layer does NOT replace raw menu data. The restaurant dashboard
// continues to read from menu_items. The compressed layer is infrastructure
// for catalog sync only.

'use strict';

const { col, newId } = require('../../config/database');
const { generateSkuSignature, generateMasterProductSignature, normalizeName, normalizeFoodType, normalizeCategory } = require('./skuSignature');
const log = require('../../utils/logger').child({ component: 'Compression' });

// ─── FULL REBUILD ───────────────────────────────────────────
/**
 * Full compression rebuild for a restaurant.
 * Reads ALL raw menu items across ALL branches, groups them, generates compressed SKUs.
 * Idempotent — can be re-run safely.
 *
 * @param {string} restaurantId
 * @param {object} opts - { includeMedia: false, dryRun: false }
 * @returns {object} - Run summary
 */
async function rebuildCompressedCatalog(restaurantId, opts = {}) {
  const startedAt = new Date();
  const { includeMedia = false, dryRun = false } = opts;

  log.info({ restaurantId, dryRun }, 'Starting full rebuild');

  // 1. Load all raw menu items for this restaurant
  const rawItems = await col('menu_items').find({
    restaurant_id: restaurantId,
    is_available: true,
  }).toArray();

  if (!rawItems.length) {
    log.info({ restaurantId }, 'No available menu items found');
    return _buildRunSummary(restaurantId, 'full_rebuild', startedAt, 0, 0, 0, []);
  }

  // 2. Group raw items by master product signature (name + food_type + category)
  const masterGroups = new Map(); // masterSig → { displayName, items: [] }

  for (const item of rawItems) {
    const masterSig = generateMasterProductSignature(item);
    if (!masterGroups.has(masterSig)) {
      masterGroups.set(masterSig, {
        normalizedName: normalizeName(item.name),
        displayName: item.name, // use first occurrence as display name
        baseCategory: normalizeCategory(item),
        foodType: normalizeFoodType(item.food_type),
        items: [],
      });
    }
    masterGroups.get(masterSig).items.push(item);
  }

  // 3. For each master group, generate compressed SKUs
  //    Items with same skuSignature share a compressed SKU.
  //    Items with different prices/sizes get separate compressed SKUs.
  const skuMap = new Map(); // skuSignature → { skuData, rawItemIds, branchIds }
  const branchMappings = []; // { rawMenuItemId, compressedSkuId, branchId, ... }
  let totalReused = 0;
  let totalCreated = 0;

  for (const [masterSig, group] of masterGroups) {
    for (const item of group.items) {
      const skuSig = generateSkuSignature(item, { includeMedia });
      const branchId = item.branch_id;

      if (skuMap.has(skuSig)) {
        // Reuse existing compressed SKU
        const existing = skuMap.get(skuSig);
        existing.rawItemIds.add(String(item._id));
        existing.branchIds.add(branchId);
        // Fix 3: OR bestseller across all source items
        if (item.is_bestseller) existing.isBestseller = true;
        totalReused++;
      } else {
        // Create new compressed SKU
        skuMap.set(skuSig, {
          masterSig,
          skuSignature: skuSig,
          displayName: item.name,
          normalizedName: normalizeName(item.name),
          pricePaise: item.price_paise,
          currency: 'INR',
          foodType: normalizeFoodType(item.food_type),
          category: normalizeCategory(item),
          imageUrl: item.image_url || null,
          size: item.size || item.variant_value || null,
          variantType: item.variant_type || null,
          variantSignature: (item.size || item.variant_value || '') + '|' + (item.variant_type || ''),
          productTags: item.product_tags || [],
          isBestseller: !!item.is_bestseller,
          // Fix 1: Preserve original retailer_id from first source item (Meta-compatible)
          sourceRetailerId: item.retailer_id || null,
          // Fix 2: Preserve original item_group_id from first source item (Meta variant grouping)
          sourceItemGroupId: item.item_group_id || null,
          // Keep reference fields for mapMenuItemToMetaProduct compatibility
          _templateItem: _buildTemplateItem(item),
          rawItemIds: new Set([String(item._id)]),
          branchIds: new Set([branchId]),
        });
        totalCreated++;
      }

      // Always record branch mapping
      branchMappings.push({
        restaurantId,
        branchId,
        rawMenuItemId: String(item._id),
        skuSignature: skuSig,
        sourcePrice: item.price_paise,
        sourceVariantSignature: (item.size || '') + '|' + (item.variant_type || ''),
        sourceSellableSignature: normalizeName(item.name) + '|' + item.price_paise,
      });
    }
  }

  if (dryRun) {
    return _buildRunSummary(restaurantId, 'full_rebuild_dry', startedAt, rawItems.length, totalCreated, totalReused, [], masterGroups, skuMap);
  }

  // 4. Write to MongoDB — generation-based: write new data first, then clean old
  //    This is crash-safe: if we fail mid-write, old generation data is still valid.
  const errors = [];
  const generationId = newId(); // unique generation marker

  try {
    // 4a. Write master products (new generation)
    const masterDocs = [];
    for (const [masterSig, group] of masterGroups) {
      const rawItemIds = group.items.map(i => String(i._id));
      masterDocs.push({
        _id: newId(),
        restaurantId,
        masterSignature: masterSig,
        normalizedName: group.normalizedName,
        displayName: group.displayName,
        baseCategory: group.baseCategory,
        foodType: group.foodType,
        createdFromRawItemIds: rawItemIds,
        variantCount: new Set(group.items.map(i => generateSkuSignature(i, { includeMedia }))).size,
        _generation: generationId,
        created_at: startedAt,
        updated_at: startedAt,
      });
    }
    if (masterDocs.length) {
      await col('catalog_master_products').insertMany(masterDocs);
    }

    // Build masterSig → masterId lookup
    const masterIdMap = {};
    for (const d of masterDocs) masterIdMap[d.masterSignature] = d._id;

    // 4b. Write compressed SKUs
    const skuDocs = [];
    const skuIdMap = {}; // skuSignature → _id

    for (const [skuSig, sku] of skuMap) {
      const skuId = newId();
      skuIdMap[skuSig] = skuId;

      skuDocs.push({
        _id: skuId,
        restaurantId,
        masterProductId: masterIdMap[sku.masterSig] || null,
        skuSignature: skuSig,
        displayName: sku.displayName,
        normalizedName: sku.normalizedName,
        pricePaise: sku.pricePaise,
        currency: sku.currency,
        foodType: sku.foodType,
        category: sku.category,
        imageUrl: sku.imageUrl,
        size: sku.size,
        variantType: sku.variantType,
        variantSignature: sku.variantSignature,
        productTags: sku.productTags,
        isBestseller: sku.isBestseller || false,
        // Fix 1: preserve original retailer_id for Meta compatibility
        sourceRetailerId: sku.sourceRetailerId || null,
        // Fix 2: preserve original item_group_id for Meta variant grouping
        sourceItemGroupId: sku.sourceItemGroupId || null,
        // Meta sync state
        metaCatalogStatus: 'pending',
        metaProductId: null,
        syncState: 'pending',
        approvalState: null,
        // Source tracking
        createdFromRawItemIds: [...sku.rawItemIds],
        createdFromBranchIds: [...sku.branchIds],
        branchCount: sku.branchIds.size,
        active: true,
        _generation: generationId,
        created_at: startedAt,
        updated_at: startedAt,
      });
    }
    if (skuDocs.length) {
      await col('catalog_compressed_skus').insertMany(skuDocs);
    }

    // 4c. Write variant records (group SKUs by master product)
    const variantDocs = [];
    const masterVariants = new Map(); // masterSig → [skuDocs]
    for (const skuDoc of skuDocs) {
      const masterSig = [...skuMap.entries()].find(([sig]) => sig === skuDoc.skuSignature)?.[1]?.masterSig;
      if (!masterSig) continue;
      if (!masterVariants.has(masterSig)) masterVariants.set(masterSig, []);
      masterVariants.get(masterSig).push(skuDoc);
    }

    for (const [masterSig, skus] of masterVariants) {
      if (skus.length <= 1) continue; // No variants to record
      const groupName = skus[0].variantType || 'size';
      for (const [idx, sku] of skus.entries()) {
        variantDocs.push({
          _id: newId(),
          restaurantId,
          compressedSkuId: sku._id,
          masterProductId: sku.masterProductId,
          variantGroupName: groupName,
          variantValue: sku.size || sku.displayName,
          variantSignature: sku.variantSignature,
          sortOrder: idx,
          _generation: generationId,
          created_at: startedAt,
          updated_at: startedAt,
        });
      }
    }
    if (variantDocs.length) {
      await col('catalog_compressed_sku_variants').insertMany(variantDocs);
    }

    // 4d. Write branch mappings (new generation)
    const mappingDocs = branchMappings.map(m => ({
      _id: newId(),
      restaurantId: m.restaurantId,
      branchId: m.branchId,
      rawMenuItemId: m.rawMenuItemId,
      compressedSkuId: skuIdMap[m.skuSignature] || null,
      active: true,
      sourcePrice: m.sourcePrice,
      sourceVariantSignature: m.sourceVariantSignature,
      sourceSellableSignature: m.sourceSellableSignature,
      _generation: generationId,
      created_at: startedAt,
      updated_at: startedAt,
    }));
    if (mappingDocs.length) {
      await col('branch_catalog_mapping').insertMany(mappingDocs);
    }

    // 4e. Fix 4: Crash-safe cleanup — delete OLD generation data only after new data is written
    await col('catalog_master_products').deleteMany({ restaurantId, _generation: { $ne: generationId } });
    await col('catalog_compressed_skus').deleteMany({ restaurantId, _generation: { $ne: generationId } });
    await col('catalog_compressed_sku_variants').deleteMany({ restaurantId, _generation: { $ne: generationId } });
    await col('branch_catalog_mapping').deleteMany({ restaurantId, _generation: { $ne: generationId } });

  } catch (e) {
    errors.push(`Write error: ${e.message}`);
    log.error({ err: e }, 'Write error');
  }

  // 5. Record the run
  const summary = _buildRunSummary(restaurantId, 'full_rebuild', startedAt, rawItems.length, totalCreated, totalReused, errors, masterGroups, skuMap);

  try {
    await col('catalog_compression_runs').insertOne({
      _id: newId(),
      ...summary,
      completedAt: new Date(),
    });
  } catch (e) {
    log.warn({ err: e }, 'Failed to record run');
  }

  log.info({ rawItems: rawItems.length, compressed: totalCreated, reused: totalReused }, 'Rebuild complete');
  return summary;
}

// ─── QUERY HELPERS ──────────────────────────────────────────

/**
 * Get compression summary for a restaurant.
 */
async function getCompressionSummary(restaurantId) {
  const [rawCount, skuCount, mappingCount, masterCount] = await Promise.all([
    col('menu_items').countDocuments({ restaurant_id: restaurantId, is_available: true }),
    col('catalog_compressed_skus').countDocuments({ restaurantId, active: true }),
    col('branch_catalog_mapping').countDocuments({ restaurantId, active: true }),
    col('catalog_master_products').countDocuments({ restaurantId }),
  ]);

  const branchStats = await col('branch_catalog_mapping').aggregate([
    { $match: { restaurantId, active: true } },
    { $group: { _id: '$branchId', count: { $sum: 1 } } },
  ]).toArray();

  const multibranchSkus = await col('catalog_compressed_skus').countDocuments({
    restaurantId, active: true, branchCount: { $gt: 1 },
  });

  return {
    totalRawItems: rawCount,
    totalCompressedSkus: skuCount,
    totalMasterProducts: masterCount,
    totalBranchMappings: mappingCount,
    compressionRatio: rawCount > 0 ? Math.round((1 - skuCount / rawCount) * 1000) / 10 : 0,
    multibranchSkus,
    branchStats: branchStats.map(b => ({ branchId: b._id, mappedItems: b.count })),
  };
}

/**
 * Get branch-level compressed mapping preview.
 */
async function getBranchMappingPreview(restaurantId, branchId) {
  const mappings = await col('branch_catalog_mapping').find({
    restaurantId, branchId, active: true,
  }).toArray();

  const skuIds = [...new Set(mappings.map(m => m.compressedSkuId).filter(Boolean))];
  const skus = skuIds.length
    ? await col('catalog_compressed_skus').find({ _id: { $in: skuIds } }).toArray()
    : [];
  const skuMap = Object.fromEntries(skus.map(s => [String(s._id), s]));

  const rawIds = mappings.map(m => m.rawMenuItemId);
  const rawItems = rawIds.length
    ? await col('menu_items').find({ _id: { $in: rawIds } }).toArray()
    : [];
  const rawMap = Object.fromEntries(rawItems.map(r => [String(r._id), r]));

  return mappings.map(m => ({
    rawMenuItemId: m.rawMenuItemId,
    rawItemName: rawMap[m.rawMenuItemId]?.name || 'Unknown',
    rawItemPrice: rawMap[m.rawMenuItemId]?.price_paise || 0,
    compressedSkuId: m.compressedSkuId,
    compressedSkuName: skuMap[m.compressedSkuId]?.displayName || 'Unknown',
    compressedSkuPrice: skuMap[m.compressedSkuId]?.pricePaise || 0,
    isReused: (skuMap[m.compressedSkuId]?.branchCount || 0) > 1,
  }));
}

/**
 * Get compressed SKUs for a restaurant, shaped for the existing mapMenuItemToMetaProduct().
 * This is the key bridge function — it produces objects that the existing
 * Meta sync pipeline can consume without modification.
 */
async function getCompressedItemsForMetaSync(restaurantId) {
  const skus = await col('catalog_compressed_skus').find({
    restaurantId, active: true,
  }).toArray();

  // Shape each compressed SKU as a menu_items-compatible document
  // so mapMenuItemToMetaProduct() can process it unchanged.
  //
  // Fix 1: Use sourceRetailerId (original branch-encoded ID) so Meta updates
  //         existing products instead of creating orphan duplicates.
  // Fix 2: Use sourceItemGroupId (original branch-encoded group ID) so Meta
  //         variant grouping stays consistent with existing catalog items.
  // Fix 3: Carry isBestseller from source items so MPM bestseller section works.
  return skus.map(sku => ({
    _id: sku._id,
    restaurant_id: restaurantId,
    branch_id: sku.createdFromBranchIds[0] || null,
    retailer_id: sku.sourceRetailerId || _generateCompressedRetailerId(sku),
    name: sku.displayName,
    description: sku.displayName,
    price_paise: sku.pricePaise,
    image_url: sku.imageUrl,
    food_type: sku.foodType,
    is_available: true,
    is_bestseller: sku.isBestseller || false,
    item_group_id: sku.sourceItemGroupId || sku.masterProductId,
    size: sku.size,
    variant_type: sku.variantType,
    variant_value: sku.size,
    product_tags: sku.productTags,
    category_name: sku.category,
    sale_price_paise: null,
    brand: null,
    google_product_category: 'Food, Beverages & Tobacco > Food Items',
    fb_product_category: 'Food & Beverages > Prepared Food',
  }));
}

// ─── INTERNAL HELPERS ───────────────────────────────────────

/**
 * Build a template item that preserves fields needed by mapMenuItemToMetaProduct().
 * This is a snapshot of the raw item's catalog-relevant fields.
 */
function _buildTemplateItem(item) {
  return {
    name: item.name,
    price_paise: item.price_paise,
    food_type: item.food_type,
    image_url: item.image_url,
    size: item.size,
    variant_type: item.variant_type,
    variant_value: item.variant_value,
    product_tags: item.product_tags,
    category_name: item.category_name,
    item_group_id: item.item_group_id,
  };
}

/**
 * Generate a retailer_id for a compressed SKU.
 * Uses a stable "c-" prefix to distinguish from branch-specific IDs.
 */
function _generateCompressedRetailerId(sku) {
  // Use first 12 chars of signature for uniqueness, prefixed with "c-"
  const shortSig = sku.skuSignature.substring(0, 12);
  const nameSlug = (sku.normalizedName || 'item').replace(/[^a-z0-9]+/g, '-').slice(0, 30);
  return `c-${nameSlug}-${shortSig}`;
}

function _buildRunSummary(restaurantId, runType, startedAt, totalRaw, totalCreated, totalReused, errors, masterGroups, skuMap) {
  return {
    restaurantId,
    runType,
    startedAt,
    completedAt: new Date(),
    totalRawItemsProcessed: totalRaw,
    totalMasterProducts: masterGroups?.size || 0,
    totalCompressedSkusCreated: totalCreated,
    totalCompressedSkusReused: totalReused,
    compressionRatio: totalRaw > 0 ? Math.round((1 - totalCreated / totalRaw) * 1000) / 10 : 0,
    errors,
  };
}

module.exports = {
  rebuildCompressedCatalog,
  getCompressionSummary,
  getBranchMappingPreview,
  getCompressedItemsForMetaSync,
};
