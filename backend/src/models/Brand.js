// src/models/Brand.js
// Native MongoDB "model" for the brand layer.
//
// This codebase uses the official mongodb driver (no Mongoose). This
// module is a thin wrapper over `col('brands')` that centralizes the
// document shape, defaults, and the common lookups the brand layer
// needs (by _id, by phone_number_id, by business_id).
//
// The collection schema and indexes are declared in:
//   - src/schemas/collections.js  (brands schema)
//   - src/config/indexes.js       (business_id, phone_number_id unique+sparse, status)
//
// Keep field names in sync with those two files.

'use strict';

const { col, newId } = require('../config/database');

const COLLECTION = 'brands';
const STATUS = Object.freeze({ ACTIVE: 'active', INACTIVE: 'inactive' });

// Build a brand document with defaults applied. Does not write.
// Required: business_id, name, phone_number_id.
function buildBrand({
  business_id,
  name,
  phone_number_id,
  waba_id = null,
  display_phone_number = null,
  catalog_id = null,
  status = STATUS.ACTIVE,
} = {}) {
  if (!business_id) throw new Error('Brand.business_id is required');
  if (!name) throw new Error('Brand.name is required');
  if (!phone_number_id) throw new Error('Brand.phone_number_id is required');
  if (status && !Object.values(STATUS).includes(status)) {
    throw new Error(`Brand.status must be one of: ${Object.values(STATUS).join(', ')}`);
  }
  const now = new Date();
  return {
    _id: newId(),
    business_id: String(business_id),
    name,
    waba_id: waba_id || null,
    phone_number_id: String(phone_number_id),
    display_phone_number: display_phone_number || null,
    catalog_id: catalog_id || null,
    status,
    created_at: now,
    updated_at: now,
  };
}

// Create a brand, then apply default-brand rules against the business
// (restaurants) row:
//
//   • business_type == 'single'    → set business.default_brand_id to
//                                    this brand IFF no default exists.
//                                    A 'single' tenant never has more
//                                    than one default — subsequent
//                                    brands become secondary.
//   • business_type == 'multi'     → never auto-assign; the caller must
//                                    explicitly pick a default via
//                                    setDefaultBrand() below.
//   • business_type missing/legacy → treated as 'single' (back-compat).
//
// The default-assignment is conditional on the business row not already
// having a default_brand_id, giving us the "only one default per
// business" invariant without a separate uniqueness index.
async function create(input) {
  const doc = buildBrand(input);
  await col(COLLECTION).insertOne(doc);

  try {
    const biz = await col('restaurants').findOne(
      { _id: doc.business_id },
      { projection: { business_type: 1 } }
    );
    if (biz) {
      const type = biz.business_type || 'single';  // legacy = single
      if (type === 'single') {
        // Atomic claim — MongoDB's findOneAndUpdate is a single-doc
        // atomic op, so only the first caller whose filter matches
        // (default_brand_id missing OR null) succeeds. Concurrent
        // brand creates on the same business get `updated == null`
        // and become silent no-ops. No extra locking required.
        const updated = await col('restaurants').findOneAndUpdate(
          {
            _id: doc.business_id,
            $or: [
              { default_brand_id: { $exists: false } },
              { default_brand_id: null },
            ],
          },
          { $set: { default_brand_id: doc._id, updated_at: new Date() } },
          { returnDocument: 'after' }
        );
        if (!updated || !updated.value) {
          // Another writer won the race. Expected on concurrent creates
          // for a single-brand tenant — leave the existing default in place.
        }
      }
    }
  } catch (_) { /* default assignment is best-effort — never fail brand create */ }

  return doc;
}

// Fetch the default brand for a business. For 'single' tenants the
// business row's default_brand_id is authoritative. For 'multi' tenants
// returns null if no default has been picked.
//
// Self-healing: if `default_brand_id` is set but the brand row is gone
// (deleted, archived, or referential drift), we log a warning and
// $unset the stale pointer so the business returns to the "no default"
// state instead of repeatedly failing lookups. All errors are swallowed
// — this helper never throws.
async function getDefaultBrand(businessId) {
  try {
    if (!businessId) return null;
    const biz = await col('restaurants').findOne(
      { _id: String(businessId) },
      { projection: { default_brand_id: 1, business_type: 1 } }
    );
    if (!biz || !biz.default_brand_id) return null;

    const brand = await findById(biz.default_brand_id);
    if (brand) return brand;

    // Pointer exists but brand row is missing — self-heal.
    const log = require('../utils/logger').child({ component: 'Brand' });
    log.warn({ businessId: String(businessId), staleDefaultBrandId: String(biz.default_brand_id) }, 'Default brand missing — resetting');
    try {
      await col('restaurants').updateOne(
        { _id: String(businessId), default_brand_id: biz.default_brand_id },
        { $unset: { default_brand_id: '' }, $set: { updated_at: new Date() } }
      );
    } catch (_) { /* best-effort cleanup — never throw from a reader */ }
    return null;
  } catch (_) {
    return null;
  }
}

// Explicitly set a brand as the default for its business. Enforces
// "only one default per business" by writing the pointer on the
// business row (single source of truth).
async function setDefaultBrand(businessId, brandId) {
  if (!businessId || !brandId) throw new Error('setDefaultBrand requires businessId and brandId');
  await col('restaurants').updateOne(
    { _id: String(businessId) },
    { $set: { default_brand_id: String(brandId), updated_at: new Date() } }
  );
  return getDefaultBrand(businessId);
}

function findById(id) {
  return col(COLLECTION).findOne({ _id: String(id) });
}

function findByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return Promise.resolve(null);
  return col(COLLECTION).findOne({ phone_number_id: String(phoneNumberId) });
}

function findByBusinessId(businessId, { status } = {}) {
  const q = { business_id: String(businessId) };
  if (status) q.status = status;
  return col(COLLECTION).find(q).sort({ created_at: -1 }).toArray();
}

async function update(id, patch = {}) {
  const $set = { ...patch, updated_at: new Date() };
  delete $set._id;
  delete $set.created_at;
  await col(COLLECTION).updateOne({ _id: String(id) }, { $set });
  return findById(id);
}

function setStatus(id, status) {
  if (!Object.values(STATUS).includes(status)) {
    throw new Error(`Brand.status must be one of: ${Object.values(STATUS).join(', ')}`);
  }
  return update(id, { status });
}

module.exports = {
  COLLECTION,
  STATUS,
  buildBrand,
  create,
  findById,
  findByPhoneNumberId,
  findByBusinessId,
  getDefaultBrand,
  setDefaultBrand,
  update,
  setStatus,
};
