'use strict';

// personaComputer.js
// Computes a per-customer persona (cuisine affinity, price/veg, frequency,
// time patterns, area clusters, engagement) from orders, user_signals,
// marketing_messages, referrals, and city_captain_sessions. Pure compute
// in computePersona(); upsertPersona() persists to customer_personas.

const DAY_MS = 24 * 60 * 60 * 1000;

// Hour buckets are computed in UTC. Order hour ranges are half-open at the
// upper edge so dinner (17-22) and late_night (22-2) never double-count
// the 22:00 hour. The "wrap" from 22..2 across midnight is unioned.
// breakfast: 6..11, lunch: 12..16, dinner: 17..21, late_night: 22..23 OR 0..2
function _bucketForHour(h) {
  if (h >= 6 && h <= 11) return 'breakfast';
  if (h >= 12 && h <= 16) return 'lunch';
  if (h >= 17 && h <= 21) return 'dinner';
  if (h >= 22 || h <= 2) return 'late_night';
  return null; // 3..5
}

async function _safeFind(db, collName, query, opts) {
  try {
    return await db.collection(collName).find(query, opts || {}).toArray();
  } catch (_) {
    return [];
  }
}

async function _safeFindOne(db, collName, query) {
  try {
    return await db.collection(collName).findOne(query);
  } catch (_) {
    return null;
  }
}

// Load the canonical cuisine list from platform_settings._id='tag_taxonomy'.
// Fallback caller derives a list from observed data if taxonomy is missing.
async function _loadCuisineList(db) {
  const tax = await _safeFindOne(db, 'platform_settings', { _id: 'tag_taxonomy' });
  if (tax && Array.isArray(tax.cuisine_primary)) return tax.cuisine_primary.slice();
  return null;
}

// Extract cuisines off a listing/restaurant doc — supports both
// `tags.cuisine_primary` (city_listings) and `cuisine_primary` (restaurants),
// and accepts either string or array shapes per spec.
function _extractCuisines(doc) {
  if (!doc) return [];
  const cands = [doc.cuisine_primary, doc?.tags?.cuisine_primary];
  for (const c of cands) {
    if (Array.isArray(c)) return c.filter(Boolean);
    if (typeof c === 'string' && c.trim()) return [c.trim()];
  }
  return [];
}

// veg_status on restaurants is typed as `restaurant_type` in the schema
// (enum: veg / non_veg / both) but spec says `veg_status` — accept both.
function _restaurantVegStatus(r) {
  if (!r) return null;
  return r.veg_status || r.restaurant_type || null;
}

function _isNonVegRestaurant(r) {
  const v = (_restaurantVegStatus(r) || '').toLowerCase().replace('-', '_');
  return v === 'non_veg' || v === 'both';
}

function _orderArea(order) {
  const a = order?.delivery_address;
  if (!a) return null;
  if (typeof a === 'string') return a.trim() || null;
  if (typeof a === 'object' && typeof a.area === 'string') return a.area.trim() || null;
  return null;
}

// "Tap" detection across heterogeneous schemas. marketing_messages does not
// currently carry click/tap fields (only sent/delivered/read/failed status),
// so we accept several patterns and fall back to status==='read' as the
// closest proxy for an engaged customer.
function _isMarketingTap(m) {
  if (!m) return false;
  if (m.clicked === true) return true;
  if (m.tapped === true) return true;
  if (m.event_type === 'click' || m.event_type === 'tap') return true;
  // `status === 'read'` is a backward-compat proxy for pre-tracking
  // rows that predate the marketing_message_id → clicked wiring.
  if (m.status === 'read') return true;
  return false;
}

async function computePersona(db, customerId) {
  if (!db || !customerId) return null;

  const customer = await _safeFindOne(db, 'customers', { _id: customerId });
  if (!customer) return null;

  const now = new Date();
  const cutoff90 = new Date(now.getTime() - 90 * DAY_MS);

  // Parallel loads — each wrapped in try/catch so a missing collection
  // or sparse data does not crash the cron job.
  const [orders, signals, mktMsgs, referrals, captainSessions] = await Promise.all([
    _safeFind(db, 'orders', { customer_id: customerId }),
    _safeFind(db, 'user_signals', { customer_id: customerId, ts: { $gte: cutoff90 } }),
    _safeFind(db, 'marketing_messages', { customer_id: customerId, created_at: { $gte: cutoff90 } }),
    _safeFind(db, 'referrals', { customer_id: customerId }),
    _safeFind(db, 'city_captain_sessions', { customer_id: customerId }),
  ]);

  // Batch-resolve restaurants for the order set and city_listings for the
  // signals. Used by cuisine affinity + veg strictness.
  const restaurantIds = Array.from(new Set(orders.map(o => o.restaurant_id).filter(Boolean)));
  const restaurants = restaurantIds.length
    ? await _safeFind(db, 'restaurants', { _id: { $in: restaurantIds } })
    : [];
  const restaurantById = new Map(restaurants.map(r => [r._id, r]));

  const listingIds = Array.from(new Set(
    signals
      .filter(s => s.action === 'listing_card_shown' || s.action === 'menu_viewed' || s.action === 'tapped_hide')
      .map(s => s.listing_id)
      .filter(Boolean)
  ));
  const listings = listingIds.length
    ? await _safeFind(db, 'city_listings', { _id: { $in: listingIds } })
    : [];
  const listingById = new Map(listings.map(l => [l._id, l]));

  // ─── cuisine_affinity ──────────────────────────────────────
  let cuisineList = await _loadCuisineList(db);
  if (!cuisineList || cuisineList.length === 0) {
    // Fallback: union of cuisines observed in this customer's orders + signals.
    const seen = new Set();
    for (const r of restaurants) for (const c of _extractCuisines(r)) seen.add(c);
    for (const l of listings) for (const c of _extractCuisines(l)) seen.add(c);
    for (const c of (customer?.discovery_prefs?.cuisine_likes || [])) if (c) seen.add(c);
    cuisineList = Array.from(seen);
  }

  const rawByCuisine = new Map();
  for (const c of cuisineList) rawByCuisine.set(c, 0);

  // +3 per matching order
  for (const o of orders) {
    const r = restaurantById.get(o.restaurant_id);
    for (const c of _extractCuisines(r)) {
      if (rawByCuisine.has(c)) rawByCuisine.set(c, rawByCuisine.get(c) + 3);
    }
  }
  // +1 per listing_card_shown / menu_viewed signal on a matching listing
  for (const s of signals) {
    if (s.action !== 'listing_card_shown' && s.action !== 'menu_viewed') continue;
    const l = listingById.get(s.listing_id);
    for (const c of _extractCuisines(l)) {
      if (rawByCuisine.has(c)) rawByCuisine.set(c, rawByCuisine.get(c) + 1);
    }
  }
  // +5 for declared cuisine_likes
  for (const c of (customer?.discovery_prefs?.cuisine_likes || [])) {
    if (rawByCuisine.has(c)) rawByCuisine.set(c, rawByCuisine.get(c) + 5);
  }
  // -2 per tapped_hide on a matching listing
  for (const s of signals) {
    if (s.action !== 'tapped_hide') continue;
    const l = listingById.get(s.listing_id);
    for (const c of _extractCuisines(l)) {
      if (rawByCuisine.has(c)) rawByCuisine.set(c, rawByCuisine.get(c) - 2);
    }
  }

  const maxRaw = Math.max(0, ...Array.from(rawByCuisine.values()));
  const cuisine_affinity = {};
  if (maxRaw > 0) {
    for (const [c, raw] of rawByCuisine.entries()) {
      if (raw > 0) cuisine_affinity[c] = Math.round((raw / maxRaw) * 100);
    }
  }

  // ─── price_sensitivity ────────────────────────────────────
  let price_sensitivity = 'mid';
  if (orders.length > 0) {
    const sum = orders.reduce((acc, o) => acc + (Number(o.total_rs) || 0), 0);
    const avg = sum / orders.length;
    if (avg < 200) price_sensitivity = 'budget';
    else if (avg <= 500) price_sensitivity = 'mid';
    else price_sensitivity = 'premium';
  } else {
    const pref = customer?.discovery_prefs?.price_band_default;
    if (pref === 'budget' || pref === 'mid' || pref === 'premium') price_sensitivity = pref;
  }

  // ─── order_frequency ──────────────────────────────────────
  const cutoff7  = new Date(now.getTime() - 7  * DAY_MS);
  const cutoff30 = new Date(now.getTime() - 30 * DAY_MS);
  const cutoff60 = new Date(now.getTime() - 60 * DAY_MS);
  const cutoffOrders90 = new Date(now.getTime() - 90 * DAY_MS);

  const ordersIn = (cutoff) => orders.filter(o => o.created_at && new Date(o.created_at) >= cutoff).length;
  const n7 = ordersIn(cutoff7);
  const n30 = ordersIn(cutoff30);
  const n60 = ordersIn(cutoff60);
  const n90 = ordersIn(cutoffOrders90);
  let order_frequency;
  if (n7 >= 4) order_frequency = 'daily';
  else if (n30 >= 4) order_frequency = 'weekly';
  else if (n60 >= 2) order_frequency = 'biweekly';
  else if (n90 >= 1) order_frequency = 'monthly';
  else if (orders.length > 0) order_frequency = 'lapsed';
  else order_frequency = 'never';

  // ─── time_patterns ────────────────────────────────────────
  const bucketCounts = { breakfast: 0, lunch: 0, dinner: 0, late_night: 0 };
  let totalBucketed = 0;
  for (const o of orders) {
    if (!o.created_at) continue;
    const h = new Date(o.created_at).getUTCHours();
    const b = _bucketForHour(h);
    if (b) { bucketCounts[b]++; totalBucketed++; }
  }
  const time_patterns = [];
  if (totalBucketed > 0) {
    for (const [b, c] of Object.entries(bucketCounts)) {
      if (c / totalBucketed >= 0.20) time_patterns.push(b);
    }
  }

  // ─── veg_strictness ───────────────────────────────────────
  const vegStatus = customer?.discovery_prefs?.veg_status || null;
  const anyNonVegOrder = orders.some(o => _isNonVegRestaurant(restaurantById.get(o.restaurant_id)));
  let veg_strictness;
  if (vegStatus === 'veg' && !anyNonVegOrder) veg_strictness = 'strict_veg';
  else if (vegStatus === 'eggetarian' || (vegStatus === 'veg' && anyNonVegOrder)) veg_strictness = 'flexible_veg';
  else veg_strictness = 'omnivore';

  // ─── discovery_stage ──────────────────────────────────────
  const totalOrders = orders.length;
  const totalCaptainSessions = captainSessions.length;
  let discovery_stage;
  if (totalOrders === 0 && totalCaptainSessions === 0) discovery_stage = 'never_active';
  else if (totalOrders === 0 && totalCaptainSessions >= 1) discovery_stage = 'captain_browser';
  else if (totalOrders >= 1 && totalOrders <= 2) discovery_stage = 'converted';
  else if (totalOrders >= 3 && totalOrders <= 9) discovery_stage = 'repeat_customer';
  else if (totalOrders >= 10) {
    const mostRecent = orders.reduce((max, o) => {
      const t = o.created_at ? new Date(o.created_at).getTime() : 0;
      return t > max ? t : max;
    }, 0);
    discovery_stage = mostRecent >= cutoff30.getTime() ? 'loyal' : 'repeat_customer';
  } else {
    discovery_stage = 'never_active';
  }

  // ─── area_clusters ────────────────────────────────────────
  const areaCounts = new Map();
  for (const o of orders) {
    const a = _orderArea(o);
    if (a) areaCounts.set(a, (areaCounts.get(a) || 0) + 1);
  }
  const sortedAreas = Array.from(areaCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([a]) => a);
  const homeArea = customer?.discovery_prefs?.home_area;
  if (homeArea && typeof homeArea === 'string' && homeArea.trim() && !sortedAreas.includes(homeArea)) {
    sortedAreas.push(homeArea);
  }
  const area_clusters = sortedAreas.filter(a => a && typeof a === 'string' && a.trim());

  // ─── engagement_score ─────────────────────────────────────
  // sends_count = total marketing_messages rows in last 90d.
  // tap_count = rows that match any tap signal (see _isMarketingTap).
  let engagement_score;
  const sendsCount = mktMsgs.length;
  if (sendsCount < 5) {
    engagement_score = 50;
  } else {
    const taps = mktMsgs.filter(_isMarketingTap).length;
    const ratio = (taps / sendsCount) * 100;
    engagement_score = Math.round(Math.max(0, Math.min(100, ratio)));
  }

  // ─── last_active_at ───────────────────────────────────────
  const orderMax = orders.reduce((m, o) => {
    const t = o.created_at ? new Date(o.created_at).getTime() : 0;
    return t > m ? t : m;
  }, 0);
  const signalMax = signals.reduce((m, s) => {
    const t = s.ts ? new Date(s.ts).getTime() : 0;
    return t > m ? t : m;
  }, 0);
  const mktMax = mktMsgs.reduce((m, x) => {
    const t = x.created_at ? new Date(x.created_at).getTime() : 0;
    return t > m ? t : m;
  }, 0);
  const lastMax = Math.max(orderMax, signalMax, mktMax);
  const last_active_at = lastMax > 0 ? new Date(lastMax) : null;

  // ─── monetary + counts ────────────────────────────────────
  const customer_lifetime_value_rs = orders.reduce((acc, o) => acc + (Number(o.total_rs) || 0), 0);
  const gbref_conversion_count = orders.filter(o => o.referral_id != null && o.referral_id !== '').length;

  // ─── primary_city_id ──────────────────────────────────────
  // Mode of city_id across captain sessions. Ties broken by first-seen.
  let primary_city_id = null;
  if (captainSessions.length > 0) {
    const cityCounts = new Map();
    for (const s of captainSessions) {
      if (!s.city_id) continue;
      cityCounts.set(s.city_id, (cityCounts.get(s.city_id) || 0) + 1);
    }
    let bestId = null;
    let bestCount = 0;
    for (const [id, c] of cityCounts.entries()) {
      if (c > bestCount) { bestCount = c; bestId = id; }
    }
    primary_city_id = bestId;
  }

  return {
    cuisine_affinity,
    price_sensitivity,
    order_frequency,
    time_patterns,
    veg_strictness,
    discovery_stage,
    area_clusters,
    engagement_score,
    last_active_at,
    customer_lifetime_value_rs,
    total_orders: totalOrders,
    gbref_conversion_count,
    total_captain_sessions: totalCaptainSessions,
    primary_city_id,
    schema_version: 1,
  };
}

async function upsertPersona(db, customerId) {
  const persona = await computePersona(db, customerId);
  if (!persona) return null;
  try {
    await db.collection('customer_personas').updateOne(
      { customer_id: customerId },
      { $set: { ...persona, customer_id: customerId, recompute_at: new Date() } },
      { upsert: true },
    );
  } catch (_) {
    // Swallow — caller (cron) decides on retry. We've already done the compute.
  }
  return persona;
}

module.exports = { computePersona, upsertPersona };
