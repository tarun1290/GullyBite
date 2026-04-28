// src/services/whatsapp.js
// All outgoing WhatsApp messages via Meta Cloud API
// Think of this as the "messenger" layer — just sends messages, no business logic

const axios = require('axios');
const metaConfig = require('../config/meta');
const log = require('../utils/logger').child({ component: 'WhatsApp' });
const Brand = require('../models/Brand');
const { col } = require('../config/database');

// Build the messages API URL for a given phone number — uses centralized API version
const apiUrl = (phoneNumberId) =>
  `${metaConfig.graphUrl}/${phoneNumberId}/messages`;

// ─── CORE SEND FUNCTION ───────────────────────────────────────
// All functions below call this one. Includes 1 automatic retry on failure.
const sendMsg = async (phoneNumberId, accessToken, to, body, _retried = false) => {
  const payload = { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...body };
  const start = Date.now();
  try {
    const { data } = await axios.post(apiUrl(phoneNumberId), payload, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    });
    log.info({ to: to?.slice(-4), sendMs: Date.now() - start }, 'WA message sent');
    return data;
  } catch (err) {
    const e = err.response?.data?.error;
    log.error({ to: to?.slice(-4), sendMs: Date.now() - start, errorCode: e?.code, errorMsg: e?.message }, 'Send failed');
    // Retry once on timeout or 5xx
    if (!_retried && (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || (err.response?.status >= 500))) {
      log.info({ to: to?.slice(-4) }, 'Retrying send after 1s');
      await new Promise(r => setTimeout(r, 1000));
      return sendMsg(phoneNumberId, accessToken, to, body, true);
    }
    throw err;
  }
};

// ─── TEXT MESSAGE ─────────────────────────────────────────────
// Plain text. The simplest type.
const sendText = (pid, token, to, text) =>
  sendMsg(pid, token, to, { type: 'text', text: { body: text, preview_url: false } });

// ─── INTERACTIVE BUTTONS ──────────────────────────────────────
// Shows tappable buttons below a message. Max 3 buttons.
// buttons: [{ id: 'BTN_ID', title: 'Button Label' }]
// id is what we receive back when customer taps
const sendButtons = (pid, token, to, { header, body, footer, buttons }) =>
  sendMsg(pid, token, to, {
    type: 'interactive',
    interactive: {
      type: 'button',
      ...(header && { header: { type: 'text', text: header } }),
      body: { text: body },
      ...(footer && { footer: { text: footer } }),
      action: {
        buttons: buttons.map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: b.title.substring(0, 20) },
        })),
      },
    },
  });

// ─── LOCATION REQUEST ─────────────────────────────────────────
// Shows a "Share Location" button.
// When customer taps → shares GPS → Meta sends us coordinates.
// This is Step 1 of the ordering flow!
const sendLocationRequest = (pid, token, to) =>
  sendMsg(pid, token, to, {
    type: 'interactive',
    interactive: {
      type: 'location_request_message',
      body: {
        text: '📍 *Share your delivery location*\n\nTap the button below to share your location so I can show you the nearest menu.\n\n_Your location is only used to find the closest restaurant._',
      },
      action: { name: 'send_location' },
    },
  });

// ─── CATALOG MESSAGE ──────────────────────────────────────────
// Shows the WhatsApp in-app shopping experience!
// Customer can browse the menu, add to cart, all inside WhatsApp.
// catalogId: the Meta Commerce Catalog ID (you create this in Meta Business Manager)
const sendCatalog = (pid, token, to, catalogId, introText) => {
  // catalog_message uses the catalog connected to the WABA — catalog_id is NOT passed in parameters
  // thumbnail_product_retailer_id is optional; omit if not available
  const params = {};
  // catalogId is kept for logging but not sent in payload (Meta uses WABA-connected catalog)
  log.info({ catalogId, to: to?.slice(-4) }, 'Sending catalog message');
  return sendMsg(pid, token, to, {
    type: 'interactive',
    interactive: {
      type: 'catalog_message',
      body: { text: introText || '🍽️ Here is our menu! Browse and add items to your cart.' },
      footer: { text: 'Tap any item to view details and add to cart' },
      action: {
        name: 'catalog_message',
        parameters: params,
      },
    },
  });
};

// ─── MULTI-PRODUCT MESSAGE (MPM) ──────────────────────────────
// Sends a product_list interactive message with items in category sections.
// sections: [{ title: "🥟 Starters", product_retailer_ids: ["madhapur-momos", ...] }, ...]
// Max 10 sections, max 30 product_retailer_ids total per MPM.
const sendMPM = (pid, token, to, catalogId, { header, body, footer, sections }) => {
  const safeCatalogId = String(catalogId || '');
  const safeSections = (sections || []).filter(s => s.product_retailer_ids?.length > 0).slice(0, 10);
  const totalProducts = safeSections.reduce((n, s) => n + s.product_retailer_ids.length, 0);
  log.info({ catalogId: safeCatalogId, sections: safeSections.length, products: totalProducts }, 'Sending MPM');
  if (!safeCatalogId) { log.error('No catalog_id — cannot send MPM'); return Promise.reject(new Error('Missing catalog_id')); }
  if (!safeSections.length) { log.error('No valid sections — cannot send MPM'); return Promise.reject(new Error('No sections')); }
  return sendMsg(pid, token, to, {
    type: 'interactive',
    interactive: {
      type: 'product_list',
      header: { type: 'text', text: (header || '\uD83C\uDF7D\uFE0F Our Menu').substring(0, 60) },
      body: { text: (body || 'Browse items, tap for options, and add to cart!').substring(0, 1024) },
      footer: { text: (footer || 'Prices inclusive of taxes').substring(0, 60) },
      action: {
        catalog_id: safeCatalogId,
        sections: safeSections.map(s => ({
          title: (s.title || 'Menu').substring(0, 24),
          product_items: s.product_retailer_ids.filter(Boolean).slice(0, 30).map(id => ({ product_retailer_id: String(id) })),
        })),
      },
    },
  });
};

// DEPRECATED: sendOrderSummary removed — replaced by sendPaymentRequest (interactive order_details checkout)
// The old text-based order summary with Confirm/Cancel/Coupon buttons is no longer used.

// ─── WHATSAPP PAY — NATIVE PAYMENT REQUEST ────────────────────
// Sends an interactive order_details message — Meta's native payment UI.
// Customer sees full order breakdown + "Review and Pay" button.
// Tapping opens WhatsApp's built-in UPI payment flow (Razorpay backend).
//
// Prerequisites:
//   - WhatsApp Pay enabled on the WABA (India, registered with Meta/NPCI)
//   - RAZORPAY_WA_CONFIG_NAME set in .env
//     (Meta Business Manager → WhatsApp → Payment Settings → config name)
//
// order:  full order row from DB (id, order_number, total_rs, subtotal_rs,
//         delivery_fee_rs, discount_rs, branch_name)
// items:  order_items rows (item_name, unit_price_rs, quantity, line_total_rs)
// ─── INTERACTIVE ORDER CHECKOUT (Review and Pay) ──────────────
// Sends an interactive order_details message with native Razorpay payment inside WhatsApp.
// Customer sees full order breakdown + "Review and Pay" button. Confirmed working format.
const sendPaymentRequest = (pid, token, to, { order, items, customerName, restaurantName, deliveryAddress }) => {
  const toPaise = (rs) => Math.round((rs || 0) * 100);
  const configName = process.env.RAZORPAY_WA_CONFIG_NAME || 'GullyBite';

  const orderItems = (items || order.items || []).map(i => ({
    retailer_id: i.retailer_id || i.menu_item_id || i.item_name || 'item',
    name: (i.item_name || i.name || 'Item').substring(0, 60),
    quantity: i.quantity || 1,
    amount: { value: toPaise(i.unit_price_rs || i.price_rs), offset: 100 },
  }));

  // Add delivery fee as a line item (instead of shipping) to avoid Meta showing address selection
  const deliveryRs = parseFloat(order.customer_delivery_rs || order.delivery_fee_rs || 0);
  if (deliveryRs > 0) {
    orderItems.push({
      retailer_id: 'delivery-fee',
      name: 'Delivery Fee',
      quantity: 1,
      amount: { value: toPaise(deliveryRs), offset: 100 },
    });
  }

  // Add packaging as a line item
  const packagingRs = parseFloat(order.packaging_rs || 0);
  if (packagingRs > 0) {
    orderItems.push({
      retailer_id: 'packaging',
      name: 'Packaging',
      quantity: 1,
      amount: { value: toPaise(packagingRs), offset: 100 },
    });
  }

  // Subtotal = sum of all line item amounts (food + delivery + packaging)
  const subtotalPaise = orderItems.reduce((sum, i) => sum + i.amount.value * (i.quantity || 1), 0);
  const taxPaise = toPaise((order.food_gst_rs || 0) + (order.customer_delivery_gst_rs || 0) + (order.packaging_gst_rs || 0));
  const totalPaise = toPaise(order.total_rs);
  const discountRs = order.discount_rs || 0;

  const orderPayload = {
    status: 'pending',
    items: orderItems,
    subtotal: { value: subtotalPaise, offset: 100 },
    tax: { value: taxPaise, offset: 100 },
  };
  if (discountRs > 0) {
    orderPayload.discount = { value: toPaise(discountRs), offset: 100, description: order.coupon_code || 'Discount' };
  }

  // Delivery address in body text for customer confirmation
  let addressText = '';
  if (deliveryAddress) {
    if (typeof deliveryAddress === 'string') {
      addressText = '\n\n📍 Delivering to:\n' + deliveryAddress;
    } else {
      const addrStr = deliveryAddress.full_address || deliveryAddress.address || [deliveryAddress.building_floor, deliveryAddress.street, deliveryAddress.area_locality, deliveryAddress.landmark ? 'Near ' + deliveryAddress.landmark : '', [deliveryAddress.city, deliveryAddress.pincode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      if (addrStr) addressText = '\n\n📍 Delivering to:\n' + addrStr;
    }
  }

  const refId = (order.order_number || order.id || 'ORD-' + Date.now()).toString().substring(0, 35);
  log.info({ to: to?.slice(-4), refId, totalRs: order.total_rs }, 'Sending order_details payment request');

  const msgPayload = {
    type: 'interactive',
    interactive: {
      type: 'order_details',
      header: { type: 'text', text: ('Your Order from ' + (restaurantName || order.business_name || order.branch_name || 'Restaurant')).substring(0, 60) },
      body: { text: 'Hi ' + (customerName || 'there') + '! Review your order and pay securely.' + addressText },
      footer: { text: 'Powered by GullyBite' },
      action: {
        name: 'review_and_pay',
        parameters: {
          reference_id: refId,
          type: 'digital-goods',
          // Meta requires payment_settings (an array of payment gateway
          // objects) on review_and_pay CTAs — payment_configuration was
          // never a valid field and Meta rejects it with #131008. Shape
          // mirrors sendCheckoutButtonTemplate (line ~474) so the two
          // checkout paths stay in lockstep on Razorpay credentials.
          payment_settings: [{
            type: 'payment_gateway',
            payment_gateway: {
              type: 'razorpay',
              configuration_name: configName,
            },
          }],
          currency: 'INR',
          total_amount: { value: totalPaise, offset: 100 },
          order: orderPayload,
        },
      },
    },
  };

  log.info({ refId, payload: JSON.stringify(msgPayload.interactive.action.parameters) }, 'order_details payload');

  return sendMsg(pid, token, to, msgPayload);
};

// DEPRECATED: sendPaymentLink removed — only interactive checkout is used

// ─── ORDER STATUS UPDATES ─────────────────────────────────────
// Sent to customers at each stage of their order
const sendStatusUpdate = (pid, token, to, status, { orderNumber, eta, trackingUrl }) => {
  const msgs = {
    CONFIRMED: `✅ *Order Confirmed!*\nYour order #${orderNumber} is confirmed.\nThe restaurant will start preparing it shortly! 🍳`,
    PREPARING: `👨‍🍳 *Being Prepared*\nOrder #${orderNumber} is in the kitchen!\nEstimated ready: ${eta || '20-25'} mins`,
    PACKED: `📦 *Packed & Ready!*\nOrder #${orderNumber} is packed and waiting for pickup!`,
    DISPATCHED: `🚴 *Out for Delivery!*\nOrder #${orderNumber} is on its way!\n${trackingUrl ? `Track: ${trackingUrl}` : ''}`,
    DELIVERED: `🎉 *Delivered!*\nOrder #${orderNumber} delivered successfully.\nEnjoy your meal! Bon appétit 🙏`,
    CANCELLED: `❌ *Order Cancelled*\nOrder #${orderNumber} has been cancelled.\nAny payment will be refunded in 3-5 business days.`,
  };
  return sendText(pid, token, to, msgs[status] || `Order #${orderNumber}: ${status}`);
};

// ─── SAVED ADDRESS LIST ───────────────────────────────────────
// Shows a WhatsApp list message with the customer's saved addresses.
// Each row id = `ADDR_<uuid>` so we know which was tapped.
// A final row lets the customer share a fresh GPS pin instead.
const sendAddressList = (pid, token, to, addresses) => {
  const rows = addresses.map((a) => ({
    id         : `ADDR_${a.id}`,
    title      : a.label.substring(0, 24),
    description: (a.full_address || '').substring(0, 72),
  }));
  rows.push({
    id         : 'USE_NEW_LOCATION',
    title      : 'Use current location',
    description: 'Share your GPS pin',
  });

  return sendMsg(pid, token, to, {
    type: 'interactive',
    interactive: {
      type  : 'list',
      body  : { text: '📍 *Select delivery address*\n\nChoose a saved address or share your current location.' },
      footer: { text: 'Tap to select' },
      action: {
        button  : 'Choose Address',
        sections: [{ title: 'Your Addresses', rows }],
      },
    },
  });
};

// ─── ADDRESS REQUEST (Native Address Form) ──────────────────
// [WhatsApp2026] Sends an interactive address_message form.
// Meta renders a native structured form (name, phone, building, floor, pin_code, etc.)
// Customer fills it in-app — we get back an nfm_reply with all fields.
// savedAddress: optional pre-fill from a saved address
const sendAddressRequest = (pid, token, to, { savedAddress } = {}) => {
  const params = {
    country: 'IN',
    ...(savedAddress && {
      values: {
        ...(savedAddress.name && { name: savedAddress.name }),
        ...(savedAddress.phone_number && { phone_number: savedAddress.phone_number }),
        ...(savedAddress.in_pin_code && { in_pin_code: savedAddress.in_pin_code }),
        ...(savedAddress.floor_number && { floor_number: savedAddress.floor_number }),
        ...(savedAddress.building_name && { building_name: savedAddress.building_name }),
        ...(savedAddress.address && { address: savedAddress.address }),
        ...(savedAddress.landmark_area && { landmark_area: savedAddress.landmark_area }),
        ...(savedAddress.city && { city: savedAddress.city }),
      },
    }),
  };

  return sendMsg(pid, token, to, {
    type: 'interactive',
    interactive: {
      type: 'address_message',
      body: {
        text: '📍 *Enter your delivery address*\n\nFill in the form below so we can deliver to the right spot.',
      },
      action: {
        name: 'address_message',
        parameters: params,
      },
    },
  });
};

// ─── TYPING INDICATOR ────────────────────────────────────────
// [WhatsApp2026] Shows "typing…" bubble for up to 25 seconds.
// Purely cosmetic — use before long operations to keep UX smooth.
const showTyping = (pid, token, to) =>
  axios.post(apiUrl(pid), { messaging_product: 'whatsapp', recipient_type: 'individual', to, status: 'typing' }, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 5000,
  }).catch(() => {}); // Best-effort, never block

// ─── MARK AS READ ─────────────────────────────────────────────
// Shows blue double-tick on the customer's screen
// Always call this when you receive a message — it's good UX
const markRead = (pid, token, messageId) =>
  axios.post(apiUrl(pid), { messaging_product: 'whatsapp', status: 'read', message_id: messageId }, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {}); // Ignore errors silently

// ─── WHATSAPP FLOW MESSAGE ───────────────────────────────────
// [WhatsApp2026] Sends a WhatsApp Flow — mini-app for structured input.
// Used for rating/feedback forms that replace simple button taps.
// flowId: the Flow ID from Meta Business Manager
// flowToken: custom token to identify the response (e.g., "rating_<orderId>")
// flowCta: button text (max 20 chars)
// screenId: initial screen to display
// flowData: optional data to pass to the Flow
const sendFlow = (pid, token, to, { flowId, flowToken, flowCta, screenId, flowData, body, footer }) =>
  sendMsg(pid, token, to, {
    type: 'interactive',
    interactive: {
      type: 'flow',
      body: { text: body || flowData?.body || 'Please fill in the form below.' },
      ...((footer || flowData?.footer) && { footer: { text: footer || flowData.footer } }),
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_id: flowId,
          flow_cta: (flowCta || 'Open Form').substring(0, 20),
          flow_action: 'navigate',
          flow_action_payload: {
            screen: screenId || 'RATING_SCREEN',
            data: flowData?.screenData || flowData || {},
          },
        },
      },
    },
  });

// ─── TEMPLATE MESSAGE ──────────────────────────────────────────
// Sends a pre-approved Meta message template.
// name:       Exact template name as registered in Meta Business Manager
// language:   Language code, e.g. 'en', 'en_US'
// components: Array of component objects — for body-only variable templates:
//             [{ type: 'body', parameters: [{ type:'text', text:'value' }, …] }]
const sendTemplate = (pid, token, to, { name, language, components = [] }) =>
  sendMsg(pid, token, to, {
    type: 'template',
    template: {
      name,
      language: { code: language || 'en' },
      ...(components.length && { components }),
    },
  });

// ─── CHECKOUT BUTTON TEMPLATE SEND (Meta beta) ───────────────
// Sends an order_details-button TEMPLATE message used by Meta's
// Checkout endpoint beta. This is a SEPARATE path from sendPaymentRequest
// (the interactive order_details flow) — both coexist; this one is only
// used when Meta has linked a checkout endpoint to the WABA and the
// admin wants coupon sub-actions.
//
// Always digital-goods — delivery fee is modelled as a line item per
// GullyBite architecture. The reference_id is a short opaque id; restaurant_id is
// stored in checkout_refs so the endpoint can resolve it on get_coupons
// / apply_coupon without exceeding Meta's 35-char reference_id limit.
const sendCheckoutButtonTemplate = async (phoneNumberId, to, {
  restaurantId, templateName, language = 'en',
  items, subtotalPaise, taxPaise, deliveryFeePaise,
  paymentConfigName, importer,
  referenceId: providedRef,
}) => {
  if (!phoneNumberId) throw new Error('phoneNumberId required');
  if (!restaurantId)  throw new Error('restaurantId required');
  if (!templateName)  throw new Error('templateName required');
  if (!Array.isArray(items) || !items.length) throw new Error('items required');

  const { col, newId } = require('../config/database');
  const metaConfig = require('../config/meta');

  // Compose reference_id — short opaque id + mapping row so the checkout
  // endpoint can resolve restaurant_id on sub-action callbacks. Capped
  // at 35 chars per Meta spec.
  const refId = (providedRef || `gb_${newId().replace(/-/g, '').slice(0, 24)}`).slice(0, 35);
  try {
    await col('checkout_refs').updateOne(
      { _id: refId },
      {
        $set: {
          restaurant_id: String(restaurantId),
          customer_phone: String(to || ''),
          template_name: templateName,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
        $setOnInsert: { created_at: new Date() },
      },
      { upsert: true },
    );
  } catch (err) {
    log.warn({ err, refId }, 'checkout_refs write failed (continuing)');
  }

  // Build item lines + add delivery as a line item (digital-goods only).
  const lineItems = items.map(i => ({
    retailer_id: String(i.retailer_id || i.id || 'item').slice(0, 60),
    name: String(i.name || 'Item').slice(0, 60),
    quantity: Number(i.quantity) || 1,
    amount: { value: Number(i.amount_paise ?? i.price_paise ?? 0), offset: 100 },
    ...(i.sale_amount_paise != null && { sale_amount: { value: Number(i.sale_amount_paise), offset: 100 } }),
  }));
  if (deliveryFeePaise && Number(deliveryFeePaise) > 0) {
    lineItems.push({
      retailer_id: 'delivery-fee',
      name: 'Delivery Fee',
      quantity: 1,
      amount: { value: Number(deliveryFeePaise), offset: 100 },
    });
  }

  const totalPaise = Number(subtotalPaise || 0) + Number(taxPaise || 0) + Number(deliveryFeePaise || 0);

  const orderPayload = {
    status: 'pending',
    catalog_id: undefined, // intentional omit — digital-goods
    items: lineItems,
    subtotal: { value: Number(subtotalPaise || 0), offset: 100 },
    tax:      { value: Number(taxPaise || 0),       offset: 100 },
  };

  const componentButton = {
    type: 'button',
    sub_type: 'order_details',
    index: '0',
    parameters: [{
      type: 'action',
      action: {
        order_details: {
          reference_id: refId,
          type: 'digital-goods',
          payment_settings: [{
            type: 'payment_gateway',
            payment_gateway: {
              type: 'razorpay',
              configuration_name: paymentConfigName || process.env.RAZORPAY_WA_CONFIG_NAME || 'GullyBite',
            },
          }],
          currency: 'INR',
          total_amount: { value: totalPaise, offset: 100 },
          order: orderPayload,
          ...(importer && {
            importer: {
              name: String(importer.name || '').slice(0, 200),
              address: String(importer.address || '').slice(0, 400),
            },
          }),
        },
      },
    }],
  };

  return sendTemplate(phoneNumberId, metaConfig.systemUserToken, to, {
    name: templateName,
    language,
    components: [componentButton],
  });
};

// ─── COUPON TEMPLATE SEND ────────────────────────────────────
// Sends a pre-approved MARKETING coupon template (one with a copy_code
// button). {{1}} is always the coupon code; {{2}} is an optional
// discount label. The copy_code button's "coupon_code" parameter is
// what the user tapping "Copy code" actually copies — it must match
// the code in the body.
// wabaId is accepted for logging / future routing; the actual send
// only needs phoneNumberId + token.
const sendCouponTemplate = (wabaId, phoneNumberId, to, { templateName, couponCode, discountText, language = 'en' }) => {
  if (!templateName) throw new Error('sendCouponTemplate: templateName required');
  if (!couponCode)   throw new Error('sendCouponTemplate: couponCode required');

  const bodyParams = [{ type: 'text', text: String(couponCode) }];
  if (discountText) bodyParams.push({ type: 'text', text: String(discountText) });

  const components = [
    { type: 'body', parameters: bodyParams },
    {
      type: 'button',
      sub_type: 'copy_code',
      index: '0',
      parameters: [{ type: 'coupon_code', coupon_code: String(couponCode) }],
    },
  ];

  const metaConfig = require('../config/meta');
  return sendTemplate(phoneNumberId, metaConfig.systemUserToken, to, {
    name: templateName,
    language,
    components,
  });
};

// ─── INTERACTIVE LIST ────────────────────────────────────────
// Shows a tappable list (max 10 rows). Used for order history, etc.
// sections: [{ title: 'Section', rows: [{ id, title, description }] }]
const sendList = (pid, token, to, { body, footer, buttonText, sections }) =>
  sendMsg(pid, token, to, {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: body },
      ...(footer && { footer: { text: footer } }),
      action: {
        button: buttonText || 'View',
        sections,
      },
    },
  });

// ─── DOCUMENT MESSAGE ─────────────────────────────────────────
// Upload a buffer as media, then send as a document message.
// buffer: Buffer, mimeType: e.g. 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const sendDocument = async (pid, token, to, { buffer, filename, caption, mimeType }) => {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType || 'application/octet-stream');
  form.append('file', buffer, { filename, contentType: mimeType });

  const uploadUrl = `${metaConfig.graphUrl}/${pid}/media`;
  const { data: media } = await axios.post(uploadUrl, form, {
    headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() },
    timeout: 30000,
  });

  return sendMsg(pid, token, to, {
    type: 'document',
    document: { id: media.id, filename, ...(caption && { caption }) },
  });
};

// ─── BRAND-AWARE SENDER (additive, non-breaking) ──────────────
// New entry point that accepts an OPTIONAL `brand_id`. When present,
// the brand's `phone_number_id` (and, if set, `access_token`) override
// the caller's defaults. When absent, behavior is identical to calling
// sendMsg directly — existing API consumers are unaffected.
//
//   sendMessage({
//     brand_id,          // optional
//     phone_number_id,   // default/fallback (legacy single-brand)
//     access_token,      // default/fallback
//     to, body,
//   })
//
// Returns whatever sendMsg returns. Logs the resolved brand_id and
// phone_number_id on every call for observability.
// Resolution ladder:
//   1. brand_id passed          → Brand.findById → brand.phone_number_id
//   2. no brand_id, business_id → load business:
//        • business_type == 'single' + default_brand_id set
//             → Brand.findById(default_brand_id) → use its phone_number_id
//        • business_type == 'multi' (or no default set) → legacy fallback
//   3. no brand_id, no business_id → caller-supplied phone_number_id / token
// Any failure at any step degrades to the legacy path — existing callers
// that only pass (phone_number_id, access_token, to, body) are unaffected.
// ─── FALLBACK REASON VOCABULARY ───────────────────────────────
// Structured tags emitted on every log line so dashboards can filter
// and alert by exact routing outcome instead of scraping message text.
//
//   no_brand_match               — brand_id passed but Brand.findById
//                                  returned null or had no pid
//   default_brand_used           — resolved via business.default_brand_id
//   multi_brand_missing_brand_id — strict-mode reject on multi tenants
//   deleted_default_brand        — default_brand_id points at a brand
//                                  row that's gone (or has no pid)
const FALLBACK_REASONS = Object.freeze({
  NO_BRAND_MATCH:               'no_brand_match',
  DEFAULT_BRAND_USED:           'default_brand_used',
  MULTI_BRAND_MISSING_BRAND_ID: 'multi_brand_missing_brand_id',
  DELETED_DEFAULT_BRAND:        'deleted_default_brand',
});

const sendMessage = async ({ brand_id, business_id, phone_number_id, access_token, to, body, allow_default_fallback = false } = {}) => {
  let pid = phone_number_id;
  let token = access_token;
  let resolvedBrandId = null;
  let routing = 'default';
  let businessType = null;
  let fallbackReason = null;

  if (brand_id) {
    try {
      const brand = await Brand.findById(brand_id);
      if (brand && brand.phone_number_id) {
        pid = brand.phone_number_id;
        token = brand.access_token || token;
        resolvedBrandId = brand._id;
        routing = 'brand';
      } else {
        fallbackReason = FALLBACK_REASONS.NO_BRAND_MATCH;
        log.warn({
          event: 'wa_send_routing',
          brand_id,
          business_id: business_id || null,
          business_type: businessType,
          fallback_reason: fallbackReason,
        }, 'brand_id not found or missing phone_number_id — falling back to default');
      }
    } catch (err) {
      fallbackReason = FALLBACK_REASONS.NO_BRAND_MATCH;
      log.warn({
        event: 'wa_send_routing',
        err,
        brand_id,
        business_id: business_id || null,
        business_type: businessType,
        fallback_reason: fallbackReason,
      }, 'Brand lookup failed — falling back to default');
    }
  } else if (business_id) {
    try {
      const biz = await col('restaurants').findOne(
        { _id: String(business_id) },
        { projection: { business_type: 1, default_brand_id: 1 } }
      );
      businessType = biz?.business_type || 'single';  // legacy rows = single

      if (businessType === 'multi') {
        if (!allow_default_fallback) {
          fallbackReason = FALLBACK_REASONS.MULTI_BRAND_MISSING_BRAND_ID;
          log.warn({
            event: 'wa_send_routing',
            business_id,
            business_type: businessType,
            fallback_reason: fallbackReason,
          }, 'Multi-brand business requires explicit brand_id');
          const err = new Error('Multi-brand business requires explicit brand_id');
          err.code = 'BRAND_ID_REQUIRED';
          err.business_type = 'multi';
          throw err;
        }
        if (biz?.default_brand_id) {
          const defaultBrand = await Brand.findById(biz.default_brand_id);
          if (defaultBrand && defaultBrand.phone_number_id) {
            pid = defaultBrand.phone_number_id;
            token = defaultBrand.access_token || token;
            resolvedBrandId = defaultBrand._id;
            routing = 'default_brand';
            fallbackReason = FALLBACK_REASONS.DEFAULT_BRAND_USED;
            log.info({
              event: 'wa_send_routing',
              business_id,
              business_type: businessType,
              brand_id: defaultBrand._id,
              fallback_reason: fallbackReason,
            }, 'Multi-brand: default_brand_used via allow_default_fallback');
          } else {
            fallbackReason = FALLBACK_REASONS.DELETED_DEFAULT_BRAND;
            log.warn({
              event: 'wa_send_routing',
              business_id,
              business_type: businessType,
              default_brand_id: biz.default_brand_id,
              fallback_reason: fallbackReason,
            }, 'Multi-brand default_brand_id points at missing or phoneless brand');
          }
        }
      } else if (businessType === 'single' && biz?.default_brand_id) {
        const defaultBrand = await Brand.findById(biz.default_brand_id);
        if (defaultBrand && defaultBrand.phone_number_id) {
          pid = defaultBrand.phone_number_id;
          token = defaultBrand.access_token || token;
          resolvedBrandId = defaultBrand._id;
          routing = 'default_brand';
          fallbackReason = FALLBACK_REASONS.DEFAULT_BRAND_USED;
        } else {
          fallbackReason = FALLBACK_REASONS.DELETED_DEFAULT_BRAND;
          log.warn({
            event: 'wa_send_routing',
            business_id,
            business_type: businessType,
            default_brand_id: biz.default_brand_id,
            fallback_reason: fallbackReason,
          }, 'Default brand has no phone_number_id — legacy fallback');
        }
      }
    } catch (err) {
      if (err && err.code === 'BRAND_ID_REQUIRED') throw err;
      log.warn({
        event: 'wa_send_routing',
        err,
        business_id,
        business_type: businessType,
        fallback_reason: fallbackReason,
      }, 'Business lookup for default brand failed — legacy fallback');
    }
  }

  // Local-dev trace only. Duplicates the structured log.info below (which
  // is the canonical record); leaving it on in prod just floods stdout
  // with the WABA phone_number_id, which is reversibly tied to a
  // restaurant identity.
  if (process.env.NODE_ENV !== 'production') {
    console.log({ brand_id: resolvedBrandId, phone_number_id: pid });
  }
  log.info({
    event: 'wa_send_routing',
    brand_id: resolvedBrandId,
    business_id: business_id || null,
    business_type: businessType,
    phone_number_id: pid,
    to: to?.slice(-4),
    routing,
    fallback_reason: fallbackReason,
  }, 'Outbound message routing resolved');

  return sendMsg(pid, token, to, body);
};

// DEPRECATED: sendCheckoutOrder and sendCheckoutTemplate removed — sendPaymentRequest is the single checkout function

// ─── OUTBOUND NUMBER SELECTION ────────────────────────────────
// Picks the Meta phone_number_id to use for OUTBOUND sends.
// Campaign / promotional paths (broadcasts, cart recovery, loyalty
// marketing) should call this. Transactional paths (order
// confirmation, payment status, order updates) must NOT — they
// always send from the primary WABA number.
//
// Accepts both camelCase (`phoneNumberId`) and snake_case
// (`phone_number_id`) fallbacks so callers can pass the restaurant
// doc directly or a composed object `{ ...restaurant, phone_number_id }`.
const getOutboundNumberId = (restaurant) => {
  const mkt = restaurant?.marketingPhoneNumberId;
  if (typeof mkt === 'string' && mkt.length > 0) return mkt;
  return restaurant?.phoneNumberId || restaurant?.phone_number_id || null;
};

module.exports = { sendMsg, sendMessage, sendText, sendButtons, sendList, sendAddressList, sendAddressRequest, sendLocationRequest, sendCatalog, sendMPM, sendPaymentRequest, sendStatusUpdate, sendTemplate, sendCouponTemplate, sendCheckoutButtonTemplate, sendFlow, sendDocument, markRead, showTyping, getOutboundNumberId };