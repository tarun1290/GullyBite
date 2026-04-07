// src/services/mpmStrategy/config.js
// MPM Strategy configuration — controls which prioritization modules are active.
// Feature flags for active features and future-smart dormant modules.

'use strict';

const MPM_STRATEGY_CONFIG = {
  // ── Active features (enabled by default) ──────────────────
  enableBestSellers: true,              // Bestseller section as first MPM priority
  enableCategoryAwareBatching: true,    // Group by category instead of random batching
  enableFoodBeverageSplit: true,        // Separate food and drink into different MPM groups
  enableCompressedCatalogSource: true,  // Use compressed catalog as MPM data source (false = raw menu_items)

  // ── Limits ────────────────────────────────────────────────
  maxProductsPerMPM: 30,               // Meta limit
  maxSectionsPerMPM: 10,               // Meta limit
  minBestsellersForSection: 2,         // Minimum items to show Bestsellers section
  maxBestsellersInSection: 15,         // Cap bestseller section size

  // ── Future-smart modules (disabled by default) ────────────
  enableTimeOfDayPrioritization: false, // Breakfast/lunch/dinner menu weighting
  enableStockAwareSuppression: false,   // Hide low-stock items from top-priority MPMs
  enableOutletBestsellerWeighting: false,// Per-branch bestseller ranking
  enableCampaignPriority: false,        // Promote campaign items higher
  enableSeasonalBoosting: false,        // Seasonal/festive specials boost
  enableNewLaunchBoost: false,          // Recently added items get visibility bump
  enableReorderPriority: false,         // Prioritize items the customer ordered before
};

// Runtime config override from DB (loaded lazily, cached 5 min)
let _dbConfig = null;
let _dbConfigTime = 0;
const CONFIG_CACHE_MS = 5 * 60 * 1000;

async function getStrategyConfig() {
  if (_dbConfig && Date.now() - _dbConfigTime < CONFIG_CACHE_MS) {
    return { ...MPM_STRATEGY_CONFIG, ..._dbConfig };
  }
  try {
    const { col } = require('../../config/database');
    const doc = await col('platform_settings').findOne({ _id: 'mpm_strategy_config' });
    if (doc) {
      _dbConfig = doc.config || {};
      _dbConfigTime = Date.now();
      return { ...MPM_STRATEGY_CONFIG, ..._dbConfig };
    }
  } catch { /* DB not ready, use defaults */ }
  return { ...MPM_STRATEGY_CONFIG };
}

module.exports = { MPM_STRATEGY_CONFIG, getStrategyConfig };
