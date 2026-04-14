// src/services/addressBook.service.js
// Phase 1: GLOBAL customer address book — a customer's saved "Home"
// is the same Home regardless of which restaurant they're ordering
// from, so addresses are keyed by customer_id with no tenant scope.
//
// Named `addressBook` (not `address`) to avoid a collision with the
// existing `src/services/address.js` (legacy geocoding helper used by
// the WhatsApp webhook). If you're looking for geocoding, that still
// lives in the old module — this file is only the saved-address store.
//
// Audit invariant: orders freeze a snapshot (orders.address_snapshot)
// at order time. Mutating a row here MUST NOT rewrite history.

'use strict';

const { col, newId } = require('../config/database');

const COLLECTION = 'customer_addresses';

function _norm(s) {
  return s == null ? null : String(s).trim() || null;
}

async function list(customerId) {
  if (!customerId) return [];
  return col(COLLECTION)
    .find({ customer_id: String(customerId) })
    .sort({ is_default: -1, updated_at: -1 })
    .toArray();
}

function findById(id) {
  if (!id) return Promise.resolve(null);
  return col(COLLECTION).findOne({ _id: String(id) });
}

async function getDefault(customerId) {
  if (!customerId) return null;
  const def = await col(COLLECTION).findOne(
    { customer_id: String(customerId), is_default: true }
  );
  if (def) return def;
  // Fallback: most-recently-updated if no explicit default set.
  return col(COLLECTION).findOne(
    { customer_id: String(customerId) },
    { sort: { updated_at: -1 } }
  );
}

// Creating an address with is_default=true demotes any prior default
// in a single pass. We do demote-then-insert rather than insert-then-
// demote so a reader never sees two defaults simultaneously.
async function create(customerId, input = {}) {
  if (!customerId) throw new Error('create: customerId is required');
  if (!input.address_line) throw new Error('create: address_line is required');

  const doc = {
    _id: newId(),
    customer_id: String(customerId),
    label:        _norm(input.label) || 'Home',
    address_line: _norm(input.address_line),
    landmark:     _norm(input.landmark),
    pincode:      _norm(input.pincode),
    city:         _norm(input.city),
    state:        _norm(input.state),
    latitude:     input.latitude != null ? Number(input.latitude) : null,
    longitude:    input.longitude != null ? Number(input.longitude) : null,
    is_default:   !!input.is_default,
    created_at:   new Date(),
    updated_at:   new Date(),
  };

  if (doc.is_default) {
    await col(COLLECTION).updateMany(
      { customer_id: doc.customer_id, is_default: true },
      { $set: { is_default: false, updated_at: new Date() } }
    );
  } else {
    // If the customer has no addresses yet, make this one the default.
    const hasAny = await col(COLLECTION).findOne({ customer_id: doc.customer_id });
    if (!hasAny) doc.is_default = true;
  }

  await col(COLLECTION).insertOne(doc);
  return doc;
}

// Partial update. Ownership check enforced at the caller (tenantGuard
// resolves the customer from the session); here we still guard by
// (id, customer_id) so a rogue address id can't be overwritten.
async function update(id, customerId, patch = {}) {
  if (!id || !customerId) throw new Error('update: id and customerId required');
  const allow = ['label', 'address_line', 'landmark', 'pincode', 'city', 'state', 'latitude', 'longitude'];
  const $set = { updated_at: new Date() };
  for (const k of allow) if (k in patch) $set[k] = patch[k];

  await col(COLLECTION).updateOne(
    { _id: String(id), customer_id: String(customerId) },
    { $set }
  );
  return findById(id);
}

async function setDefault(id, customerId) {
  if (!id || !customerId) throw new Error('setDefault: id and customerId required');
  const target = await col(COLLECTION).findOne({ _id: String(id), customer_id: String(customerId) });
  if (!target) return null;

  await col(COLLECTION).updateMany(
    { customer_id: String(customerId), is_default: true },
    { $set: { is_default: false, updated_at: new Date() } }
  );
  await col(COLLECTION).updateOne(
    { _id: String(id), customer_id: String(customerId) },
    { $set: { is_default: true, updated_at: new Date() } }
  );
  return findById(id);
}

async function remove(id, customerId) {
  if (!id || !customerId) return false;
  const target = await col(COLLECTION).findOne({ _id: String(id), customer_id: String(customerId) });
  if (!target) return false;
  await col(COLLECTION).deleteOne({ _id: String(id), customer_id: String(customerId) });

  // If we just deleted the default, promote the most-recently-updated
  // remaining address so the customer isn't left without a default.
  if (target.is_default) {
    const next = await col(COLLECTION).findOne(
      { customer_id: String(customerId) },
      { sort: { updated_at: -1 } }
    );
    if (next) {
      await col(COLLECTION).updateOne(
        { _id: next._id },
        { $set: { is_default: true, updated_at: new Date() } }
      );
    }
  }
  return true;
}

// Freeze an address into a plain object suitable for orders.address_snapshot.
// Strips mutable/unstable fields (_id, updated_at, is_default) that don't
// make sense on a historical record.
function snapshot(address) {
  if (!address) return null;
  return {
    label: address.label || null,
    address_line: address.address_line || null,
    landmark: address.landmark || null,
    pincode: address.pincode || null,
    city: address.city || null,
    state: address.state || null,
    latitude: address.latitude ?? null,
    longitude: address.longitude ?? null,
    captured_at: new Date(),
  };
}

module.exports = {
  COLLECTION,
  list,
  findById,
  getDefault,
  create,
  update,
  setDefault,
  remove,
  snapshot,
};
