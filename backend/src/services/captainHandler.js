'use strict';

const wa = require('./whatsapp');
const customerIdentity = require('./customerIdentity');
const captainMessages = require('./captainMessages');
const { col, newId } = require('../config/database');
const { hashPhone } = require('../utils/phoneHash');
const log = require('../utils/logger').child({ component: 'captainHandler' });

// Fire-and-forget user_signals writer. Never awaited, never throws.
function logSignal(db, data) {
  setImmediate(async () => {
    try {
      await db.collection('user_signals').insertOne({
        _id: newId(),
        customer_id: data.customer_id,
        city_id: data.city_id,
        session_id: data.session_id || null,
        listing_id: data.listing_id || null,
        action: data.action,
        context: data.context || null,
        schema_version: 1,
        ts: new Date(),
      });
    } catch (err) {
      log.warn({ err: err.message, action: data.action }, 'logSignal insert failed (swallowed)');
    }
  });
}

// Derive a coarse message_type from the incoming Meta payload. Map
// unknown shapes to 'unknown' so the log never silently misclassifies.
function _captainMessageType(message) {
  const t = message?.type;
  if (!t) return 'unknown';
  if (t === 'text' || t === 'interactive' || t === 'image' || t === 'location') return t;
  return t;
}

// Fire-and-forget log writer. Own try/catch; never awaited; never
// propagates. Reads the post-handler session state via one findOne
// so the log carries the actual transition even if the handler
// mutated state mid-flow.
function writeCaptainInboundLog(db, { cityId, customerId, sessionId, phoneHash, messageType, stateBefore, hadError }) {
  setImmediate(() => {
    (async () => {
      try {
        let stateAfter = stateBefore;
        if (sessionId) {
          try {
            const fresh = await db.collection('city_captain_sessions').findOne(
              { _id: sessionId },
              { projection: { state: 1 } },
            );
            if (fresh?.state) stateAfter = fresh.state;
          } catch { /* swallow — log is best-effort */ }
        }
        await db.collection('captain_inbound_logs').insertOne({
          _id: newId(),
          city_id: cityId,
          customer_id: customerId,
          phone_hash: phoneHash,
          message_type: messageType,
          session_state_before: stateBefore,
          session_state_after: stateAfter,
          had_error: !!hadError,
          ts: new Date(),
        });
      } catch (err) {
        log.warn({ err: err.message }, 'captain_inbound_logs insert failed (swallowed)');
      }
    })();
  });
}

// Pull taxonomy from the captain:taxonomy Redis cache or fall back to
// platform_settings._id='tag_taxonomy'.
async function loadTaxonomy(db, redisClient) {
  try {
    const cached = await redisClient.get('captain:taxonomy');
    if (cached) return JSON.parse(cached);
  } catch { /* fall through */ }
  return db.collection('platform_settings').findOne({ _id: 'tag_taxonomy' });
}

// 6-char alphanumeric (admin.js _generateRefCode style).
function _generateRefCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return code;
}

// Find or create city captain customer. Tags new rows with source='city_captain'.
async function ensureCustomer(message, contact) {
  const { bsuid, wa_phone, meta_bsuid } = customerIdentity.extractIdentifiers(message, contact);
  const profile_name = contact?.profile?.name;
  const customer = await customerIdentity.getOrCreateCustomer({ bsuid, wa_phone, meta_bsuid, profile_name });
  // Only stamp source='city_captain' on the first sighting. If `source`
  // is already set (e.g. customer came in via a restaurant first), do not
  // overwrite — we still treat them as a city-captain customer for this
  // session but the original source wins.
  if (customer && !customer.source) {
    await col('customers').updateOne(
      { _id: customer._id, source: { $exists: false } },
      { $set: { source: 'city_captain', captain_first_seen_at: new Date() } },
    );
  }
  return customer;
}

// Helpers to detect message shape.
function buttonReplyId(msg) {
  return msg?.interactive?.button_reply?.id || null;
}
function listReplyId(msg) {
  return msg?.interactive?.list_reply?.id || null;
}
function anyReplyId(msg) {
  return buttonReplyId(msg) || listReplyId(msg);
}
function isText(msg) { return msg?.type === 'text' && typeof msg?.text?.body === 'string'; }
function isImage(msg) { return msg?.type === 'image' && msg?.image?.id; }

// Send helper that adapts a payload object to the right wa.* function.
// captainMessages may return a single payload OR an array of payloads
// (listingCard returns [text, buttons]). Each payload object has a
// `_send` key indicating which sender to use ('text' | 'buttons' | 'list').
// — but actually captainMessages returns "send args" objects keyed by
// function signature. We detect by shape:
//   { buttons: [...] }     → sendButtons
//   { sections: [...] }    → sendList
//   { body: 'text', _text: true } or { _text: 'string' } → sendText
// For simplicity captainMessages returns:
//   sendText payload: { _text: '...' }
//   sendButtons payload: { body, buttons, header?, footer? }
//   sendList payload: { body, buttonText, sections, footer? }
async function sendPayload(pid, to, payload) {
  if (Array.isArray(payload)) {
    for (const p of payload) await sendPayload(pid, to, p);
    return;
  }
  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (payload?._text) {
    return wa.sendText(pid, token, to, payload._text);
  }
  if (payload?.buttons) {
    return wa.sendButtons(pid, token, to, payload);
  }
  if (payload?.sections) {
    return wa.sendList(pid, token, to, payload);
  }
  log.warn({ payload }, 'sendPayload: unknown payload shape — skipping');
}

// ─── MAIN ENTRY ────────────────────────────────────────────────
async function handleInbound(db, redisClient, message, contact, cityId) {
  // STEP 1 — city
  const city = await db.collection('cities').findOne({ _id: cityId });
  if (!city) { log.warn({ cityId }, 'handleInbound: city not found'); return; }
  const pid = String(city.phone_number_id);

  // STEP 2 — customer
  const customer = await ensureCustomer(message, contact);
  if (!customer) { log.warn({ cityId }, 'handleInbound: customer ensure failed'); return; }
  const to = customerIdentity.resolveRecipient(customer);

  // STEP 3 — session upsert
  const sessionFilter = { customer_id: customer._id, city_id: cityId };
  const now = new Date();
  const upsertRes = await db.collection('city_captain_sessions').findOneAndUpdate(
    sessionFilter,
    {
      $setOnInsert: {
        _id: newId(),
        customer_id: customer._id,
        city_id: cityId,
        state: 'onboarding_q1',
        onboarding_cuisine_picks: [],
        active_filters: {},
        created_at: now,
      },
      $set: { updated_at: now },
    },
    { upsert: true, returnDocument: 'after' },
  );
  const session = upsertRes.value || upsertRes; // driver returns differ across versions
  // The Mongo native driver populates lastErrorObject.upserted (an _id)
  // only when findOneAndUpdate actually inserted a new doc. This is
  // strictly correct vs the old created_at-window heuristic, which
  // could mis-fire under clock skew or slow upserts.
  const wasNew = !!(upsertRes?.lastErrorObject?.upserted);

  // Capture inbound-log fields BEFORE the switch so we have the
  // pre-handler state even when a case early-returns. The log itself
  // fires from the finally block via setImmediate (fire-and-forget).
  const stateBefore = session?.state || 'unknown';
  const phoneRaw = customer?.wa_phone || customer?.bsuid || null;
  let phoneHashVal = null;
  try { phoneHashVal = phoneRaw ? hashPhone(String(phoneRaw)) : null; } catch { phoneHashVal = null; }
  const messageType = _captainMessageType(message);

  let hadError = false;
  try {
    // STEP 4 — route by state
    switch (session.state) {
    case 'onboarding_q1': {
      if (wasNew) {
        // Brand-new session — send Q1 regardless of content.
        await sendPayload(pid, to, captainMessages.q1Buttons(city.name));
        return;
      }
      const reply = buttonReplyId(message);
      if (!reply) {
        await sendPayload(pid, to, captainMessages.q1Buttons(city.name));
        return;
      }
      // Map veg button → discovery_prefs.veg_status
      const vegMap = { veg_only: 'veg', eggetarian: 'eggetarian', non_veg: 'non-veg' };
      const veg = vegMap[reply];
      if (!veg) {
        await sendPayload(pid, to, captainMessages.q1Buttons(city.name));
        return;
      }
      await col('customers').updateOne(
        { _id: customer._id },
        { $set: { 'discovery_prefs.veg_status': veg, updated_at: new Date() } },
      );
      await db.collection('city_captain_sessions').updateOne(
        { _id: session._id },
        { $set: { state: 'onboarding_q2_picks', onboarding_cuisine_picks: [], updated_at: new Date() } },
      );
      const taxonomy = await loadTaxonomy(db, redisClient);
      const cuisineOpts = (taxonomy?.cuisine_primary || []).slice(0, 10);
      await sendPayload(pid, to, captainMessages.q2CuisineList(cuisineOpts, []));
      return;
    }

    case 'onboarding_q2_picks': {
      const reply = listReplyId(message);
      if (!reply) {
        // Re-prompt.
        const taxonomy = await loadTaxonomy(db, redisClient);
        const cuisineOpts = (taxonomy?.cuisine_primary || []).slice(0, 10);
        await sendPayload(pid, to, captainMessages.q2CuisineList(cuisineOpts, session.onboarding_cuisine_picks || []));
        return;
      }
      if (reply === 'cuisine_done' || (session.onboarding_cuisine_picks || []).length >= 3) {
        // Advance to Q3.
        await col('customers').updateOne(
          { _id: customer._id },
          { $set: { 'discovery_prefs.cuisine_likes': session.onboarding_cuisine_picks || [], updated_at: new Date() } },
        );
        await db.collection('city_captain_sessions').updateOne(
          { _id: session._id },
          { $set: { state: 'onboarding_q3', updated_at: new Date() } },
        );
        await sendPayload(pid, to, captainMessages.q3Buttons());
        return;
      }
      if (reply.startsWith('cuisine_pick_')) {
        const value = reply.replace(/^cuisine_pick_/, '');
        const picks = Array.isArray(session.onboarding_cuisine_picks) ? [...session.onboarding_cuisine_picks] : [];
        if (!picks.includes(value) && picks.length < 3) picks.push(value);
        await db.collection('city_captain_sessions').updateOne(
          { _id: session._id },
          { $set: { onboarding_cuisine_picks: picks, updated_at: new Date() } },
        );
        if (picks.length >= 3) {
          // Auto-advance.
          await col('customers').updateOne(
            { _id: customer._id },
            { $set: { 'discovery_prefs.cuisine_likes': picks, updated_at: new Date() } },
          );
          await db.collection('city_captain_sessions').updateOne(
            { _id: session._id },
            { $set: { state: 'onboarding_q3', updated_at: new Date() } },
          );
          await sendPayload(pid, to, captainMessages.q3Buttons());
          return;
        }
        const taxonomy = await loadTaxonomy(db, redisClient);
        const cuisineOpts = (taxonomy?.cuisine_primary || []).slice(0, 10);
        await sendPayload(pid, to, captainMessages.q2CuisineList(cuisineOpts, picks));
        return;
      }
      // Unknown id → re-prompt.
      const taxonomy = await loadTaxonomy(db, redisClient);
      const cuisineOpts = (taxonomy?.cuisine_primary || []).slice(0, 10);
      await sendPayload(pid, to, captainMessages.q2CuisineList(cuisineOpts, session.onboarding_cuisine_picks || []));
      return;
    }

    case 'onboarding_q3': {
      const reply = buttonReplyId(message);
      const priceMap = { price_budget: 'budget', price_mid: 'mid', price_premium: 'premium' };
      const price = priceMap[reply];
      if (!price) {
        await sendPayload(pid, to, captainMessages.q3Buttons());
        return;
      }
      await col('customers').updateOne(
        { _id: customer._id },
        { $set: { 'discovery_prefs.price_band_default': price, updated_at: new Date() } },
      );
      await db.collection('city_captain_sessions').updateOne(
        { _id: session._id },
        { $set: { state: 'browsing', updated_at: new Date() } },
      );
      logSignal(db, { customer_id: customer._id, city_id: cityId, session_id: session._id, action: 'onboarding_complete' });
      await sendPayload(pid, to, captainMessages.browsingMenu(city.name));
      return;
    }

    case 'browsing':
      return handleBrowsing(db, redisClient, city, customer, session, message, to);

    case 'awaiting_menu_photo':
      return handleAwaitingMenuPhoto(db, city, customer, session, message, to);

    default:
      // Unknown state — reset to browsing menu.
      await db.collection('city_captain_sessions').updateOne(
        { _id: session._id },
        { $set: { state: 'browsing', updated_at: new Date() } },
      );
      await sendPayload(pid, to, captainMessages.browsingMenu(city.name));
      return;
    }
  } catch (err) {
    hadError = true;
    throw err;
  } finally {
    writeCaptainInboundLog(db, {
      cityId,
      customerId: customer?._id || null,
      sessionId: session?._id || null,
      phoneHash: phoneHashVal,
      messageType,
      stateBefore,
      hadError,
    });
  }
}

// ─── BROWSING STATE HANDLER ───────────────────────────────────
async function handleBrowsing(db, redisClient, city, customer, session, message, to) {
  const pid = String(city.phone_number_id);
  const cityId = city._id;
  const reply = anyReplyId(message);

  if (reply) {
    // Filter list replies
    if (reply.startsWith('filter_cuisine_')) {
      const value = reply.replace(/^filter_cuisine_/, '');
      await db.collection('city_captain_sessions').updateOne(
        { _id: session._id },
        { $set: { 'active_filters.cuisine': value, updated_at: new Date() } },
      );
      return runListingSearch(db, city, customer, { ...(session.active_filters || {}), cuisine: value }, session, to);
    }
    if (reply.startsWith('filter_area_')) {
      const value = reply.replace(/^filter_area_/, '');
      await db.collection('city_captain_sessions').updateOne(
        { _id: session._id },
        { $set: { 'active_filters.area': value, updated_at: new Date() } },
      );
      return runListingSearch(db, city, customer, { ...(session.active_filters || {}), area: value }, session, to);
    }
    if (reply.startsWith('filter_price_')) {
      const value = reply.replace(/^filter_price_/, '');
      await db.collection('city_captain_sessions').updateOne(
        { _id: session._id },
        { $set: { 'active_filters.price_band': value, updated_at: new Date() } },
      );
      return runListingSearch(db, city, customer, { ...(session.active_filters || {}), price_band: value }, session, to);
    }
    if (reply === 'browse_new') {
      const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      return runListingSearch(db, city, customer, { ...(session.active_filters || {}), created_after: cutoff }, session, to, 'New this week');
    }
    if (reply === 'browse_veg') {
      return runListingSearch(db, city, customer, { ...(session.active_filters || {}), veg_status: 'veg' }, session, to, 'Veg places');
    }
    if (reply === 'browse_menu') {
      await sendPayload(pid, to, captainMessages.browsingMenu(city.name));
      return;
    }
    if (reply === 'contribute_photo') {
      await db.collection('city_captain_sessions').updateOne(
        { _id: session._id },
        { $set: { state: 'awaiting_menu_photo', updated_at: new Date() } },
      );
      await sendPayload(pid, to, { _text: '📸 Great — please share a clear photo of the menu. Just attach it as an image to your next message.' });
      return;
    }
    if (reply.startsWith('listing_')) {
      const listingId = reply.replace(/^listing_/, '');
      const listing = await db.collection('city_listings').findOne({ _id: listingId });
      if (!listing) {
        await sendPayload(pid, to, { _text: '😕 Sorry — that listing is no longer available.' });
        return;
      }
      logSignal(db, { customer_id: customer._id, city_id: cityId, session_id: session._id, listing_id: listing._id, action: 'menu_viewed' });
      const payload = captainMessages.listingCard(listing);
      await sendPayload(pid, to, payload);
      return;
    }
    if (reply.startsWith('notify_me_')) {
      const listingId = reply.replace(/^notify_me_/, '');
      await db.collection('notify_intents').updateOne(
        { listing_id: listingId, customer_id: customer._id },
        {
          $setOnInsert: { _id: newId(), listing_id: listingId, customer_id: customer._id, city_id: cityId, created_at: new Date() },
          $set: { updated_at: new Date() },
        },
        { upsert: true },
      );
      logSignal(db, { customer_id: customer._id, city_id: cityId, session_id: session._id, listing_id: listingId, action: 'tapped_notify_me' });
      await sendPayload(pid, to, { _text: '🔔 Got it — we will notify you here when this place opens for orders.' });
      return;
    }
    if (reply.startsWith('order_now_')) {
      const listingId = reply.replace(/^order_now_/, '');
      const listing = await db.collection('city_listings').findOne({ _id: listingId });
      if (!listing) {
        await sendPayload(pid, to, { _text: '😕 Sorry — that listing is no longer available.' });
        return;
      }
      if (!listing.linked_restaurant_id) {
        await sendPayload(pid, to, { _text: '🚧 This place is not yet on GullyBite ordering. Try "Notify me 🔔" to be alerted when it opens.' });
        return;
      }
      // Resolve restaurant + WABA number for the wa.me link.
      const restaurant = await db.collection('restaurants').findOne({ _id: listing.linked_restaurant_id });
      const waAcc = await db.collection('whatsapp_accounts').findOne({ restaurant_id: listing.linked_restaurant_id, is_active: true });
      const phone = (waAcc?.wa_phone_number || '').replace(/[^0-9]/g, '');
      if (!restaurant || !phone) {
        await sendPayload(pid, to, { _text: '😕 We could not generate an order link right now. Please try again later.' });
        return;
      }
      // Generate a GBREF code; insert referral_links so restaurant-side
      // detection finds it; create referrals row with source=city_captain
      // so attribution starts at handoff time.
      let code;
      for (let attempt = 0; attempt < 5; attempt++) {
        code = _generateRefCode();
        const exists = await db.collection('referral_links').findOne({ code });
        if (!exists) break;
      }
      const waLink = `https://wa.me/${phone}?text=${encodeURIComponent('Hi 👋 GBREF-' + code)}`;
      await db.collection('referral_links').insertOne({
        _id: newId(),
        code,
        restaurant_id: restaurant._id,
        listing_id: listingId,
        restaurant_name: restaurant.business_name || restaurant.brand_name || '',
        restaurant_phone: phone,
        campaign_name: 'city_captain',
        wa_link: waLink,
        click_count: 0,
        status: 'active',
        created_by: 'city_captain',
        source: 'city_captain',
        created_at: new Date(),
        expires_at: null,
      });
      try {
        const refAttr = require('./referralAttribution');
        await refAttr.createReferral({
          restaurantId: restaurant._id,
          customerPhone: customer.wa_phone || customer.bsuid,
          customerBsuid: customer.bsuid,
          customerName: customer.name,
          source: 'city_captain',
          referralCode: code,
          notes: 'city_captain order handoff',
        });
      } catch (err) {
        log.warn({ err: err.message }, 'createReferral failed (continuing with wa.me link)');
      }
      logSignal(db, { customer_id: customer._id, city_id: cityId, session_id: session._id, listing_id: listingId, action: 'gbref_link_generated', context: { code } });
      await sendPayload(pid, to, { _text: `🛵 Tap to order from *${listing.name}*:\n${waLink}` });
      return;
    }
    // Unknown reply → fall through to menu.
    await sendPayload(pid, to, captainMessages.browsingMenu(city.name));
    return;
  }

  if (isImage(message)) {
    // Treat as direct menu-photo submission.
    await handleAwaitingMenuPhoto(db, city, customer, session, message, to);
    return;
  }

  if (isText(message)) {
    // Per spec — no free-text parsing yet. Re-show menu with a gentle note.
    await sendPayload(pid, to, { _text: 'Use the options below to explore 👇' });
    await sendPayload(pid, to, captainMessages.browsingMenu(city.name));
    return;
  }

  // Unknown shape — re-show menu.
  await sendPayload(pid, to, captainMessages.browsingMenu(city.name));
}

// ─── LISTING SEARCH ───────────────────────────────────────────
async function runListingSearch(db, city, customer, filters, session, to, appliedLabel) {
  const pid = String(city.phone_number_id);
  const cityId = city._id;
  const q = { city_id: cityId, status: 'active' };
  if (filters.cuisine) q['tags.cuisine_primary'] = filters.cuisine;
  if (filters.area) q.area = filters.area;
  if (filters.price_band === 'premium') {
    q['tags.price_band'] = { $in: ['premium', 'luxury'] };
  } else if (filters.price_band) {
    q['tags.price_band'] = filters.price_band;
  }
  if (filters.veg_status) q['tags.veg_status'] = filters.veg_status;
  if (filters.created_after) q.created_at = { $gte: filters.created_after };

  const now = new Date();
  // Pipeline-style sort: sponsored first, then editorial, then created_at.
  // findOne-style sort doesn't support computed fields, so we use a
  // lightweight aggregate.
  const listings = await db.collection('city_listings').aggregate([
    { $match: q },
    { $addFields: { _is_sponsored: { $cond: [{ $gt: ['$sponsored_until', now] }, 1, 0] } } },
    { $sort: { _is_sponsored: -1, editorial_boost_score: -1, created_at: -1 } },
    { $limit: 8 },
  ]).toArray();

  if (listings.length === 0) {
    await sendPayload(pid, to, { _text: 'No matches yet for that filter. Try a different one 👇' });
    await sendPayload(pid, to, captainMessages.browsingMenu(city.name));
    return;
  }
  // Batch user_signals: listing_card_shown per listing.
  for (const l of listings) {
    logSignal(db, { customer_id: customer._id, city_id: cityId, session_id: session._id, listing_id: l._id, action: 'listing_card_shown' });
  }
  const payload = captainMessages.listingsResultList(listings, appliedLabel || null);
  await sendPayload(pid, to, payload);
}

// ─── AWAITING-MENU-PHOTO HANDLER ──────────────────────────────
async function handleAwaitingMenuPhoto(db, city, customer, session, message, to) {
  const pid = String(city.phone_number_id);
  const cityId = city._id;
  if (!isImage(message)) {
    await sendPayload(pid, to, { _text: '📸 Please share a photo — attach an image to your next message.' });
    return;
  }
  const snapshotId = newId();
  await db.collection('menu_snapshots').insertOne({
    _id: snapshotId,
    listing_id: null,
    city_id: cityId,
    customer_id: customer._id,
    source: 'user_contribution',
    media_id: message.image.id,
    media_mime_type: message.image.mime_type || null,
    status: 'needs_review',
    is_live: false,
    submitted_at: new Date(),
    created_at: new Date(),
    schema_version: 1,
  });
  await db.collection('city_captain_sessions').updateOne(
    { _id: session._id },
    { $set: { state: 'browsing', updated_at: new Date() } },
  );
  logSignal(db, { customer_id: customer._id, city_id: cityId, session_id: session._id, action: 'sent_menu_photo', context: { snapshot_id: snapshotId } });
  await sendPayload(pid, to, { _text: '🙏 Thanks for the photo! Our team will review it shortly.' });
  await sendPayload(pid, to, captainMessages.browsingMenu(city.name));
}

module.exports = { handleInbound };
