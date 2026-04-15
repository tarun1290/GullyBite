// src/webhooks/whatsapp.js
// ⚡ THE BRAIN OF THE SYSTEM ⚡
// Every WhatsApp message and event comes through here.
// Meta sends a POST request to /webhooks/whatsapp for every event.
//
// IMPORTANT: Must respond with HTTP 200 within 5 seconds.
// We respond immediately and process asynchronously.

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { col, newId } = require('../config/database');
const wa = require('../services/whatsapp');
const location = require('../services/location');
const metaConfig = require('../config/meta');
const orderSvc = require('../services/order');
const paymentSvc = require('../services/payment');
const addressSvc = require('../services/address');
const flowMgr = require('../services/flowManager');
const couponSvc = require('../services/coupon');
const etaSvc = require('../services/eta');
const loyaltySvc = require('../services/loyalty');
const notify = require('../services/notify');
const { getNextRetryAt, retryDefaults } = require('../utils/retry');
const { waMessageLimiter, waOrderLimiter, abuseDetector, isPhoneBlocked, isBlocked, rateLimit, adaptiveRateLimit, recordAbuseEvent, RateLimitExceededError, extractSenderIdentifier, extractPhoneNumberId } = require('../middleware/rateLimit');
const customerIdentity = require('../services/customerIdentity');
const Brand = require('../models/Brand');
const issueSvc = require('../services/issues');
const { logActivity } = require('../services/activityLog');
const ws = require('../services/websocket');
const memcache = require('../config/memcache');
// [IDEMPOTENCY] keys.order(customerId, branchId, cart) builds a stable
// fingerprint of the cart contents so two double-clicks with the same cart
// collapse to one order. See utils/withIdempotency.js for details.
const { keys: idemKeys } = require('../utils/withIdempotency');
const log = require('../utils/logger').child({ component: 'whatsapp' });

// Phase 1 flow handler (additive). Gated entirely by env so the legacy
// flowManager path remains the default. To enable:
//   PHASE1_FLOW_ENABLED=true
// Optional per-number allow-list (comma-separated phone_number_ids):
//   PHASE1_FLOW_PHONE_IDS=123456,654321
const phase1Flow = require('../whatsapp/flowHandler');
function _phase1FlowEnabled(phoneNumberId) {
  if (process.env.PHASE1_FLOW_ENABLED !== 'true') return false;
  const allow = (process.env.PHASE1_FLOW_PHONE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allow.length === 0) return true;
  return allow.includes(String(phoneNumberId));
}

// ─── GET: WEBHOOK VERIFICATION ────────────────────────────────
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    req.log.info('Meta webhook verified');
    return res.status(200).send(challenge);
  }
  req.log.error('Webhook verification failed. Check WEBHOOK_VERIFY_TOKEN in .env');
  res.sendStatus(403);
});

// ─── POST: INCOMING EVENTS ────────────────────────────────────
router.post('/', express.raw({ type: '*/*' }), async (req, res) => {
  // Must ALWAYS return 200 to Meta — even for rate-limited / blocked messages
  res.sendStatus(200);

  // Entry-point diagnostic logging
  req.log.info({
    bodyExists: !!req.body,
    bodyType: typeof req.body,
    bodyLen: req.body?.length || 0,
    ct: req.headers['content-type'],
    hasSig: !!req.headers['x-hub-signature-256'],
  }, 'Webhook entry');

  // Heartbeat: track last webhook received (fire-and-forget, never blocks)
  try { col('platform_health').updateOne({ _id: 'webhook_heartbeat' }, { $set: { last_received: new Date() }, $inc: { count_24h: 1 } }, { upsert: true }); } catch (_) {}

  let logId = null;
  try {
    const sig = req.headers['x-hub-signature-256']?.split('sha256=')[1];
    const expected = crypto
      .createHmac('sha256', process.env.WEBHOOK_APP_SECRET)
      .update(req.body)
      .digest('hex');

    if (!sig || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
      req.log.warn({ hasAppSecret: !!process.env.WEBHOOK_APP_SECRET }, 'Signature mismatch');
      return;
    }
    req.log.info('Signature passed');

    const body = JSON.parse(req.body);
    if (body.object !== 'whatsapp_business_account') {
      req.log.info({ object: body.object }, 'Ignored — not whatsapp_business_account');
      return;
    }

    // [BSUID] ── ABUSE CHECK: blocked identifier (phone or BSUID) ──
    const senderIdentifier = extractSenderIdentifier(body);
    if (senderIdentifier) {
      // Two block sources to check:
      //   1. Mongo blocked_phones — durable 24h auto-blocks / manual bans
      //   2. Redis blocked:wa:<phone> — short-lived (10min) abuse-score blocks
      const [mongoBlocked, redisBlock] = await Promise.all([
        isPhoneBlocked(senderIdentifier),
        isBlocked(`wa:${senderIdentifier}`),
      ]);
      if (mongoBlocked || redisBlock.blocked) {
        req.log.warn({ senderIdentifier, source: mongoBlocked ? 'mongo' : 'redis' }, 'Blocked identifier dropped');
        return; // silently drop — already returned 200
      }

      // ── RATE LIMIT CHECK ──
      // Adaptive limit driven by trust tier (low=3/10, medium=5/10, high=15/10).
      // adaptiveRateLimit already feeds the abuse scorer AND applies a
      // trust penalty on WA overflow, so we don't repeat those here.
      // Legacy waMessageLimiter (30/min, per-process) remains as a
      // belt-and-suspenders for the Redis-less fallback path.
      let specAllowed = true;
      try {
        await adaptiveRateLimit('wa', senderIdentifier);
      } catch (e) {
        if (e instanceof RateLimitExceededError) specAllowed = false;
        else throw e;
      }
      const { allowed: legacyAllowed } = waMessageLimiter.isAllowed(senderIdentifier);
      if (!specAllowed || !legacyAllowed) {
        req.log.warn({ senderIdentifier, specAllowed, legacyAllowed }, 'Message rate limited');
        // Record violation for BOTH scorers. Mongo-backed abuseDetector
        // drives 24h auto-blocks; Redis-backed recordAbuseEvent drives
        // 10-min cool-downs on repeated offenders within a single session.
        abuseDetector.recordViolation(senderIdentifier).catch(() => {});
        recordAbuseEvent(`wa:${senderIdentifier}`, 'rate_limit_hit_wa').catch(() => {});
        // Log rate-limited event
        await col('webhook_logs').insertOne({
          _id: newId(),
          source: 'whatsapp',
          event_type: 'rate_limited',
          phone_number_id: extractPhoneNumberId(body),
          payload: { from: senderIdentifier, note: 'Rate limited — payload omitted' },
          processed: true,
          error_message: `Rate limited: ${senderIdentifier}`,
          received_at: new Date(),
          processed_at: new Date(),
          ...retryDefaults(),
          retry_status: 'success',
        }).catch(() => {});
        return; // silently drop — already returned 200
      }
    }

    logId = await logWebhook('whatsapp', body).catch(() => null);

    await processWhatsAppWebhook(logId, body);

    // Mark webhook as processed
    if (logId) {
      await col('webhook_logs').updateOne(
        { _id: logId },
        { $set: { processed: true, processed_at: new Date(), retry_status: 'success' } }
      ).catch(() => {});
    }
  } catch (err) {
    req.log.error({ err }, 'Processing error');
    logActivity({ actorType: 'webhook', action: 'bot.error', category: 'webhook', description: `WhatsApp bot error: ${err.message}`, severity: 'error', metadata: { error: err.message } });
    // Schedule for retry
    if (logId) {
      await col('webhook_logs').updateOne(
        { _id: logId },
        {
          $set: { error_message: err.message, last_error: err.message, retry_status: 'pending', next_retry_at: getNextRetryAt(0) },
          $push: { error_history: { error: err.message, attempted_at: new Date() } },
        }
      ).catch(() => {});
    }
  }
});

// ─── REUSABLE PROCESSOR (called by POST handler and retry job) ──
const processWhatsAppWebhook = async (logId, body) => {
  const tasks = [];
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;
      tasks.push(processChange(change.value).catch(err => log.error({ err }, 'Change processing error')));
    }
  }
  if (tasks.length) await Promise.allSettled(tasks);
};

// ─── PROCESS A CHANGE OBJECT ──────────────────────────────────
let _dedupIndexCreated = false;
const processChange = async (value) => {
  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId) { log.info('No phone_number_id in metadata — skipping'); return; }

  const msgCount = value.messages?.length || 0;
  const statusCount = value.statuses?.length || 0;
  log.info({ phoneNumberId, msgCount, statusCount }, 'Processing change');

  // Ensure dedup TTL index exists (lazy, once)
  if (!_dedupIndexCreated) {
    col('_webhook_dedup').createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600, background: true }).catch(() => {});
    col('_error_cooldown').createIndex({ t: 1 }, { expireAfterSeconds: 60, background: true }).catch(() => {});
    _dedupIndexCreated = true;
  }

  const { getWaAccount } = require('../utils/cachedLookup');
  const waAccount = await getWaAccount(phoneNumberId);
  if (!waAccount) {
    log.warn({ phoneNumberId }, 'No WA account found — message will NOT be processed');
    return;
  }
  log.info({ restaurantId: waAccount.restaurant_id }, 'WA account matched');

  // ─── BRAND ROUTING (additive, non-blocking) ──────────────────
  // Resolve the brand by phone_number_id via the Brand model. If found,
  // stamp brand_id, business_id, and the raw phone_number_id onto the
  // waAccount so every downstream writer in this change (message
  // capture, order creation, etc.) picks up brand context for free.
  //
  // Fallback ladder when phone_number_id has no direct brand match:
  //   1. Load the business (restaurants row) via waAccount.business_id
  //      or legacy waAccount.restaurant_id.
  //   2. business_type === 'single' → adopt business.default_brand_id
  //      as the effective brand (single-brand tenants shouldn't need
  //      to register their WABA in the brands collection to benefit
  //      from brand-scoped writes).
  //   3. business_type === 'multi' (or any other value) → leave
  //      brand_id null; the legacy single-brand path handles it.
  // Any failure at any step falls through to the legacy path —
  // parsing and response logic are untouched.
  waAccount.phone_number_id_received = phoneNumberId;
  try {
    const brand = await Brand.findByPhoneNumberId(phoneNumberId);
    if (brand) {
      waAccount.brand_id = brand._id;
      waAccount.business_id = brand.business_id;
      log.info({ brandId: brand._id, businessId: brand.business_id, phoneNumberId }, 'Brand matched for webhook');
    } else {
      // No direct brand row — try the business-aware fallback.
      const businessId = waAccount.business_id || waAccount.restaurant_id || null;
      if (businessId) {
        try {
          const biz = await col('restaurants').findOne(
            { _id: String(businessId) },
            { projection: { business_type: 1, default_brand_id: 1 } }
          );
          const type = biz?.business_type || 'single';  // legacy rows = single
          if (type === 'single' && biz?.default_brand_id) {
            const defaultBrand = await Brand.findById(biz.default_brand_id);
            if (defaultBrand) {
              waAccount.brand_id = defaultBrand._id;
              waAccount.business_id = defaultBrand.business_id || String(businessId);
              log.info({ brandId: defaultBrand._id, businessId: waAccount.business_id, phoneNumberId, via: 'default_brand' }, 'Default brand applied for single-business');
            } else {
              log.info({ phoneNumberId, businessId }, 'Default brand id set but brand row missing — legacy fallback');
            }
          } else {
            log.info({ phoneNumberId, businessId, businessType: type }, 'No brand match — using legacy single-brand fallback');
          }
        } catch (err) {
          log.warn({ err, phoneNumberId, businessId }, 'Business lookup for brand fallback failed — continuing with legacy path');
        }
      } else {
        log.info({ phoneNumberId }, 'No brand match and no business context — using legacy single-brand fallback');
      }
    }
  } catch (err) {
    log.warn({ err, phoneNumberId }, 'Brand lookup failed — continuing with fallback');
  }

  // Use system user token for all messaging (never-expiring, set via env var)
  waAccount.access_token = metaConfig.systemUserToken || waAccount.access_token;

  for (const msg of value.messages || []) {
    log.info({ msgId: msg.id, type: msg.type, from: msg.from || msg.user_id || '?' }, 'Processing message');

    // Guard: skip stale messages (>2 min old — likely Meta retries)
    if (msg.timestamp) {
      const age = Date.now() - parseInt(msg.timestamp) * 1000;
      if (age > 120000) { log.info({ msgId: msg.id, ageSec: Math.round(age/1000) }, 'Stale message dropped'); continue; }
    }

    // Dedup: skip if we already processed this message (Meta retries)
    if (msg.id) {
      try {
        const existing = await col('_webhook_dedup').findOne({ _id: msg.id });
        if (existing) { log.info({ msgId: msg.id }, 'Dedup: skipping already-processed message'); continue; }
        await col('_webhook_dedup').insertOne({ _id: msg.id, createdAt: new Date() });
      } catch (e) {
        if (e.code === 11000) { log.info({ msgId: msg.id }, 'Dedup: duplicate insert, skipping'); continue; }
      }
    }

    const msgStart = Date.now();

    // [BSUID] Extract both phone and BSUID from webhook payload
    const contact = value.contacts?.find(c => c.wa_id === msg.from || c.user_id === msg.from || c.user_id === msg.user_id);
    const { bsuid, wa_phone } = customerIdentity.extractIdentifiers(msg, contact);
    const senderName = contact?.profile?.name;
    // Best identifier for sending error messages back
    const replyTo = wa_phone || bsuid || msg.from;

    // [BSUID] Persist sighting fire-and-forget — stamp bsuid_seen_at so
    // we can trace Meta's June 2026 rollout even if the rest of the flow
    // never writes a customers row (e.g. blocked phone, dedup race).
    // Also fallback-detects if msg.from is itself BSUID-shaped but
    // extractIdentifiers didn't surface it (belt-and-braces).
    const sightedBsuid = bsuid || (customerIdentity.isBsuid(msg.from) ? msg.from : null);
    if (sightedBsuid) {
      setImmediate(() => {
        (async () => {
          try {
            const filter = wa_phone
              ? { $or: [{ bsuid: sightedBsuid }, { wa_phone }] }
              : { bsuid: sightedBsuid };
            const res = await col('customers').updateOne(
              filter,
              { $set: { bsuid: sightedBsuid, bsuid_seen_at: new Date() } },
              { upsert: false },
            );
            if (res.matchedCount) {
              console.log(`[BSUID] Detected and stored for customer ${sightedBsuid.slice(0, 12)}…`);
            }
          } catch (err) {
            log.warn({ err, bsuid: sightedBsuid.slice(0, 12) }, '[BSUID] sighting stamp failed');
          }
        })();
      });
    }

    await wa.markRead(phoneNumberId, waAccount.access_token, msg.id);

    // [WhatsApp2026] Show typing indicator while processing
    wa.showTyping(phoneNumberId, waAccount.access_token, replyTo);

    // ─── PHASE 1 FLOW HANDLER (feature-flagged) ─────────────
    // When enabled, the new conversational state machine handles the
    // message. If it defers (returns { handled: false }), fall through
    // to the legacy flowManager path untouched. This lets us roll the
    // new UX forward one phone_number_id at a time.
    if (_phase1FlowEnabled(phoneNumberId)) {
      try {
        const res = await phase1Flow.handle({
          phone_number_id: phoneNumberId,
          from: replyTo,
          message: msg,
        });
        if (res && res.handled) {
          log.info({ msgId: msg.id, state: 'phase1_handled' }, 'Phase 1 flow handled message');
          continue;
        }
        log.info({ msgId: msg.id, reason: res?.reason }, 'Phase 1 flow deferred — legacy path');
      } catch (err) {
        log.warn({ err, msgId: msg.id }, 'Phase 1 flow threw — legacy path will handle');
      }
    }

    logActivity({
      actorType: 'customer', actorId: wa_phone || bsuid, actorName: senderName,
      action: 'customer.message_received', category: 'webhook',
      description: `Incoming ${msg.type} message from ${senderName || wa_phone || bsuid}`,
      restaurantId: waAccount.restaurant_id, resourceType: 'message',
      metadata: { type: msg.type, state: 'processing' }, severity: 'info',
    });

    try {
      await handleMessage(msg, { bsuid, wa_phone }, senderName, waAccount);
      log.info({ messageType: msg.type, phone: wa_phone?.slice(-4), durationMs: Date.now() - msgStart }, 'Message processed');
    } catch (err) {
      log.error({ err, phone: wa_phone?.slice(-4), durationMs: Date.now() - msgStart }, 'Error handling message');
      logActivity({
        actorType: 'webhook', action: 'bot.error', category: 'webhook',
        description: `Error processing message: ${err.message}`,
        restaurantId: waAccount.restaurant_id, severity: 'error',
        metadata: { error: err.message, from: wa_phone || bsuid },
      });
      // Send dead-end error — NO keywords that trigger the bot (no MENU, ORDER, etc.)
      const errorCooldownKey = `err_${replyTo}`;
      const recentErr = await col('_error_cooldown').findOne({ _id: errorCooldownKey, t: { $gt: new Date(Date.now() - 30000) } }).catch(() => null);
      if (!recentErr) {
        await col('_error_cooldown').updateOne({ _id: errorCooldownKey }, { $set: { t: new Date() } }, { upsert: true }).catch(() => {});
        await wa.sendText(phoneNumberId, waAccount.access_token, replyTo,
          'Sorry, something went wrong on our end. Please try again in a moment.'
        ).catch(() => {});
      }
    }
  }

  for (const status of value.statuses || []) {
    await handleStatus(status);
  }
};

// ─── HANDLE INCOMING MESSAGE ──────────────────────────────────
// [BSUID] senderIdentifiers is now { bsuid, wa_phone } instead of plain phone string
const handleMessage = async (msg, senderIdentifiers, senderName, waAccount) => {
  const customer = await orderSvc.getOrCreateCustomer({
    bsuid: senderIdentifiers.bsuid,
    wa_phone: senderIdentifiers.wa_phone,
    profile_name: senderName,
  });
  const conv = await orderSvc.getOrCreateConversation(customer.id, String(waAccount._id));

  // [BSUID] Stash BSUID on the live session so downstream handlers can
  // prefer it for identity resolution without a second DB lookup. Only
  // writes when the session's current value differs.
  const sessionBsuid = senderIdentifiers.bsuid || customer.bsuid || null;
  if (sessionBsuid && conv.session_data?.bsuid !== sessionBsuid) {
    col('conversations').updateOne(
      { _id: conv.id },
      { $set: { 'session_data.bsuid': sessionBsuid } },
    ).catch(err => log.warn({ err, convId: conv.id }, '[BSUID] session stash failed'));
    conv.session_data = { ...(conv.session_data || {}), bsuid: sessionBsuid };
  }

  // [BSUID] Handle contacts message type (phone number sharing flow — Step 13)
  if (msg.type === 'contacts' && conv.state === 'AWAITING_PHONE_FOR_PAYMENT') {
    await handlePhoneShared(msg, customer, conv, waAccount);
    return;
  }

  if (msg.type === 'text') {
    await handleTextMessage(msg, customer, conv, waAccount);
  } else if (msg.type === 'location') {
    await handleLocationMessage(msg, customer, conv, waAccount);
  } else if (msg.type === 'order') {
    await handleCatalogOrder(msg, customer, conv, waAccount);
  } else if (msg.type === 'interactive') {
    await handleInteractiveReply(msg, customer, conv, waAccount);
  } else {
    // If in issue description state, capture media as issue content
    const msgType = msg.type;
    if (conv && conv.state === 'AWAITING_ISSUE_DESCRIPTION') {
      const session = conv.session_data || {};
      const pid = waAccount.phone_number_id;
      const token = waAccount.access_token;
      const to = customerIdentity.resolveRecipient(customer);
      const waAccount2 = await col('whatsapp_accounts').findOne({ phone_number_id: pid });
      const restId = waAccount2?.restaurant_id || session.restaurant_id;
      const mediaObj = msg[msgType]; // msg.image, msg.audio, etc
      const mediaItem = mediaObj ? [{ media_id: mediaObj.id, media_type: msgType, caption: mediaObj.caption || null }] : [];

      const issue = await issueSvc.createIssue({
        customerId: customer._id,
        customerName: customer.name || customer.wa_name,
        customerPhone: customer.wa_phone,
        orderId: session.issue_order_id || null,
        orderNumber: session.issue_order_number || null,
        restaurantId: restId,
        branchId: session.issue_branch_id || null,
        category: session.issue_category,
        description: mediaObj?.caption || `[${msgType} message]`,
        media: mediaItem,
        source: 'whatsapp',
      });

      logActivity({ actorType: 'customer', actorId: customer.wa_phone || customer.bsuid, action: 'customer.issue_raised', category: 'issue', description: `Issue raised by ${customer.name || customer.wa_phone || customer.bsuid}`, restaurantId: restId, severity: 'info' });
      await wa.sendText(pid, token, to,
        `✅ Issue #${issue.issue_number} has been created.\n\nWe'll get back to you shortly. You'll receive updates here on WhatsApp.`
      );
      await orderSvc.setState(conv.id, 'GREETING', {});
      return;
    }

    // Skip audio/video from inbox — only capture text-like and image messages
    if (msgType === 'audio' || msgType === 'video') {
      const to = customerIdentity.resolveRecipient(customer);
      await wa.sendText(waAccount.phone_number_id, waAccount.access_token, to,
        'We currently support text and image messages. Please type your query or send a photo.'
      );
      return;
    }

    // Capture image, document, sticker, contact, location to inbox
    await captureCustomerMessage(msg, customer, conv, waAccount);
    const to = customerIdentity.resolveRecipient(customer);
    await wa.sendText(waAccount.phone_number_id, waAccount.access_token, to,
      'Thanks for your message! The restaurant team will get back to you shortly. 😊\n\nType *MENU* to browse our menu or *TRACK* to check your order.'
    );
  }
};

// ─── CHECKOUT TEMPLATE HELPER ─────────────────────────────────
// Tries to send the checkout button template with in-WhatsApp payment.
// Falls back to the text-based sendOrderSummary if the template isn't approved or fails.
// When checkout template succeeds, creates the order so Razorpay webhook can match it.
const _sendOrderCheckout = async (pid, token, to, { orderNumber, items, charges, subtotal, deliveryFee, total, discount, dynamicNote, session, customer, waAccount }) => {
  // Try interactive order_details checkout (Razorpay in-WhatsApp payment)
  const checkoutEnabled = !!(process.env.RAZORPAY_WA_CONFIG_NAME || (await col('platform_settings').findOne({ _id: 'checkout_order' }))?.enabled);
  if (checkoutEnabled && session?.branchId && session?.cart?.length) {
    try {
      const branch = await col('branches').findOne({ _id: session.branchId });
      const restaurant = branch ? await col('restaurants').findOne({ _id: branch.restaurant_id }) : null;

      // Create order in PENDING_PAYMENT state so Razorpay webhook can match it.
      // [IDEMPOTENCY] Pass idempotencyKey so a double-click on the Pay button
      // (or a webhook retry, or a stuck client) returns the SAME order.
      const order = await orderSvc.createOrder({
        idempotencyKey: idemKeys.order(customer?.id, session.branchId, session.cart),
        convId       : session.convId || null,
        customerId   : customer?.id,
        branchId     : session.branchId,
        cart         : session.cart,
        subtotalRs   : session.subtotalRs || Number(subtotal) || 0,
        deliveryFeeRs: session.deliveryFeeRs || Number(deliveryFee) || 0,
        totalRs      : session.totalRs || Number(total) || 0,
        discountRs   : session.discountRs || 0,
        couponId     : session.coupon?.id || null,
        couponCode   : session.coupon?.code || null,
        deliveryAddress: session.deliveryAddress,
        deliveryLat  : session.deliveryLat,
        deliveryLng  : session.deliveryLng,
        waPhone      : customer?.wa_phone || customer?.bsuid,
        charges      : charges || session.charges || null,
        deliveryFeeBreakdown: session.deliveryFeeBreakdown || null,
        deliveryQuote: session.deliveryQuote || null,
        structuredAddress: session.structuredAddress || null,
        addressSource: session.addressSource || null,
      });

      const refId = order.order_number.substring(0, 35).replace(/[^a-zA-Z0-9_\-\.]/g, '-');
      const taxRs = charges ? (charges.food_gst_rs || 0) + (charges.customer_delivery_gst_rs || 0) + (charges.packaging_gst_rs || 0) : 0;
      const discountRs = discount?.amountRs || 0;

      // Build a fake fullOrder for sendPaymentRequest (same shape as getOrderDetails returns)
      const checkoutOrder = {
        order_number: order.order_number, id: order.id,
        subtotal_rs: charges?.subtotal_rs || Number(subtotal) || 0,
        customer_delivery_rs: charges?.customer_delivery_rs || Number(deliveryFee) || 0,
        delivery_fee_rs: charges?.customer_delivery_rs || Number(deliveryFee) || 0,
        food_gst_rs: charges?.food_gst_rs || 0,
        customer_delivery_gst_rs: charges?.customer_delivery_gst_rs || 0,
        packaging_gst_rs: charges?.packaging_gst_rs || 0,
        discount_rs: discountRs,
        coupon_code: discount?.code || null,
        total_rs: charges?.customer_total_rs || Number(total) || 0,
        business_name: restaurant?.business_name || branch?.name || 'Restaurant',
        items: (items || []).map(i => ({ item_name: i.name, quantity: i.qty || 1, unit_price_rs: Number(i.price) || 0, retailer_id: i.retailer_id || i.name })),
      };
      await wa.sendPaymentRequest(pid, token, to, {
        order: checkoutOrder,
        items: checkoutOrder.items,
        customerName: customer?.name || 'there',
        restaurantName: restaurant?.business_name || branch?.name,
        deliveryAddress: session.deliveryAddress || null,
      });

      // Update session with order ID and transition to AWAITING_PAYMENT
      const conv = customer?.id ? await col('conversations').findOne({ customer_id: customer.id, 'session_data.branchId': session.branchId }) : null;
      if (conv) {
        await orderSvc.setState(conv._id, 'AWAITING_PAYMENT', {
          ...session,
          orderId: order.id,
          orderNumber: order.order_number,
          checkoutOrder: true,
        });
      }

      log.info({ orderNumber: order.order_number, orderId: order.id }, 'order_details sent');

      // Save a payment record so the Razorpay webhook can match by reference_id
      await col('payments').insertOne({
        _id: newId(),
        order_id: order.id,
        reference_id: refId,
        payment_type: 'checkout_order',
        amount_rs: charges?.customer_total_rs || Number(total) || 0,
        currency: 'INR',
        status: 'pending',
        created_at: new Date(),
      }).catch(e => log.warn({ err: e }, 'Payment record save failed'));

      return;
    } catch (checkoutErr) {
      log.warn({ err: checkoutErr }, 'order_details send failed, falling back to text summary');
    }
  }

  // Fallback: if interactive checkout is disabled or failed, send simple retry text
  await wa.sendText(pid, token, to, '⚠️ We had trouble loading your checkout. Please send your cart again to retry.');

  // Track as review_pending abandoned cart (will be recovered when order is confirmed)
  if (session?.branchId && customer?.id) {
    const { guard: guardCR } = require('../utils/smartModule');
    guardCR('CART_RECOVERY', {
      fn: () => {
        const cartRecovery = require('../services/cart-recovery');
        return cartRecovery.trackAbandonedCart({
          restaurantId: waAccount?.restaurant_id, branchId: session.branchId,
          customerId: customer.id, customerPhone: customer.wa_phone || customer.bsuid,
          customerName: customer.name,
          cartItems: (items || []).map(i => ({ product_retailer_id: null, quantity: i.qty || 1, item_price: Number(i.price) || 0, currency: 'INR', item_name: i.name })),
          cartTotal: Number(charges?.customer_total_rs || total) || 0,
          itemCount: (items || []).reduce((s, i) => s + (i.qty || 1), 0),
          abandonmentStage: 'review_pending',
          deliveryAddress: session.deliveryAddress ? { full_address: session.deliveryAddress } : null,
          lastCustomerMessageAt: new Date(),
        });
      },
      fallback: undefined,
      label: 'trackAbandonedCart:review',
      context: { customerId: customer.id },
    }); // fire-and-forget — no await needed
  }
};

// ─── TEXT MESSAGE HANDLER ─────────────────────────────────────
const handleTextMessage = async (msg, customer, conv, waAccount) => {
  const pid = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to = customerIdentity.resolveRecipient(customer);
  let rawText = msg.text.body.trim();

  // ── GBREF code detection (referral tracking — invisible to customer) ──
  const gbrefMatch = rawText.match(/GBREF-([a-zA-Z0-9]{4,10})/i);
  if (gbrefMatch) {
    const refCode = gbrefMatch[1];
    log.info({ refCode, phone: (customer.wa_phone || customer.bsuid)?.slice(-4) }, 'GBREF detected');
    try {
      const refLink = await col('referral_links').findOne({ code: refCode, status: 'active' });
      if (refLink) {
        col('referral_links').updateOne({ _id: refLink._id }, { $inc: { click_count: 1 } }).catch(() => {});
        const refAttr = require('../services/referralAttribution');
        await refAttr.refreshOrCreateReferral({
          restaurantId: refLink.restaurant_id,
          customerPhone: customer.wa_phone || customer.bsuid,
          customerBsuid: customer.bsuid,
          customerName: customer.name,
          source: 'gbref',
          referralCode: refCode,
          referralLinkId: String(refLink._id),
          notes: refLink.campaign_name,
        });
      } else {
        log.info({ refCode }, 'GBREF code not found or not active — ignoring');
      }
    } catch (e) {
      log.warn({ err: e }, 'GBREF processing error');
    }

    // Strip the GBREF code from the message, continue with cleaned text
    rawText = rawText.replace(/GBREF-[a-zA-Z0-9]{4,10}/gi, '').trim();
    if (!rawText) rawText = 'Hi'; // If message was only the code, treat as greeting
    msg.text.body = rawText;
  }

  const text = rawText.toUpperCase();

  // ── Google Maps URL detection ─────────────────────────────
  if (location.isMapsUrl(rawText)) {
    const mapsUrl = location.extractMapsUrl(rawText) || rawText;
    log.info({ mapsUrl: mapsUrl.substring(0, 100) }, 'Maps URL detected');
    try {
      const coords = await location.extractCoordsFromMapsUrl(mapsUrl);
      if (coords) {
        log.info({ lat: coords.lat, lng: coords.lng }, 'Extracted coords from Maps URL');
        // Treat this the same as a location pin drop — delegate to location handler
        const syntheticLocationMsg = {
          type: 'location',
          location: { latitude: coords.lat, longitude: coords.lng },
        };
        await handleLocationMessage(syntheticLocationMsg, customer, conv, waAccount);
        return;
      }
    } catch (e) {
      log.error({ err: e }, 'Maps URL parse failed');
    }
    // If parsing failed, ask for pin drop instead
    await wa.sendText(pid, token, to,
      "I couldn't read that Maps link. You can:\n\n" +
      "📍 *Share your live location* — tap the + button → Location → Send your current location\n" +
      "🔗 *Send a Google Maps link* — open Google Maps → select location → tap Share → copy link → paste here\n" +
      "✍️ *Type your full address* — e.g., 123 Main St, Banjara Hills, Hyderabad 500034\n\n" +
      "All options work — pick whichever is easiest!"
    );
    return;
  }

  // ── Recovery opt-out ──
  if (['STOP', 'UNSUBSCRIBE'].includes(text)) {
    const cartRecovery = require('../services/cart-recovery');
    await cartRecovery.optOut(customer.wa_phone || customer.bsuid, waAccount.restaurant_id);
    await wa.sendText(pid, token, to, "No worries! We won't send you cart reminders. You can always message us when you're ready to order. 😊");
    return;
  }

  // ── Recovery re-engagement: check for abandoned cart when customer says ORDER/CART/CONTINUE ──
  if (['ORDER', 'CART', 'CONTINUE', 'COMPLETE ORDER'].includes(text) && conv.state === 'GREETING') {
    try {
      const cartRecovery = require('../services/cart-recovery');
      const reEngagement = await cartRecovery.handleReEngagement(customer.wa_phone || customer.bsuid, waAccount.restaurant_id);
      if (reEngagement?.validItems?.length) {
        log.info({ validItemCount: reEngagement.validItems.length }, 'Cart recovery re-engagement');
        if (reEngagement.removedItems.length) {
          await wa.sendText(pid, token, to, `⚠️ ${reEngagement.removedItems.length} item(s) from your previous cart are no longer available.`);
        }
        // If we have address and branch, go straight to order review
        if (reEngagement.deliveryAddress && reEngagement.branchId) {
          // Store cart in session and process as catalog order
          const productItems = reEngagement.validItems.map(i => ({ product_retailer_id: i.product_retailer_id, quantity: i.quantity, item_price: String(Math.round(i.item_price * 100)), currency: 'INR' }));
          await orderSvc.setState(conv.id, 'SHOWING_CATALOG', {
            branchId: reEngagement.branchId,
            deliveryAddress: reEngagement.deliveryAddress.full_address || '',
            deliveryLat: reEngagement.deliveryAddress.lat || null,
            deliveryLng: reEngagement.deliveryAddress.lng || null,
          });
          const updatedConv = await col('conversations').findOne({ _id: conv._id || conv.id });
          await handleCatalogOrder({ order: { product_items: productItems } }, customer, updatedConv, waAccount);
          return;
        }
        // No address — store as pending cart and collect address
        await orderSvc.setState(conv.id, 'AWAITING_ADDRESS_FOR_CART', {
          pendingCart: {
            product_items: reEngagement.validItems.map(i => ({ product_retailer_id: i.product_retailer_id, quantity: i.quantity, item_price: i.item_price, currency: 'INR' })),
            received_at: new Date().toISOString(),
          },
        });
        await wa.sendText(pid, token, to, '🛒 Welcome back! I found your previous cart. Let me get your delivery address.');
        // Trigger address Flow
        const restaurant = await col('restaurants').findOne({ _id: waAccount.restaurant_id });
        if (restaurant?.flow_id) {
          const savedAddrs = await addressSvc.getAddresses({ customer_id: customer.id, wa_phone: customer.wa_phone || customer.bsuid });
          if (savedAddrs?.length > 0) {
            const addressItems = flowMgr.formatAddressesForFlow(savedAddrs);
            await wa.sendFlow(pid, token, to, { body: 'Choose your delivery address:', flowId: restaurant.flow_id, flowCta: 'Choose Address', screenId: 'SAVED_ADDRESSES', flowData: { screenData: { addresses: addressItems } } });
          } else {
            await wa.sendFlow(pid, token, to, { body: 'Set your delivery location:', flowId: restaurant.flow_id, flowCta: 'Set Location', screenId: 'NEW_ADDRESS', flowData: { screenData: { customer_name: customer.name || '', customer_phone: customer.wa_phone || '' } } });
          }
        } else {
          await wa.sendLocationRequest(pid, token, to);
        }
        return;
      }
    } catch (e) { log.warn({ err: e }, 'Cart recovery re-engagement check failed'); }
  }

  if (['HI', 'HELLO', 'HEY', 'START', 'MENU', 'ORDER'].includes(text)) {
    await orderSvc.setState(conv.id, 'SELECTING_ADDRESS');

    const restaurant = await col('restaurants').findOne({ _id: waAccount.restaurant_id });
    const restName = restaurant?.business_name || waAccount.display_name || 'our restaurant';

    // Send warm welcome text first
    await wa.sendText(pid, token, to,
      `🍔 Welcome to *${restName}*!\n` +
      `Hi${customer.name ? ' ' + customer.name : ''}! 👋\n\n` +
      `I'll show you our menu and help you place an order right here in WhatsApp.`
    );

    // Immediately send delivery address Flow (no buttons, no waiting)
    if (restaurant?.flow_id) {
      const savedAddrs = await addressSvc.getAddresses({ customer_id: customer.id, wa_phone: customer.wa_phone || customer.bsuid });
      if (savedAddrs?.length > 0) {
        const addressItems = flowMgr.formatAddressesForFlow(savedAddrs);
        await wa.sendFlow(pid, token, to, {
          body: 'Choose your delivery address to see our menu:',
          flowId: restaurant.flow_id,
          flowCta: 'Choose Address',
          screenId: 'SAVED_ADDRESSES',
          flowData: { screenData: { addresses: addressItems } },
        });
      } else {
        await wa.sendFlow(pid, token, to, {
          body: 'Set your delivery location to browse our menu:',
          flowId: restaurant.flow_id,
          flowCta: 'Set Location',
          screenId: 'NEW_ADDRESS',
          flowData: { screenData: { customer_name: customer.name || '', customer_phone: customer.wa_phone || '' } },
        });
      }
    } else {
      // Fallback: no Flow — ask for location directly (no buttons)
      await wa.sendText(pid, token, to,
        '📍 Share your delivery location so I can show you the menu:\n\n' +
        '• *Share your live location* — tap + → Location\n' +
        '• *Send a Google Maps link*\n' +
        '• *Type your full address*'
      );
      await orderSvc.setState(conv.id, 'AWAITING_LOCATION');
    }
    return;
  }

  if (['TRACK', 'STATUS', 'WHERE'].some(w => text.includes(w))) {
    await sendTrackingInfo(customer, conv, waAccount);
    return;
  }

  if (text === 'CANCEL') {
    await handleCancelRequest(customer, conv, waAccount);
    return;
  }

  if (['HISTORY', 'ORDERS', 'PAST ORDERS', 'MY ORDERS'].includes(text)) {
    await sendOrderHistory(customer, waAccount);
    return;
  }

  if (['POINTS', 'LOYALTY', 'REWARDS', 'MY POINTS'].includes(text)) {
    await sendLoyaltyBalance(customer, waAccount);
    return;
  }

  if (text.startsWith('REORDER')) {
    const num = parseInt(text.replace('REORDER', '').trim()) || 1;
    await handleReorder(customer, conv, waAccount, num);
    return;
  }

  if (['COMPLAINT', 'ISSUE', 'PROBLEM', 'HELP', 'REFUND'].includes(text)) {
    // Show issue category picker
    await wa.sendList(pid, token, to, {
      body: "I'm sorry you're having an issue. What's this about?",
      buttonText: 'Select Category',
      sections: [{
        title: 'Issue Type',
        rows: [
          { id: 'ISS_food_quality', title: '🍕 Food Quality', description: 'Cold, bad taste, undercooked' },
          { id: 'ISS_missing_item', title: '📦 Missing Items', description: 'Item missing from order' },
          { id: 'ISS_wrong_order', title: '❌ Wrong Order', description: 'Received wrong items' },
          { id: 'ISS_delivery_late', title: '🛵 Delivery Issue', description: 'Late, damaged, not received' },
          { id: 'ISS_payment_failed', title: '💰 Payment Issue', description: 'Wrong charge, refund, failed payment' },
          { id: 'ISS_general', title: '💬 Something Else', description: 'Other feedback or question' },
        ],
      }],
    });
    await orderSvc.setState(conv.id, 'SELECTING_ISSUE_CATEGORY', {});
    return;
  }

  if (text === 'REOPEN') {
    // Find customer's most recent resolved issue
    const lastIssue = await col('issues').findOne(
      { customer_id: customer._id, status: { $in: ['resolved', 'closed'] } },
      { sort: { created_at: -1 } }
    );
    if (lastIssue) {
      await issueSvc.reopenIssue(lastIssue._id, {
        actorType: 'customer', actorName: customer.name || customer.wa_name,
        actorId: customer._id, reason: 'Customer reopened via WhatsApp'
      });
      await wa.sendText(pid, token, to, `Your issue #${lastIssue.issue_number} has been reopened. We'll look into it again.`);
    } else {
      await wa.sendText(pid, token, to, "You don't have any recent resolved issues to reopen. Type COMPLAINT to report a new issue.");
    }
    return;
  }

  // [BSUID] Handle phone number typed as text during phone collection flow
  if (conv.state === 'AWAITING_PHONE_FOR_PAYMENT') {
    const rawPhone = msg.text.body.trim().replace(/[\s\-\(\)]/g, '');
    // Accept 10-digit Indian number or with country code
    const phoneMatch = rawPhone.match(/^(?:\+?91)?(\d{10})$/);
    if (!phoneMatch) {
      await wa.sendText(pid, token, to,
        '❌ That doesn\'t look like a valid phone number.\n\nPlease enter a 10-digit Indian mobile number (e.g. 9876543210).'
      );
      return;
    }
    const phone = '91' + phoneMatch[1];
    await linkPhoneAndResumeOrder(phone, customer, conv, waAccount);
    return;
  }

  if (conv.state === 'AWAITING_COUPON') {
    const session = conv.session_data || {};
    if (text === 'SKIP') {
      await orderSvc.setState(conv.id, 'ORDER_REVIEW');
      const tempNum = `TEMP-${Date.now().toString().slice(-6)}`;
      await _sendOrderCheckout(pid, token, to, {
        orderNumber: tempNum,
        items:       session.cart.map(i => ({ name: i.name, qty: i.qty, price: i.unitPriceRs.toFixed(0) })),
        subtotal:    session.subtotalRs.toFixed(0),
        deliveryFee: session.deliveryFeeRs.toFixed(0),
        total:       session.totalRs.toFixed(0),
        discount:    null,
        session, customer, waAccount,
      });
      return;
    }

    const branch = await col('branches').findOne({ _id: session.branchId });
    const restaurantId = branch?.restaurant_id;
    const result = await couponSvc.validateCoupon(msg.text.body.trim(), restaurantId, session.subtotalRs);

    if (!result.valid) {
      await wa.sendText(pid, token, to, result.message);
      return;
    }

    const couponData   = { id: result.coupon.id, code: result.coupon.code, discountRs: result.discountRs };
    let updatedCharges = session.charges || null;
    if (updatedCharges) {
      const { calculateOrderCharges } = require('../services/charges');
      const restDoc = await col('restaurants').findOne({ _id: restaurantId });
      updatedCharges = calculateOrderCharges(
        { delivery_fee_customer_pct: restDoc?.delivery_fee_customer_pct ?? 100,
          menu_gst_mode: restDoc?.menu_gst_mode ?? 'included',
          menu_gst_pct: restDoc?.menu_gst_pct ?? 5,
          packaging_charge_rs: restDoc?.packaging_charge_rs ?? 0,
          packaging_gst_pct: restDoc?.packaging_gst_pct ?? 18 },
        session.subtotalRs, updatedCharges.delivery_fee_total_rs, result.discountRs
      );
    }
    const newTotal = updatedCharges ? updatedCharges.customer_total_rs : (session.subtotalRs + session.deliveryFeeRs - result.discountRs);
    await orderSvc.setState(conv.id, 'ORDER_REVIEW', {
      ...session, coupon: couponData, discountRs: result.discountRs, totalRs: newTotal, charges: updatedCharges,
    });

    await wa.sendText(pid, token, to, result.message);
    const tempNum = `TEMP-${Date.now().toString().slice(-6)}`;
    await _sendOrderCheckout(pid, token, to, {
      orderNumber: tempNum,
      items:       session.cart.map(i => ({ name: i.name, qty: i.qty, price: i.unitPriceRs.toFixed(0) })),
      charges:     updatedCharges,
      subtotal:    session.subtotalRs.toFixed(0),
      deliveryFee: (updatedCharges ? updatedCharges.customer_delivery_rs : session.deliveryFeeRs).toFixed(0),
      total:       newTotal.toFixed(0),
      discount:    { code: couponData.code, amountRs: result.discountRs },
      session: { ...session, coupon: couponData, discountRs: result.discountRs, totalRs: newTotal, charges: updatedCharges },
      customer, waAccount,
    });
    return;
  }

  // ── AWAITING_FEEDBACK: capture rating comment with keyword detection ──
  if (conv.state === 'AWAITING_FEEDBACK') {
    const session = conv.session_data || {};
    const rawText = msg.text.body.trim();
    const comment = text === 'SKIP' ? null : rawText;
    const baseScore = session.buttonScore || session.foodRating || 3;

    // Detect feedback categories from keywords
    const lower = (rawText || '').toLowerCase();
    const feedbackTags = [];
    let tasteScore = 3, packingScore = 3, deliveryScore = 3, valueScore = 3;

    if (/taste|food|flavour|flavor|bland|cold|stale|spicy|raw/.test(lower)) { feedbackTags.push('taste'); tasteScore = baseScore; }
    if (/pack|packing|packaging|leak|spill|messy|container/.test(lower)) { feedbackTags.push('packing'); packingScore = baseScore; }
    if (/deliver|delivery|late|slow|rider|driver|wrong.address/.test(lower)) { feedbackTags.push('delivery'); deliveryScore = baseScore; }
    if (/price|value|expensive|costly|overpriced|worth/.test(lower)) { feedbackTags.push('value'); valueScore = baseScore; }

    // If no specific keyword detected, apply baseScore to all
    if (!feedbackTags.length) { tasteScore = baseScore; packingScore = baseScore; deliveryScore = baseScore; valueScore = baseScore; }

    const overall = Math.round(((tasteScore + packingScore + deliveryScore + valueScore) / 4) * 10) / 10;

    try {
      const order = await col('orders').findOne({ _id: session.ratingOrderId });
      await col('order_ratings').insertOne({
        _id: newId(),
        order_id: session.ratingOrderId,
        customer_id: customer.id,
        branch_id: order?.branch_id || null,
        restaurant_id: order?.restaurant_id || null,
        taste_rating: tasteScore,
        packing_rating: packingScore,
        delivery_rating: deliveryScore,
        value_rating: valueScore,
        food_rating: tasteScore,
        overall_rating: overall,
        comment,
        feedback_tags: feedbackTags,
        source: 'whatsapp_text',
        created_at: new Date(),
      });
      logActivity({ actorType: 'customer', actorId: customer.wa_phone || customer.bsuid, action: 'customer.feedback_submitted', category: 'customer', description: `Rating submitted by ${customer.name || customer.wa_phone || customer.bsuid}`, restaurantId: order?.restaurant_id || null, severity: 'info' });
    } catch (e) {
      if (e.code !== 11000) log.error({ err: e }, 'Rating save error');
    }
    await orderSvc.setState(conv.id, 'GREETING', {});
    await wa.sendText(pid, token, to, comment ? 'Thanks for your feedback! We\'ll work on improving. \uD83D\uDE4F' : 'No worries \u2014 thanks for rating! \uD83C\uDF89');
    return;
  }

  // ── AWAITING_POINTS_REDEEM: customer types point amount ──
  if (conv.state === 'AWAITING_POINTS_REDEEM') {
    const session = conv.session_data || {};
    const branch = await col('branches').findOne({ _id: session.branchId });
    const restaurantId = branch?.restaurant_id;
    if (!restaurantId) { await wa.sendText(pid, token, to, 'Sorry, something went wrong. Please try again in a moment.'); return; }

    const bal = await loyaltySvc.getBalance(customer.id, restaurantId);
    let pointsToRedeem = text === 'ALL' ? bal.balance : parseInt(msg.text.body.trim());

    if (isNaN(pointsToRedeem) || pointsToRedeem <= 0) {
      await wa.sendText(pid, token, to, 'Please enter a number or type *ALL* to redeem all points. Type *SKIP* to continue without redeeming.');
      return;
    }
    if (text === 'SKIP') {
      await orderSvc.setState(conv.id, 'ORDER_REVIEW', session);
      await wa.sendText(pid, token, to, 'No points redeemed. Continuing with your order.');
      return;
    }

    const result = await loyaltySvc.redeemPoints(customer.id, restaurantId, pointsToRedeem);
    if (result.error) {
      await wa.sendText(pid, token, to, `⚠️ ${result.error}\n\nType a different amount, *ALL*, or *SKIP*.`);
      return;
    }

    // Apply discount to order
    const { calculateOrderCharges } = require('../services/charges');
    const totalDiscount = (session.discountRs || 0) + result.discountRs;
    let updatedCharges = session.charges || null;
    if (updatedCharges) {
      const restaurant = await col('restaurants').findOne({ _id: restaurantId });
      updatedCharges = calculateOrderCharges(
        { delivery_fee_customer_pct: restaurant?.delivery_fee_customer_pct ?? 100,
          menu_gst_mode: restaurant?.menu_gst_mode ?? 'included',
          menu_gst_pct: restaurant?.menu_gst_pct ?? 5,
          packaging_charge_rs: restaurant?.packaging_charge_rs ?? 0,
          packaging_gst_pct: restaurant?.packaging_gst_pct ?? 18 },
        session.subtotalRs, updatedCharges.delivery_fee_total_rs, totalDiscount
      );
    }
    const newTotal = updatedCharges ? updatedCharges.customer_total_rs : (session.subtotalRs + session.deliveryFeeRs - totalDiscount);

    await orderSvc.setState(conv.id, 'ORDER_REVIEW', {
      ...session,
      loyaltyDiscount: result.discountRs,
      loyaltyPointsUsed: result.pointsRedeemed,
      discountRs: totalDiscount,
      totalRs: newTotal,
      charges: updatedCharges,
    });

    await wa.sendText(pid, token, to, `✅ Redeemed *${result.pointsRedeemed} points* for ₹${result.discountRs} off!`);
    const tempNum = `TEMP-${Date.now().toString().slice(-6)}`;
    await _sendOrderCheckout(pid, token, to, {
      orderNumber: tempNum,
      items: session.cart.map(i => ({ name: i.name, qty: i.qty, price: i.unitPriceRs.toFixed(0) })),
      charges: updatedCharges,
      subtotal: session.subtotalRs.toFixed(0),
      deliveryFee: (updatedCharges ? updatedCharges.customer_delivery_rs : session.deliveryFeeRs).toFixed(0),
      total: newTotal.toFixed(0),
      discount: { code: `${result.pointsRedeemed} pts`, amountRs: totalDiscount },
      session: { ...session, discountRs: totalDiscount, totalRs: newTotal, charges: updatedCharges },
      customer, waAccount,
    });
    return;
  }

  // ── AWAITING_PAYMENT: resend link or allow cancel ──
  if (conv.state === 'AWAITING_PAYMENT') {
    const session = conv.session_data || {};
    if (['PAY', 'RETRY', 'LINK'].includes(text)) {
      // Resend interactive checkout
      try {
        const fullOrder = session.orderId ? await orderSvc.getOrderDetails(session.orderId) : null;
        if (fullOrder) {
          const branch = await col('branches').findOne({ _id: session.branchId });
          const restaurant = branch ? await col('restaurants').findOne({ _id: branch.restaurant_id }) : null;
          await wa.sendPaymentRequest(pid, token, to, {
            order: fullOrder, items: fullOrder.items,
            customerName: customer.name,
            restaurantName: restaurant?.business_name || fullOrder.business_name,
            deliveryAddress: session.structuredAddress || (session.deliveryAddress ? { address: session.deliveryAddress } : null),
          });
          return;
        }
      } catch (e) {
        log.error({ err: e }, 'Payment retry checkout failed');
      }
      await wa.sendText(pid, token, to, '⚠️ Could not resend checkout. Please type *MENU* to start a new order.');
      return;
    }
    if (text === 'CANCEL') {
      if (session.orderId) {
        await orderSvc.updateStatus(session.orderId, 'CANCELLED', { cancelReason: 'Customer cancelled before payment' });
      }
      await orderSvc.setState(conv.id, 'GREETING', {});
      await wa.sendText(pid, token, to, '❌ Order cancelled. Type *MENU* to start a new order anytime!');
      return;
    }
    // Any other text — remind about payment
    await wa.sendText(pid, token, to,
      `💳 Your order #${session.orderNumber || ''} is awaiting payment.\n\n` +
      (session.paymentLinkUrl ? `Pay here: ${session.paymentLinkUrl}\n\n` : '') +
      'Type *PAY* to get a new payment link, or *CANCEL* to cancel your order.'
    );
    return;
  }

  // ── AWAITING_ADDRESS_FOR_CART: customer sent cart from direct catalog, waiting for address ──
  if (conv.state === 'AWAITING_ADDRESS_FOR_CART') {
    // Try forward geocoding the text as an address
    if (rawText && rawText.length > 5 && !['HI','HELLO','HEY','MENU','ORDER','START'].includes(text)) {
      try {
        const geocoded = await location.forwardGeocode(rawText);
        if (geocoded?.lat && geocoded?.lng) {
          log.info({ address: geocoded.address }, 'Forward geocoded address for pending cart');
          const syntheticMsg = { type: 'location', location: { latitude: geocoded.lat, longitude: geocoded.lng, address: geocoded.address } };
          await handleLocationMessage(syntheticMsg, customer, conv, waAccount);
          return;
        }
      } catch (e) { log.warn({ err: e }, 'Text geocode failed'); }
    }
    // If greeting while cart is pending, re-send address prompt
    if (['HI','HELLO','HEY','START','MENU','ORDER'].includes(text)) {
      await wa.sendText(pid, token, to, '👋 Welcome back! You have items in your cart. Let me get your delivery address.');
    } else {
      await wa.sendText(pid, token, to, "I couldn't find that location. Please share your delivery address:");
    }
    // Re-send address Flow
    const restaurant = await col('restaurants').findOne({ _id: waAccount.restaurant_id });
    if (restaurant?.flow_id) {
      const savedAddrs = await addressSvc.getAddresses({ customer_id: customer.id, wa_phone: customer.wa_phone || customer.bsuid });
      if (savedAddrs?.length > 0) {
        const addressItems = flowMgr.formatAddressesForFlow(savedAddrs);
        await wa.sendFlow(pid, token, to, { body: 'Choose your delivery address:', flowId: restaurant.flow_id, flowCta: 'Choose Address', screenId: 'SAVED_ADDRESSES', flowData: { screenData: { addresses: addressItems } } });
      } else {
        await wa.sendFlow(pid, token, to, { body: 'Set your delivery location:', flowId: restaurant.flow_id, flowCta: 'Set Location', screenId: 'NEW_ADDRESS', flowData: { screenData: { customer_name: customer.name || '', customer_phone: customer.wa_phone || '' } } });
      }
    } else {
      await wa.sendLocationRequest(pid, token, to);
    }
    return;
  }

  if (conv.state === 'AWAITING_LOCATION') {
    // Try forward geocoding the text as an address before re-prompting
    if (rawText && rawText.length > 5 && !['HI','HELLO','HEY','MENU','ORDER','START'].includes(text)) {
      try {
        const geocoded = await location.forwardGeocode(rawText);
        if (geocoded?.lat && geocoded?.lng) {
          log.info({ address: geocoded.address }, 'Forward geocoded text address');
          const syntheticMsg = { type: 'location', location: { latitude: geocoded.lat, longitude: geocoded.lng, address: geocoded.address } };
          await handleLocationMessage(syntheticMsg, customer, conv, waAccount);
          return;
        }
      } catch (e) { log.warn({ err: e }, 'Text geocode failed'); }
    }
    await wa.sendLocationRequest(pid, token, to);
    return;
  }

  if (conv.state === 'SELECTING_ADDRESS') {
    const addresses = await addressSvc.getAddresses({ customer_id: customer.id });
    if (addresses.length > 0) {
      await wa.sendAddressList(pid, token, to, addresses);
    } else {
      await orderSvc.setState(conv.id, 'AWAITING_LOCATION');
      await wa.sendLocationRequest(pid, token, to);
    }
    return;
  }

  if (conv.state === 'AWAITING_ISSUE_DESCRIPTION') {
    const session = conv.session_data || {};
    // Collect the description
    const description = msg.text?.body || '';

    // Create the issue
    const waAccount2 = await col('whatsapp_accounts').findOne({ phone_number_id: pid });
    const restId = waAccount2?.restaurant_id || session.restaurant_id;

    const issue = await issueSvc.createIssue({
      customerId: customer._id,
      customerName: customer.name || customer.wa_name,
      customerPhone: customer.wa_phone,
      orderId: session.issue_order_id || null,
      orderNumber: session.issue_order_number || null,
      restaurantId: restId,
      branchId: session.issue_branch_id || null,
      category: session.issue_category,
      description,
      media: [],
      source: 'whatsapp',
    });

    logActivity({ actorType: 'customer', actorId: customer.wa_phone || customer.bsuid, action: 'customer.issue_raised', category: 'issue', description: `Issue raised by ${customer.name || customer.wa_phone || customer.bsuid}`, restaurantId: restId, severity: 'info' });
    await wa.sendText(pid, token, to,
      `✅ Issue #${issue.issue_number} has been created.\n\nWe'll get back to you shortly. You'll receive updates here on WhatsApp.\n\nType MENU to browse our menu or TRACK to check your order.`
    );
    await orderSvc.setState(conv.id, 'GREETING', {});
    return;
  }

  // ── GENERAL MESSAGE — not recognized by any handler → route to restaurant inbox ──
  await captureCustomerMessage(msg, customer, conv, waAccount);
  await wa.sendText(pid, token, to,
    'Thanks for your message! The restaurant team will get back to you shortly. 😊\n\nIn the meantime:\n• Type *MENU* to browse our menu 🍽️\n• Type *TRACK* to track your order 📦'
  );
};

// ─── LOCATION MESSAGE HANDLER ─────────────────────────────────
const handleLocationMessage = async (msg, customer, conv, waAccount) => {
  const pid = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to = customerIdentity.resolveRecipient(customer);
  const { latitude, longitude, address: waAddress, name: locName } = msg.location;

  logActivity({ actorType: 'customer', actorId: customer.wa_phone || customer.bsuid, action: 'customer.location_shared', category: 'order', description: `${customer.name || customer.wa_phone || customer.bsuid} shared delivery location`, restaurantId: waAccount.restaurant_id, severity: 'info' });

  await wa.sendText(pid, token, to, '🔍 Finding the nearest restaurant for you...');

  // Reverse geocode to get a full formatted address from Google Maps API
  let address = waAddress || locName || null;
  try {
    const geocoded = await location.reverseGeocode(latitude, longitude);
    if (geocoded?.address) {
      address = geocoded.address;
      log.info({ address }, 'Geocoded address');
    }
  } catch (e) {
    log.warn({ err: e }, 'Reverse geocoding failed, using WhatsApp-provided address');
  }

  await col('customers').updateOne(
    { _id: customer.id },
    { $set: { last_lat: latitude, last_lng: longitude, last_address: address || null } }
  );

  const result = await location.findBestAvailableBranch(latitude, longitude);

  if (!result.found) {
    await wa.sendText(pid, token, to, result.message);
    return;
  }

  // If routed to a fallback branch (nearest was closed), tell the customer
  if (result.isFallback && result.fallbackMessage) {
    await wa.sendText(pid, token, to, result.fallbackMessage);
  }

  const branch = result.branch;
  const alreadySaved = await addressSvc.isNearSavedAddress({ customer_id: customer.id }, latitude, longitude);

  // ── REORDER: if customer came from "REORDER N", restore their cart ──
  const session = conv.session_data || {};
  if (session.reorderCart?.length) {
    const reorderCart = session.reorderCart;
    const subtotalRs  = reorderCart.reduce((s, i) => s + (i.lineTotalRs || i.unitPriceRs * i.qty), 0);

    // 3PL delivery quote + charge breakdown
    const { calculateDynamicDeliveryFee } = require('../services/dynamicPricing');
    const { guard: guardDP } = require('../utils/smartModule');
    const _defaultFee = parseFloat(process.env.DEFAULT_DELIVERY_FEE) || 40;
    const dynamicResult = await guardDP('DYNAMIC_PRICING', {
      fn: () => calculateDynamicDeliveryFee(branch.id, latitude, longitude, {
        deliveryAddress: address || 'Your location',
        customerName: customer.name,
        customerPhone: customer.wa_phone || customer.bsuid || '',
      }),
      fallback: { deliveryFeeRs: _defaultFee, dynamic: false, breakdown: { totalFeeRs: _defaultFee } },
      label: 'reorderDeliveryQuote',
      context: { branchId: branch.id },
    });

    const branchDoc    = await col('branches').findOne({ _id: branch.id });
    const restaurantDoc = branchDoc
      ? await col('restaurants').findOne({ _id: branchDoc.restaurant_id })
      : null;

    const { calculateOrderCharges } = require('../services/charges');
    const charges = calculateOrderCharges(
      {
        delivery_fee_customer_pct: restaurantDoc?.delivery_fee_customer_pct ?? 100,
        menu_gst_mode:             restaurantDoc?.menu_gst_mode             ?? 'included',
        menu_gst_pct:              restaurantDoc?.menu_gst_pct              ?? 5,
        packaging_charge_rs:       restaurantDoc?.packaging_charge_rs       ?? 0,
        packaging_gst_pct:         restaurantDoc?.packaging_gst_pct         ?? 18,
      },
      subtotalRs, dynamicResult.deliveryFeeRs, 0
    );

    const deliveryQuote = dynamicResult.dynamic ? {
      providerName:  dynamicResult.breakdown.providerName,
      providerFeeRs: dynamicResult.breakdown.baseFeeRs,
      quoteId:       dynamicResult.breakdown.quoteId,
      estimatedMins: dynamicResult.breakdown.estimatedMins,
      distanceKm:    dynamicResult.breakdown.distanceKm,
    } : null;

    await orderSvc.setState(conv.id, 'ORDER_REVIEW', {
      branchId       : branch.id,
      branchName     : branch.name,
      catalogId      : branch.catalogId,
      deliveryLat    : latitude,
      deliveryLng    : longitude,
      deliveryAddress: address || 'Your location',
      cart           : reorderCart,
      subtotalRs,
      deliveryFeeRs  : charges.customer_delivery_rs,
      totalRs        : charges.customer_total_rs,
      discountRs     : 0,
      charges,
      deliveryFeeBreakdown: dynamicResult.breakdown,
      dynamicPricing:       dynamicResult.dynamic,
      deliveryQuote,
    });

    await wa.sendText(pid, token, to,
      `✅ Delivering from *${branch.businessName} — ${branch.name}*\n🚴 ${branch.distanceKm} km away`
    );

    const tempNum = `TEMP-${Date.now().toString().slice(-6)}`;
    await _sendOrderCheckout(pid, token, to, {
      orderNumber: tempNum,
      items      : reorderCart.map(i => ({ name: i.name, qty: i.qty, price: i.unitPriceRs.toFixed(0) })),
      charges,
      subtotal   : subtotalRs.toFixed(0),
      deliveryFee: charges.customer_delivery_rs.toFixed(0),
      total      : charges.customer_total_rs.toFixed(0),
      discount   : null,
      session: { branchId: branch.id, deliveryAddress: address || 'Your location', deliveryLat: latitude, deliveryLng: longitude },
      customer, waAccount,
    });
    return;
  }

  // [WhatsApp2026] Preserve structured address from address form if present
  const structuredAddr = session.pendingStructuredAddress || null;
  const addrSource = session.addressSource || 'gps';
  const displayAddress = (structuredAddr ? session.pendingFullAddress : null) || address || 'Your location';

  await orderSvc.setState(conv.id, 'SHOWING_CATALOG', {
    branchId: branch.id,
    branchName: branch.name,
    catalogId: branch.catalogId,
    deliveryLat: latitude,
    deliveryLng: longitude,
    deliveryAddress: displayAddress,
    ...(structuredAddr ? { structuredAddress: structuredAddr, addressSource: addrSource } : {}),
    ...(alreadySaved ? {} : {
      pendingSaveLat    : latitude,
      pendingSaveLng    : longitude,
      pendingSaveAddress: displayAddress,
    }),
  });

  await wa.sendText(pid, token, to,
    `✅ Great! We'll deliver from:\n\n` +
    `🏪 *${branch.businessName} — ${branch.name}*\n` +
    `📍 ${branch.address || ''}\n` +
    `🚴 ${branch.distanceKm} km from you\n\n` +
    `Opening our menu for you...`
  );

  // Send pre-menu trust message (non-blocking — don't let it delay MPM)
  try {
    const itemTrust = require('../services/itemTrust');
    const trustMsg = await itemTrust.buildPreMenuTrustMessage(branch.restaurantId || waAccount.restaurant_id, branch.id);
    if (trustMsg) await wa.sendText(pid, token, to, trustMsg);
  } catch (e) { log.warn({ err: e }, 'Pre-menu trust message failed (non-fatal)'); }

  // Send branch-filtered MPMs (Multi-Product Messages)
  const restaurantDoc = await col('restaurants').findOne({ _id: branch.restaurantId });
  let catalogId = branch.catalogId || branch.catalog_id || restaurantDoc?.meta_catalog_id;
  log.info({ branchCatalogId: branch.catalogId, branchCatalog_id: branch.catalog_id, restaurantMetaCatalogId: restaurantDoc?.meta_catalog_id }, 'MPM catalogId source');
  log.info({ catalogId, catalogIdType: typeof catalogId }, 'Resolved catalogId');
  // Ensure catalog_id is a string — Meta API rejects numbers
  if (catalogId && typeof catalogId !== 'string') { log.warn('catalogId was not a string, converting'); catalogId = String(catalogId); }

  // ── Pre-flight check: verify catalog is linked to phone number ──
  if (catalogId) {
    try {
      const cacheKey = `commerce_settings:${pid}`;
      let commerceSettings = memcache.get(cacheKey);
      if (!commerceSettings) {
        const metaConfig = require('../config/meta');
        const axios = require('axios');
        const csRes = await axios.get(`${metaConfig.graphUrl}/${pid}/whatsapp_commerce_settings`, {
          headers: { Authorization: `Bearer ${metaConfig.systemUserToken}` },
          timeout: 5000,
        });
        commerceSettings = csRes.data?.data?.[0] || csRes.data || {};
        memcache.set(cacheKey, commerceSettings, 300); // Cache 5 minutes
        log.info({ phoneNumberId: pid, commerceSettings }, 'Commerce settings fetched');
      }

      const linkedCatalog = commerceSettings.id || commerceSettings.catalog_id;
      if (!linkedCatalog) {
        // No catalog linked — try to auto-link
        log.warn({ phoneNumberId: pid, catalogId }, 'No catalog linked — attempting auto-link');
        try {
          const metaConfig = require('../config/meta');
          const axios = require('axios');
          await axios.post(`${metaConfig.graphUrl}/${pid}/whatsapp_commerce_settings`, {
            is_catalog_visible: true,
            is_cart_enabled: true,
          }, {
            params: { access_token: metaConfig.systemUserToken },
            timeout: 10000,
          });
          memcache.del(cacheKey); // Invalidate cache
          log.info('Auto-link succeeded');
        } catch (linkErr) {
          log.error({ err: linkErr, responseData: linkErr.response?.data }, 'Auto-link failed');
        }
      } else if (String(linkedCatalog) !== String(catalogId)) {
        // Different catalog linked — use Meta's catalog
        log.warn({ dbCatalogId: catalogId, metaCatalogId: linkedCatalog }, 'Catalog mismatch — using Meta catalog');
        catalogId = String(linkedCatalog);
      }
    } catch (preflightErr) {
      // Pre-flight failed — proceed anyway, existing error handling will catch 131009
      log.warn({ err: preflightErr }, 'Preflight check failed (non-blocking)');
    }
  }

  if (catalogId) {
    try {
      const { guard } = require('../utils/smartModule');
      const rid = branch.restaurantId || branch.restaurant_id || waAccount.restaurant_id;
      const mpms = await guard('MPM_STRATEGY', {
        fn: () => {
          const { buildStrategyMPMs } = require('../services/mpmStrategy');
          return buildStrategyMPMs(branch.id, rid, { customerId: customer?.id });
        },
        fallbackFn: () => {
          const { buildBranchMPMs } = require('../services/mpmBuilder');
          return buildBranchMPMs(branch.id, rid);
        },
        label: 'buildStrategyMPMs',
        context: { branchId: branch.id },
      });
      log.info({ mpmCount: mpms.length, branchName: branch.name }, 'Built MPMs for branch');
      for (const [mi, mpm] of mpms.entries()) {
        log.info({ mpmIndex: mi + 1, header: mpm.header, sectionCount: mpm.sections?.length, productCount: mpm.sections?.reduce((s,sec) => s + (sec.product_retailer_ids?.length || 0), 0) }, 'MPM detail');
        if (mpm.sections) for (const sec of mpm.sections) {
          log.info({ sectionTitle: sec.title, retailerIds: (sec.product_retailer_ids || []).join(', ') }, 'MPM section');
        }
      }
      if (mpms.length) {
        for (let i = 0; i < mpms.length; i++) {
          // Validate MPM payload before sending
          const mpm = mpms[i];
          if (mpm.sections) {
            mpm.sections = mpm.sections.filter(s => {
              if (!s.title) { log.warn('Section with no title removed'); return false; }
              s.product_retailer_ids = (s.product_retailer_ids || []).filter(id => {
                if (!id || typeof id !== 'string') { log.warn({ retailerId: JSON.stringify(id) }, 'Invalid retailer_id removed'); return false; }
                return true;
              });
              if (!s.product_retailer_ids.length) { log.warn({ sectionTitle: s.title }, 'Section has 0 valid products — removed'); return false; }
              return true;
            });
          }
          if (!mpm.sections?.length) {
            log.warn('MPM has 0 valid sections after filtering — skipping');
            await wa.sendText(pid, token, to, 'Our menu is being set up. Please try again shortly.');
            break;
          }
          try {
            await wa.sendMPM(pid, token, to, String(catalogId), mpms[i]);
            log.info({ mpmIndex: i + 1, mpmTotal: mpms.length }, 'MPM sent successfully');
          } catch (mpmSendErr) {
            log.error({ err: mpmSendErr, mpmIndex: i + 1, responseData: mpmSendErr.response?.data }, 'MPM send failed');
            // If first MPM fails, fall back to catalog message
            if (i === 0) {
              log.info('Falling back to catalog message');
              await wa.sendCatalog(pid, token, to, catalogId,
                `🍽️ Here's our menu from *${branch.name}*!\n\nBrowse and add items to your cart.`
              );
              break;
            }
          }
          if (i < mpms.length - 1) await new Promise(r => setTimeout(r, 500));
        }
        if (mpms.length > 1) {
          await wa.sendText(pid, token, to, '👆 Browse the menus above, add items to your cart, and send it when you\'re ready!');
        }
      } else {
        log.info('No items in branch — sending text menu');
        await sendTextMenu(pid, token, to, branch.id);
      }
    } catch (mpmErr) {
      log.error({ err: mpmErr }, 'MPM build failed');
      await wa.sendCatalog(pid, token, to, catalogId,
        `🍽️ Here's our menu from *${branch.name}*!\n\nBrowse and add items to your cart.`
      );
    }
  } else {
    log.info('No catalog_id found — sending text menu');
    await sendTextMenu(pid, token, to, branch.id);
  }

  if (!alreadySaved) {
    await wa.sendButtons(pid, token, to, {
      body: '💾 *Save this delivery address for next time?*',
      buttons: [
        { id: 'SAVE_ADDR_HOME', title: '🏠 Home' },
        { id: 'SAVE_ADDR_WORK', title: '🏢 Work' },
        { id: 'SAVE_ADDR_SKIP', title: 'Skip' },
      ],
    });
  }
};

// ─── CATALOG ORDER HANDLER ────────────────────────────────────
const handleCatalogOrder = async (msg, customer, conv, waAccount) => {
  const pid = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to = customerIdentity.resolveRecipient(customer);

  const session = conv.session_data || {};
  const branchId = session.branchId;

  if (!branchId) {
    // Direct catalog cart — customer has no address/branch context yet
    // Store the cart and trigger address collection
    const productItems = msg.order?.product_items || [];
    if (!productItems.length) return;

    log.info({ itemCount: productItems.length }, 'Direct catalog cart — no branch context, collecting address');

    await orderSvc.setState(conv.id, 'AWAITING_ADDRESS_FOR_CART', {
      ...session,
      pendingCart: {
        catalog_id: msg.order?.catalog_id || null,
        product_items: productItems,
        coupon_code: msg.order?.coupon_code || null,
        received_at: new Date().toISOString(),
      },
    });

    // Track abandoned cart (address_pending stage)
    const { guard: guardCR2 } = require('../utils/smartModule');
    guardCR2('CART_RECOVERY', {
      fn: async () => {
        const cartRecovery = require('../services/cart-recovery');
        const enrichedItems = await cartRecovery.enrichCartItems(productItems);
        const cartTotal = enrichedItems.reduce((s, i) => s + (i.item_price * i.quantity), 0);
        return cartRecovery.trackAbandonedCart({
          restaurantId: waAccount.restaurant_id, branchId: null,
          customerId: customer.id, customerPhone: customer.wa_phone || customer.bsuid,
          customerName: customer.name, cartItems: enrichedItems, cartTotal,
          itemCount: enrichedItems.reduce((s, i) => s + i.quantity, 0),
          catalogId: msg.order?.catalog_id, abandonmentStage: 'address_pending',
          lastCustomerMessageAt: new Date(),
        });
      },
      fallback: undefined,
      label: 'trackAbandonedCart:address',
      context: { customerId: customer.id },
    }); // fire-and-forget

    await wa.sendText(pid, token, to,
      '🎉 Great choices! Before we proceed with your order, I need your delivery address.'
    );

    // Trigger address Flow (same as greeting flow)
    const restaurant = await col('restaurants').findOne({ _id: waAccount.restaurant_id });
    if (restaurant?.flow_id) {
      const savedAddrs = await addressSvc.getAddresses({ customer_id: customer.id, wa_phone: customer.wa_phone || customer.bsuid });
      if (savedAddrs?.length > 0) {
        const addressItems = flowMgr.formatAddressesForFlow(savedAddrs);
        await wa.sendFlow(pid, token, to, {
          body: 'Choose your delivery address:',
          flowId: restaurant.flow_id,
          flowCta: 'Choose Address',
          screenId: 'SAVED_ADDRESSES',
          flowData: { screenData: { addresses: addressItems } },
        });
      } else {
        await wa.sendFlow(pid, token, to, {
          body: 'Set your delivery location:',
          flowId: restaurant.flow_id,
          flowCta: 'Set Location',
          screenId: 'NEW_ADDRESS',
          flowData: { screenData: { customer_name: customer.name || '', customer_phone: customer.wa_phone || '' } },
        });
      }
    } else {
      await wa.sendLocationRequest(pid, token, to);
    }
    return;
  }

  const productItems = msg.order?.product_items || [];
  if (!productItems.length) return;

  logActivity({ actorType: 'customer', actorId: customer.wa_phone || customer.bsuid, action: 'customer.cart_submitted', category: 'order', description: `Cart submitted by ${customer.name || customer.wa_phone || customer.bsuid}`, restaurantId: waAccount.restaurant_id, branchId: branchId ? String(branchId) : null, severity: 'info' });

  // CRIT-2A-04: resolve loyalty tier for this customer+restaurant so the
  // free-delivery waiver is reflected in the cart preview and any
  // subsequent recalculation in this handler. Failure is non-fatal.
  let loyaltyTier = null;
  try {
    const loyalty = require('../services/loyalty');
    const bal = await loyalty.getBalance(customer.id, waAccount.restaurant_id);
    loyaltyTier = bal?.tier || null;
  } catch (err) {
    log.warn({ err, customerId: customer.id }, 'loyalty tier lookup failed — proceeding without waiver');
  }

  const cart = await orderSvc.buildCartFromCatalogOrder(productItems, branchId, session.deliveryLat, session.deliveryLng, {
    deliveryAddress: session.deliveryAddress,
    customerName: customer.name,
    customerPhone: customer.wa_phone || customer.bsuid || '',
  }, loyaltyTier);

  if (!cart.cart.length) {
    await wa.sendText(pid, token, to, '⚠️ Some items are no longer available. Please browse the menu again.');
    const cartCatalogId = session.catalogId || (await col('restaurants').findOne({ _id: waAccount.restaurant_id }))?.meta_catalog_id;
    if (cartCatalogId) await wa.sendCatalog(pid, token, to, String(cartCatalogId));
    return;
  }

  const metaCouponCode = msg.order?.coupon_code;
  let couponData = session.coupon || null;

  const branch = await col('branches').findOne({ _id: branchId });
  const restaurantId = branch?.restaurant_id;
  const restaurant = branch ? await col('restaurants').findOne({ _id: branch.restaurant_id }) : null;
  const restConfig = {
    delivery_fee_customer_pct: restaurant?.delivery_fee_customer_pct ?? 100,
    menu_gst_mode: restaurant?.menu_gst_mode ?? 'included',
    menu_gst_pct: restaurant?.menu_gst_pct ?? 5,
    packaging_charge_rs: restaurant?.packaging_charge_rs ?? 0,
    packaging_gst_pct: restaurant?.packaging_gst_pct ?? 18,
  };

  // Try Meta coupon code first, then auto-resolve best offer
  if (metaCouponCode && !couponData) {
    const result = await couponSvc.validateCoupon(metaCouponCode, restaurantId, cart.subtotalRs,
      { customerId: customer?.id, branchId, isFirstOrder: await couponSvc.isCustomerFirstOrder(customer?.id, restaurantId) });
    if (result.valid) {
      couponData = { id: result.coupon.id, code: result.coupon.code, discountRs: result.discountRs, freeDelivery: result.freeDelivery, autoApplied: false };
      await wa.sendText(pid, token, to, result.message);
    }
  }

  // Auto-apply best offer if no coupon yet
  if (!couponData) {
    try {
      const isFirstOrder = await couponSvc.isCustomerFirstOrder(customer?.id, restaurantId);
      const deliveryFee = cart.charges?.delivery_fee_total_rs || cart.deliveryFeeRs || 0;
      const resolved = await couponSvc.resolveBestOffer(restaurantId, cart.subtotalRs, deliveryFee, restConfig,
        { customerId: customer?.id, branchId, isFirstOrder });
      if (resolved.bestCoupon) {
        couponData = {
          id: resolved.bestCoupon.coupon.id,
          code: resolved.bestCoupon.coupon.code,
          discountRs: resolved.bestCoupon.discountRs,
          freeDelivery: resolved.bestCoupon.freeDelivery,
          autoApplied: true,
        };
        await wa.sendText(pid, token, to,
          `🎉 *Best offer auto-applied!*\n${resolved.bestCoupon.label} — *${couponData.code}*\nYou save ₹${couponData.discountRs.toFixed(0)}${resolved.allEligible.length > 1 ? `\n\n_${resolved.allEligible.length} offers available — reply COUPON to change_` : ''}`);
      }
    } catch (e) { log.warn({ err: e }, 'Auto-offer resolution failed (non-blocking)'); }
  }

  const discountRs = couponData?.discountRs || 0;

  let charges = cart.charges;
  if ((discountRs > 0 || couponData?.freeDelivery) && charges) {
    const { calculateOrderCharges } = require('../services/charges');
    const effectiveDelivery = couponData?.freeDelivery ? 0 : charges.delivery_fee_total_rs;
    charges = calculateOrderCharges(restConfig, cart.subtotalRs, effectiveDelivery, discountRs, loyaltyTier);
  }
  const finalTotalRs = charges ? charges.customer_total_rs : (cart.subtotalRs + cart.deliveryFeeRs - discountRs);

  await orderSvc.setState(conv.id, 'ORDER_REVIEW', {
    ...session,
    cart: cart.cart,
    subtotalRs:    cart.subtotalRs,
    deliveryFeeRs: charges ? charges.customer_delivery_rs : cart.deliveryFeeRs,
    totalRs:       finalTotalRs,
    discountRs,
    coupon:        couponData,
    charges,
    deliveryFeeBreakdown: cart.deliveryFeeBreakdown || null,
    dynamicPricing:       cart.dynamicPricing || false,
    deliveryQuote:        cart.deliveryQuote || null,
  });

  const tempOrderNum = `TEMP-${Date.now().toString().slice(-6)}`;

  // Build 3PL delivery info text for order summary
  let dynamicNote = null;
  if (cart.dynamicPricing && cart.deliveryFeeBreakdown) {
    const bd = cart.deliveryFeeBreakdown;
    const parts = [];
    if (bd.distanceKm) parts.push(`📍 ${bd.distanceKm} km`);
    if (bd.providerName) parts.push(`🚴 ${bd.providerName}`);
    if (bd.estimatedMins) parts.push(`⏱ ~${bd.estimatedMins} min`);
    if (bd.surgeReason) parts.push(`⚡ ${bd.surgeReason}`);
    if (parts.length) dynamicNote = parts.join(' · ');
  }

  await _sendOrderCheckout(pid, token, to, {
    orderNumber: tempOrderNum,
    items: cart.cart.map(i => ({ name: i.name, qty: i.qty, price: i.unitPriceRs.toFixed(0) })),
    charges,
    subtotal:    cart.subtotalRs.toFixed(0),
    deliveryFee: (charges ? charges.customer_delivery_rs : cart.deliveryFeeRs).toFixed(0),
    total:       finalTotalRs.toFixed(0),
    discount:    couponData ? { code: couponData.code, amountRs: discountRs } : null,
    dynamicNote,
    session: conv.session_data || session,
    customer, waAccount,
  });

  if (cart.unavailable.length > 0) {
    await wa.sendText(pid, token, to,
      `⚠️ Note: ${cart.unavailable.length} item(s) were unavailable and removed from your cart.`
    );
  }
};

// ─── INTERACTIVE REPLY HANDLER ────────────────────────────────
const handleInteractiveReply = async (msg, customer, conv, waAccount) => {
  const pid = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to = customerIdentity.resolveRecipient(customer);

  // [WhatsApp2026] Handle nfm_reply (address forms and WhatsApp Flows)
  const nfmReply = msg.interactive?.nfm_reply;
  if (nfmReply) {
    await handleNfmReply(nfmReply, customer, conv, waAccount);
    return;
  }

  const replyId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id;

  if (replyId?.startsWith('ADDR_')) {
    const addressId = replyId.slice(5);
    await handleSavedAddressSelected(addressId, customer, conv, waAccount);
    return;
  }

  if (replyId?.startsWith('REORDER_')) {
    const orderId = replyId.slice(8); // strip "REORDER_"
    await handleReorderById(orderId, customer, conv, waAccount);
    return;
  }

  // ── Rating reply: RATE_<orderId>_<score> ──
  if (replyId?.startsWith('RATE_')) {
    const parts = replyId.split('_'); // ['RATE', orderId, score]
    const ratingOrderId = parts[1];
    const score = parseInt(parts[2]) || 3;
    await handleRatingReply(ratingOrderId, score, customer, conv, waAccount);
    return;
  }

  // ── Issue category selection: ISS_<category> ──
  if (replyId?.startsWith('ISS_')) {
    const category = replyId.replace('ISS_', '');
    // Store category in session, ask which order
    await orderSvc.setState(conv.id, 'SELECTING_ISSUE_ORDER', { issue_category: category });

    // Fetch recent orders for this customer
    const recentOrders = await col('orders').find({ customer_id: customer._id })
      .sort({ created_at: -1 }).limit(5).toArray();

    if (recentOrders.length) {
      const rows = recentOrders.map(o => ({
        id: 'ISSORD_' + o._id,
        title: '#' + (o.order_number || o._id.toString().slice(-6)),
        description: new Date(o.created_at).toLocaleDateString() + ' · ₹' + (o.total_rs || 0),
      }));
      rows.push({ id: 'ISSORD_none', title: 'Not about a specific order', description: 'General feedback' });

      await wa.sendList(pid, token, to, {
        body: 'Which order is this about?',
        buttonText: 'Select Order',
        sections: [{ title: 'Recent Orders', rows }],
      });
    } else {
      // No orders — skip to description
      await orderSvc.setState(conv.id, 'AWAITING_ISSUE_DESCRIPTION', { issue_category: category });
      await wa.sendText(pid, token, to, 'Please describe your issue. You can also send a photo.');
    }
    return;
  }

  // ── Issue order selection: ISSORD_<orderId> ──
  if (replyId?.startsWith('ISSORD_')) {
    const session = conv.session_data || {};
    const ordVal = replyId.replace('ISSORD_', '');
    let orderId = null, orderNumber = null, branchId = null;

    if (ordVal !== 'none') {
      const order = await col('orders').findOne({ _id: ordVal });
      if (order) {
        orderId = order._id;
        orderNumber = order.order_number;
        branchId = order.branch_id;
      }
    }

    await orderSvc.setState(conv.id, 'AWAITING_ISSUE_DESCRIPTION', {
      ...session, issue_order_id: orderId, issue_order_number: orderNumber, issue_branch_id: branchId,
    });
    await wa.sendText(pid, token, to, 'Please describe your issue. You can also send a photo.');
    return;
  }

  switch (replyId) {
    case 'START_ORDER': {
      logActivity({ actorType: 'customer', actorId: customer.wa_phone || customer.bsuid, action: 'customer.order_started', category: 'order', description: `${customer.name || customer.wa_phone || customer.bsuid} started ordering`, restaurantId: waAccount.restaurant_id, severity: 'info' });
      await orderSvc.setState(conv.id, 'SELECTING_ADDRESS');
      const restaurant = await col('restaurants').findOne({ _id: waAccount.restaurant_id });
      if (restaurant?.flow_id) {
        const savedAddrs = await addressSvc.getAddresses({ customer_id: customer.id, wa_phone: customer.wa_phone || customer.bsuid });
        if (savedAddrs?.length > 0) {
          const addressItems = flowMgr.formatAddressesForFlow(savedAddrs);
          await wa.sendFlow(pid, token, to, { body: 'Choose your delivery address:', flowId: restaurant.flow_id, flowCta: 'Choose Address', screenId: 'SAVED_ADDRESSES', flowData: { screenData: { addresses: addressItems } } });
        } else {
          await wa.sendFlow(pid, token, to, { body: 'Set your delivery location:', flowId: restaurant.flow_id, flowCta: 'Set Location', screenId: 'NEW_ADDRESS', flowData: { screenData: { customer_name: customer.name || '', customer_phone: customer.wa_phone || '' } } });
        }
      } else {
        await orderSvc.setState(conv.id, 'AWAITING_LOCATION');
        await wa.sendLocationRequest(pid, token, to);
      }
      break;
    }

    case 'USE_NEW_LOCATION':
      await orderSvc.setState(conv.id, 'AWAITING_LOCATION');
      await wa.sendLocationRequest(pid, token, to);
      break;

    // [WhatsApp2026] Native address form — opens structured address input
    case 'TYPE_ADDRESS':
      await orderSvc.setState(conv.id, 'AWAITING_ADDRESS_FORM');
      await wa.sendAddressRequest(pid, token, to, {
        savedAddress: customer.name ? { name: customer.name, phone_number: customer.wa_phone } : undefined,
      });
      break;

    case 'VIEW_HISTORY':
      await sendOrderHistory(customer, waAccount);
      break;

    case 'TRACK_ORDER':
      await sendTrackingInfo(customer, conv, waAccount);
      break;

    case 'CONFIRM_ORDER': {
      const session = conv.session_data || {};
      if (!session.cart?.length) {
        await wa.sendText(pid, token, to, 'Your cart is empty. Type *MENU* to browse.');
        return;
      }

      // If already awaiting payment, resend the interactive checkout
      if (conv.state === 'AWAITING_PAYMENT' && session.orderId) {
        try {
          const fullOrder = await orderSvc.getOrderDetails(session.orderId);
          if (fullOrder) {
            const branch = await col('branches').findOne({ _id: session.branchId });
            const restaurant = branch ? await col('restaurants').findOne({ _id: branch.restaurant_id }) : null;
            await wa.sendPaymentRequest(pid, token, to, {
              order: fullOrder, items: fullOrder.items,
              customerName: customer.name,
              restaurantName: restaurant?.business_name || fullOrder.business_name,
              deliveryAddress: session.structuredAddress || (session.deliveryAddress ? { address: session.deliveryAddress } : null),
            });
            return;
          }
        } catch (e) { log.warn({ err: e }, 'Payment resend checkout failed'); }
        await wa.sendText(pid, token, to, '⚠️ Could not reload your order. Please type *MENU* to start again.');
        return;
      }

      // [BSUID] If customer has no phone number, we need to collect it before payment
      // Razorpay and 3PL delivery require a real phone number
      if (!customer.wa_phone) {
        await orderSvc.setState(conv.id, 'AWAITING_PHONE_FOR_PAYMENT');
        await wa.sendText(pid, token, to,
          '📱 *We need your phone number to process payment and delivery.*\n\n' +
          'Please share your contact by tapping the 📎 attachment button → *Contact* → share your own contact.\n\n' +
          'Or simply type your 10-digit phone number below.\n\n' +
          '_Your number is only used for payment & delivery updates._'
        );
        return;
      }

      logActivity({ actorType: 'customer', actorId: customer.wa_phone || customer.bsuid, action: 'customer.order_confirmed', category: 'order', description: `Order confirmed by ${customer.name || customer.wa_phone || customer.bsuid}`, restaurantId: waAccount.restaurant_id, severity: 'info' });

      // Order creation rate limit — 5 per 10 minutes
      const orderRateCheck = waOrderLimiter.isAllowed(customerIdentity.resolveRecipient(customer));
      if (!orderRateCheck.allowed) {
        await wa.sendText(pid, token, to, '⚠️ You\'re placing orders too quickly. Please wait a few minutes and try again.');
        return;
      }

      // [IDEMPOTENCY] Same key shape as the checkout-flow caller above —
      // a double-confirm collapses to one order.
      const order = await orderSvc.createOrder({
        idempotencyKey: idemKeys.order(customer.id, session.branchId, session.cart),
        convId       : conv.id,
        customerId   : customer.id,
        branchId     : session.branchId,
        cart         : session.cart,
        subtotalRs   : session.subtotalRs,
        deliveryFeeRs: session.deliveryFeeRs,
        totalRs      : session.totalRs,
        discountRs   : session.discountRs || 0,
        couponId     : session.coupon?.id   || null,
        couponCode   : session.coupon?.code || null,
        deliveryAddress: session.deliveryAddress,
        deliveryLat  : session.deliveryLat,
        deliveryLng  : session.deliveryLng,
        waPhone      : customer.wa_phone || customer.bsuid,
        charges      : session.charges || null,
        deliveryFeeBreakdown: session.deliveryFeeBreakdown || null,
        deliveryQuote: session.deliveryQuote || null,
        structuredAddress: session.structuredAddress || null,
        addressSource: session.addressSource || null,
      });

      ws.broadcastOrder(waAccount.restaurant_id, 'new_order', { orderId: order.id, orderNumber: order.order_number, customerName: customer.name, totalRs: session.totalRs, createdAt: new Date().toISOString() });

      // Parallelize: order details, ETA, delivery record, Razorpay order
      const _orderStart = Date.now();
      const [fullOrder, etaResult] = await Promise.all([
        orderSvc.getOrderDetails(order.id),
        etaSvc.calculateETA(session.branchId, session.deliveryLat, session.deliveryLng).catch(e => { log.warn({ err: e }, 'ETA calc error'); return null; }),
        col('deliveries').updateOne(
          { order_id: order.id },
          { $setOnInsert: { _id: newId(), order_id: order.id, status: 'pending', cost_rs: session.deliveryFeeRs || 0, created_at: new Date() } },
          { upsert: true }
        ),
      ]);

      let etaText = '';
      if (etaResult) {
        etaText = etaResult.etaText;
        col('orders').updateOne({ _id: order.id }, { $set: {
          estimated_prep_min: etaResult.prepTimeMinutes,
          estimated_delivery_min: etaResult.deliveryTimeMinutes,
          estimated_total_min: etaResult.totalMinutes,
          eta_text: etaResult.etaText,
        }}).catch(() => {});
      }

      // Send interactive order_details checkout (Review and Pay inside WhatsApp)
      try {
        const branch = await col('branches').findOne({ _id: session.branchId });
        const restaurant = branch ? await col('restaurants').findOne({ _id: branch.restaurant_id }) : null;
        await wa.sendPaymentRequest(pid, token, to, {
          order: fullOrder,
          items: fullOrder.items,
          customerName: customer.name,
          restaurantName: restaurant?.business_name || fullOrder.business_name,
          deliveryAddress: session.structuredAddress || (session.deliveryAddress ? { address: session.deliveryAddress } : null),
        });
        await orderSvc.setState(conv.id, 'AWAITING_PAYMENT', {
          ...session,
          orderId: order.id,
          orderNumber: order.order_number,
        });
        if (etaText) await wa.sendText(pid, token, to, `⏱ Estimated delivery: *${etaText}*`);

        // Track as payment_pending abandoned cart
        const { guard: guardCR3 } = require('../utils/smartModule');
        guardCR3('CART_RECOVERY', {
          fn: () => {
            const cartRecovery = require('../services/cart-recovery');
            return cartRecovery.trackAbandonedCart({
              restaurantId: waAccount.restaurant_id, branchId: session.branchId,
              customerId: customer.id, customerPhone: customer.wa_phone || customer.bsuid,
              customerName: customer.name,
              cartItems: (session.cart || []).map(i => ({ product_retailer_id: i.retailerId || null, quantity: i.qty, item_price: i.unitPriceRs, currency: 'INR', item_name: i.name })),
              cartTotal: session.totalRs || 0, itemCount: (session.cart || []).reduce((s, i) => s + i.qty, 0),
              abandonmentStage: 'payment_pending',
              deliveryAddress: session.deliveryAddress ? { full_address: session.deliveryAddress } : null,
              lastCustomerMessageAt: new Date(),
            });
          },
          fallback: undefined,
          label: 'trackAbandonedCart:payment',
          context: { customerId: customer.id },
        }); // fire-and-forget
      } catch (payErr) {
        log.error({ err: payErr }, 'Interactive checkout failed');
        await wa.sendText(pid, token, to, '⚠️ We had trouble loading your checkout. Please type *PAY* to try again.');
        await orderSvc.setState(conv.id, 'ORDER_REVIEW', { ...session, orderId: order.id, orderNumber: order.order_number });
      }
      log.info({ durationMs: Date.now() - _orderStart }, 'Order post-processing complete');
      logActivity({ actorType: 'customer', actorId: customer.wa_phone || customer.bsuid, action: 'customer.payment_initiated', category: 'payment', description: `Payment link sent to ${customer.name || customer.wa_phone || customer.bsuid}`, restaurantId: waAccount.restaurant_id, severity: 'info' });
      break;
    }

    case 'APPLY_COUPON': {
      await orderSvc.setState(conv.id, 'AWAITING_COUPON');
      await wa.sendText(pid, token, to,
        '🎟 Enter your coupon code below.\n\nType *SKIP* to continue without a coupon.'
      );
      break;
    }

    case 'REDEEM_POINTS': {
      const session = conv.session_data || {};
      const branch = await col('branches').findOne({ _id: session.branchId });
      const restaurantId = branch?.restaurant_id;
      if (!restaurantId) { await wa.sendText(pid, token, to, 'Sorry, something went wrong. Please try again in a moment.'); break; }
      const bal = await loyaltySvc.getBalance(customer.id, restaurantId);
      if (bal.balance < 100) {
        await wa.sendText(pid, token, to, `💰 You have *${bal.balance} points* (need at least 100 to redeem).\n\nKeep ordering to earn more! 🎉`);
        break;
      }
      const worthRs = Math.floor(bal.balance / 10);
      await orderSvc.setState(conv.id, 'AWAITING_POINTS_REDEEM', session);
      await wa.sendText(pid, token, to,
        `💰 You have *${bal.balance} points* (worth ₹${worthRs})\n🏅 Tier: ${bal.tier.charAt(0).toUpperCase() + bal.tier.slice(1)}\n\nHow many points to redeem?\nType a number, *ALL*, or *SKIP* to continue without redeeming.`
      );
      break;
    }

    case 'REMOVE_COUPON': {
      const session = conv.session_data || {};
      let restoredCharges = session.charges || null;
      if (restoredCharges) {
        const { calculateOrderCharges } = require('../services/charges');
        const _branch = await col('branches').findOne({ _id: session.branchId });
        const _restDoc = _branch ? await col('restaurants').findOne({ _id: _branch.restaurant_id }) : null;
        restoredCharges = calculateOrderCharges(
          { delivery_fee_customer_pct: _restDoc?.delivery_fee_customer_pct ?? 100,
            menu_gst_mode: _restDoc?.menu_gst_mode ?? 'included',
            menu_gst_pct: _restDoc?.menu_gst_pct ?? 5,
            packaging_charge_rs: _restDoc?.packaging_charge_rs ?? 0,
            packaging_gst_pct: _restDoc?.packaging_gst_pct ?? 18 },
          session.subtotalRs, restoredCharges.delivery_fee_total_rs, 0
        );
      }
      const updatedTotal = restoredCharges ? restoredCharges.customer_total_rs : (session.subtotalRs + session.deliveryFeeRs);
      await orderSvc.setState(conv.id, 'ORDER_REVIEW', {
        ...session, coupon: null, discountRs: 0, totalRs: updatedTotal, charges: restoredCharges,
      });
      const tempNum = `TEMP-${Date.now().toString().slice(-6)}`;
      await wa.sendText(pid, token, to, '🗑 Coupon removed.');
      await _sendOrderCheckout(pid, token, to, {
        orderNumber: tempNum,
        items:       session.cart.map(i => ({ name: i.name, qty: i.qty, price: i.unitPriceRs.toFixed(0) })),
        charges:     restoredCharges,
        subtotal:    session.subtotalRs.toFixed(0),
        deliveryFee: (restoredCharges ? restoredCharges.customer_delivery_rs : session.deliveryFeeRs).toFixed(0),
        total:       updatedTotal.toFixed(0),
        discount:    null,
        session: { ...session, coupon: null, discountRs: 0, totalRs: updatedTotal, charges: restoredCharges },
        customer, waAccount,
      });
      break;
    }

    case 'CANCEL_ORDER':
      await orderSvc.setState(conv.id, 'GREETING', {});
      await wa.sendText(pid, token, to, '❌ Order cancelled. Type *MENU* whenever you\'re ready! 😊');
      break;

    case 'SAVE_ADDR_HOME':
    case 'SAVE_ADDR_WORK':
    case 'SAVE_ADDR_SKIP': {
      const session = conv.session_data || {};
      if (replyId !== 'SAVE_ADDR_SKIP' && session.pendingSaveLat) {
        const label = replyId === 'SAVE_ADDR_HOME' ? 'Home' : 'Work';
        const existingAddrs = await addressSvc.getAddresses({ customer_id: customer.id });
        await addressSvc.saveAddress({ customer_id: customer.id, wa_phone: customer.wa_phone }, {
          label,
          fullAddress : session.pendingSaveAddress,
          latitude    : session.pendingSaveLat,
          longitude   : session.pendingSaveLng,
          makeDefault : existingAddrs.length === 0,
        });
        await wa.sendText(pid, token, to, `✅ Saved as *${label}*! We'll use it next time.`);
      }
      const cleaned = { ...session };
      delete cleaned.pendingSaveLat;
      delete cleaned.pendingSaveLng;
      delete cleaned.pendingSaveAddress;
      await orderSvc.setState(conv.id, 'SHOWING_CATALOG', cleaned);
      break;
    }

    default:
      await wa.sendText(pid, token, to, 'Type *MENU* to start ordering or *TRACK* to check your order.');
  }
};

// ─── SAVED ADDRESS SELECTED ───────────────────────────────────
const handleSavedAddressSelected = async (addressId, customer, conv, waAccount) => {
  const pid   = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to    = customerIdentity.resolveRecipient(customer);

  const addr = await col('customer_addresses').findOne({ _id: addressId, $or: [{ customer_id: customer.id }, { wa_phone: customer.wa_phone }] });

  if (!addr || !addr.latitude) {
    await orderSvc.setState(conv.id, 'AWAITING_LOCATION');
    await wa.sendLocationRequest(pid, token, to);
    return;
  }

  await wa.sendText(pid, token, to,
    `📍 Using *${addr.label}*${addr.full_address ? `: ${addr.full_address}` : ''}\n\n🔍 Finding nearest restaurant...`
  );

  const result = await location.findBestAvailableBranch(addr.latitude, addr.longitude);
  if (!result.found) {
    await wa.sendText(pid, token, to, result.message);
    return;
  }
  if (result.isFallback && result.fallbackMessage) {
    await wa.sendText(pid, token, to, result.fallbackMessage);
  }

  await _sendBranchMenu(pid, token, to, result.branch, conv, customer, addr);
};

// ─── ORDER HISTORY ────────────────────────────────────────────
const sendOrderHistory = async (customer, waAccount) => {
  const pid   = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to    = customerIdentity.resolveRecipient(customer);

  const orders = await col('orders')
    .find({ customer_id: customer.id, status: { $in: ['DELIVERED', 'COMPLETED'] } })
    .sort({ created_at: -1 })
    .limit(5)
    .toArray();

  if (!orders.length) {
    await wa.sendText(pid, token, to,
      'You haven\'t placed any orders yet! Type *MENU* to get started.'
    );
    return;
  }

  const orderIds  = orders.map(o => String(o._id));
  const branchIds = [...new Set(orders.map(o => o.branch_id).filter(Boolean))];

  const [allItems, branches] = await Promise.all([
    col('order_items').find({ order_id: { $in: orderIds } }).toArray(),
    col('branches').find({ _id: { $in: branchIds } }, { projection: { name: 1 } }).toArray(),
  ]);

  const itemsByOrder = {};
  for (const item of allItems) {
    if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
    itemsByOrder[item.order_id].push(item);
  }
  const branchMap = Object.fromEntries(branches.map(b => [String(b._id), b.name]));

  // Build interactive list rows — each row reorders that specific order
  const rows = orders.map(order => {
    const items      = itemsByOrder[String(order._id)] || [];
    const date       = new Date(order.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    const branchName = branchMap[order.branch_id] || '';
    const itemList   = items.slice(0, 2).map(it => `${it.quantity || it.qty || 1}x ${it.name}`).join(', ');
    const more       = items.length > 2 ? ` +${items.length - 2} more` : '';

    return {
      id         : `REORDER_${String(order._id)}`,
      title      : `#${order.order_number} · ₹${order.total_rs}`.substring(0, 24),
      description: `${date} · ${branchName}\n${itemList}${more}`.substring(0, 72),
    };
  });

  await wa.sendList(pid, token, to, {
    body      : `*Your Recent Orders* 🧾\n\nTap an order below to reorder it instantly!`,
    footer    : 'Tap "Reorder" to pick one',
    buttonText: 'Reorder',
    sections  : [{ title: 'Past Orders', rows }],
  });
};

// ─── REORDER BY INDEX (text: "REORDER 1") ───────────────────
const handleReorder = async (customer, conv, waAccount, orderNum) => {
  const pid   = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to    = customerIdentity.resolveRecipient(customer);

  const orders = await col('orders')
    .find({ customer_id: customer.id, status: { $in: ['DELIVERED', 'COMPLETED'] } })
    .sort({ created_at: -1 })
    .limit(5)
    .toArray();

  const order = orders[orderNum - 1];
  if (!order) {
    await wa.sendText(pid, token, to,
      `No order #${orderNum} in your history. Type *HISTORY* to see your past orders.`
    );
    return;
  }

  await _processReorder(String(order._id), customer, conv, waAccount);
};

// ─── REORDER BY ORDER ID (interactive: REORDER_<id>) ────────
const handleReorderById = async (orderId, customer, conv, waAccount) => {
  // Verify the order belongs to this customer
  const order = await col('orders').findOne({ _id: orderId, customer_id: customer.id });
  if (!order) {
    await wa.sendText(waAccount.phone_number_id, waAccount.access_token, customerIdentity.resolveRecipient(customer),
      'Order not found. Type *HISTORY* to see your past orders.'
    );
    return;
  }
  await _processReorder(orderId, customer, conv, waAccount);
};

// ─── SHARED REORDER LOGIC ────────────────────────────────────
const _processReorder = async (orderId, customer, conv, waAccount) => {
  const pid   = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to    = customerIdentity.resolveRecipient(customer);

  const order = await col('orders').findOne({ _id: orderId });
  if (!order) {
    await wa.sendText(pid, token, to, 'Order not found. Type *MENU* to order manually.');
    return;
  }

  const items = await col('order_items').find({ order_id: orderId }).toArray();
  if (!items.length) {
    await wa.sendText(pid, token, to, 'Could not load items for that order. Type *MENU* to order manually.');
    return;
  }

  // Check if original branch is still open
  const branch = await col('branches').findOne({ _id: order.branch_id });
  if (!branch || !branch.is_open || !branch.accepts_orders) {
    await wa.sendText(pid, token, to,
      `⚠️ The branch *${branch?.name || ''}* is currently closed.\nType *MENU* to order from another location.`
    );
    return;
  }

  // Check availability of each item (current price from menu_items)
  const menuItemIds = items.map(i => i.menu_item_id).filter(Boolean);
  const menuItems   = menuItemIds.length
    ? await col('menu_items').find({ _id: { $in: menuItemIds }, is_available: true }).toArray()
    : [];
  const availableMap = Object.fromEntries(menuItems.map(m => [String(m._id), m]));

  const unavailableNames = [];
  const cart = [];
  for (const i of items) {
    const m = availableMap[String(i.menu_item_id)];
    if (!m) { unavailableNames.push(i.name); continue; }
    const qty = i.quantity || i.qty || 1;
    cart.push({
      menuItemId : String(m._id),
      retailerId : m.retailer_id || null,
      name       : m.name,
      qty,
      unitPriceRs: m.price_paise / 100,
      lineTotalRs: (m.price_paise / 100) * qty,
    });
  }

  if (!cart.length) {
    await wa.sendText(pid, token, to,
      '⚠️ None of those items are currently available. Type *MENU* to see what\'s available now.'
    );
    return;
  }

  const cartText = cart.map(i => `${i.qty}x ${i.name} — ₹${i.lineTotalRs.toFixed(0)}`).join('\n');

  await orderSvc.setState(conv.id, 'AWAITING_LOCATION', {
    reorderCart    : cart,
    reorderBranchId: order.branch_id,
  });

  let replyText = `♻️ *Reordering from #${order.order_number}*\n\n${cartText}\n\n`;
  if (unavailableNames.length) {
    replyText += `⚠️ Removed (unavailable): ${unavailableNames.join(', ')}\n\n`;
  }
  replyText += 'Share your delivery location to confirm 📍';

  await wa.sendText(pid, token, to, replyText);
  await wa.sendLocationRequest(pid, token, to);
};

// ─── TRACKING INFO ────────────────────────────────────────────
const sendTrackingInfo = async (customer, conv, waAccount) => {
  const pid = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to = customerIdentity.resolveRecipient(customer);

  const activeStatuses = ['PENDING_PAYMENT', 'PAID', 'CONFIRMED', 'PREPARING', 'PACKED', 'DISPATCHED'];
  const order = await col('orders').findOne(
    { customer_id: customer.id, status: { $in: activeStatuses } },
    { sort: { created_at: -1 } }
  );

  if (!order) {
    await wa.sendText(pid, token, to, 'No active orders found. Type *MENU* to place a new order! 🍽️');
    return;
  }

  const [branch, delivery] = await Promise.all([
    col('branches').findOne({ _id: order.branch_id }, { projection: { name: 1 } }),
    col('deliveries').findOne({ order_id: String(order._id) }),
  ]);

  const statusEmoji = {
    PENDING_PAYMENT: '⏳ Awaiting payment',
    PAID: '✅ Payment received',
    CONFIRMED: '✅ Confirmed',
    PREPARING: '👨‍🍳 Being prepared',
    PACKED: '📦 Packed, awaiting pickup',
    DISPATCHED: '🚴 Out for delivery',
  };

  let trackingLine = '';
  if (order.status === 'DISPATCHED' && delivery) {
    if (delivery.tracking_url) trackingLine += `\n🔗 Track: ${delivery.tracking_url}`;
    if (delivery.driver_name)  trackingLine += `\n🚴 Driver: ${delivery.driver_name}`;
    if (delivery.driver_phone) trackingLine += ` · ${delivery.driver_phone}`;
    if (delivery.estimated_mins) trackingLine += `\n⏱ ETA: ~${delivery.estimated_mins} mins`;
  }

  const etaLine = order.eta_text ? `\n⏱ ETA: *${order.eta_text}*` : '';

  await wa.sendText(pid, token, to,
    `*Order Tracker*\n\n` +
    `Order: #${order.order_number}\n` +
    `Status: ${statusEmoji[order.status] || order.status}\n` +
    `Amount: ₹${order.total_rs}\n` +
    `From: ${branch?.name || ''}` +
    trackingLine + etaLine +
    `\n\n_We'll notify you at each step!_ 📱`
  );
};

// ─── CANCEL REQUEST ───────────────────────────────────────────
const handleCancelRequest = async (customer, conv, waAccount) => {
  const pid = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to = customerIdentity.resolveRecipient(customer);

  const order = await col('orders').findOne(
    { customer_id: customer.id, status: { $in: ['PENDING_PAYMENT', 'PAID', 'CONFIRMED'] } },
    { sort: { created_at: -1 } }
  );

  if (!order) {
    await wa.sendText(pid, token, to, 'No cancellable orders found.');
    return;
  }

  await orderSvc.updateStatus(String(order._id), 'CANCELLED', { cancelReason: 'Customer requested cancellation' });

  if (order.status === 'PAID') {
    await paymentSvc.issueRefund(String(order._id)).catch(e =>
      log.error({ err: e }, 'Refund failed')
    );
  }

  await wa.sendStatusUpdate(pid, token, to, 'CANCELLED', { orderNumber: order.order_number });

  // Fire-and-forget manager notification
  const fullOrder = await orderSvc.getOrderDetails(String(order._id));
  if (fullOrder) {
    notify.notifyOrderStatusChange(fullOrder, order.status, 'CANCELLED').catch(() => {});
  }
};

// ─── TEXT MENU FALLBACK ───────────────────────────────────────
const sendTextMenu = async (pid, token, to, branchId) => {
  const items = await col('menu_items').find({ branch_id: branchId, is_available: true })
    .sort({ sort_order: 1 }).limit(30).toArray();

  if (!items.length) {
    await wa.sendText(pid, token, to, 'Menu is being updated. Please try again in a few minutes!');
    return;
  }

  // Fetch categories for grouping
  const catIds = [...new Set(items.map(i => i.category_id).filter(Boolean))];
  const cats = catIds.length
    ? await col('menu_categories').find({ _id: { $in: catIds } }).toArray()
    : [];
  const catMap = Object.fromEntries(cats.map(c => [String(c._id), c.name]));

  const grouped = {};
  for (const item of items) {
    const cat = catMap[item.category_id] || 'Menu';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(item);
  }

  let menuText = '🍽️ *Our Menu*\n\n';
  for (const [cat, catItems] of Object.entries(grouped)) {
    menuText += `*${cat}*\n`;
    catItems.forEach(i => { menuText += `• ${i.name} — ₹${i.price_paise / 100}\n`; });
    menuText += '\n';
  }
  menuText += '_To order, reply with items like: "2 Butter Chicken, 1 Naan"_';

  await wa.sendText(pid, token, to, menuText);
};

// ─── LOYALTY BALANCE ─────────────────────────────────────────
const sendLoyaltyBalance = async (customer, waAccount) => {
  const pid   = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to    = customerIdentity.resolveRecipient(customer);

  // Get loyalty across all restaurants this customer has ordered from
  const loyaltyDocs = await col('loyalty_points')
    .find({ customer_id: customer.id })
    .toArray();

  if (!loyaltyDocs.length) {
    await wa.sendText(pid, token, to,
      '💰 *Loyalty Points*\n\nYou don\'t have any loyalty points yet.\nPlace your first order to start earning! Type *MENU* to get started.'
    );
    return;
  }

  const restIds = loyaltyDocs.map(l => l.restaurant_id).filter(Boolean);
  const restaurants = restIds.length
    ? await col('restaurants').find({ _id: { $in: restIds } }, { projection: { business_name: 1 } }).toArray()
    : [];
  const restMap = Object.fromEntries(restaurants.map(r => [String(r._id), r.business_name]));

  let msg = '💰 *Your Loyalty Points*\n\n';
  for (const l of loyaltyDocs) {
    const name = restMap[l.restaurant_id] || 'Restaurant';
    const tierLabel = l.tier.charAt(0).toUpperCase() + l.tier.slice(1);
    msg += `🏪 *${name}*\n`;
    msg += `   Points: ${l.points_balance} (lifetime: ${l.lifetime_points})\n`;
    msg += `   Tier: ${tierLabel}\n`;
    msg += `   ${loyaltySvc.getTierBenefits(l.tier)}\n\n`;
  }
  msg += '_Redeem points at checkout — 10 points = ₹1 off!_';

  await wa.sendText(pid, token, to, msg);
};

// ─── RATING REPLY HANDLER ────────────────────────────────────
const handleRatingReply = async (orderId, score, customer, conv, waAccount) => {
  const pid   = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to    = customerIdentity.resolveRecipient(customer);

  // Check for duplicate rating
  const existing = await col('order_ratings').findOne({ order_id: orderId });
  if (existing) {
    await wa.sendText(pid, token, to, 'You\'ve already rated this order. Thank you! 😊');
    return;
  }

  if (score <= 3) {
    // Ask for specific feedback
    await orderSvc.setState(conv.id, 'AWAITING_FEEDBACK', { ratingOrderId: orderId, buttonScore: score });
    await wa.sendText(pid, token, to,
      'Sorry to hear that. \uD83D\uDE14 What could we improve?\n\n' +
      'Reply with any of these:\n' +
      '\u2022 *taste* \u2014 if the food didn\'t taste good\n' +
      '\u2022 *packing* \u2014 if packaging was poor\n' +
      '\u2022 *delivery* \u2014 if delivery was late or bad\n' +
      '\u2022 *price* \u2014 if it wasn\'t value for money\n\n' +
      'Or just type your feedback in your own words.'
    );
  } else {
    // High score — save with all categories = score
    const order = await col('orders').findOne({ _id: orderId });
    try {
      await col('order_ratings').insertOne({
        _id: newId(),
        order_id: orderId,
        customer_id: customer.id,
        branch_id: order?.branch_id || null,
        restaurant_id: order?.restaurant_id || null,
        taste_rating: score,
        packing_rating: score,
        delivery_rating: score,
        value_rating: score,
        food_rating: score,
        overall_rating: score,
        comment: null,
        feedback_tags: [],
        source: 'whatsapp_button',
        created_at: new Date(),
      });
    } catch (e) {
      if (e.code !== 11000) log.error({ err: e }, 'Rating save error');
    }
    logActivity({ actorType: 'customer', actorId: customer.wa_phone || customer.bsuid, action: 'customer.feedback_submitted', category: 'customer', description: `Rating submitted by ${customer.name || customer.wa_phone || customer.bsuid}`, restaurantId: order?.restaurant_id || null, severity: 'info' });
    await wa.sendText(pid, token, to, 'Thanks for your feedback! 🎉 We\'re glad you enjoyed it!');
    await orderSvc.setState(conv.id, 'GREETING', {});
  }
};

// ─── SEND RATING REQUEST (called after delivery) ─────────────
// [WhatsApp2026] Tries WhatsApp Flow first (richer form with food + delivery rating + comment).
// Falls back to simple 3-button rating if Flow is not configured or fails.
const sendRatingRequest = async (orderId, pid, token, to) => {
  try {
    const order = await col('orders').findOne({ _id: orderId });
    if (!order) return;
    const existing = await col('order_ratings').findOne({ order_id: orderId });
    if (existing) return; // already rated

    // Try WhatsApp Flow — check platform_settings first, then env var
    const flowSetting = await col('platform_settings').findOne({ _id: 'feedback_flow' });
    const flowId = flowSetting?.flow_id || process.env.RATING_FLOW_ID;
    if (flowId) {
      try {
        await wa.sendFlow(pid, token, to, {
          flowId,
          flowToken: `rating_${orderId}`,
          flowCta: '⭐ Rate Order',
          screenId: 'RATING_SCREEN',
          flowData: {
            body: `How was your order #${order.order_number}?\n\nTap below to rate your food and delivery experience.`,
            footer: 'Your feedback helps improve quality',
            screenData: { order_number: order.order_number, order_id: orderId, flow_token: `rating_${orderId}` },
          },
        });
        return; // Flow sent successfully
      } catch (flowErr) {
        log.warn({ err: flowErr }, 'Rating Flow send failed, falling back to buttons');
      }
    }

    // Fallback: simple 3-button rating
    await wa.sendButtons(pid, token, to, {
      header: '⭐ Rate Your Order',
      body: `How was your order #${order.order_number}?\n\nTap a rating below:`,
      footer: 'Your feedback helps improve quality',
      buttons: [
        { id: `RATE_${orderId}_5`, title: '\uD83D\uDE0D Loved it!' },
        { id: `RATE_${orderId}_3`, title: '\uD83D\uDE10 It was okay' },
        { id: `RATE_${orderId}_1`, title: '\uD83D\uDE1E Not great' },
      ],
    });
  } catch (e) {
    log.error({ err: e }, 'sendRatingRequest error');
  }
};

// ─── STATUS UPDATE HANDLER ────────────────────────────────────
const handleStatus = async (status) => {
  // Idempotency: deduplicate status updates by status.id + status type
  if (status.id) {
    const { once } = require('../utils/idempotency');
    const statusKey = status.payment
      ? `payment:${status.payment?.reference_id || status.id}:${status.payment?.transaction?.status || status.status}`
      : `${status.id}:${status.status}`;
    const isNew = await once('wa_status', statusKey);
    if (!isNew) return;
  }

  if (status.status === 'failed') {
    log.error({ recipient: status.recipient_id, error: status.errors?.[0]?.title, code: status.errors?.[0]?.code }, 'Message delivery failed');
  }

  // ── Payment status from interactive order_details (Razorpay in-WhatsApp) ──
  if (status.payment) {
    const payment = status.payment;
    const refId = payment.reference_id;
    const txn = payment.transaction || {};
    log.info({ referenceId: refId, txnId: txn.id, txnStatus: txn.status, amount: payment.amount?.value }, 'WA payment status received');

    if (txn.status === 'success' && refId) {
      try {
        // Find the order by reference_id (stored in payments collection)
        const paymentRec = await col('payments').findOne({ reference_id: refId, payment_type: 'checkout_order' });
        if (paymentRec?.order_id) {
          // Mark payment as paid
          await col('payments').updateOne(
            { _id: paymentRec._id },
            { $set: { status: 'paid', rp_payment_id: txn.id, payment_method: txn.type, paid_at: new Date() } }
          );
          // Confirm the order via existing flow
          const { confirmPaidOrder } = require('./razorpay');
          if (confirmPaidOrder) {
            await confirmPaidOrder(paymentRec.order_id);
            log.info({ orderId: paymentRec.order_id }, 'Order confirmed via WA payment status');
          }
        } else {
          log.warn({ referenceId: refId }, 'No payment record for reference_id');
        }
      } catch (e) {
        log.error({ err: e }, 'WA payment processing error');
      }
    } else if (txn.status === 'failed' && refId) {
      try {
        const paymentRec = await col('payments').findOne({ reference_id: refId, payment_type: 'checkout_order' });
        if (paymentRec) {
          await col('payments').updateOne({ _id: paymentRec._id }, { $set: { status: 'failed' } });
          // Send failure message
          const order = paymentRec.order_id ? await col('orders').findOne({ _id: paymentRec.order_id }) : null;
          if (order && status.recipient_id) {
            const waAcc = await col('whatsapp_accounts').findOne({ restaurant_id: order.restaurant_id, is_active: true });
            if (waAcc) {
              await wa.sendButtons(waAcc.phone_number_id, metaConfig.systemUserToken, status.recipient_id, {
                body: `❌ Payment failed for order #${order.order_number}.\n\nWould you like to try again?`,
                buttons: [
                  { id: 'CONFIRM_ORDER', title: '🔄 Retry Payment' },
                  { id: 'CANCEL_ORDER', title: '❌ Cancel Order' },
                ],
              });
            }
          }
        }
      } catch (e) {
        log.error({ err: e }, 'WA payment failure handling error');
      }
    }
    return; // Don't process payment statuses as regular message statuses
  }

  // [WhatsApp2026] Track message status in message_statuses collection
  if (status.id && ['sent', 'delivered', 'read', 'failed'].includes(status.status)) {
    try {
      const msgTracking = require('../services/messageTracking');
      const errorInfo = status.status === 'failed' && status.errors?.[0]
        ? { code: status.errors[0].code, message: status.errors[0].title }
        : null;
      await msgTracking.updateStatus(status.id, status.status, errorInfo);

      // Capture Meta-reported conversation + pricing for marketing messages.
      // Upserts marketing_messages keyed by message_id — never throws, never
      // blocks webhook response.
      if (status.pricing || status.conversation) {
        msgTracking.capturePricingFromWebhook(status).catch(() => {});
      }
    } catch (_) {} // Non-critical

    // Campaign message tracking (existing)
    try {
      const campaignSvc = require('../services/campaigns');
      await campaignSvc.trackMessageStatus(status.id, status.status);
    } catch (_) {} // Non-critical
  }
};

// ─── LOG WEBHOOK ──────────────────────────────────────────────
const logWebhook = async (source, payload) => {
  const phoneNumberId = payload.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
  const id = newId();
  await col('webhook_logs').insertOne({
    _id: id,
    source,
    event_type: 'messages',
    phone_number_id: phoneNumberId || null,
    payload,
    processed: false,
    error_message: null,
    received_at: new Date(),
    processed_at: null,
    ...retryDefaults(),
  });
  return id;
};

// ─── [BSUID] PHONE SHARING FLOW ─────────────────────────────
// Handles contacts message type when customer shares their contact card
const handlePhoneShared = async (msg, customer, conv, waAccount) => {
  const pid = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to = customerIdentity.resolveRecipient(customer);

  try {
    // Extract phone from contacts message payload
    // contacts[0].phones[0].phone or .wa_id
    const contact = msg.contacts?.[0];
    const phoneEntry = contact?.phones?.[0];
    const rawPhone = phoneEntry?.wa_id || phoneEntry?.phone || '';
    const cleaned = rawPhone.replace(/[\s\-\(\)\+]/g, '');

    // Accept 10-digit or with 91 prefix
    const phoneMatch = cleaned.match(/^(?:91)?(\d{10})$/);
    if (!phoneMatch) {
      await wa.sendText(pid, token, to,
        '❌ We couldn\'t read a valid phone number from that contact.\n\n' +
        'Please try again or type your 10-digit phone number directly.'
      );
      return;
    }

    const phone = '91' + phoneMatch[1];
    await linkPhoneAndResumeOrder(phone, customer, conv, waAccount);
  } catch (err) {
    log.error({ err }, 'handlePhoneShared error');
    await wa.sendText(pid, token, to,
      '⚠️ Something went wrong. Please type your 10-digit phone number to continue.'
    );
  }
};

// Links a phone number to a BSUID-only customer and resumes the CONFIRM_ORDER flow
const linkPhoneAndResumeOrder = async (phone, customer, conv, waAccount) => {
  const pid = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to = customerIdentity.resolveRecipient(customer);

  // Check if another customer already has this phone
  const existing = await col('customers').findOne({ wa_phone: phone, _id: { $ne: customer.id } });
  if (existing) {
    // Merge: link BSUID to the existing phone-based customer record
    // Update existing record with this customer's BSUID
    await col('customers').updateOne(
      { _id: existing._id },
      { $set: { bsuid: customer.bsuid, identifier_type: 'both', updated_at: new Date() } }
    );
    // Point conversation to the merged customer
    await col('conversations').updateOne(
      { _id: conv.id },
      { $set: { customer_id: String(existing._id) } }
    );
    // Update customer reference for the resumed flow
    customer = { ...customer, id: String(existing._id), wa_phone: phone, identifier_type: 'both' };
  } else {
    // Link phone to current customer
    await col('customers').updateOne(
      { _id: customer.id },
      { $set: { wa_phone: phone, identifier_type: 'both', updated_at: new Date() } }
    );
    customer = { ...customer, wa_phone: phone, identifier_type: 'both' };
  }

  await wa.sendText(pid, token, to, `✅ Phone number linked: *${phone.slice(2)}*\n\nProcessing your order now...`);

  // Resume the order flow — transition back to ORDER_REVIEW and trigger CONFIRM_ORDER
  await orderSvc.setState(conv.id, 'ORDER_REVIEW');

  // Re-fetch conversation to get fresh session data
  const freshConv = await orderSvc.getOrCreateConversation(customer.id, String(waAccount._id));

  // Simulate the CONFIRM_ORDER action by calling handleInteractiveReply with a synthetic message
  // Instead, directly inline the order creation to avoid recursion complexity
  const session = freshConv.session_data || {};
  if (!session.cart?.length) {
    await wa.sendText(pid, token, to, 'Your cart appears empty. Please browse our menu and add items to your cart, then send it.');
    return;
  }

  const orderRateCheck = waOrderLimiter.isAllowed(phone);
  if (!orderRateCheck.allowed) {
    await wa.sendText(pid, token, to, '⚠️ You\'re placing orders too quickly. Please wait a few minutes.');
    return;
  }

  // [IDEMPOTENCY] Phone-share-then-resume flow can fire twice if the user
  // re-sends their phone number quickly. The cart-fingerprint key collapses
  // both attempts to one order.
  const order = await orderSvc.createOrder({
    idempotencyKey: idemKeys.order(customer.id, session.branchId, session.cart),
    convId       : freshConv.id,
    customerId   : customer.id,
    branchId     : session.branchId,
    cart         : session.cart,
    subtotalRs   : session.subtotalRs,
    deliveryFeeRs: session.deliveryFeeRs,
    totalRs      : session.totalRs,
    discountRs   : session.discountRs || 0,
    couponId     : session.coupon?.id   || null,
    couponCode   : session.coupon?.code || null,
    deliveryAddress: session.deliveryAddress,
    deliveryLat  : session.deliveryLat,
    deliveryLng  : session.deliveryLng,
    waPhone      : phone,
    charges      : session.charges || null,
    deliveryFeeBreakdown: session.deliveryFeeBreakdown || null,
    deliveryQuote: session.deliveryQuote || null,
  });

  ws.broadcastOrder(waAccount.restaurant_id, 'new_order', { orderId: order.id, orderNumber: order.order_number, customerName: customer.name, totalRs: session.totalRs, createdAt: new Date().toISOString() });

  const fullOrder = await orderSvc.getOrderDetails(order.id);

  // ETA
  let etaText = '';
  try {
    const eta = await etaSvc.calculateETA(session.branchId, session.deliveryLat, session.deliveryLng);
    await col('orders').updateOne({ _id: order.id }, { $set: {
      estimated_prep_min: eta.prepTimeMinutes,
      estimated_delivery_min: eta.deliveryTimeMinutes,
      estimated_total_min: eta.totalMinutes,
      eta_text: eta.etaText,
    }});
    etaText = eta.etaText;
  } catch (etaErr) { log.warn({ err: etaErr }, 'ETA calc error'); }

  // Delivery record
  await col('deliveries').updateOne(
    { order_id: order.id },
    { $setOnInsert: { _id: newId(), order_id: order.id, status: 'pending', cost_rs: session.deliveryFeeRs || 0, created_at: new Date() } },
    { upsert: true }
  );

  // Payment — send interactive order_details checkout
  try {
    await wa.sendPaymentRequest(pid, token, to, {
      order: fullOrder, items: fullOrder.items,
      customerName: customer.name,
      restaurantName: fullOrder.business_name,
      deliveryAddress: session.structuredAddress || (session.deliveryAddress ? { address: session.deliveryAddress } : null),
    });
    if (etaText) await wa.sendText(pid, token, to, `⏱ Estimated delivery: *${etaText}*`);
  } catch (payErr) {
    log.error({ err: payErr }, 'Interactive checkout failed');
    await wa.sendText(pid, token, to, '⚠️ Payment checkout failed. Please type *PAY* to retry.');
  }
};

// ─── NFM REPLY HANDLER (Address Forms + WhatsApp Flows) ────
// [WhatsApp2026] Handles nfm_reply interactive type from:
//   1. Native address_message forms → structured address fields
//   2. WhatsApp Flows → feedback/rating forms
const handleNfmReply = async (nfmReply, customer, conv, waAccount) => {
  const pid   = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to    = customerIdentity.resolveRecipient(customer);

  // Parse response body — Meta sends JSON string in nfm_reply.response_json
  let responseData = {};
  try {
    responseData = typeof nfmReply.response_json === 'string'
      ? JSON.parse(nfmReply.response_json)
      : nfmReply.response_json || {};
  } catch { responseData = {}; }

  // ── Delivery Address Flow response (action-based — check BEFORE flow_token) ──
  if (responseData.action === 'select_address' || responseData.action === 'new_address') {
    await handleDeliveryFlowResponse(responseData, customer, conv, waAccount);
    return;
  }

  // ── WhatsApp Flow response (rating/feedback — uses flow_token) ──
  if (responseData.flow_token) {
    await handleFlowResponse(responseData, customer, conv, waAccount);
    return;
  }

  // ── Address form response (legacy structured address form) ──
  const addr = responseData.values || responseData;
  const structuredAddress = {
    name:          addr.name || null,
    phone_number:  addr.phone_number || null,
    in_pin_code:   addr.in_pin_code || null,
    floor_number:  addr.floor_number || null,
    building_name: addr.building_name || null,
    address:       addr.address || null,
    landmark_area: addr.landmark_area || null,
    city:          addr.city || null,
  };

  // Build a readable full address string
  const parts = [
    structuredAddress.building_name,
    structuredAddress.floor_number ? `Floor ${structuredAddress.floor_number}` : null,
    structuredAddress.address,
    structuredAddress.landmark_area,
    structuredAddress.city,
    structuredAddress.in_pin_code,
  ].filter(Boolean);
  const fullAddress = parts.join(', ') || 'Address provided via form';

  // Save as a customer address
  await addressSvc.saveAddress({ customer_id: customer.id, wa_phone: customer.wa_phone }, {
    label: 'Delivered',
    fullAddress,
    landmark: structuredAddress.landmark_area,
    flatNo: [structuredAddress.building_name, structuredAddress.floor_number ? `Floor ${structuredAddress.floor_number}` : null].filter(Boolean).join(', ') || null,
    makeDefault: false,
  });

  // Store structured address in session for order creation
  await wa.sendText(pid, token, to, `📍 Got it! Address: *${fullAddress}*\n\n🔍 Finding nearest restaurant...`);

  // Use geocoding if we have pin code + city, else do text-based branch assignment
  // For now, use the saved address without lat/lng — the branch is found by text match or fallback
  const session = conv.session_data || {};

  // If we have a branch already (reorder flow), skip location lookup
  if (session.branchId) {
    await orderSvc.setState(conv.id, 'SHOWING_CATALOG', {
      ...session,
      deliveryAddress: fullAddress,
      structuredAddress,
      addressSource: 'address_form',
    });

    const branch = await col('branches').findOne({ _id: session.branchId });
    const reorderCatalogId = branch?.catalog_id || branch?.catalogId || session.catalogId || (await col('restaurants').findOne({ _id: branch?.restaurant_id || session.restaurantId }))?.meta_catalog_id;
    if (reorderCatalogId) {
      await wa.sendCatalog(pid, token, to, String(reorderCatalogId), `🍽️ Here's our menu from *${branch?.name || 'your restaurant'}*!`);
    }
    return;
  }

  // No GPS coords from address form — ask for location to find nearest branch
  await orderSvc.setState(conv.id, 'AWAITING_LOCATION', {
    ...session,
    pendingStructuredAddress: structuredAddress,
    pendingFullAddress: fullAddress,
    addressSource: 'address_form',
  });
  await wa.sendText(pid, token, to,
    '📍 To find your nearest restaurant, please also share your GPS location.\n' +
    '_Tap the button below — your address details are saved!_'
  );
  await wa.sendLocationRequest(pid, token, to);
};

// ─── WHATSAPP FLOW RESPONSE HANDLER ─────────────────────────
// [WhatsApp2026] Handles responses from WhatsApp Flows (rating/feedback forms)
// ─── DELIVERY ADDRESS FLOW RESPONSE ──────────────────────────
const handleDeliveryFlowResponse = async (responseData, customer, conv, waAccount) => {
  const pid = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to = customerIdentity.resolveRecipient(customer);
  const restaurantId = waAccount.restaurant_id;

  log.info({ responseData }, 'Flow delivery response');

  // ── SAVED ADDRESS SELECTED ──
  if (responseData.action === 'select_address') {
    const addressId = responseData.selected_address_id;

    // "Add New Address" was selected from NavigationList
    if (addressId === 'new_address') {
      const restaurant = await col('restaurants').findOne({ _id: restaurantId });
      if (restaurant?.flow_id) {
        await wa.sendFlow(pid, token, to, {
          body: 'Enter your new delivery address:',
          flowId: restaurant.flow_id,
          flowCta: 'Add Address',
          screenId: 'NEW_ADDRESS',
          flowData: { screenData: { customer_name: customer.name || '', customer_phone: customer.wa_phone || '' } },
        });
      } else {
        await wa.sendText(pid, token, to, '📍 Please share your location using the 📎 attach icon → Location.');
      }
      return;
    }

    // Look up saved address
    const addresses = await addressSvc.getAddresses({ customer_id: customer.id, wa_phone: customer.wa_phone || customer.bsuid });
    const addr = addresses.find(a => String(a._id) === addressId || a.id === addressId);
    if (!addr) {
      await wa.sendText(pid, token, to, "Sorry, that address wasn't found. Please share your location.");
      return;
    }

    await wa.sendText(pid, token, to, `📍 Delivering to: *${addr.full_address}*\n\n🔍 Finding the nearest outlet...`);

    // Find branch and send menu
    if (addr.latitude && addr.longitude) {
      const result = await location.findBestAvailableBranch(addr.latitude, addr.longitude, restaurantId);
      if (result.found) {
        if (result.isFallback && result.fallbackMessage) await wa.sendText(pid, token, to, result.fallbackMessage);
        await _sendBranchMenu(pid, token, to, result.branch, conv, customer, addr);
      } else {
        await wa.sendText(pid, token, to, result.message);
      }
    } else {
      // No GPS on saved address — use the first active branch
      const branch = await col('branches').findOne({ restaurant_id: restaurantId, is_open: true, accepts_orders: true });
      if (branch) {
        const restaurant = await col('restaurants').findOne({ _id: restaurantId });
        const fakeResult = { id: String(branch._id), name: branch.name, address: branch.address, restaurantId, catalogId: restaurant?.meta_catalog_id || branch.catalog_id, businessName: restaurant?.business_name };
        await _sendBranchMenu(pid, token, to, fakeResult, conv, customer, addr);
      } else {
        await wa.sendText(pid, token, to, '😔 No outlets are currently open. Please try again later.');
      }
    }
    return;
  }

  // ── NEW ADDRESS SUBMITTED ──
  if (responseData.action === 'new_address') {
    let parsedAddress = null;

    // Try Google Maps link first
    if (responseData.maps_link?.trim()) {
      try {
        const coords = await location.extractCoordsFromMapsUrl(responseData.maps_link.trim());
        if (coords) {
          parsedAddress = await location.reverseGeocode(coords.lat, coords.lng);
        }
      } catch (e) {
        log.error({ err: e }, 'Flow Maps URL parse failed');
      }
    }

    // Build full address from structured fields (v2 enhanced form)
    const buildingFloor = responseData.building_floor?.trim() || null;
    const street = responseData.street?.trim() || null;
    const areaLocality = responseData.area_locality?.trim() || null;
    const city = responseData.city?.trim() || null;
    const pincode = responseData.pincode?.trim() || null;
    const addressLandmark = responseData.landmark?.trim() || null;

    // If no Maps link geocode, build address from structured fields or fall back to manual_address
    if (!parsedAddress) {
      const structuredParts = [buildingFloor, street, areaLocality, addressLandmark ? `Near ${addressLandmark}` : null, city, pincode].filter(Boolean);
      const structuredAddr = structuredParts.length >= 2 ? structuredParts.join(', ') : null;
      const manualAddr = responseData.manual_address?.trim() || null;
      const addressText = structuredAddr || manualAddr;

      if (addressText) {
        try {
          const geocoded = await location.forwardGeocode(addressText);
          if (geocoded) {
            parsedAddress = geocoded;
            log.info({ address: geocoded.address, lat: geocoded.lat, lng: geocoded.lng }, 'Flow forward geocoded address');
          } else {
            parsedAddress = { full_address: addressText, source: 'manual' };
          }
        } catch (e) {
          log.warn({ err: e }, 'Flow forward geocode failed, using structured text');
          parsedAddress = { full_address: addressText, source: 'manual' };
        }
      }
    }

    if (!parsedAddress) {
      await wa.sendText(pid, token, to, "We couldn't read your address. Please share your Google Maps location pin or try again.");
      return;
    }

    // Resolve label — address_type (v2) or address_label (v1 compat)
    const addressType = responseData.address_type || responseData.address_label || 'other';
    const nickname = responseData.address_nickname || '';
    let label;
    if (addressType === 'home' || addressType === 'Home') {
      label = nickname || 'Home';
    } else if (addressType === 'office' || addressType === 'Office') {
      label = nickname || 'Office';
    } else {
      label = nickname || areaLocality || 'Other Address';
    }

    // Build full address string from best available data
    const fullAddr = parsedAddress.address || parsedAddress.full_address
      || [buildingFloor, street, areaLocality, city, pincode].filter(Boolean).join(', ');

    // Save to customer addresses with enhanced fields
    await addressSvc.saveAddress({ customer_id: customer.id, wa_phone: customer.wa_phone || customer.bsuid }, {
      label,
      type: addressType.toLowerCase(),
      fullAddress: fullAddr,
      receiverName: responseData.receiver_name || customer.name || null,
      receiverPhone: responseData.receiver_phone || customer.wa_phone || null,
      buildingFloor,
      street,
      areaLocality,
      city,
      pincode,
      landmark: addressLandmark,
      deliveryInstructions: responseData.delivery_instructions || null,
      latitude: parsedAddress.lat || null,
      longitude: parsedAddress.lng || null,
      makeDefault: true,
    });

    // Confirmation message with receiver info if ordering for someone else
    const receiverNote = (responseData.receiver_name && responseData.receiver_name !== customer.name)
      ? `\n👤 Receiver: ${responseData.receiver_name}` : '';
    await wa.sendText(pid, token, to, `📍 Delivering to: *${fullAddr}*${receiverNote}\n\n🔍 Finding the nearest outlet...`);

    // Find branch and send menu
    if (parsedAddress.lat && parsedAddress.lng) {
      const result = await location.findBestAvailableBranch(parsedAddress.lat, parsedAddress.lng, restaurantId);
      if (result.found) {
        if (result.isFallback && result.fallbackMessage) await wa.sendText(pid, token, to, result.fallbackMessage);
        await _sendBranchMenu(pid, token, to, result.branch, conv, customer, parsedAddress);
      } else {
        await wa.sendText(pid, token, to, result.message);
      }
    } else {
      // Manual address without GPS — use nearest branch
      const branch = await col('branches').findOne({ restaurant_id: restaurantId, is_open: true, accepts_orders: true });
      if (branch) {
        const restaurant = await col('restaurants').findOne({ _id: restaurantId });
        const fakeResult = { id: String(branch._id), name: branch.name, address: branch.address, restaurantId, catalogId: restaurant?.meta_catalog_id || branch.catalog_id, businessName: restaurant?.business_name };
        await _sendBranchMenu(pid, token, to, fakeResult, conv, customer, parsedAddress);
      } else {
        await wa.sendText(pid, token, to, '😔 No outlets are currently open. Please try again later.');
      }
    }
    return;
  }
};

// Helper: after address is resolved and branch found, set session and send MPM catalog
async function _sendBranchMenu(pid, token, to, branch, conv, customer, address) {
  const restaurantId = branch.restaurantId || branch.restaurant_id;

  // Resolve catalogId — branch first, then restaurant fallback
  let effectiveCatalogId = branch.catalogId || branch.catalog_id || (await col('restaurants').findOne({ _id: restaurantId }))?.meta_catalog_id;
  if (effectiveCatalogId && typeof effectiveCatalogId !== 'string') effectiveCatalogId = String(effectiveCatalogId);

  // Branch confirmation message — show nearest branch name + distance
  const branchLabel = branch.businessName ? `*${branch.businessName} — ${branch.name}*` : `*${branch.name}*`;
  const distLine = branch.distanceKm ? `\n🚴 ${branch.distanceKm} km from you` : '';
  const closedNote = (branch.is_open === false) ? `\n\n⏰ ${branch.name} is currently closed. You can browse the menu and order for when they open.` : '';
  await wa.sendText(pid, token, to,
    `✅ Delivering from:\n\n🏪 ${branchLabel}${branch.address ? '\n📍 ' + branch.address : ''}${distLine}\n\nOpening our menu...${closedNote}`
  );

  await orderSvc.setState(conv.id, 'SHOWING_CATALOG', {
    branchId: branch.id,
    branchName: branch.name,
    catalogId: effectiveCatalogId,
    deliveryLat: address.latitude || address.lat || null,
    deliveryLng: address.longitude || address.lng || null,
    deliveryAddress: address.full_address || address.address || '',
  });
  log.info({ effectiveCatalogId, catalogIdType: typeof effectiveCatalogId }, '_sendBranchMenu: resolved catalogId');
  log.info({ branchCatalogId: branch.catalogId, branchCatalog_id: branch.catalog_id, restaurantId }, '_sendBranchMenu: source ids');

  // ── Check for pending cart from direct catalog browse ──
  const freshConv = await col('conversations').findOne({ _id: conv._id || conv.id });
  const pendingCart = freshConv?.session_data?.pendingCart;
  if (pendingCart?.product_items?.length) {
    log.info({ itemCount: pendingCart.product_items.length }, 'Resuming pending cart after address collection');

    // Verify cart items belong to this branch (lookup by retailer_id)
    const retailerIds = pendingCart.product_items.map(i => i.product_retailer_id);
    const menuItems = await col('menu_items').find({ retailer_id: { $in: retailerIds } }).toArray();
    const branchItems = menuItems.filter(mi => String(mi.branch_id) === String(branch.id));

    if (!branchItems.length) {
      // Items are from a different branch — inform customer and show this branch's menu instead
      const itemBranch = menuItems.length ? await col('branches').findOne({ _id: menuItems[0].branch_id }) : null;
      await wa.sendText(pid, token, to,
        `⚠️ The items in your cart are from ${itemBranch?.name || 'another branch'} which doesn't deliver to your area.\n\nBrowse the menu from *${branch.name}* below:`
      );
      // Clear pending cart and fall through to MPM sending
      await orderSvc.setState(conv.id, 'SHOWING_CATALOG', {
        branchId: branch.id, branchName: branch.name, catalogId: effectiveCatalogId,
        deliveryLat: address.latitude || address.lat || null,
        deliveryLng: address.longitude || address.lng || null,
        deliveryAddress: address.full_address || address.address || '',
      });
    } else {
      // Process the pending cart as if it were a normal catalog order
      const syntheticOrder = { order: { product_items: pendingCart.product_items, catalog_id: pendingCart.catalog_id, coupon_code: pendingCart.coupon_code } };
      // Set session with branch and address data first, then delegate to handleCatalogOrder
      await orderSvc.setState(conv.id, 'SHOWING_CATALOG', {
        branchId: branch.id, branchName: branch.name, catalogId: effectiveCatalogId,
        deliveryLat: address.latitude || address.lat || null,
        deliveryLng: address.longitude || address.lng || null,
        deliveryAddress: address.full_address || address.address || '',
      });
      // Re-fetch conv with updated session
      const updatedConv = await col('conversations').findOne({ _id: conv._id || conv.id });
      await handleCatalogOrder(syntheticOrder, customer, updatedConv, waAccount);
      return; // Don't send MPMs — cart is being processed
    }
  }

  // ── Pre-flight check: verify catalog is linked to phone number ──
  if (effectiveCatalogId) {
    try {
      const cacheKey = `commerce_settings:${pid}`;
      let commerceSettings = memcache.get(cacheKey);
      if (!commerceSettings) {
        const axios = require('axios');
        const csRes = await axios.get(`${metaConfig.graphUrl}/${pid}/whatsapp_commerce_settings`, {
          headers: { Authorization: `Bearer ${metaConfig.systemUserToken}` },
          timeout: 5000,
        });
        commerceSettings = csRes.data?.data?.[0] || csRes.data || {};
        memcache.set(cacheKey, commerceSettings, 300);
        log.info({ phoneNumberId: pid, commerceSettings }, '_sendBranchMenu: Commerce settings fetched');
      }
      const linkedCatalog = commerceSettings.id || commerceSettings.catalog_id;
      if (linkedCatalog && String(linkedCatalog) !== String(effectiveCatalogId)) {
        log.warn({ dbCatalogId: effectiveCatalogId, metaCatalogId: linkedCatalog }, '_sendBranchMenu: Catalog mismatch — using Meta catalog');
        effectiveCatalogId = String(linkedCatalog);
      }
    } catch (preflightErr) {
      log.warn({ err: preflightErr }, '_sendBranchMenu: Preflight check failed (non-blocking)');
    }
  }

  if (effectiveCatalogId) {
    try {
      const { guard } = require('../utils/smartModule');
      const mpms = await guard('MPM_STRATEGY', {
        fn: () => {
          const { buildStrategyMPMs } = require('../services/mpmStrategy');
          return buildStrategyMPMs(branch.id, restaurantId, { customerId: customer?.id });
        },
        fallbackFn: () => {
          const { buildBranchMPMs } = require('../services/mpmBuilder');
          return buildBranchMPMs(branch.id, restaurantId);
        },
        label: 'buildStrategyMPMs',
        context: { branchId: branch.id },
      });
      log.info({ mpmCount: mpms.length, branchName: branch.name }, '_sendBranchMenu: Built MPMs');
      for (const [mi, mpm] of mpms.entries()) {
        log.info({ mpmIndex: mi + 1, header: mpm.header, sectionCount: mpm.sections?.length, productCount: mpm.sections?.reduce((s,sec) => s + (sec.product_retailer_ids?.length || 0), 0) }, '_sendBranchMenu MPM detail');
        if (mpm.sections) for (const sec of mpm.sections) {
          log.info({ sectionTitle: sec.title, retailerIds: (sec.product_retailer_ids || []).join(', ') }, '_sendBranchMenu MPM section');
        }
      }
      if (mpms.length) {
        for (let i = 0; i < mpms.length; i++) {
          // Validate MPM payload before sending
          const mpm = mpms[i];
          if (mpm.sections) {
            mpm.sections = mpm.sections.filter(s => {
              if (!s.title) { log.warn('_sendBranchMenu: Section with no title removed'); return false; }
              s.product_retailer_ids = (s.product_retailer_ids || []).filter(id => {
                if (!id || typeof id !== 'string') { log.warn({ retailerId: JSON.stringify(id) }, '_sendBranchMenu: Invalid retailer_id removed'); return false; }
                return true;
              });
              if (!s.product_retailer_ids.length) { log.warn({ sectionTitle: s.title }, '_sendBranchMenu: Section has 0 valid products — removed'); return false; }
              return true;
            });
          }
          if (!mpm.sections?.length) {
            log.warn('_sendBranchMenu: MPM has 0 valid sections after filtering — skipping');
            await wa.sendText(pid, token, to, 'Our menu is being set up. Please try again shortly.');
            break;
          }
          log.info({ catalogId: effectiveCatalogId, catalogIdType: typeof effectiveCatalogId }, '_sendBranchMenu: sending MPM');
          log.info({ sections: mpm.sections.map(s => ({ title: s.title, count: s.product_retailer_ids.length, sample: s.product_retailer_ids.slice(0, 3) })) }, '_sendBranchMenu: MPM sections');
          try {
            await wa.sendMPM(pid, token, to, String(effectiveCatalogId), mpms[i]);
            log.info({ mpmIndex: i + 1, mpmTotal: mpms.length }, '_sendBranchMenu: MPM sent successfully');
          } catch (mpmSendErr) {
            log.error({ err: mpmSendErr, mpmIndex: i + 1, responseData: mpmSendErr.response?.data }, '_sendBranchMenu: MPM send failed');
            if (i === 0) {
              log.info('_sendBranchMenu: falling back to catalog message');
              await wa.sendCatalog(pid, token, to, effectiveCatalogId, `🍽️ Here's our menu from *${branch.name}*!\n\nBrowse and add items to your cart.`);
              break;
            }
          }
          if (i < mpms.length - 1) await new Promise(r => setTimeout(r, 300));
        }
        if (mpms.length > 1) {
          await wa.sendText(pid, token, to, '👆 Browse the menus above, add items to your cart, and send it when you\'re ready!');
        }
      } else {
        await sendTextMenu(pid, token, to, branch.id);
      }
    } catch (e) {
      log.error({ err: e }, '_sendBranchMenu: MPM build failed');
      await wa.sendCatalog(pid, token, to, effectiveCatalogId, `🍽️ Here's our menu from *${branch.name}*!\n\nBrowse and add items to your cart.`);
    }
  } else {
    await wa.sendText(pid, token, to, `🍽️ Welcome to *${branch.name}*! Our catalog is being set up. Please check back shortly.`);
  }
}

const handleFlowResponse = async (responseData, customer, conv, waAccount) => {
  const pid   = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to    = customerIdentity.resolveRecipient(customer);

  const flowToken = responseData.flow_token || '';
  // flow_token format: "rating_<orderId>" or "feedback_<orderId>"
  const parts = flowToken.split('_');
  const flowType = parts[0];
  const orderId = parts.slice(1).join('_');

  if (flowType === 'rating' || flowType === 'feedback') {
    // Parse all 4 categories + backward compat with old food_rating
    const tasteRating    = parseInt(responseData.taste_rating || responseData.food_rating) || 0;
    const packingRating  = parseInt(responseData.packing_rating) || 0;
    const deliveryRating = parseInt(responseData.delivery_rating) || 0;
    const valueRating    = parseInt(responseData.value_rating) || 0;
    const comment        = responseData.comment || responseData.feedback || null;
    const foodRating     = tasteRating; // backward compat

    if (!orderId || !tasteRating) {
      await wa.sendText(pid, token, to, 'Thanks for your feedback! 😊');
      return;
    }

    // Dedup check
    const existing = await col('order_ratings').findOne({ order_id: orderId });
    if (existing) {
      await wa.sendText(pid, token, to, 'You\'ve already rated this order. Thank you! 😊');
      return;
    }

    const order = await col('orders').findOne({ _id: orderId });
    const overall = Math.round(((tasteRating + packingRating + deliveryRating + valueRating) / 4) * 10) / 10;
    try {
      await col('order_ratings').insertOne({
        _id: newId(),
        order_id: orderId,
        customer_id: customer.id,
        branch_id: order?.branch_id || null,
        restaurant_id: order?.restaurant_id || null,
        taste_rating: tasteRating,
        packing_rating: packingRating,
        delivery_rating: deliveryRating,
        value_rating: valueRating,
        food_rating: foodRating,
        overall_rating: overall,
        comment,
        feedback_tags: [],
        source: 'whatsapp_flow',
        created_at: new Date(),
      });
    } catch (e) {
      if (e.code !== 11000) log.error({ err: e }, 'Flow rating save error');
    }

    const emoji = overall >= 4 ? '🎉' : '🙏';
    await wa.sendText(pid, token, to, `Thank you for rating! ${emoji} Your feedback helps us improve.`);
    await orderSvc.setState(conv.id, 'GREETING', {});
  }
};

// ─── CAPTURE CUSTOMER MESSAGE TO INBOX ──────────────────────
// Saves a general (non-order-flow) message to customer_messages for the restaurant dashboard inbox.
const captureCustomerMessage = async (msg, customer, conv, waAccount) => {
  try {
    // Resolve restaurant_id from the conversation context or WA account
    const session = conv?.session_data || {};
    let restaurantId = null;
    let branchId = session.branchId || null;
    if (branchId) {
      const branch = await col('branches').findOne({ _id: branchId });
      restaurantId = branch?.restaurant_id || null;
    }
    if (!restaurantId) {
      restaurantId = waAccount.restaurant_id || null;
    }

    // Find any active order for context
    const activeOrder = await col('orders').findOne(
      { customer_id: customer.id, status: { $in: ['CONFIRMED', 'PREPARING', 'PACKED', 'DISPATCHED'] } },
      { sort: { created_at: -1 }, projection: { _id: 1, order_number: 1 } }
    );

    // Extract message content
    const messageType = msg.type || 'text';
    let text = null;
    let mediaId = null;
    let mediaMime = null;
    let caption = null;

    if (messageType === 'text') {
      text = msg.text?.body || null;
    } else if (['image', 'document', 'sticker'].includes(messageType)) {
      const media = msg[messageType];
      mediaId = media?.id || null;
      mediaMime = media?.mime_type || null;
      caption = media?.caption || null;
    } else if (messageType === 'location') {
      text = `📍 Location: ${msg.location?.latitude}, ${msg.location?.longitude}`;
      if (msg.location?.address) text += ` — ${msg.location.address}`;
    }

    // Brand context (set in processChange via Brand.findByPhoneNumberId).
    // All three fields are optional — null/undefined preserves legacy
    // single-brand behavior.
    const brandId = waAccount?.brand_id || null;
    const businessId = waAccount?.business_id || null;
    const phoneNumberIdRx = waAccount?.phone_number_id_received || waAccount?.phone_number_id || null;

    const doc = {
      _id: newId(),
      restaurant_id: restaurantId,
      branch_id: branchId,
      brand_id: brandId,
      business_id: businessId,
      phone_number_id: phoneNumberIdRx,
      customer_id: customer.id,
      customer_name: customer.name || null,
      customer_phone: customer.wa_phone || null,
      customer_bsuid: customer.bsuid || null,
      direction: 'inbound',
      message_type: messageType,
      text,
      media_id: mediaId,
      media_url: null,
      media_mime_type: mediaMime,
      caption,
      wa_message_id: msg.id || null,
      conversation_state: conv?.state || null,
      related_order_id: activeOrder ? String(activeOrder._id) : null,
      related_order_number: activeOrder?.order_number || null,
      status: 'unread',
      read_at: null,
      read_by: null,
      replied_at: null,
      replied_by: null,
      resolved_at: null,
      resolved_by: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    await col('customer_messages').insertOne(doc);

    if (restaurantId) ws.broadcastToRestaurant(restaurantId, 'new_message', { customerId: doc.customer_id, customerName: doc.customer_name, text: doc.text, messageType: doc.message_type, createdAt: doc.created_at });

    // Track conversation for analytics (active conversations count)
    if (restaurantId && customer.wa_phone) {
      col('conversations').updateOne(
        { restaurant_id: restaurantId, customer_phone: customer.wa_phone },
        {
          $set: {
            last_message_at: new Date(),
            last_message_direction: 'inbound',
            category: 'service',
          },
          $setOnInsert: {
            _id: newId(),
            restaurant_id: restaurantId,
            customer_phone: customer.wa_phone,
            conversation_started_at: new Date(),
          },
        },
        { upsert: true }
      ).catch(e => log.warn({ err: e }, 'Conversations upsert failed'));
    }

    logActivity({
      actorType: 'customer',
      actorId: customer.id,
      actorName: customer.name || customer.wa_phone || customer.bsuid,
      action: 'customer.message_unhandled',
      category: 'webhook',
      description: `Customer message to inbox: "${(text || caption || messageType).substring(0, 80)}"`,
      restaurantId,
      branchId,
      resourceType: 'customer_message',
      resourceId: String(doc._id),
      severity: 'warning',
    });
  } catch (err) {
    log.error({ err }, 'Failed to capture message to inbox');
  }
};

module.exports = router;
module.exports.sendRatingRequest = sendRatingRequest;
module.exports.processWhatsAppWebhook = processWhatsAppWebhook;
