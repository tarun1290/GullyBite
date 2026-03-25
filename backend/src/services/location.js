// src/services/location.js
// Finds the nearest restaurant branch to a customer's GPS coordinates
// Uses the Haversine formula (standard spherical distance calculation)

const { col } = require('../config/database');

// ─── HAVERSINE FORMULA ────────────────────────────────────────
const haversineKm = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const toRad = (deg) => (deg * Math.PI) / 180;

// ─── FIND NEAREST BRANCH ──────────────────────────────────────
const findNearestBranch = async (customerLat, customerLng, restaurantId = null) => {
  const branchFilter = { is_open: true, accepts_orders: true };
  if (restaurantId) branchFilter.restaurant_id = restaurantId;

  const branches = await col('branches').find(branchFilter).toArray();

  // Filter to branches whose restaurant is active
  const activeBranches = await Promise.all(
    branches.map(async b => {
      const restaurant = await col('restaurants').findOne({ _id: b.restaurant_id, status: 'active' });
      if (!restaurant) return null;
      const wa_acc = await col('whatsapp_accounts').findOne({ restaurant_id: b.restaurant_id, is_active: true });
      return { branch: b, restaurant, wa_acc };
    })
  ).then(results => results.filter(Boolean));

  if (!activeBranches.length) {
    return {
      found: false,
      message: '😔 Sorry, no restaurants are currently available. Please try again later!',
    };
  }

  const withDistance = activeBranches.map(({ branch, restaurant, wa_acc }) => ({
    branch,
    restaurant,
    wa_acc,
    distanceKm: haversineKm(
      parseFloat(customerLat), parseFloat(customerLng),
      parseFloat(branch.latitude), parseFloat(branch.longitude)
    ),
  }));

  withDistance.sort((a, b) => a.distanceKm - b.distanceKm);

  const deliverable = withDistance.filter(
    r => r.distanceKm <= parseFloat(r.branch.delivery_radius_km)
  );

  if (!deliverable.length) {
    const closest = withDistance[0];
    return {
      found: false,
      message:
        `😔 Sorry, we don't deliver to your location yet.\n\n` +
        `Nearest outlet: *${closest.branch.name}* (${closest.distanceKm.toFixed(1)} km away)\n` +
        `Our current delivery radius is ${closest.branch.delivery_radius_km} km from that outlet.\n\n` +
        `We're expanding soon! 🚀`,
    };
  }

  const { branch, restaurant, wa_acc, distanceKm } = deliverable[0];
  return {
    found: true,
    branch: {
      id:            String(branch._id),
      name:          branch.name,
      address:       branch.address,
      city:          branch.city,
      distanceKm:    distanceKm.toFixed(1),
      restaurantId:  branch.restaurant_id,
      businessName:  restaurant.business_name,
      waAccountId:   wa_acc ? String(wa_acc._id) : null,
      phoneNumberId: wa_acc?.phone_number_id || null,
      accessToken:   wa_acc?.access_token || null,
      catalogId:     restaurant.meta_catalog_id || branch.catalog_id,
      catalogSyncedAt: branch.catalog_synced_at,
    },
  };
};

module.exports = { findNearestBranch, haversineKm };
