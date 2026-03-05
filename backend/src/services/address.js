// src/services/address.js
// Manages saved delivery addresses per customer (keyed by wa_phone)
// Allows repeat customers to pick a saved address instead of re-sharing GPS every order

const db = require('../config/database');

// Get up to 5 saved addresses, default first
async function getAddresses(waPhone) {
  const { rows } = await db.query(
    `SELECT id, label, full_address, landmark, flat_no,
            latitude, longitude, is_default
     FROM customer_addresses
     WHERE wa_phone = $1
     ORDER BY is_default DESC, created_at DESC
     LIMIT 5`,
    [waPhone]
  );
  return rows;
}

// Save a new delivery address
// makeDefault = true → unsets all other defaults first
async function saveAddress(waPhone, { label, fullAddress, landmark, flatNo, latitude, longitude, makeDefault = false }) {
  if (makeDefault) {
    await db.query(
      `UPDATE customer_addresses SET is_default = false WHERE wa_phone = $1`,
      [waPhone]
    );
  }
  const { rows } = await db.query(
    `INSERT INTO customer_addresses
       (wa_phone, label, full_address, landmark, flat_no, latitude, longitude, is_default)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [waPhone, label || 'Home', fullAddress || null, landmark || null,
     flatNo || null, latitude || null, longitude || null, makeDefault]
  );
  return rows[0];
}

// Returns true if a saved address already exists within radiusMeters of these coordinates
// Used to avoid prompting to save duplicate locations
async function isNearSavedAddress(waPhone, lat, lng, radiusMeters = 150) {
  const { rows } = await db.query(
    `SELECT id FROM customer_addresses
     WHERE wa_phone = $1
       AND latitude IS NOT NULL
       AND (
         6371000 * acos(
           LEAST(1.0,
             cos(radians($2)) * cos(radians(latitude)) *
             cos(radians(longitude) - radians($3)) +
             sin(radians($2)) * sin(radians(latitude))
           )
         )
       ) < $4`,
    [waPhone, parseFloat(lat), parseFloat(lng), radiusMeters]
  );
  return rows.length > 0;
}

// Change which address is the default
async function setDefault(waPhone, addressId) {
  await db.query(
    `UPDATE customer_addresses SET is_default = false WHERE wa_phone = $1`,
    [waPhone]
  );
  await db.query(
    `UPDATE customer_addresses SET is_default = true
     WHERE id = $1 AND wa_phone = $2`,
    [addressId, waPhone]
  );
}

// Remove a saved address
async function deleteAddress(waPhone, addressId) {
  await db.query(
    `DELETE FROM customer_addresses WHERE id = $1 AND wa_phone = $2`,
    [addressId, waPhone]
  );
}

module.exports = { getAddresses, saveAddress, isNearSavedAddress, setDefault, deleteAddress };
