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
  const start = Date.now();
  let resolvedUrl = url;

  // Resolve short links (maps.app.goo.gl, goo.gl/maps) with multiple strategies
  if (url.includes('maps.app.goo.gl') || url.includes('goo.gl/maps')) {
    resolvedUrl = await resolveShortUrl(url) || url;
    console.log(`[Perf] Maps URL resolve: ${Date.now() - start}ms → ${resolvedUrl.substring(0, 80)}`);
  }

  // Try extracting coordinates from multiple URL patterns
  const patterns = [
    /[@/](-?\d+\.\d{3,}),\s*(-?\d+\.\d{3,})/,     // @17.385,78.486 or /17.385,78.486
    /[?&]q=(-?\d+\.\d+),\s*(-?\d+\.\d+)/,           // ?q=17.385,78.486
    /ll=(-?\d+\.\d+),\s*(-?\d+\.\d+)/,               // ll=17.385,78.486
    /center=(-?\d+\.\d+),\s*(-?\d+\.\d+)/,           // center=17.385,78.486
    /!3d(-?\d+\.\d+).*!4d(-?\d+\.\d+)/,              // !3d17.385!4d78.486 (embed)
  ];

  for (const pattern of patterns) {
    const match = resolvedUrl.match(pattern);
    if (match) {
      const lat = parseFloat(match[1]);
      const lng = parseFloat(match[2]);
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        console.log(`[Location] Extracted coords: ${lat}, ${lng} (${Date.now() - start}ms)`);
        return { lat, lng };
      }
    }
  }

  // Fallback: try place name geocoding
  const placeMatch = resolvedUrl.match(/place\/([^/@]+)/);
  if (placeMatch) {
    const placeName = decodeURIComponent(placeMatch[1].replace(/\+/g, ' '));
    console.log('[Location] Trying place name geocode:', placeName);
    return await geocodePlaceName(placeName);
  }

  console.warn(`[Location] Could not extract coords from URL (${Date.now() - start}ms)`);
  return null;
}

// Resolve Google Maps short URLs with multiple fallback strategies
async function resolveShortUrl(shortUrl) {
  const axios = require('axios');
  const BROWSER_UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

  // Strategy 1: HEAD request with manual redirect — fastest
  try {
    const resp = await axios.head(shortUrl, {
      maxRedirects: 0,
      timeout: 8000,
      validateStatus: s => s >= 300 && s < 400,
      headers: { 'User-Agent': BROWSER_UA },
    });
    const loc = resp.headers?.location;
    if (loc && !loc.includes('goo.gl')) return loc;
    // If still a short URL, follow one more hop
    if (loc) {
      const resp2 = await axios.head(loc, { maxRedirects: 0, timeout: 5000, validateStatus: s => s >= 300 && s < 400, headers: { 'User-Agent': BROWSER_UA } });
      if (resp2.headers?.location) return resp2.headers.location;
    }
  } catch (e) {
    if (e.response?.headers?.location) return e.response.headers.location;
    console.warn('[Location] Strategy 1 (HEAD) failed:', e.message);
  }

  // Strategy 2: GET with auto-follow — slower but handles JS redirects
  try {
    const resp = await axios.get(shortUrl, {
      maxRedirects: 5,
      timeout: 12000,
      validateStatus: () => true,
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
    });
    const finalUrl = resp.request?.res?.responseUrl;
    if (finalUrl && finalUrl !== shortUrl) return finalUrl;

    // Check HTML body for meta refresh or JS redirect
    const html = typeof resp.data === 'string' ? resp.data : '';
    const metaMatch = html.match(/content=["']0;\s*url=([^"']+)/i);
    if (metaMatch) return metaMatch[1];
    const jsMatch = html.match(/window\.location\s*=\s*["']([^"']+)/);
    if (jsMatch) return jsMatch[1];
  } catch (e) {
    console.warn('[Location] Strategy 2 (GET follow) failed:', e.message);
  }

  return null;
}

// Geocode a place name to coordinates via Google Maps API
async function geocodePlaceName(placeName) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  const axios = require('axios');
  try {
    const { data } = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { address: placeName, key: apiKey },
      timeout: 8000,
    });
    if (data.results?.length) {
      const r = data.results[0];
      return { lat: r.geometry.location.lat, lng: r.geometry.location.lng };
    }
  } catch (e) {
    console.warn('[Location] Place name geocode failed:', e.message);
  }
  return null;
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
