// src/services/mpmBuilder.js
// Builds Multi-Product Messages (MPMs) for a branch's menu.
// One catalog per restaurant, bot filters by branch via retailer_id.
// Variants (same item_group_id) count as ONE product slot in the MPM.
// Max 30 product groups per MPM, max 10 sections per MPM.
// Large menus get split into multiple MPMs — cart persists across them.

const { col } = require('../config/database');
const memcache = require('../config/memcache');
const log = require('../utils/logger').child({ component: 'MPMBuilder' });

// ── Category sort order (lower = appears first in menu) ──────
const CATEGORY_ORDER = [
  'your usuals', 'reorder picks',
  'bestsellers', 'popular', 'recommended',
  'starters', 'appetizer', 'appetizers', 'snacks', 'snack',
  'momos', 'dumplings',
  'soups', 'soup', 'salads', 'salad',
  'main course', 'mains', 'curries', 'curry', 'gravies', 'gravy',
  'breads', 'bread', 'rotis', 'roti', 'naan',
  'rice', 'biryani', 'pulao',
  'combos', 'combo', 'thali', 'thalis', 'meals', 'meal',
  'chinese', 'indo-chinese',
  'pizza', 'burger', 'burgers', 'noodles', 'noodle',
  'wraps', 'wrap', 'sandwich', 'sandwiches',
  'beverages', 'beverage', 'drinks', 'drink', 'chai', 'tea', 'coffee',
  'juices', 'juice', 'smoothies', 'smoothie', 'shakes', 'shake', 'milkshake', 'milkshakes',
  'mocktails', 'mocktail',
  'desserts', 'dessert', 'sweets', 'sweet', 'ice cream',
];

// ── Food vs Drink category classification ────────────────────
const FOOD_CATS = new Set([
  'your usuals', 'reorder picks',
  'bestsellers', 'popular', 'recommended',
  'starters', 'appetizer', 'appetizers', 'snacks', 'snack',
  'momos', 'dumplings', 'soups', 'soup', 'salads', 'salad',
  'main course', 'mains', 'curries', 'curry', 'gravies', 'gravy',
  'breads', 'bread', 'rotis', 'roti', 'naan',
  'rice', 'biryani', 'pulao',
  'combos', 'combo', 'thali', 'thalis', 'meals', 'meal',
  'chinese', 'indo-chinese',
  'pizza', 'burger', 'burgers', 'noodles', 'noodle',
  'wraps', 'wrap', 'sandwich', 'sandwiches',
]);

const DRINK_CATS = new Set([
  'beverages', 'beverage', 'drinks', 'drink', 'chai', 'tea', 'coffee',
  'juices', 'juice', 'smoothies', 'smoothie', 'shakes', 'shake',
  'milkshake', 'milkshakes', 'mocktails', 'mocktail',
  'desserts', 'dessert', 'sweets', 'sweet', 'ice cream',
]);

// ── Category emoji mapping ───────────────────────────────────
const CATEGORY_EMOJI = {
  'your usuals': '⭐', 'reorder picks': '⭐',
  bestsellers: '🔥', popular: '🔥', recommended: '🔥',
  starters: '🥟', appetizer: '🥟', appetizers: '🥟', snacks: '🍿', snack: '🍿',
  momos: '🥟', dumplings: '🥟',
  soups: '🍲', soup: '🍲', salads: '🥗', salad: '🥗',
  'main course': '🍛', mains: '🍛', curries: '🍛', curry: '🍛', gravies: '🍛', gravy: '🍛',
  breads: '🍞', bread: '🍞', rotis: '🍞', roti: '🍞', naan: '🍞',
  rice: '🍚', biryani: '🍚', pulao: '🍚',
  combos: '🍱', combo: '🍱', thali: '🍽️', thalis: '🍽️', meals: '🍱', meal: '🍱',
  chinese: '🥡', 'indo-chinese': '🥡',
  pizza: '🍕', burger: '🍔', burgers: '🍔', noodles: '🍜', noodle: '🍜',
  wraps: '🌯', wrap: '🌯', sandwich: '🥪', sandwiches: '🥪',
  beverages: '☕', beverage: '☕', drinks: '🥤', drink: '🥤',
  chai: '☕', tea: '☕', coffee: '☕',
  juices: '🧃', juice: '🧃', smoothies: '🥤', smoothie: '🥤',
  shakes: '🥤', shake: '🥤', milkshake: '🥤', milkshakes: '🥤',
  mocktails: '🍹', mocktail: '🍹',
  desserts: '🍰', dessert: '🍰', sweets: '🍬', sweet: '🍬', 'ice cream': '🍨',
};

function getCategoryOrder(catNameLower) {
  const idx = CATEGORY_ORDER.indexOf(catNameLower);
  return idx >= 0 ? idx : 999;
}

function getCategoryEmoji(catNameLower) {
  return CATEGORY_EMOJI[catNameLower] || '🍴';
}

function isFoodCategory(catNameLower) {
  if (FOOD_CATS.has(catNameLower)) return true;
  for (const fc of FOOD_CATS) {
    if (catNameLower.includes(fc) || fc.includes(catNameLower)) return true;
  }
  return false;
}

function isDrinkCategory(catNameLower) {
  if (DRINK_CATS.has(catNameLower)) return true;
  for (const dc of DRINK_CATS) {
    if (catNameLower.includes(dc) || dc.includes(catNameLower)) return true;
  }
  return false;
}

/**
 * Select the variant representative — cheapest item in the group.
 * Only this retailer_id goes into the MPM. Meta shows all variants when tapped.
 */
function selectVariantRepresentative(variantItems) {
  const sorted = [...variantItems].sort((a, b) => (a.price_paise || 0) - (b.price_paise || 0));
  return sorted[0];
}

/**
 * Build MPM message(s) for a branch.
 * Returns an array of MPM payloads ready for wa.sendMPM().
 *
 * @param {string} branchId
 * @param {string} restaurantId
 * @returns {Promise<Array<{ header, body, footer, sections }>>}
 */
async function buildBranchMPMs(branchId, restaurantId) {
  const restaurant = await col('restaurants').findOne({ _id: restaurantId });
  const branch = await col('branches').findOne({ _id: branchId });
  if (!restaurant || !branch) throw new Error('Restaurant or branch not found');

  if (branch.meta_collection_id) {
    log.info({ branchName: branch.name, collectionId: branch.meta_collection_id }, 'Branch has Collection');
  }

  // Get all available items for this branch (cached 2 min)
  const cacheKey = `branch:${branchId}:menu`;
  let items = memcache.get(cacheKey);
  if (!items) {
    items = await col('menu_items').find({
      $or: [{ branch_id: branchId }, { branch_ids: branchId }],
      is_available: true,
    }).sort({ sort_order: 1, name: 1 }).toArray();
    if (items.length) memcache.set(cacheKey, items, 120);
  }

  if (!items.length) return [];

  // Debug: dump every fetched item with the branch field that matched.
  // The reader-side `$or` ({ branch_id } OR { branch_ids: branchId })
  // is the hot path that's caught a few cross-branch leaks before, so
  // log per-item which side won so a stray scalar→array drift shows up
  // immediately in the logs.
  log.info({
    branchId,
    branchName: branch.name,
    itemCount: items.length,
    items: items.map((it) => ({
      _id: it._id,
      name: it.name,
      matched: it.branch_id === branchId
        ? 'branch_id'
        : (Array.isArray(it.branch_ids) && it.branch_ids.includes(branchId))
          ? 'branch_ids'
          : 'unknown',
    })),
  }, 'mpmBuilder: branch products fetched');

  // Resolve category names from category_ids
  const catIds = [...new Set(items.filter(i => i.category_id).map(i => i.category_id))];
  const catNameLookup = {};
  if (catIds.length) {
    const cats = await col('menu_categories').find({ _id: { $in: catIds } }).toArray();
    cats.forEach(c => { catNameLookup[c._id] = c.name; });
  }

  // Determine category for each item
  function getItemCategory(item) {
    if (item.product_tags?.[1]) return item.product_tags[1].trim();
    if (item.category_id && catNameLookup[item.category_id]) return catNameLookup[item.category_id];
    return 'Menu';
  }

  // Group items by category, then collapse variants
  const categoryMap = new Map(); // categoryName → { items: [], productGroups: [] }

  // First pass: group all items by category
  for (const item of items) {
    if (!item.retailer_id) continue;
    const catName = getItemCategory(item);
    if (!categoryMap.has(catName)) categoryMap.set(catName, { items: [], variantGroups: new Map() });
    const cat = categoryMap.get(catName);
    cat.items.push(item);

    // Track variant groups
    if (item.item_group_id) {
      if (!cat.variantGroups.has(item.item_group_id)) cat.variantGroups.set(item.item_group_id, []);
      cat.variantGroups.get(item.item_group_id).push(item);
    }
  }

  // Separate bestsellers into their own category
  const bestsellers = items.filter(i => i.is_bestseller && i.retailer_id);
  const bestsellerIds = new Set();
  if (bestsellers.length >= 2) {
    // Only create Bestsellers section if there are at least 2
    const bsGroup = { items: bestsellers, variantGroups: new Map() };
    for (const item of bestsellers) {
      bestsellerIds.add(item.retailer_id);
      if (item.item_group_id) {
        if (!bsGroup.variantGroups.has(item.item_group_id)) bsGroup.variantGroups.set(item.item_group_id, []);
        bsGroup.variantGroups.get(item.item_group_id).push(item);
      }
    }
    // Insert at beginning
    const newMap = new Map();
    newMap.set('Bestsellers', bsGroup);
    for (const [k, v] of categoryMap) newMap.set(k, v);
    categoryMap.clear();
    for (const [k, v] of newMap) categoryMap.set(k, v);
  }

  // Second pass: collapse variants, pick representative per group
  // Track retailer_ids already used in Bestsellers to avoid double-counting
  const globalUsedIds = new Set();
  const sections = [];
  let totalProductGroups = 0;

  // Sort categories by defined order
  const sortedCategories = [...categoryMap.entries()].sort((a, b) => {
    return getCategoryOrder(a[0].toLowerCase()) - getCategoryOrder(b[0].toLowerCase());
  });

  for (const [catName, catData] of sortedCategories) {
    const seen = new Set(); // item_group_ids already included in THIS category
    const productIds = [];
    const isBestsellersSection = catName === 'Bestsellers';

    for (const item of catData.items) {
      if (!item.retailer_id) continue;

      // Skip items already in Bestsellers section (prevents double-counting)
      if (!isBestsellersSection && globalUsedIds.has(item.retailer_id)) continue;
      if (!isBestsellersSection && item.item_group_id && globalUsedIds.has('grp:' + item.item_group_id)) continue;

      if (item.item_group_id) {
        if (seen.has(item.item_group_id)) continue;
        seen.add(item.item_group_id);

        // Pick cheapest variant as representative
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
      // Pre-truncate: emoji (1-2 chars) + space + catName must fit 24 chars
      const maxCatLen = 24 - emoji.length - 1; // 1 for the space
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

  log.info({ branchName: branch.name, totalItems: items.length, productGroups: totalProductGroups, sections: sections.length, deduped: globalUsedIds.size }, 'MPM sections built');

  const restName = restaurant.business_name || restaurant.name || 'Menu';

  // Merge small sections if >10 to fit MPM limit
  function mergeSectionsIfNeeded(secs) {
    if (secs.length <= 10) return secs;
    // Sort by size ascending, merge smallest pairs
    const sorted = [...secs].sort((a, b) => a.product_retailer_ids.length - b.product_retailer_ids.length);
    while (sorted.length > 10) {
      const a = sorted.shift();
      const b = sorted.shift();
      const mergedTitle = `${a.title} & more`.substring(0, 24);
      const merged = {
        title: mergedTitle,
        product_retailer_ids: [...a.product_retailer_ids, ...b.product_retailer_ids],
        _catLower: a._catLower,
      };
      // Insert back sorted by size
      const idx = sorted.findIndex(s => s.product_retailer_ids.length >= merged.product_retailer_ids.length);
      sorted.splice(idx >= 0 ? idx : sorted.length, 0, merged);
    }
    return sorted;
  }

  // ── Single MPM case ────────────────────────────────────────
  if (totalProductGroups <= 30) {
    return [{
      header: `🍽️ ${restName} — ${branch.name}`,
      body: 'Browse items, tap for size options, and add to cart!',
      footer: 'Prices inclusive of taxes',
      sections: mergeSectionsIfNeeded(sections),
    }];
  }

  // ── Multiple MPMs — split by food vs drink ─────────────────
  const foodSections = [];
  const drinkSections = [];
  const otherSections = [];

  for (const section of sections) {
    if (isDrinkCategory(section._catLower)) {
      drinkSections.push(section);
    } else if (isFoodCategory(section._catLower)) {
      foodSections.push(section);
    } else {
      otherSections.push(section);
    }
  }

  // Merge "other" into whichever group has fewer items
  const foodCount = foodSections.reduce((s, sec) => s + sec.product_retailer_ids.length, 0);
  const drinkCount = drinkSections.reduce((s, sec) => s + sec.product_retailer_ids.length, 0);
  if (foodCount <= drinkCount) {
    foodSections.push(...otherSections);
  } else {
    drinkSections.push(...otherSections);
  }

  const mpms = [];

  // Build MPMs from section buckets, respecting 30 items + 10 sections limits
  function buildMPMsFromBucket(label, secs) {
    if (!secs.length) return;

    // FIRST: merge sections to respect 10-section limit
    secs = mergeSectionsIfNeeded(secs);
    const count = secs.reduce((s, sec) => s + sec.product_retailer_ids.length, 0);
    log.info({ label, sections: secs.length, products: count }, 'Building MPMs from bucket');

    if (count <= 30) {
      // Single MPM — sections already merged to ≤10
      mpms.push({
        header: `${label} — ${branch.name}`,
        body: 'Browse and add to cart. Your cart persists across messages!',
        footer: 'Prices inclusive of taxes',
        sections: secs,
      });
      log.info({ label, mpmCount: 1 }, 'Single MPM built from bucket');
      return;
    }

    // Need multiple MPMs — batch by item count (≤30 items per MPM)
    let batch = [];
    let batchItems = 0;
    let part = 1;

    for (const sec of secs) {
      if (batchItems + sec.product_retailer_ids.length > 30 && batch.length) {
        mpms.push({
          header: `${label} (${part}) — ${branch.name}`,
          body: 'Browse and add to cart. Your cart persists across messages!',
          footer: 'Prices inclusive of taxes',
          sections: mergeSectionsIfNeeded(batch),
        });
        part++;
        batch = [];
        batchItems = 0;
      }
      batch.push(sec);
      batchItems += sec.product_retailer_ids.length;
    }

    if (batch.length) {
      mpms.push({
        header: `${label}${part > 1 ? ` (${part})` : ''} — ${branch.name}`,
        body: 'Browse and add to cart. Your cart persists across messages!',
        footer: 'Prices inclusive of taxes',
        sections: mergeSectionsIfNeeded(batch),
      });
    }
    log.info({ label, mpmCount: part }, 'MPMs built from bucket');
  }

  buildMPMsFromBucket('🍽️ Food Menu', foodSections);
  buildMPMsFromBucket('🥤 Drinks & Desserts', drinkSections);

  return mpms;
}

module.exports = {
  buildBranchMPMs,
  // Exported for reuse by mpmStrategy engine (do not remove)
  getCategoryOrder, getCategoryEmoji, isFoodCategory, isDrinkCategory,
  selectVariantRepresentative,
};
