// src/services/whatsapp.js
// All outgoing WhatsApp messages via Meta Cloud API
// Think of this as the "messenger" layer — just sends messages, no business logic

const axios = require('axios');

// Build the messages API URL for a given phone number
const apiUrl = (phoneNumberId) =>
  `https://graph.facebook.com/${process.env.WA_API_VERSION}/${phoneNumberId}/messages`;

// ─── CORE SEND FUNCTION ───────────────────────────────────────
// All functions below call this one.
// phoneNumberId: Your Meta phone number ID (from developer console)
// accessToken:   Restaurant's Meta access token
// to:            Customer's phone number (with country code, no + sign)
// body:          Message payload (different per message type)
const sendMsg = async (phoneNumberId, accessToken, to, body) => {
  const payload = { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...body };
  try {
    const { data } = await axios.post(apiUrl(phoneNumberId), payload, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    return data;
  } catch (err) {
    const e = err.response?.data?.error;
    console.error(`[WA] ❌ Send failed to ${to}: code=${e?.code} msg=${e?.message}`);
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
const sendCatalog = (pid, token, to, catalogId, introText) =>
  sendMsg(pid, token, to, {
    type: 'interactive',
    interactive: {
      type: 'catalog_message',
      body: { text: introText || '🍽️ Here is our menu! Browse and add items to your cart.' },
      footer: { text: 'Tap any item to view details and add to cart' },
      action: {
        name      : 'catalog_message',
        parameters: { catalog_id: catalogId, thumbnail_product_retailer_id: '' },
      },
    },
  });

// ─── ORDER SUMMARY ────────────────────────────────────────────
// Shows cart items + total with Confirm/Cancel/Coupon buttons
// items: [{ name, qty, price }]
// discount: optional { code, amountRs }
const sendOrderSummary = (pid, token, to, { orderNumber, items, subtotal, deliveryFee, total, discount }) => {
  const lines = items.map((i) => `• ${i.name} ×${i.qty} — ₹${i.price}`).join('\n');
  let financials = `Subtotal: ₹${subtotal}\n`;
  if (discount && discount.amountRs > 0) {
    financials += `🎟 Coupon (${discount.code}): -₹${parseFloat(discount.amountRs).toFixed(0)}\n`;
  }
  financials += `Delivery: ₹${deliveryFee}\n*Total: ₹${total}*`;

  const buttons = [{ id: 'CONFIRM_ORDER', title: '✅ Confirm & Pay' }];
  if (discount && discount.amountRs > 0) {
    buttons.push({ id: 'REMOVE_COUPON', title: '🗑 Remove Coupon' });
  } else {
    buttons.push({ id: 'APPLY_COUPON',  title: '🎟 Apply Coupon' });
  }
  buttons.push({ id: 'CANCEL_ORDER', title: '❌ Cancel' });

  return sendButtons(pid, token, to, {
    header: `🛒 Order #${orderNumber}`,
    body: `*Your Order:*\n${lines}\n\n${financials}\n\nReady to pay? Tap Confirm to pay securely inside WhatsApp.`,
    footer: 'UPI • WhatsApp Pay • Cards',
    buttons,
  });
};

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
const sendPaymentRequest = (pid, token, to, { order, items }) => {
  const expiryMins = parseInt(process.env.PAYMENT_LINK_EXPIRY_MINS) || 15;
  const expiryTs   = String(Math.floor(Date.now() / 1000) + expiryMins * 60);

  const orderItems = items.map((i) => ({
    retailer_id : i.retailer_id || i.menu_item_id || i.item_name,
    name        : i.item_name,
    amount      : { value: Math.round(i.unit_price_rs * 100), offset: 100 },
    quantity    : i.quantity,
    sale_amount : { value: Math.round(i.line_total_rs * 100), offset: 100 },
  }));

  return sendMsg(pid, token, to, {
    type: 'interactive',
    interactive: {
      type  : 'order_details',
      body  : { text: `Your order from *${order.branch_name}* is ready!\nReview and pay securely inside WhatsApp.` },
      footer: { text: 'GullyBite × Razorpay — 100% secure' },
      action: {
        name      : 'review_and_pay',
        parameters: {
          reference_id    : order.order_number,
          type            : 'digital-goods',
          payment_settings: [{
            type           : 'payment_gateway',
            payment_gateway: {
              type              : 'razorpay',
              configuration_name: process.env.RAZORPAY_WA_CONFIG_NAME,
              razorpay          : {
                receipt: order.order_number,
                notes  : { order_id: order.id, order_number: order.order_number },
              },
            },
          }],
          currency    : 'INR',
          total_amount: { value: Math.round(order.total_rs * 100), offset: 100 },
          order: {
            status    : 'pending',
            expiration: { timestamp: expiryTs, description: 'Order expires if unpaid' },
            items     : orderItems,
            subtotal  : { value: Math.round(order.subtotal_rs * 100),       offset: 100 },
            shipping  : { value: Math.round(order.delivery_fee_rs * 100),    offset: 100 },
            discount  : { value: Math.round((order.discount_rs || 0) * 100), offset: 100 },
            tax       : { value: 0, offset: 100 },
          },
        },
      },
    },
  });
};

// ─── PAYMENT LINK (fallback) ───────────────────────────────────
// Used when WhatsApp Pay is not available / not yet enabled.
// Sends a plain Razorpay short URL the customer opens in a browser.
const sendPaymentLink = (pid, token, to, { orderNumber, total, url, expiryMins }) =>
  sendText(pid, token, to,
    `💳 *Payment Link — Order #${orderNumber}*\n\n` +
    `Amount: *₹${total}*\n\n` +
    `Pay securely:\n${url}\n\n` +
    `⏱ Expires in ${expiryMins} minutes\n` +
    `_Powered by Razorpay_`
  );

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

// ─── MARK AS READ ─────────────────────────────────────────────
// Shows blue double-tick on the customer's screen
// Always call this when you receive a message — it's good UX
const markRead = (pid, token, messageId) =>
  axios.post(apiUrl(pid), { messaging_product: 'whatsapp', status: 'read', message_id: messageId }, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {}); // Ignore errors silently

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

module.exports = { sendText, sendButtons, sendAddressList, sendLocationRequest, sendCatalog, sendOrderSummary, sendPaymentRequest, sendPaymentLink, sendStatusUpdate, sendTemplate, markRead };