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
const db = require('../config/database');
const wa = require('../services/whatsapp');
const location = require('../services/location');
const orderSvc = require('../services/order');
const paymentSvc = require('../services/payment');
const addressSvc = require('../services/address');
const couponSvc = require('../services/coupon');

// ─── GET: WEBHOOK VERIFICATION ────────────────────────────────
// Meta calls this ONCE when you first configure the webhook.
// We must return the challenge token to prove we own this URL.
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Meta webhook verified!');
    return res.status(200).send(challenge); // Echo back the challenge
  }
  console.error('❌ Webhook verification failed. Check WEBHOOK_VERIFY_TOKEN in .env');
  res.sendStatus(403);
});

// ─── POST: INCOMING EVENTS ────────────────────────────────────
// Receives ALL WhatsApp events: messages, status updates, etc.
router.post('/', express.raw({ type: '*/*' }), async (req, res) => {
  // 1. RESPOND IMMEDIATELY — prevents Meta from retrying
  res.sendStatus(200);

  try {
    // 2. VERIFY SIGNATURE — prevents fake/spoofed webhooks
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

    // 3. LOG RAW WEBHOOK for analytics
    await logWebhook('whatsapp', body).catch(() => {});

    // 4. PROCESS EACH ENTRY
    // Meta may batch multiple events in one request
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        await processChange(change.value);
      }
    }
  } catch (err) {
    console.error('[WA Webhook] Processing error:', err.message);
  }
});

// ─── PROCESS A CHANGE OBJECT ──────────────────────────────────
// A "change" contains messages and/or status updates
const processChange = async (value) => {
  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId) return;

  // Lookup which restaurant this WA number belongs to
  const { rows: waAccounts } = await db.query(
    'SELECT * FROM whatsapp_accounts WHERE phone_number_id = $1 AND is_active = TRUE',
    [phoneNumberId]
  );
  if (!waAccounts.length) {
    console.warn('[WA] Unknown phone_number_id:', phoneNumberId);
    return;
  }
  const waAccount = waAccounts[0];

  // Handle incoming messages
  for (const msg of value.messages || []) {
    const senderPhone = msg.from;
    const senderName = value.contacts?.find((c) => c.wa_id === senderPhone)?.profile?.name;

    // Mark as read immediately (shows blue ticks)
    await wa.markRead(phoneNumberId, waAccount.access_token, msg.id);

    // Process message based on type
    try {
      await handleMessage(msg, senderPhone, senderName, waAccount);
    } catch (err) {
      console.error(`[WA] Error handling message from ${senderPhone}:`, err.message);
      // Send friendly error to customer
      await wa.sendText(
        phoneNumberId, waAccount.access_token, senderPhone,
        '😅 Something went wrong. Type *MENU* to start over.'
      );
    }
  }

  // Handle status updates (sent/delivered/read/failed)
  for (const status of value.statuses || []) {
    await handleStatus(status, waAccount.id);
  }
};

// ─── HANDLE INCOMING MESSAGE ──────────────────────────────────
// Routes to appropriate handler based on message type and conversation state
const handleMessage = async (msg, senderPhone, senderName, waAccount) => {
  const pid = waAccount.phone_number_id;
  const token = waAccount.access_token;

  // Get or create customer
  const customer = await orderSvc.getOrCreateCustomer(senderPhone, senderName);

  // Get or create conversation (holds our state machine)
  const conv = await orderSvc.getOrCreateConversation(customer.id, waAccount.id);

  // Route by message type
  if (msg.type === 'text') {
    await handleTextMessage(msg, customer, conv, waAccount);
  } else if (msg.type === 'location') {
    await handleLocationMessage(msg, customer, conv, waAccount);
  } else if (msg.type === 'order') {
    // Customer placed order from WhatsApp Catalog
    await handleCatalogOrder(msg, customer, conv, waAccount);
  } else if (msg.type === 'interactive') {
    // Customer tapped a button
    await handleInteractiveReply(msg, customer, conv, waAccount);
  } else {
    // Voice note, image, etc. — politely redirect
    await wa.sendText(pid, token, senderPhone,
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

  // Global commands — work from any state
  if (['HI', 'HELLO', 'HEY', 'START', 'MENU', 'ORDER'].includes(text)) {
    await orderSvc.setState(conv.id, 'GREETING');
    await wa.sendButtons(pid, token, to, {
      header: `🍔 Welcome to ${waAccount.display_name || 'GullyBite'}!`,
      body: `Hi ${customer.name || 'there'}! 👋\n\nI'm your food ordering assistant.\nI'll show you our menu and help you place an order right here in WhatsApp.\n\nWant to get started?`,
      footer: 'Takes less than 2 minutes to order',
      buttons: [
        { id: 'START_ORDER', title: '🛒 Order Now' },
        { id: 'TRACK_ORDER', title: '📦 Track Order' },
      ],
    });
    return;
  }

  if (['TRACK', 'STATUS', 'WHERE'].some((w) => text.includes(w))) {
    await sendTrackingInfo(customer, conv, waAccount);
    return;
  }

  if (text === 'CANCEL') {
    await handleCancelRequest(customer, conv, waAccount);
    return;
  }

  // ── Coupon code entry ─────────────────────────────────────────
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

    // Validate the coupon against this branch's restaurant
    const { rows: branchRes } = await db.query(
      'SELECT restaurant_id FROM branches WHERE id=$1', [session.branchId]
    );
    const restaurantId = branchRes[0]?.restaurant_id;
    const result = await couponSvc.validateCoupon(msg.text.body.trim(), restaurantId, session.subtotalRs);

    if (!result.valid) {
      await wa.sendText(pid, token, to, result.message);
      return; // stay in AWAITING_COUPON so they can retry
    }

    const couponData   = { id: result.coupon.id, code: result.coupon.code, discountRs: result.discountRs };
    const newTotal     = session.subtotalRs + session.deliveryFeeRs - result.discountRs;
    await orderSvc.setState(conv.id, 'ORDER_REVIEW', {
      ...session, coupon: couponData, discountRs: result.discountRs, totalRs: newTotal,
    });

    await wa.sendText(pid, token, to, result.message);
    const tempNum = `TEMP-${Date.now().toString().slice(-6)}`;
    await wa.sendOrderSummary(pid, token, to, {
      orderNumber: tempNum,
      items:       session.cart.map(i => ({ name: i.name, qty: i.qty, price: i.unitPriceRs.toFixed(0) })),
      subtotal:    session.subtotalRs.toFixed(0),
      deliveryFee: session.deliveryFeeRs.toFixed(0),
      total:       newTotal.toFixed(0),
      discount:    { code: couponData.code, amountRs: result.discountRs },
    });
    return;
  }

  // State-based responses
  if (conv.state === 'AWAITING_LOCATION') {
    await wa.sendLocationRequest(pid, token, to);
    return;
  }

  if (conv.state === 'SELECTING_ADDRESS') {
    // Re-show address list if they typed instead of tapping
    const addresses = await addressSvc.getAddresses(customer.wa_phone);
    if (addresses.length > 0) {
      await wa.sendAddressList(pid, token, to, addresses);
    } else {
      await orderSvc.setState(conv.id, 'AWAITING_LOCATION');
      await wa.sendLocationRequest(pid, token, to);
    }
    return;
  }

  // Default: show welcome
  await wa.sendText(pid, token, to,
    'Type *MENU* to browse our menu 🍽️\nType *TRACK* to track your order 📦'
  );
};

// ─── LOCATION MESSAGE HANDLER ─────────────────────────────────
// Customer shared their GPS → find nearest branch → send catalog
const handleLocationMessage = async (msg, customer, conv, waAccount) => {
  const pid = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to = customer.wa_phone;
  const { latitude, longitude, address, name: locName } = msg.location;

  await wa.sendText(pid, token, to, '🔍 Finding the nearest restaurant for you...');

  // Save location to customer record
  await db.query(
    'UPDATE customers SET last_lat=$1, last_lng=$2, last_address=$3 WHERE id=$4',
    [latitude, longitude, address || locName, customer.id]
  );

  // Find nearest deliverable branch
  const result = await location.findNearestBranch(latitude, longitude);

  if (!result.found) {
    await wa.sendText(pid, token, to, result.message);
    return;
  }

  const branch = result.branch;

  // Check if this location is already saved (avoid duplicate save prompts)
  const alreadySaved = await addressSvc.isNearSavedAddress(to, latitude, longitude);

  // Save branch + delivery location to session
  // Also stash pending save data if this is a new location
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

  // Tell customer which branch they'll get
  await wa.sendText(pid, token, to,
    `✅ Great! We'll deliver from:\n\n` +
    `🏪 *${branch.businessName} — ${branch.name}*\n` +
    `📍 ${branch.address || ''}\n` +
    `🚴 ${branch.distanceKm} km from you\n\n` +
    `Opening our menu for you...`
  );

  // Send catalog
  if (branch.catalogId) {
    await wa.sendCatalog(pid, token, to, branch.catalogId,
      `🍽️ Here's our menu from *${branch.name}*!\n\nBrowse and add items to your cart.`
    );
  } else {
    await sendTextMenu(pid, token, to, branch.id);
  }

  // If this is a new location, ask if customer wants to save it
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
// Customer placed an order from the WhatsApp in-app catalog
// msg.order.product_items = [{ product_retailer_id, quantity }]
const handleCatalogOrder = async (msg, customer, conv, waAccount) => {
  const pid = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to = customer.wa_phone;

  const session = conv.session_data || {};
  const branchId = session.branchId;

  if (!branchId) {
    // No branch selected yet — ask for location first
    await orderSvc.setState(conv.id, 'AWAITING_LOCATION');
    await wa.sendLocationRequest(pid, token, to);
    return;
  }

  const productItems = msg.order?.product_items || [];
  if (!productItems.length) return;

  // Build cart from catalog order
  const cart = await orderSvc.buildCartFromCatalogOrder(productItems, branchId);

  if (!cart.cart.length) {
    await wa.sendText(pid, token, to, '⚠️ Some items are no longer available. Please browse the menu again.');
    if (session.catalogId) await wa.sendCatalog(pid, token, to, session.catalogId);
    return;
  }

  // Check if Meta's native checkout included a coupon code
  const metaCouponCode = msg.order?.coupon_code;
  let couponData = session.coupon || null;
  if (metaCouponCode && !couponData) {
    const { rows: branchRes } = await db.query('SELECT restaurant_id FROM branches WHERE id=$1', [branchId]);
    const restaurantId = branchRes[0]?.restaurant_id;
    const result = await couponSvc.validateCoupon(metaCouponCode, restaurantId, cart.subtotalRs);
    if (result.valid) {
      couponData = { id: result.coupon.id, code: result.coupon.code, discountRs: result.discountRs };
      await wa.sendText(pid, token, to, result.message);
    }
  }

  const discountRs   = couponData?.discountRs || 0;
  const finalTotalRs = cart.subtotalRs + cart.deliveryFeeRs - discountRs;

  // Save cart to session
  await orderSvc.setState(conv.id, 'ORDER_REVIEW', {
    ...session,
    cart: cart.cart,
    subtotalRs:   cart.subtotalRs,
    deliveryFeeRs: cart.deliveryFeeRs,
    totalRs:      finalTotalRs,
    discountRs,
    coupon:       couponData,
  });

  // Generate temp order number for display (real one created on confirm)
  const tempOrderNum = `TEMP-${Date.now().toString().slice(-6)}`;

  // Show order summary with confirm/coupon/cancel buttons
  await wa.sendOrderSummary(pid, token, to, {
    orderNumber: tempOrderNum,
    items: cart.cart.map((i) => ({ name: i.name, qty: i.qty, price: i.unitPriceRs.toFixed(0) })),
    subtotal:    cart.subtotalRs.toFixed(0),
    deliveryFee: cart.deliveryFeeRs.toFixed(0),
    total:       finalTotalRs.toFixed(0),
    discount:    couponData ? { code: couponData.code, amountRs: discountRs } : null,
  });

  if (cart.unavailable.length > 0) {
    await wa.sendText(pid, token, to,
      `⚠️ Note: ${cart.unavailable.length} item(s) were unavailable and removed from your cart.`
    );
  }
};

// ─── INTERACTIVE REPLY HANDLER ────────────────────────────────
// Customer tapped a button
const handleInteractiveReply = async (msg, customer, conv, waAccount) => {
  const pid = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to = customer.wa_phone;

  const replyId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id;

  // ── Saved address selected from list ──────────────────────────
  if (replyId?.startsWith('ADDR_')) {
    const addressId = replyId.slice(5); // strip 'ADDR_'
    await handleSavedAddressSelected(addressId, customer, conv, waAccount);
    return;
  }

  switch (replyId) {
    case 'START_ORDER': {
      // Check for saved addresses first; fall back to GPS request
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

    case 'TRACK_ORDER':
      await sendTrackingInfo(customer, conv, waAccount);
      break;

    case 'CONFIRM_ORDER': {
      const session = conv.session_data || {};
      if (!session.cart?.length) {
        await wa.sendText(pid, token, to, 'Your cart is empty. Type *MENU* to browse.');
        return;
      }

      // Create the actual order in DB
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
      });

      const fullOrder = await orderSvc.getOrderDetails(order.id);

      // Create a delivery record immediately — 3PL details filled in after dispatch
      await db.query(
        `INSERT INTO deliveries (order_id, status, cost_rs)
         VALUES ($1, 'pending', $2)
         ON CONFLICT DO NOTHING`,
        [order.id, session.deliveryFeeRs || 0]
      );

      // PRIMARY: Native WhatsApp Pay via Razorpay
      // Creates a Razorpay order and sends an interactive order_details message.
      // Customer taps "Review and Pay" → UPI payment inside WhatsApp.
      // Falls back to a payment link if WhatsApp Pay is not enabled on this WABA.
      try {
        await paymentSvc.createRazorpayOrder(fullOrder, customer);
        await wa.sendPaymentRequest(pid, token, to, {
          order: fullOrder,
          items: fullOrder.items,
        });
      } catch (waPayErr) {
        console.warn('[WA] WhatsApp Pay failed, falling back to payment link:', waPayErr.message);
        const link = await paymentSvc.createPaymentLink(fullOrder, customer);
        await wa.sendPaymentLink(pid, token, to, {
          orderNumber: order.order_number,
          total      : order.total_rs.toFixed(0),
          url        : link.url,
          expiryMins : link.expiryMins,
        });
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

    case 'REMOVE_COUPON': {
      const session = conv.session_data || {};
      const updatedTotal = session.subtotalRs + session.deliveryFeeRs;
      await orderSvc.setState(conv.id, 'ORDER_REVIEW', {
        ...session, coupon: null, discountRs: 0, totalRs: updatedTotal,
      });
      const tempNum = `TEMP-${Date.now().toString().slice(-6)}`;
      await wa.sendText(pid, token, to, '🗑 Coupon removed.');
      await wa.sendOrderSummary(pid, token, to, {
        orderNumber: tempNum,
        items:       session.cart.map(i => ({ name: i.name, qty: i.qty, price: i.unitPriceRs.toFixed(0) })),
        subtotal:    session.subtotalRs.toFixed(0),
        deliveryFee: session.deliveryFeeRs.toFixed(0),
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
      // Clear pending save fields from session
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
// Customer picked one of their saved addresses from the list.
// We use its lat/lng to find the nearest branch and send catalog.
const handleSavedAddressSelected = async (addressId, customer, conv, waAccount) => {
  const pid   = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to    = customer.wa_phone;

  const { rows } = await db.query(
    `SELECT * FROM customer_addresses WHERE id = $1 AND wa_phone = $2`,
    [addressId, customer.wa_phone]
  );

  if (!rows.length || !rows[0].latitude) {
    // Address not found or has no coordinates — fall back to GPS
    await orderSvc.setState(conv.id, 'AWAITING_LOCATION');
    await wa.sendLocationRequest(pid, token, to);
    return;
  }

  const addr = rows[0];
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

// ─── TRACKING INFO ────────────────────────────────────────────
const sendTrackingInfo = async (customer, conv, waAccount) => {
  const { rows } = await db.query(
    `SELECT o.*, b.name AS branch_name,
            d.tracking_url, d.driver_name, d.driver_phone, d.estimated_mins
     FROM orders o
     JOIN branches b ON o.branch_id = b.id
     LEFT JOIN deliveries d ON d.order_id = o.id
     WHERE o.customer_id = $1
       AND o.status NOT IN ('DELIVERED','CANCELLED','REFUNDED')
     ORDER BY o.created_at DESC LIMIT 1`,
    [customer.id]
  );

  const pid = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to = customer.wa_phone;

  if (!rows.length) {
    await wa.sendText(pid, token, to, 'No active orders found. Type *MENU* to place a new order! 🍽️');
    return;
  }

  const order = rows[0];
  const statusEmoji = {
    PENDING_PAYMENT: '⏳ Awaiting payment',
    PAID: '✅ Payment received',
    CONFIRMED: '✅ Confirmed',
    PREPARING: '👨‍🍳 Being prepared',
    PACKED: '📦 Packed, awaiting pickup',
    DISPATCHED: '🚴 Out for delivery',
  };

  let trackingLine = '';
  if (order.status === 'DISPATCHED') {
    if (order.tracking_url) trackingLine += `\n🔗 Track: ${order.tracking_url}`;
    if (order.driver_name)   trackingLine += `\n🚴 Driver: ${order.driver_name}`;
    if (order.driver_phone)  trackingLine += ` · ${order.driver_phone}`;
    if (order.estimated_mins) trackingLine += `\n⏱ ETA: ~${order.estimated_mins} mins`;
  }

  await wa.sendText(pid, token, to,
    `*Order Tracker*\n\n` +
    `Order: #${order.order_number}\n` +
    `Status: ${statusEmoji[order.status] || order.status}\n` +
    `Amount: ₹${order.total_rs}\n` +
    `From: ${order.branch_name}` +
    trackingLine +
    `\n\n_We'll notify you at each step!_ 📱`
  );
};

// ─── CANCEL REQUEST ───────────────────────────────────────────
const handleCancelRequest = async (customer, conv, waAccount) => {
  const pid = waAccount.phone_number_id;
  const token = waAccount.access_token;
  const to = customer.wa_phone;

  const { rows } = await db.query(
    `SELECT * FROM orders WHERE customer_id=$1
     AND status IN ('PENDING_PAYMENT','PAID','CONFIRMED')
     ORDER BY created_at DESC LIMIT 1`,
    [customer.id]
  );

  if (!rows.length) {
    await wa.sendText(pid, token, to, 'No cancellable orders found.');
    return;
  }

  const order = rows[0];
  await orderSvc.updateStatus(order.id, 'CANCELLED', { cancelReason: 'Customer requested cancellation' });

  // Issue refund if already paid
  if (order.status === 'PAID') {
    await paymentSvc.issueRefund(order.id).catch((e) =>
      console.error('[Refund] Failed:', e.message)
    );
  }

  await wa.sendStatusUpdate(pid, token, to, 'CANCELLED', { orderNumber: order.order_number });
};

// ─── TEXT MENU FALLBACK ───────────────────────────────────────
// Used when catalog_id isn't set up yet
const sendTextMenu = async (pid, token, to, branchId) => {
  const { rows } = await db.query(
    `SELECT mi.name, mi.price_paise, mc.name AS cat
     FROM menu_items mi
     LEFT JOIN menu_categories mc ON mi.category_id = mc.id
     WHERE mi.branch_id=$1 AND mi.is_available=TRUE
     ORDER BY mc.sort_order, mi.sort_order LIMIT 30`,
    [branchId]
  );

  if (!rows.length) {
    await wa.sendText(pid, token, to, 'Menu is being updated. Please try again in a few minutes!');
    return;
  }

  // Group by category
  const grouped = rows.reduce((acc, item) => {
    const cat = item.cat || 'Menu';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(item);
    return acc;
  }, {});

  let menuText = '🍽️ *Our Menu*\n\n';
  for (const [cat, items] of Object.entries(grouped)) {
    menuText += `*${cat}*\n`;
    items.forEach((i) => { menuText += `• ${i.name} — ₹${i.price_paise / 100}\n`; });
    menuText += '\n';
  }
  menuText += '_To order, reply with items like: "2 Butter Chicken, 1 Naan"_';

  await wa.sendText(pid, token, to, menuText);
};

// ─── STATUS UPDATE HANDLER ────────────────────────────────────
// When our sent messages are delivered/read/failed
const handleStatus = async (status, waAccountId) => {
  // Log failures — useful for debugging delivery issues
  if (status.status === 'failed') {
    console.error('[WA] Message delivery failed:', {
      recipient: status.recipient_id,
      error: status.errors?.[0]?.title,
    });
  }
  // Could update message delivery status in DB here for analytics
};

// ─── LOG WEBHOOK ──────────────────────────────────────────────
const logWebhook = async (source, payload) => {
  const phoneNumberId = payload.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
  await db.query(
    `INSERT INTO webhook_logs (source, event_type, phone_number_id, payload)
     VALUES ($1, $2, $3, $4)`,
    [source, 'messages', phoneNumberId, JSON.stringify(payload)]
  );
};

module.exports = router;