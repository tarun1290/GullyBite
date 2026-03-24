// src/webhooks/directory.js
// WhatsApp webhook handler for the Directory WABA
// Separate from the restaurant WABA — this is GullyBite's discovery number

'use strict';

const express = require('express');
const router = express.Router();
const directory = require('../services/directory');
const wa = require('../services/whatsapp');
const { logActivity } = require('../services/activityLog');

const DIR_PID   = () => process.env.DIRECTORY_WA_PHONE_NUMBER_ID;
const DIR_TOKEN = () => process.env.DIRECTORY_WA_ACCESS_TOKEN;

// ─── WEBHOOK VERIFICATION ───────────────────────────────────────
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.DIRECTORY_WA_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── INCOMING MESSAGES ──────────────────────────────────────────
router.post('/', express.json(), async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    if (!value?.messages?.length) return;

    const msg = value.messages[0];
    const contact = value.contacts?.[0];
    // [BSUID] from may be phone or BSUID — Meta accepts both for sending
    const from = msg.user_id || contact?.user_id || msg.from;

    // Mark as read
    wa.markRead(DIR_PID(), DIR_TOKEN(), msg.id).catch(() => {});

    logActivity({ actorType: 'customer', actorId: from, action: 'directory.query_received', category: 'directory', description: `Directory query from ${from}`, severity: 'info' });

    // Route by message type
    if (msg.type === 'interactive') {
      await handleInteractive(from, msg.interactive);
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
      const usernameNote = (waAccount?.business_username && waAccount?.username_status === 'active')
        ? `\n💬 @${waAccount.business_username}` : '';
      return wa.sendText(DIR_PID(), DIR_TOKEN(), from,
        `Great choice! To order from *${name}*, send them a message on WhatsApp:${usernameNote}\n\n` +
        `👉 ${orderUrl}\n\n` +
        `Just say "Hi" and they'll send you their menu!`
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

// ─── WELCOME MESSAGE ────────────────────────────────────────────
async function sendWelcome(from) {
  return wa.sendButtons(DIR_PID(), DIR_TOKEN(), from, {
    header: 'GullyBite Directory',
    body: 'Welcome to GullyBite! 🍽️\n\nFind restaurants near you and order food directly on WhatsApp — no app needed.\n\n*How to search:*\nJust type a restaurant name, cuisine, or city.\n\nOr tap below to browse:',
    footer: 'GullyBite — Order food on WhatsApp',
    buttons: [
      { id: 'DIR_BROWSE_ALL', title: 'Browse All' },
      { id: 'DIR_BROWSE_VEG', title: 'Pure Veg' },
      { id: 'DIR_BROWSE_NONVEG', title: 'Non-Veg' },
    ],
  });
}

module.exports = router;
