// ═══════════════════════════════════════════════════════════════
// DELIVERY PROVIDER TEMPLATE
// ═══════════════════════════════════════════════════════════════
//
// THIS FILE IS NOT EXECUTABLE CODE — it is a reference document
// for integrating a new 3PL delivery partner into GullyBite.
//
// HOW TO ADD A NEW PROVIDER:
// 1. Copy this file → rename to provider name (e.g., dunzo.js, shadowfax.js, borzo.js)
// 2. Fill in the API endpoints, auth, request/response mappings below
// 3. Register in services/delivery/index.js:
//      const myProvider = require('./myProvider');
//      PROVIDERS.myProvider = myProvider;
// 4. Set DEFAULT_DELIVERY_PROVIDER=myProvider in .env
// 5. Add env vars: DELIVERY_API_KEY, DELIVERY_BASE_URL, DELIVERY_WEBHOOK_SECRET
// 6. Configure the provider's dashboard to send webhooks to: {BASE_URL}/webhooks/delivery
//
// REQUIRED EXPORTS: getQuote, createTask, cancelTask, getTaskStatus, normalizeStatus
// ═══════════════════════════════════════════════════════════════

'use strict';

// const axios = require('axios');

// ─── CONFIGURATION ──────────────────────────────────────────
// Read from environment variables — never hardcode
// const API_KEY = process.env.DELIVERY_API_KEY;
// const BASE_URL = process.env.DELIVERY_BASE_URL || 'https://api.provider.com';

// ─── GET QUOTE ──────────────────────────────────────────────
// Called during cart building to show the customer a delivery fee.
//
// Input:
//   pickup: { lat, lng, address, contactName, contactPhone }
//   drop:   { lat, lng, address, contactName, contactPhone }
//   orderDetails: { orderId, itemCount, orderValueRs }
//
// Output:
//   { deliveryFeeRs, estimatedMins, distanceKm, quoteId, expiresAt, surgeActive, providerName }
//
// Provider API call example:
//   POST {BASE_URL}/v1/quotes
//   Headers: { Authorization: `Bearer ${API_KEY}` }
//   Body: { pickup_lat, pickup_lng, drop_lat, drop_lng, ... }
//   Response: { quote_id, fee, eta_minutes, distance_km, surge }
//
async function getQuote(pickup, drop, orderDetails = {}) {
  throw new Error('Not implemented — replace with actual provider API call');
}

// ─── CREATE TASK (DISPATCH) ─────────────────────────────────
// Called after payment to dispatch a rider.
//
// Input:
//   pickup, drop, orderDetails (same as getQuote)
//   quoteId: the quoteId from getQuote (some providers require it)
//
// Output:
//   { taskId, trackingUrl, estimatedMins, status: 'assigned' }
//
// Provider API call example:
//   POST {BASE_URL}/v1/tasks
//   Body: { quote_id, pickup: {...}, drop: {...}, order_value, ... }
//   Response: { task_id, tracking_link, eta, status }
//
async function createTask(pickup, drop, orderDetails = {}, quoteId = null) {
  throw new Error('Not implemented — replace with actual provider API call');
}

// ─── CANCEL TASK ────────────────────────────────────────────
// Called to cancel an active delivery.
//
// Input:  taskId (the provider's task/order ID)
// Output: { success: boolean, refundable: boolean }
//
// Provider API call example:
//   POST {BASE_URL}/v1/tasks/{taskId}/cancel
//   Response: { success, refund_amount }
//
async function cancelTask(taskId) {
  throw new Error('Not implemented — replace with actual provider API call');
}

// ─── GET TASK STATUS ────────────────────────────────────────
// Called to fetch live delivery status.
//
// Input:  taskId
// Output: { status, driverName, driverPhone, driverLat, driverLng, estimatedMins, trackingUrl }
//
// Provider API call example:
//   GET {BASE_URL}/v1/tasks/{taskId}
//   Response: { status, rider: { name, phone, lat, lng }, eta }
//
async function getTaskStatus(taskId) {
  throw new Error('Not implemented — replace with actual provider API call');
}

// ─── NORMALIZE STATUS ───────────────────────────────────────
// Maps provider-specific status strings to GullyBite's standard set.
//
// Standard statuses: pending, assigned, picked_up, in_transit, delivered, failed, cancelled
//
// Example mapping (replace with actual provider statuses):
//   'ACCEPTED' → 'assigned'
//   'PICKED_UP' | 'AT_PICKUP' → 'picked_up'
//   'IN_TRANSIT' | 'ON_THE_WAY' → 'in_transit'
//   'DELIVERED' | 'COMPLETED' → 'delivered'
//   'CANCELLED' | 'REJECTED' → 'cancelled'
//   'FAILED' | 'RTO' → 'failed'
//
function normalizeStatus(rawStatus) {
  const map = {
    // Replace with actual provider status values:
    // 'ACCEPTED': 'assigned',
    // 'PICKED_UP': 'picked_up',
    // 'IN_TRANSIT': 'in_transit',
    // 'DELIVERED': 'delivered',
    // 'CANCELLED': 'cancelled',
    // 'FAILED': 'failed',
  };
  return map[rawStatus] || 'pending';
}

// ─── WEBHOOK CONFIGURATION ──────────────────────────────────
// In the provider's dashboard, set the webhook URL to:
//   {BASE_URL}/webhooks/delivery
//
// The webhook handler in webhooks/delivery.js will:
// 1. Extract the task ID and status from the webhook payload
// 2. Call normalizeStatus() to convert to standard statuses
// 3. Update the delivery and order records accordingly
//
// If the provider uses webhook signature verification, add DELIVERY_WEBHOOK_SECRET
// to .env and validate in the webhook handler.

// ─── ENVIRONMENT VARIABLES ──────────────────────────────────
// Add these to .env:
//   DEFAULT_DELIVERY_PROVIDER=providerName
//   DELIVERY_API_KEY=your-api-key
//   DELIVERY_BASE_URL=https://api.provider.com
//   DELIVERY_WEBHOOK_SECRET=your-webhook-secret (if provider signs webhooks)

module.exports = { getQuote, createTask, cancelTask, getTaskStatus, normalizeStatus };
