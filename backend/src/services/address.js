// src/services/address.js
// Manages saved delivery addresses per customer (keyed by wa_phone)
// Allows repeat customers to pick a saved address instead of re-sharing GPS every order

const { col, newId } = require('../config/database');
const { haversineKm } = require('./location');

// Get up to 5 saved addresses, default first
async function getAddresses(waPhone) {
  const docs = await col('customer_addresses')
    .find({ wa_phone: waPhone })
    .sort({ is_default: -1, created_at: -1 })
    .limit(5)
    .toArray();
  return docs.map(d => ({ ...d, id: String(d._id) }));
}

// Save a new delivery address
async function saveAddress(waPhone, { label, fullAddress, landmark, flatNo, latitude, longitude, makeDefault = false }) {
  const now = new Date();
  if (makeDefault) {
    await col('customer_addresses').updateMany({ wa_phone: waPhone }, { $set: { is_default: false } });
  }
  const doc = {
    _id: newId(),
    wa_phone: waPhone,
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
async function isNearSavedAddress(waPhone, lat, lng, radiusMeters = 150) {
  const addresses = await col('customer_addresses').find({
    wa_phone: waPhone,
    latitude: { $ne: null },
    longitude: { $ne: null },
  }).toArray();

  const radiusKm = radiusMeters / 1000;
  return addresses.some(a =>
    haversineKm(parseFloat(lat), parseFloat(lng), parseFloat(a.latitude), parseFloat(a.longitude)) < radiusKm
  );
}

// Change which address is the default
async function setDefault(waPhone, addressId) {
  await col('customer_addresses').updateMany({ wa_phone: waPhone }, { $set: { is_default: false } });
  await col('customer_addresses').updateOne({ _id: addressId, wa_phone: waPhone }, { $set: { is_default: true } });
}

// Remove a saved address
async function deleteAddress(waPhone, addressId) {
  await col('customer_addresses').deleteOne({ _id: addressId, wa_phone: waPhone });
}

module.exports = { getAddresses, saveAddress, isNearSavedAddress, setDefault, deleteAddress };
