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
const { waMessageLimiter, waOrderLimiter, abuseDetector, isPhoneBlocked, extractSenderIdentifier, extractPhoneNumberId } = require('../middleware/rateLimit');
const customerIdentity = require('../services/customerIdentity');
const issueSvc = require('../services/issues');
const { logActivity } = require('../services/activityLog');
const ws = require('../services/websocket');

// ─── GET: WEBHOOK VERIFICATION ────────────────────────────────
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Meta webhook verified!');
    return res.status(200).send(challenge);
  }
  console.error('❌ Webhook verification failed. Check WEBHOOK_VERIFY_TOKEN in .env');
  res.sendStatus(403);
});

// ─── POST: INCOMING EVENTS ────────────────────────────────────
router.post('/', express.raw({ type: '*/*' }), async (req, res) => {
  // Must ALWAYS return 200 to Meta — even for rate-limited / blocked messages
  res.sendStatus(200);

  // Entry-point diagnostic logging
  console.log('[WEBHOOK-ENTRY]', {
    ts: new Date().toISOString(),
    bodyExists: !!req.body,
    bodyType: typeof req.body,
    bodyLen: req.body?.length || 0,
    ct: req.headers['content-type'],
    hasSig: !!req.headers['x-hub-signature-256'],
  });

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
      console.warn('[WEBHOOK-SIGNATURE] ⚠️ FAILED — sig mismatch. Has WEBHOOK_APP_SECRET:', !!process.env.WEBHOOK_APP_SECRET);
      return;
    }
    console.log('[WEBHOOK-SIGNATURE] ✅ passed');

    const body = JSON.parse(req.body);
    if (body.object !== 'whatsapp_business_account') {
      console.log('[WEBHOOK-ENTRY] Ignored — object:', body.object);
      return;
    }

    // [BSUID] ── ABUSE CHECK: blocked identifier (phone or BSUID) ──
    const senderIdentifier = extractSenderIdentifier(body);
    if (senderIdentifier) {
      const blocked = await isPhoneBlocked(senderIdentifier);
      if (blocked) {
        console.warn(`[WA Webhook] Blocked identifier dropped: ${senderIdentifier}`);
        return; // silently drop — already returned 200
      }

      // ── RATE LIMIT CHECK ──
      const { allowed } = waMessageLimiter.isAllowed(senderIdentifier);
      if (!allowed) {
        console.warn(`[RateLimit] WhatsApp message rate limited: ${senderIdentifier}`);
        // Record violation for abuse detection
        abuseDetector.recordViolation(senderIdentifier).catch(() => {});
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
    console.error('[WA Webhook] Processing error:', err.message);
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
      tasks.push(processChange(change.value).catch(err => console.error('[WH] Change processing error:', err.message)));
    }
  }
  if (tasks.length) await Promise.allSettled(tasks);
};

// ─── PROCESS A CHANGE OBJECT ──────────────────────────────────
let _dedupIndexCreated = false;
const processChange = async (value) => {
  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId) { console.log('[WEBHOOK-PROCESS] No phone_number_id in metadata — skipping'); return; }

  const msgCount = value.messages?.length || 0;
  const statusCount = value.statuses?.length || 0;
  console.log(`[WEBHOOK-PROCESS] phone=${phoneNumberId} messages=${msgCount} statuses=${statusCount}`);

  // Ensure dedup TTL index exists (lazy, once)
  if (!_dedupIndexCreated) {
    col('_webhook_dedup').createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600, background: true }).catch(() => {});
    col('_error_cooldown').createIndex({ t: 1 }, { expireAfterSeconds: 60, background: true }).catch(() => {});
    _dedupIndexCreated = true;
  }

  const { getWaAccount } = require('../utils/cachedLookup');
  const waAccount = await getWaAccount(phoneNumberId);
  if (!waAccount) {
    console.warn('[WEBHOOK-PROCESS] ❌ No WA account found for phone_number_id:', phoneNumberId, '— message will NOT be processed');
    return;
  }
  console.log(`[WEBHOOK-PROCESS] ✅ WA account matched: restaurant=${waAccount.restaurant_id}`);

  // Use system user token for all messaging (never-expiring, set via env var)
  waAccount.access_token = metaConfig.systemUserToken || waAccount.access_token;

  for (const msg of value.messages || []) {
    console.log(`[WEBHOOK-MESSAGE] id=${msg.id} type=${msg.type} from=${msg.from || msg.user_id || '?'}`);

    // Guard: skip stale messages (>2 min old — likely Meta retries)
    if (msg.timestamp) {
      const age = Date.now() - parseInt(msg.timestamp) * 1000;
      if (age > 120000) { console.log(`[WA] Stale message dropped (${Math.round(age/1000)}s old):`, msg.id); continue; }
    }

    // Dedup: skip if we already processed this message (Meta retries)
    if (msg.id) {
      try {
        const existing = await col('_webhook_dedup').findOne({ _id: msg.id });
        if (existing) { console.log('[WA] Dedup: skipping already-processed message', msg.id); continue; }
        await col('_webhook_dedup').insertOne({ _id: msg.id, createdAt: new Date() });
      } catch (e) {
        if (e.code === 11000) { console.log('[WA] Dedup: duplicate insert, skipping', msg.id); continue; }
      }
    }

    const msgStart = Date.now();

    // [BSUID] Extract both phone and BSUID from webhook payload
    const contact = value.contacts?.find(c => c.wa_id === msg.from || c.user_id === msg.from || c.user_id === msg.user_id);
    const { bsuid, wa_phone } = customerIdentity.extractIdentifiers(msg, contact);
    const senderName = contact?.profile?.name;
    // Best identifier for sending error messages back
    const replyTo = wa_phone || bsuid || msg.from;

    await wa.markRead(phoneNumberId, waAccount.access_token, msg.id);

    // [WhatsApp2026] Show typing indicator while processing
    wa.showTyping(phoneNumberId, waAccount.access_token, replyTo);

    logActivity({
      actorType: 'customer', actorId: wa_phone || bsuid, actorName: senderName,
      action: 'customer.message_received', category: 'webhook',
      description: `Incoming ${msg.type} message from ${senderName || wa_phone || bsuid}`,
      restaurantId: waAccount.restaurant_id, resourceType: 'message',
      metadata: { type: msg.type, state: 'processing' }, severity: 'info',
    });

    try {
      await handleMessage(msg, { bsuid, wa_phone }, senderName, waAccount);
      console.log(`[Perf] Message ${msg.type} from ${wa_phone || bsuid}: ${Date.now() - msgStart}ms`);
    } catch (err) {
      console.error(`[WA] Error handling message from ${customerIdentity.displayIdentifier({ wa_phone, bsuid })} (${Date.now() - msgStart}ms):`, err.message);
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

// ─── TEXT MESSAGE HANDLER ─────────────────────────────────────
const handleTextMessage = async (msg, customer, conv, waAccount) => {
  const pid = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to = customerIdentity.resolveRecipient(customer);
  const rawText = msg.text.body.trim();
  const text = rawText.toUpperCase();

  // ── Google Maps URL detection ─────────────────────────────
  if (location.isMapsUrl(rawText)) {
    console.log('[Bot] Google Maps URL detected:', rawText.substring(0, 100));
    try {
      const coords = await location.extractCoordsFromMapsUrl(rawText);
      if (coords) {
        console.log(`[Bot] Extracted coords: ${coords.lat}, ${coords.lng}`);
        // Treat this the same as a location pin drop — delegate to location handler
        const syntheticLocationMsg = {
          type: 'location',
          location: { latitude: coords.lat, longitude: coords.lng },
        };
        await handleLocationMessage(syntheticLocationMsg, customer, conv, waAccount);
        return;
      }
    } catch (e) {
      console.error('[Bot] Maps URL parse failed:', e.message);
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

  if (['HI', 'HELLO', 'HEY', 'START', 'MENU', 'ORDER'].includes(text)) {
    await orderSvc.setState(conv.id, 'GREETING');

    // If restaurant has a delivery Flow, use it for address selection
    const restaurant = await col('restaurants').findOne({ _id: waAccount.restaurant_id });
    if (restaurant?.flow_id) {
      const savedAddrs = await addressSvc.getAddresses({ customer_id: customer.id, wa_phone: customer.wa_phone || customer.bsuid });
      if (savedAddrs?.length > 0) {
        // Returning customer — show saved addresses via Flow
        const addressItems = flowMgr.formatAddressesForFlow(savedAddrs);
        await wa.sendFlow(pid, token, to, {
          body: `Welcome back${customer.name ? ', ' + customer.name : ''}! 👋\nChoose your delivery address to see our menu.`,
          flowId: restaurant.flow_id,
          flowCta: 'Choose Address',
          screenId: 'SAVED_ADDRESSES',
          flowData: { addresses: addressItems },
        });
      } else {
        // New customer — show new address form via Flow
        await wa.sendFlow(pid, token, to, {
          body: `Hi${customer.name ? ' ' + customer.name : ''}! 👋\nSet your delivery location to browse our menu.`,
          flowId: restaurant.flow_id,
          flowCta: 'Set Location',
          screenId: 'NEW_ADDRESS',
          flowData: {},
        });
      }
      return;
    }

    // Fallback: no Flow set up — use buttons
    await wa.sendButtons(pid, token, to, {
      header: `🍔 Welcome to ${waAccount.display_name || 'GullyBite'}!`,
      body: `Hi ${customer.name || 'there'}! 👋\n\nI'm your food ordering assistant.\nI'll show you our menu and help you place an order right here in WhatsApp.\n\nWant to get started?`,
      footer: 'Takes less than 2 minutes to order',
      buttons: [
        { id: 'START_ORDER', title: '🛒 Order Now' },
        { id: 'TRACK_ORDER', title: '📦 Track Order' },
        { id: 'VIEW_HISTORY', title: '📜 Past Orders' },
      ],
    });
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
      await wa.sendOrderSummary(pid, token, to, {
        orderNumber: tempNum,
        items:       session.cart.map(i => ({ name: i.name, qty: i.qty, price: i.unitPriceRs.toFixed(0) })),
        subtotal:    session.subtotalRs.toFixed(0),
        deliveryFee: session.deliveryFeeRs.toFixed(0),
        total:       session.totalRs.toFixed(0),
        discount:    null,
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
      updatedCharges = calculateOrderCharges(
        { delivery_fee_customer_pct: Math.round((updatedCharges.customer_delivery_rs / updatedCharges.delivery_fee_total_rs) * 100) || 100,
          menu_gst_mode: updatedCharges.food_gst_rs > 0 ? 'extra' : 'included',
          menu_gst_pct: updatedCharges.food_gst_rs > 0 ? (updatedCharges.food_gst_rs / updatedCharges.subtotal_rs * 100) : 5,
          packaging_charge_rs: updatedCharges.packaging_rs,
          packaging_gst_pct: updatedCharges.packaging_rs > 0 ? (updatedCharges.packaging_gst_rs / updatedCharges.packaging_rs * 100) : 18 },
        session.subtotalRs, updatedCharges.delivery_fee_total_rs, result.discountRs
      );
    }
    const newTotal = updatedCharges ? updatedCharges.customer_total_rs : (session.subtotalRs + session.deliveryFeeRs - result.discountRs);
    await orderSvc.setState(conv.id, 'ORDER_REVIEW', {
      ...session, coupon: couponData, discountRs: result.discountRs, totalRs: newTotal, charges: updatedCharges,
    });

    await wa.sendText(pid, token, to, result.message);
    const tempNum = `TEMP-${Date.now().toString().slice(-6)}`;
    await wa.sendOrderSummary(pid, token, to, {
      orderNumber: tempNum,
      items:       session.cart.map(i => ({ name: i.name, qty: i.qty, price: i.unitPriceRs.toFixed(0) })),
      charges:     updatedCharges,
      subtotal:    session.subtotalRs.toFixed(0),
      deliveryFee: (updatedCharges ? updatedCharges.customer_delivery_rs : session.deliveryFeeRs).toFixed(0),
      total:       newTotal.toFixed(0),
      discount:    { code: couponData.code, amountRs: result.discountRs },
    });
    return;
  }

  // ── AWAITING_FEEDBACK: capture rating comment ──
  if (conv.state === 'AWAITING_FEEDBACK') {
    const session = conv.session_data || {};
    const comment = text === 'SKIP' ? null : msg.text.body.trim();
    try {
      const order = await col('orders').findOne({ _id: session.ratingOrderId });
      await col('order_ratings').insertOne({
        _id: newId(),
        order_id: session.ratingOrderId,
        customer_id: customer.id,
        branch_id: order?.branch_id || null,
        restaurant_id: order?.restaurant_id || null,
        food_rating: session.foodRating,
        delivery_rating: session.foodRating,
        comment,
        created_at: new Date(),
      });
    } catch (e) {
      if (e.code !== 11000) console.error('[Rating] save error:', e.message);
    }
    logActivity({ actorType: 'customer', actorId: customer.wa_phone || customer.bsuid, action: 'customer.feedback_submitted', category: 'customer', description: `Rating submitted by ${customer.name || customer.wa_phone || customer.bsuid}`, restaurantId: order?.restaurant_id || null, severity: 'info' });
    await orderSvc.setState(conv.id, 'GREETING', {});
    await wa.sendText(pid, token, to, comment ? 'Thanks for your feedback! We\'ll work on improving. 🙏' : 'No worries — thanks for rating! 🎉');
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
    await wa.sendOrderSummary(pid, token, to, {
      orderNumber: tempNum,
      items: session.cart.map(i => ({ name: i.name, qty: i.qty, price: i.unitPriceRs.toFixed(0) })),
      charges: updatedCharges,
      subtotal: session.subtotalRs.toFixed(0),
      deliveryFee: (updatedCharges ? updatedCharges.customer_delivery_rs : session.deliveryFeeRs).toFixed(0),
      total: newTotal.toFixed(0),
      discount: { code: `${result.pointsRedeemed} pts`, amountRs: totalDiscount },
    });
    return;
  }

  if (conv.state === 'AWAITING_LOCATION') {
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
      console.log('[Bot] Geocoded address:', address);
    }
  } catch (e) {
    console.warn('[Bot] Reverse geocoding failed, using WhatsApp-provided address:', e.message);
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
    const dynamicResult = await calculateDynamicDeliveryFee(branch.id, latitude, longitude, {
      deliveryAddress: address || 'Your location',
      customerName: customer.name,
      customerPhone: customer.wa_phone || customer.bsuid || '',
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
    await wa.sendOrderSummary(pid, token, to, {
      orderNumber: tempNum,
      items      : reorderCart.map(i => ({ name: i.name, qty: i.qty, price: i.unitPriceRs.toFixed(0) })),
      charges,
      subtotal   : subtotalRs.toFixed(0),
      deliveryFee: charges.customer_delivery_rs.toFixed(0),
      total      : charges.customer_total_rs.toFixed(0),
      discount   : null,
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

  // Send branch-filtered MPMs (Multi-Product Messages)
  // Fetch restaurant for meta_catalog_id fallback (branch object from findNearestBranch doesn't include it always)
  const restaurantDoc = await col('restaurants').findOne({ _id: branch.restaurantId });
  const catalogId = branch.catalogId || branch.catalog_id || restaurantDoc?.meta_catalog_id;
  console.log(`[Bot] Sending menu: branch=${branch.name}, catalogId=${catalogId}, phone=${pid}`);

  if (catalogId) {
    try {
      const { buildBranchMPMs } = require('../services/mpmBuilder');
      const mpms = await buildBranchMPMs(branch.id, branch.restaurantId || branch.restaurant_id || waAccount.restaurant_id);
      console.log(`[Bot] Built ${mpms.length} MPM(s) with sections:`, mpms.map(m => m.sections?.map(s => `${s.title}(${s.product_retailer_ids?.length})`)));
      if (mpms.length) {
        for (let i = 0; i < mpms.length; i++) {
          try {
            await wa.sendMPM(pid, token, to, catalogId, mpms[i]);
            console.log(`[Bot] MPM ${i+1}/${mpms.length} sent successfully`);
          } catch (mpmSendErr) {
            console.error(`[Bot] MPM ${i+1} send failed:`, mpmSendErr.response?.data || mpmSendErr.message);
            // If first MPM fails, fall back to catalog message
            if (i === 0) {
              console.log('[Bot] Falling back to catalog message');
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
        console.log('[Bot] No items in branch — sending text menu');
        await sendTextMenu(pid, token, to, branch.id);
      }
    } catch (mpmErr) {
      console.error('[Bot] MPM build failed:', mpmErr.message, mpmErr.stack?.split('\n')[1]);
      await wa.sendCatalog(pid, token, to, catalogId,
        `🍽️ Here's our menu from *${branch.name}*!\n\nBrowse and add items to your cart.`
      );
    }
  } else {
    console.log('[Bot] No catalog_id found — sending text menu');
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
    await orderSvc.setState(conv.id, 'AWAITING_LOCATION');
    await wa.sendLocationRequest(pid, token, to);
    return;
  }

  const productItems = msg.order?.product_items || [];
  if (!productItems.length) return;

  logActivity({ actorType: 'customer', actorId: customer.wa_phone || customer.bsuid, action: 'customer.cart_submitted', category: 'order', description: `Cart submitted by ${customer.name || customer.wa_phone || customer.bsuid}`, restaurantId: waAccount.restaurant_id, branchId: branchId ? String(branchId) : null, severity: 'info' });

  const cart = await orderSvc.buildCartFromCatalogOrder(productItems, branchId, session.deliveryLat, session.deliveryLng, {
    deliveryAddress: session.deliveryAddress,
    customerName: customer.name,
    customerPhone: customer.wa_phone || customer.bsuid || '',
  });

  if (!cart.cart.length) {
    await wa.sendText(pid, token, to, '⚠️ Some items are no longer available. Please browse the menu again.');
    if (session.catalogId) await wa.sendCatalog(pid, token, to, session.catalogId);
    return;
  }

  const metaCouponCode = msg.order?.coupon_code;
  let couponData = session.coupon || null;
  if (metaCouponCode && !couponData) {
    const branch = await col('branches').findOne({ _id: branchId });
    const restaurantId = branch?.restaurant_id;
    const result = await couponSvc.validateCoupon(metaCouponCode, restaurantId, cart.subtotalRs);
    if (result.valid) {
      couponData = { id: result.coupon.id, code: result.coupon.code, discountRs: result.discountRs };
      await wa.sendText(pid, token, to, result.message);
    }
  }

  const discountRs = couponData?.discountRs || 0;

  let charges = cart.charges;
  if (discountRs > 0 && charges) {
    const branch = await col('branches').findOne({ _id: branchId });
    const restaurant = branch ? await col('restaurants').findOne({ _id: branch.restaurant_id }) : null;
    const { calculateOrderCharges } = require('../services/charges');
    charges = calculateOrderCharges(
      { delivery_fee_customer_pct: restaurant?.delivery_fee_customer_pct ?? 100,
        menu_gst_mode: restaurant?.menu_gst_mode ?? 'included',
        menu_gst_pct: restaurant?.menu_gst_pct ?? 5,
        packaging_charge_rs: restaurant?.packaging_charge_rs ?? 0,
        packaging_gst_pct: restaurant?.packaging_gst_pct ?? 18 },
      cart.subtotalRs, charges.delivery_fee_total_rs, discountRs
    );
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

  await wa.sendOrderSummary(pid, token, to, {
    orderNumber: tempOrderNum,
    items: cart.cart.map(i => ({ name: i.name, qty: i.qty, price: i.unitPriceRs.toFixed(0) })),
    charges,
    subtotal:    cart.subtotalRs.toFixed(0),
    deliveryFee: (charges ? charges.customer_delivery_rs : cart.deliveryFeeRs).toFixed(0),
    total:       finalTotalRs.toFixed(0),
    discount:    couponData ? { code: couponData.code, amountRs: discountRs } : null,
    dynamicNote,
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
      const addresses = await addressSvc.getAddresses({ customer_id: customer.id });
      if (addresses.length > 0) {
        await orderSvc.setState(conv.id, 'SELECTING_ADDRESS');
        await wa.sendAddressList(pid, token, to, addresses);
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

      const order = await orderSvc.createOrder({
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
        etaSvc.calculateETA(session.branchId, session.deliveryLat, session.deliveryLng).catch(e => { console.warn('[ETA] calc error:', e.message); return null; }),
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

      try {
        await paymentSvc.createRazorpayOrder(fullOrder, customer);
        await wa.sendPaymentRequest(pid, token, to, {
          order: fullOrder,
          items: fullOrder.items,
        });
        if (etaText) await wa.sendText(pid, token, to, `⏱ Estimated delivery: *${etaText}*`);
      } catch (waPayErr) {
        console.warn('[WA] WhatsApp Pay failed, falling back to payment link:', waPayErr.message);
        const link = await paymentSvc.createPaymentLink(fullOrder, customer);
        await wa.sendPaymentLink(pid, token, to, {
          orderNumber: order.order_number,
          total      : order.total_rs.toFixed(0),
          url        : link.url,
          expiryMins : link.expiryMins,
        });
        if (etaText) await wa.sendText(pid, token, to, `⏱ Estimated delivery: *${etaText}*`);
      }
      console.log(`[Perf] Order post-processing: ${Date.now() - _orderStart}ms`);
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
        restoredCharges = calculateOrderCharges(
          { delivery_fee_customer_pct: Math.round((restoredCharges.customer_delivery_rs / restoredCharges.delivery_fee_total_rs) * 100) || 100,
            menu_gst_mode: restoredCharges.food_gst_rs > 0 ? 'extra' : 'included',
            menu_gst_pct: restoredCharges.food_gst_rs > 0 ? (restoredCharges.food_gst_rs / restoredCharges.subtotal_rs * 100) : 5,
            packaging_charge_rs: restoredCharges.packaging_rs,
            packaging_gst_pct: restoredCharges.packaging_rs > 0 ? (restoredCharges.packaging_gst_rs / restoredCharges.packaging_rs * 100) : 18 },
          session.subtotalRs, restoredCharges.delivery_fee_total_rs, 0
        );
      }
      const updatedTotal = restoredCharges ? restoredCharges.customer_total_rs : (session.subtotalRs + session.deliveryFeeRs);
      await orderSvc.setState(conv.id, 'ORDER_REVIEW', {
        ...session, coupon: null, discountRs: 0, totalRs: updatedTotal, charges: restoredCharges,
      });
      const tempNum = `TEMP-${Date.now().toString().slice(-6)}`;
      await wa.sendText(pid, token, to, '🗑 Coupon removed.');
      await wa.sendOrderSummary(pid, token, to, {
        orderNumber: tempNum,
        items:       session.cart.map(i => ({ name: i.name, qty: i.qty, price: i.unitPriceRs.toFixed(0) })),
        charges:     restoredCharges,
        subtotal:    session.subtotalRs.toFixed(0),
        deliveryFee: (restoredCharges ? restoredCharges.customer_delivery_rs : session.deliveryFeeRs).toFixed(0),
        total:       updatedTotal.toFixed(0),
        discount:    null,
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
      console.error('[Refund] Failed:', e.message)
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
    // Ask for feedback comment
    await orderSvc.setState(conv.id, 'AWAITING_FEEDBACK', { ratingOrderId: orderId, foodRating: score });
    await wa.sendText(pid, token, to,
      'Sorry to hear that. 😔 Could you tell us what went wrong?\n\nType your feedback or *SKIP* to continue.'
    );
  } else {
    // Save immediately with no comment
    const order = await col('orders').findOne({ _id: orderId });
    try {
      await col('order_ratings').insertOne({
        _id: newId(),
        order_id: orderId,
        customer_id: customer.id,
        branch_id: order?.branch_id || null,
        restaurant_id: order?.restaurant_id || null,
        food_rating: score,
        delivery_rating: score,
        comment: null,
        created_at: new Date(),
      });
    } catch (e) {
      if (e.code !== 11000) console.error('[Rating] save error:', e.message);
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
            screenData: { order_number: order.order_number, order_id: orderId },
          },
        });
        return; // Flow sent successfully
      } catch (flowErr) {
        console.warn('[Rating] Flow send failed, falling back to buttons:', flowErr.message);
      }
    }

    // Fallback: simple 3-button rating
    await wa.sendButtons(pid, token, to, {
      header: '⭐ Rate Your Order',
      body: `How was your order #${order.order_number}?\n\nTap a rating below:`,
      footer: 'Your feedback helps improve quality',
      buttons: [
        { id: `RATE_${orderId}_5`, title: '⭐⭐⭐⭐⭐ Great!' },
        { id: `RATE_${orderId}_3`, title: '⭐⭐⭐ Average' },
        { id: `RATE_${orderId}_1`, title: '⭐ Poor' },
      ],
    });
  } catch (e) {
    console.error('[Rating] sendRatingRequest error:', e.message);
  }
};

// ─── STATUS UPDATE HANDLER ────────────────────────────────────
const handleStatus = async (status) => {
  if (status.status === 'failed') {
    console.error('[WA] Message delivery failed:', {
      recipient: status.recipient_id,
      error: status.errors?.[0]?.title,
      code: status.errors?.[0]?.code,
    });
  }

  // [WhatsApp2026] Track message status in message_statuses collection
  if (status.id && ['sent', 'delivered', 'read', 'failed'].includes(status.status)) {
    try {
      const msgTracking = require('../services/messageTracking');
      const errorInfo = status.status === 'failed' && status.errors?.[0]
        ? { code: status.errors[0].code, message: status.errors[0].title }
        : null;
      await msgTracking.updateStatus(status.id, status.status, errorInfo);
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
    console.error('[BSUID] handlePhoneShared error:', err.message);
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

  const order = await orderSvc.createOrder({
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
  } catch (etaErr) { console.warn('[ETA] calc error:', etaErr.message); }

  // Delivery record
  await col('deliveries').updateOne(
    { order_id: order.id },
    { $setOnInsert: { _id: newId(), order_id: order.id, status: 'pending', cost_rs: session.deliveryFeeRs || 0, created_at: new Date() } },
    { upsert: true }
  );

  // Payment
  try {
    await paymentSvc.createRazorpayOrder(fullOrder, customer);
    await wa.sendPaymentRequest(pid, token, to, { order: fullOrder, items: fullOrder.items });
    if (etaText) await wa.sendText(pid, token, to, `⏱ Estimated delivery: *${etaText}*`);
  } catch (waPayErr) {
    console.warn('[WA] WhatsApp Pay failed, falling back to payment link:', waPayErr.message);
    const link = await paymentSvc.createPaymentLink(fullOrder, customer);
    await wa.sendPaymentLink(pid, token, to, {
      orderNumber: order.order_number,
      total      : order.total_rs.toFixed(0),
      url        : link.url,
      expiryMins : link.expiryMins,
    });
    if (etaText) await wa.sendText(pid, token, to, `⏱ Estimated delivery: *${etaText}*`);
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

  // ── WhatsApp Flow response (has flow_token) ──
  if (responseData.flow_token) {
    await handleFlowResponse(responseData, customer, conv, waAccount);
    return;
  }

  // ── Delivery Address Flow response (action-based) ──
  if (responseData.action === 'select_address' || responseData.action === 'new_address') {
    await handleDeliveryFlowResponse(responseData, customer, conv, waAccount);
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
    if (branch?.catalog_id) {
      await wa.sendCatalog(pid, token, to, branch.catalog_id, `🍽️ Here's our menu from *${branch.name}*!`);
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

  console.log('[Flow] Delivery response:', JSON.stringify(responseData));

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
          flowData: {},
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
        console.error('[Flow] Maps URL parse failed:', e.message);
      }
    }

    // Fall back to manual address text
    if (!parsedAddress && responseData.manual_address?.trim()) {
      parsedAddress = { full_address: responseData.manual_address.trim(), source: 'manual' };
    }

    if (!parsedAddress) {
      await wa.sendText(pid, token, to, "We couldn't read your address. Please share your Google Maps location pin or try again.");
      return;
    }

    // Add extra details
    const label = responseData.address_label || 'Other';
    const landmark = responseData.address_line2 || null;

    // Save to customer addresses
    await addressSvc.saveAddress({ customer_id: customer.id, wa_phone: customer.wa_phone || customer.bsuid }, {
      label,
      fullAddress: parsedAddress.address || parsedAddress.full_address,
      landmark,
      flatNo: landmark,
      latitude: parsedAddress.lat || null,
      longitude: parsedAddress.lng || null,
      makeDefault: true,
    });

    await wa.sendText(pid, token, to, `📍 Delivering to: *${parsedAddress.address || parsedAddress.full_address}*\n\n🔍 Finding the nearest outlet...`);

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
  const catalogId = branch.catalogId || branch.catalog_id;
  const restaurantId = branch.restaurantId || branch.restaurant_id;

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
    catalogId,
    deliveryLat: address.latitude || address.lat || null,
    deliveryLng: address.longitude || address.lng || null,
    deliveryAddress: address.full_address || address.address || '',
  });

  // Resolve catalogId from restaurant if branch doesn't have one
  const effectiveCatalogId = catalogId || (await col('restaurants').findOne({ _id: restaurantId }))?.meta_catalog_id;

  if (effectiveCatalogId) {
    try {
      const { buildBranchMPMs } = require('../services/mpmBuilder');
      const mpms = await buildBranchMPMs(branch.id, restaurantId);
      console.log(`[Bot] Built ${mpms.length} MPM(s) for branch ${branch.name}`);
      if (mpms.length) {
        for (let i = 0; i < mpms.length; i++) {
          try {
            await wa.sendMPM(pid, token, to, effectiveCatalogId, mpms[i]);
          } catch (mpmSendErr) {
            console.error(`[Bot] MPM ${i+1} send failed:`, mpmSendErr.response?.data || mpmSendErr.message);
            if (i === 0) {
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
      console.error('[Bot] MPM build failed:', e.message);
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
    const foodRating     = parseInt(responseData.food_rating) || 0;
    const deliveryRating = parseInt(responseData.delivery_rating) || foodRating;
    const comment        = responseData.comment || responseData.feedback || null;

    if (!orderId || !foodRating) {
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
    try {
      await col('order_ratings').insertOne({
        _id: newId(),
        order_id: orderId,
        customer_id: customer.id,
        branch_id: order?.branch_id || null,
        restaurant_id: order?.restaurant_id || null,
        food_rating: foodRating,
        delivery_rating: deliveryRating,
        comment,
        source: 'whatsapp_flow',
        created_at: new Date(),
      });
    } catch (e) {
      if (e.code !== 11000) console.error('[Flow Rating] save error:', e.message);
    }

    const emoji = foodRating >= 4 ? '🎉' : '🙏';
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

    const doc = {
      _id: newId(),
      restaurant_id: restaurantId,
      branch_id: branchId,
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
      ).catch(e => console.warn('[Conversations] Upsert failed:', e.message));
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
    console.error('[Inbox] Failed to capture message:', err.message);
  }
};

module.exports = router;
module.exports.sendRatingRequest = sendRatingRequest;
module.exports.processWhatsAppWebhook = processWhatsAppWebhook;
