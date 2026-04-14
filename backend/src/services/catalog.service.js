// src/services/catalog.service.js
// WhatsApp catalog PRE-SYNC GUARD — wraps the existing catalog sync
// (services/catalog.js) with the compliance gates the spec requires.
//
// The existing `syncBranchCatalog` already posts items to Meta; we do
// NOT modify it. Instead, this layer filters the product set BEFORE the
// existing code runs, producing two outputs:
//
//   eligible   — products that passed every gate; safe to sync
//   skipped    — products rejected, with a structured reason per row
//
// Callers use `filterForSync(branchId, products)` to get back only the
// eligible rows. Skipped rows are logged to `catalog_sync_skips` so ops
// can audit "why did this item not go to WhatsApp?" without grepping.
//
// ─── GATES (in order of cheapest → most expensive) ──────────────
//   1. product.is_unassigned !== true
//   2. product.branch_ids includes this branch  (OR legacy branch_id match)
//   3. branch exists
//   4. branch.is_active !== false
//   5. branch.fssai_number is present (food-compliance hard requirement)
//   6. branch_products row exists with a non-null price for this (product, branch)
//      → falls back to product.price_paise if no override exists; only
//        fails if BOTH are missing.

'use strict';

const { col, newId } = require('../config/database');
const branchSvc = require('./branch.service');
const log = require('../utils/logger').child({ component: 'catalog.service' });

// ─── AUDIT LOG MODEL — sync_logs ──────────────────────────────
// Canonical writer for the per-product Meta sync audit collection.
// Schema is declared in src/schemas/collections.js (sync_logs); indexes
// in src/config/indexes.js. Fire-and-forget — never throws back to the
// caller, since audit failures must not break the sync path.
//
//   {
//     _id, restaurant_id, product_id, branch_id,
//     status: "synced" | "skipped",
//     reason, timestamp
//   }
// Auto-fix suggestion mapping — reason code → actionable hint.
// Keys are the UPPERCASE user-facing codes persisted to `sync_logs`
// (see SYNC_SKIP_CODE in services/catalog.js). Internal lowercase
// reason codes from SKIP_REASONS are also mapped so callers that
// pass raw guard reasons still get a useful suggestion.
const SUGGESTION_BY_REASON = {
  UNASSIGNED_PRODUCT:  'Assign this product to at least one branch',
  META_INCOMPLETE:     'Complete required fields like price, category',
  FSSAI_MISSING:       'Add FSSAI number to the branch',
  PRICE_MISSING:       'Set price for this product in branch',
  BRANCH_INACTIVE:     'Activate the branch to enable sync',
  // Internal aliases (lowercase, from SKIP_REASONS).
  product_unassigned:                 'Assign this product to at least one branch',
  product_not_assigned_to_this_branch:'Assign this product to at least one branch',
  meta_incomplete:                    'Complete required fields like price, category',
  branch_missing_fssai:               'Add FSSAI number to the branch',
  no_price_configured:                'Set price for this product in branch',
  branch_inactive:                    'Activate the branch to enable sync',
  branch_not_found:                   'Activate the branch to enable sync',
};

function suggestionForReason(reason) {
  if (!reason) return null;
  return SUGGESTION_BY_REASON[reason] || null;
}

async function writeSyncLog({ restaurantId, branchId, productId, status, reason }) {
  // Auto-fix hints are only meaningful for skipped rows.
  const suggestion = status === 'skipped' ? suggestionForReason(reason) : null;
  try {
    await col('sync_logs').insertOne({
      _id: newId(),
      restaurant_id: String(restaurantId),
      product_id:    String(productId),
      branch_id:     String(branchId),
      status,                          // 'synced' | 'skipped'
      reason: reason || null,
      suggestion,
      timestamp: new Date(),
    });
  } catch (_) { /* audit only — never fail the caller */ }
}

const SKIP_REASONS = {
  UNASSIGNED:        'product_unassigned',
  NOT_IN_BRANCH:     'product_not_assigned_to_this_branch',
  BRANCH_MISSING:    'branch_not_found',
  BRANCH_INACTIVE:   'branch_inactive',
  NO_FSSAI:          'branch_missing_fssai',
  NO_PRICE:          'no_price_configured',
  META_INCOMPLETE:   'meta_incomplete',
};

async function _recordSkip(productId, branchId, reason) {
  try {
    await col('catalog_sync_skips').insertOne({
      product_id: String(productId),
      branch_id: String(branchId),
      reason,
      at: new Date(),
    });
  } catch (_) { /* audit only — never fail the caller */ }
}

/**
 * Validate a single (product, branch) pair.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
async function validateForSync(product, branch, override) {
  if (!product) return { ok: false, reason: SKIP_REASONS.UNASSIGNED };
  if (product.is_unassigned === true) return { ok: false, reason: SKIP_REASONS.UNASSIGNED };

  // Either the new array OR the legacy scalar must match this branch.
  const inBranch = Array.isArray(product.branch_ids)
    && product.branch_ids.map(String).includes(String(branch?._id));
  const legacyMatch = product.branch_id && String(product.branch_id) === String(branch?._id);
  if (!inBranch && !legacyMatch) return { ok: false, reason: SKIP_REASONS.NOT_IN_BRANCH };

  if (!branch) return { ok: false, reason: SKIP_REASONS.BRANCH_MISSING };
  if (!branchSvc.isOperational(branch)) return { ok: false, reason: SKIP_REASONS.BRANCH_INACTIVE };
  if (!branch.fssai_number) return { ok: false, reason: SKIP_REASONS.NO_FSSAI };

  // Block products the XLSX normaliser flagged as having missing fields.
  // Only enforced when meta_status is explicitly set; legacy rows
  // without the field pass through unchanged (back-compat).
  if (product.meta_status === 'incomplete') return { ok: false, reason: SKIP_REASONS.META_INCOMPLETE };

  const hasOverridePrice = override && override.price_paise != null;
  const hasProductPrice  = product.price_paise != null;
  if (!hasOverridePrice && !hasProductPrice) return { ok: false, reason: SKIP_REASONS.NO_PRICE };

  return { ok: true };
}

/**
 * Filter a list of products down to those eligible for catalog sync.
 * Batch-loads the branch and the branch_products overrides once.
 */
async function filterForSync(branchId, products) {
  if (!Array.isArray(products) || products.length === 0) {
    return { eligible: [], skipped: [] };
  }
  const branch = await branchSvc.getBranch(branchId);
  const ids = products.map(p => String(p._id));
  const overrides = await col('branch_products').find({
    branch_id: String(branchId),
    product_id: { $in: ids },
  }).toArray();
  const oByProduct = new Map(overrides.map(o => [o.product_id, o]));

  // Re-hydrate products from DB so we don't trust stale in-memory copies
  // (e.g., is_unassigned/branch_ids that have changed since the caller
  // loaded them). Falls back to the passed-in object if the row is gone.
  const fresh = await col('menu_items').find({ _id: { $in: ids } }).toArray();
  const freshById = new Map(fresh.map(d => [String(d._id), d]));

  const eligible = [];
  const skipped  = [];
  for (const p of products) {
    const current = freshById.get(String(p._id)) || p;
    const override = oByProduct.get(String(p._id));
    const check = await validateForSync(current, branch, override);
    if (check.ok) {
      eligible.push({ product: p, override });
    } else {
      skipped.push({ product_id: p._id, reason: check.reason });
      _recordSkip(p._id, branchId, check.reason);
    }
  }

  if (skipped.length) {
    log.warn({ branchId, skipped: skipped.length, total: products.length }, 'catalog sync: products skipped');
  }
  return { eligible, skipped };
}

// ─── NON-BLOCKING META VALIDATION WRAPPER ─────────────────────
// Mirrors the gates in `validateForSync` but is intentionally
// LOG-ONLY: callers iterate every product, get an `{isValid, reason}`
// verdict, and ALWAYS forward the product to Meta. Used to surface
// data-quality issues in production without changing sync output.
//
// Distinct from `validateForSync` so the strict pre-filter path can
// keep evolving independently of the audit-only path.
const META_INVALID_REASONS = {
  UNASSIGNED:      'product_unassigned',
  META_NOT_READY:  'meta_status_not_ready',
  BRANCH_INACTIVE: 'branch_inactive',
  NO_FSSAI:        'branch_missing_fssai',
  NO_PRICE:        'no_price_configured',
};

/**
 * Validate a (product, branch) pair for Meta sync — log-only.
 * Never blocks; callers should forward the product regardless.
 * @returns {{ isValid: boolean, reason: string }}
 */
function validateProductForMeta(product, branch) {
  if (!product || product.is_unassigned === true) {
    return { isValid: false, reason: META_INVALID_REASONS.UNASSIGNED };
  }
  if (product.meta_status && product.meta_status !== 'ready') {
    return { isValid: false, reason: META_INVALID_REASONS.META_NOT_READY };
  }
  if (!branch || branchSvc.isOperational(branch) === false) {
    return { isValid: false, reason: META_INVALID_REASONS.BRANCH_INACTIVE };
  }
  if (!branch.fssai_number) {
    return { isValid: false, reason: META_INVALID_REASONS.NO_FSSAI };
  }
  const hasPrice = (product.price_paise != null) || (product.price != null);
  if (!hasPrice) {
    return { isValid: false, reason: META_INVALID_REASONS.NO_PRICE };
  }
  return { isValid: true, reason: '' };
}

/**
 * Iterate every product, run the log-only validator, emit one structured
 * log line per row. Returns the per-row verdicts so callers can also
 * persist them to `catalog_sync_skips` / `sync_logs` if desired.
 *
 * IMPORTANT: This wrapper does NOT mutate the products array and does
 * NOT decide what gets sent. The caller still forwards every product.
 */
async function logValidateForMeta(branchId, products) {
  if (!Array.isArray(products) || products.length === 0) return [];
  const branch = await branchSvc.getBranch(branchId);
  return products.map(p => {
    const verdict = validateProductForMeta(p, branch);
    if (!verdict.isValid) {
      log.warn({
        product_id: p && p._id, branch_id: branchId,
        meta_validation: 'invalid', reason: verdict.reason,
      }, 'meta validation: product flagged (log-only, not blocked)');
    } else {
      log.debug({
        product_id: p && p._id, branch_id: branchId,
        meta_validation: 'valid',
      }, 'meta validation: product ok');
    }
    return { product_id: p && p._id, ...verdict };
  });
}

module.exports = {
  validateForSync,
  filterForSync,
  SKIP_REASONS,
  validateProductForMeta,
  logValidateForMeta,
  META_INVALID_REASONS,
  writeSyncLog,
  suggestionForReason,
  SUGGESTION_BY_REASON,
};
