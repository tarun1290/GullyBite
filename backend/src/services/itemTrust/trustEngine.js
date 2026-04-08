// src/services/itemTrust/trustEngine.js
// Item Trust Calculation Engine — computes trust metrics, tags, and descriptions
// for menu items based on order history, ratings, and reorder behavior.
// Runs as a scheduled job (every 6-12 hours). Does NOT recalculate on every feedback.

'use strict';

const { col, newId } = require('../../config/database');
const log = require('../../utils/logger').child({ component: 'Trust' });

// ─── TRUST TAG PRIORITY RULES ───────────────────────────────
const TRUST_RULES = [
  { tag: 'Best Seller',    check: (m, allItems) => m.fulfilled_order_count >= (allItems._p90OrderCount || 50) },
  { tag: 'Most Loved',     check: (m) => m.average_rating >= 4.5 && m.rating_count >= 10 && m.issue_rate < 0.1 },
  { tag: 'Most Reordered', check: (m) => m.reorder_rate >= 0.35 && m.fulfilled_order_count >= 20 },
  { tag: 'Trending',       check: (m) => m.last_30_day_order_count > 0 && m.prev_30_day_order_count > 0 && m.last_30_day_order_count >= m.prev_30_day_order_count * 1.3 },
  { tag: 'Popular Pick',   check: (m) => m.fulfilled_order_count >= 15 && !m.public_rating_enabled },
  { tag: 'New Item',       check: (m) => m._isNew && m.fulfilled_order_count < 15 },
];

// ─── CALCULATE TRUST METRICS FOR ONE ITEM ───────────────────
async function calculateItemTrustMetrics(itemId, restaurantId) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 86400000);
  const twentyOneDaysAgo = new Date(now.getTime() - 21 * 86400000);

  const item = await col('menu_items').findOne({ _id: itemId });
  if (!item) return null;

  // Get all order_items for this menu item (by item name match across branches)
  const itemName = (item.name || '').toLowerCase().trim();
  const orderItems = await col('order_items').aggregate([
    { $match: { item_name: { $regex: new RegExp(`^${itemName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } } },
    { $lookup: { from: 'orders', localField: 'order_id', foreignField: '_id', as: 'order' } },
    { $unwind: '$order' },
    { $match: { 'order.restaurant_id': restaurantId, 'order.status': { $nin: ['CANCELLED', 'PAYMENT_FAILED'] } } },
  ]).toArray();

  const fulfilledOrders = orderItems.filter(oi => oi.order.status === 'DELIVERED');
  const fulfilledOrderCount = fulfilledOrders.length;

  // Item-level ratings from order_ratings (match by order_id)
  const orderIds = fulfilledOrders.map(oi => oi.order_id);
  const ratings = orderIds.length
    ? await col('order_ratings').find({ order_id: { $in: orderIds } }).toArray()
    : [];

  const validRatings = ratings.filter(r => r.overall_rating > 0);
  const ratingCount = validRatings.length;
  const averageRating = ratingCount > 0
    ? Math.round(validRatings.reduce((s, r) => s + r.overall_rating, 0) / ratingCount * 10) / 10
    : 0;

  // Reorder count: customers who ordered this item more than once
  const customerOrders = {};
  for (const oi of fulfilledOrders) {
    const custId = oi.order.customer_id;
    if (!customerOrders[custId]) customerOrders[custId] = 0;
    customerOrders[custId]++;
  }
  const reorderCount = Object.values(customerOrders).filter(c => c >= 2).length;
  const uniqueCustomers = Object.keys(customerOrders).length;
  const reorderRate = uniqueCustomers > 0 ? reorderCount / uniqueCustomers : 0;

  // Favorite count (from order_ratings where this item was marked favorite)
  const favoriteCount = ratings.filter(r => r.favorite_item_name?.toLowerCase().trim() === itemName).length;

  // Issue tracking
  const issueRatings = ratings.filter(r => r.overall_rating <= 2 || r.issue_tags?.length > 0);
  const issueCount = issueRatings.length;
  const issueRate = fulfilledOrderCount > 0 ? issueCount / fulfilledOrderCount : 0;

  // Last 30 days
  const last30Orders = fulfilledOrders.filter(oi => new Date(oi.order.delivered_at || oi.order.created_at) >= thirtyDaysAgo);
  const prev30Orders = fulfilledOrders.filter(oi => {
    const d = new Date(oi.order.delivered_at || oi.order.created_at);
    return d >= sixtyDaysAgo && d < thirtyDaysAgo;
  });
  const last30Ratings = validRatings.filter(r => new Date(r.created_at) >= thirtyDaysAgo);

  const isNew = item.created_at && new Date(item.created_at) >= twentyOneDaysAgo;

  return {
    item_id: itemId,
    restaurant_id: restaurantId,
    item_name: item.name,
    fulfilled_order_count: fulfilledOrderCount,
    rating_count: ratingCount,
    average_rating: averageRating,
    reorder_count: reorderCount,
    reorder_rate: Math.round(reorderRate * 100) / 100,
    favorite_count: favoriteCount,
    issue_count: issueCount,
    issue_rate: Math.round(issueRate * 100) / 100,
    last_30_day_order_count: last30Orders.length,
    prev_30_day_order_count: prev30Orders.length,
    last_30_day_rating_count: last30Ratings.length,
    last_30_day_average_rating: last30Ratings.length > 0
      ? Math.round(last30Ratings.reduce((s, r) => s + r.overall_rating, 0) / last30Ratings.length * 10) / 10 : 0,
    public_rating_enabled: fulfilledOrderCount >= 20 && ratingCount >= 5,
    _isNew: isNew,
  };
}

// ─── ASSIGN TRUST TAG ───────────────────────────────────────
function assignTrustTag(metrics, allItemsContext) {
  for (const rule of TRUST_RULES) {
    if (rule.check(metrics, allItemsContext)) return rule.tag;
  }
  return null;
}

// ─── GENERATE SECONDARY TAGS ────────────────────────────────
function generateSecondaryTags(item) {
  const tags = [];
  // Spice level
  const spiceMap = { mild: 'Mild spicy', medium: 'Medium spicy', spicy: 'Spicy' };
  if (item.spice_level && spiceMap[item.spice_level]) tags.push(spiceMap[item.spice_level]);
  // Portion
  const portionMap = { good_for_1: 'Good for 1', good_for_sharing: 'Good for Sharing', quick_bite: 'Quick Bite' };
  if (item.portion_label && portionMap[item.portion_label]) tags.push(portionMap[item.portion_label]);
  // Veg/Non-veg
  if (item.food_type === 'veg' || item.food_type === 'vegan') tags.push('Veg');
  else if (item.food_type === 'non_veg') tags.push('Non-Veg');
  else if (item.food_type === 'egg') tags.push('Egg');
  return tags.slice(0, 2);
}

// ─── GENERATE META DESCRIPTION ──────────────────────────────
function generateMetaDescription(metrics, item, maxLen = 280) {
  const parts = [];

  // Line 1: Rating (if eligible)
  if (metrics.public_rating_enabled && metrics.average_rating > 0) {
    parts.push(`⭐ ${metrics.average_rating}/5 from ${metrics.rating_count} recent orders`);
  }

  // Line 2: Trust tag + secondary tags
  const trustTag = metrics.trust_tag;
  const secondaryTags = generateSecondaryTags(item);
  const tagLine = [trustTag, ...secondaryTags].filter(Boolean).join(' | ');
  if (tagLine) parts.push(tagLine);

  // Line 3: Base description
  const baseDesc = (item.description || item.name || '').trim();
  if (baseDesc) parts.push(baseDesc);

  let result = parts.join('\n');

  // Truncate if too long — preserve rating first, tags second, trim description
  if (result.length > maxLen && parts.length >= 3) {
    const descBudget = maxLen - (parts[0] || '').length - (parts[1] || '').length - 2;
    if (descBudget > 20) {
      parts[2] = parts[2].substring(0, descBudget - 3) + '...';
    } else {
      parts.pop(); // remove description entirely
    }
    result = parts.join('\n');
  }

  // Meta minimum 10 chars
  if (result.length < 10) result = `${item.name || 'Menu item'} — freshly prepared`;

  return result.substring(0, 1000); // Meta max
}

// ─── FULL TRUST REFRESH FOR A RESTAURANT ────────────────────
async function refreshTrustMetrics(restaurantId) {
  const startTime = Date.now();
  log.info({ restaurantId }, 'Refreshing trust metrics');

  const items = await col('menu_items').find({ restaurant_id: restaurantId, is_available: true }).toArray();
  if (!items.length) return { processed: 0 };

  // Calculate metrics for all items
  const allMetrics = [];
  for (const item of items) {
    try {
      const metrics = await calculateItemTrustMetrics(String(item._id), restaurantId);
      if (metrics) allMetrics.push({ ...metrics, _item: item });
    } catch (e) {
      log.warn({ err: e, itemName: item.name }, 'Metrics calc failed');
    }
  }

  // Calculate p90 order count for "Best Seller" threshold
  const orderCounts = allMetrics.map(m => m.fulfilled_order_count).sort((a, b) => a - b);
  const p90Index = Math.floor(orderCounts.length * 0.9);
  const allItemsContext = { _p90OrderCount: orderCounts[p90Index] || 50 };

  // Assign trust tags and generate descriptions
  const bulkOps = [];
  for (const metrics of allMetrics) {
    const trustTag = assignTrustTag(metrics, allItemsContext);
    const metaDescription = generateMetaDescription({ ...metrics, trust_tag: trustTag }, metrics._item);

    bulkOps.push({
      updateOne: {
        filter: { _id: metrics.item_id },
        update: { $set: {
          trust_metrics: {
            fulfilled_order_count: metrics.fulfilled_order_count,
            rating_count: metrics.rating_count,
            average_rating: metrics.average_rating,
            reorder_count: metrics.reorder_count,
            reorder_rate: metrics.reorder_rate,
            favorite_count: metrics.favorite_count,
            issue_count: metrics.issue_count,
            issue_rate: metrics.issue_rate,
            last_30_day_order_count: metrics.last_30_day_order_count,
            last_30_day_average_rating: metrics.last_30_day_average_rating,
            public_rating_enabled: metrics.public_rating_enabled,
            trust_tag: trustTag,
            calculated_at: new Date(),
          },
          meta_description_generated: metaDescription,
          meta_description_last_synced_at: null, // Mark as needing sync
        }},
      },
    });
  }

  if (bulkOps.length) {
    await col('menu_items').bulkWrite(bulkOps, { ordered: false });
  }

  const elapsed = Date.now() - startTime;
  log.info({ restaurantId, items: allMetrics.length, elapsedMs: elapsed }, 'Trust metrics refreshed');

  return { processed: allMetrics.length, elapsed };
}

// ─── GET TOP TRUSTED ITEMS FOR PRE-MENU MESSAGE ─────────────
async function getTopTrustedItems(restaurantId, branchId, limit = 5) {
  const query = {
    restaurant_id: restaurantId,
    is_available: true,
    'trust_metrics.trust_tag': { $ne: null },
  };
  if (branchId) query.branch_id = branchId;

  const items = await col('menu_items').find(query)
    .sort({ 'trust_metrics.average_rating': -1, 'trust_metrics.fulfilled_order_count': -1 })
    .limit(limit * 2) // fetch extra to filter
    .toArray();

  // Prioritize: public_rating_enabled first, then by rating, then by trust tag
  const rated = items.filter(i => i.trust_metrics?.public_rating_enabled);
  const unrated = items.filter(i => !i.trust_metrics?.public_rating_enabled);

  return [...rated, ...unrated].slice(0, limit).map(i => ({
    name: i.name,
    averageRating: i.trust_metrics?.average_rating || 0,
    ratingCount: i.trust_metrics?.rating_count || 0,
    trustTag: i.trust_metrics?.trust_tag,
    publicRatingEnabled: i.trust_metrics?.public_rating_enabled || false,
    foodType: i.food_type,
  }));
}

// ─── BUILD PRE-MENU TRUST MESSAGE ───────────────────────────
async function buildPreMenuTrustMessage(restaurantId, branchId) {
  const topItems = await getTopTrustedItems(restaurantId, branchId);
  if (!topItems.length) return null;

  const foodEmoji = { veg: '🥬', non_veg: '🍗', egg: '🥚', vegan: '🌱' };
  const hasRated = topItems.some(i => i.publicRatingEnabled);

  let header = hasRated ? 'Most loved dishes from this outlet ⭐\n' : 'Popular picks from this outlet ⭐\n';
  const lines = topItems.map(i => {
    const emoji = foodEmoji[i.foodType] || '🍽️';
    if (i.publicRatingEnabled && i.averageRating > 0) {
      return `${emoji} ${i.name} — ${i.averageRating}/5 (${i.ratingCount} reviews)`;
    }
    return `${emoji} ${i.name}${i.trustTag ? ' — ' + i.trustTag : ''}`;
  });

  return header + '\n' + lines.join('\n') + '\n\nTap below to explore the menu 👇';
}

module.exports = {
  calculateItemTrustMetrics,
  assignTrustTag,
  generateSecondaryTags,
  generateMetaDescription,
  refreshTrustMetrics,
  getTopTrustedItems,
  buildPreMenuTrustMessage,
};
