// src/services/mpmStrategy/bestSellerSelector.js
// Selects best-seller items for the priority MPM section.
// Priority: merchant-marked flags → order history → fallback heuristic.

'use strict';

const { col } = require('../../config/database');
const log = require('../../utils/logger').child({ component: 'BestSeller' });

/**
 * Select best-seller items from a set of menu items.
 * Returns items sorted by bestseller score (highest first).
 *
 * @param {Array} items - Available menu items (raw or compressed)
 * @param {object} opts - { branchId, restaurantId, maxItems, config }
 * @returns {Array} - Best-seller items with _bestsellerScore and _bestsellerSource
 */
async function selectBestSellers(items, opts = {}) {
  const { branchId, restaurantId, maxItems = 15, config = {} } = opts;
  if (!items.length) return [];

  // ── Strategy 1: Merchant-marked bestsellers (is_bestseller flag) ──
  const flagged = items.filter(i => i.is_bestseller);

  if (flagged.length >= 2) {
    return flagged.slice(0, maxItems).map(i => ({
      ...i,
      _bestsellerScore: 100,
      _bestsellerSource: 'merchant_flag',
    }));
  }

  // ── Strategy 2: Order history (if available) ──
  try {
    const query = { restaurant_id: restaurantId, status: { $nin: ['CANCELLED', 'PAYMENT_FAILED'] } };
    if (config.enableOutletBestsellerWeighting && branchId) {
      query.branch_id = branchId;
    }

    const topItems = await col('order_items').aggregate([
      { $lookup: { from: 'orders', localField: 'order_id', foreignField: '_id', as: 'order' } },
      { $unwind: '$order' },
      { $match: { 'order.restaurant_id': restaurantId, 'order.status': { $nin: ['CANCELLED', 'PAYMENT_FAILED'] } } },
      { $group: { _id: '$item_name', count: { $sum: '$quantity' }, lastOrdered: { $max: '$order.created_at' } } },
      { $sort: { count: -1 } },
      { $limit: maxItems * 2 }, // fetch extra to account for unavailable items
    ]).toArray();

    if (topItems.length >= 3) {
      const topNames = new Set(topItems.map(t => (t._id || '').toLowerCase().trim()));
      const matched = items
        .filter(i => topNames.has((i.name || '').toLowerCase().trim()))
        .slice(0, maxItems);

      if (matched.length >= 2) {
        return matched.map((i, idx) => ({
          ...i,
          _bestsellerScore: 80 - idx,
          _bestsellerSource: 'order_history',
        }));
      }
    }
  } catch (e) {
    log.warn({ err: e }, 'Order history query failed');
  }

  // ── Strategy 3: Fallback heuristic ──
  // Pick items with lowest sort_order (merchant-curated order) or lowest price (accessible items)
  const sorted = [...items].sort((a, b) => {
    if ((a.sort_order || 999) !== (b.sort_order || 999)) return (a.sort_order || 999) - (b.sort_order || 999);
    return (a.price_paise || 0) - (b.price_paise || 0);
  });

  return sorted.slice(0, Math.min(maxItems, Math.max(5, Math.floor(items.length * 0.15)))).map((i, idx) => ({
    ...i,
    _bestsellerScore: 50 - idx,
    _bestsellerSource: 'fallback_heuristic',
  }));
}

module.exports = { selectBestSellers };
