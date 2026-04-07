// src/services/reorderIntelligence/config.js
// Reorder Intelligence configuration — controls which reorder modules are active.

'use strict';

const REORDER_CONFIG = {
  // ── Active features ───────────────────────────────────────
  enableBasicReorderIntelligence: true,  // Core reorder candidate identification
  enableYourUsualsGroup: true,           // "Your Usuals" section in MPMs
  maxReorderCandidates: 12,             // Max items in Your Usuals section
  minOrdersForReorder: 1,              // Min past orders to activate reorder
  reorderHistoryDays: 90,              // Look back N days for order history
  minReorderScore: 10,                 // Min score to qualify as reorder candidate

  // ── Future-smart modules (disabled by default) ────────────
  enableTimeOfDayReorder: false,        // Breakfast/lunch/dinner reorder habits
  enableDayOfWeekReorder: false,        // Weekend/weekday reorder patterns
  enableComboAffinity: false,           // Suggest commonly ordered-together items
  enableBeveragePairing: false,         // Suggest usual beverage with food reorder
  enableReactivationNudges: false,      // Surface items after inactivity period
  enableRoutineMealPatterns: false,     // Detect subscription-like meal patterns
};

// Runtime override from DB (cached 5 min)
let _dbConfig = null;
let _dbConfigTime = 0;

async function getReorderConfig() {
  if (_dbConfig && Date.now() - _dbConfigTime < 300000) {
    return { ...REORDER_CONFIG, ..._dbConfig };
  }
  try {
    const { col } = require('../../config/database');
    const doc = await col('platform_settings').findOne({ _id: 'reorder_intelligence_config' });
    if (doc?.config) { _dbConfig = doc.config; _dbConfigTime = Date.now(); return { ...REORDER_CONFIG, ..._dbConfig }; }
  } catch { /* DB not ready */ }
  return { ...REORDER_CONFIG };
}

module.exports = { REORDER_CONFIG, getReorderConfig };
