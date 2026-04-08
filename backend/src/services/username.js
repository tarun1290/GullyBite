// src/services/username.js
// Business username management for WhatsApp
// Meta allows businesses to claim @usernames (e.g., @beyondsnacks)
// As of March 2026, there's no public Graph API to claim/delete usernames —
// it's done via Meta Business Suite → WhatsApp Manager → Settings.
// This service handles: suggestions, validation, local dedup, sync placeholders.

'use strict';

const axios = require('axios');
const { col, newId } = require('../config/database');
const metaConfig = require('../config/meta');
const log = require('../utils/logger').child({ component: 'Username' });

const GRAPH = () => metaConfig.graphUrl;
const TOKEN = () => metaConfig.systemUserToken;

// ─── USERNAME FORMAT RULES (from Meta) ────────────────────────
// - Lowercase letters, numbers, periods (.) and underscores (_) only
// - Min 5, max 30 characters
// - Cannot start or end with a period or underscore
// - No consecutive periods or underscores
// - Cannot be purely numeric
// - Must be unique globally (we check locally; Meta checks globally)

function validateUsernameFormat(username) {
  if (!username || typeof username !== 'string') {
    return { valid: false, error: 'Username is required' };
  }
  const u = username.toLowerCase().trim();
  if (u.length < 5) return { valid: false, error: 'Must be at least 5 characters' };
  if (u.length > 30) return { valid: false, error: 'Must be 30 characters or fewer' };
  if (!/^[a-z0-9._]+$/.test(u)) return { valid: false, error: 'Only lowercase letters, numbers, periods, and underscores allowed' };
  if (/^[._]/.test(u) || /[._]$/.test(u)) return { valid: false, error: 'Cannot start or end with a period or underscore' };
  if (/\.\./.test(u) || /__/.test(u)) return { valid: false, error: 'No consecutive periods or underscores' };
  if (/^\d+$/.test(u)) return { valid: false, error: 'Cannot be purely numeric' };
  return { valid: true, error: null };
}

// ─── SLUGIFY HELPER ──────────────────────────────────────────
function slugify(str) {
  return (str || '')
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 30);
}

// ─── GENERATE USERNAME SUGGESTIONS ──────────────────────────
function generateUsernameSuggestions(restaurantName, businessName, city, restaurantType) {
  const candidates = new Set();
  const name = restaurantName || businessName || '';
  const biz = businessName || restaurantName || '';

  // Base slugs
  const nameSlug = slugify(name);
  const bizSlug = slugify(biz);
  const citySlug = slugify(city);

  // 1. Direct slug
  if (nameSlug) candidates.add(nameSlug);
  if (bizSlug && bizSlug !== nameSlug) candidates.add(bizSlug);

  // 2. No separators version
  const compact = nameSlug.replace(/_/g, '');
  if (compact && compact !== nameSlug) candidates.add(compact);

  // 3. With periods instead of underscores
  const dotted = nameSlug.replace(/_/g, '.');
  if (dotted && dotted !== nameSlug) candidates.add(dotted);

  // 4. Name + city
  if (nameSlug && citySlug) {
    candidates.add(`${nameSlug}_${citySlug}`.substring(0, 30));
    candidates.add(`${compact}.${citySlug}`.substring(0, 30));
  }

  // 5. Abbreviated (first letters of words + full last word)
  const words = name.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    const abbr = words.map(w => w[0]).join('') + words[words.length - 1].substring(1);
    if (abbr.length >= 5) candidates.add(abbr.substring(0, 30));
  }

  // 6. Common patterns
  if (compact) {
    candidates.add(`${compact}official`.substring(0, 30));
    candidates.add(`${compact}food`.substring(0, 30));
    candidates.add(`${compact}eats`.substring(0, 30));
  }

  // 7. Type-based suffix
  if (compact && restaurantType) {
    const typeMap = { veg: 'veg', non_veg: 'nonveg', both: 'cafe' };
    const suffix = typeMap[restaurantType] || 'cafe';
    candidates.add(`${compact}.${suffix}`.substring(0, 30));
  }

  // Filter out invalid candidates
  return [...candidates]
    .filter(c => validateUsernameFormat(c).valid)
    .slice(0, 10);
}

// ─── LOCAL AVAILABILITY CHECK ────────────────────────────────
async function checkLocalAvailability(username, excludeWaAccountId) {
  const filter = { business_username: username.toLowerCase() };
  if (excludeWaAccountId) filter._id = { $ne: excludeWaAccountId };
  const existing = await col('whatsapp_accounts').findOne(filter);
  return !existing;
}

// ─── CHECK USERNAME AVAILABILITY (local + Meta placeholder) ──
async function checkUsernameAvailability(username, excludeWaAccountId) {
  const format = validateUsernameFormat(username);
  if (!format.valid) return { available: false, error: format.error, meta_check: null };

  const locallyAvailable = await checkLocalAvailability(username.toLowerCase(), excludeWaAccountId);

  // TODO: When Meta launches username availability API, replace with actual call:
  // GET https://graph.facebook.com/v25.0/whatsapp_username_check?username={username}
  const metaCheck = 'not_available_yet';

  return {
    available: locallyAvailable,
    available_locally: locallyAvailable,
    meta_check: metaCheck,
    error: locallyAvailable ? null : 'Username already in use by another restaurant on GullyBite',
  };
}

// ─── SET TARGET USERNAME (pending_claim) ─────────────────────
async function setTargetUsername(waAccountId, username) {
  const u = username.toLowerCase().trim();
  const format = validateUsernameFormat(u);
  if (!format.valid) throw new Error(format.error);

  const avail = await checkUsernameAvailability(u, waAccountId);
  if (!avail.available) throw new Error(avail.error || 'Username not available');

  const waAccount = await col('whatsapp_accounts').findOne({ _id: waAccountId });
  if (!waAccount) throw new Error('WhatsApp account not found');

  const now = new Date();
  const historyEntry = { username: u, status: 'pending_claim', changed_at: now };

  await col('whatsapp_accounts').updateOne({ _id: waAccountId }, {
    $set: {
      business_username: u,
      username_status: 'pending_claim',
      username_updated_at: now,
    },
    $push: { username_history: historyEntry },
  });

  return { username: u, status: 'pending_claim' };
}

// ─── CONFIRM USERNAME (active) ──────────────────────────────
async function confirmUsername(waAccountId, username) {
  const u = (username || '').toLowerCase().trim();
  if (!u) throw new Error('Username required');

  const format = validateUsernameFormat(u);
  if (!format.valid) throw new Error(format.error);

  const now = new Date();
  await col('whatsapp_accounts').updateOne({ _id: waAccountId }, {
    $set: {
      business_username: u,
      username_status: 'active',
      username_claimed_at: now,
      username_updated_at: now,
    },
    $push: { username_history: { username: u, status: 'active', changed_at: now } },
  });

  // Update directory listing with username
  const waAccount = await col('whatsapp_accounts').findOne({ _id: waAccountId });
  if (waAccount?.restaurant_id) {
    await col('directory_listings').updateOne(
      { restaurant_id: waAccount.restaurant_id },
      { $set: { business_username: u, wa_link: `https://wa.me/${u}`, updated_at: now } }
    );
  }

  return { username: u, status: 'active' };
}

// ─── RELEASE USERNAME ───────────────────────────────────────
async function releaseUsername(waAccountId) {
  const waAccount = await col('whatsapp_accounts').findOne({ _id: waAccountId });
  if (!waAccount) throw new Error('WhatsApp account not found');

  const oldUsername = waAccount.business_username;
  const now = new Date();

  await col('whatsapp_accounts').updateOne({ _id: waAccountId }, {
    $set: {
      business_username: null,
      username_status: 'released',
      username_updated_at: now,
    },
    $push: { username_history: { username: oldUsername, status: 'released', changed_at: now } },
  });

  // Revert directory listing to phone-based link
  if (waAccount.restaurant_id) {
    const phoneLink = waAccount.wa_phone_number
      ? `https://wa.me/${waAccount.wa_phone_number}`
      : null;
    await col('directory_listings').updateOne(
      { restaurant_id: waAccount.restaurant_id },
      { $set: { business_username: null, wa_link: phoneLink, updated_at: now } }
    );
  }

  return { released: oldUsername };
}

// ─── SYNC USERNAME FROM META ────────────────────────────────
// Tries to fetch the actual username from Meta's WABA API
async function syncUsernameFromMeta(waAccountId) {
  const waAccount = await col('whatsapp_accounts').findOne({ _id: waAccountId });
  if (!waAccount?.waba_id) throw new Error('No WABA ID on this account');

  const token = TOKEN();
  if (!token) throw new Error('WhatsApp API token is not configured. Please contact support.');

  let metaUsername = null;
  try {
    // TODO: Replace with actual endpoint when Meta launches it
    // Currently trying the standard WABA fields endpoint
    const { data } = await axios.get(`${GRAPH()}/${waAccount.waba_id}`, {
      params: { fields: 'name,username', access_token: token },
      timeout: 8000,
    });
    metaUsername = data.username || null;
  } catch (err) {
    const code = err.response?.status;
    const msg = err.response?.data?.error?.message || err.message;
    log.warn({ wabaId: waAccount.waba_id, statusCode: code, errorMsg: msg }, 'Username sync failed');
    // If the field doesn't exist yet, that's expected
    if (code === 400 || code === 404) {
      return { synced: false, reason: 'Meta username API not available yet', manual_entry_required: true };
    }
    throw err;
  }

  if (metaUsername) {
    const now = new Date();
    await col('whatsapp_accounts').updateOne({ _id: waAccountId }, {
      $set: {
        business_username: metaUsername.toLowerCase(),
        username_status: 'active',
        username_claimed_at: now,
        username_updated_at: now,
      },
      $push: { username_history: { username: metaUsername.toLowerCase(), status: 'active', changed_at: now } },
    });

    if (waAccount.restaurant_id) {
      await col('directory_listings').updateOne(
        { restaurant_id: waAccount.restaurant_id },
        { $set: { business_username: metaUsername.toLowerCase(), wa_link: `https://wa.me/${metaUsername.toLowerCase()}`, updated_at: now } }
      );
    }

    return { synced: true, username: metaUsername.toLowerCase() };
  }

  return { synced: false, reason: 'No username found on Meta', manual_entry_required: true };
}

// ─── SYNC ALL WABAs ─────────────────────────────────────────
async function syncAllUsernames() {
  const accounts = await col('whatsapp_accounts').find({ is_active: true, waba_id: { $exists: true, $ne: null } }).toArray();
  const results = { total: accounts.length, synced: 0, failed: 0, not_available: 0 };

  for (const acc of accounts) {
    try {
      const r = await syncUsernameFromMeta(String(acc._id));
      if (r.synced) results.synced++;
      else results.not_available++;
    } catch (err) {
      results.failed++;
      log.error({ err, accountId: acc._id }, 'Username sync failed for account');
    }
  }

  return results;
}

// ─── AUTO-SUGGEST FOR ALL ───────────────────────────────────
async function autoSuggestAll() {
  const accounts = await col('whatsapp_accounts').find({
    is_active: true,
    $or: [{ username_suggestions: null }, { username_suggestions: { $size: 0 } }, { username_suggestions: { $exists: false } }],
  }).toArray();

  let updated = 0;
  for (const acc of accounts) {
    const restaurant = await col('restaurants').findOne({ _id: acc.restaurant_id });
    if (!restaurant) continue;

    const suggestions = generateUsernameSuggestions(
      restaurant.brand_name || restaurant.business_name,
      restaurant.business_name,
      restaurant.city,
      restaurant.restaurant_type
    );

    if (suggestions.length) {
      await col('whatsapp_accounts').updateOne({ _id: acc._id }, {
        $set: { username_suggestions: suggestions, username_updated_at: new Date() },
      });
      updated++;
    }
  }

  return { total: accounts.length, updated };
}

// ─── GET USERNAME STATUS FOR RESTAURANT ─────────────────────
async function getUsernameStatus(restaurantId) {
  const waAccount = await col('whatsapp_accounts').findOne({ restaurant_id: restaurantId, is_active: true });
  if (!waAccount) return null;

  return {
    wa_account_id: String(waAccount._id),
    business_username: waAccount.business_username || null,
    username_status: waAccount.username_status || 'not_claimed',
    username_claimed_at: waAccount.username_claimed_at || null,
    username_suggestions: waAccount.username_suggestions || [],
    username_history: waAccount.username_history || [],
    wa_link: waAccount.business_username && waAccount.username_status === 'active'
      ? `https://wa.me/${waAccount.business_username}`
      : waAccount.wa_phone_number ? `https://wa.me/${waAccount.wa_phone_number}` : null,
  };
}

// ─── GET ALL USERNAMES (admin overview) ─────────────────────
async function getAllUsernameStatuses({ search, statusFilter } = {}) {
  const pipeline = [
    { $match: { is_active: true } },
    { $lookup: { from: 'restaurants', localField: 'restaurant_id', foreignField: '_id', as: 'restaurant' } },
    { $unwind: { path: '$restaurant', preserveNullAndEmptyArrays: true } },
    { $project: {
      restaurant_id: 1, display_name: 1, waba_id: 1,
      business_username: 1, username_status: { $ifNull: ['$username_status', 'not_claimed'] },
      username_claimed_at: 1, username_suggestions: 1, wa_phone_number: 1,
      restaurant_name: { $ifNull: ['$restaurant.brand_name', '$restaurant.business_name'] },
      city: '$restaurant.city',
      restaurant_type: '$restaurant.restaurant_type',
    }},
  ];

  if (statusFilter && statusFilter !== 'all') {
    pipeline.push({ $match: { username_status: statusFilter } });
  }
  if (search) {
    pipeline.push({ $match: { $or: [
      { restaurant_name: { $regex: search, $options: 'i' } },
      { display_name: { $regex: search, $options: 'i' } },
      { business_username: { $regex: search, $options: 'i' } },
    ]}});
  }

  pipeline.push({ $sort: { username_status: 1, restaurant_name: 1 } });

  return col('whatsapp_accounts').aggregate(pipeline).toArray();
}

// ─── HELPER: Generate wa_link for any account ────────────────
function getWaLink(waAccount) {
  if (waAccount.business_username && waAccount.username_status === 'active') {
    return `https://wa.me/${waAccount.business_username}`;
  }
  if (waAccount.wa_phone_number) {
    return `https://wa.me/${waAccount.wa_phone_number}`;
  }
  return null;
}

// ─── ENSURE INDEXES ─────────────────────────────────────────
async function ensureIndexes() {
  try {
    await col('whatsapp_accounts').createIndex(
      { business_username: 1 },
      { unique: true, sparse: true, name: 'idx_business_username' }
    );
  } catch (err) {
    log.warn({ err }, 'Username index may already exist');
  }
}

module.exports = {
  validateUsernameFormat,
  generateUsernameSuggestions,
  checkUsernameAvailability,
  setTargetUsername,
  confirmUsername,
  releaseUsername,
  syncUsernameFromMeta,
  syncAllUsernames,
  autoSuggestAll,
  getUsernameStatus,
  getAllUsernameStatuses,
  getWaLink,
  ensureIndexes,
};
