// src/config/features.js
// Central feature flags — controls which subsystems are active.
// Each flag auto-enables when the required env vars are set.

'use strict';

const IMAGE_PIPELINE_ENABLED = !!(
  process.env.AWS_ACCESS_KEY_ID &&
  process.env.AWS_SECRET_ACCESS_KEY &&
  process.env.AWS_S3_BUCKET &&
  (process.env.AWS_CLOUDFRONT_DOMAIN || process.env.CLOUDFRONT_URL)
);

// Log on startup
if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'test') {
  console.log(`[Features] Image pipeline: ${IMAGE_PIPELINE_ENABLED ? 'ENABLED' : 'DISABLED (set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET, CLOUDFRONT_URL to enable)'}`);
}

const POS_INTEGRATIONS_ENABLED = process.env.ENABLE_POS_INTEGRATIONS === 'true';

module.exports = {
  IMAGE_PIPELINE_ENABLED,
  POS_INTEGRATIONS_ENABLED,
};
