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

  // State-based responses
  if (conv.state === 'AWAITING_LOCATION') {
    // They sent text instead of location — prompt again
    await wa.sendLocationRequest(pid, token, to);
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

  // Save branch selection and delivery location to conversation
  await orderSvc.setState(conv.id, 'SHOWING_CATALOG', {
    branchId: branch.id,
    branchName: branch.name,
    deliveryLat: latitude,
    deliveryLng: longitude,
    deliveryAddress: address || locName || 'Your location',
  });

  // Tell customer which branch they'll get
  await wa.sendText(pid, token, to,
    `✅ Great! We'll deliver from:\n\n` +
    `🏪 *${branch.businessName} — ${branch.name}*\n` +
    `📍 ${branch.address || ''}\n` +
    `🚴 ${branch.distanceKm} km from you\n\n` +
    `Opening our menu for you...`
  );

  // Send the WhatsApp Catalog (in-app shopping experience)
  if (branch.catalogId) {
    await wa.sendCatalog(pid, token, to, branch.catalogId);
  } else {
    // Fallback: send text-based menu if catalog not set up yet
    await sendTextMenu(pid, token, to, branch.id);
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
    await wa.sendCatalog(pid, token, to, waAccount.catalog_id);
    return;
  }

  // Save cart to session
  await orderSvc.setState(conv.id, 'ORDER_REVIEW', {
    ...session,
    cart: cart.cart,
    subtotalRs: cart.subtotalRs,
    deliveryFeeRs: cart.deliveryFeeRs,
    totalRs: cart.totalRs,
  });

  // Generate temp order number for display (real one created on confirm)
  const tempOrderNum = `TEMP-${Date.now().toString().slice(-6)}`;

  // Show order summary with confirm/cancel buttons
  await wa.sendOrderSummary(pid, token, to, {
    orderNumber: tempOrderNum,
    items: cart.cart.map((i) => ({ name: i.name, qty: i.qty, price: i.unitPriceRs.toFixed(0) })),
    subtotal: cart.subtotalRs.toFixed(0),
    deliveryFee: cart.deliveryFeeRs.toFixed(0),
    total: cart.totalRs.toFixed(0),
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

  switch (replyId) {
    case 'START_ORDER':
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
        convId: conv.id,
        customerId: customer.id,
        branchId: session.branchId,
        cart: session.cart,
        subtotalRs: session.subtotalRs,
        deliveryFeeRs: session.deliveryFeeRs,
        totalRs: session.totalRs,
        deliveryAddress: session.deliveryAddress,
        deliveryLat: session.deliveryLat,
        deliveryLng: session.deliveryLng,
      });

      // Get full order for payment link creation
      const fullOrder = await orderSvc.getOrderDetails(order.id);

      // Create Razorpay payment link
      const link = await paymentSvc.createPaymentLink(fullOrder, customer);

      // Send payment link via WhatsApp
      await wa.sendPaymentLink(pid, token, to, {
        orderNumber: order.order_number,
        total: order.total_rs.toFixed(0),
        url: link.url,
        expiryMins: link.expiryMins,
      });
      break;
    }

    case 'CANCEL_ORDER':
      await orderSvc.setState(conv.id, 'GREETING', {});
      await wa.sendText(pid, token, to, '❌ Order cancelled. Type *MENU* whenever you\'re ready! 😊');
      break;

    default:
      await wa.sendText(pid, token, to, 'Type *MENU* to start ordering or *TRACK* to check your order.');
  }
};

// ─── TRACKING INFO ────────────────────────────────────────────
const sendTrackingInfo = async (customer, conv, waAccount) => {
  const { rows } = await db.query(
    `SELECT o.*, b.name AS branch_name
     FROM orders o
     JOIN branches b ON o.branch_id = b.id
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

  await wa.sendText(pid, token, to,
    `*Order Tracker*\n\n` +
    `Order: #${order.order_number}\n` +
    `Status: ${statusEmoji[order.status] || order.status}\n` +
    `Amount: ₹${order.total_rs}\n` +
    `From: ${order.branch_name}\n\n` +
    `_We'll notify you at each step!_ 📱`
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