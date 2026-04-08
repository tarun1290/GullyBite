// src/services/directory.js
// WhatsApp Restaurant Directory — lets customers discover restaurants
// Uses a separate WABA (Directory WABA) dedicated to discovery
//
// Collections:
//   directory_listings — one per approved restaurant, holds display info
//   directory_sessions — conversation state for directory WABA interactions

'use strict';

const { col, newId } = require('../config/database');
const wa = require('./whatsapp');
const log = require('../utils/logger').child({ component: 'Directory' });

const DIR_PID    = () => process.env.DIRECTORY_WA_PHONE_NUMBER_ID;
const DIR_TOKEN  = () => process.env.DIRECTORY_WA_ACCESS_TOKEN;

// ─── AUTO-LIST ON APPROVAL ──────────────────────────────────────
// Called from admin approve route — creates or updates a directory listing
async function listRestaurant(restaurantId) {
  const restaurant = await col('restaurants').findOne({ _id: restaurantId });
  if (!restaurant || restaurant.approval_status !== 'approved') return null;

  const branches = await col('branches').find({ restaurant_id: restaurantId }).toArray();
  const primaryBranch = branches[0];

  // [WhatsApp2026] Include username and wa_link from WA account
  const waAccount = await col('whatsapp_accounts').findOne({ restaurant_id: restaurantId, is_active: true });
  const { getWaLink } = require('./username');
  const waLink = waAccount ? getWaLink(waAccount) : null;

  const listing = {
    restaurant_id: restaurantId,
    business_name: restaurant.business_name,
    brand_name: restaurant.brand_name || restaurant.business_name,
    city: restaurant.city || '',
    restaurant_type: restaurant.restaurant_type || 'both',
    logo_url: restaurant.logo_url || null,
    store_slug: restaurant.store_slug || null,
    cuisine_tags: restaurant.cuisine_tags || [],
    business_username: waAccount?.business_username || null,
    wa_link: waLink,
    is_active: true,
    branch_count: branches.length,
    primary_branch: primaryBranch ? {
      id: String(primaryBranch._id),
      name: primaryBranch.name,
      lat: primaryBranch.lat,
      lng: primaryBranch.lng,
      area: primaryBranch.area || primaryBranch.locality || '',
    } : null,
    updated_at: new Date(),
  };

  const existing = await col('directory_listings').findOne({ restaurant_id: restaurantId });
  if (existing) {
    await col('directory_listings').updateOne({ _id: existing._id }, { $set: listing });
    return existing._id;
  } else {
    listing._id = newId();
    listing.created_at = new Date();
    listing.view_count = 0;
    listing.order_count = 0;
    await col('directory_listings').insertOne(listing);
    return listing._id;
  }
}

// ─── UNLIST ON REJECTION / DEACTIVATION ─────────────────────────
async function unlistRestaurant(restaurantId) {
  await col('directory_listings').updateOne(
    { restaurant_id: restaurantId },
    { $set: { is_active: false, updated_at: new Date() } }
  );
}

// ─── SEARCH DIRECTORY ───────────────────────────────────────────
// Returns active listings matching a text query or city filter
async function searchListings({ query, city, type, limit = 10 }) {
  const filter = { is_active: true };
  if (city) filter.city = { $regex: city, $options: 'i' };
  if (type && type !== 'all') filter.restaurant_type = type;
  if (query) {
    // [WhatsApp2026] Strip @ prefix for username searches
    const cleanQuery = query.startsWith('@') ? query.substring(1) : query;
    filter.$or = [
      { brand_name: { $regex: cleanQuery, $options: 'i' } },
      { business_name: { $regex: cleanQuery, $options: 'i' } },
      { cuisine_tags: { $regex: cleanQuery, $options: 'i' } },
      { city: { $regex: cleanQuery, $options: 'i' } },
      { business_username: { $regex: cleanQuery, $options: 'i' } },
    ];
    // TODO: When Meta launches username search API, add verification:
    // GET https://graph.facebook.com/v25.0/whatsapp_username_search?q={username}
    // For now, we trust the manually entered username from admin
  }

  return col('directory_listings')
    .find(filter)
    .sort({ order_count: -1, view_count: -1 })
    .limit(limit)
    .toArray();
}

// ─── GET ALL LISTINGS (admin) ───────────────────────────────────
async function getAllListings({ limit = 50, offset = 0 }) {
  const [listings, total] = await Promise.all([
    col('directory_listings').find({}).sort({ created_at: -1 }).skip(offset).limit(limit).toArray(),
    col('directory_listings').countDocuments({}),
  ]);
  return { listings, total };
}

// ─── DIRECTORY STATS ────────────────────────────────────────────
async function getStats() {
  const all = await col('directory_listings').find({}).toArray();
  return {
    total: all.length,
    active: all.filter(l => l.is_active).length,
    inactive: all.filter(l => !l.is_active).length,
    total_views: all.reduce((s, l) => s + (l.view_count || 0), 0),
    total_orders: all.reduce((s, l) => s + (l.order_count || 0), 0),
  };
}

// ─── SEND DIRECTORY LIST VIA WHATSAPP ───────────────────────────
// Sends up to 10 restaurants as an interactive list message
async function sendDirectoryResults(to, listings, headerText) {
  const pid = DIR_PID();
  const token = DIR_TOKEN();
  if (!pid || !token) {
    log.error('DIRECTORY_WA_PHONE_NUMBER_ID or DIRECTORY_WA_ACCESS_TOKEN not configured');
    return;
  }

  if (!listings.length) {
    return wa.sendText(pid, token, to,
      `Sorry, no restaurants found matching your search. Try a different keyword or city!\n\nType *menu* to see options.`
    );
  }

  const typeEmoji = { veg: '🟢', non_veg: '🔴', both: '🟡' };

  const sections = [{
    title: 'Restaurants',
    rows: listings.slice(0, 10).map(l => ({
      id: `DIR_VIEW_${l.restaurant_id}`,
      title: (l.brand_name || l.business_name).substring(0, 24),
      description: `${typeEmoji[l.restaurant_type] || '🟡'} ${l.city || ''}${l.cuisine_tags?.length ? ' · ' + l.cuisine_tags.slice(0, 2).join(', ') : ''}`.substring(0, 72),
    })),
  }];

  return wa.sendList(pid, token, to, {
    header: headerText || 'Restaurant Directory',
    body: `Found ${listings.length} restaurant${listings.length > 1 ? 's' : ''}. Tap below to browse:`,
    footer: 'GullyBite — Order food on WhatsApp',
    buttonText: 'Browse Restaurants',
    sections,
  });
}

// ─── SEND RESTAURANT DETAIL CARD ────────────────────────────────
async function sendRestaurantCard(to, listing) {
  const pid = DIR_PID();
  const token = DIR_TOKEN();
  if (!pid || !token) return;

  // Increment view count
  await col('directory_listings').updateOne(
    { restaurant_id: listing.restaurant_id },
    { $inc: { view_count: 1 } }
  );

  const typeLabel = { veg: 'Pure Veg 🟢', non_veg: 'Non-Veg 🔴', both: 'Veg & Non-Veg 🟡' };
  const name = listing.brand_name || listing.business_name;
  const area = listing.primary_branch?.area ? `📍 ${listing.primary_branch.area}, ${listing.city}` : `📍 ${listing.city}`;
  const cuisine = listing.cuisine_tags?.length ? `🍽️ ${listing.cuisine_tags.join(', ')}` : '';
  const baseUrl = process.env.BASE_URL || 'https://gully-bite.vercel.app';

  // [WhatsApp2026] Show username if available
  const usernameDisplay = listing.business_username
    ? `💬 @${listing.business_username}\n`
    : '';

  const body =
    `*${name}*\n` +
    `${typeLabel[listing.restaurant_type] || 'Veg & Non-Veg 🟡'}\n` +
    `${area}\n` +
    (cuisine ? `${cuisine}\n` : '') +
    usernameDisplay +
    `\nTap below to start ordering on WhatsApp!`;

  const buttons = [
    { id: `DIR_ORDER_${listing.restaurant_id}`, title: 'Order Now' },
  ];

  if (listing.store_slug) {
    buttons.push({ id: `DIR_STORE_${listing.restaurant_id}`, title: 'View Store' });
  }

  buttons.push({ id: 'DIR_BACK', title: 'Back to Search' });

  return wa.sendButtons(pid, token, to, {
    header: name.substring(0, 60),
    body,
    footer: 'GullyBite Directory',
    buttons,
  });
}

// ─── INCREMENT ORDER COUNT ──────────────────────────────────────
async function incrementOrderCount(restaurantId) {
  await col('directory_listings').updateOne(
    { restaurant_id: restaurantId },
    { $inc: { order_count: 1 } }
  ).catch(() => {});
}

module.exports = {
  listRestaurant,
  unlistRestaurant,
  searchListings,
  getAllListings,
  getStats,
  sendDirectoryResults,
  sendRestaurantCard,
  incrementOrderCount,
};
