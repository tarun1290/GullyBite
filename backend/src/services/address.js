// src/services/address.js
// Manages saved delivery addresses per customer
// [BSUID] Supports lookup by customer_id (preferred) or wa_phone (legacy)
// Allows repeat customers to pick a saved address instead of re-sharing GPS every order

const { col, newId } = require('../config/database');
const { haversineKm } = require('./location');

// [BSUID] Build query filter — supports customer_id or wa_phone
function _customerFilter(identifier) {
  if (typeof identifier === 'object' && identifier.customer_id) {
    return { customer_id: identifier.customer_id };
  }
  // Legacy: plain wa_phone string
  return { wa_phone: identifier };
}

// Get up to 5 saved addresses, default first
async function getAddresses(identifier) {
  const docs = await col('customer_addresses')
    .find(_customerFilter(identifier))
    .sort({ is_default: -1, created_at: -1 })
    .limit(5)
    .toArray();
  return docs.map(d => ({ ...d, id: String(d._id) }));
}

// Save a new delivery address
// [BSUID] identifier can be wa_phone string or { customer_id, wa_phone }
async function saveAddress(identifier, { label, fullAddress, landmark, flatNo, latitude, longitude, makeDefault = false }) {
  const now = new Date();
  const filter = _customerFilter(identifier);
  if (makeDefault) {
    await col('customer_addresses').updateMany(filter, { $set: { is_default: false } });
  }
  const doc = {
    _id: newId(),
    // Store both customer_id and wa_phone for backward compat
    customer_id: typeof identifier === 'object' ? identifier.customer_id : null,
    wa_phone: typeof identifier === 'object' ? (identifier.wa_phone || null) : identifier,
    label: label || 'Home',
    full_address: fullAddress || null,
    landmark: landmark || null,
    flat_no: flatNo || null,
    latitude: latitude || null,
    longitude: longitude || null,
    is_default: makeDefault,
    created_at: now,
  };
  await col('customer_addresses').insertOne(doc);
  return { ...doc, id: String(doc._id) };
}

// Returns true if a saved address already exists within radiusMeters of these coordinates
async function isNearSavedAddress(identifier, lat, lng, radiusMeters = 150) {
  const addresses = await col('customer_addresses').find({
    ..._customerFilter(identifier),
    latitude: { $ne: null },
    longitude: { $ne: null },
  }).toArray();

  const radiusKm = radiusMeters / 1000;
  return addresses.some(a =>
    haversineKm(parseFloat(lat), parseFloat(lng), parseFloat(a.latitude), parseFloat(a.longitude)) < radiusKm
  );
}

// Change which address is the default
async function setDefault(identifier, addressId) {
  const filter = _customerFilter(identifier);
  await col('customer_addresses').updateMany(filter, { $set: { is_default: false } });
  await col('customer_addresses').updateOne({ _id: addressId, ...filter }, { $set: { is_default: true } });
}

// Remove a saved address
async function deleteAddress(identifier, addressId) {
  await col('customer_addresses').deleteOne({ _id: addressId, ..._customerFilter(identifier) });
}

module.exports = { getAddresses, saveAddress, isNearSavedAddress, setDefault, deleteAddress };
