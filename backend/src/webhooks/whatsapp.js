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
const { col, newId, connect } = require('../config/database');
const wa = require('../services/whatsapp');
const captainHandler = require('../services/captainHandler');
const redisClient = require('../queue/redis');
const location = require('../services/location');
const metaConfig = require('../config/meta');
const orderSvc = require('../services/order');
const paymentSvc = require('../services/payment');
const addressSvc = require('../services/address');
const flowMgr = require('../services/flowManager');
const couponSvc = require('../services/coupon');
const etaSvc = require('../services/eta');
const loyaltySvc = require('../services/loyaltyEngine');
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

// ─── ORDER-LINKAGE RESET ─────────────────────────────────────
// When the cart contents or totals change, any session.orderId carried
// over from a previously-created order becomes a hazard: a subsequent
// checkout would anchor the new cart's items to the OLD order_number,
// which Meta then rejects with error 131009 (total_amount mismatch). This
// helper nulls the order-tied linkage on a session object so the next
// checkout creates a fresh order from scratch.
//
// Use it at every cart-mutation / totals-mutation site by spreading the
// returned session FIRST in the new state's payload, then overriding any
// fields the site recomputes (cart, subtotalRs, totalRs, etc.) afterwards
// so the recomputed values take precedence.
//
// Does NOT touch branchId, deliveryAddress, deliveryLat/Lng, catalogId,
// customer-identity fields, or the cart itself — those belong to the
// conversation, not to a specific just-created order.
function _resetOrderLinkage(session) {
  return {
    ...session,
    orderId: null,
    orderNumber: null,
    rpOrderId: null,
    subtotalRs: null,
    totalRs: null,
  };
}

// ─── CHECKOUT-ENABLED PREDICATE ───────────────────────────────
// Single source of truth for "is in-WhatsApp interactive checkout
// (order_details / sendPaymentRequest) allowed right now?". Mirrors the
// exact two-condition gate used inside _sendOrderCheckout (the Tier-1
// gate): the Razorpay WhatsApp Pay configuration_name must be set in the
// environment AND the platform_settings:checkout_order kill-switch must
// be enabled. Extracted as a tiny helper so the other call sites that
// build order_details inline can apply the SAME gate without duplicating
// the predicate or touching the original gate. Returns a boolean.
async function isCheckoutEnabled() {
  return !!(process.env.RAZORPAY_WA_CONFIG_NAME && (await col('platform_settings').findOne({ _id: 'checkout_order' }))?.enabled);
}

// ─── CROSS-BRANCH CART REMEDIATION ─────────────────────────────
// When a customer browses one branch's catalog (e.g. Madhapur) and then
// their session branch resolves to a different branch (e.g. Marathahalli)
// — typically because the delivery address sits inside the second branch's
// radius — the cart's retailer_id values still carry the FIRST branch's
// slug (e.g. "madhapur-paneer-tikka-half"). Without remediation, the
// menu_items lookup at buildCartFromCatalogOrder drops every foreign-slug
// item as "unavailable at this branch" and the customer's whole cart
// silently vanishes.
//
// This helper walks the incoming cart and rewrites foreign-branch
// retailer_ids to their session-branch equivalents when the same item
// exists at the session branch (matched by the slug suffix after the
// branch prefix). Items that cannot be remediated (no matching item at
// the session branch) are dropped with a warn log.
//
// Args:
//   cartItems     — array of { retailer_id|product_retailer_id, quantity, item_price }
//                   (Meta sends `product_retailer_id`; we accept either)
//   sessionBranch — branch doc with `_id` and `branch_slug`
//   db            — native MongoDB db handle, conventionally
//                   client.db('gullybite') so the lookup is pinned to the
//                   prod db regardless of MONGODB_DB env-var drift
//   notifyCtx     — optional { pid, token, to } for the empty-cart fallback
//                   text. Omit only when the caller will handle the null
//                   return itself.
//
// Returns:
//   null  — cart became empty after remediation; the unavailable-cart
//           text has been sent (when notifyCtx provided). Caller should
//           abort the checkout.
//   array — the remediated cart (possibly identical, possibly shorter).
async function remediateCartItems(cartItems, sessionBranch, db, notifyCtx) {
  if (!Array.isArray(cartItems) || !cartItems.length) return cartItems || [];
  if (!sessionBranch || !sessionBranch.branch_slug) {
    log.warn('remediateCartItems: sessionBranch missing branch_slug — skipping remediation');
    return cartItems;
  }
  if (!db || typeof db.collection !== 'function') {
    log.warn('remediateCartItems: db handle missing — skipping remediation');
    return cartItems;
  }

  const sessionSlug = String(sessionBranch.branch_slug).toLowerCase();
  const sessionPrefix = `${sessionSlug}-`;
  const sessionBranchId = String(sessionBranch._id);

  const remediated = [];
  let mutated = false;

  for (const item of cartItems) {
    const originalRid = String(item.retailer_id || item.product_retailer_id || '').toLowerCase();
    if (!originalRid) {
      // No retailer_id at all — keep as-is and let downstream handle it.
      remediated.push(item);
      continue;
    }
    if (originalRid.startsWith(sessionPrefix)) {
      remediated.push(item);
      continue;
    }

    // Foreign-branch retailer_id. Resolve the foreign branch slug from
    // the menu_items doc carrying this exact retailer_id, strip it, and
    // try to find an equivalent item at the session branch.
    const foreignDoc = await db.collection('menu_items').findOne(
      { retailer_id: originalRid },
      { projection: { branch_id: 1 } }
    );
    if (!foreignDoc) {
      log.warn({ retailer_id: originalRid }, 'cross-branch item dropped (unavailable): retailer_id not found in menu_items');
      mutated = true;
      continue;
    }
    const foreignBranch = await db.collection('branches').findOne(
      { _id: String(foreignDoc.branch_id) },
      { projection: { branch_slug: 1 } }
    );
    if (!foreignBranch || !foreignBranch.branch_slug) {
      log.warn({ retailer_id: originalRid, branch_id: foreignDoc.branch_id }, 'cross-branch item dropped (unavailable): foreign branch slug not resolvable');
      mutated = true;
      continue;
    }
    const foreignPrefix = `${String(foreignBranch.branch_slug).toLowerCase()}-`;
    if (!originalRid.startsWith(foreignPrefix)) {
      // retailer_id wasn't generated by the standard makeRetailerId
      // (branchSlug, name, size) pattern — can't recover the suffix
      // safely. Drop.
      log.warn({ retailer_id: originalRid, foreign_slug: foreignBranch.branch_slug }, 'cross-branch item dropped (unavailable): retailer_id does not start with foreign branch slug');
      mutated = true;
      continue;
    }
    const suffix = originalRid.slice(foreignPrefix.length);
    const candidate = `${sessionPrefix}${suffix}`;

    const localDoc = await db.collection('menu_items').findOne({
      retailer_id: candidate,
      $or: [
        { branch_id: sessionBranchId },
        { branch_ids: sessionBranchId },
      ],
      is_available: true,
      deleted_at: { $exists: false },
    });
    if (!localDoc) {
      log.warn({ retailer_id: originalRid, candidate }, 'cross-branch item dropped (unavailable): no matching item at session branch');
      mutated = true;
      continue;
    }

    log.warn({ original: originalRid, candidate }, 'cross-branch item remediated');
    // Mirror retailer_id under both naming conventions so a downstream
    // consumer reading either field name (Meta uses product_retailer_id;
    // our cart row uses retailer_id) sees the corrected value.
    remediated.push({
      ...item,
      retailer_id: candidate,
      product_retailer_id: candidate,
      item_price: typeof localDoc.price_paise === 'number'
        ? localDoc.price_paise / 100
        : item.item_price,
    });
    mutated = true;
  }

  if (remediated.length === 0) {
    if (notifyCtx && notifyCtx.pid && notifyCtx.token && notifyCtx.to) {
      try {
        await wa.sendText(
          notifyCtx.pid,
          notifyCtx.token,
          notifyCtx.to,
          'Some items in your cart are currently unavailable. Please browse the menu and try again.'
        );
      } catch (e) {
        log.warn({ err: e?.message }, 'remediateCartItems: empty-cart notify sendText failed');
      }
    }
    return null;
  }

  return mutated ? remediated : cartItems;
}

// ─── ADDRESS FLOW HELPER ─────────────────────────────────────
// New flow JSON (id: 26478907788405154) ALWAYS opens on SAVED_ADDRESSES,
// even for customers with zero saved addresses. The "+ Add new address"
// affordance is now a native EmbeddedLink in the Flow JSON that navigates
// to the NEW_ADDRESS screen — no synthetic radio option, no second
// sendFlow re-trigger from the webhook.
async function _sendSavedAddressesFlow(pid, token, to, restaurant, customer, body, flowCta) {
  const savedAddrs = await addressSvc.getAddresses({
    customer_id: customer.id,
    wa_phone: customer.wa_phone || customer.bsuid,
  });
  const addresses = (savedAddrs?.length)
    ? require('../services/flowManager').formatAddressesForFlow(savedAddrs)
    : [];
  await wa.sendFlow(pid, token, to, {
    body,
    flowId: restaurant.flow_id,
    flowCta,
    screenId: 'SAVED_ADDRESSES',
    flowData: {
      screenData: {
        wa_id: customer.wa_phone || customer.bsuid,
        addresses,
        // has_addresses / is_empty are precomputed booleans because
        // Meta's Flow `visible` property only resolves ${data.<field>}
        // references — it can't evaluate `${data.addresses.length > 0}`
        // or any other inline expression. Mirrors the same fields
        // returned by the data-exchange endpoint at routes/flowAddress.js
        // so this kickoff payload and the runtime callbacks stay in
        // lockstep on what the flow JSON can read.
        has_addresses: addresses.length > 0,
        is_empty: addresses.length === 0,
      },
    },
  });
}

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

  // Constant-time verify-token comparison. Mirrors the POST
  // X-Hub-Signature-256 idiom below (this file, ~line 309-312):
  // Buffer.from() both sides → Buffer.byteLength length guard →
  // crypto.timingSafeEqual (throws on unequal length, so the guard
  // runs first). Fail closed: unset/empty expected token, missing
  // provided token, or any mismatch → 403, never echo hub.challenge.
  const expectedVerifyToken = process.env.WEBHOOK_VERIFY_TOKEN;
  if (!expectedVerifyToken || !token) {
    req.log.error('Webhook verification failed. Check WEBHOOK_VERIFY_TOKEN in .env');
    return res.sendStatus(403);
  }
  const provBuf = Buffer.from(token);
  const expBuf = Buffer.from(expectedVerifyToken);
  // timingSafeEqual throws on unequal-length buffers — guard first
  const tokenOk =
    Buffer.byteLength(token) === Buffer.byteLength(expectedVerifyToken) &&
    crypto.timingSafeEqual(provBuf, expBuf);
  if (mode === 'subscribe' && tokenOk) {
    req.log.info('Meta webhook verified');
    return res.status(200).send(challenge);
  }
  req.log.error('Webhook verification failed. Check WEBHOOK_VERIFY_TOKEN in .env');
  res.sendStatus(403);
});

// ─── POST: INCOMING EVENTS ────────────────────────────────────
router.post('/', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
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
    // Verify HMAC-SHA256 signature — MANDATORY, fail closed.
    // Absent header OR unconfigured secret must NEVER process a forgeable payload.
    const sig = req.headers['x-hub-signature-256']?.split('sha256=')[1];
    if (!sig) {
      req.log.warn('Missing x-hub-signature-256 — dropping unsigned payload');
      return;
    }
    if (!process.env.WEBHOOK_APP_SECRET) {
      req.log.error('FATAL: WEBHOOK_APP_SECRET not configured — refusing to process unverifiable webhook (fail closed)');
      return;
    }
    const expected = crypto
      .createHmac('sha256', process.env.WEBHOOK_APP_SECRET)
      .update(req.body)
      .digest('hex');
    const expBuf = Buffer.from(expected);
    const sigBuf = Buffer.from(sig);
    // timingSafeEqual throws on unequal-length buffers — guard first
    if (expBuf.length !== sigBuf.length || !crypto.timingSafeEqual(expBuf, sigBuf)) {
      req.log.warn({ hasAppSecret: !!process.env.WEBHOOK_APP_SECRET }, 'Signature mismatch');
      return;
    }
    req.log.info('Signature passed');

    const body = JSON.parse(req.body);
    if (body.object !== 'whatsapp_business_account') {
      req.log.info({ object: body.object }, 'Ignored — not whatsapp_business_account');
      return;
    }

    // ── STATUS-CALLBACK BYPASS ──
    // Status callbacks are server-to-server delivery/read confirmations
    // from Meta about the BOT's own outbound sends — they are NOT
    // customer activity and must never count toward customer rate limits
    // or abuse scoring. We walk every entry/change because a single
    // webhook batch can mix message and status deliveries.
    const hasInboundMessages = (Array.isArray(body.entry) ? body.entry : []).some((entry) =>
      (Array.isArray(entry?.changes) ? entry.changes : []).some((change) =>
        Array.isArray(change?.value?.messages) && change.value.messages.length > 0
      )
    );
    if (!hasInboundMessages) {
      req.log.info({ phoneNumberId: extractPhoneNumberId(body) }, 'Webhook entry — status callback');
    }

    // [BSUID] ── ABUSE CHECK: blocked identifier (phone or BSUID) ──
    // Skipped entirely on status-only payloads (above): no isPhoneBlocked,
    // no rate-limit checks, no recordViolation, no recordAbuseEvent, no
    // rate_limited webhook_logs row.
    const senderIdentifier = hasInboundMessages ? extractSenderIdentifier(body) : null;
    if (senderIdentifier) {
      // Resolve the WhatsApp account once up-front. We need its
      // restaurant_id to scope the block / violation check per tenant
      // (so a flood at restaurant A doesn't ban the user from
      // restaurant B), and its access_token to send the user-facing
      // warning when we DO rate-limit them. Reuses the same
      // whatsapp_accounts.findOne pattern the downstream handlers use.
      const phoneNumberId = extractPhoneNumberId(body);
      const waAccount = phoneNumberId
        ? await col('whatsapp_accounts').findOne({ phone_number_id: phoneNumberId })
        : null;
      const restaurantId = waAccount?.restaurant_id || null;

      // Two block sources to check:
      //   1. Mongo blocked_phones — durable 30min auto-blocks / manual bans
      //   2. Redis blocked:wa:<phone> — short-lived (10min) abuse-score blocks
      const [mongoBlocked, redisBlock] = await Promise.all([
        isPhoneBlocked(senderIdentifier, restaurantId),
        isBlocked(`wa:${senderIdentifier}`),
      ]);
      if (mongoBlocked || redisBlock.blocked) {
        // (C) Already-blocked customer — do NOT send a message back.
        // The 30min auto-block warning was sent at block creation; sending
        // again on every dropped webhook would amplify noise.
        req.log.warn({ phoneSuffix: String(senderIdentifier).slice(-4), source: mongoBlocked ? 'mongo' : 'redis' }, 'Blocked identifier dropped');
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
        req.log.warn({ phoneSuffix: String(senderIdentifier).slice(-4), specAllowed, legacyAllowed }, 'Message rate limited');
        // Record violation for BOTH scorers. Mongo-backed abuseDetector
        // drives 30min auto-blocks; Redis-backed recordAbuseEvent drives
        // 10-min cool-downs on repeated offenders within a single session.
        // Both restaurant_id-scoped now so a flood against tenant A does
        // not contribute to a block at tenant B.
        abuseDetector.recordViolation(senderIdentifier, restaurantId)
          .then((result) => {
            // (B) Auto-block tipped over: tell the user the chat is paused.
            // (A) Otherwise, drip a "catching up" warning at most once per
            //     5 min via canSendWarning. Both sends are fire-and-forget
            //     — webhook already returned 200 at the top of the handler.
            if (!waAccount) return;
            if (result?.autoBlocked) {
              wa.sendText(
                waAccount.phone_number_id,
                waAccount.access_token,
                senderIdentifier,
                "You've sent a lot of messages in a short time. I've paused this chat for 30 minutes — please try again later."
              ).catch(() => {});
            } else if (abuseDetector.canSendWarning(senderIdentifier)) {
              wa.sendText(
                waAccount.phone_number_id,
                waAccount.access_token,
                senderIdentifier,
                "⏳ Just a moment — I'm catching up. Please try again in 60 seconds."
              ).catch(() => {});
            }
          })
          .catch(() => {});
        recordAbuseEvent(`wa:${senderIdentifier}`, 'rate_limit_hit_wa').catch(() => {});
        // Log rate-limited event
        await col('webhook_logs').insertOne({
          _id: newId(),
          source: 'whatsapp',
          event_type: 'rate_limited',
          phone_number_id: phoneNumberId,
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

// ─── CITY CAPTAIN PHONE-NUMBER-ID → CITY MAP ─────────────────
const CAPTAIN_CITY_MAP_KEY = 'captain:city_map';
const CAPTAIN_CITY_MAP_TTL_SEC = 300;

async function _resolveCaptainCity(phoneNumberId, redisClient) {
  if (!phoneNumberId) return null;
  try {
    const cached = await redisClient.hget(CAPTAIN_CITY_MAP_KEY, String(phoneNumberId));
    if (cached) return cached;
    // Cache miss — rebuild from DB.
    const cities = await col('cities')
      .find({ status: 'active' }, { projection: { _id: 1, phone_number_id: 1 } })
      .toArray();
    if (cities.length === 0) {
      // Set TTL on the empty key so we don't hammer the DB; nothing to set.
      await redisClient.expire(CAPTAIN_CITY_MAP_KEY, CAPTAIN_CITY_MAP_TTL_SEC).catch(() => {});
      return null;
    }
    const pipeline = redisClient.pipeline();
    for (const c of cities) {
      if (c.phone_number_id) pipeline.hset(CAPTAIN_CITY_MAP_KEY, String(c.phone_number_id), String(c._id));
    }
    pipeline.expire(CAPTAIN_CITY_MAP_KEY, CAPTAIN_CITY_MAP_TTL_SEC);
    await pipeline.exec();
    // Look up the requested id from the just-built map.
    const m = cities.find((c) => String(c.phone_number_id) === String(phoneNumberId));
    return m ? String(m._id) : null;
  } catch (err) {
    // Cache fail → don't claim a captain match (let restaurant flow handle).
    return null;
  }
}

// ─── PROCESS A CHANGE OBJECT ──────────────────────────────────
let _dedupIndexCreated = false;
const processChange = async (value) => {
  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId) { log.info('No phone_number_id in metadata — skipping'); return; }

  const msgCount = value.messages?.length || 0;
  const statusCount = value.statuses?.length || 0;
  log.info({ phoneNumberId, msgCount, statusCount }, 'Processing change');

  // ─── CITY CAPTAIN DISPATCHER ─────────────────────────────────
  // Map phone_number_id → cityId via the captain:city_map Redis hash
  // (5-minute TTL, lazily rebuilt from `cities` on miss). If a match
  // is found, route ALL messages in this change to captainHandler and
  // skip the restaurant-side waAccount lookup entirely. Wrapped in a
  // try/catch so any captain bug cannot break restaurant inbound flow.
  try {
    const cityId = await _resolveCaptainCity(phoneNumberId, redisClient);
    if (cityId) {
      log.info({ phoneNumberId, cityId }, 'Routing change to city captain');
      const db = await connect();
      for (const msg of value.messages || []) {
        const contact = (value.contacts || []).find(
          (c) => c.wa_id === msg.from || c.user_id === msg.from || c.user_id === msg.user_id,
        );
        try {
          await captainHandler.handleInbound(db, redisClient, msg, contact, cityId);
        } catch (err) {
          log.error({ err: err.message, msgId: msg.id, cityId }, 'captainHandler.handleInbound threw');
        }
      }
      return;
    }
  } catch (err) {
    log.error({ err: err.message, phoneNumberId }, 'Captain dispatcher failed — falling through to restaurant flow');
  }

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

    // [BSUID] Extract both phone and BSUID from webhook payload.
    // meta_bsuid is Meta's official user_id (kept distinct from our
    // internal `bsuid` so the June 2026 rollout safety-net lookup
    // (CASE 5 in customerIdentity.getOrCreateCustomer) can match
    // returning customers without creating duplicate rows.
    const contact = value.contacts?.find(c => c.wa_id === msg.from || c.user_id === msg.from || c.user_id === msg.user_id);
    const { bsuid, wa_phone, meta_bsuid } = customerIdentity.extractIdentifiers(msg, contact);
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
      await handleMessage(msg, { bsuid, wa_phone, meta_bsuid }, senderName, waAccount);
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
// [BSUID] senderIdentifiers is now { bsuid, wa_phone, meta_bsuid }.
// meta_bsuid is forwarded to getOrCreateCustomer so the CASE 5 lookup
// can recognise returning customers who switched to BSUID-only messaging
// during Meta's June 2026 rollout.
const handleMessage = async (msg, senderIdentifiers, senderName, waAccount) => {
  const customer = await orderSvc.getOrCreateCustomer({
    bsuid: senderIdentifiers.bsuid,
    wa_phone: senderIdentifiers.wa_phone,
    meta_bsuid: senderIdentifiers.meta_bsuid,
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

  // CSW stamp. utils/csw.js reads customers.last_inbound_at to answer
  // "is this customer inside the 24h Meta customer service window?".
  // This is the one place every inbound message type passes through
  // AFTER customer resolution and BEFORE the per-type dispatch (text /
  // interactive / order / location / contacts / fallback), so stamping
  // here is the only point that guarantees full coverage. The prior
  // proxy (customer_messages.direction:'inbound') was only written by
  // captureCustomerMessage in the dead-letter branches, so active
  // ordering customers showed as "outside CSW" and post-payment status
  // updates were silently suppressed.
  // Best-effort: a write failure must NOT block message processing.
  try {
    await col('customers').updateOne(
      { _id: customer.id },
      { $set: { last_inbound_at: new Date() } },
    );
  } catch (err) {
    log.warn({ err: err?.message, customerId: customer.id }, 'CSW stamp (last_inbound_at) failed — continuing');
  }

  // Dashboard-analytics conversation stamp. Mirror-image of the CSW
  // gap above: until now, conversations.last_message_at was written
  // ONLY from captureCustomerMessage's dead-letter branch (whatsapp.js
  // ~4724), so the dashboard "active conversations (24h)" /
  // "active (30d)" KPIs at routes/restaurant.js:7337/7341 severely
  // under-counted real ordering traffic. Stamping here closes that
  // gap; the existing write below stays as-is (harmless redundant
  // write on the dead-letter path — same Date value).
  //
  // Match shape is intentionally `{ restaurant_id, customer_phone }`
  // (NOT conv.id) — that's the analytics-doc convention this field
  // lives on, distinct from the session/state-machine conv doc
  // returned by orderSvc.getOrCreateConversation. Upsert mirrors the
  // existing write so a first-message customer still gets a row.
  //
  // Independent try/catch from the CSW stamp above so one stamp
  // failing cannot suppress the other (per spec).
  try {
    if (waAccount?.restaurant_id && customer.wa_phone) {
      await col('conversations').updateOne(
        { restaurant_id: waAccount.restaurant_id, customer_phone: customer.wa_phone },
        {
          $set: {
            last_message_at: new Date(),
            last_message_direction: 'inbound',
            category: 'service',
          },
          $setOnInsert: {
            _id: newId(),
            restaurant_id: waAccount.restaurant_id,
            customer_phone: customer.wa_phone,
            conversation_started_at: new Date(),
          },
        },
        { upsert: true },
      );
    }
  } catch (err) {
    log.warn({ err: err?.message, restaurantId: waAccount?.restaurant_id }, 'last_message_at stamp failed — continuing');
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
const _sendOrderCheckout = async (pid, token, to, { orderNumber, items, charges, subtotal, deliveryFee, total, discount, dynamicNote, session, customer, waAccount, wamid }) => {
  // Try interactive order_details checkout (Razorpay in-WhatsApp payment)
  const checkoutEnabled = !!(process.env.RAZORPAY_WA_CONFIG_NAME && (await col('platform_settings').findOne({ _id: 'checkout_order' }))?.enabled);
  if (checkoutEnabled && session?.branchId && session?.cart?.length) {
    try {
      const branch = await col('branches').findOne({ _id: session.branchId });
      const restaurant = branch ? await col('restaurants').findOne({ _id: branch.restaurant_id }) : null;

      // ─── PROROUTING /estimate ───────────────────────────────
      // Replace the flat/dynamic delivery fee with a live 3PL quote. On
      // failure we fall back to whatever charges the upstream flow
      // already produced and set needs_manual_dispatch so ops can
      // reroute. Never blocks checkout — always degrades safely.
      const prorouting = require('../services/prorouting');
      let effectiveCharges = charges || session.charges || null;
      let effectiveDeliveryFeeRs = session.deliveryFeeRs || Number(deliveryFee) || 0;
      let effectiveTotalRs = session.totalRs || Number(total) || 0;
      let proroutingEstimatePrice = null;
      let proroutingQuoteId = null;
      let needsManualDispatch = false;

      const canQuote = branch
        && Number.isFinite(Number(branch.latitude)) && Number.isFinite(Number(branch.longitude))
        && Number.isFinite(Number(session.deliveryLat)) && Number.isFinite(Number(session.deliveryLng));

      if (canQuote) {
        const subtotalRs = session.subtotalRs || Number(subtotal) || 0;
        try {
          const est = await prorouting.getEstimate(
            { latitude: branch.latitude, longitude: branch.longitude, pincode: branch.pincode || '' },
            { latitude: session.deliveryLat, longitude: session.deliveryLng, pincode: session.structuredAddress?.pincode || '' },
            subtotalRs,
            branch.city || ''
          );
          proroutingEstimatePrice = Number(est?.estimated_price) || 0;
          proroutingQuoteId = est?.quote_id || null;

          // GullyBite's flat per-order delivery markup (₹5 today, env
          // DELIVERY_PLATFORM_MARKUP_FLAT_RS, default 0). Stage 1
          // (services/delivery/index.js) folds this into the 3PL fee
          // before the split; the Stage 2 re-quote here bypassed Stage 1
          // entirely, so without re-adding it the customer was charged
          // the bare Prorouting fare with no markup. Add it back onto the
          // gross delivery fee BEFORE calculateCheckout so the
          // customer/restaurant split + GST land on the same base Stage 1
          // would have produced.
          const platformMarkupRs = parseFloat(process.env.DELIVERY_PLATFORM_MARKUP_FLAT_RS || 0);
          const grossDeliveryFeeRs = proroutingEstimatePrice + platformMarkupRs;

          // Re-run the financial split using the Prorouting fare so the
          // customer/restaurant shares are re-derived from the live quote.
          const { calculateCheckout } = require('../core/financialEngine');
          const restaurantConfig = {
            delivery_fee_customer_pct: restaurant?.delivery_fee_customer_pct ?? 100,
            menu_gst_mode:             restaurant?.menu_gst_mode             ?? 'included',
            menu_gst_pct:              restaurant?.menu_gst_pct              ?? 5,
            packaging_charge_rs:       restaurant?.packaging_charge_rs       ?? 0,
            packaging_gst_pct:         restaurant?.packaging_gst_pct         ?? 18,
          };
          effectiveCharges = calculateCheckout(
            restaurantConfig,
            subtotalRs,
            grossDeliveryFeeRs,
            session.discountRs || 0
          );
          effectiveDeliveryFeeRs = effectiveCharges.customer_delivery_rs;
          effectiveTotalRs = effectiveCharges.customer_total_rs;
          // Refresh the breakdown's gross fee + provider so the persisted
          // order shows the live Prorouting quote (Stage 2) rather than
          // the stale dynamic-pricing snapshot (Stage 1, e.g. mock@43.81)
          // that was captured during buildCartFromCatalogOrder. Other
          // breakdown fields (distanceKm, surge, etc.) are preserved —
          // they're still useful diagnostic context.
          if (session.deliveryFeeBreakdown && typeof session.deliveryFeeBreakdown === 'object') {
            session.deliveryFeeBreakdown = {
              ...session.deliveryFeeBreakdown,
              // Gross fee = Prorouting fare + flat markup — matches the
              // base actually passed to calculateCheckout above, so the
              // breakdown persisted on the order doc (platformMarkupRs
              // included) is consistent with what the customer was charged.
              totalFeeRs: grossDeliveryFeeRs,
              platformMarkupRs,
              providerName: 'prorouting',
            };
          }
          log.info({ proroutingEstimatePrice, proroutingQuoteId, customerDeliveryRs: effectiveCharges.customer_delivery_rs }, 'prorouting estimate applied');
        } catch (estErr) {
          needsManualDispatch = true;
          log.warn({ err: estErr?.message, status: estErr?.response?.status }, 'prorouting.getEstimate failed — falling back to flat fee');
        }
      } else {
        log.info({ hasBranchCoords: !!(branch?.latitude && branch?.longitude), hasDropCoords: !!(session?.deliveryLat && session?.deliveryLng) }, 'prorouting estimate skipped — missing coords');
      }

      // Create order in PENDING_PAYMENT state so Razorpay webhook can match it.
      // [IDEMPOTENCY] Pass idempotencyKey so a double-click on the Pay button
      // (or a webhook retry, or a stuck client) returns the SAME order.
      const order = await orderSvc.createOrder({
        idempotencyKey: idemKeys.order(customer?.id, session.branchId, session.cart, wamid),
        wamid,
        convId       : session.convId || null,
        customerId   : customer?.id,
        branchId     : session.branchId,
        cart         : session.cart,
        subtotalRs   : session.subtotalRs || Number(subtotal) || 0,
        deliveryFeeRs: effectiveDeliveryFeeRs,
        totalRs      : effectiveTotalRs,
        discountRs   : session.discountRs || 0,
        couponId     : session.coupon?.id || null,
        couponCode   : session.coupon?.code || null,
        deliveryAddress: session.deliveryAddress,
        deliveryLat  : session.deliveryLat,
        deliveryLng  : session.deliveryLng,
        waPhone      : customer?.wa_phone || customer?.bsuid,
        charges      : effectiveCharges,
        deliveryFeeBreakdown: session.deliveryFeeBreakdown || null,
        deliveryQuote: session.deliveryQuote || null,
        structuredAddress: session.structuredAddress || null,
        addressSource: session.addressSource || null,
        proroutingEstimatePrice,
        proroutingQuoteId,
        customerDeliveryFee: effectiveCharges?.customer_delivery_rs ?? null,
        totalDeliveryFee: effectiveCharges?.delivery_fee_total_rs ?? (proroutingEstimatePrice ?? null),
        needsManualDispatch,
      });

      const refId = order.order_number.substring(0, 35).replace(/[^a-zA-Z0-9_\-\.]/g, '-');
      const taxRs = effectiveCharges ? (effectiveCharges.food_gst_rs || 0) + (effectiveCharges.customer_delivery_gst_rs || 0) + (effectiveCharges.packaging_gst_rs || 0) : 0;
      const discountRs = discount?.amountRs || 0;

      // Build a fake fullOrder for sendPaymentRequest (same shape as getOrderDetails returns)
      const checkoutOrder = {
        order_number: order.order_number, id: order.id,
        // Mirrors the persisted field on the order doc — sendPaymentRequest
        // gates the Meta-subtotal deflation on this. Default matches the
        // financialEngine default ('included') so an unconfigured
        // restaurant gets a self-consistent extraction-and-deflation
        // path; Meta's subtotal+tax+shipping−discount invariant holds.
        menu_gst_mode: restaurant?.menu_gst_mode ?? 'included',
        subtotal_rs: effectiveCharges?.subtotal_rs || Number(subtotal) || 0,
        customer_delivery_rs: effectiveCharges?.customer_delivery_rs || effectiveDeliveryFeeRs || 0,
        delivery_fee_rs: effectiveCharges?.customer_delivery_rs || effectiveDeliveryFeeRs || 0,
        food_gst_rs: effectiveCharges?.food_gst_rs || 0,
        customer_delivery_gst_rs: effectiveCharges?.customer_delivery_gst_rs || 0,
        packaging_rs: effectiveCharges?.packaging_rs || 0,
        packaging_gst_rs: effectiveCharges?.packaging_gst_rs || 0,
        discount_rs: discountRs,
        coupon_code: discount?.code || null,
        total_rs: effectiveCharges?.customer_total_rs || effectiveTotalRs || 0,
        business_name: restaurant?.business_name || branch?.name || 'Restaurant',
        items: (items || []).map(i => ({ item_name: i.name, quantity: i.qty || 1, unit_price_rs: Number(i.price) || 0, retailer_id: i.retailer_id || i.retailerId || i.menu_item_id || i.name })),
      };

      // ── Razorpay pre-create ──
      // Pre-create the Razorpay order before sending the WhatsApp
      // interactive message and persist rp_order_id on the orders doc
      // (alongside the payments-collection write below) so reconciliation
      // can resolve from either side. The rp_order_id is NOT embedded in
      // the Meta order_details payload — Meta's schema rejects extra
      // keys on payment_gateway with #131008. Inbound Razorpay webhooks
      // resolve via reference_id (the order_number).
      const rpOrderAmountRs = effectiveCharges?.customer_total_rs || effectiveTotalRs || 0;
      let rpOrderId = null;
      try {
        const rzpOrder = await paymentSvc.createRazorpayOrderRaw({
          amountRs: rpOrderAmountRs,
          currency: 'INR',
          receipt: refId,
          notes: {
            client_order_id: order.order_number,
            gullybite_order_id: String(order.id),
            branch_id: String(session.branchId || ''),
          },
          // close_by — instructs Razorpay to reject payment attempts
          // after the order's expires_at. The post-capture expiry guard
          // in webhooks/razorpay.js stays as a safety net for clock
          // drift between our server and Razorpay's edge.
          ...(order.expires_at ? { close_by: Math.floor(new Date(order.expires_at).getTime() / 1000) } : {}),
        });
        rpOrderId = rzpOrder?.id || null;
        log.info({ orderNumber: order.order_number, rpOrderId }, 'razorpay pre-create ok');
        if (rpOrderId) {
          // Persist on the orders doc — denormalised helper so dashboards
          // and ops scripts can filter orders by rp_order_id without
          // joining payments. Source of truth for webhook reconciliation
          // remains the payments collection (written below).
          await col('orders').updateOne(
            { _id: order.id },
            { $set: { rp_order_id: rpOrderId, updated_at: new Date() } }
          ).catch((err) => log.warn({ err: err?.message, orderId: order.id }, 'orders.rp_order_id persist failed (continuing)'));
        }
      } catch (rpErr) {
        // Order-expiry gate (services/payment.js) — distinct from a
        // Razorpay/network failure: the order's payment window has
        // already closed, so there is nothing to retry. Tell the
        // customer and abort the checkout send entirely rather than
        // falling through to wa.sendPaymentRequest with a null
        // rp_order_id (which would invite a doomed payment attempt).
        if (rpErr?.message && rpErr.message.includes('payment window has expired')) {
          log.warn({ err: rpErr.message, orderNumber: order.order_number }, 'razorpay pre-create skipped — order expired');
          await wa.sendText(pid, token, to, 'This order has expired. Please place a new order.');
          return;
        }
        // Non-expiry Razorpay/network failure: previously this fell
        // through to wa.sendPaymentRequest with rpOrderId=null, handing
        // the customer a payment button that fails when tapped. Abort
        // the checkout send and tell them to retry instead.
        log.warn({
          err: rpErr?.message,
          status: rpErr?.statusCode || rpErr?.response?.status,
          body: rpErr?.error || rpErr?.response?.data,
          orderNumber: order.order_number,
        }, 'razorpay pre-create failed — aborting checkout send');
        await wa.sendText(pid, token, to, 'Payment system is temporarily unavailable. Please try placing the order again in a few minutes.');
        return;
      }

      await wa.sendPaymentRequest(pid, token, to, {
        order: checkoutOrder,
        items: checkoutOrder.items,
        customerName: customer?.name || 'there',
        restaurantName: restaurant?.business_name || branch?.name,
        deliveryAddress: session.deliveryAddress || null,
        rpOrderId,
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

      // Save a payment record so the Razorpay webhook can match it.
      // Primary lookup is rp_order_id (Self-Service path); reference_id
      // remains as a fallback when the pre-create above failed.
      await col('payments').insertOne({
        _id: newId(),
        order_id: order.id,
        rp_order_id: rpOrderId,
        reference_id: refId,
        payment_type: 'checkout_order',
        amount_rs: effectiveCharges?.customer_total_rs || effectiveTotalRs || 0,
        currency: 'INR',
        status: 'pending',
        created_at: new Date(),
      }).catch(e => log.warn({ err: e }, 'Payment record save failed'));

      return;
    } catch (checkoutErr) {
      // Diagnostic-only — preserves existing fallback behavior. Surfaces
      // the swallowed exception with axios response.data + truncated
      // stack + cart context so we can tell whether the failure was
      // orderSvc.createOrder, wa.sendPaymentRequest (Meta API rejection),
      // or a downstream DB write. Variables declared inside the try
      // (effectiveCharges, effectiveTotalRs, ...) are NOT in scope here,
      // so we lean on the function parameters (charges, total, items,
      // session, customer) which are guaranteed to be in scope at every
      // throw point above.
      log.error({
        msg: checkoutErr?.message,
        stack: (checkoutErr?.stack || '').slice(0, 2000),
        axiosData: checkoutErr?.response?.data || null,
        phoneSuffix: String(customer?.wa_phone || customer?.bsuid || '').slice(-4),
        branchId: session?.branchId || null,
        cartTotal: Number(charges?.customer_total_rs || total) || 0,
        itemCount: (items || []).reduce((s, i) => s + (i.qty || 1), 0),
      }, 'order_details build failed — checkout fallback fired');
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

  // ── Dine-in QR check-in (DININ-{branch-slug}) ─────────────────
  // Customer scans a per-branch QR code that pre-fills a WhatsApp
  // message of the form "DININ-{branch-slug}" pointed at the
  // restaurant's WhatsApp number. We detect the format here, BEFORE
  // any other routing (greetings, intent, STOP keyword, dine-in
  // feedback rating prompt), short-circuit on match, and never fall
  // through to the catalog / order flow. Non-matching messages are
  // not affected — control passes to the next handler block.
  {
    const dineInMatch = rawText.match(/^DININ-([\w-]+)$/i);
    if (dineInMatch) {
      const branchSlug = dineInMatch[1];
      const restaurantId = waAccount.restaurant_id;
      try {
        const restaurant = restaurantId
          ? await col('restaurants').findOne({ _id: String(restaurantId) })
          : null;
        const branch = restaurant
          ? await col('branches').findOne({ restaurant_id: String(restaurantId), branch_slug: branchSlug })
          : null;
        if (!branch) {
          log.warn({ restaurantId, branchSlug }, 'dine-in QR: branch not found for slug — acking and dropping');
          await wa.sendText(pid, token, to, 'Thanks for visiting!').catch(() => {});
          return;
        }
        const customerPhone = customer.wa_phone || customerIdentity.resolveRecipient(customer);
        await handleDineInCheckin(customerPhone, branch, restaurant, { source: 'qr' });
      } catch (err) {
        log.error({ err, branchSlug }, 'dine-in QR check-in failed');
        await wa.sendText(pid, token, to, 'Thanks for visiting!').catch(() => {});
      }
      return;
    }
  }

  // ── Dine-in rating text/contextual reply (Prompt 8) ─────────
  // Fires when the customer replies to our list message with a
  // number (1-5) or quotes the prompt directly. Matches by context.id
  // when available, otherwise by recent pending prompt on this phone.
  try {
    const numericMatch = /^\s*([1-5])(?:\s*(?:star|stars|\u2B50))?\s*$/i.test(rawText);
    const contextId = msg.context?.id || null;
    if (numericMatch || contextId) {
      const feedbackSvc = require('../services/feedbackService');
      const pending = await feedbackSvc.findPendingByReply({
        waMessageId: contextId,
        customerPhone: customer?.wa_phone || null,
        restaurantId: waAccount?.restaurant_id || null,
      });
      if (pending && pending.source === 'dine_in' && pending.status === 'sent') {
        const score = numericMatch ? parseInt(rawText, 10) : null;
        if (score) {
          await handleDineInRating({
            feedbackEventId: pending._id,
            score,
            customer,
            waAccount,
          });
          return;
        }
        if (contextId && rawText) {
          // Customer quoted the prompt with free-text feedback — stash it
          // but leave status as 'sent' so a follow-up numeric reply can
          // still land the rating.
          await col('feedback_events').updateOne(
            { _id: pending._id },
            { $set: { feedback_text: rawText.substring(0, 1000), updated_at: new Date() } }
          );
        }
      }
    }
  } catch (fbErr) {
    log.warn({ err: fbErr }, 'dine-in text rating check failed');
  }

  // ── GBREF code detection (referral tracking — invisible to customer) ──
  const gbrefMatch = rawText.match(/GBREF-([a-zA-Z0-9]{4,10})/i);
  if (gbrefMatch) {
    const refCode = gbrefMatch[1];
    log.info({ refCode, phone: (customer.wa_phone || customer.bsuid)?.slice(-4) }, 'GBREF detected');
    // Case-sensitive presence flag captured BEFORE the strip below
    // mutates rawText. Used after stripping to decide whether to
    // route this message through the canonical new-customer welcome
    // handler further down. Case-sensitive per spec — every captain
    // prefill produced by gbrefRedirect.js + captainHandler.js uses
    // literal uppercase 'GBREF-', so this catches every captain
    // handoff while ignoring any lowercase 'gbref-' the regex above
    // would have matched case-insensitively.
    const hadGbrefCaseSensitive = rawText.includes('GBREF-');
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

    // Captain-referred customers (wa.me prefill contains 'GBREF-')
    // are first-message-by-definition — they tapped a deep-link.
    // The downstream welcome handler at ~line 1385 uses an exact
    // Array.includes check against ['HI','HAI','HELLO','HEY',
    // 'START','MENU','ORDER']; prefills like "Hi! GBREF-{code}"
    // strip to "Hi!" which misses the list and would leave the
    // customer with no response. Rewrite rawText to the canonical
    // 'Hi' here so the SAME welcome+address-flow handler that runs
    // for any other new customer fires — no duplicated logic, no
    // captain-specific response code path. The empty-residual
    // fallback above already does this for pure-code prefills; this
    // widens the rewrite to cover all GBREF-bearing inputs.
    if (hadGbrefCaseSensitive) {
      rawText = 'Hi';
      msg.text.body = rawText;
    }
  }

  // ── STOP / UNSUBSCRIBE keyword (marketing block-list) ────────────
  // Hard line for marketing-CSW compliance: the moment a customer texts
  // STOP (in any case) or UNSUBSCRIBE, we drop a row in
  // marketing_blocklist for this (restaurant, customer) pair and flip
  // marketing_opted_in=false on the global customers doc. Both gates
  // are then enforced before send by services/marketingCampaigns.js
  // (manual blasts) and services/journeyExecutor.js (auto journeys).
  // Idempotent — re-sending STOP collapses into the same row via
  // unique (restaurant_id, customer_id). cart-recovery's narrower
  // opt-out is preserved so the abandoned_carts side-state stays
  // consistent. We then short-circuit so the rest of the text
  // pipeline (greetings, intent routing) does NOT run on a STOP.
  if (/^(STOP|UNSUBSCRIBE)$/i.test(rawText.trim())) {
    const restaurantId = waAccount.restaurant_id;
    const customerId = customer._id || customer.id;
    const waPhone = customer.wa_phone || customer.bsuid;
    const now = new Date();
    try {
      await col('marketing_blocklist').updateOne(
        { restaurant_id: restaurantId, customer_id: customerId },
        {
          $setOnInsert: {
            _id: require('../config/database').newId(),
            restaurant_id: restaurantId,
            customer_id: customerId,
            wa_phone: waPhone,
            blocked_at: now,
            blocked_by: 'customer_stop',
            created_at: now,
          },
        },
        { upsert: true },
      );
      // Flip the global opt-in flag too. _at + _source give an audit
      // trail for compliance reviews.
      await col('customers').updateOne(
        { _id: customerId },
        { $set: {
            marketing_opted_in: false,
            marketing_opted_in_at: now,
            marketing_opted_in_source: 'customer_stop',
            updated_at: now,
        } },
      ).catch(() => {});
      // Preserve the narrower cart-recovery opt-out side-effect — it
      // updates abandoned_carts rows that the marketing block-list
      // gate would otherwise leave in 'pending' state.
      try {
        const cartRecovery = require('../services/cart-recovery');
        await cartRecovery.optOut(waPhone, restaurantId);
      } catch (e) { log.warn({ err: e }, 'cart recovery opt-out failed during STOP'); }
    } catch (err) {
      log.error({ err, restaurantId, customerId }, 'STOP keyword: blocklist write failed');
    }
    await wa.sendText(
      pid, token, to,
      "You've been unsubscribed from marketing messages from this restaurant. Reply START to re-subscribe.",
    );
    return;
  }

  // ── START keyword (re-subscribe to marketing) ────────────────────
  // Inverse of the STOP handler above. Removes the marketing_blocklist
  // row for this (restaurant, customer) pair and flips the global
  // marketing_opted_in flag back on so journeyExecutor + manual blasts
  // start sending again. Source 'whatsapp_start' distinguishes this
  // re-opt from signup-time opt-in for compliance audits.
  if (/^START$/i.test(rawText.trim())) {
    const restaurantId = waAccount.restaurant_id;
    const customerId = customer._id || customer.id;
    const now = new Date();
    try {
      await col('marketing_blocklist').deleteOne(
        { restaurant_id: restaurantId, customer_id: customerId },
      );
      await col('customers').updateOne(
        { _id: customerId },
        { $set: {
            marketing_opted_in: true,
            marketing_opted_in_at: now,
            marketing_opted_in_source: 'whatsapp_start',
            updated_at: now,
        } },
      ).catch(() => {});
    } catch (err) {
      log.error({ err, restaurantId, customerId }, 'START keyword: blocklist removal failed');
    }
    await wa.sendText(
      pid, token, to,
      "You've been re-subscribed to marketing messages from this restaurant. You'll receive offers and updates again.",
    );
    return;
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
          await _sendSavedAddressesFlow(pid, token, to, restaurant, customer, 'Choose your delivery address:', 'Choose Address');
        } else {
          await wa.sendLocationRequest(pid, token, to);
        }
        return;
      }
    } catch (e) { log.warn({ err: e }, 'Cart recovery re-engagement check failed'); }
  }

  if (['HI', 'HAI', 'HELLO', 'HEY', 'START', 'MENU', 'ORDER'].includes(text)) {
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
      await _sendSavedAddressesFlow(pid, token, to, restaurant, customer, 'Choose your delivery address to see our menu:', 'Choose Address');
    } else {
      // Flow is the only supported address path. A restaurant with no
      // flow_id is mis-configured — surface a graceful "not ready" message
      // instead of dropping the customer into the deprecated AWAITING_LOCATION
      // collection flow.
      await wa.sendText(pid, token, to,
        "⚠️ This restaurant's ordering is currently being set up. Please contact the restaurant directly."
      );
      await orderSvc.setState(conv.id, 'GREETING');
    }
    return;
  }

  // LEGACY KEYWORD: disabled per Tarun 2026-04-30 — pending dead-code audit decision
  /*
  if (['TRACK', 'STATUS', 'WHERE'].some(w => text.includes(w))) {
    await sendTrackingInfo(customer, conv, waAccount);
    return;
  }
  */

  // LEGACY KEYWORD: disabled per Tarun 2026-04-30 — pending dead-code audit decision
  /*
  if (text === 'CANCEL') {
    await handleCancelRequest(customer, conv, waAccount);
    return;
  }
  */

  // LEGACY KEYWORD: disabled per Tarun 2026-04-30 — pending dead-code audit decision
  /*
  if (['HISTORY', 'ORDERS', 'PAST ORDERS', 'MY ORDERS'].includes(text)) {
    await sendOrderHistory(customer, waAccount);
    return;
  }
  */

  // LEGACY KEYWORD: disabled per Tarun 2026-04-30 — pending dead-code audit decision
  /*
  if (['POINTS', 'LOYALTY', 'REWARDS', 'MY POINTS'].includes(text)) {
    await sendLoyaltyBalance(customer, waAccount);
    return;
  }
  */

  if (text.startsWith('REORDER')) {
    const num = parseInt(text.replace('REORDER', '').trim()) || 1;
    await handleReorder(customer, conv, waAccount, num);
    return;
  }

  // LEGACY KEYWORD: disabled per Tarun 2026-04-30 — pending dead-code audit decision
  /*
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
  */

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
    await linkPhoneAndResumeOrder(phone, customer, conv, waAccount, msg?.id);
    return;
  }

  if (conv.state === 'AWAITING_COUPON') {
    const session = conv.session_data || {};
    if (text === 'SKIP') {
      await orderSvc.setState(conv.id, 'ORDER_REVIEW');
      const tempNum = `TEMP-${Date.now().toString().slice(-6)}`;
      await _sendOrderCheckout(pid, token, to, {
        orderNumber: tempNum,
        items:       session.cart.map(i => ({ name: i.name, qty: i.qty, price: i.unitPriceRs.toFixed(0), retailer_id: i.retailerId })),
        subtotal:    session.subtotalRs.toFixed(0),
        deliveryFee: session.deliveryFeeRs.toFixed(0),
        total:       session.totalRs.toFixed(0),
        discount:    null,
        session, customer, waAccount,
        wamid: msg?.id,
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
    // Coupon changes the total — drop the linkage to whatever order
    // existed under the old totals so checkout below builds a fresh one.
    await orderSvc.setState(conv.id, 'ORDER_REVIEW', {
      ..._resetOrderLinkage(session), coupon: couponData, discountRs: result.discountRs, totalRs: newTotal, charges: updatedCharges,
    });

    await wa.sendText(pid, token, to, result.message);
    const tempNum = `TEMP-${Date.now().toString().slice(-6)}`;
    await _sendOrderCheckout(pid, token, to, {
      orderNumber: tempNum,
      items:       session.cart.map(i => ({ name: i.name, qty: i.qty, price: i.unitPriceRs.toFixed(0), retailer_id: i.retailerId })),
      charges:     updatedCharges,
      subtotal:    session.subtotalRs.toFixed(0),
      deliveryFee: (updatedCharges ? updatedCharges.customer_delivery_rs : session.deliveryFeeRs).toFixed(0),
      total:       newTotal.toFixed(0),
      discount:    { code: couponData.code, amountRs: result.discountRs },
      session: { ...session, coupon: couponData, discountRs: result.discountRs, totalRs: newTotal, charges: updatedCharges },
      customer, waAccount,
      wamid: msg?.id,
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
      // Additive mirror into the unified feedback_events stream so the
      // escalation inbox + review-link funnel pick up this rating.
      // Failure is non-fatal — legacy order_ratings remains authoritative.
      try {
        const feedbackSvc = require('../services/feedbackService');
        const fb = await feedbackSvc.createFeedbackRequest({
          restaurantId: order?.restaurant_id,
          outletId: order?.branch_id || null,
          customerId: customer.id,
          customerPhone: customer.wa_phone || null,
          source: 'delivery',
          orderId: session.ratingOrderId,
          triggeredBy: 'system',
        });
        await feedbackSvc.recordRating({
          feedbackEventId: fb._id,
          rating: overall,
          feedbackText: comment || null,
        });
      } catch (fbErr) {
        log.warn({ err: fbErr }, 'feedback_events mirror (AWAITING_FEEDBACK) failed');
      }
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

    const result = await loyaltySvc.redeemPoints(customer.id, restaurantId, null, pointsToRedeem);
    if (!result.ok) {
      const reasonMsg = result.reason === 'insufficient_balance'
        ? `You only have ${bal.balance} points.`
        : result.reason === 'program_inactive'
          ? 'Loyalty program is not active for this restaurant.'
          : result.reason === 'invalid_points'
            ? 'Please enter a valid point amount.'
            : 'Could not redeem points right now.';
      await wa.sendText(pid, token, to, `⚠️ ${reasonMsg}\n\nType a different amount, *ALL*, or *SKIP*.`);
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

    // Loyalty redeem changes the total — drop the linkage to the prior
    // order so checkout below builds a fresh one against the new total.
    await orderSvc.setState(conv.id, 'ORDER_REVIEW', {
      ..._resetOrderLinkage(session),
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
      items: session.cart.map(i => ({ name: i.name, qty: i.qty, price: i.unitPriceRs.toFixed(0), retailer_id: i.retailerId })),
      charges: updatedCharges,
      subtotal: session.subtotalRs.toFixed(0),
      deliveryFee: (updatedCharges ? updatedCharges.customer_delivery_rs : session.deliveryFeeRs).toFixed(0),
      total: newTotal.toFixed(0),
      discount: { code: `${result.pointsRedeemed} pts`, amountRs: totalDiscount },
      session: { ...session, discountRs: totalDiscount, totalRs: newTotal, charges: updatedCharges },
      customer, waAccount,
      wamid: msg?.id,
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
          // Same two-condition gate as _sendOrderCheckout (Tier-1): only
          // send the in-WhatsApp order_details card when checkout is
          // actually enabled. If it's off, fall back to the standard
          // payment-pending reminder text used by this same handler
          // (below) rather than sending a broken/half-configured card.
          if (!(await isCheckoutEnabled())) {
            log.warn({ orderId: session.orderId }, 'AWAITING_PAYMENT resend: checkout disabled — sending payment-pending text fallback');
            await wa.sendText(pid, token, to,
              `💳 Your order #${session.orderNumber || ''} is awaiting payment.\n\n` +
              (session.paymentLinkUrl ? `Pay here: ${session.paymentLinkUrl}\n\n` : '') +
              'Type *PAY* to get a new payment link, or *CANCEL* to cancel your order.'
            );
            return;
          }
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
          log.info({ hasCoords: true }, 'Forward geocoded address for pending cart');
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
      await _sendSavedAddressesFlow(pid, token, to, restaurant, customer, 'Choose your delivery address:', 'Choose Address');
    } else {
      await wa.sendLocationRequest(pid, token, to);
    }
    return;
  }

  // DEPRECATED: AWAITING_LOCATION state is no longer reachable via normal flow.
  // The WhatsApp delivery-address Flow is the only supported address-collection
  // path. Kept in place so any conversation row stuck in this legacy state from
  // before the migration still gets a usable response. Remove once
  // `db.conversations.countDocuments({state:'AWAITING_LOCATION'})` is zero in prod.
  if (conv.state === 'AWAITING_LOCATION') {
    console.warn('[DEPRECATED] AWAITING_LOCATION handler triggered — should not happen after flow_id enforcement');
    // Try forward geocoding the text as an address before re-prompting
    if (rawText && rawText.length > 5 && !['HI','HELLO','HEY','MENU','ORDER','START'].includes(text)) {
      try {
        const geocoded = await location.forwardGeocode(rawText);
        if (geocoded?.lat && geocoded?.lng) {
          log.info({ hasCoords: true }, 'Forward geocoded text address');
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
    // Flow is the only supported address path. Populated case opens
    // SAVED_ADDRESSES with the customer's addresses pre-loaded; empty
    // case opens NEW_ADDRESS so the customer goes straight to entry.
    // Restaurant fetch hoisted above the if/else so both branches see
    // the same flow_id without a second DB round-trip.
    const addresses = await addressSvc.getAddresses({ customer_id: customer.id });
    const restaurant = await col('restaurants').findOne({ _id: waAccount.restaurant_id });
    if (addresses.length > 0) {
      if (restaurant?.flow_id) {
        await _sendSavedAddressesFlow(pid, token, to, restaurant, customer, 'Choose your delivery address:', 'Choose Address');
      } else {
        await wa.sendLocationRequest(pid, token, to);
      }
    } else {
      // No saved addresses → straight to NEW_ADDRESS. Not-ready message
      // when the restaurant somehow has no flow_id (mis-configured).
      if (restaurant?.flow_id) {
        await wa.sendFlow(pid, token, to, {
          body: 'Set your delivery location:',
          flowId: restaurant.flow_id,
          flowCta: 'Set Location',
          screenId: 'NEW_ADDRESS',
          flowData: { screenData: { wa_id: customer.wa_phone || customer.bsuid, customer_name: customer.name || '', customer_phone: customer.wa_phone || '' } },
        });
      } else {
        await wa.sendText(pid, token, to,
          "⚠️ This restaurant's ordering is currently being set up. Please contact the restaurant directly."
        );
        await orderSvc.setState(conv.id, 'GREETING');
      }
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
    "Sorry, I didn't quite get that. Type *Hi* to browse our menu or tap a button below."
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
      log.info({ hasAddress: !!address }, 'Geocoded address');
    }
  } catch (e) {
    log.warn({ err: e }, 'Reverse geocoding failed, using WhatsApp-provided address');
  }

  await col('customers').updateOne(
    { _id: customer.id },
    { $set: { last_lat: latitude, last_lng: longitude, last_address: address || null } }
  );

  const radiusKm = await location.getPlatformDeliveryRadius();
  const result = await location.findBestAvailableBranch(latitude, longitude, null, radiusKm);

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
      wamid: msg?.id,
    });
    return;
  }

  // Structured-address propagation from the legacy native address form was
  // removed alongside the AWAITING_LOCATION deprecation — that chain is dead
  // (no UI exposes TYPE_ADDRESS). Structured addresses now arrive exclusively
  // via the delivery-address Flow handler, which writes order fields directly.
  const displayAddress = address || 'Your location';

  await orderSvc.setState(conv.id, 'SHOWING_CATALOG', {
    branchId: branch.id,
    branchName: branch.name,
    catalogId: branch.catalogId,
    deliveryLat: latitude,
    deliveryLng: longitude,
    deliveryAddress: displayAddress,
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
  // Fallback: older onboarding paths sometimes only persisted catalog_id on
  // whatsapp_accounts. Read it from there before giving up.
  if (!catalogId) {
    const waCatalog = await col('whatsapp_accounts').findOne(
      { restaurant_id: branch.restaurantId || branch.restaurant_id || waAccount.restaurant_id },
      { projection: { catalog_id: 1 } }
    );
    if (waCatalog?.catalog_id) catalogId = waCatalog.catalog_id;
  }
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
        // Trust the DB catalog_id. The `id` field in commerce_settings is
        // the settings entity id, not a catalog id, so comparing the two
        // produced bogus "mismatches" that overrode the correct DB value
        // with garbage. Just log and move on.
        log.info({ dbCatalogId: catalogId, commerceSettingsId: linkedCatalog }, 'Commerce settings id differs from DB catalog (informational)');
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
            console.error('[MPM-PREFLIGHT-ABORT] reason: mpm_no_valid_sections_after_filter', {
              catalogId: String(catalogId),
              sectionsBeforeFilter: mpm.sections?.length || 0,
              restaurantId: branch.restaurantId || branch.restaurant_id || waAccount.restaurant_id,
              branchId: branch.id,
            });
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
        console.error('[MPM-PREFLIGHT-ABORT] reason: build_returned_zero_mpms', {
          catalogId: String(catalogId),
          totalItems: 0,
          restaurantId: branch.restaurantId || branch.restaurant_id || waAccount.restaurant_id,
          branchId: branch.id,
        });
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
    console.error('[MPM-PREFLIGHT-ABORT] reason: catalogId_unresolved', {
      catalogId: null,
      branchCatalogId: branch.catalogId || branch.catalog_id || null,
      restaurantMetaCatalogId: restaurantDoc?.meta_catalog_id || null,
      restaurantId: branch.restaurantId || branch.restaurant_id || waAccount.restaurant_id,
      branchId: branch.id,
    });
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

    // Trigger address Flow (same as greeting flow). The SAVED_ADDRESSES
    // screen is the single entry point — empty-list shows just the
    // synthetic "+ Add new address" radio, which the webhook re-triggers
    // as a fresh sendFlow on NEW_ADDRESS when the customer selects it.
    const restaurant = await col('restaurants').findOne({ _id: waAccount.restaurant_id });
    if (restaurant?.flow_id) {
      await _sendSavedAddressesFlow(pid, token, to, restaurant, customer, 'Choose your delivery address:', 'Choose Address');
    } else {
      await wa.sendLocationRequest(pid, token, to);
    }
    return;
  }

  let productItems = msg.order?.product_items || [];
  if (!productItems.length) return;

  // Cross-branch remediation. Customer may have browsed one branch's
  // catalog before their address resolved to a different branch — rewrite
  // foreign-slug retailer_ids to the session branch's equivalents (or
  // drop them if no equivalent exists) before buildCartFromCatalogOrder
  // does its branch-scoped lookup. If the cart drops to zero items, the
  // helper sends the unavailable-cart text and returns null; we abort.
  const sessionBranchDoc = await col('branches').findOne({ _id: branchId });
  if (sessionBranchDoc) {
    const remediated = await remediateCartItems(
      productItems,
      sessionBranchDoc,
      globalThis._mongoClient ? globalThis._mongoClient.db('gullybite') : null,
      { pid, token, to }
    );
    if (remediated === null) return;
    productItems = remediated;
  }

  logActivity({ actorType: 'customer', actorId: customer.wa_phone || customer.bsuid, action: 'customer.cart_submitted', category: 'order', description: `Cart submitted by ${customer.name || customer.wa_phone || customer.bsuid}`, restaurantId: waAccount.restaurant_id, branchId: branchId ? String(branchId) : null, severity: 'info' });

  const cart = await orderSvc.buildCartFromCatalogOrder(productItems, branchId, session.deliveryLat, session.deliveryLng, {
    deliveryAddress: session.deliveryAddress,
    customerName: customer.name,
    customerPhone: customer.wa_phone || customer.bsuid || '',
  });

  if (!cart.cart.length) {
    await wa.sendText(pid, token, to, '⚠️ Some items are no longer available. Please browse the menu again.');
    const cartCatalogId = session.catalogId || (await col('restaurants').findOne({ _id: waAccount.restaurant_id }))?.meta_catalog_id;
    if (cartCatalogId) await wa.sendCatalog(pid, token, to, String(cartCatalogId));
    return;
  }

  const metaCouponCode = msg.order?.coupon_code;
  let couponData = session.coupon || null;

  // Reuse the branch doc fetched at line ~2105 for cross-branch remediation
  // — same query (`{_id: branchId}`) so the second findOne was redundant.
  const branch = sessionBranchDoc;
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
    charges = calculateOrderCharges(restConfig, cart.subtotalRs, effectiveDelivery, discountRs);
  }
  const finalTotalRs = charges ? charges.customer_total_rs : (cart.subtotalRs + cart.deliveryFeeRs - discountRs);

  // Cart contents replaced — drop the linkage to whatever order was
  // created under the previous cart. Without this, a subsequent checkout
  // would reuse the old order_number with the new cart's items → Meta
  // 131009 total_amount mismatch.
  await orderSvc.setState(conv.id, 'ORDER_REVIEW', {
    ..._resetOrderLinkage(session),
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

  // setState persists the new cart/charges to MongoDB but the local
  // `conv.session_data` and `session` JS variables are pre-setState
  // snapshots — they still hold the OLD cart contents. Passing them
  // straight to _sendOrderCheckout below caused Meta error 131009 on
  // ZM-20260430-0005: orderSvc.createOrder used session.cart (OLD)
  // for the persisted order while _sendOrderCheckout's items arg was
  // already the NEW cart, so the line items diverged from total_amount.
  // Mirror the setState payload field-for-field here so downstream
  // reads see consistent state.
  const refreshedSession = {
    ..._resetOrderLinkage(session),
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
  };

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
    items: cart.cart.map(i => ({ name: i.name, qty: i.qty, price: i.unitPriceRs.toFixed(0), retailer_id: i.retailerId })),
    charges,
    subtotal:    cart.subtotalRs.toFixed(0),
    deliveryFee: (charges ? charges.customer_delivery_rs : cart.deliveryFeeRs).toFixed(0),
    total:       finalTotalRs.toFixed(0),
    discount:    couponData ? { code: couponData.code, amountRs: discountRs } : null,
    dynamicNote,
    session: refreshedSession,
    customer, waAccount,
    wamid: msg?.id,
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

  // ── Dine-in rating list reply: dinein-rating-<feedbackEventId>-<score>
  if (replyId?.startsWith('dinein-rating-')) {
    const rest = replyId.slice('dinein-rating-'.length);
    const lastDash = rest.lastIndexOf('-');
    if (lastDash > 0) {
      const feedbackEventId = rest.slice(0, lastDash);
      const score = parseInt(rest.slice(lastDash + 1), 10);
      if (feedbackEventId && score >= 1 && score <= 5) {
        await handleDineInRating({
          feedbackEventId,
          score,
          customer,
          waAccount,
        });
        return;
      }
    }
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
        await _sendSavedAddressesFlow(pid, token, to, restaurant, customer, 'Choose your delivery address:', 'Choose Address');
      } else {
        // Flow is the only supported address path. Mirror of the
        // greeting-handler not-ready branch.
        await wa.sendText(pid, token, to,
          "⚠️ This restaurant's ordering is currently being set up. Please contact the restaurant directly."
        );
        await orderSvc.setState(conv.id, 'GREETING');
      }
      break;
    }

    case 'USE_NEW_LOCATION': {
      // "Use current location" tapped in the saved-address list. Route to
      // the Flow's NEW_ADDRESS screen instead of the deprecated native
      // location prompt.
      const restaurant = await col('restaurants').findOne({ _id: waAccount.restaurant_id });
      if (restaurant?.flow_id) {
        await wa.sendFlow(pid, token, to, {
          body: 'Set your delivery location:',
          flowId: restaurant.flow_id,
          flowCta: 'Set Location',
          screenId: 'NEW_ADDRESS',
          flowData: { screenData: { wa_id: customer.wa_phone || customer.bsuid, customer_name: customer.name || '', customer_phone: customer.wa_phone || '' } },
        });
      } else {
        await wa.sendText(pid, token, to,
          "⚠️ This restaurant's ordering is currently being set up. Please contact the restaurant directly."
        );
        await orderSvc.setState(conv.id, 'GREETING');
      }
      break;
    }

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
            // Same two-condition gate as _sendOrderCheckout (Tier-1).
            // When checkout is disabled, fall back to the standard
            // payment-pending reminder text rather than a broken card.
            if (!(await isCheckoutEnabled())) {
              log.warn({ orderId: session.orderId }, 'CONFIRM_ORDER resend: checkout disabled — sending payment-pending text fallback');
              await wa.sendText(pid, token, to,
                `💳 Your order #${session.orderNumber || ''} is awaiting payment.\n\n` +
                (session.paymentLinkUrl ? `Pay here: ${session.paymentLinkUrl}\n\n` : '') +
                'Type *PAY* to get a new payment link, or *CANCEL* to cancel your order.'
              );
              return;
            }
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
        idempotencyKey: idemKeys.order(customer.id, session.branchId, session.cart, msg?.id),
        wamid: msg?.id,
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
        // Same two-condition gate as _sendOrderCheckout (Tier-1). The
        // order is already created here, so in BOTH branches we move to
        // AWAITING_PAYMENT (so PAY/CANCEL and the payment-pending
        // reminder keep working) and the shared payment_pending
        // abandoned-cart tracking below still runs. When checkout is
        // disabled we send the standard payment-pending reminder text
        // instead of a broken card.
        if (await isCheckoutEnabled()) {
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
            // Prefer the per-restaurant display id so the
            // payment-pending reminder ("Your order #X is awaiting
            // payment") shows ABBR-MMDD-NNN. Falls back to the legacy
            // order_number for orders created before this rollout.
            orderNumber: order.display_order_id || order.order_number,
          });
        } else {
          log.warn({ orderId: order.id }, 'CONFIRM_ORDER checkout: checkout disabled — sending payment-pending text fallback');
          const _orderNumber = order.display_order_id || order.order_number;
          await orderSvc.setState(conv.id, 'AWAITING_PAYMENT', {
            ...session,
            orderId: order.id,
            orderNumber: _orderNumber,
          });
          await wa.sendText(pid, token, to,
            `💳 Your order #${_orderNumber || ''} is awaiting payment.\n\n` +
            (session.paymentLinkUrl ? `Pay here: ${session.paymentLinkUrl}\n\n` : '') +
            'Type *PAY* to get a new payment link, or *CANCEL* to cancel your order.'
          );
        }
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
        await orderSvc.setState(conv.id, 'ORDER_REVIEW', { ...session, orderId: order.id, orderNumber: order.display_order_id || order.order_number });
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
      // Coupon removed — total reverts upward, so any order created under
      // the discounted total is now stale. Drop the linkage and let
      // checkout below build a fresh one.
      await orderSvc.setState(conv.id, 'ORDER_REVIEW', {
        ..._resetOrderLinkage(session), coupon: null, discountRs: 0, totalRs: updatedTotal, charges: restoredCharges,
      });
      const tempNum = `TEMP-${Date.now().toString().slice(-6)}`;
      await wa.sendText(pid, token, to, '🗑 Coupon removed.');
      await _sendOrderCheckout(pid, token, to, {
        orderNumber: tempNum,
        items:       session.cart.map(i => ({ name: i.name, qty: i.qty, price: i.unitPriceRs.toFixed(0), retailer_id: i.retailerId })),
        charges:     restoredCharges,
        subtotal:    session.subtotalRs.toFixed(0),
        deliveryFee: (restoredCharges ? restoredCharges.customer_delivery_rs : session.deliveryFeeRs).toFixed(0),
        total:       updatedTotal.toFixed(0),
        discount:    null,
        session: { ...session, coupon: null, discountRs: 0, totalRs: updatedTotal, charges: restoredCharges },
        customer, waAccount,
        wamid: msg?.id,
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
    // Saved address is missing GPS coords (legacy row, pre-Flow rollout).
    // Re-collect via the Flow's NEW_ADDRESS screen instead of the
    // deprecated native location prompt.
    const restaurant = await col('restaurants').findOne({ _id: waAccount.restaurant_id });
    if (restaurant?.flow_id) {
      await wa.sendFlow(pid, token, to, {
        body: 'Set your delivery location:',
        flowId: restaurant.flow_id,
        flowCta: 'Set Location',
        screenId: 'NEW_ADDRESS',
        flowData: { screenData: { wa_id: customer.wa_phone || customer.bsuid, customer_name: customer.name || '', customer_phone: customer.wa_phone || '' } },
      });
    } else {
      await wa.sendText(pid, token, to,
        "⚠️ This restaurant's ordering is currently being set up. Please contact the restaurant directly."
      );
      await orderSvc.setState(conv.id, 'GREETING');
    }
    return;
  }

  await wa.sendText(pid, token, to,
    `📍 Using *${addr.label}*${addr.full_address ? `: ${addr.full_address}` : ''}\n\n🔍 Finding nearest restaurant...`
  );

  const radiusKm = await location.getPlatformDeliveryRadius();
  const result = await location.findBestAvailableBranch(addr.latitude, addr.longitude, null, radiusKm);
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

  // Reorder recognises itself via session_data.reorderCart inside
  // handleLocationMessage (not via state), so the state name is
  // informational. Use GREETING (neutral) since AWAITING_LOCATION is
  // deprecated; the session stash is what actually carries context.
  await orderSvc.setState(conv.id, 'GREETING', {
    reorderCart    : cart,
    reorderBranchId: order.branch_id,
  });

  let replyText = `♻️ *Reordering from #${order.display_order_id || order.order_number}*\n\n${cartText}\n\n`;
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

  // Manager notification now handled by notificationListener.onOrderUpdated,
  // which subscribes to order.updated emitted by orderStateEngine.transitionOrder.
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
    msg += `🏪 *${name}*\n`;
    msg += `   Points: ${l.points_balance} (lifetime: ${l.lifetime_points})\n\n`;
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
    // Mirror into feedback_events so the unified inbox + review funnel
    // reflect the positive rating. Triggers the Google/Zomato nudge.
    try {
      const feedbackSvc = require('../services/feedbackService');
      const fb = await feedbackSvc.createFeedbackRequest({
        restaurantId: order?.restaurant_id,
        outletId: order?.branch_id || null,
        customerId: customer.id,
        customerPhone: customer.wa_phone || null,
        source: 'delivery',
        orderId,
        triggeredBy: 'system',
      });
      await feedbackSvc.recordRating({ feedbackEventId: fb._id, rating: score });
    } catch (fbErr) {
      log.warn({ err: fbErr }, 'feedback_events mirror (handleRatingReply) failed');
    }
    logActivity({ actorType: 'customer', actorId: customer.wa_phone || customer.bsuid, action: 'customer.feedback_submitted', category: 'customer', description: `Rating submitted by ${customer.name || customer.wa_phone || customer.bsuid}`, restaurantId: order?.restaurant_id || null, severity: 'info' });
    await wa.sendText(pid, token, to, 'Thanks for your feedback! 🎉 We\'re glad you enjoyed it!');
    await orderSvc.setState(conv.id, 'GREETING', {});
  }
};

// ─── DINE-IN RATING REPLY HANDLER (Prompt 8) ─────────────────
// Resolves a list-row or text reply against a pending feedback_events
// row. Positive replies trigger the delayed Google/Zomato nudge;
// negative replies park an escalation for the merchant to act on.
const handleDineInRating = async ({ feedbackEventId, score, feedbackText = null, customer, waAccount }) => {
  const pid   = waAccount?.phone_number_id;
  const token = waAccount?.access_token;
  const to    = customer ? customerIdentity.resolveRecipient(customer) : null;

  try {
    const feedbackSvc = require('../services/feedbackService');
    const row = await col('feedback_events').findOne({ _id: feedbackEventId });
    if (!row) {
      if (pid && token && to) {
        await wa.sendText(pid, token, to, 'Thanks for your feedback!');
      }
      return;
    }
    if (row.status !== 'sent') {
      if (pid && token && to) {
        await wa.sendText(pid, token, to, 'You\'ve already rated this visit. Thank you! \uD83D\uDE0A');
      }
      return;
    }
    await feedbackSvc.recordRating({
      feedbackEventId: row._id,
      rating: score,
      feedbackText: feedbackText || null,
    });
  } catch (err) {
    log.warn({ err, feedbackEventId }, 'dine-in rating save failed');
  }

  if (pid && token && to) {
    const msg = score >= 4
      ? `Thanks for the ${score}\u2B50 rating! \uD83C\uDF89 We\'ll follow up shortly with a quick review nudge.`
      : 'Sorry we didn\'t meet your expectations — thank you for telling us. The team has been alerted.';
    await wa.sendText(pid, token, to, msg).catch(() => {});
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

    // Items the customer ordered — surfaced as a CheckboxGroup on
    // RATING_SCREEN so they can flag which dishes they loved. Orders use
    // a string UUID _id (newId()), so the order is already in scope from
    // the findOne above and we map off it directly — NOT new ObjectId()
    // (that throws on a non-hex UUID and there is no second lookup).
    const ordered_items = Array.isArray(order.items)
      ? order.items.map((i) => ({ id: String(i.menu_item_id || i.item_id || i._id), title: i.name }))
      : [];

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
            screenData: { order_number: order.order_number, order_id: orderId, flow_token: `rating_${orderId}`, ordered_items },
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

    // Manual-blast marketing campaigns — attribution lookup via
    // campaign_message_map (separate from the MPM campaigns above).
    // Never allowed to throw or delay the webhook response.
    try {
      const marketingCampaigns = require('../services/marketingCampaigns');
      await marketingCampaigns.trackWebhookStatus(status.id, status.status);
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
    await linkPhoneAndResumeOrder(phone, customer, conv, waAccount, msg?.id);
  } catch (err) {
    log.error({ err }, 'handlePhoneShared error');
    await wa.sendText(pid, token, to,
      '⚠️ Something went wrong. Please type your 10-digit phone number to continue.'
    );
  }
};

// Links a phone number to a BSUID-only customer and resumes the CONFIRM_ORDER flow
const linkPhoneAndResumeOrder = async (phone, customer, conv, waAccount, wamid) => {
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
    idempotencyKey: idemKeys.order(customer.id, session.branchId, session.cart, wamid),
    wamid,
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
    // Same two-condition gate as _sendOrderCheckout (Tier-1). The order
    // is already created; when checkout is disabled, send the standard
    // payment-pending reminder text instead of a broken card. (Parity
    // with the catch branch below — neither changes conversation state.)
    if (!(await isCheckoutEnabled())) {
      log.warn({ orderId: order.id }, 'linkPhoneAndResumeOrder checkout: checkout disabled — sending payment-pending text fallback');
      const _orderNumber = order.display_order_id || order.order_number;
      await wa.sendText(pid, token, to,
        `💳 Your order #${_orderNumber || ''} is awaiting payment.\n\n` +
        (session.paymentLinkUrl ? `Pay here: ${session.paymentLinkUrl}\n\n` : '') +
        'Type *PAY* to get a new payment link, or *CANCEL* to cancel your order.'
      );
      if (etaText) await wa.sendText(pid, token, to, `⏱ Estimated delivery: *${etaText}*`);
      return;
    }
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

// ─── ISSUE FLOW HANDLER (post-delivery issue / dispute) ────
// Consolidated onto the existing issues subsystem (services/issues.js +
// the `issues` collection): the issue Flow's nfm_reply is mapped into
// issueSvc.createIssue, which owns issue_number, routing, SLA, threads.
// Signature mirrors the sibling nfm handlers (responseData, customer,
// conv, waAccount) — not the Part-3 (waId, flowToken, payload, db)
// sketch — to match this file's convention and reuse customerIdentity /
// col / issueSvc. Wrapped end-to-end so a failure never throws into the
// webhook. Part-3 Flow categories are mapped to the existing issues.js
// vocabulary so ROUTING_MAP / PRIORITY_MAP yield the right routed_to.
const ISSUE_FLOW_CATEGORY_MAP = {
  food_quality:       'food_quality',
  packaging:          'packaging',
  wrong_order_placed: 'wrong_order',
  late_delivery:      'delivery_late',
  not_delivered:      'delivery_not_received',
  payment_issue:      'payment_failed',
};

const handleIssueFlowResponse = async (responseData, customer, conv, waAccount) => {
  const pid   = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to    = customerIdentity.resolveRecipient(customer);
  try {
    // Part 4 sends the issue Flow with flow_token = orderId.
    const orderId = String(responseData.flow_token || '').trim();
    if (!orderId) {
      log.warn({ wa_phone: customer.wa_phone || customer.bsuid }, 'issue flow: missing flow_token (orderId)');
      await wa.sendText(pid, token, to,
        'Sorry, we could not link this to an order. Please try again from your order message.'
      ).catch(() => {});
      return;
    }

    const order = await col('orders').findOne({ _id: orderId });
    if (!order) {
      log.warn({ orderId }, 'issue flow: order not found for flow_token');
      await wa.sendText(pid, token, to,
        'Sorry, we could not find that order. Please contact support if this continues.'
      ).catch(() => {});
      return;
    }

    const rawCategory = String(responseData.issue_category || '').trim();
    const category    = ISSUE_FLOW_CATEGORY_MAP[rawCategory] || 'general';
    const description = String(responseData.issue_description || '').trim();

    const issue = await issueSvc.createIssue({
      customerId:    order.customer_id,
      customerName:  customer?.name || order.customer_name || null,
      customerPhone: customer?.wa_phone || order.customer_phone || null,
      orderId:       order._id,
      orderNumber:   order.order_number || null,
      restaurantId:  order.restaurant_id,
      branchId:      order.branch_id || null,
      category,
      description,
      source:        'whatsapp',
    });

    // Acknowledgement copy keyed off the routing the issues engine
    // computed (routed_to), with the not-delivered priority special case.
    let ack;
    if (issue.routed_to === 'restaurant') {
      ack = "We've flagged your concern with the restaurant. Expect a resolution within 24 hours.";
    } else if (category === 'delivery_not_received') {
      ack = 'This is being treated as priority. Our team will contact you within 2 hours.';
    } else {
      ack = 'Our team is reviewing this and will get back to you within 24 hours.';
    }

    log.info(
      { orderId, issueNumber: issue.issue_number, category, routedTo: issue.routed_to },
      'issue flow: issue created',
    );
    await wa.sendText(pid, token, to, ack).catch(() => {});
  } catch (err) {
    log.error(
      { err: err?.message, wa_phone: customer?.wa_phone || customer?.bsuid, flow_token: responseData?.flow_token },
      'handleIssueFlowResponse failed',
    );
    await wa.sendText(pid, token, to,
      "Sorry, we couldn't record your issue. Please try again in a moment."
    ).catch(() => {});
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
  } catch (err) {
    // Malformed JSON from Meta — previously swallowed silently then fell
    // through to the legacy structured-address branch, building a junk
    // "Address provided via form" record and losing the real submission.
    // Now: log it, tell the customer, and STOP (no fall-through).
    log.error({ err, wa_phone: customer.wa_phone || customer.bsuid, response_json: nfmReply.response_json }, 'nfm_reply.response_json parse failed — aborting submission');
    await wa.sendText(pid, token, to,
      'Sorry, something went wrong with your submission. Please try again in a moment.'
    ).catch(() => {});
    return;
  }

  // ── Delivery Address Flow response (action-based — check BEFORE flow_token) ──
  // Accept both 'add_address' (current Flow JSON) and 'new_address' (legacy
  // submissions still in flight from older flow versions).
  if (responseData.action === 'select_address'
      || responseData.action === 'new_address'
      || responseData.action === 'add_address') {
    await handleDeliveryFlowResponse(responseData, customer, conv, waAccount);
    return;
  }

  // ── Issue Flow response (post-delivery issue / dispute) ──
  // Discriminated by the issue_category field — Meta's nfm_reply does
  // not carry the Flow id, and the issue Flow's flow_token is the bare
  // orderId, so issue_category presence is the reliable signal (the
  // env gate was dropped; the Flow id is hardcoded in template.js).
  // MUST precede the generic flow_token branch below, else
  // handleFlowResponse (rating/feedback) would swallow it.
  if (responseData.issue_category !== undefined) {
    await handleIssueFlowResponse(responseData, customer, conv, waAccount);
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

  // No GPS coords from address form — ask for location to find nearest branch.
  // pendingStructuredAddress / pendingFullAddress used to be stashed here for
  // handleLocationMessage to read back, but that whole legacy address-form
  // chain is unreachable now (no UI exposes the TYPE_ADDRESS button). Keys
  // dropped from the stash; the GPS prompt stays as a defensive fallback in
  // case TYPE_ADDRESS is ever re-introduced upstream.
  await orderSvc.setState(conv.id, 'GREETING', {
    ...session,
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

  // Additive error boundary ONLY — wraps the entire existing body unchanged.
  // Previously any throw in saveAddress / serviceability / branch-lookup lost
  // the customer's address submission silently with no retry prompt.
  try {
  log.info({ responseData }, 'Flow delivery response');

  // ── SAVED ADDRESS SELECTED ──
  if (responseData.action === 'select_address') {
    // New flow JSON sends `address_id`; older in-flight payloads sent
    // `selected_address_id` — accept both for the deploy-overlap window.
    const addressId = responseData.address_id || responseData.selected_address_id;

    // "+ Add new address" is now a native EmbeddedLink in the Flow JSON
    // that navigates inline to NEW_ADDRESS — the webhook will only ever
    // receive `select_address` with a real saved-address id (or
    // `add_address` from the NEW_ADDRESS submit handled below).

    // Look up saved address
    const addresses = await addressSvc.getAddresses({ customer_id: customer.id, wa_phone: customer.wa_phone || customer.bsuid });
    const addr = addresses.find(a => String(a._id) === addressId || a.id === addressId);
    if (!addr) {
      await wa.sendText(pid, token, to, "Sorry, that address wasn't found. Please share your location.");
      return;
    }

    // Re-gate saved addresses — a PIN that was serviceable at save
    // time may have been disabled since. Fails open if no PIN stored.
    {
      const { isPincodeServiceable, extractPincode } = require('../utils/pincodeValidator');
      const pinToCheck = addr.pincode || extractPincode(addr.full_address);
      if (pinToCheck) {
        const ok = await isPincodeServiceable(pinToCheck);
        if (!ok) {
          await wa.sendText(pid, token, to, `Sorry, we don't deliver to your area (PIN: ${pinToCheck}) yet. We're expanding soon! 🙏`);
          return;
        }
      } else {
        log.warn({ action: 'select_address', addressId }, 'No pincode extractable — skipping serviceability check');
      }
    }

    // Find branch and send menu
    if (addr.latitude && addr.longitude) {
      const radiusKm = await location.getPlatformDeliveryRadius();
      const result = await location.findBestAvailableBranch(addr.latitude, addr.longitude, restaurantId, radiusKm);
      if (result.found) {
        if (result.isFallback && result.fallbackMessage) await wa.sendText(pid, token, to, result.fallbackMessage);
        await _sendBranchMenu(pid, token, to, result.branch, conv, customer, addr, true);
      } else {
        await wa.sendText(pid, token, to, result.message);
      }
    } else {
      // No GPS on saved address — use the first active branch
      const branch = await col('branches').findOne({ restaurant_id: restaurantId, is_open: true, accepts_orders: true });
      if (branch) {
        const restaurant = await col('restaurants').findOne({ _id: restaurantId });
        const fakeResult = { id: String(branch._id), name: branch.name, address: branch.address, restaurantId, catalogId: restaurant?.meta_catalog_id || branch.catalog_id, businessName: restaurant?.business_name };
        await _sendBranchMenu(pid, token, to, fakeResult, conv, customer, addr, true);
      } else {
        await wa.sendText(pid, token, to, '😔 No outlets are currently open. Please try again later.');
      }
    }
    return;
  }

  // ── NEW ADDRESS SUBMITTED ──
  // Accepts the v3 Flow payload (action: 'add_address') as well as the older
  // 'new_address' submissions still in flight while WABAs migrate to the
  // updated address-flow.json. v3 ships fully-structured fields and we
  // server-side geocode via GOOGLE_MAPS_API_KEY before saving — no Maps link.
  if (responseData.action === 'add_address' || responseData.action === 'new_address') {
    // ── Field normalisation across v3 / v2 / v1 payloads ──
    const recipientName = (responseData.recipient_name
        || responseData.full_name
        || responseData.receiver_name
        || customer.name
        || '').toString().trim() || null;
    const deliveryPhone = (responseData.delivery_phone
        || responseData.phone_number
        || responseData.receiver_phone
        || customer.wa_phone
        || '').toString().trim() || null;
    const houseNumber  = (responseData.house_number
        || responseData.door_no
        || responseData.building_floor
        || '').toString().trim() || null;
    const buildingStreet = (responseData.building_street
        || [responseData.building_name, responseData.street_name || responseData.street].filter(Boolean).join(', ')
        || '').toString().trim() || null;
    const areaLocality = (responseData.area_locality
        || responseData.locality_search
        || '').toString().trim() || null;
    const city = (responseData.city || '').toString().trim() || null;
    const pincode = (responseData.pincode || '').toString().trim() || null;
    const addressLandmark = (responseData.landmark || '').toString().trim() || null;

    // ── Save-as label + nickname resolution ──
    // v3.1 (current flow JSON): `label` is the Home/Work/Other dropdown
    // value; `nickname` is a separate optional free-text field that the
    // SAVED_ADDRESSES card prefers over `label` for the title.
    // v2/v1 compat: `address_type` + `address_nickname` accepted as well.
    const rawLabel = responseData.label
        || responseData.address_type
        || responseData.address_label
        || 'Home';
    const labelLower = String(rawLabel).toLowerCase();
    const nickname = (responseData.nickname || responseData.address_nickname || '').toString().trim();
    let label;
    let typeKey;
    if (labelLower === 'home') {
      label = 'Home';   typeKey = 'home';
    } else if (labelLower === 'work' || labelLower === 'office') {
      label = labelLower === 'work' ? 'Work' : 'Office';
      typeKey = labelLower;
    } else {
      label = rawLabel || 'Other';
      typeKey = 'other';
    }

    // ── Server-side geocoding (non-blocking on failure) ──
    // Always run geocodeAddress before save, but if it returns null
    // coords we still save the address and continue the order flow.
    let geo = { lat: null, lng: null, formatted_address: null };
    try {
      geo = await location.geocodeAddress({
        house_number: houseNumber,
        building_street: buildingStreet,
        area_locality: areaLocality,
        city,
        pincode,
      });
    } catch (e) {
      log.warn({ err: e.message }, 'geocodeAddress threw — continuing with null coords');
    }

    // Build a fallback formatted_address from the structured fields
    // when Google didn't return one (e.g. partial address, API down).
    const fallbackFormatted = [houseNumber, buildingStreet, areaLocality, city]
      .filter(Boolean).join(', ') + (pincode ? ` - ${pincode}` : '');
    const fullAddr = geo.formatted_address || fallbackFormatted || areaLocality || 'Saved address';

    // ── Pincode serviceability gate (fails open when no PIN) ──
    {
      const { isPincodeServiceable, extractPincode } = require('../utils/pincodeValidator');
      const pinToCheck = pincode || extractPincode(fullAddr);
      if (pinToCheck) {
        const ok = await isPincodeServiceable(pinToCheck);
        if (!ok) {
          await wa.sendText(pid, token, to, `Sorry, we don't deliver to your area (PIN: ${pinToCheck}) yet. We're expanding soon! 🙏`);
          return;
        }
      } else {
        log.warn({ action: 'add_address' }, 'No pincode extractable — skipping serviceability check');
      }
    }

    // ── Persist to customer_addresses ──
    await addressSvc.saveAddress(
      { customer_id: customer.id, wa_phone: customer.wa_phone || customer.bsuid },
      {
        label,
        nickname,            // v3.1: separate user-chosen friendly name
        type: typeKey,
        fullAddress: fullAddr,
        formattedAddress: fullAddr,
        recipientName,
        deliveryPhone,
        // v3 structured fields
        houseNumber,
        buildingStreet,
        areaLocality,
        city,
        pincode,
        landmark: addressLandmark,
        // v3 GPS (may be null — non-fatal)
        latitude: geo.lat,
        longitude: geo.lng,
        geocodedAt: geo.lat != null ? new Date() : null,
        locality: areaLocality,
        makeDefault: true,
      }
    );

    // ── Confirmation + branch lookup ──
    const parsedAddress = {
      lat: geo.lat,
      lng: geo.lng,
      latitude: geo.lat,
      longitude: geo.lng,
      address: fullAddr,
      full_address: fullAddr,
      area: areaLocality,
    };

    if (geo.lat != null && geo.lng != null) {
      const radiusKm = await location.getPlatformDeliveryRadius();
      const result = await location.findBestAvailableBranch(geo.lat, geo.lng, restaurantId, radiusKm);
      if (result.found) {
        if (result.isFallback && result.fallbackMessage) await wa.sendText(pid, token, to, result.fallbackMessage);
        await _sendBranchMenu(pid, token, to, result.branch, conv, customer, parsedAddress, true, recipientName);
      } else {
        await wa.sendText(pid, token, to, result.message);
      }
    } else {
      // Geocoding failed — fall back to the first available branch for the
      // restaurant so the customer can still browse the menu and order.
      const branch = await col('branches').findOne({ restaurant_id: restaurantId, is_open: true, accepts_orders: true });
      if (branch) {
        const restaurant = await col('restaurants').findOne({ _id: restaurantId });
        const fakeResult = { id: String(branch._id), name: branch.name, address: branch.address, restaurantId, catalogId: restaurant?.meta_catalog_id || branch.catalog_id, businessName: restaurant?.business_name };
        await _sendBranchMenu(pid, token, to, fakeResult, conv, customer, parsedAddress, true, recipientName);
      } else {
        await wa.sendText(pid, token, to, '😔 No outlets are currently open. Please try again later.');
      }
    }
    return;
  }
  } catch (err) {
    // Address submission failed mid-flow — surface it instead of dead-ending.
    // Match the file's webhook catch pattern: log.error + customer reply,
    // return safely without rethrowing so the webhook does not crash.
    log.error({ err, wa_phone: customer.wa_phone || customer.bsuid, responseData }, 'handleDeliveryFlowResponse threw — address submission failed');
    await wa.sendText(pid, token, to,
      'Sorry, we couldn\'t save your address. Please try again in a moment.'
    ).catch(() => {});
    return;
  }
};

// Helper: after address is resolved and branch found, set session and send MPM catalog
async function _sendBranchMenu(pid, token, to, branch, conv, customer, address, showDeliveryAddress = false, receiverName = null) {
  const restaurantId = branch.restaurantId || branch.restaurant_id;

  // Resolve catalogId — branch first, then restaurant fallback, then
  // whatsapp_accounts fallback (older onboarding paths sometimes only
  // persisted catalog_id there).
  let effectiveCatalogId = branch.catalogId || branch.catalog_id || (await col('restaurants').findOne({ _id: restaurantId }))?.meta_catalog_id;
  if (!effectiveCatalogId) {
    const waCatalog = await col('whatsapp_accounts').findOne(
      { restaurant_id: restaurantId },
      { projection: { catalog_id: 1 } }
    );
    if (waCatalog?.catalog_id) effectiveCatalogId = waCatalog.catalog_id;
  }
  if (effectiveCatalogId && typeof effectiveCatalogId !== 'string') effectiveCatalogId = String(effectiveCatalogId);

  // Branch confirmation message — show nearest branch name + distance
  const branchLabel = branch.businessName ? `*${branch.businessName} — ${branch.name}*` : `*${branch.name}*`;
  const distLine = branch.distanceKm ? `\n🚴 ${branch.distanceKm} km from you` : '';
  const closedNote = (branch.is_open === false) ? `\n\n⏰ ${branch.name} is currently closed. You can browse the menu and order for when they open.` : '';
  // nfm_reply flow folds the customer's delivery address into this message
  // (the interim outlet-lookup message was removed). Other callers
  // (saved-address quick path) keep the original "Delivering from:" header.
  const customerAddr = address?.full_address || address?.address || '';
  let header;
  if (showDeliveryAddress && customerAddr) {
    const receiverLine = receiverName ? `\n👤 Receiver: *${receiverName}*` : '';
    header = `✅ Delivering to: *${customerAddr}*${receiverLine}\n\n`;
  } else {
    header = '✅ Delivering from:\n\n';
  }
  await wa.sendText(pid, token, to,
    `${header}🏪 ${branchLabel}${branch.address ? '\n📍 ' + branch.address : ''}${distLine}\n\nOpening our menu...${closedNote}`
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
        // DB is authoritative — menu_items.retailer_id values are filtered
        // against the DB catalog id, and Meta's whatsapp_commerce_settings
        // can hold a stale phantom catalog id (Apr 26 incident: phantom
        // 2107642493135111 vs real 1623100592347036, not flippable via
        // Graph or UI). Stay on the DB id; warn so the drift is visible.
        log.warn({
          dbCatalogId: effectiveCatalogId,
          metaCatalogId: linkedCatalog,
        }, '_sendBranchMenu: Catalog mismatch — using DB catalog (Meta whatsapp_commerce_settings stale)');
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
            console.error('[MPM-PREFLIGHT-ABORT] reason: mpm_no_valid_sections_after_filter', {
              catalogId: String(effectiveCatalogId),
              sectionsBeforeFilter: mpm.sections?.length || 0,
              restaurantId,
              branchId: branch.id,
              source: '_sendBranchMenu',
            });
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
        console.error('[MPM-PREFLIGHT-ABORT] reason: build_returned_zero_mpms', {
          catalogId: String(effectiveCatalogId),
          totalItems: 0,
          restaurantId,
          branchId: branch.id,
          source: '_sendBranchMenu',
        });
        await sendTextMenu(pid, token, to, branch.id);
      }
    } catch (e) {
      log.error({ err: e }, '_sendBranchMenu: MPM build failed');
      await wa.sendCatalog(pid, token, to, effectiveCatalogId, `🍽️ Here's our menu from *${branch.name}*!\n\nBrowse and add items to your cart.`);
    }
  } else {
    console.error('[MPM-PREFLIGHT-ABORT] reason: catalogId_unresolved', {
      catalogId: null,
      branchCatalogId: branch.catalogId || branch.catalog_id || null,
      restaurantId,
      branchId: branch.id,
      source: '_sendBranchMenu',
    });
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
    // Optional CheckboxGroup on RATING_SCREEN — ids of the ordered items
    // the customer ticked as "loved". Empty array if they skipped it
    // (loved_items is never required).
    const lovedItemIds   = Array.isArray(responseData.loved_items) ? responseData.loved_items : [];

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
        loved_item_ids: lovedItemIds,
        source: 'whatsapp_flow',
        created_at: new Date(),
      });
    } catch (e) {
      if (e.code !== 11000) log.error({ err: e }, 'Flow rating save error');
    }
    // Additive mirror into feedback_events for the unified inbox +
    // review funnel. Legacy order_ratings remains the authoritative
    // source for per-category analytics.
    try {
      const feedbackSvc = require('../services/feedbackService');
      const fb = await feedbackSvc.createFeedbackRequest({
        restaurantId: order?.restaurant_id,
        outletId: order?.branch_id || null,
        customerId: customer.id,
        customerPhone: customer.wa_phone || null,
        source: 'delivery',
        orderId,
        triggeredBy: 'system',
      });
      await feedbackSvc.recordRating({
        feedbackEventId: fb._id,
        rating: overall,
        feedbackText: comment || null,
      });
    } catch (fbErr) {
      log.warn({ err: fbErr }, 'feedback_events mirror (handleFlowResponse) failed');
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

// ─── DINE-IN CHECK-IN HANDLER ─────────────────────────────────
// Shared by the WhatsApp DININ-{slug} webhook path and the staff
// manual-entry route (POST /api/restaurant/dine-in/checkin). Idempotent
// at the customer-row level (findOrCreateByPhone) so retries don't
// create duplicate customer docs — but a SECOND insert into
// dine_in_visits is intentional: each scan is its own visit. Callers
// that want to dedupe a double-scan must do so before invoking this.
//
//   phone      — customer's wa_phone (E.164-ish digit string)
//   branch     — branches doc (must include _id, restaurant_id, dine_in_config)
//   restaurant — restaurants doc (must include _id, marketing_wa_phone_number_id,
//                access_token-bearing waAccount lookup happens here)
//   opts.source — 'qr' (default) | 'staff' | 'pos'
//
// Behaviour:
//   1. Upsert customer by phone (global identity).
//   2. If branch.dine_in_config.enabled !== true: send plain
//      "Thanks for visiting!" and return early (no points, no ledger).
//   3. Insert dine_in_visits row with the next visit_number for
//      (customer_id, branch_id).
//   4. $inc customer.dine_in_points + customer.dine_in_total_visits.
//   5. Compute milestone_hit: the highest threshold the new balance
//      crossed in this check-in (i.e. new_balance >= T > old_balance).
//   6. Fire journeyExecutor.executeJourney with type 'dine_in_checkin'
//      and context { milestone_hit, points_balance, visit_number }.
//
// Never throws — returns { ok, reason, ... } so the WhatsApp webhook
// can always 200 Meta. Returned shape:
//   { ok: true, customer_id, branch_id, visit_number, points_balance,
//     milestone_hit, journeyResult }
//   { ok: false, reason }
const handleDineInCheckin = async (phone, branch, restaurant, opts = {}) => {
  try {
    if (!phone || !branch || !restaurant) {
      return { ok: false, reason: 'bad_args' };
    }
    const source = opts.source || 'qr';
    if (!['qr', 'staff', 'pos'].includes(source)) {
      return { ok: false, reason: 'bad_source' };
    }
    const customerSvc = require('../services/customer.service');
    const journeyExecutor = require('../services/journeyExecutor');

    const customer = await customerSvc.findOrCreateByPhone(phone);
    if (!customer) return { ok: false, reason: 'customer_upsert_failed' };

    // Find a waAccount we can send a reply on. Prefer the marketing
    // number if configured (consistent with how journey templates send),
    // otherwise any whatsapp_accounts row for this restaurant.
    const waAccount = await col('whatsapp_accounts').findOne({
      restaurant_id: String(restaurant._id),
      $or: [{ account_type: 'restaurant' }, { account_type: { $exists: false } }],
    });

    const dineCfg = branch.dine_in_config || {};
    if (!dineCfg.enabled) {
      if (waAccount?.phone_number_id && waAccount?.access_token) {
        await wa.sendText(waAccount.phone_number_id, waAccount.access_token, phone, 'Thanks for visiting!')
          .catch((err) => log.warn({ err: err?.message }, 'dine-in: thanks-only reply failed'));
      }
      return { ok: true, reason: 'feature_disabled', customer_id: String(customer._id) };
    }

    const pointsPerVisit = Number(dineCfg.points_per_visit) || 0;
    const thresholds = Array.isArray(dineCfg.milestone_thresholds) ? dineCfg.milestone_thresholds : [];
    const now = new Date();

    // IST calendar date as 'YYYY-MM-DD' — same approach as
    // routes/admin.js:_todayISTBoundary (en-CA locale formats as
    // YYYY-MM-DD; Intl, no extra date lib). This is the per-day dedupe
    // bucket so a customer can only earn one dine-in credit per IST day.
    const visit_date = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);

    // Small helper so the two early-bail branches (gap / already-credited)
    // send a consistent WA reply, mirroring the thanks-only path above.
    const sendDineInReply = async (msg) => {
      if (waAccount?.phone_number_id && waAccount?.access_token) {
        await wa.sendText(waAccount.phone_number_id, waAccount.access_token, phone, msg)
          .catch((err) => log.warn({ err: err?.message }, 'dine-in: early-return reply failed'));
      }
    };

    // PROBLEM 3 — minimum gap between check-ins. Query the most recent
    // prior visit for this (restaurant, branch, customer) inside the gap
    // window. Done BEFORE the upsert so a too-recent scan never inserts
    // a visit row (no orphan rows on the gap-bail) and never credits.
    const minGapHours = Number(dineCfg.min_checkin_gap_hours) || 4;
    const minimumGapMs = minGapHours * 3600000;
    const recentVisit = await col('dine_in_visits').findOne(
      {
        restaurant_id: String(restaurant._id),
        branch_id: String(branch._id),
        customer_id: String(customer._id),
        created_at: { $gt: new Date(now.getTime() - minimumGapMs) },
      },
      { sort: { created_at: -1 } },
    );
    if (recentVisit) {
      await sendDineInReply('You have already checked in recently — thanks for visiting again!');
      return { ok: true, reason: 'checkin_too_recent', customer_id: String(customer._id) };
    }

    // PROBLEM 1 — double-credit race. Upsert on the per-IST-day dedupe
    // key (restaurant_id, branch_id, customer_id, visit_date) instead of
    // count-then-insert. The native driver (mongodb v6) exposes
    // lastErrorObject.upserted ONLY when this call inserted the doc, so
    // includeResultMetadata:true lets us reliably tell a fresh check-in
    // from one that already existed for today (already credited).
    const visitRes = await col('dine_in_visits').findOneAndUpdate(
      {
        restaurant_id: String(restaurant._id),
        branch_id: String(branch._id),
        customer_id: String(customer._id),
        visit_date,
      },
      {
        $setOnInsert: {
          _id: newId(),
          source,
          points_earned: pointsPerVisit,
          created_at: now,
        },
      },
      { upsert: true, returnDocument: 'after', includeResultMetadata: true },
    );
    // lastErrorObject.upserted is set iff THIS call created the doc.
    const isNewCheckin = !!visitRes?.lastErrorObject?.upserted;
    if (!isNewCheckin) {
      // Already checked in today for this branch — no points, no dupe.
      await sendDineInReply('You are already checked in for today. See you on your next visit!');
      return { ok: true, reason: 'already_checked_in_today', customer_id: String(customer._id) };
    }

    // visit_number = count of visits at this branch (the row we just
    // upserted is included, so the count IS this visit's number). The
    // per-day upsert above makes this race-safe for the common path.
    const visit_number = await col('dine_in_visits').countDocuments({
      customer_id: String(customer._id),
      branch_id: String(branch._id),
    });

    // Atomic $inc, then derive milestone_hit from the PRE-increment
    // balance. mongodb v6 findOneAndUpdate returns the doc directly (no
    // {value} wrapper); using returnDocument:'before' gives the exact
    // pre-update balance so milestone-crossing is computed correctly even
    // under concurrent check-ins (each $inc is atomic). The 48h frequency
    // cap in executeJourney still guards against sending a dupe.
    const before = await col('customers').findOneAndUpdate(
      { _id: String(customer._id) },
      {
        $inc: { dine_in_points: pointsPerVisit, dine_in_total_visits: 1 },
        $set: { updated_at: now },
      },
      { returnDocument: 'before' },
    );
    const prevBalance = Number(before?.dine_in_points || 0);
    const points_balance = prevBalance + pointsPerVisit;
    const after = before;

    // milestone_hit: the LARGEST threshold strictly between prev and
    // new (inclusive of new). If multiple thresholds were crossed in
    // one visit (huge points_per_visit), we report the highest — the
    // milestone template renders the most impressive number.
    let milestone_hit = null;
    for (const t of thresholds) {
      const n = Number(t);
      if (!Number.isFinite(n)) continue;
      if (prevBalance < n && points_balance >= n) {
        if (milestone_hit === null || n > milestone_hit) milestone_hit = n;
      }
    }

    const journeyContext = { points_balance, visit_number };
    if (milestone_hit !== null) journeyContext.milestone_hit = milestone_hit;

    // Dine-in is a promotional/marketing surface — route the journey
    // send through the restaurant-configured marketing number when set
    // (falls back to the primary WABA number otherwise, which is the
    // acceptable behaviour per spec). Same call shape as
    // services/campaigns.js:220 and services/cart-recovery.js:174 so
    // the three promotional paths stay uniform.
    const outboundPhoneNumberId = wa.getOutboundNumberId({
      ...restaurant,
      phoneNumberId: waAccount?.phone_number_id,
      marketingPhoneNumberId: restaurant.marketing_wa_phone_number_id,
    });

    const journeyResult = await journeyExecutor.executeJourney(
      String(restaurant._id),
      String(customer._id),
      'dine_in_checkin',
      journeyContext,
      { outboundPhoneNumberId },
    );

    return {
      ok: true,
      customer_id: String(customer._id),
      customer_name: after?.name || customer.name || null,
      branch_id: String(branch._id),
      visit_number,
      points_balance,
      milestone_hit,
      journeyResult,
    };
  } catch (err) {
    log.error({ err, phone: phone?.slice?.(-4), branchId: branch?._id }, 'handleDineInCheckin crashed');
    return { ok: false, reason: 'error' };
  }
};

module.exports = router;
module.exports.sendRatingRequest = sendRatingRequest;
module.exports.processWhatsAppWebhook = processWhatsAppWebhook;
module.exports.handleDineInCheckin = handleDineInCheckin;
