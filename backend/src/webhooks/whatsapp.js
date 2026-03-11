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
  res.sendStatus(200);

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

    const logId = await logWebhook('whatsapp', body).catch(() => null);

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        await processChange(change.value);
      }
    }

    // Mark webhook as processed
    if (logId) {
      await col('webhook_logs').updateOne(
        { _id: logId },
        { $set: { processed: true, processed_at: new Date() } }
      ).catch(() => {});
    }
  } catch (err) {
    console.error('[WA Webhook] Processing error:', err.message);
  }
});

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

  const cart = await orderSvc.buildCartFromCatalogOrder(productItems, branchId);

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
  });

  const tempOrderNum = `TEMP-${Date.now().toString().slice(-6)}`;

  await wa.sendOrderSummary(pid, token, to, {
    orderNumber: tempOrderNum,
    items: cart.cart.map(i => ({ name: i.name, qty: i.qty, price: i.unitPriceRs.toFixed(0) })),
    charges,
    subtotal:    cart.subtotalRs.toFixed(0),
    deliveryFee: (charges ? charges.customer_delivery_rs : cart.deliveryFeeRs).toFixed(0),
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

    case 'TRACK_ORDER':
      await sendTrackingInfo(customer, conv, waAccount);
      break;

    case 'CONFIRM_ORDER': {
      const session = conv.session_data || {};
      if (!session.cart?.length) {
        await wa.sendText(pid, token, to, 'Your cart is empty. Type *MENU* to browse.');
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
      });

      const fullOrder = await orderSvc.getOrderDetails(order.id);

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

  await wa.sendText(pid, token, to,
    `*Order Tracker*\n\n` +
    `Order: #${order.order_number}\n` +
    `Status: ${statusEmoji[order.status] || order.status}\n` +
    `Amount: ₹${order.total_rs}\n` +
    `From: ${branch?.name || ''}` +
    trackingLine +
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
  });
  return id;
};

module.exports = router;
