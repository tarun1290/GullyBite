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

// ─── GOOGLE MAPS URL PARSING ────────────────────────────────
// Detects and extracts coordinates from Google Maps URLs shared as text
const MAPS_URL_REGEX = /https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|www\.google\.com\/maps|maps\.google\.com|google\.com\/maps)[^\s)]+/i;

function isMapsUrl(text) {
  return MAPS_URL_REGEX.test(text);
}

async function extractCoordsFromMapsUrl(url) {
  let resolvedUrl = url;

  // Resolve short links (maps.app.goo.gl, goo.gl/maps)
  if (url.includes('maps.app.goo.gl') || url.includes('goo.gl/maps')) {
    try {
      const axios = require('axios');
      const resp = await axios.get(url, { maxRedirects: 5, timeout: 5000, validateStatus: () => true });
      resolvedUrl = resp.request?.res?.responseUrl || resp.headers?.location || url;
    } catch (e) {
      console.warn('[Location] Failed to resolve short URL:', e.message);
    }
  }

  let lat, lng;

  // Pattern 1: @17.385,78.486 or /17.385,78.486
  const atMatch = resolvedUrl.match(/[@/](-?\d+\.\d{3,}),(-?\d+\.\d{3,})/);
  if (atMatch) { lat = parseFloat(atMatch[1]); lng = parseFloat(atMatch[2]); }

  // Pattern 2: ?q=17.385,78.486
  if (!lat) {
    const qMatch = resolvedUrl.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (qMatch) { lat = parseFloat(qMatch[1]); lng = parseFloat(qMatch[2]); }
  }

  // Pattern 3: !3d17.385!4d78.486 (embedded format)
  if (!lat) {
    const embMatch = resolvedUrl.match(/!3d(-?\d+\.\d+).*!4d(-?\d+\.\d+)/);
    if (embMatch) { lat = parseFloat(embMatch[1]); lng = parseFloat(embMatch[2]); }
  }

  if (!lat || !lng) {
    // Try to extract place name as fallback
    const placeMatch = resolvedUrl.match(/place\/([^/@]+)/);
    if (placeMatch) {
      console.log('[Location] Extracted place name:', decodeURIComponent(placeMatch[1]));
    }
    return null;
  }

  // Validate coordinates are reasonable
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  return { lat, lng };
}

// ─── REVERSE GEOCODING ──────────────────────────────────────
// Uses Google Maps Geocoding API to get a full address from coordinates.
// GOOGLE_MAPS_API_KEY is required.
async function reverseGeocode(lat, lng) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  const axios = require('axios');
  const { data } = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
    params: { latlng: `${lat},${lng}`, key: apiKey },
    timeout: 5000,
  });

  if (data.results?.length) {
    const r = data.results[0];
    const get = (type) => r.address_components?.find(c => c.types.includes(type))?.long_name || '';
    return {
      lat, lng,
      address: r.formatted_address,
      place_id: r.place_id,
      area: get('sublocality_level_1') || get('sublocality'),
      city: get('locality'),
      state: get('administrative_area_level_1'),
      pincode: get('postal_code'),
      source: 'geocode',
    };
  }

  console.error('[Location] Geocoding returned no results for:', lat, lng);
  return null;
}

module.exports = { findNearestBranch, haversineKm, isMapsUrl, extractCoordsFromMapsUrl, reverseGeocode };
