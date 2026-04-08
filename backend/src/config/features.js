// src/config/features.js
// Central feature flags — controls which subsystems are active.
// Each flag auto-enables when the required env vars are set,
// OR can be force-disabled via DISABLE_<NAME>=true env var.

'use strict';

const log = require('../utils/logger').child({ component: 'features' });

// ── Helper: flag is ON unless explicitly disabled ────────────
const isEnabled = (envDisableKey, autoCondition = true) =>
  process.env[envDisableKey] !== 'true' && autoCondition;

// ── Infrastructure flags ─────────────────────────────────────
const IMAGE_PIPELINE_ENABLED = isEnabled('DISABLE_IMAGE_PIPELINE', !!(
  process.env.AWS_ACCESS_KEY_ID &&
  process.env.AWS_SECRET_ACCESS_KEY &&
  process.env.AWS_S3_BUCKET &&
  (process.env.AWS_CLOUDFRONT_DOMAIN || process.env.CLOUDFRONT_URL)
));

const POS_INTEGRATIONS_ENABLED = isEnabled('DISABLE_POS_INTEGRATIONS',
  process.env.ENABLE_POS_INTEGRATIONS === 'true'
);

// ── Smart module flags ───────────────────────────────────────
// Each can be killed instantly via env var: DISABLE_<NAME>=true
// When disabled, callers fall back to simpler legacy paths.
const SMART_MODULES = {
  MPM_STRATEGY:         isEnabled('DISABLE_MPM_STRATEGY'),
  CATALOG_COMPRESSION:  isEnabled('DISABLE_CATALOG_COMPRESSION'),
  REORDER_INTELLIGENCE: isEnabled('DISABLE_REORDER_INTELLIGENCE'),
  ITEM_TRUST:           isEnabled('DISABLE_ITEM_TRUST'),
  DYNAMIC_PRICING:      isEnabled('DISABLE_DYNAMIC_PRICING'),
  REFERRAL_ATTRIBUTION: isEnabled('DISABLE_REFERRAL_ATTRIBUTION'),
  CART_RECOVERY:        isEnabled('DISABLE_CART_RECOVERY'),
};

// ── Startup log ──────────────────────────────────────────────
if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'test') {
  log.info({ enabled: IMAGE_PIPELINE_ENABLED }, `Image pipeline: ${IMAGE_PIPELINE_ENABLED ? 'ON' : 'OFF'}`);
  log.info({ enabled: POS_INTEGRATIONS_ENABLED }, `POS integrations: ${POS_INTEGRATIONS_ENABLED ? 'ON' : 'OFF'}`);

  const smartStatus = Object.entries(SMART_MODULES)
    .map(([k, v]) => `${k}=${v ? 'ON' : 'OFF'}`)
    .join(', ');
  log.info({ component: 'features' }, `Smart modules: ${smartStatus}`);
}

module.exports = {
  IMAGE_PIPELINE_ENABLED,
  POS_INTEGRATIONS_ENABLED,
  SMART_MODULES,
};
