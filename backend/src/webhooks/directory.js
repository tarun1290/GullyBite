// src/webhooks/directory.js
// WhatsApp webhook handler for the Directory WABA
// Separate from the restaurant WABA — this is GullyBite's discovery number

'use strict';

const express = require('express');
const router = express.Router();
const { col, newId } = require('../config/database');
const directory = require('../services/directory');
const wa = require('../services/whatsapp');
const location = require('../services/location');
const { logActivity } = require('../services/activityLog');

const metaConfig = require('../config/meta');

const REFERRAL_COMMISSION_PCT = parseFloat(process.env.REFERRAL_COMMISSION_PCT || '7.5');
const REFERRAL_WINDOW_HRS = parseInt(process.env.REFERRAL_WINDOW_HRS || '8', 10);

// ─── ADMIN NUMBER RESOLUTION ────────────────────────────────
// DB-first: reads admin_numbers collection. Falls back to env vars for backward compat.
let _cachedAdminNumber = null;
let _cacheTime = 0;
async function getAdminNumber(phoneNumberId) {
  if (phoneNumberId) {
    const num = await col('admin_numbers').findOne({ phone_number_id: phoneNumberId, is_active: true });
    if (num) return { pid: num.phone_number_id, token: metaConfig.systemUserToken, purpose: num.purpose || 'directory' };
  }
  // Fallback: use first active admin number or env vars
  if (!_cachedAdminNumber || Date.now() - _cacheTime > 300000) {
    const num = await col('admin_numbers').findOne({ purpose: 'directory', is_active: true });
    if (num) { _cachedAdminNumber = { pid: num.phone_number_id, token: metaConfig.systemUserToken }; _cacheTime = Date.now(); }
  }
  if (_cachedAdminNumber) return { ...(_cachedAdminNumber), purpose: 'directory' };
  return { pid: process.env.DIRECTORY_WA_PHONE_NUMBER_ID, token: process.env.DIRECTORY_WA_ACCESS_TOKEN || metaConfig.systemUserToken, purpose: 'directory' };
}
const DIR_PID   = () => _cachedAdminNumber?.pid || process.env.DIRECTORY_WA_PHONE_NUMBER_ID;
const DIR_TOKEN = () => metaConfig.systemUserToken || process.env.DIRECTORY_WA_ACCESS_TOKEN;

// ─── WEBHOOK VERIFICATION ───────────────────────────────────────
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === (process.env.WEBHOOK_VERIFY_TOKEN || process.env.DIRECTORY_WA_VERIFY_TOKEN)) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── INCOMING MESSAGES ──────────────────────────────────────────
router.post('/', express.raw({ type: '*/*' }), async (req, res) => {
  res.sendStatus(200);

  try {
    // Validate Meta webhook signature
    const sig = req.headers['x-hub-signature-256']?.split('sha256=')[1];
    if (sig && process.env.WEBHOOK_APP_SECRET) {
      const crypto = require('crypto');
      const expected = crypto.createHmac('sha256', process.env.WEBHOOK_APP_SECRET).update(req.body).digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
        console.warn('[Directory WH] Invalid signature — dropping');
        return;
      }
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body);
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    if (!value?.messages?.length) return;

    const msg = value.messages[0];
    const contact = value.contacts?.[0];
    // [BSUID] from may be phone or BSUID — Meta accepts both for sending
    const from = msg.user_id || contact?.user_id || msg.from;

    // Mark as read
    wa.markRead(DIR_PID(), DIR_TOKEN(), msg.id).catch(() => {});

    // Resolve which admin number received this message
    const recvPid = value.metadata?.phone_number_id;
    const adminNum = await getAdminNumber(recvPid);
    _cachedAdminNumber = { pid: adminNum.pid, token: adminNum.token };

    logActivity({ actorType: 'customer', actorId: from, action: 'directory.query_received', category: 'directory', description: `Directory query from ${from}`, severity: 'info' });

    // Log incoming message
    col('admin_messages').insertOne({
      _id: newId(), admin_number_id: recvPid, phone_number_id: recvPid,
      customer_phone: from, direction: 'incoming',
      message_type: msg.type, message_content: msg.text?.body || msg.interactive?.button_reply?.title || msg.type,
      wa_message_id: msg.id, timestamp: new Date(),
    }).catch(() => {});

    // Route by message type
    if (msg.type === 'interactive') {
      await handleInteractive(from, msg.interactive);
    } else if (msg.type === 'location') {
      await handleLocation(from, msg.location);
    } else if (msg.type === 'text') {
      await handleText(from, msg.text.body.trim());
    } else {
      await sendWelcome(from);
    }
  } catch (err) {
    console.error('[Directory WH] Error:', err.message);
  }
});

// ─── HANDLE TEXT MESSAGES ───────────────────────────────────────
async function handleText(from, text) {
  const lower = text.toLowerCase();

  if (['hi', 'hello', 'hey', 'start', 'menu'].includes(lower)) {
    return sendWelcome(from);
  }

  if (lower.startsWith('search ')) {
    const query = text.substring(7).trim();
    const listings = await directory.searchListings({ query });
    return directory.sendDirectoryResults(from, listings, `Results for "${query}"`);
  }

  // Treat any text as a search query
  const listings = await directory.searchListings({ query: text });
  if (listings.length) {
    return directory.sendDirectoryResults(from, listings, `Results for "${text}"`);
  }

  // No results — send helpful message
  return wa.sendButtons(DIR_PID(), DIR_TOKEN(), from, {
    header: 'No Results',
    body: `We couldn't find restaurants matching "${text}".\n\nTry searching by city, cuisine, or restaurant name.`,
    footer: 'GullyBite Directory',
    buttons: [
      { id: 'DIR_BROWSE_ALL', title: 'Browse All' },
      { id: 'DIR_BROWSE_VEG', title: 'Pure Veg Only' },
    ],
  });
}

// ─── HANDLE INTERACTIVE (BUTTON / LIST) ─────────────────────────
async function handleInteractive(from, interactive) {
  const id = interactive.button_reply?.id || interactive.list_reply?.id || '';

  if (id === 'DIR_BROWSE_ALL') {
    const listings = await directory.searchListings({ limit: 10 });
    return directory.sendDirectoryResults(from, listings, 'All Restaurants');
  }

  if (id === 'DIR_BROWSE_VEG') {
    const listings = await directory.searchListings({ type: 'veg', limit: 10 });
    return directory.sendDirectoryResults(from, listings, 'Pure Veg Restaurants');
  }

  if (id === 'DIR_BROWSE_NONVEG') {
    const listings = await directory.searchListings({ type: 'non_veg', limit: 10 });
    return directory.sendDirectoryResults(from, listings, 'Non-Veg Restaurants');
  }

  if (id.startsWith('DIR_VIEW_')) {
    const restaurantId = id.replace('DIR_VIEW_', '');
    const listing = await require('../config/database').col('directory_listings').findOne({ restaurant_id: restaurantId });
    if (listing) {
      logActivity({ actorType: 'system', action: 'directory.restaurant_shared', category: 'directory', description: `Restaurant shared with ${from}`, severity: 'info' });
      return directory.sendRestaurantCard(from, listing);
    }
    return wa.sendText(DIR_PID(), DIR_TOKEN(), from, 'Sorry, this restaurant is no longer available.');
  }

  if (id.startsWith('DIR_ORDER_')) {
    const restaurantId = id.replace('DIR_ORDER_', '');
    const listing = await require('../config/database').col('directory_listings').findOne({ restaurant_id: restaurantId });
    if (!listing) return wa.sendText(DIR_PID(), DIR_TOKEN(), from, 'Restaurant not found.');

    // Find the restaurant's WhatsApp number and send the customer there
    const waAccount = await require('../config/database').col('whatsapp_accounts').findOne({
      restaurant_id: restaurantId,
      is_active: true,
    });

    const name = listing.brand_name || listing.business_name;
    // [WhatsApp2026] Prefer username-based link, fall back to phone
    const orderUrl = (waAccount?.business_username && waAccount?.username_status === 'active')
      ? `https://wa.me/${waAccount.business_username}?text=Hi%2C%20I%27d%20like%20to%20order`
      : waAccount?.wa_phone_number
        ? `https://wa.me/${waAccount.wa_phone_number}?text=Hi%2C%20I%27d%20like%20to%20order`
        : null;
    if (orderUrl) {
      // Create referral record for commission tracking
      await createDirectoryReferral(restaurantId, from);

      const usernameNote = (waAccount?.business_username && waAccount?.username_status === 'active')
        ? `\n💬 @${waAccount.business_username}` : '';
      return wa.sendText(DIR_PID(), DIR_TOKEN(), from,
        `Great choice! To order from *${name}*, send them a message on WhatsApp:${usernameNote}\n\n` +
        `👉 ${orderUrl}\n\n` +
        `Just say "Hi" and they'll send you their menu!\n\n` +
        `💡 Order within the next ${REFERRAL_WINDOW_HRS} hours through this link for the best experience!`
      );
    }

    if (listing.store_slug) {
      const baseUrl = process.env.BASE_URL || 'https://gully-bite.vercel.app';
      return wa.sendText(DIR_PID(), DIR_TOKEN(), from,
        `To order from *${name}*, visit their store:\n\n` +
        `👉 ${baseUrl}/store/${listing.store_slug}`
      );
    }

    return wa.sendText(DIR_PID(), DIR_TOKEN(), from,
      `*${name}* is setting up their ordering. Check back soon!`
    );
  }

  if (id.startsWith('DIR_STORE_')) {
    const restaurantId = id.replace('DIR_STORE_', '');
    const listing = await require('../config/database').col('directory_listings').findOne({ restaurant_id: restaurantId });
    if (listing?.store_slug) {
      const baseUrl = process.env.BASE_URL || 'https://gully-bite.vercel.app';
      return wa.sendText(DIR_PID(), DIR_TOKEN(), from,
        `View ${listing.brand_name || listing.business_name}'s store page:\n\n` +
        `👉 ${baseUrl}/store/${listing.store_slug}`
      );
    }
    return wa.sendText(DIR_PID(), DIR_TOKEN(), from, 'Store page not available yet.');
  }

  if (id === 'DIR_BACK') {
    return sendWelcome(from);
  }

  // Unknown button — send welcome
  return sendWelcome(from);
}

// ─── HANDLE LOCATION SHARE ──────────────────────────────────────
async function handleLocation(from, loc) {
  const { latitude, longitude } = loc;
  try {
    const listings = await col('directory_listings').aggregate([
      { $match: { status: 'active' } },
      { $lookup: { from: 'branches', localField: 'restaurant_id', foreignField: 'restaurant_id', as: 'branches' } },
      { $unwind: { path: '$branches', preserveNullAndEmptyArrays: false } },
      { $addFields: {
        _dist: {
          $multiply: [6371, { $acos: { $min: [1, { $add: [
            { $multiply: [{ $sin: { $degreesToRadians: latitude } }, { $sin: { $degreesToRadians: '$branches.latitude' } }] },
            { $multiply: [{ $cos: { $degreesToRadians: latitude } }, { $cos: { $degreesToRadians: '$branches.latitude' } }, { $cos: { $subtract: [{ $degreesToRadians: '$branches.longitude' }, { $degreesToRadians: longitude }] } }] },
          ] }] } }],
        },
      } },
      { $match: { _dist: { $lte: 10 } } },
      { $sort: { _dist: 1 } },
      { $group: { _id: '$restaurant_id', doc: { $first: '$$ROOT' }, dist: { $first: '$_dist' } } },
      { $limit: 5 },
    ]).toArray();

    if (listings.length) {
      const results = listings.map(l => ({ ...l.doc, _distKm: l.dist.toFixed(1) }));
      return directory.sendDirectoryResults(from, results, 'Restaurants near you');
    }
    return wa.sendText(DIR_PID(), DIR_TOKEN(), from, 'No restaurants found within 10 km. Try typing a restaurant name instead.');
  } catch (err) {
    console.error('[Directory] Location search failed:', err.message);
    return wa.sendText(DIR_PID(), DIR_TOKEN(), from, 'Could not search your area. Try typing a restaurant name.');
  }
}

// ─── WELCOME MESSAGE ────────────────────────────────────────────
async function sendWelcome(from) {
  return wa.sendButtons(DIR_PID(), DIR_TOKEN(), from, {
    header: 'GullyBite Directory',
    body: 'Welcome to GullyBite! 🍽️\n\nFind restaurants near you and order food directly on WhatsApp — no app needed.\n\n*How to search:*\nJust type a restaurant name, cuisine, or city.\n📍 Or share your location to find nearby restaurants.\n\nTap below to browse:',
    footer: 'GullyBite — Order food on WhatsApp',
    buttons: [
      { id: 'DIR_BROWSE_ALL', title: 'Browse All' },
      { id: 'DIR_BROWSE_VEG', title: 'Pure Veg' },
      { id: 'DIR_BROWSE_NONVEG', title: 'Non-Veg' },
    ],
  });
}

// ─── REFERRAL CREATION ──────────────────────────────────────────
async function createDirectoryReferral(restaurantId, customerPhone) {
  try {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + REFERRAL_WINDOW_HRS * 3600000);

    // Expire previous active referral for same restaurant + customer (prevent double-charge)
    await col('referrals').updateMany(
      { restaurant_id: restaurantId, customer_wa_phone: customerPhone, status: 'active' },
      { $set: { status: 'expired', updated_at: now } }
    );

    await col('referrals').insertOne({
      _id: newId(),
      source: 'directory',
      restaurant_id: restaurantId,
      customer_wa_phone: customerPhone,
      customer_name: null,
      notes: 'Auto-created from GullyBite directory',
      status: 'active',
      expires_at: expiresAt,
      orders_count: 0,
      total_order_value_rs: 0,
      referral_fee_rs: 0,
      created_at: now,
      updated_at: now,
    });

    logActivity({ actorType: 'system', action: 'directory.referral_created', category: 'referral', description: `Directory referral created for restaurant ${restaurantId}`, restaurantId, severity: 'info' });
  } catch (err) {
    console.error('[Directory] Referral creation failed:', err.message);
  }
}

module.exports = router;
