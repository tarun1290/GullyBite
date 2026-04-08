// src/services/mpmStrategy/futurePrioritizers.js
// Future-smart MPM prioritization modules — DISABLED by default.
// Each module is a clean, self-contained function that can modify item scores/order.
// Enable via config flags. No-op when disabled.

'use strict';

const log = require('../../utils/logger').child({ component: 'MPMFuture' });

/**
 * Time-of-day prioritizer — boost breakfast/lunch/dinner items based on current hour.
 * When enabled, items tagged with matching meal period get a score boost.
 */
async function applyTimeOfDayPriority(items, config) {
  if (!config.enableTimeOfDayPrioritization) return items;
  // Future: check current IST hour, boost items tagged with matching meal period
  // e.g., breakfast items boosted 6am-11am, lunch 11am-3pm, dinner 6pm-11pm
  log.info('Time-of-day prioritization: enabled but not yet implemented');
  return items;
}

/**
 * Stock-aware suppression — demote or remove items with low/zero stock.
 * When enabled, unavailable or low-stock items are pushed down or hidden.
 */
async function applyStockAwareSuppression(items, config) {
  if (!config.enableStockAwareSuppression) return items;
  // Future: check stock levels, demote items with quantity < threshold
  log.info('Stock-aware suppression: enabled but not yet implemented');
  return items;
}

/**
 * Campaign/promo prioritizer — boost items in active campaigns.
 * When enabled, items linked to active marketing campaigns get priority.
 */
async function applyCampaignPriority(items, config) {
  if (!config.enableCampaignPriority) return items;
  // Future: check active campaigns, boost matching items
  log.info('Campaign priority: enabled but not yet implemented');
  return items;
}

/**
 * Seasonal/festive booster — boost seasonal specials.
 * When enabled, items tagged as seasonal or festive get visibility boost.
 */
async function applySeasonalBoosting(items, config) {
  if (!config.enableSeasonalBoosting) return items;
  // Future: check seasonal tags, date ranges, festival calendar
  log.info('Seasonal boosting: enabled but not yet implemented');
  return items;
}

/**
 * New-launch booster — boost recently added items.
 * When enabled, items created in the last N days get a temporary visibility bump.
 */
async function applyNewLaunchBoost(items, config) {
  if (!config.enableNewLaunchBoost) return items;
  // Future: check created_at, boost items < 7 days old
  log.info('New-launch boost: enabled but not yet implemented');
  return items;
}

/**
 * Reorder prioritizer — boost items the current customer has ordered before.
 * When enabled, requires customerId context.
 */
async function applyReorderPriority(items, config, context = {}) {
  if (!config.enableReorderPriority) return items;
  // Future: check customer's order history, boost previously ordered items
  log.info('Reorder priority: enabled but not yet implemented');
  return items;
}

/**
 * Run all future prioritizers in sequence (no-op for disabled ones).
 */
async function applyAllFuturePrioritizers(items, config, context = {}) {
  let result = items;
  result = await applyTimeOfDayPriority(result, config);
  result = await applyStockAwareSuppression(result, config);
  result = await applyCampaignPriority(result, config);
  result = await applySeasonalBoosting(result, config);
  result = await applyNewLaunchBoost(result, config);
  result = await applyReorderPriority(result, config, context);
  return result;
}

module.exports = {
  applyTimeOfDayPriority,
  applyStockAwareSuppression,
  applyCampaignPriority,
  applySeasonalBoosting,
  applyNewLaunchBoost,
  applyReorderPriority,
  applyAllFuturePrioritizers,
};
