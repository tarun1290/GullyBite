// src/services/product.service.js
// Product (menu_items) domain service with multi-branch assignment.
//
// ─── TERMINOLOGY MAPPING ────────────────────────────────────────
// The spec calls them "products". In GullyBite they're `menu_items`.
// This service treats them interchangeably — external API can expose
// /products, internally we write to `menu_items`. No rename = no break.
//
// The spec adds two new fields on top of the existing schema:
//   branch_ids      : array of branch IDs the item is assigned to.
//                     Complementary to the legacy `branch_id` scalar
//                     (which remains primary key of the menu_items row
//                     for back-compat). A single menu_items row usually
//                     represents one product in one branch; this array
//                     lets a single product logically span branches.
//   is_unassigned   : derived flag. True when branch_ids is empty, i.e.
//                     the product exists but has no branch mapping. Used
//                     by the customer-facing and catalog-sync layers to
//                     exclude the product.
//
// branch_products — new collection of per-branch overrides (price,
//                   tax %, availability). Unique on (product_id, branch_id).

'use strict';

const { col, newId } = require('../config/database');
const branchSvc = require('./branch.service');
const log = require('../utils/logger').child({ component: 'product.service' });

// ─── CREATE ─────────────────────────────────────────────────────
// Allows product creation WITHOUT branch assignment per spec. Defaults:
//   branch_ids    = []
//   is_unassigned = true
// The legacy `branch_id` scalar is still accepted (existing callers pass
// it) — when present, the product is ALSO assigned to that branch so
// old create paths continue producing usable rows.
async function createProduct(input) {
  const {
    restaurant_id, branch_id, name, description,
    price_paise, price_rs,                        // accept both
    tax_percentage, food_type, image_url, retailer_id,
  } = input;
  if (!restaurant_id) throw Object.assign(new Error('restaurant_id required'), { statusCode: 400 });
  if (!name)          throw Object.assign(new Error('name required'), { statusCode: 400 });

  const priceP = price_paise != null ? Number(price_paise)
                : price_rs    != null ? Math.round(Number(price_rs) * 100)
                : null;
  if (priceP == null || Number.isNaN(priceP)) {
    throw Object.assign(new Error('price required (price_paise or price_rs)'), { statusCode: 400 });
  }

  const now = new Date();
  const branchIds = branch_id ? [String(branch_id)] : [];
  const product = {
    _id: newId(),
    restaurant_id: String(restaurant_id),
    // Legacy scalar — keep populated for existing queries. When the
    // product is created without a branch, this stays null.
    branch_id: branch_id ? String(branch_id) : null,
    branch_ids: branchIds,
    is_unassigned: branchIds.length === 0,
    retailer_id: retailer_id || null,
    name: String(name).trim(),
    description: description || '',
    price_paise: priceP,
    tax_percentage: tax_percentage != null ? Number(tax_percentage) : null,
    food_type: food_type || null,
    image_url: image_url || null,
    is_available: true,
    catalog_sync_status: 'pending',
    created_at: now,
    updated_at: now,
  };
  await col('menu_items').insertOne(product);
  log.info({ productId: product._id, unassigned: product.is_unassigned }, 'product created');
  return product;
}

// ─── ASSIGN / UNASSIGN INVARIANT ────────────────────────────────
// Multi-branch assignment invariant:
//   branch_ids[] is the canonical set of branches the product is
//   assigned to.
//   branch_id (scalar) MUST be one of branch_ids[] when branch_ids
//   is non-empty, otherwise null.
//   This keeps mpmBuilder (which filters on branch_id scalar) and
//   catalog sync (which reads $or over both) consistent.
//
// Anything that mutates branch_ids in this file is responsible for
// reconciling the scalar branch_id at the same time. The dedicated
// helpers below do that. If a future writer skips this reconciliation,
// items will silently disappear from MPM even though the catalog still
// shows them — see services/mpmBuilder.js for the reader contract.

// ─── ASSIGN TO BRANCH ───────────────────────────────────────────
// POST /products/:id/assign-branch — add branch to product.branch_ids AND
// create/update the branch_products override row. Idempotent: re-calling
// with the same (product_id, branch_id) upserts the override and does
// not duplicate the branch in branch_ids.
async function assignProductToBranch({ product_id, branch_id, price, tax_percentage, availability = true }) {
  if (!product_id || !branch_id) {
    throw Object.assign(new Error('product_id and branch_id required'), { statusCode: 400 });
  }
  const [product, branch] = await Promise.all([
    col('menu_items').findOne({ _id: String(product_id) }),
    branchSvc.getBranch(branch_id),
  ]);
  if (!product) throw Object.assign(new Error('product not found'), { statusCode: 404 });
  if (!branch)  throw Object.assign(new Error('branch not found'),  { statusCode: 404 });

  const now = new Date();
  const priceP = price != null ? Math.round(Number(price) * 100) : (product.price_paise || 0);

  // 1) Upsert branch_products override.
  await col('branch_products').updateOne(
    { product_id: String(product_id), branch_id: String(branch_id) },
    {
      $set: {
        product_id: String(product_id),
        branch_id: String(branch_id),
        price_paise: priceP,
        tax_percentage: tax_percentage != null ? Number(tax_percentage) : null,
        availability: availability !== false,
        updated_at: now,
      },
      $setOnInsert: { _id: newId(), created_at: now },
    },
    { upsert: true }
  );

  // 2) Patch product: add branch to array, recompute is_unassigned, and —
  // when the scalar branch_id is currently empty — backfill it to the new
  // branch so the invariant holds. We deliberately DO NOT overwrite an
  // existing non-null scalar; another branch may already be the "primary"
  // assignment that downstream readers (e.g. mpmBuilder.js) rely on.
  const setOps = { is_unassigned: false, updated_at: now };
  const currentScalar = product.branch_id;
  if (currentScalar == null || currentScalar === '') {
    setOps.branch_id = String(branch_id);
  }
  const updated = await col('menu_items').findOneAndUpdate(
    { _id: String(product_id) },
    {
      $addToSet: { branch_ids: String(branch_id) },
      $set: setOps,
    },
    { returnDocument: 'after' }
  );

  log.info(
    { productId: product_id, branchId: branch_id, scalarBackfilled: 'branch_id' in setOps },
    'product assigned to branch'
  );
  return updated.value;
}

// ─── UNASSIGN ───────────────────────────────────────────────────
// Removes a single branch from branch_ids[] and reconciles the scalar
// branch_id per the invariant above. Two round-trips when reconciliation
// is needed (rare path, unassign is uncommon) — keeping consistency
// strictly correct beats saving a millisecond here.
async function unassignFromBranch({ product_id, branch_id }) {
  const res = await col('menu_items').findOneAndUpdate(
    { _id: String(product_id) },
    { $pull: { branch_ids: String(branch_id) }, $set: { updated_at: new Date() } },
    { returnDocument: 'after' }
  );
  if (!res.value) throw Object.assign(new Error('product not found'), { statusCode: 404 });

  const doc = res.value;
  const remaining = Array.isArray(doc.branch_ids) ? doc.branch_ids : [];
  const scalarPointedAtUnassigned = String(doc.branch_id || '') === String(branch_id);

  // Reconciliation cases:
  //   • branch_ids now empty → null the scalar, mark unassigned.
  //   • branch_ids still has entries AND scalar pointed at the branch we
  //     just removed → re-point scalar at the first remaining branch.
  //   • Otherwise (scalar still points at a branch that's still in the
  //     array) → no-op, invariant already holds.
  let reconcile = null;
  if (remaining.length === 0) {
    reconcile = { branch_id: null, is_unassigned: true, updated_at: new Date() };
  } else if (scalarPointedAtUnassigned) {
    reconcile = { branch_id: String(remaining[0]), updated_at: new Date() };
  }
  if (reconcile) {
    await col('menu_items').updateOne(
      { _id: String(product_id) },
      { $set: reconcile }
    );
    Object.assign(doc, reconcile);
  }

  await col('branch_products').deleteOne({
    product_id: String(product_id),
    branch_id: String(branch_id),
  });
  return doc;
}

// ─── LISTS ──────────────────────────────────────────────────────
async function listUnassignedProducts(restaurantId) {
  return col('menu_items').find({
    restaurant_id: String(restaurantId),
    $or: [{ is_unassigned: true }, { branch_ids: { $size: 0 } }, { branch_ids: { $exists: false } }],
  }).sort({ created_at: -1 }).toArray();
}

// Customer-facing: only assigned items in operational branches.
// Uses $lookup to enforce branch.is_active at query time — a single
// round trip, and the branch flag check lives with the data (no stale
// cache hazards).
async function listCustomerMenuForBranch(branchId) {
  if (!branchId) return [];
  const branch = await branchSvc.getBranch(branchId);
  if (!branchSvc.isOperational(branch)) return [];

  const items = await col('menu_items').find({
    $or: [
      { branch_ids: String(branchId) },
      { branch_id: String(branchId), is_unassigned: { $ne: true } },
    ],
    is_available: true,
  }).toArray();

  // Merge branch-level overrides.
  if (!items.length) return [];
  const overrides = await col('branch_products').find({
    branch_id: String(branchId),
    product_id: { $in: items.map(i => String(i._id)) },
  }).toArray();
  const oByProduct = new Map(overrides.map(o => [o.product_id, o]));
  return items.map(i => {
    const o = oByProduct.get(String(i._id));
    if (!o) return i;
    return {
      ...i,
      price_paise:    o.price_paise ?? i.price_paise,
      tax_percentage: o.tax_percentage ?? i.tax_percentage,
      is_available:   i.is_available && (o.availability !== false),
    };
  }).filter(i => i.is_available);
}

module.exports = {
  createProduct,
  assignProductToBranch,
  unassignFromBranch,
  listUnassignedProducts,
  listCustomerMenuForBranch,
};
