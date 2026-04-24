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
async function saveAddress(identifier, {
  label, fullAddress, landmark, flatNo, latitude, longitude, makeDefault = false,
  // Enhanced fields (v2)
  type, receiverName, receiverPhone, buildingFloor, street, areaLocality, city, pincode,
  deliveryInstructions,
  // Google Places integration — populated when address was picked from
  // Places Autocomplete. place_id lets us re-resolve, locality is the
  // human label shown to the user.
  placeId, locality,
  // v3 fields — server-side geocoded structured address from the
  // NEW_ADDRESS Flow. recipient_name/delivery_phone are per-delivery
  // (the receiver may differ from the WA account holder); house_number
  // and building_street replace the older buildingFloor/street pair.
  recipientName, deliveryPhone, houseNumber, buildingStreet,
  formattedAddress, geocodedAt,
} = {}) {
  const now = new Date();
  const filter = _customerFilter(identifier);
  if (makeDefault) {
    await col('customer_addresses').updateMany(filter, { $set: { is_default: false } });
  }
  const _recipient = recipientName || receiverName || null;
  const _delivery  = deliveryPhone || receiverPhone || null;
  const _house     = houseNumber || buildingFloor || flatNo || null;
  const _street    = buildingStreet || street || null;
  const _formatted = formattedAddress || fullAddress || null;
  const _lat       = latitude != null ? latitude : null;
  const _lng       = longitude != null ? longitude : null;
  const doc = {
    _id: newId(),
    customer_id: typeof identifier === 'object' ? identifier.customer_id : null,
    wa_phone: typeof identifier === 'object' ? (identifier.wa_phone || null) : identifier,
    label: label || 'Home',
    type: type || null,                            // home | office | other
    full_address: _formatted,
    formatted_address: _formatted,
    // v3 receiver fields (per-delivery contact)
    recipient_name: _recipient,
    delivery_phone: _delivery,
    // Legacy receiver alias — kept populated so older readers still work
    receiver_name: _recipient,
    receiver_phone: _delivery,
    // Structured address fields
    house_number: _house,
    building_street: _street,
    // Legacy aliases — kept populated for backward compat with v1/v2 readers
    building_floor: _house,
    street: _street,
    area_locality: areaLocality || null,
    city: city || null,
    pincode: pincode || null,
    landmark: landmark || null,
    // Legacy compat
    flat_no: _house,
    // GPS — from server-side geocoding (may be null if geocode failed)
    lat: _lat,
    lng: _lng,
    latitude: _lat,
    longitude: _lng,
    geocoded_at: geocodedAt || (_lat != null ? now : null),
    // Delivery
    delivery_instructions: deliveryInstructions || null,
    // Google Places
    place_id: placeId || null,
    locality: locality || areaLocality || null,
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
