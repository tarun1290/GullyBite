// src/services/mpmStrategy/index.js
// MPM Strategy Engine — orchestrates intelligent MPM generation.
// Uses compressed catalog as data source, applies bestseller selection,
// category-aware grouping, food/beverage split, and 30-product batching.
// Future-smart modules are dormant by default.

'use strict';

const { col } = require('../../config/database');
const memcache = require('../../config/memcache');
const { getStrategyConfig } = require('./config');
const { selectBestSellers } = require('./bestSellerSelector');
const { applyAllFuturePrioritizers } = require('./futurePrioritizers');
const { getReorderCandidates, applyAllFutureReorderModules, getReorderConfig } = require('../reorderIntelligence');

// Reuse constants and helpers from existing mpmBuilder (not duplicated)
const {
  getCategoryOrder, getCategoryEmoji, isFoodCategory, isDrinkCategory,
  selectVariantRepresentative,
} = require('../mpmBuilder');

/**
 * Build strategy-driven MPMs for a branch.
 * Uses compressed catalog if available, falls back to raw menu_items.
 *
 * @param {string} branchId
 * @param {string} restaurantId
 * @param {object} context - Optional: { customerId } for personalization
 * @returns {Promise<Array<{ header, body, footer, sections }>>}
 */
async function buildStrategyMPMs(branchId, restaurantId, context = {}) {
  const config = await getStrategyConfig();
  const restaurant = await col('restaurants').findOne({ _id: restaurantId });
  const branch = await col('branches').findOne({ _id: branchId });
  if (!restaurant || !branch) throw new Error('Restaurant or branch not found');

  // ── 1. Fetch items (compressed or raw) ──────────────────────
  let items;
  if (config.enableCompressedCatalogSource) {
    items = await _getCompressedItemsForBranch(branchId, restaurantId);
  }
  if (!items?.length) {
    items = await _getRawItemsForBranch(branchId);
  }
  if (!items?.length) return [];

  // ── 2. Apply future prioritizers (no-op when disabled) ──────
  items = await applyAllFuturePrioritizers(items, config, context);

  // ── 3. Resolve categories ───────────────────────────────────
  const catNameLookup = await _buildCategoryLookup(items);
  function getItemCategory(item) {
    if (item.product_tags?.[1]) return item.product_tags[1].trim();
    if (item.category_name) return item.category_name;
    if (item.category_id && catNameLookup[item.category_id]) return catNameLookup[item.category_id];
    return 'Menu';
  }

  // ── 4. Group items by category, collapse variants ───────────
  const categoryMap = new Map();
  for (const item of items) {
    if (!item.retailer_id) continue;
    const catName = getItemCategory(item);
    if (!categoryMap.has(catName)) categoryMap.set(catName, { items: [], variantGroups: new Map() });
    const cat = categoryMap.get(catName);
    cat.items.push(item);
    if (item.item_group_id) {
      if (!cat.variantGroups.has(item.item_group_id)) cat.variantGroups.set(item.item_group_id, []);
      cat.variantGroups.get(item.item_group_id).push(item);
    }
  }

  // ── 4b. "Your Usuals" reorder section (returning customers) ──
  const globalUsedIds = new Set();
  const reorderConfig = await getReorderConfig();

  if (reorderConfig.enableYourUsualsGroup && context.customerId) {
    try {
      let reorderCandidates = await getReorderCandidates(context.customerId, branchId, restaurantId, items);
      reorderCandidates = await applyAllFutureReorderModules(reorderCandidates, reorderConfig);

      if (reorderCandidates.length >= 2) {
        const reorderGroup = { items: reorderCandidates, variantGroups: new Map() };
        for (const item of reorderCandidates) {
          if (item.item_group_id) {
            if (!reorderGroup.variantGroups.has(item.item_group_id)) reorderGroup.variantGroups.set(item.item_group_id, []);
            reorderGroup.variantGroups.get(item.item_group_id).push(item);
          }
        }
        // Insert "Your Usuals" at the very top (before all categories and bestsellers)
        const newMap = new Map();
        newMap.set('Your Usuals', reorderGroup);
        for (const [k, v] of categoryMap) newMap.set(k, v);
        categoryMap.clear();
        for (const [k, v] of newMap) categoryMap.set(k, v);

        console.log(`[MPM-Strategy] Reorder: ${reorderCandidates.length} "Your Usuals" items for customer ${context.customerId}`);
      }
    } catch (reorderErr) {
      console.warn('[MPM-Strategy] Reorder intelligence failed (non-fatal):', reorderErr.message);
    }
  }

  // ── 5. Best-seller section ──────────────────────────────────
  if (config.enableBestSellers) {
    const bestsellers = await selectBestSellers(items, {
      branchId, restaurantId,
      maxItems: config.maxBestsellersInSection,
      config,
    });
    if (bestsellers.length >= config.minBestsellersForSection) {
      const bsGroup = { items: bestsellers, variantGroups: new Map() };
      for (const item of bestsellers) {
        if (item.item_group_id) {
          if (!bsGroup.variantGroups.has(item.item_group_id)) bsGroup.variantGroups.set(item.item_group_id, []);
          bsGroup.variantGroups.get(item.item_group_id).push(item);
        }
      }
      const newMap = new Map();
      newMap.set('Bestsellers', bsGroup);
      for (const [k, v] of categoryMap) newMap.set(k, v);
      categoryMap.clear();
      for (const [k, v] of newMap) categoryMap.set(k, v);
    }
  }

  // ── 6. Collapse variants, build sections ────────────────────
  const sections = [];
  let totalProductGroups = 0;

  const sortedCategories = [...categoryMap.entries()].sort((a, b) =>
    getCategoryOrder(a[0].toLowerCase()) - getCategoryOrder(b[0].toLowerCase())
  );

  for (const [catName, catData] of sortedCategories) {
    const seen = new Set();
    const productIds = [];
    const isBestsellersSection = catName === 'Bestsellers';

    for (const item of catData.items) {
      if (!item.retailer_id) continue;
      if (!isBestsellersSection && globalUsedIds.has(item.retailer_id)) continue;
      if (!isBestsellersSection && item.item_group_id && globalUsedIds.has('grp:' + item.item_group_id)) continue;

      if (item.item_group_id) {
        if (seen.has(item.item_group_id)) continue;
        seen.add(item.item_group_id);
        const group = catData.variantGroups.get(item.item_group_id);
        if (group?.length > 1) {
          const rep = selectVariantRepresentative(group);
          productIds.push(rep.retailer_id);
          if (isBestsellersSection) { globalUsedIds.add(rep.retailer_id); globalUsedIds.add('grp:' + item.item_group_id); }
          continue;
        }
      }
      productIds.push(item.retailer_id);
      if (isBestsellersSection) { globalUsedIds.add(item.retailer_id); if (item.item_group_id) globalUsedIds.add('grp:' + item.item_group_id); }
    }

    if (productIds.length) {
      const catLower = catName.toLowerCase();
      const emoji = getCategoryEmoji(catLower);
      const maxCatLen = 24 - emoji.length - 1;
      const truncatedCat = catName.length > maxCatLen ? catName.substring(0, maxCatLen) : catName;
      sections.push({
        title: `${emoji} ${truncatedCat}`,
        product_retailer_ids: productIds,
        _catLower: catLower,
      });
      totalProductGroups += productIds.length;
    }
  }

  if (!sections.length) return [];

  const restName = restaurant.business_name || restaurant.name || 'Menu';

  console.log(`[MPM-Strategy] Branch "${branch.name}": ${items.length} items → ${totalProductGroups} groups across ${sections.length} sections`);

  // ── 7. Build MPMs with intelligent sequencing ───────────────
  return _buildSequencedMPMs(sections, totalProductGroups, restName, branch.name, config);
}

// ─── INTERNAL: Build sequenced MPMs from sections ────────────
function _buildSequencedMPMs(sections, totalProductGroups, restName, branchName, config) {
  const MAX_ITEMS = config.maxProductsPerMPM;
  const MAX_SECTIONS = config.maxSectionsPerMPM;

  function mergeSectionsIfNeeded(secs) {
    if (secs.length <= MAX_SECTIONS) return secs;
    const sorted = [...secs].sort((a, b) => a.product_retailer_ids.length - b.product_retailer_ids.length);
    while (sorted.length > MAX_SECTIONS) {
      const a = sorted.shift();
      const b = sorted.shift();
      sorted.splice(
        sorted.findIndex(s => s.product_retailer_ids.length >= (a.product_retailer_ids.length + b.product_retailer_ids.length)) || sorted.length,
        0,
        { title: `${a.title} & more`.substring(0, 24), product_retailer_ids: [...a.product_retailer_ids, ...b.product_retailer_ids], _catLower: a._catLower }
      );
    }
    return sorted;
  }

  // Single MPM case
  if (totalProductGroups <= MAX_ITEMS) {
    return [{
      header: `🍽️ ${restName} — ${branchName}`,
      body: 'Browse items, tap for size options, and add to cart!',
      footer: 'Prices inclusive of taxes',
      sections: mergeSectionsIfNeeded(sections),
    }];
  }

  // Multi-MPM: split by food/drink if enabled
  if (!config.enableFoodBeverageSplit) {
    return _chunkIntoBatches('🍽️ Menu', sections, branchName, MAX_ITEMS, mergeSectionsIfNeeded);
  }

  const foodSections = [], drinkSections = [], otherSections = [];
  for (const s of sections) {
    if (s._catLower === 'bestsellers') foodSections.unshift(s); // bestsellers go with food
    else if (isDrinkCategory(s._catLower)) drinkSections.push(s);
    else if (isFoodCategory(s._catLower)) foodSections.push(s);
    else otherSections.push(s);
  }
  // Merge "other" into smaller group
  const fCount = foodSections.reduce((s, sec) => s + sec.product_retailer_ids.length, 0);
  const dCount = drinkSections.reduce((s, sec) => s + sec.product_retailer_ids.length, 0);
  (fCount <= dCount ? foodSections : drinkSections).push(...otherSections);

  const mpms = [];
  mpms.push(..._chunkIntoBatches('🍽️ Food Menu', foodSections, branchName, MAX_ITEMS, mergeSectionsIfNeeded));
  mpms.push(..._chunkIntoBatches('🥤 Drinks & Desserts', drinkSections, branchName, MAX_ITEMS, mergeSectionsIfNeeded));
  return mpms;
}

function _chunkIntoBatches(label, secs, branchName, maxItems, mergeFn) {
  if (!secs.length) return [];
  secs = mergeFn(secs);
  const count = secs.reduce((s, sec) => s + sec.product_retailer_ids.length, 0);
  if (count <= maxItems) {
    return [{ header: `${label} — ${branchName}`, body: 'Browse and add to cart. Your cart persists across messages!', footer: 'Prices inclusive of taxes', sections: secs }];
  }
  const mpms = [];
  let batch = [], batchItems = 0, part = 1;
  for (const sec of secs) {
    if (batchItems + sec.product_retailer_ids.length > maxItems && batch.length) {
      mpms.push({ header: `${label} (${part}) — ${branchName}`, body: 'Browse and add to cart. Your cart persists across messages!', footer: 'Prices inclusive of taxes', sections: mergeFn(batch) });
      part++; batch = []; batchItems = 0;
    }
    batch.push(sec); batchItems += sec.product_retailer_ids.length;
  }
  if (batch.length) {
    mpms.push({ header: `${label}${part > 1 ? ` (${part})` : ''} — ${branchName}`, body: 'Browse and add to cart. Your cart persists across messages!', footer: 'Prices inclusive of taxes', sections: mergeFn(batch) });
  }
  return mpms;
}

// ─── DATA FETCHERS ──────────────────────────────────────────

async function _getCompressedItemsForBranch(branchId, restaurantId) {
  const cacheKey = `strategy:compressed:${branchId}`;
  let cached = memcache.get(cacheKey);
  if (cached) return cached;

  // Get branch mappings → compressed SKU IDs
  const mappings = await col('branch_catalog_mapping').find({ restaurantId, branchId, active: true }).toArray();
  if (!mappings.length) return null; // no compressed data, will fall back to raw

  const skuIds = [...new Set(mappings.map(m => m.compressedSkuId).filter(Boolean))];
  const skus = skuIds.length
    ? await col('catalog_compressed_skus').find({ _id: { $in: skuIds }, active: true }).toArray()
    : [];

  if (!skus.length) return null;

  // Shape as menu_items-compatible (same as getCompressedItemsForMetaSync but branch-filtered)
  const items = skus.map(sku => ({
    _id: sku._id,
    restaurant_id: restaurantId,
    branch_id: branchId,
    retailer_id: sku.sourceRetailerId || `c-${(sku.normalizedName || 'item').replace(/[^a-z0-9]+/g, '-').slice(0, 30)}-${sku.skuSignature.substring(0, 12)}`,
    name: sku.displayName,
    price_paise: sku.pricePaise,
    image_url: sku.imageUrl,
    food_type: sku.foodType,
    is_available: true,
    is_bestseller: sku.isBestseller || false,
    item_group_id: sku.sourceItemGroupId || sku.masterProductId,
    size: sku.size,
    variant_type: sku.variantType,
    variant_value: sku.size,
    product_tags: sku.productTags || [],
    category_name: sku.category,
    sort_order: 0,
  }));

  memcache.set(cacheKey, items, 120); // 2 min cache
  return items;
}

async function _getRawItemsForBranch(branchId) {
  const cacheKey = `branch:${branchId}:menu`;
  let cached = memcache.get(cacheKey);
  if (cached) return cached;

  const items = await col('menu_items').find({ branch_id: branchId, is_available: true })
    .sort({ sort_order: 1, name: 1 }).toArray();
  if (items.length) memcache.set(cacheKey, items, 120);
  return items;
}

async function _buildCategoryLookup(items) {
  const catIds = [...new Set(items.filter(i => i.category_id).map(i => i.category_id))];
  const lookup = {};
  if (catIds.length) {
    const cats = await col('menu_categories').find({ _id: { $in: catIds } }).toArray();
    cats.forEach(c => { lookup[c._id] = c.name; });
  }
  return lookup;
}

// ─── PREVIEW / DEBUG ────────────────────────────────────────

async function getMPMPreview(branchId, restaurantId) {
  const mpms = await buildStrategyMPMs(branchId, restaurantId);
  return {
    mpmCount: mpms.length,
    mpms: mpms.map((m, idx) => ({
      index: idx + 1,
      header: m.header,
      sectionCount: m.sections.length,
      sections: m.sections.map(s => ({ title: s.title, itemCount: s.product_retailer_ids.length })),
      totalItems: m.sections.reduce((sum, s) => sum + s.product_retailer_ids.length, 0),
    })),
    config: await getStrategyConfig(),
  };
}

module.exports = { buildStrategyMPMs, getMPMPreview };
