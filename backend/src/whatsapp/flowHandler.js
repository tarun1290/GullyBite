// src/whatsapp/flowHandler.js
// Phase 1: WhatsApp conversational flow state machine.
//
// This file is ADDITIVE. It is only invoked from src/webhooks/whatsapp.js
// when PHASE1_FLOW_ENABLED=true. When disabled (the default), the
// legacy flowManager / handlers remain the sole path. This lets us roll
// the new UX out one tenant at a time by allow-listing phone_number_ids.
//
// Design principles:
//
//   • State lives on the `conversations` row (per customer per tenant).
//     We never keep it in-memory — serverless invocations are stateless.
//   • Every transition is idempotent: handling the same inbound message
//     twice must not double-spend or duplicate sends. The webhook layer
//     already dedups via processed_events; this module is safe under
//     replays anyway.
//   • The handler never throws out; errors become a graceful
//     "Something went wrong" reply. Throwing would surface 5xx to Meta
//     which triggers aggressive retries.
//
// Flows currently implemented (a subset of the full plan; others will
// fall through to legacy until migrated):
//
//   IDLE           — greet, ask for name if unknown, send HOME menu
//   AWAIT_NAME     — capture the customer's display name
//   HOME           — main menu buttons (Order / Reorder / My Orders)
//   CART           — view cart, checkout, clear
//   AWAIT_ADDRESS  — list saved addresses (or request location)
//   CONFIRM        — summary + confirm-pay trigger
//
// The BROWSE_* / PAYMENT states intentionally delegate to the legacy
// catalog + payment services — the new flow ADDS state management
// around them; it does not replace catalog send/checkout.

'use strict';

const { col } = require('../config/database');
const wa = require('../services/whatsapp');
const customerSvc = require('../services/customer.service');
const profileSvc = require('../services/customerProfile.service');
const cartSvc = require('../services/cart.service');
const reorderSvc = require('../services/reorder.service');
const addressBook = require('../services/addressBook.service');
const orderCreateSvc = require('../services/orderCreate.service');
const paymentSvc = require('../services/payment');
const Brand = require('../models/Brand');
const log = require('../utils/logger').child({ component: 'flowHandler' });

// ─── STATES ───────────────────────────────────────────────────
const STATE = Object.freeze({
  IDLE:            'IDLE',
  AWAIT_NAME:      'AWAIT_NAME',
  HOME:            'HOME',
  BROWSE_CATEGORY: 'BROWSE_CATEGORY',
  CART:            'CART',
  AWAIT_ADDRESS:   'AWAIT_ADDRESS',
  CONFIRM:         'CONFIRM',
  AWAIT_PAYMENT:   'AWAIT_PAYMENT',
});

// ─── TENANT RESOLUTION ────────────────────────────────────────
// phone_number_id → (brand, restaurant). Brand.findByPhoneNumberId is
// the primary path; whatsapp_accounts.phone_number_id is the fallback
// for single-brand tenants that never opted into the brand layer.
async function _resolveTenant(phoneNumberId) {
  if (!phoneNumberId) return null;
  let brand = null;
  try { brand = await Brand.findByPhoneNumberId(phoneNumberId); } catch (_) { brand = null; }
  if (brand) {
    const biz = await col('restaurants').findOne(
      { _id: String(brand.business_id) },
      { projection: { business_name: 1, meta_catalog_id: 1 } }
    );
    return {
      brand_id: String(brand._id),
      restaurant_id: String(brand.business_id),
      restaurant_name: biz?.business_name || brand.name || null,
      phone_number_id: phoneNumberId,
      access_token: null,  // resolved at send-time by wa.sendMessage via brand lookup
      catalog_id: brand.catalog_id || biz?.meta_catalog_id || null,
    };
  }
  const acct = await col('whatsapp_accounts').findOne({ phone_number_id: String(phoneNumberId) });
  if (!acct) return null;
  const biz = await col('restaurants').findOne(
    { _id: acct.restaurant_id },
    { projection: { business_name: 1, meta_catalog_id: 1, whatsapp_access_token: 1 } }
  );
  return {
    brand_id: null,
    restaurant_id: String(acct.restaurant_id),
    restaurant_name: biz?.business_name || null,
    phone_number_id: phoneNumberId,
    access_token: biz?.whatsapp_access_token || process.env.META_ACCESS_TOKEN || null,
    catalog_id: acct.catalog_id || biz?.meta_catalog_id || null,
  };
}

// ─── CONVERSATION (state persistence) ─────────────────────────
async function _getOrCreateConversation(restaurantId, customerId, waAccountId) {
  const now = new Date();
  const res = await col('conversations').findOneAndUpdate(
    { restaurant_id: String(restaurantId), customer_id: String(customerId) },
    {
      $setOnInsert: {
        _id: require('../config/database').newId(),
        restaurant_id: String(restaurantId),
        customer_id: String(customerId),
        wa_account_id: waAccountId || null,
        state: STATE.IDLE,
        session_data: {},
        is_active: true,
        created_at: now,
      },
      $set: { last_msg_at: now, is_active: true },
    },
    { upsert: true, returnDocument: 'after' }
  );
  return res?.value || col('conversations').findOne({
    restaurant_id: String(restaurantId), customer_id: String(customerId),
  });
}

async function _setState(convoId, state, sessionPatch) {
  const $set = { state, last_msg_at: new Date() };
  if (sessionPatch) $set.session_data = sessionPatch;
  await col('conversations').updateOne({ _id: convoId }, { $set });
}

// ─── SEND HELPERS (brand-aware) ───────────────────────────────
function _send(tenant, to, body) {
  return wa.sendMessage({
    brand_id: tenant.brand_id,
    business_id: tenant.restaurant_id,
    phone_number_id: tenant.phone_number_id,
    access_token: tenant.access_token,
    to,
    body,
    allow_default_fallback: true,
  });
}

function _textBody(text) {
  return { type: 'text', text: { body: text, preview_url: false } };
}

function _buttonsBody({ header, body, buttons }) {
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      ...(header && { header: { type: 'text', text: header } }),
      body: { text: body },
      action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.substring(0, 20) } })) },
    },
  };
}

function _listBody({ header, body, buttonText, sections }) {
  return {
    type: 'interactive',
    interactive: {
      type: 'list',
      ...(header && { header: { type: 'text', text: header } }),
      body: { text: body },
      action: { button: (buttonText || 'Choose').substring(0, 20), sections },
    },
  };
}

// ─── VIEWS ────────────────────────────────────────────────────
function _renderCart(cart) {
  if (!cart || !cart.items?.length) return '🛒 Your cart is empty.';
  const lines = cart.items.map((it) => `• ${it.qty}× ${it.name} — ₹${(Number(it.unit_price_rs) || 0).toFixed(2)}`);
  lines.push(`\nSubtotal: ₹${(Number(cart.subtotal_rs) || 0).toFixed(2)}`);
  return `🛒 *Your cart*\n\n${lines.join('\n')}`;
}

async function _sendHome(tenant, to, customerName) {
  const hi = customerName ? `Hi ${customerName}! 👋` : 'Hi! 👋';
  return _send(tenant, to, _buttonsBody({
    body: `${hi}\n\nWhat would you like to do?`,
    buttons: [
      { id: 'FLOW_ORDER',   title: '🍽️ Order now' },
      { id: 'FLOW_REORDER', title: '🔄 Reorder' },
      { id: 'FLOW_ORDERS',  title: '📦 My orders' },
    ],
  }));
}

// ─── INBOUND EXTRACTORS ───────────────────────────────────────
function _extractText(msg) {
  if (!msg) return null;
  if (msg.type === 'text') return (msg.text?.body || '').trim() || null;
  if (msg.type === 'interactive') {
    const ir = msg.interactive;
    if (ir?.type === 'button_reply') return ir.button_reply?.id || null;
    if (ir?.type === 'list_reply')   return ir.list_reply?.id || null;
  }
  return null;
}

// ─── STATE HANDLERS ───────────────────────────────────────────
async function _handleIdleOrHome(tenant, convo, customer, from, input) {
  if (!customer.name) {
    await _send(tenant, from, _textBody('Welcome! What name should I save you as?'));
    await _setState(convo._id, STATE.AWAIT_NAME, { ...convo.session_data });
    return;
  }
  // Route HOME button replies.
  if (input === 'FLOW_ORDER') {
    // Send the brand's/tenant's Meta commerce catalog. catalog_message
    // uses the WABA-connected catalog (Meta ignores a passed catalog_id
    // in the payload), but we still require a catalog_id to be known so
    // we don't send a broken message for tenants that never hooked up
    // Meta Commerce. If none, fall back to a friendly text + HOME.
    if (!tenant.catalog_id) {
      // No catalog wired up for this tenant. Do NOT silently bounce back
      // to HOME — surface the situation clearly and give the customer
      // explicit alternatives (reorder a past order, view recent orders,
      // or ask staff). Leave state where it is so they choose.
      const buttons = [
        { type: 'reply', reply: { id: 'FLOW_REORDER', title: '🔄 Reorder' } },
        { type: 'reply', reply: { id: 'FLOW_ORDERS',  title: '📦 My orders' } },
      ];
      await _send(tenant, from, _buttonsBody({
        body:
          `Sorry ${customer.name || 'there'} — our digital menu isn't set up yet at ${tenant.restaurant_name || 'this restaurant'}.\n\n` +
          `While we get it connected, you can reorder a previous order or reach out to our team.`,
        buttons,
      }));
      return;
    }
    await _send(tenant, from, {
      type: 'interactive',
      interactive: {
        type: 'catalog_message',
        body: { text: '🍽️ Here is our menu! Browse and add items to your cart.' },
        footer: { text: 'Tap any item to view details and add to cart' },
        action: { name: 'catalog_message', parameters: {} },
      },
    });
    await _setState(convo._id, STATE.BROWSE_CATEGORY, convo.session_data);
    return;
  }
  if (input === 'FLOW_REORDER') {
    const recent = await reorderSvc.lastOrders(tenant.restaurant_id, customer._id, { limit: 5 });
    if (!recent.length) {
      await _send(tenant, from, _textBody("You don't have any past orders yet. Tap *Order now* from the menu."));
      await _sendHome(tenant, from, customer.name);
      return;
    }
    const sections = [{
      title: 'Recent orders',
      rows: recent.slice(0, 10).map((o) => ({
        id: `REORDER_${o._id}`,
        title: `#${o.order_number || o._id.slice(0, 6)} · ₹${Number(o.total_rs).toFixed(0)}`,
        description: (o.items || []).slice(0, 3).map((it) => it.name).join(', ').slice(0, 70),
      })),
    }];
    await _send(tenant, from, _listBody({ body: 'Pick an order to reorder:', buttonText: 'Choose', sections }));
    await _setState(convo._id, STATE.HOME, convo.session_data);
    return;
  }
  if (input === 'FLOW_ORDERS') {
    const recent = await reorderSvc.lastOrders(tenant.restaurant_id, customer._id, { limit: 5 });
    if (!recent.length) {
      await _send(tenant, from, _textBody('No orders yet.'));
    } else {
      const lines = recent.map((o) => `#${o.order_number || o._id.slice(0, 6)} · ${o.status} · ₹${Number(o.total_rs).toFixed(0)}`);
      await _send(tenant, from, _textBody(`📦 *Recent orders*\n\n${lines.join('\n')}`));
    }
    await _sendHome(tenant, from, customer.name);
    return;
  }
  if (typeof input === 'string' && input.startsWith('REORDER_')) {
    const orderId = input.slice('REORDER_'.length);
    try {
      const { cart, added, skipped } = await reorderSvc.reorder(tenant.restaurant_id, customer._id, orderId);
      let msg = `Added ${added.length} item${added.length === 1 ? '' : 's'} to your cart.`;
      if (skipped.length) msg += `\n\n⚠️ ${skipped.length} item${skipped.length === 1 ? ' was' : 's were'} unavailable and skipped.`;
      await _send(tenant, from, _textBody(msg));
      await _send(tenant, from, _textBody(_renderCart(cart)));
      await _setState(convo._id, STATE.CART, { ...convo.session_data });
    } catch (err) {
      log.warn({ err }, 'reorder failed');
      await _send(tenant, from, _textBody("Couldn't reorder that one. Try picking another?"));
    }
    return;
  }

  // Default: re-show HOME.
  await _sendHome(tenant, from, customer.name);
  await _setState(convo._id, STATE.HOME, convo.session_data);
}

async function _handleAwaitName(tenant, convo, customer, from, input) {
  const name = (input || '').replace(/[^\w\s.'-]/g, '').trim().slice(0, 40);
  if (!name) {
    await _send(tenant, from, _textBody('Please send just your name as text.'));
    return;
  }
  await customerSvc.updateName(customer._id, name);
  await _sendHome(tenant, from, name);
  await _setState(convo._id, STATE.HOME, convo.session_data);
}

async function _handleCart(tenant, convo, customer, from, input) {
  const cart = await cartSvc.getCart(tenant.restaurant_id, customer._id);
  if (!cart || !cart.items?.length) {
    await _send(tenant, from, _textBody('Your cart is empty. Tap *Order now* from the menu.'));
    await _sendHome(tenant, from, customer.name);
    await _setState(convo._id, STATE.HOME, convo.session_data);
    return;
  }
  if (input === 'CART_CLEAR') {
    await cartSvc.clearCart(tenant.restaurant_id, customer._id);
    await _send(tenant, from, _textBody('Cart cleared.'));
    await _sendHome(tenant, from, customer.name);
    await _setState(convo._id, STATE.HOME, convo.session_data);
    return;
  }
  if (input === 'CART_CHECKOUT') {
    const addresses = await addressBook.list(customer._id);
    if (!addresses.length) {
      await _send(tenant, from, wa ? (require('../services/whatsapp').sendLocationRequest ? { type: 'interactive', interactive: { type: 'location_request_message', body: { text: '📍 Share your delivery location to continue.' }, action: { name: 'send_location' } } } : _textBody('Please share your delivery address.')) : _textBody('Please share your delivery address.'));
      await _setState(convo._id, STATE.AWAIT_ADDRESS, convo.session_data);
      return;
    }
    const sections = [{
      title: 'Saved addresses',
      rows: addresses.slice(0, 10).map((a) => ({
        id: `ADDR_${a._id}`,
        title: (a.label || 'Address').slice(0, 24),
        description: (a.address_line || '').slice(0, 70),
      })),
    }];
    await _send(tenant, from, _listBody({ body: 'Deliver to which address?', buttonText: 'Choose', sections }));
    await _setState(convo._id, STATE.AWAIT_ADDRESS, convo.session_data);
    return;
  }

  await _send(tenant, from, _textBody(_renderCart(cart)));
  await _send(tenant, from, _buttonsBody({
    body: 'Ready to checkout?',
    buttons: [
      { id: 'CART_CHECKOUT', title: '✅ Checkout' },
      { id: 'CART_CLEAR',    title: '🗑️ Clear cart' },
    ],
  }));
}

async function _handleAwaitAddress(tenant, convo, customer, from, input, rawMsg) {
  // Customer tapped a saved address.
  if (typeof input === 'string' && input.startsWith('ADDR_')) {
    const addrId = input.slice('ADDR_'.length);
    const cart = await cartSvc.setAddress(tenant.restaurant_id, customer._id, addrId);
    const address = await addressBook.findById(addrId);
    const summary = `*Delivering to:*\n${address?.address_line || '(address)'}\n\n${_renderCart(cart)}\n\nConfirm to place order?`;
    await _send(tenant, from, _buttonsBody({
      body: summary,
      buttons: [
        { id: 'ORDER_CONFIRM', title: '✅ Confirm' },
        { id: 'ORDER_CANCEL',  title: '❌ Cancel' },
      ],
    }));
    await _setState(convo._id, STATE.CONFIRM, convo.session_data);
    return;
  }
  // Location share — create a new address from it.
  if (rawMsg?.type === 'location') {
    const { latitude, longitude, address: addrText } = rawMsg.location || {};
    if (latitude == null || longitude == null) {
      await _send(tenant, from, _textBody("Couldn't read that location. Try sharing again?"));
      return;
    }
    const created = await addressBook.create(customer._id, {
      label: 'Delivery',
      address_line: addrText || `${latitude}, ${longitude}`,
      latitude, longitude,
      is_default: true,
    });
    await cartSvc.setAddress(tenant.restaurant_id, customer._id, created._id);
    const cart = await cartSvc.getCart(tenant.restaurant_id, customer._id);
    await _send(tenant, from, _buttonsBody({
      body: `Location saved.\n\n${_renderCart(cart)}\n\nConfirm to place order?`,
      buttons: [
        { id: 'ORDER_CONFIRM', title: '✅ Confirm' },
        { id: 'ORDER_CANCEL',  title: '❌ Cancel' },
      ],
    }));
    await _setState(convo._id, STATE.CONFIRM, convo.session_data);
    return;
  }
  await _send(tenant, from, _textBody('Please pick a saved address or share your location.'));
}

async function _handleConfirm(tenant, convo, customer, from, input) {
  if (input === 'ORDER_CANCEL') {
    await _send(tenant, from, _textBody('Order cancelled. Your cart is still saved.'));
    await _setState(convo._id, STATE.HOME, convo.session_data);
    await _sendHome(tenant, from, customer.name);
    return;
  }
  if (input === 'ORDER_CONFIRM') {
    const cart = await cartSvc.getCart(tenant.restaurant_id, customer._id);
    if (!cart || !cart.items?.length) {
      await _send(tenant, from, _textBody('Your cart is empty — nothing to place.'));
      await _setState(convo._id, STATE.HOME, convo.session_data);
      await _sendHome(tenant, from, customer.name);
      return;
    }
    if (!cart.address_id) {
      await _send(tenant, from, _textBody('Please pick a delivery address first.'));
      await _setState(convo._id, STATE.CART, convo.session_data);
      return;
    }

    // 1. Create order (address_snapshot + items frozen inside).
    let order;
    try {
      const res = await orderCreateSvc.createOrder({
        restaurantId: tenant.restaurant_id,
        customerId: customer._id,
        cart,
        options: { brandId: tenant.brand_id },
      });
      order = res.order;
    } catch (err) {
      log.error({ err }, 'orderCreate failed');
      await _send(tenant, from, _textBody('Sorry, we couldn\'t place your order. Your cart is saved — please try again in a moment.'));
      await _setState(convo._id, STATE.HOME, convo.session_data);
      await _sendHome(tenant, from, customer.name);
      return;
    }

    // 2. Razorpay order — paymentSvc.createRazorpayOrder expects
    // { id, total_rs, order_number }, not the raw Mongo doc.
    let rzpOrder;
    try {
      rzpOrder = await paymentSvc.createRazorpayOrder(
        { id: order._id, order_number: order.order_number, total_rs: order.total_rs },
        { wa_phone: customer.wa_phone, name: customer.name || 'Customer' }
      );
    } catch (err) {
      log.error({ err, orderId: order._id }, 'createRazorpayOrder failed — marking order as payment_failed');
      try {
        await col('orders').updateOne(
          { _id: order._id },
          { $set: { status: 'CANCELLED', payment_status: 'failed', updated_at: new Date() } }
        );
      } catch (_) { /* swallow */ }
      await _send(tenant, from, _textBody('Payment setup failed. Please try again shortly.'));
      await _setState(convo._id, STATE.HOME, convo.session_data);
      await _sendHome(tenant, from, customer.name);
      return;
    }

    // 3. Send the native Meta order_details checkout. Falls back to a
    // plain text if the interactive send fails (rare — usually means
    // the WABA isn't configured for WhatsApp Pay / Razorpay).
    const items = (order.items || []).map((li) => ({
      item_name: li.name,
      quantity: li.qty,
      unit_price_rs: li.unit_price_rs,
      menu_item_id: li.menu_item_id,
    }));
    try {
      await _send(tenant, from, (function buildPaymentRequestBody() {
        const toPaise = (rs) => Math.round((rs || 0) * 100);
        const orderItems = items.map((i) => ({
          retailer_id: String(i.menu_item_id || i.item_name || 'item'),
          name: String(i.item_name).substring(0, 60),
          quantity: i.quantity || 1,
          amount: { value: toPaise(i.unit_price_rs), offset: 100 },
        }));
        const subtotalPaise = orderItems.reduce((s, i) => s + i.amount.value * (i.quantity || 1), 0);
        const totalPaise = toPaise(order.total_rs);
        const refId = String(order.order_number || order._id).substring(0, 35);
        const configName = process.env.RAZORPAY_WA_CONFIG_NAME || 'GullyBite';
        const addrLine = order.address_snapshot?.address_line;
        return {
          type: 'interactive',
          interactive: {
            type: 'order_details',
            header: { type: 'text', text: `Your Order from ${tenant.restaurant_name || 'Restaurant'}`.substring(0, 60) },
            body: { text: `Hi ${customer.name || 'there'}! Review your order and pay securely.${addrLine ? '\n\n📍 Delivering to:\n' + addrLine : ''}` },
            footer: { text: 'Powered by GullyBite' },
            action: {
              name: 'review_and_pay',
              parameters: {
                reference_id: refId,
                type: 'digital-goods',
                payment_configuration: configName,
                currency: 'INR',
                total_amount: { value: totalPaise, offset: 100 },
                order: {
                  status: 'pending',
                  items: orderItems,
                  subtotal: { value: subtotalPaise, offset: 100 },
                  tax: { value: 0, offset: 100 },
                },
              },
            },
          },
        };
      })());
    } catch (err) {
      log.warn({ err, orderId: order._id }, 'sendPaymentRequest failed — sending text fallback');
      await _send(tenant, from, _textBody(
        `Order #${order.order_number} placed for ₹${order.total_rs.toFixed(2)}.\n\nPayment ID: ${rzpOrder.id}\n\nWe'll confirm once payment is received.`
      ));
    }

    // 4. Persist order/rp_order ids on the conversation session so
    // onPaymentConfirmed can route the customer back to HOME cleanly.
    // Phase 2: lock the cart while awaiting payment so the customer
    // cannot add/update/remove items and drift from the order we just
    // created. Cart is cleared in onPaymentConfirmed on success, or
    // unlocked on cancel.
    await cartSvc.lockCart(tenant.restaurant_id, customer._id);
    await _setState(convo._id, STATE.AWAIT_PAYMENT, {
      ...(convo.session_data || {}),
      order_id: order._id,
      order_number: order.order_number,
      rp_order_id: rzpOrder.id,
      total_rs: order.total_rs,
      awaiting_payment_since: new Date(),
    });
    return;
  }
  // Unknown input in CONFIRM — nudge back to the choice.
  await _send(tenant, from, _textBody('Please tap *Confirm* or *Cancel*.'));
}

// AWAIT_PAYMENT: we're waiting on Razorpay webhook. Any inbound message
// here gets a polite "we're still waiting" reply plus a safety hatch
// back to HOME so the customer is never stuck. Dead-end prevention.
async function _handleAwaitPayment(tenant, convo, customer, from, input) {
  const orderId = convo.session_data?.order_id;
  const orderNum = convo.session_data?.order_number || '';

  // Cancel — Phase 2 safety: refuse if the order has already been paid.
  // A cancel arriving after payment would otherwise race with the
  // Razorpay webhook and either leave the order in an inconsistent
  // state or trigger a manual refund for no reason.
  if (input === 'PAY_CANCEL' || (typeof input === 'string' && /^cancel$/i.test(input))) {
    if (!orderId) {
      await _send(tenant, from, _textBody('Nothing to cancel here.'));
      await _setState(convo._id, STATE.HOME, {});
      await _sendHome(tenant, from, customer.name);
      return;
    }
    const cur = await col('orders').findOne(
      { _id: String(orderId) },
      { projection: { payment_status: 1, status: 1, order_number: 1 } }
    );
    if (cur?.payment_status === 'paid' || ['PAID', 'CONFIRMED', 'PREPARING', 'PACKED', 'DISPATCHED', 'DELIVERED'].includes(cur?.status)) {
      await _send(tenant, from, _textBody(
        `Order #${cur.order_number || orderNum} is already paid and can't be cancelled here. Please contact support if you need help.`
      ));
      return;  // stay in AWAIT_PAYMENT — the payment webhook will route us out
    }
    try {
      await col('orders').updateOne(
        { _id: String(orderId), payment_status: { $ne: 'paid' } },
        { $set: { status: 'CANCELLED', payment_status: 'unpaid', updated_at: new Date() } }
      );
    } catch (_) { /* swallow */ }
    // Unlock the cart so the customer can edit and try again.
    try { await cartSvc.unlockCart(tenant.restaurant_id, customer._id); } catch (_) {}
    await _send(tenant, from, _textBody('Order cancelled. Your cart is available again.'));
    await _setState(convo._id, STATE.HOME, {});
    await _sendHome(tenant, from, customer.name);
    return;
  }

  // Resend payment link — creates a fresh Razorpay order and re-sends
  // the native review-and-pay card. Useful if the original card expired
  // or the customer dismissed it.
  if (input === 'RESEND_PAYMENT_LINK') {
    if (!orderId) {
      await _send(tenant, from, _textBody('No pending payment found.'));
      await _setState(convo._id, STATE.HOME, {});
      await _sendHome(tenant, from, customer.name);
      return;
    }
    const order = await col('orders').findOne({ _id: String(orderId) });
    if (!order) {
      await _send(tenant, from, _textBody("Couldn't find that order."));
      await _setState(convo._id, STATE.HOME, {});
      return;
    }
    if (order.payment_status === 'paid') {
      await _send(tenant, from, _textBody(`Order #${order.order_number} is already paid — thank you!`));
      await _setState(convo._id, STATE.HOME, {});
      await _sendHome(tenant, from, customer.name);
      return;
    }

    let rzpOrder;
    try {
      rzpOrder = await paymentSvc.createRazorpayOrder(
        { id: order._id, order_number: order.order_number, total_rs: order.total_rs },
        { wa_phone: customer.wa_phone, name: customer.name || 'Customer' }
      );
    } catch (err) {
      log.error({ err, orderId }, 'RESEND_PAYMENT_LINK: createRazorpayOrder failed');
      await _send(tenant, from, _textBody("Couldn't create a new payment link. Please try again in a moment."));
      return;
    }

    try {
      const toPaise = (rs) => Math.round((rs || 0) * 100);
      const items = (order.items || []).map((li) => ({
        retailer_id: String(li.menu_item_id || li.name || 'item'),
        name: String(li.name).substring(0, 60),
        quantity: li.qty || 1,
        amount: { value: toPaise(li.unit_price_rs), offset: 100 },
      }));
      const subtotalPaise = items.reduce((s, i) => s + i.amount.value * (i.quantity || 1), 0);
      const totalPaise = toPaise(order.total_rs);
      const refId = String(order.order_number || order._id).substring(0, 35);
      const configName = process.env.RAZORPAY_WA_CONFIG_NAME || 'GullyBite';
      const addrLine = order.address_snapshot?.address_line;
      await _send(tenant, from, {
        type: 'interactive',
        interactive: {
          type: 'order_details',
          header: { type: 'text', text: `Your Order from ${tenant.restaurant_name || 'Restaurant'}`.substring(0, 60) },
          body: { text: `Here is your payment again.${addrLine ? '\n\n📍 Delivering to:\n' + addrLine : ''}` },
          footer: { text: 'Powered by GullyBite' },
          action: {
            name: 'review_and_pay',
            parameters: {
              reference_id: refId,
              type: 'digital-goods',
              payment_configuration: configName,
              currency: 'INR',
              total_amount: { value: totalPaise, offset: 100 },
              order: {
                status: 'pending',
                items,
                subtotal: { value: subtotalPaise, offset: 100 },
                tax: { value: 0, offset: 100 },
              },
            },
          },
        },
      });
    } catch (err) {
      log.warn({ err, orderId }, 'RESEND_PAYMENT_LINK: sendPaymentRequest failed — text fallback');
      await _send(tenant, from, _textBody(
        `New payment request created for order #${order.order_number}. Payment ID: ${rzpOrder.id}. Please complete payment to proceed.`
      ));
    }
    await _setState(convo._id, STATE.AWAIT_PAYMENT, {
      ...(convo.session_data || {}),
      rp_order_id: rzpOrder.id,
      awaiting_payment_since: new Date(),
    });
    return;
  }

  // Default — polite nudge with the three options.
  await _send(tenant, from, _buttonsBody({
    body: `We're still waiting for payment on order${orderNum ? ' #' + orderNum : ''}. Finish the payment in the review card, resend it, or cancel to start over.`,
    buttons: [
      { id: 'RESEND_PAYMENT_LINK', title: '🔁 Resend link' },
      { id: 'PAY_CANCEL',          title: '❌ Cancel order' },
      { id: 'FLOW_ORDERS',         title: '📦 My orders' },
    ],
  }));
}

// ─── PUBLIC ENTRY ─────────────────────────────────────────────
// Called by the webhook POST handler for each inbound message.
//   phone_number_id — Meta number id (envelope "metadata.phone_number_id")
//   from            — customer phone (envelope "contacts[0].wa_id")
//   message         — raw message object from envelope "messages[0]"
//
// Returns:
//   { handled: true }            — flow consumed the message
//   { handled: false, reason }   — flow deferred (caller should run
//                                   legacy handling)
async function handle({ phone_number_id, from, message } = {}) {
  try {
    const tenant = await _resolveTenant(phone_number_id);
    if (!tenant) return { handled: false, reason: 'tenant_not_resolved' };

    const customer = await customerSvc.findOrCreateByPhone(from);
    if (!customer) return { handled: false, reason: 'customer_not_resolved' };

    // The `wa_account_id` isn't strictly needed for new-arch logic but
    // keeps the conversations row shape backwards-compatible with any
    // legacy reader that projects it.
    const waAcct = await col('whatsapp_accounts').findOne(
      { phone_number_id: String(phone_number_id) },
      { projection: { _id: 1 } }
    );
    const convo = await _getOrCreateConversation(tenant.restaurant_id, customer._id, waAcct?._id || null);

    const input = _extractText(message);

    // Every state awaits its handler, then returns { handled: true }.
    // Unknown states (e.g., BROWSE_CATEGORY — where the customer's next
    // action is a catalog-item add that the legacy webhook path picks
    // up) fall through to the HOME handler so the conversation is
    // never stuck. Same safety applies if session_data references a
    // state we've since removed after a deploy.
    switch (convo.state) {
      case STATE.AWAIT_NAME:
        await _handleAwaitName(tenant, convo, customer, from, input); break;
      case STATE.CART:
        await _handleCart(tenant, convo, customer, from, input); break;
      case STATE.AWAIT_ADDRESS:
        await _handleAwaitAddress(tenant, convo, customer, from, input, message); break;
      case STATE.CONFIRM:
        await _handleConfirm(tenant, convo, customer, from, input); break;
      case STATE.AWAIT_PAYMENT:
        await _handleAwaitPayment(tenant, convo, customer, from, input); break;
      case STATE.BROWSE_CATEGORY:
        // Catalog replies (product_list / order messages) are handled
        // by the legacy webhook path for now — defer so the legacy
        // add-to-cart flow runs. If the customer sends text instead,
        // bounce them back to HOME so they're never dead-ended.
        if (input && typeof input === 'string' && !message?.order && !message?.interactive?.nfm_reply) {
          await _handleIdleOrHome(tenant, convo, customer, from, input);
          break;
        }
        return { handled: false, reason: 'defer_catalog_reply_to_legacy' };
      case STATE.HOME:
      case STATE.IDLE:
      default:
        await _handleIdleOrHome(tenant, convo, customer, from, input);
        break;
    }
    return { handled: true };
  } catch (err) {
    log.error({ err }, 'flowHandler.handle failed');
    return { handled: false, reason: 'error', error: err?.message };
  }
}

// Called by the Razorpay webhook after an order is marked PAID.
//
// Phase 2: the confirmation message is now ALWAYS sent — it does not
// depend on a conversation existing, on the customer being in
// AWAIT_PAYMENT, or on Phase 1 having handled the original order.
// A paying customer must always get a receipt. Conversation-state
// bookkeeping is best-effort and happens only if a conversation row
// exists; it never gates the send.
//
// Never throws: payment confirmation must never fail because a
// post-payment UX nudge broke.
async function onPaymentConfirmed({ orderId } = {}) {
  try {
    if (!orderId) return { handled: false, reason: 'missing_orderId' };
    const order = await col('orders').findOne(
      { _id: String(orderId) },
      { projection: { restaurant_id: 1, customer_id: 1, order_number: 1, total_rs: 1 } }
    );
    if (!order) return { handled: false, reason: 'order_not_found' };

    // Always clear the cart — it represents pre-checkout state, and
    // the order is now the authoritative record. Unconditionally
    // clearing also releases any 'locked' status.
    try { await cartSvc.clearCart(order.restaurant_id, order.customer_id); } catch (_) {}

    const customer = await customerSvc.findById(order.customer_id);
    if (!customer?.wa_phone) return { handled: false, reason: 'customer_or_phone_missing' };

    // Resolve the tenant's WABA (for token/pid routing). Without this
    // we can't send — but we still return success for the state-reset
    // part if a conversation exists.
    const acct = await col('whatsapp_accounts').findOne(
      { restaurant_id: String(order.restaurant_id), is_active: true },
      { projection: { phone_number_id: 1 } }
    );
    const phoneNumberId = acct?.phone_number_id;
    const tenant = phoneNumberId ? await _resolveTenant(phoneNumberId) : null;

    // ALWAYS try to send the receipt + home menu if we have a tenant.
    // The previous gate on conversation.state === AWAIT_PAYMENT has
    // been removed — payment confirmation is unconditional.
    let sent = false;
    if (tenant) {
      try {
        await _send(tenant, customer.wa_phone, _textBody(
          `✅ Payment received for order #${order.order_number}. ₹${Number(order.total_rs).toFixed(2)} — thank you!\n\nWe'll send updates as your order progresses.`
        ));
        await _sendHome(tenant, customer.wa_phone, customer.name);
        sent = true;
      } catch (err) {
        log.warn({ err, orderId }, 'onPaymentConfirmed: send failed — continuing state reset');
      }
    }

    // Best-effort state reset — only if a conversation row exists for
    // this (tenant, customer). We do NOT gate on current state; a
    // paid order always means the Phase 1 conversation is done
    // awaiting payment.
    try {
      const convo = await col('conversations').findOne({
        restaurant_id: String(order.restaurant_id),
        customer_id: String(order.customer_id),
      });
      if (convo) await _setState(convo._id, STATE.HOME, {});
    } catch (_) { /* best-effort */ }

    return { handled: true, sent, tenant_resolved: !!tenant };
  } catch (err) {
    log.error({ err, orderId }, 'onPaymentConfirmed failed');
    return { handled: false, reason: 'error', error: err?.message };
  }
}

module.exports = { handle, onPaymentConfirmed, STATE };
