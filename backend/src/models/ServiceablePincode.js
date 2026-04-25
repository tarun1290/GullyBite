// src/models/ServiceablePincode.js
// Native MongoDB "model" for the platform-wide pincode serviceability
// map. Seeded from data/serviceable_pincodes.csv via scripts/seedPincodes.js.
//
// This is NOT per-restaurant — all restaurants inherit the same
// serviceability list. Toggling `enabled` on a pincode affects every
// tenant platform-wide.
//
// Collection:   serviceable_pincodes
// Indexes:      { pincode: 1 } unique, { enabled: 1 }, { city: 1 }, { state: 1 }
//               (declared in src/config/indexes.js)
// Shape:        { _id, pincode, enabled, notes, city, state, area,
//                 created_at, updated_at }
//
// city/state are derived from the 3-digit prefix via
// utils/pincodeCityMap. Both are optional — legacy docs without them
// are backfilled by scripts/seedPincodes.js.

'use strict';

const { col } = require('../config/database');
const { getCityForPincode } = require('../utils/pincodeCityMap');

const COLLECTION = 'serviceable_pincodes';

function buildPincode({ pincode, enabled = true, notes = null, city = null, state = null, area = null } = {}) {
  if (!pincode) throw new Error('ServiceablePincode.pincode is required');
  const pc = String(pincode).trim();
  if (!/^[1-9][0-9]{5}$/.test(pc)) {
    throw new Error(`ServiceablePincode.pincode must be a 6-digit Indian PIN (got "${pc}")`);
  }
  const now = new Date();
  const autoTag = getCityForPincode(pc);
  return {
    _id: pc,
    pincode: pc,
    enabled: !!enabled,
    notes: notes || null,
    city: city || autoTag.city,
    state: state || autoTag.state,
    // Optional locality / neighbourhood within the PIN. No backfill —
    // pre-existing rows return null until populated by a future tool.
    area: area || null,
    created_at: now,
    updated_at: now,
  };
}

function findByPincode(pincode) {
  if (!pincode) return Promise.resolve(null);
  return col(COLLECTION).findOne({ pincode: String(pincode).trim() });
}

async function setEnabled(pincode, enabled) {
  const pc = String(pincode).trim();
  const res = await col(COLLECTION).findOneAndUpdate(
    { pincode: pc },
    { $set: { enabled: !!enabled, updated_at: new Date() } },
    { returnDocument: 'after' }
  );
  return res?.value || res || null;
}

async function toggle(pincode) {
  const pc = String(pincode).trim();
  const existing = await findByPincode(pc);
  if (!existing) return null;
  return setEnabled(pc, !existing.enabled);
}

// Upsert-on-insert for `enabled` (never overrides), but always refreshes
// city/state from the prefix map so legacy rows get tagged on re-import.
// Used by both the seed script and the admin CSV-import endpoint.
async function upsertIdempotent(pincode, notes = null) {
  const pc = String(pincode).trim();
  if (!/^[1-9][0-9]{5}$/.test(pc)) return { inserted: false, skipped: true };
  const now = new Date();
  const { city, state } = getCityForPincode(pc);
  const $set = { city, state, updated_at: now };
  if (notes) $set.notes = notes;
  const res = await col(COLLECTION).updateOne(
    { pincode: pc },
    {
      $set,
      $setOnInsert: {
        _id: pc,
        pincode: pc,
        enabled: true,
        created_at: now,
      },
    },
    { upsert: true }
  );
  return {
    inserted: res.upsertedCount > 0,
    skipped: res.upsertedCount === 0,
  };
}

// Bulk-set `enabled` on a list of pincodes. Returns the mongo
// updateMany result ({ matchedCount, modifiedCount }).
async function setEnabledBulk(pincodes, enabled) {
  const arr = (pincodes || [])
    .map((p) => String(p).trim())
    .filter((p) => /^[1-9][0-9]{5}$/.test(p));
  if (!arr.length) return { matchedCount: 0, modifiedCount: 0 };
  const res = await col(COLLECTION).updateMany(
    { pincode: { $in: arr } },
    { $set: { enabled: !!enabled, updated_at: new Date() } }
  );
  return { matchedCount: res.matchedCount, modifiedCount: res.modifiedCount };
}

module.exports = {
  COLLECTION,
  buildPincode,
  findByPincode,
  setEnabled,
  toggle,
  upsertIdempotent,
  setEnabledBulk,
};
