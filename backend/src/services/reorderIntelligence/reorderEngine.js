// src/services/reorderIntelligence/reorderEngine.js
// Reorder Intelligence Engine — identifies likely reorder items for returning customers.
// Branch-aware and compressed-catalog-safe.

'use strict';

const { col } = require('../../config/database');
const { getReorderConfig } = require('./config');
const log = require('../../utils/logger').child({ component: 'ReorderEngine' });

/**
 * Get reorder candidates for a customer at a specific branch.
 * Returns items ranked by reorder likelihood, filtered to items available at the branch.
 *
 * @param {string} customerId - Customer document _id
 * @param {string} branchId - Current branch being served
 * @param {string} restaurantId
 * @param {Array} availableItems - Currently available items (compressed or raw) for this branch
 * @returns {Array} - Reorder candidates with _reorderScore and _reorderSource
 */
async function getReorderCandidates(customerId, branchId, restaurantId, availableItems) {
  const config = await getReorderConfig();
  if (!config.enableBasicReorderIntelligence || !customerId) return [];

  // 1. Fetch customer's order history
  const cutoffDate = new Date(Date.now() - config.reorderHistoryDays * 24 * 3600000);
  const orders = await col('orders').find({
    customer_id: customerId,
    restaurant_id: restaurantId,
    status: { $nin: ['CANCELLED', 'PAYMENT_FAILED'] },
    created_at: { $gte: cutoffDate },
  }).sort({ created_at: -1 }).limit(50).toArray();

  if (orders.length < config.minOrdersForReorder) return [];

  // 2. Aggregate item-level history
  const orderIds = orders.map(o => String(o._id));
  const orderItems = await col('order_items').find({ order_id: { $in: orderIds } }).toArray();

  if (!orderItems.length) return [];

  // 3. Build reorder scoring — recency + frequency + repeat
  const itemStats = new Map(); // item_name_lower → { count, lastOrdered, repeatCount, totalQty, orderIds }
  const orderDateMap = {};
  for (const o of orders) orderDateMap[String(o._id)] = o.created_at;

  for (const oi of orderItems) {
    const key = (oi.item_name || '').toLowerCase().trim();
    if (!key) continue;

    const orderDate = orderDateMap[oi.order_id] || new Date(0);
    if (!itemStats.has(key)) {
      itemStats.set(key, { name: oi.item_name, count: 0, totalQty: 0, lastOrdered: orderDate, orderSet: new Set() });
    }
    const stats = itemStats.get(key);
    stats.count++;
    stats.totalQty += oi.quantity || 1;
    stats.orderSet.add(oi.order_id);
    if (orderDate > stats.lastOrdered) stats.lastOrdered = orderDate;
  }

  // 4. Score each historical item
  const now = Date.now();
  const scored = [];

  for (const [key, stats] of itemStats) {
    const daysSinceLast = Math.max(1, (now - new Date(stats.lastOrdered).getTime()) / 86400000);
    const uniqueOrders = stats.orderSet.size;

    // Score: recency (higher = more recent) + frequency (higher = more orders) + repeat (ordered in multiple orders)
    const recencyScore = Math.max(0, 40 - daysSinceLast * 0.5);   // 0-40 points, decays over 80 days
    const frequencyScore = Math.min(30, uniqueOrders * 10);         // 0-30 points, 10 per unique order
    const repeatScore = uniqueOrders >= 2 ? 20 : 0;                // 20 bonus for repeat items
    const quantityBonus = Math.min(10, stats.totalQty * 2);        // 0-10 points for high-quantity items

    const totalScore = recencyScore + frequencyScore + repeatScore + quantityBonus;

    scored.push({
      nameKey: key,
      displayName: stats.name,
      score: Math.round(totalScore * 10) / 10,
      uniqueOrders,
      totalQty: stats.totalQty,
      lastOrdered: stats.lastOrdered,
      source: uniqueOrders >= 2 ? 'repeat_item' : 'recent_order',
    });
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // 5. Filter to currently available items at this branch (compressed-catalog-safe)
  const availableByName = new Map();
  for (const item of availableItems) {
    const key = (item.name || '').toLowerCase().trim();
    if (!availableByName.has(key)) availableByName.set(key, item);
  }

  const candidates = [];
  for (const s of scored) {
    if (s.score < config.minReorderScore) break;
    if (candidates.length >= config.maxReorderCandidates) break;

    const matchedItem = availableByName.get(s.nameKey);
    if (!matchedItem) continue; // Not available at this branch — skip

    candidates.push({
      ...matchedItem,
      _reorderScore: s.score,
      _reorderSource: s.source,
      _reorderUniqueOrders: s.uniqueOrders,
      _reorderLastOrdered: s.lastOrdered,
    });
  }

  return candidates;
}

/**
 * Get a preview of reorder intelligence for admin/debug.
 */
async function getReorderPreview(customerId, branchId, restaurantId, availableItems) {
  const candidates = await getReorderCandidates(customerId, branchId, restaurantId, availableItems);
  const config = await getReorderConfig();

  // Also show what was filtered out (for debug)
  const cutoffDate = new Date(Date.now() - config.reorderHistoryDays * 24 * 3600000);
  const orders = await col('orders').find({
    customer_id: customerId, restaurant_id: restaurantId,
    status: { $nin: ['CANCELLED', 'PAYMENT_FAILED'] },
    created_at: { $gte: cutoffDate },
  }).sort({ created_at: -1 }).limit(50).toArray();

  const orderIds = orders.map(o => String(o._id));
  const allOrderItems = await col('order_items').find({ order_id: { $in: orderIds } }).toArray();
  const allNames = [...new Set(allOrderItems.map(i => (i.item_name || '').toLowerCase().trim()))];

  const availableByName = new Set((availableItems || []).map(i => (i.name || '').toLowerCase().trim()));
  const filteredOut = allNames.filter(n => n && !availableByName.has(n));

  return {
    customerId,
    branchId,
    restaurantId,
    totalPastOrders: orders.length,
    totalHistoricalItems: allNames.length,
    candidates: candidates.map(c => ({
      name: c.name, score: c._reorderScore, source: c._reorderSource,
      uniqueOrders: c._reorderUniqueOrders, retailer_id: c.retailer_id,
    })),
    filteredOutByBranch: filteredOut,
    config,
  };
}

// ─── FUTURE-SMART REORDER MODULES (dormant) ─────────────────

async function applyTimeOfDayReorder(candidates, config) {
  if (!config.enableTimeOfDayReorder) return candidates;
  log.info('Time-of-day reorder: enabled but not yet implemented');
  return candidates;
}

async function applyDayOfWeekReorder(candidates, config) {
  if (!config.enableDayOfWeekReorder) return candidates;
  log.info('Day-of-week reorder: enabled but not yet implemented');
  return candidates;
}

async function applyComboAffinity(candidates, config) {
  if (!config.enableComboAffinity) return candidates;
  log.info('Combo affinity: enabled but not yet implemented');
  return candidates;
}

async function applyBeveragePairing(candidates, config) {
  if (!config.enableBeveragePairing) return candidates;
  log.info('Beverage pairing: enabled but not yet implemented');
  return candidates;
}

async function applyReactivationNudges(candidates, config) {
  if (!config.enableReactivationNudges) return candidates;
  log.info('Reactivation nudges: enabled but not yet implemented');
  return candidates;
}

async function applyRoutineMealPatterns(candidates, config) {
  if (!config.enableRoutineMealPatterns) return candidates;
  log.info('Routine meal patterns: enabled but not yet implemented');
  return candidates;
}

async function applyAllFutureReorderModules(candidates, config) {
  let result = candidates;
  result = await applyTimeOfDayReorder(result, config);
  result = await applyDayOfWeekReorder(result, config);
  result = await applyComboAffinity(result, config);
  result = await applyBeveragePairing(result, config);
  result = await applyReactivationNudges(result, config);
  result = await applyRoutineMealPatterns(result, config);
  return result;
}

module.exports = {
  getReorderCandidates,
  getReorderPreview,
  applyAllFutureReorderModules,
};
