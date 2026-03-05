// src/services/location.js
// Finds the nearest restaurant branch to a customer's GPS coordinates
// Uses the Haversine formula (standard spherical distance calculation)

const db = require('../config/database');

// ─── HAVERSINE FORMULA ────────────────────────────────────────
// Calculates "as the crow flies" distance between two GPS points
// Returns distance in kilometers
//
// Why Haversine? GPS coordinates are on a sphere (Earth),
// not a flat plane. Regular Pythagorean distance would be wrong.
// Haversine accounts for Earth's curvature.
const haversineKm = (lat1, lng1, lat2, lng2) => {
  const R = 6371; // Earth radius in km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const toRad = (deg) => (deg * Math.PI) / 180;

// ─── FIND NEAREST BRANCH ──────────────────────────────────────
// Given customer's GPS coordinates, returns the closest branch
// that is:
//   1. Currently open (is_open = true)
//   2. Accepting orders (accepts_orders = true)  
//   3. Within its own delivery radius of the customer
//
// Also fetches the WhatsApp account credentials for that branch
// so we can send messages without additional DB calls
//
// Returns:
//   { found: true, branch: { ... } }   -- if a branch was found
//   { found: false, message: '...' }   -- if none found, with explanation
const findNearestBranch = async (customerLat, customerLng, restaurantId = null) => {
  // Fetch all open branches (optionally filtered by restaurant)
  const { rows } = await db.query(`
    SELECT
      b.id,
      b.name AS branch_name,
      b.address,
      b.city,
      b.latitude,
      b.longitude,
      b.delivery_radius_km,
      b.opening_time,
      b.closing_time,
      b.manager_phone,
      b.catalog_id        AS branch_catalog_id,
      b.catalog_synced_at,
      r.id AS restaurant_id,
      r.business_name,
      r.logo_url,
      wa.id AS wa_account_id,
      wa.phone_number_id,
      wa.access_token,
      wa.display_name AS wa_display_name
    FROM branches b
    JOIN restaurants r ON b.restaurant_id = r.id
    LEFT JOIN whatsapp_accounts wa ON wa.restaurant_id = r.id AND wa.is_active = TRUE
    WHERE b.is_open = TRUE
      AND b.accepts_orders = TRUE
      AND r.status = 'active'
      ${restaurantId ? 'AND r.id = $1' : ''}
    ORDER BY b.created_at
  `, restaurantId ? [restaurantId] : []);

  if (rows.length === 0) {
    return {
      found: false,
      message: '😔 Sorry, no restaurants are currently available. Please try again later!',
    };
  }

  // Calculate distance to each branch
  const withDistance = rows.map((branch) => ({
    ...branch,
    distanceKm: haversineKm(
      parseFloat(customerLat),
      parseFloat(customerLng),
      parseFloat(branch.latitude),
      parseFloat(branch.longitude)
    ),
  }));

  // Sort by distance (nearest first)
  withDistance.sort((a, b) => a.distanceKm - b.distanceKm);

  // Filter branches that deliver to the customer's location
  const deliverable = withDistance.filter(
    (b) => b.distanceKm <= parseFloat(b.delivery_radius_km)
  );

  if (deliverable.length === 0) {
    const closest = withDistance[0];
    return {
      found: false,
      message:
        `😔 Sorry, we don't deliver to your location yet.\n\n` +
        `Nearest outlet: *${closest.branch_name}* (${closest.distanceKm.toFixed(1)} km away)\n` +
        `Our current delivery radius is ${closest.delivery_radius_km} km from that outlet.\n\n` +
        `We're expanding soon! 🚀`,
    };
  }

  const best = deliverable[0]; // The closest deliverable branch
  return {
    found: true,
    branch: {
      id: best.id,
      name: best.branch_name,
      address: best.address,
      city: best.city,
      distanceKm: best.distanceKm.toFixed(1),
      restaurantId: best.restaurant_id,
      businessName: best.business_name,
      waAccountId: best.wa_account_id,
      phoneNumberId: best.phone_number_id,
      accessToken: best.access_token,
      catalogId: best.branch_catalog_id,   // from branches.catalog_id (per-branch)
      catalogSyncedAt: best.catalog_synced_at,
    },
  };
};

module.exports = { findNearestBranch, haversineKm };