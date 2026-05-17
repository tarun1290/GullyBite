'use strict';

// Captain re-engagement send. Triggered when a city_listings doc flips
// to fulfillment_mode='handoff' with a linked_restaurant_id set —
// every customer who had previously tapped "Notify me 🔔" on this
// listing gets a one-time WhatsApp marketing message announcing the
// listing is live for ordering. Sent from the city captain's WABA
// number (not the restaurant's marketing number) so the customer's
// existing captain thread stays the source of truth for that city.
//
// ─── Meta template definition (submit manually before sending) ───
// Name:        marketing_captain_listing_live_v1
// Category:    MARKETING
// Language:    en_US
// Body:        "Hey {{1}}! Great news — {{2}} just joined GullyBite.
//              Tap below to explore their menu and place your first order."
// Button:      URL button, label "Order now 🎉",
//              URL prefix: https://gullybite.duckdns.org/r/ + {{1}} (dynamic)
//
// Body variables: {{1}} = customer first name or "there", {{2}} = restaurant name.
// Button dynamic suffix: the GBREF code generated below.
// Never attempt to send unless campaign_templates row status === 'APPROVED'.

const wa = require('./whatsapp');
const { col, newId } = require('../config/database');
const log = require('../utils/logger').child({ component: 'captainReengagement' });

const TEMPLATE_NAME = 'marketing_captain_listing_live_v1';
const REDIRECT_BASE = 'https://gullybite.duckdns.org/r';
const DEFAULT_MARKUP_MULTIPLIER = 1.0;

// Inline 6-char alphanumeric code generator — matches captainHandler.js
// order_now branch character set + length. Keep this generator local so
// captainHandler changes can't change the captain re-engagement code
// shape underneath us.
function _generateRefCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return code;
}

function firstName(customer) {
  const n = String(customer?.name || '').trim();
  if (!n) return 'there';
  return n.split(/\s+/)[0] || 'there';
}

async function runReengagementJob(db, redisClient, listingId, cityId) {
  // STEP 1 — load listing, city, restaurant.
  const listing = await db.collection('city_listings').findOne({ _id: listingId });
  if (!listing) { log.warn({ listingId }, 'listing not found — skipping'); return; }
  if (listing.fulfillment_mode !== 'handoff' || !listing.linked_restaurant_id) {
    log.info({ listingId, fulfillment_mode: listing.fulfillment_mode }, 'listing no longer eligible — skipping');
    return;
  }
  const city = await db.collection('cities').findOne({ _id: cityId || listing.city_id });
  if (!city?.phone_number_id) { log.warn({ cityId }, 'city missing phone_number_id'); return; }
  const restaurant = await db.collection('restaurants').findOne({ _id: listing.linked_restaurant_id });
  if (!restaurant) { log.warn({ listingId, restaurantId: listing.linked_restaurant_id }, 'restaurant not found'); return; }
  const waAcc = await db.collection('whatsapp_accounts').findOne({ restaurant_id: listing.linked_restaurant_id, is_active: true });
  const restaurantPhone = String(waAcc?.wa_phone_number || '').replace(/[^0-9]/g, '');
  if (!restaurantPhone) { log.warn({ listingId, restaurantId: listing.linked_restaurant_id }, 'restaurant has no active WhatsApp number'); return; }

  // STEP 2 — template gate. Never send unless APPROVED.
  const template = await db.collection('campaign_templates').findOne({ template_id: TEMPLATE_NAME });
  if (!template) {
    log.warn({ template: TEMPLATE_NAME }, 'template row missing in campaign_templates — cannot send');
    return;
  }
  if (template.status !== 'APPROVED') {
    log.warn({ template: TEMPLATE_NAME, status: template.status }, 'template not APPROVED — skipping all sends');
    return;
  }
  const perMessageCostRs = Number(template.per_message_cost_rs) || 0;

  // STEP 3 — load notify_intents + customers, filter eligible.
  const intents = await db.collection('notify_intents').find({
    listing_id: listingId,
    $or: [{ fulfilled: { $ne: true } }, { reengaged_at: { $exists: false } }],
  }).toArray();

  if (intents.length === 0) {
    log.info({ listingId }, 'no notify_intents — nothing to send');
    return;
  }

  const customerIds = intents.map((i) => i.customer_id);
  const customers = await db.collection('customers')
    .find({ _id: { $in: customerIds } })
    .toArray();
  const customerById = new Map(customers.map((c) => [String(c._id), c]));

  // Pre-load the restaurant-scoped marketing block-list as a Set.
  const blockedSet = new Set();
  const blockedRows = await db.collection('marketing_blocklist').find(
    { restaurant_id: String(listing.linked_restaurant_id) },
    { projection: { customer_id: 1 } },
  ).toArray();
  for (const b of blockedRows) blockedSet.add(String(b.customer_id));

  // Platform-pricing markup multiplier (same source as marketingCampaigns.js).
  const pricingSettings = await db.collection('platform_settings').findOne(
    { _id: 'wa_pricing' },
    { projection: { markup_multiplier: 1 } },
  );
  const markupMultiplier = Number.isFinite(Number(pricingSettings?.markup_multiplier))
    ? Number(pricingSettings.markup_multiplier)
    : DEFAULT_MARKUP_MULTIPLIER;

  // STEP 4+5 — per-recipient eligibility + send.
  let sentCount = 0;
  let skippedCount = 0;
  const sentIntentIds = [];

  for (const intent of intents) {
    const customer = customerById.get(String(intent.customer_id));
    if (!customer) { skippedCount++; continue; }
    if (customer.marketing_opted_in === false) { skippedCount++; continue; }
    if (blockedSet.has(String(customer._id))) { skippedCount++; continue; }
    const to = customer.wa_phone || customer.bsuid;
    if (!to) { skippedCount++; continue; }

    // Pre-generate the marketing_messages._id so we can embed it on
    // the referral_links row BEFORE the send. The same id is reused
    // when the marketing_messages row is inserted below (after the
    // wa.sendTemplate call). This is what lets gbrefRedirect.js stamp
    // tapped_at / clicked back onto the originating marketing row on
    // a GBREF tap.
    const marketingMessageId = newId();

    // STEP 4 — generate GBREF code; insert referral_links + referrals
    // (mirror captainHandler.js order_now branch). source name is
    // distinct so analytics can split organic captain handoffs from
    // re-engagement-driven ones.
    let code;
    for (let attempt = 0; attempt < 5; attempt++) {
      code = _generateRefCode();
      const exists = await db.collection('referral_links').findOne({ code });
      if (!exists) break;
    }
    const redirectUrl = `${REDIRECT_BASE}/${code}`;
    const waLink = `https://wa.me/${restaurantPhone}?text=${encodeURIComponent('GBREF-' + code)}`;
    await db.collection('referral_links').insertOne({
      _id: newId(),
      code,
      restaurant_id: restaurant._id,
      listing_id: listingId,
      restaurant_name: restaurant.business_name || restaurant.brand_name || '',
      restaurant_phone: restaurantPhone,
      campaign_name: 'city_captain_reengagement',
      wa_link: waLink,
      click_count: 0,
      status: 'active',
      created_by: 'city_captain_reengagement',
      source: 'city_captain_reengagement',
      marketing_message_id: marketingMessageId,
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
        source: 'city_captain_reengagement',
        referralCode: code,
        notes: `captain reengagement listing=${listingId}`,
      });
    } catch (err) {
      log.warn({ err: err.message, code }, 'createReferral failed — continuing with send');
    }

    // STEP 5 — send the template via the CAPTAIN's WABA number.
    const components = [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: firstName(customer) },
          { type: 'text', text: restaurant.business_name || restaurant.brand_name || 'this restaurant' },
        ],
      },
      {
        // URL button dynamic suffix — the runtime parameter appended to
        // the template's base URL prefix in Meta's template registry.
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: code }],
      },
    ];

    const pid = String(city.phone_number_id);
    const token = process.env.META_SYSTEM_USER_TOKEN;
    if (!token) { log.error('META_SYSTEM_USER_TOKEN missing — aborting send loop'); break; }

    let messageId = null;
    try {
      const resp = await wa.sendTemplate(pid, token, to, {
        name: TEMPLATE_NAME,
        language: template.language || 'en_US',
        components,
      });
      messageId = resp?.messages?.[0]?.id || null;
    } catch (err) {
      log.warn({ err: err.message, customerId: customer._id, code }, 'sendTemplate failed — skipping recipient');
      skippedCount++;
      continue;
    }

    // STEP 5 (continued) — write the per-message billing trail in
    // marketing_messages, matching the per-row fields used by
    // marketingCampaigns.js. We attribute the cost to the linked
    // restaurant since the conversion lands in their inbox.
    const platformChargeRs = Number((perMessageCostRs * markupMultiplier).toFixed(4));
    const platformMarginRs = Number((platformChargeRs - perMessageCostRs).toFixed(4));
    await db.collection('marketing_messages').insertOne({
      _id: marketingMessageId,
      message_id: messageId ? String(messageId) : null,
      campaign_source: 'city_captain_reengagement',
      listing_id: listingId,
      city_id: city._id,
      restaurant_id: restaurant._id,
      customer_id: customer._id ? String(customer._id) : null,
      to,
      template_id: TEMPLATE_NAME,
      referral_code: code,
      meta_cost_rs: perMessageCostRs,
      platform_charge_rs: platformChargeRs,
      platform_margin_rs: platformMarginRs,
      sent_at: new Date(),
      created_at: new Date(),
    }).catch((err) => log.warn({ err: err.message, messageId }, 'marketing_messages insert failed'));

    sentCount++;
    sentIntentIds.push(intent._id);
  }

  // STEP 6 — mark intents fulfilled so they don't re-send on the next job run.
  if (sentIntentIds.length > 0) {
    await db.collection('notify_intents').updateMany(
      { _id: { $in: sentIntentIds } },
      { $set: { reengaged_at: new Date(), fulfilled: true, updated_at: new Date() } },
    ).catch((err) => log.warn({ err: err.message }, 'notify_intents fulfilled-stamp failed'));
  }

  // STEP 7 — summary log.
  log.info(
    { listingId, eligible: intents.length, sent: sentCount, skipped: skippedCount },
    'captain reengagement job complete',
  );
}

module.exports = { runReengagementJob, TEMPLATE_NAME };
