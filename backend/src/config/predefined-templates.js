// src/config/predefined-templates.js
// Pre-built WhatsApp message template definitions for common restaurant operations.
// Admin picks from this gallery → customizes → submits to Meta for approval.

'use strict';

module.exports = [
  // ─── ORDER LIFECYCLE (UTILITY) ─────────────────────────────
  {
    id: 'order_confirmed',
    name: 'order_confirmed',
    display_name: 'Order Confirmed',
    description: 'Sent when a restaurant confirms a customer order',
    category: 'UTILITY',
    language: 'en',
    components: [
      { type: 'HEADER', format: 'TEXT', text: '\u2705 Order Confirmed' },
      { type: 'BODY', text: 'Hi {{1}}, your order #{{2}} worth \u20B9{{3}} from {{4}} is confirmed! Estimated delivery: {{5}} minutes.' },
      { type: 'FOOTER', text: 'Powered by GullyBite' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Track Order' }] },
    ],
    variables: [
      { position: 1, source: 'customer.name', sample: 'Tarun' },
      { position: 2, source: 'order.order_number', sample: 'ZM-20260404-0001' },
      { position: 3, source: 'order.total_rs', sample: '718' },
      { position: 4, source: 'restaurant.business_name', sample: 'Beyond Snacks' },
      { position: 5, source: 'order.eta_text', sample: '30-45' },
    ],
    suggested_event: 'order_confirmed',
  },
  {
    id: 'order_preparing',
    name: 'order_preparing',
    display_name: 'Order Preparing',
    description: 'Sent when the restaurant starts preparing the order',
    category: 'UTILITY',
    language: 'en',
    components: [
      { type: 'BODY', text: 'Hi {{1}}, your order #{{2}} is being prepared by the kitchen at {{3}}. We\'ll let you know once it\'s ready! \uD83C\uDF73' },
    ],
    variables: [
      { position: 1, source: 'customer.name', sample: 'Tarun' },
      { position: 2, source: 'order.order_number', sample: 'ZM-20260404-0001' },
      { position: 3, source: 'restaurant.business_name', sample: 'Beyond Snacks' },
    ],
    suggested_event: 'order_preparing',
  },
  {
    id: 'order_dispatched',
    name: 'order_dispatched',
    display_name: 'Order Dispatched',
    description: 'Sent when the delivery rider picks up the order',
    category: 'UTILITY',
    language: 'en',
    components: [
      { type: 'BODY', text: 'Hi {{1}}, your order #{{2}} is on the way! \uD83D\uDE80 Your delivery partner {{3}} ({{4}}) is heading to you.' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Track Order' }] },
    ],
    variables: [
      { position: 1, source: 'customer.name', sample: 'Tarun' },
      { position: 2, source: 'order.order_number', sample: 'ZM-20260404-0001' },
      { position: 3, source: 'rider.name', sample: 'Raju' },
      { position: 4, source: 'rider.phone', sample: '9876543210' },
    ],
    suggested_event: 'order_dispatched',
  },
  {
    id: 'order_delivered',
    name: 'order_delivered',
    display_name: 'Order Delivered',
    description: 'Sent after the order is delivered',
    category: 'UTILITY',
    language: 'en',
    components: [
      { type: 'BODY', text: 'Hi {{1}}, your order #{{2}} has been delivered! \uD83C\uDF89 We hope you enjoy your meal from {{3}}. Rate your experience by replying with 1-5 \u2B50' },
    ],
    variables: [
      { position: 1, source: 'customer.name', sample: 'Tarun' },
      { position: 2, source: 'order.order_number', sample: 'ZM-20260404-0001' },
      { position: 3, source: 'restaurant.business_name', sample: 'Beyond Snacks' },
    ],
    suggested_event: 'order_delivered',
  },
  {
    id: 'order_cancelled',
    name: 'order_cancelled',
    display_name: 'Order Cancelled',
    description: 'Sent when an order is cancelled',
    category: 'UTILITY',
    language: 'en',
    components: [
      { type: 'BODY', text: 'Hi {{1}}, your order #{{2}} has been cancelled. Reason: {{3}}. If you were charged, a refund will be processed within 5-7 business days.' },
    ],
    variables: [
      { position: 1, source: 'customer.name', sample: 'Tarun' },
      { position: 2, source: 'order.order_number', sample: 'ZM-20260404-0001' },
      { position: 3, source: 'order.cancellation_reason', sample: 'Restaurant closed' },
    ],
    suggested_event: 'order_cancelled',
  },
  {
    id: 'refund_processed',
    name: 'refund_processed',
    display_name: 'Refund Processed',
    description: 'Sent when a refund is issued',
    category: 'UTILITY',
    language: 'en',
    components: [
      { type: 'BODY', text: 'Hi {{1}}, a refund of \u20B9{{2}} for order #{{3}} has been processed. It will reflect in your account within 5-7 business days. \uD83D\uDCB0' },
    ],
    variables: [
      { position: 1, source: 'customer.name', sample: 'Tarun' },
      { position: 2, source: 'order.refund_amount_rs', sample: '350' },
      { position: 3, source: 'order.order_number', sample: 'ZM-20260404-0001' },
    ],
    suggested_event: 'refund_processed',
  },
  {
    id: 'payment_reminder',
    name: 'payment_reminder',
    display_name: 'Payment Reminder',
    description: 'Sent when order is awaiting payment',
    category: 'UTILITY',
    language: 'en',
    components: [
      { type: 'BODY', text: 'Hi {{1}}, your order #{{2}} worth \u20B9{{3}} is awaiting payment. Complete your payment to confirm the order! \u23F3' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Pay Now' }] },
    ],
    variables: [
      { position: 1, source: 'customer.name', sample: 'Tarun' },
      { position: 2, source: 'order.order_number', sample: 'ZM-20260404-0001' },
      { position: 3, source: 'order.total_rs', sample: '718' },
    ],
    suggested_event: 'payment_reminder',
  },

  // ─── CART RECOVERY (MARKETING) ─────────────────────────────
  {
    id: 'cart_recovery_reminder',
    name: 'cart_recovery_reminder',
    display_name: 'Cart Recovery',
    description: 'Sent to customers who abandoned their cart (24h+ window)',
    category: 'MARKETING',
    language: 'en',
    components: [
      { type: 'BODY', text: 'Hi {{1}}, you left {{2}} items (\u20B9{{3}}) in your cart at {{4}}. Your favorites are waiting \u2014 reply to complete your order! \uD83C\uDF7D\uFE0F' },
      { type: 'FOOTER', text: 'Reply STOP to opt out' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Order Now' }] },
    ],
    variables: [
      { position: 1, source: 'customer.name', sample: 'Tarun' },
      { position: 2, source: 'item_count', sample: '3' },
      { position: 3, source: 'cart_total', sample: '718' },
      { position: 4, source: 'restaurant.business_name', sample: 'Beyond Snacks' },
    ],
    suggested_event: 'cart_recovery',
  },

  // ─── CUSTOMER ENGAGEMENT (MARKETING) ──────────────────────
  {
    id: 'welcome_new_customer',
    name: 'welcome_new_customer',
    display_name: 'Welcome New Customer',
    description: 'Sent to first-time customers',
    category: 'MARKETING',
    language: 'en',
    components: [
      { type: 'HEADER', format: 'TEXT', text: '\uD83C\uDF89 Welcome to {{1}}!' },
      { type: 'BODY', text: 'Hi {{2}}, thanks for choosing us! Browse our menu anytime by sending "Menu". Your first order is just a message away! \uD83C\uDF7D\uFE0F' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'View Menu' }] },
    ],
    variables: [
      { position: 1, source: 'restaurant.business_name', sample: 'Beyond Snacks' },
      { position: 2, source: 'customer.name', sample: 'Tarun' },
    ],
    suggested_event: 'welcome',
  },
  {
    id: 'reorder_suggestion',
    name: 'reorder_suggestion',
    display_name: 'Re-order Suggestion',
    description: 'Sent to inactive customers to encourage repeat orders',
    category: 'MARKETING',
    language: 'en',
    components: [
      { type: 'BODY', text: 'Hi {{1}}, it\'s been a while! Missing your favorites from {{2}}? \uD83D\uDE0B Reply "Menu" to browse and reorder!' },
      { type: 'FOOTER', text: 'Reply STOP to opt out' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Order Again' }] },
    ],
    variables: [
      { position: 1, source: 'customer.name', sample: 'Tarun' },
      { position: 2, source: 'restaurant.business_name', sample: 'Beyond Snacks' },
    ],
    suggested_event: 'reorder_suggestion',
  },

  // ─── OPERATIONS (UTILITY) ──────────────────────────────────
  {
    id: 'delivery_otp',
    name: 'delivery_otp',
    display_name: 'Delivery OTP',
    description: 'OTP for delivery verification',
    category: 'UTILITY',
    language: 'en',
    components: [
      { type: 'BODY', text: 'Hi {{1}}, your delivery OTP for order #{{2}} is: {{3}}. Share this with the delivery partner to complete delivery.' },
    ],
    variables: [
      { position: 1, source: 'customer.name', sample: 'Tarun' },
      { position: 2, source: 'order.order_number', sample: 'ZM-20260404-0001' },
      { position: 3, source: 'delivery_otp', sample: '4821' },
    ],
    suggested_event: 'delivery_otp',
  },
  {
    id: 'feedback_request',
    name: 'feedback_request',
    display_name: 'Feedback Request',
    description: 'Ask for rating after delivery',
    category: 'UTILITY',
    language: 'en',
    components: [
      { type: 'BODY', text: 'Hi {{1}}, how was your recent order from {{2}}? We\'d love your feedback! Reply with a rating from 1-5 \u2B50' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Rate Now' }] },
    ],
    variables: [
      { position: 1, source: 'customer.name', sample: 'Tarun' },
      { position: 2, source: 'restaurant.business_name', sample: 'Beyond Snacks' },
    ],
    suggested_event: 'feedback_request',
  },
];
