// src/utils/brandContext.js
// Dashboard-level brand context resolver.
//
// Reads the tenant's `business_type` + `default_brand_id` and reconciles
// them with the request's `brand_id` query param. Gives every brand-
// aware dashboard endpoint (orders, messages, catalog) a single place
// to enforce the "multi requires a brand" rule and auto-fill from the
// default_brand_id.
//
// Return shape:
//   {
//     business_type:     'single' | 'multi',
//     default_brand_id:  <uuid|null>,
//     effective_brand_id:<uuid|null>,   // apply to filter; null = no brand scope
//     requested_brand_id:<uuid|null>,   // raw query param
//     missing:           boolean,        // multi tenant, no brand, no default
//   }
//
// Callers should 400 when `missing === true`. Otherwise add
// `effective_brand_id` to the query filter when non-null.

'use strict';

const { col } = require('../config/database');

async function resolveBrandContext(restaurantId, requestedBrandId = null) {
  const biz = await col('restaurants').findOne(
    { _id: String(restaurantId) },
    { projection: { business_type: 1, default_brand_id: 1 } }
  );
  const businessType = biz?.business_type || 'single';   // legacy = single
  const defaultBrandId = biz?.default_brand_id || null;

  let effective = requestedBrandId || null;

  if (businessType === 'single') {
    // Single-brand tenants don't require a brand_id. If one is given,
    // honour it; otherwise fall through with no brand filter (full
    // tenant data, matching legacy behaviour).
    return {
      business_type: businessType,
      default_brand_id: defaultBrandId,
      effective_brand_id: effective,
      requested_brand_id: requestedBrandId || null,
      missing: false,
    };
  }

  // multi: brand_id required. Auto-filter by default_brand_id when the
  // caller didn't pass one but a default exists.
  if (!effective && defaultBrandId) effective = defaultBrandId;
  const missing = !effective;
  return {
    business_type: businessType,
    default_brand_id: defaultBrandId,
    effective_brand_id: effective,
    requested_brand_id: requestedBrandId || null,
    missing,
  };
}

// Express helper: sets X-Business-Type / X-Brand-Id response headers
// so clients can see the resolved context without a response-shape change.
function setBrandHeaders(res, ctx) {
  if (!ctx) return;
  try {
    res.set('X-Business-Type', ctx.business_type);
    if (ctx.effective_brand_id) res.set('X-Brand-Id', String(ctx.effective_brand_id));
    if (ctx.default_brand_id)   res.set('X-Default-Brand-Id', String(ctx.default_brand_id));
  } catch (_) { /* header set failures are non-fatal */ }
}

module.exports = { resolveBrandContext, setBrandHeaders };
