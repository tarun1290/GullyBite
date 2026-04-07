// src/services/whatsapp.js
// All outgoing WhatsApp messages via Meta Cloud API
// Think of this as the "messenger" layer — just sends messages, no business logic

const axios = require('axios');
const metaConfig = require('../config/meta');

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
    console.log(`[Perf] WA send to ${to}: ${Date.now() - start}ms`);
    return data;
  } catch (err) {
    const e = err.response?.data?.error;
    console.error(`[WA] ❌ Send failed to ${to} (${Date.now() - start}ms): code=${e?.code} msg=${e?.message}`);
    // Retry once on timeout or 5xx
    if (!_retried && (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || (err.response?.status >= 500))) {
      console.log('[WA] Retrying send after 1s...');
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
  console.log(`[Catalog-DEBUG] sendCatalog: catalogId=${catalogId} to=${to}`);
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
  console.log(`[MPM-DEBUG] sendMPM: catalog=${safeCatalogId} sections=${safeSections.length} products=${totalProducts}`);
  if (!safeCatalogId) { console.error('[MPM-VALIDATION] No catalog_id — cannot send MPM'); return Promise.reject(new Error('Missing catalog_id')); }
  if (!safeSections.length) { console.error('[MPM-VALIDATION] No valid sections — cannot send MPM'); return Promise.reject(new Error('No sections')); }
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
    country_of_origin: 'IN',
    importer_name: (restaurantName || order.business_name || order.branch_name || 'Restaurant').substring(0, 100),
    importer_address: { address_line1: 'India', city: 'India', zone_code: 'TS', postal_code: '500001', country_code: 'IN' },
  }));

  const subtotalPaise = toPaise(order.subtotal_rs);
  const shippingPaise = toPaise(order.customer_delivery_rs || order.delivery_fee_rs || 0);
  const taxPaise = toPaise((order.food_gst_rs || 0) + (order.customer_delivery_gst_rs || 0) + (order.packaging_gst_rs || 0));
  const totalPaise = toPaise(order.total_rs);
  const discountRs = order.discount_rs || 0;

  const orderPayload = {
    status: 'pending',
    items: orderItems,
    subtotal: { value: subtotalPaise, offset: 100 },
    shipping: { value: shippingPaise, offset: 100 },
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
  console.log(`[Payment] Sending order_details to ${to}, ref=${refId}, total=₹${order.total_rs}`);

  return sendMsg(pid, token, to, {
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
          payment_configuration: configName,
          currency: 'INR',
          total_amount: { value: totalPaise, offset: 100 },
          order: orderPayload,
          payment_settings: [{
            type: 'payment_gateway',
            payment_gateway: { type: 'razorpay', configuration_name: configName },
          }],
        },
      },
    },
  });
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

  const uploadUrl = `https://graph.facebook.com/${process.env.WA_API_VERSION}/${pid}/media`;
  const { data: media } = await axios.post(uploadUrl, form, {
    headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() },
    timeout: 30000,
  });

  return sendMsg(pid, token, to, {
    type: 'document',
    document: { id: media.id, filename, ...(caption && { caption }) },
  });
};

// DEPRECATED: sendCheckoutOrder and sendCheckoutTemplate removed — sendPaymentRequest is the single checkout function

module.exports = { sendMsg, sendText, sendButtons, sendList, sendAddressList, sendAddressRequest, sendLocationRequest, sendCatalog, sendMPM, sendPaymentRequest, sendStatusUpdate, sendTemplate, sendFlow, sendDocument, markRead, showTyping };