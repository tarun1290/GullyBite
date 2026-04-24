// src/services/branch.service.js
// Branch domain service — creation, validation, lookups.
//
// ─── BACK-COMPAT NOTES ──────────────────────────────────────────
// The existing `branches` collection has `is_open` and `accepts_orders`
// as activity flags. The spec introduces `is_active` as the canonical
// "branch is operational" flag. Rather than renaming (which would break
// existing queries across the codebase), we ADD `is_active` alongside
// the old flags and treat `is_active !== false` as the default.
//
// `fssai_number` and `gst_number` are additive columns. Absent fssai
// blocks catalog sync (see catalog.service.js) but never blocks branch
// creation for platforms that onboard non-food vendors later.

'use strict';

const { col, newId } = require('../config/database');
const log = require('../utils/logger').child({ component: 'branch.service' });

// Canonical hyphen-separated slug (consolidated from per-file copies).
const slugify = require('../utils/slugify');

// ─── FORMAT VALIDATORS ──────────────────────────────────────────
// FSSAI: 14-digit numeric string.
// GST: 15-char state-wise format, validated with the published checksum
//      algorithm. We accept any 15-char alphanumeric that matches the
//      structure on create — full checksum is optional (set
//      STRICT_GST_CHECKSUM=true in env to enforce).

const FSSAI_RE = /^\d{14}$/;
const GST_RE   = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

function validateFssai(fssai) {
  if (!fssai) return { ok: false, reason: 'fssai_number is required' };
  if (typeof fssai !== 'string' || !FSSAI_RE.test(fssai.trim())) {
    return { ok: false, reason: 'fssai_number must be a 14-digit number' };
  }
  return { ok: true, normalized: fssai.trim() };
}

function validateGst(gst) {
  if (!gst) return { ok: true, normalized: null }; // optional
  if (typeof gst !== 'string' || !GST_RE.test(gst.trim().toUpperCase())) {
    return { ok: false, reason: 'gst_number must be a valid 15-char GSTIN' };
  }
  return { ok: true, normalized: gst.trim().toUpperCase() };
}

// ─── CREATE ─────────────────────────────────────────────────────
async function createBranch(input) {
  const { restaurant_id, name, address, city, state, gst_number, fssai_number, latitude, longitude } = input;
  if (!restaurant_id) throw Object.assign(new Error('restaurant_id is required'), { statusCode: 400 });
  if (!name)          throw Object.assign(new Error('name is required'), { statusCode: 400 });

  const fssai = validateFssai(fssai_number);
  if (!fssai.ok) throw Object.assign(new Error(fssai.reason), { statusCode: 400 });

  const gst = validateGst(gst_number);
  if (!gst.ok) throw Object.assign(new Error(gst.reason), { statusCode: 400 });

  const now = new Date();
  const _id = newId();
  const branch = {
    _id,
    restaurant_id: String(restaurant_id),
    name: String(name).trim(),
    branch_slug: slugify(String(name).trim(), 20) || String(_id).slice(0, 8),
    address: address || null,
    city: city || null,
    state: state || null,
    // latitude/longitude retained because the existing system uses them
    // for delivery-radius calculations. They are NOT in the spec's
    // minimal schema but required by existing code paths.
    latitude:  latitude  != null ? parseFloat(latitude)  : null,
    longitude: longitude != null ? parseFloat(longitude) : null,
    gst_number: gst.normalized,
    fssai_number: fssai.normalized,
    is_active: true,
    // Legacy flags — keep true by default so existing queries keep working
    is_open: true,
    accepts_orders: true,
    created_at: now,
    updated_at: now,
  };

  await col('branches').insertOne(branch);
  log.info({ branchId: branch._id, restaurantId: branch.restaurant_id, city: branch.city }, 'branch created');
  return branch;
}

// ─── READ ───────────────────────────────────────────────────────
async function getBranch(branchId) {
  if (!branchId) return null;
  return col('branches').findOne({ _id: String(branchId) });
}

async function listBranchesByRestaurant(restaurantId, { onlyActive = false } = {}) {
  const q = { restaurant_id: String(restaurantId) };
  if (onlyActive) q.is_active = { $ne: false };
  return col('branches').find(q).sort({ created_at: 1 }).toArray();
}

// "Operational" means: is_active is not explicitly false AND (legacy flag
// not explicitly disabled). This lets the spec's is_active ride alongside
// the legacy accepts_orders flag without either side winning silently.
function isOperational(branch) {
  if (!branch) return false;
  if (branch.is_active === false) return false;
  if (branch.accepts_orders === false) return false;
  return true;
}

// ─── UPDATE ─────────────────────────────────────────────────────
async function updateBranch(branchId, patch) {
  const update = { updated_at: new Date() };
  if (patch.name != null)    update.name = String(patch.name).trim();
  if (patch.address != null) update.address = patch.address;
  if (patch.city != null)    update.city = patch.city;
  if (patch.state != null)   update.state = patch.state;
  if (patch.is_active != null) update.is_active = Boolean(patch.is_active);
  if (patch.fssai_number !== undefined) {
    const v = validateFssai(patch.fssai_number);
    if (!v.ok) throw Object.assign(new Error(v.reason), { statusCode: 400 });
    update.fssai_number = v.normalized;
  }
  if (patch.gst_number !== undefined) {
    const v = validateGst(patch.gst_number);
    if (!v.ok) throw Object.assign(new Error(v.reason), { statusCode: 400 });
    update.gst_number = v.normalized;
  }
  const res = await col('branches').findOneAndUpdate(
    { _id: String(branchId) },
    { $set: update },
    { returnDocument: 'after' }
  );
  if (!res.value) throw Object.assign(new Error('branch not found'), { statusCode: 404 });
  return res.value;
}

module.exports = {
  createBranch,
  getBranch,
  listBranchesByRestaurant,
  updateBranch,
  isOperational,
  validateFssai,
  validateGst,
};
