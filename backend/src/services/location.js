// src/services/location.js
// Finds the nearest restaurant branch to a customer's GPS coordinates
// Uses the Haversine formula (standard spherical distance calculation)

const { col } = require('../config/database');
const log = require('../utils/logger').child({ component: 'Location' });

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
const MAPS_URL_REGEX = /(?:https?:\/\/)?(maps\.app\.goo\.gl|goo\.gl\/maps|(?:www\.)?google\.(?:com|co\.\w+)\/maps|maps\.google\.(?:com|co\.\w+))[^\s)]+/i;

function isMapsUrl(text) {
  return MAPS_URL_REGEX.test(text);
}

// Extract just the URL from message text (message may contain surrounding text)
function extractMapsUrl(text) {
  const match = text.match(MAPS_URL_REGEX);
  if (!match) return null;
  let url = match[0];
  // Ensure https:// prefix for HTTP calls
  if (!url.startsWith('http')) url = 'https://' + url;
  return url;
}

async function extractCoordsFromMapsUrl(url) {
  const start = Date.now();
  let resolvedUrl = url;

  // Resolve short links (maps.app.goo.gl, goo.gl/maps) with multiple strategies
  if (url.includes('maps.app.goo.gl') || url.includes('goo.gl/maps')) {
    resolvedUrl = await resolveShortUrl(url) || url;
    log.info({ resolveMs: Date.now() - start }, 'Maps URL resolved');
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
        log.info({ lat, lng, extractMs: Date.now() - start }, 'Extracted coords from URL');
        return { lat, lng };
      }
    }
  }

  // Fallback: try place name geocoding
  const placeMatch = resolvedUrl.match(/place\/([^/@]+)/);
  if (placeMatch) {
    const placeName = decodeURIComponent(placeMatch[1].replace(/\+/g, ' '));
    log.info({ placeName }, 'Trying place name geocode');
    return await geocodePlaceName(placeName);
  }

  log.warn({ extractMs: Date.now() - start }, 'Could not extract coords from URL');
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
      timeout: 3000,
      validateStatus: s => s >= 300 && s < 400,
      headers: { 'User-Agent': BROWSER_UA },
    });
    const loc = resp.headers?.location;
    if (loc && !loc.includes('goo.gl')) return loc;
    // If still a short URL, follow one more hop
    if (loc) {
      const resp2 = await axios.head(loc, { maxRedirects: 0, timeout: 3000, validateStatus: s => s >= 300 && s < 400, headers: { 'User-Agent': BROWSER_UA } });
      if (resp2.headers?.location) return resp2.headers.location;
    }
  } catch (e) {
    if (e.response?.headers?.location) return e.response.headers.location;
    log.warn({ err: e }, 'Strategy 1 (HEAD) failed');
  }

  // Strategy 2: GET with auto-follow — slower but handles JS redirects
  try {
    const resp = await axios.get(shortUrl, {
      maxRedirects: 5,
      timeout: 5000,
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
    log.warn({ err: e }, 'Strategy 2 (GET follow) failed');
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
    log.warn({ err: e }, 'Place name geocode failed');
  }
  return null;
}

// ─── FORWARD GEOCODING ──────────────────────────────────────
// Converts address text to coordinates + formatted address
async function forwardGeocode(addressText) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) { log.error('GOOGLE_MAPS_API_KEY not set'); return null; }
  if (!addressText?.trim()) return null;
  try {
    const { data } = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { address: addressText.trim(), key: apiKey, region: 'in' },
      timeout: 8000,
    });
    if (data.results?.length) {
      const r = data.results[0];
      const comps = r.address_components || [];
      const getComp = (type) => comps.find(c => c.types.includes(type))?.long_name || null;
      return {
        lat: r.geometry.location.lat,
        lng: r.geometry.location.lng,
        address: r.formatted_address,
        full_address: r.formatted_address,
        city: getComp('locality') || getComp('administrative_area_level_2'),
        pin_code: getComp('postal_code'),
        area: getComp('sublocality_level_1') || getComp('sublocality'),
        source: 'forward_geocode',
      };
    }
    log.warn({ addressText }, 'Forward geocode returned no results');
    return null;
  } catch (e) {
    log.error({ err: e }, 'Forward geocode failed');
    return null;
  }
}

// ─── GEOCODE STRUCTURED ADDRESS ─────────────────────────────
// Forward-geocodes a structured Indian address (the Flow NEW_ADDRESS
// payload) to coordinates + Google's canonical formatted_address.
// Reuses GOOGLE_MAPS_API_KEY (the key everything else in this file
// uses); GOOGLE_GEOCODING_API_KEY is checked as a secondary name in
// case future infra splits the keys.
//
// Always resolves — never throws. Returns
// { lat, lng, formatted_address } where any field may be null. The
// caller (nfm_reply handler) treats null coords as non-fatal so the
// address still saves and the order flow continues.
async function geocodeAddress(addressObj = {}) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_GEOCODING_API_KEY;
  if (!apiKey) {
    console.warn('[GEOCODE] GOOGLE_MAPS_API_KEY / GOOGLE_GEOCODING_API_KEY not set — geocoding disabled');
    return { lat: null, lng: null, formatted_address: null };
  }

  const {
    house_number, building_street, area_locality, city, pincode,
  } = addressObj || {};

  const parts = [
    [house_number, building_street].filter(Boolean).join(' ').trim(),
    area_locality,
    city,
    pincode,
    'India',
  ].map(p => (typeof p === 'string' ? p.trim() : p)).filter(Boolean);

  if (parts.length < 3) {
    return { lat: null, lng: null, formatted_address: null };
  }

  const query = parts.join(', ');

  try {
    const axios = require('axios');
    const { data } = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: {
        address: query,
        key: apiKey,
        region: 'in',
        components: 'country:IN',
      },
      timeout: 8000,
    });

    if (data.status !== 'OK' || !data.results?.length) {
      log.warn({ query, status: data.status }, '[GEOCODE] No results');
      return { lat: null, lng: null, formatted_address: null };
    }

    const r = data.results[0];
    const lat = r.geometry?.location?.lat ?? null;
    const lng = r.geometry?.location?.lng ?? null;
    const formatted_address = r.formatted_address || null;
    console.log(`[GEOCODE] ${city || ''}, ${pincode || ''} → ${lat},${lng}`);
    return { lat, lng, formatted_address };
  } catch (e) {
    console.warn(`[GEOCODE] Error: ${e.message}`);
    return { lat: null, lng: null, formatted_address: null };
  }
}

// ─── REVERSE GEOCODING ──────────────────────────────────────
// Uses Google Maps Geocoding API to get a full address from coordinates.
// GOOGLE_MAPS_API_KEY is required.
async function reverseGeocode(lat, lng) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    log.error('GOOGLE_MAPS_API_KEY is not set — geocoding will not work');
    return null;
  }

  // Cache check — round to 4 decimal places (~11m precision)
  const cacheKey = `geocode:${parseFloat(lat).toFixed(4)}:${parseFloat(lng).toFixed(4)}`;
  try {
    const cached = await col('_cache').findOne({ _id: cacheKey, expires_at: { $gt: new Date() } });
    if (cached?.data) return cached.data;
  } catch (_) {}

  const axios = require('axios');
  try {
    const { data } = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { latlng: `${lat},${lng}`, key: apiKey },
      timeout: 8000,
    });

    if (data.status === 'REQUEST_DENIED') {
      log.error({ errorMessage: data.error_message }, 'Geocoding API denied — check API key and ensure Geocoding API is enabled');
      return null;
    }

    if (data.results?.length) {
      const r = data.results[0];
      const get = (type) => r.address_components?.find(c => c.types.includes(type))?.long_name || '';
      const result = {
        lat, lng,
        address: r.formatted_address,
        place_id: r.place_id,
        area: get('sublocality_level_1') || get('sublocality'),
        city: get('locality'),
        state: get('administrative_area_level_1'),
        pincode: get('postal_code'),
        source: 'geocode',
      };
      // Cache for 24 hours
      col('_cache').updateOne({ _id: cacheKey }, { $set: { data: result, expires_at: new Date(Date.now() + 24 * 3600000) } }, { upsert: true }).catch(() => {});
      return result;
    }

    log.warn({ lat, lng }, 'Geocoding returned no results');
    return null;
  } catch (e) {
    log.error({ err: e }, 'Geocoding request failed');
    return null;
  }
}

// ─── PLACE DETAILS ───────────────────────────────────────────
// Resolves a Google Places (New API) placeId to coordinates + formatted
// address. Used after the Delivery Address flow returns a place_id from
// the Autocomplete dropdown (see routes/flowAddress.js). Returns null if
// the API key is missing or the lookup fails — callers should fall back
// to forwardGeocode on the user-entered text.
async function placeDetails(placeId) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) { log.error('GOOGLE_MAPS_API_KEY is not set — placeDetails disabled'); return null; }
  if (!placeId) return null;
  const axios = require('axios');
  try {
    const { data } = await axios.get(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'id,location,formattedAddress,displayName,addressComponents',
      },
      timeout: 8000,
    });
    const loc = data?.location;
    if (!loc) { log.warn({ placeId }, 'placeDetails: no location on response'); return null; }
    const comps = Array.isArray(data.addressComponents) ? data.addressComponents : [];
    const getComp = (type) => comps.find(c => (c.types || []).includes(type))?.longText || null;
    return {
      lat: Number(loc.latitude),
      lng: Number(loc.longitude),
      place_id: data.id || placeId,
      address: data.formattedAddress || data.displayName?.text || null,
      full_address: data.formattedAddress || null,
      city: getComp('locality') || getComp('administrative_area_level_2'),
      pincode: getComp('postal_code'),
      area: getComp('sublocality_level_1') || getComp('sublocality'),
      state: getComp('administrative_area_level_1'),
      source: 'places_details',
    };
  } catch (e) {
    log.warn({ err: e.message, status: e.response?.status, placeId }, 'placeDetails failed');
    return null;
  }
}

// ─── IS BRANCH OPEN ──────────────────────────────────────────
// Checks if a branch is currently open based on operating_hours or opening_time/closing_time.
// If no hours are set, assumes always open (backward compatible).
function isBranchOpen(branch) {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffset);
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayName = dayNames[ist.getUTCDay()];
  const currentTime = ist.getUTCHours() * 100 + ist.getUTCMinutes(); // HHMM format

  // Per-day operating_hours (if set)
  if (branch.operating_hours) {
    const dayHours = branch.operating_hours[dayName];
    if (!dayHours) return true; // Day not configured = open
    if (dayHours.is_closed) return false;
    const open = parseTime(dayHours.open || '00:00');
    const close = parseTime(dayHours.close || '23:59');
    if (close <= open) return currentTime >= open || currentTime <= close;
    return currentTime >= open && currentTime <= close;
  }

  // Fallback to simple opening_time / closing_time
  if (branch.opening_time && branch.closing_time) {
    const open = parseTime(branch.opening_time);
    const close = parseTime(branch.closing_time);
    if (close <= open) return currentTime >= open || currentTime <= close;
    return currentTime >= open && currentTime <= close;
  }

  return true; // No hours set = always open
}

function parseTime(timeStr) {
  const [h, m] = (timeStr || '00:00').split(':').map(Number);
  return h * 100 + (m || 0);
}

// Get next opening time for a branch (returns human-readable string)
function getNextOpeningTime(branch) {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffset);
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  if (branch.operating_hours) {
    // Check today (if we haven't passed close yet) and upcoming days
    for (let d = 0; d < 7; d++) {
      const checkDay = dayNames[(ist.getUTCDay() + d) % 7];
      const dayHours = branch.operating_hours[checkDay];
      if (!dayHours || dayHours.is_closed) continue;
      const open = dayHours.open || '10:00';
      if (d === 0) {
        const openTime = parseTime(open);
        const currentTime = ist.getUTCHours() * 100 + ist.getUTCMinutes();
        if (currentTime < openTime) return `today at ${open}`;
      }
      if (d === 1) return `tomorrow at ${open}`;
      return `${checkDay.charAt(0).toUpperCase() + checkDay.slice(1)} at ${open}`;
    }
  }

  // Fallback to opening_time
  if (branch.opening_time) return `tomorrow at ${branch.opening_time}`;
  return 'soon';
}

// ─── FIND BEST AVAILABLE BRANCH ──────────────────────────────
// Like findNearestBranch but with operating hours awareness and fallback.
// Reimplements branch lookup (not a wrapper) because it needs ALL deliverable
// branches sorted by distance to find fallback options when the nearest is closed.
async function findBestAvailableBranch(customerLat, customerLng, restaurantId = null) {
  // Get all deliverable branches sorted by distance
  const branchFilter = { is_open: true, accepts_orders: true };
  if (restaurantId) branchFilter.restaurant_id = restaurantId;

  const branches = await col('branches').find(branchFilter).toArray();

  const activeBranches = (await Promise.all(
    branches.map(async b => {
      const restaurant = await col('restaurants').findOne({ _id: b.restaurant_id, status: 'active' });
      if (!restaurant) return null;
      const wa_acc = await col('whatsapp_accounts').findOne({ restaurant_id: b.restaurant_id, is_active: true });
      return { branch: b, restaurant, wa_acc };
    })
  )).filter(Boolean);

  if (!activeBranches.length) {
    return { found: false, message: '😔 Sorry, no restaurants are currently available. Please try again later!' };
  }

  const withDistance = activeBranches.map(({ branch, restaurant, wa_acc }) => ({
    branch, restaurant, wa_acc,
    distanceKm: haversineKm(parseFloat(customerLat), parseFloat(customerLng), parseFloat(branch.latitude), parseFloat(branch.longitude)),
  })).sort((a, b) => a.distanceKm - b.distanceKm);

  const deliverable = withDistance.filter(r => r.distanceKm <= parseFloat(r.branch.delivery_radius_km));

  if (!deliverable.length) {
    const closest = withDistance[0];
    return {
      found: false,
      message: `😔 Sorry, we don't deliver to your location yet.\n\nNearest outlet: *${closest.branch.name}* (${closest.distanceKm.toFixed(1)} km away)\nOur current delivery radius is ${closest.branch.delivery_radius_km} km from that outlet.\n\nWe're expanding soon! 🚀`,
    };
  }

  const makeBranchResult = (entry, isFallback = false) => ({
    found: true,
    branch: {
      id: String(entry.branch._id),
      name: entry.branch.name,
      address: entry.branch.address,
      city: entry.branch.city,
      distanceKm: entry.distanceKm.toFixed(1),
      restaurantId: entry.branch.restaurant_id,
      businessName: entry.restaurant.business_name,
      waAccountId: entry.wa_acc ? String(entry.wa_acc._id) : null,
      phoneNumberId: entry.wa_acc?.phone_number_id || null,
      accessToken: entry.wa_acc?.access_token || null,
      catalogId: entry.restaurant.meta_catalog_id || entry.branch.catalog_id,
      catalogSyncedAt: entry.branch.catalog_synced_at,
    },
    isFallback,
  });

  // Check nearest deliverable branch
  const nearest = deliverable[0];
  if (isBranchOpen(nearest.branch)) {
    return makeBranchResult(nearest, false);
  }

  // Nearest is closed — find the next open branch within range
  const openFallback = deliverable.find(d => isBranchOpen(d.branch));
  if (openFallback) {
    const result = makeBranchResult(openFallback, true);
    result.closedBranchName = nearest.branch.name;
    result.fallbackMessage = `📍 *${nearest.branch.name}* is currently closed. Routing you to *${openFallback.branch.name}*, ${openFallback.distanceKm.toFixed(1)} km away — they're open now!`;
    return result;
  }

  // All branches within range are closed
  const nextOpen = getNextOpeningTime(nearest.branch);
  return {
    found: false,
    allClosed: true,
    message: `😔 All *${nearest.restaurant.business_name}* branches near you are currently closed. They open ${nextOpen}. We'll be here when they're ready!`,
  };
}

module.exports = { findNearestBranch, findBestAvailableBranch, isBranchOpen, haversineKm, isMapsUrl, extractMapsUrl, extractCoordsFromMapsUrl, reverseGeocode, forwardGeocode, geocodeAddress, placeDetails };
