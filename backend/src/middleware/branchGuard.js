// src/middleware/branchGuard.js
// Centralised branch-first validation checkpoints.
//
// The branch-first model adds three new gates on top of the legacy menu
// flow. Rather than scatter the logic across order/customer/sync paths,
// every gate funnels through this module. Each helper is read-only and
// purely additive: it surfaces a structured reason but never mutates DB
// state, so callers stay in control of how to react (skip, 400, warn).
//
// Reason codes (stable; surfaced to dashboards & logs):
//   PRODUCT_UNASSIGNED, PRODUCT_NOT_IN_BRANCH,
//   BRANCH_NOT_FOUND,   BRANCH_INACTIVE,
//   BRANCH_MISSING_FSSAI, NO_PRICE
//
// Used by:
//   • services/order.js          → assertOrderable (block bad orders)
//   • services/product.service.js → already filters via listCustomerMenuForBranch
//   • services/catalog.js        → already filters via filterForSync
//   • routes/admin.js            → /branch-insights uses the same vocabulary

'use strict';

const { col } = require('../config/database');
const branchSvc = require('../services/branch.service');

const REASONS = {
  PRODUCT_UNASSIGNED:    'PRODUCT_UNASSIGNED',
  PRODUCT_NOT_IN_BRANCH: 'PRODUCT_NOT_IN_BRANCH',
  BRANCH_NOT_FOUND:      'BRANCH_NOT_FOUND',
  BRANCH_INACTIVE:       'BRANCH_INACTIVE',
  BRANCH_MISSING_FSSAI:  'BRANCH_MISSING_FSSAI',
  NO_PRICE:              'NO_PRICE',
};

// Shared predicate. Returns { ok: true } or { ok: false, reason }.
function checkProductForBranch(product, branch) {
  if (!product) return { ok: false, reason: REASONS.PRODUCT_UNASSIGNED };
  if (product.is_unassigned === true) return { ok: false, reason: REASONS.PRODUCT_UNASSIGNED };
  const ids = Array.isArray(product.branch_ids) ? product.branch_ids.map(String) : [];
  const inBranch = ids.includes(String(branch?._id));
  const legacyMatch = product.branch_id && String(product.branch_id) === String(branch?._id);
  if (!inBranch && !legacyMatch) return { ok: false, reason: REASONS.PRODUCT_NOT_IN_BRANCH };
  if (!branch) return { ok: false, reason: REASONS.BRANCH_NOT_FOUND };
  if (!branchSvc.isOperational(branch)) return { ok: false, reason: REASONS.BRANCH_INACTIVE };
  if (!branch.fssai_number) return { ok: false, reason: REASONS.BRANCH_MISSING_FSSAI };
  return { ok: true };
}

// CHECKPOINT — order placement.
// Throws { code, status: 400, details } so the caller can surface a
// structured 400. Soft by design: skips happen during cart-build for
// catalog flows; this is the *hard* line for direct order POSTs.
async function assertOrderable(branchId, productIds) {
  const branch = await branchSvc.getBranch(branchId);
  const products = await col('menu_items').find({
    _id: { $in: productIds.map(String) },
  }).toArray();
  const byId = new Map(products.map(p => [String(p._id), p]));

  const failures = [];
  for (const pid of productIds) {
    const p = byId.get(String(pid));
    const r = checkProductForBranch(p, branch);
    if (!r.ok) failures.push({ product_id: pid, reason: r.reason });
  }

  if (failures.length) {
    const err = new Error('Order contains products that cannot be ordered from this branch');
    err.status = 400;
    err.code = 'BRANCH_GUARD_REJECTED';
    err.details = failures;
    throw err;
  }
  return { ok: true, branch };
}

// CHECKPOINT — express middleware. Use on any route whose body carries
// { branch_id, items: [{ product_id }] }. Lightweight wrapper around
// assertOrderable that responds 400 with the structured failure list.
function requireOrderable(extract) {
  return async (req, res, next) => {
    try {
      const { branchId, productIds } = (extract ? extract(req) : {
        branchId: req.body?.branch_id,
        productIds: (req.body?.items || []).map(i => i.product_id || i.menu_item_id).filter(Boolean),
      });
      if (!branchId || !productIds?.length) return next();
      await assertOrderable(branchId, productIds);
      next();
    } catch (e) {
      if (e.status === 400 && e.code === 'BRANCH_GUARD_REJECTED') {
        return res.status(400).json({ error: e.message, code: e.code, details: e.details });
      }
      next(e);
    }
  };
}

module.exports = {
  REASONS,
  checkProductForBranch,
  assertOrderable,
  requireOrderable,
};
