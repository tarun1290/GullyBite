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
const orderSvc = require('../services/order');
const paymentSvc = require('../services/payment');
const addressSvc = require('../services/address');
const couponSvc = require('../services/coupon');
const etaSvc = require('../services/eta');
const loyaltySvc = require('../services/loyalty');
const notify = require('../services/notify');
const { getNextRetryAt, retryDefaults } = require('../utils/retry');
const { waMessageLimiter, waOrderLimiter, abuseDetector, isPhoneBlocked, extractSenderPhone, extractPhoneNumberId } = require('../middleware/rateLimit');

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

  let logId = null;
  try {
    const sig = req.headers['x-hub-signature-256']?.split('sha256=')[1];
    const expected = crypto
      .createHmac('sha256', process.env.WEBHOOK_APP_SECRET)
      .update(req.body)
      .digest('hex');

    if (!sig || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
      console.warn('[WA Webhook] ⚠️ Invalid signature — ignoring');
      return;
    }

    const body = JSON.parse(req.body);
    if (body.object !== 'whatsapp_business_account') return;

    // ── ABUSE CHECK: blocked phone ──
    const senderPhone = extractSenderPhone(body);
    if (senderPhone) {
      const blocked = await isPhoneBlocked(senderPhone);
      if (blocked) {
        console.warn(`[WA Webhook] Blocked phone dropped: ${senderPhone}`);
        return; // silently drop — already returned 200
      }

      // ── RATE LIMIT CHECK ──
      const { allowed } = waMessageLimiter.isAllowed(senderPhone);
      if (!allowed) {
        console.warn(`[RateLimit] WhatsApp message rate limited: ${senderPhone}`);
        // Record violation for abuse detection
        abuseDetector.recordViolation(senderPhone).catch(() => {});
        // Log rate-limited event
        await col('webhook_logs').insertOne({
          _id: newId(),
          source: 'whatsapp',
          event_type: 'rate_limited',
          phone_number_id: extractPhoneNumberId(body),
          payload: { from: senderPhone, note: 'Rate limited — payload omitted' },
          processed: true,
          error_message: `Rate limited: ${senderPhone}`,
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
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;
      await processChange(change.value);
    }
  }
};

// ─── PROCESS A CHANGE OBJECT ──────────────────────────────────
const processChange = async (value) => {
  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId) return;

  const waAccount = await col('whatsapp_accounts').findOne({ phone_number_id: phoneNumberId, is_active: true });
  if (!waAccount) {
    console.warn('[WA] Unknown phone_number_id:', phoneNumberId);
    return;
  }

  for (const msg of value.messages || []) {
    const senderPhone = msg.from;
    const senderName = value.contacts?.find(c => c.wa_id === senderPhone)?.profile?.name;

    await wa.markRead(phoneNumberId, waAccount.access_token, msg.id);

    try {
      await handleMessage(msg, senderPhone, senderName, waAccount);
    } catch (err) {
      console.error(`[WA] Error handling message from ${senderPhone}:`, err.message);
      await wa.sendText(
        phoneNumberId, waAccount.access_token, senderPhone,
        '😅 Something went wrong. Type *MENU* to start over.'
      );
    }
  }

  for (const status of value.statuses || []) {
    await handleStatus(status);
  }
};

// ─── HANDLE INCOMING MESSAGE ──────────────────────────────────
const handleMessage = async (msg, senderPhone, senderName, waAccount) => {
  const customer = await orderSvc.getOrCreateCustomer(senderPhone, senderName);
  const conv = await orderSvc.getOrCreateConversation(customer.id, String(waAccount._id));

  if (msg.type === 'text') {
    await handleTextMessage(msg, customer, conv, waAccount);
  } else if (msg.type === 'location') {
    await handleLocationMessage(msg, customer, conv, waAccount);
  } else if (msg.type === 'order') {
    await handleCatalogOrder(msg, customer, conv, waAccount);
  } else if (msg.type === 'interactive') {
    await handleInteractiveReply(msg, customer, conv, waAccount);
  } else {
    await wa.sendText(waAccount.phone_number_id, waAccount.access_token, senderPhone,
      '👋 I can only handle text and orders. Type *MENU* to browse our menu!'
    );
  }
};

// ─── TEXT MESSAGE HANDLER ─────────────────────────────────────
const handleTextMessage = async (msg, customer, conv, waAccount) => {
  const pid = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to = customer.wa_phone;
  const text = msg.text.body.trim().toUpperCase();

  if (['HI', 'HELLO', 'HEY', 'START', 'MENU', 'ORDER'].includes(text)) {
    await orderSvc.setState(conv.id, 'GREETING');
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
    await orderSvc.setState(conv.id, 'GREETING', {});
    await wa.sendText(pid, token, to, comment ? 'Thanks for your feedback! We\'ll work on improving. 🙏' : 'No worries — thanks for rating! 🎉');
    return;
  }

  // ── AWAITING_POINTS_REDEEM: customer types point amount ──
  if (conv.state === 'AWAITING_POINTS_REDEEM') {
    const session = conv.session_data || {};
    const branch = await col('branches').findOne({ _id: session.branchId });
    const restaurantId = branch?.restaurant_id;
    if (!restaurantId) { await wa.sendText(pid, token, to, 'Something went wrong. Type *MENU* to start over.'); return; }

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
    const addresses = await addressSvc.getAddresses(customer.wa_phone);
    if (addresses.length > 0) {
      await wa.sendAddressList(pid, token, to, addresses);
    } else {
      await orderSvc.setState(conv.id, 'AWAITING_LOCATION');
      await wa.sendLocationRequest(pid, token, to);
    }
    return;
  }

  await wa.sendText(pid, token, to,
    'Type *MENU* to browse our menu 🍽️\nType *TRACK* to track your order 📦'
  );
};

// ─── LOCATION MESSAGE HANDLER ─────────────────────────────────
const handleLocationMessage = async (msg, customer, conv, waAccount) => {
  const pid = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to = customer.wa_phone;
  const { latitude, longitude, address, name: locName } = msg.location;

  await wa.sendText(pid, token, to, '🔍 Finding the nearest restaurant for you...');

  await col('customers').updateOne(
    { _id: customer.id },
    { $set: { last_lat: latitude, last_lng: longitude, last_address: address || locName || null } }
  );

  const result = await location.findNearestBranch(latitude, longitude);

  if (!result.found) {
    await wa.sendText(pid, token, to, result.message);
    return;
  }

  const branch = result.branch;
  const alreadySaved = await addressSvc.isNearSavedAddress(to, latitude, longitude);

  // ── REORDER: if customer came from "REORDER N", restore their cart ──
  const session = conv.session_data || {};
  if (session.reorderCart?.length) {
    const reorderCart = session.reorderCart;
    const subtotalRs  = reorderCart.reduce((s, i) => s + (i.lineTotalRs || i.unitPriceRs * i.qty), 0);

    // Dynamic delivery fee + charge breakdown
    const { calculateDynamicDeliveryFee } = require('../services/dynamicPricing');
    const dynamicResult = await calculateDynamicDeliveryFee(branch.id, latitude, longitude);

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

    await orderSvc.setState(conv.id, 'ORDER_REVIEW', {
      branchId       : branch.id,
      branchName     : branch.name,
      catalogId      : branch.catalogId,
      deliveryLat    : latitude,
      deliveryLng    : longitude,
      deliveryAddress: address || locName || 'Your location',
      cart           : reorderCart,
      subtotalRs,
      deliveryFeeRs  : charges.customer_delivery_rs,
      totalRs        : charges.customer_total_rs,
      discountRs     : 0,
      charges,
      deliveryFeeBreakdown: dynamicResult.breakdown,
      dynamicPricing:       dynamicResult.dynamic,
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

  await orderSvc.setState(conv.id, 'SHOWING_CATALOG', {
    branchId: branch.id,
    branchName: branch.name,
    catalogId: branch.catalogId,
    deliveryLat: latitude,
    deliveryLng: longitude,
    deliveryAddress: address || locName || 'Your location',
    ...(alreadySaved ? {} : {
      pendingSaveLat    : latitude,
      pendingSaveLng    : longitude,
      pendingSaveAddress: address || locName || null,
    }),
  });

  await wa.sendText(pid, token, to,
    `✅ Great! We'll deliver from:\n\n` +
    `🏪 *${branch.businessName} — ${branch.name}*\n` +
    `📍 ${branch.address || ''}\n` +
    `🚴 ${branch.distanceKm} km from you\n\n` +
    `Opening our menu for you...`
  );

  if (branch.catalogId) {
    await wa.sendCatalog(pid, token, to, branch.catalogId,
      `🍽️ Here's our menu from *${branch.name}*!\n\nBrowse and add items to your cart.`
    );
  } else {
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
  const to = customer.wa_phone;

  const session = conv.session_data || {};
  const branchId = session.branchId;

  if (!branchId) {
    await orderSvc.setState(conv.id, 'AWAITING_LOCATION');
    await wa.sendLocationRequest(pid, token, to);
    return;
  }

  const productItems = msg.order?.product_items || [];
  if (!productItems.length) return;

  const cart = await orderSvc.buildCartFromCatalogOrder(productItems, branchId, session.deliveryLat, session.deliveryLng);

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
  });

  const tempOrderNum = `TEMP-${Date.now().toString().slice(-6)}`;

  // Build surge/dynamic info text for order summary
  let dynamicNote = null;
  if (cart.dynamicPricing && cart.deliveryFeeBreakdown) {
    const bd = cart.deliveryFeeBreakdown;
    const parts = [];
    if (bd.distanceKm !== null) parts.push(`📍 ${bd.distanceKm} km`);
    if (bd.effectiveMultiplier > 1.0) parts.push(`⚡ ${bd.effectiveMultiplier}x${bd.reason ? ' (' + bd.reason + ')' : ''}`);
    if (bd.capped) parts.push('🔒 Fee capped');
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
  const to = customer.wa_phone;

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

  switch (replyId) {
    case 'START_ORDER': {
      const addresses = await addressSvc.getAddresses(customer.wa_phone);
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

      // Order creation rate limit — 5 per 10 minutes
      const orderRateCheck = waOrderLimiter.isAllowed(customer.wa_phone);
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
        waPhone      : customer.wa_phone,
        charges      : session.charges || null,
        deliveryFeeBreakdown: session.deliveryFeeBreakdown || null,
      });

      const fullOrder = await orderSvc.getOrderDetails(order.id);

      // Calculate and store ETA
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

      // Create a delivery record immediately
      await col('deliveries').updateOne(
        { order_id: order.id },
        { $setOnInsert: { _id: newId(), order_id: order.id, status: 'pending', cost_rs: session.deliveryFeeRs || 0, created_at: new Date() } },
        { upsert: true }
      );

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
      if (!restaurantId) { await wa.sendText(pid, token, to, 'Could not identify restaurant. Type *MENU* to start over.'); break; }
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
        const existingAddrs = await addressSvc.getAddresses(customer.wa_phone);
        await addressSvc.saveAddress(customer.wa_phone, {
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
  const to    = customer.wa_phone;

  const addr = await col('customer_addresses').findOne({ _id: addressId, wa_phone: customer.wa_phone });

  if (!addr || !addr.latitude) {
    await orderSvc.setState(conv.id, 'AWAITING_LOCATION');
    await wa.sendLocationRequest(pid, token, to);
    return;
  }

  await wa.sendText(pid, token, to,
    `📍 Using *${addr.label}*${addr.full_address ? `: ${addr.full_address}` : ''}\n\n🔍 Finding nearest restaurant...`
  );

  const result = await location.findNearestBranch(addr.latitude, addr.longitude);
  if (!result.found) {
    await wa.sendText(pid, token, to, result.message);
    return;
  }

  const branch = result.branch;
  await orderSvc.setState(conv.id, 'SHOWING_CATALOG', {
    branchId       : branch.id,
    branchName     : branch.name,
    catalogId      : branch.catalogId,
    deliveryLat    : addr.latitude,
    deliveryLng    : addr.longitude,
    deliveryAddress: addr.full_address || addr.label,
  });

  await wa.sendText(pid, token, to,
    `✅ Delivering from:\n\n` +
    `🏪 *${branch.businessName} — ${branch.name}*\n` +
    `📍 ${branch.address || ''}\n` +
    `🚴 ${branch.distanceKm} km from you\n\n` +
    `Opening our menu...`
  );

  if (branch.catalogId) {
    await wa.sendCatalog(pid, token, to, branch.catalogId,
      `🍽️ Here's our menu from *${branch.name}*!`
    );
  } else {
    await sendTextMenu(pid, token, to, branch.id);
  }
};

// ─── ORDER HISTORY ────────────────────────────────────────────
const sendOrderHistory = async (customer, waAccount) => {
  const pid   = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to    = customer.wa_phone;

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
  const to    = customer.wa_phone;

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
    await wa.sendText(waAccount.phone_number_id, waAccount.access_token, customer.wa_phone,
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
  const to    = customer.wa_phone;

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
  const to = customer.wa_phone;

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
  const to = customer.wa_phone;

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
  const to    = customer.wa_phone;

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
  const to    = customer.wa_phone;

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
    await wa.sendText(pid, token, to, 'Thanks for your feedback! 🎉 We\'re glad you enjoyed it!');
    await orderSvc.setState(conv.id, 'GREETING', {});
  }
};

// ─── SEND RATING REQUEST (called after delivery) ─────────────
const sendRatingRequest = async (orderId, pid, token, to) => {
  try {
    const order = await col('orders').findOne({ _id: orderId });
    if (!order) return;
    const existing = await col('order_ratings').findOne({ order_id: orderId });
    if (existing) return; // already rated
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
    });
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

module.exports = router;
module.exports.sendRatingRequest = sendRatingRequest;
module.exports.processWhatsAppWebhook = processWhatsAppWebhook;
