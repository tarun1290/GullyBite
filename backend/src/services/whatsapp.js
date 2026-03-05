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
        name: 'catalog_message',
        parameters: { thumbnail_product_retailer_id: '' },
      },
    },
  });

// ─── ORDER SUMMARY ────────────────────────────────────────────
// Shows cart items + total with Confirm/Cancel buttons
// items: [{ name, qty, price }]
const sendOrderSummary = (pid, token, to, { orderNumber, items, subtotal, deliveryFee, total }) => {
  const lines = items.map((i) => `• ${i.name} ×${i.qty} — ₹${i.price}`).join('\n');
  return sendButtons(pid, token, to, {
    header: `🛒 Order #${orderNumber}`,
    body: `*Your Order:*\n${lines}\n\n` +
          `Subtotal: ₹${subtotal}\n` +
          `Delivery: ₹${deliveryFee}\n` +
          `*Total: ₹${total}*\n\n` +
          `Ready to pay? Tap Confirm to get your payment link.`,
    footer: 'UPI • Cards • Netbanking • Wallets',
    buttons: [
      { id: 'CONFIRM_ORDER', title: '✅ Confirm & Pay' },
      { id: 'CANCEL_ORDER', title: '❌ Cancel' },
    ],
  });
};

// ─── PAYMENT LINK ─────────────────────────────────────────────
// Sends the Razorpay link to the customer
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

// ─── MARK AS READ ─────────────────────────────────────────────
// Shows blue double-tick on the customer's screen
// Always call this when you receive a message — it's good UX
const markRead = (pid, token, messageId) =>
  axios.post(apiUrl(pid), { messaging_product: 'whatsapp', status: 'read', message_id: messageId }, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {}); // Ignore errors silently

module.exports = { sendText, sendButtons, sendLocationRequest, sendCatalog, sendOrderSummary, sendPaymentLink, sendStatusUpdate, markRead };