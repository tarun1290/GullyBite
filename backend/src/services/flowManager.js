// src/services/flowManager.js
// WhatsApp Flow management — creates, updates, and publishes Flows via Meta API.
// This file manages the Delivery Address Flow (no-endpoint, client-side Flow).

const axios = require('axios');
const metaConfig = require('../config/meta');
const { col } = require('../config/database');
const FormData = require('form-data');

// ─── FLOW JSON DEFINITION ────────────────────────────────────
// Version 6.2 for NavigationList support.
// Two paths: SAVED_ADDRESSES → CONFIRM_DELIVERY, or NEW_ADDRESS → complete.
// NavigationList CANNOT be on a terminal screen, so SAVED_ADDRESSES navigates
// to a minimal CONFIRM_DELIVERY terminal screen.
function buildDeliveryFlowJson() {
  return {
    version: '6.2',
    screens: [
      {
        id: 'SAVED_ADDRESSES',
        title: 'Deliver To',
        terminal: false,
        data: {
          addresses: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                'main-content': {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    description: { type: 'string' },
                    metadata: { type: 'string' },
                  },
                },
                badge: { type: 'string' },
              },
            },
            __example__: [
              {
                id: 'addr_1',
                'main-content': { title: 'Home', description: 'Banjara Hills', metadata: '123 Main St, Hyderabad 500034' },
                badge: 'Default',
              },
              {
                id: 'new_address',
                'main-content': { title: 'Add New Address', description: 'New location', metadata: 'Enter address or Maps link' },
              },
            ],
          },
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            {
              type: 'NavigationList',
              name: 'selected_address',
              label: 'Your saved addresses',
              description: 'Where to deliver?',
              'list-items': '${data.addresses}',
              'on-click-action': {
                name: 'navigate',
                next: { type: 'screen', name: 'CONFIRM_DELIVERY' },
                payload: {
                  address_id: '${form.selected_address}',
                },
              },
            },
          ],
        },
      },
      {
        id: 'CONFIRM_DELIVERY',
        title: 'Delivery Address',
        terminal: true,
        success: true,
        data: {
          address_id: { type: 'string', __example__: 'addr_1' },
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            {
              type: 'TextHeading',
              text: 'Continue',
            },
            {
              type: 'TextBody',
              text: 'Tap below to proceed.',
            },
            {
              type: 'Footer',
              label: 'Continue',
              'on-click-action': {
                name: 'complete',
                payload: {
                  action: 'select_address',
                  selected_address_id: '${data.address_id}',
                },
              },
            },
          ],
        },
      },
      {
        id: 'NEW_ADDRESS',
        title: 'New Address',
        terminal: true,
        success: true,
        layout: {
          type: 'SingleColumnLayout',
          children: [
            {
              type: 'TextHeading',
              text: 'Add delivery address',
            },
            {
              type: 'TextBody',
              text: 'Paste a Google Maps link or type your address',
            },
            {
              type: 'TextInput',
              label: 'Google Maps link',
              'input-type': 'text',
              name: 'maps_link',
              required: false,
              'helper-text': 'e.g. maps.app.goo.gl/abc123',
            },
            {
              type: 'TextInput',
              label: 'Full address',
              'input-type': 'text',
              name: 'manual_address',
              required: false,
              'helper-text': 'Street, area, city, pincode',
            },
            {
              type: 'TextInput',
              label: 'Flat / Floor / Landmark',
              'input-type': 'text',
              name: 'address_line2',
              required: false,
            },
            {
              type: 'Dropdown',
              label: 'Save as',
              name: 'address_label',
              required: true,
              'data-source': [
                { id: 'Home', title: 'Home' },
                { id: 'Office', title: 'Office' },
                { id: 'Other', title: 'Other' },
              ],
            },
            {
              type: 'Footer',
              label: 'Deliver Here',
              'on-click-action': {
                name: 'complete',
                payload: {
                  action: 'new_address',
                  maps_link: '${form.maps_link}',
                  manual_address: '${form.manual_address}',
                  address_line2: '${form.address_line2}',
                  address_label: '${form.address_label}',
                },
              },
            },
          ],
        },
      },
    ],
  };
}

// ─── CREATE FLOW ─────────────────────────────────────────────
async function createDeliveryFlow(wabaId) {
  const token = metaConfig.getMessagingToken();
  const flowJson = buildDeliveryFlowJson();

  console.log('[Flow] Creating delivery address Flow for WABA:', wabaId);

  const { data } = await axios.post(`${metaConfig.graphUrl}/${wabaId}/flows`, {
    name: 'GullyBite Delivery Address',
    categories: ['OTHER'],
    flow_json: JSON.stringify(flowJson),
  }, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 15000,
  });

  if (data.error) {
    console.error('[Flow] Creation failed:', JSON.stringify(data.error));
    if (data.validation_errors?.length) {
      for (const err of data.validation_errors) {
        console.error(`[Flow Validation] ${err.error}: ${err.message} at ${err.pointers?.[0]?.path || 'unknown'}`);
      }
    }
    return { success: false, error: data.error, validation_errors: data.validation_errors };
  }

  const flowId = data.id;
  console.log('[Flow] Created with ID:', flowId);

  // Publish the Flow
  try {
    await axios.post(`${metaConfig.graphUrl}/${flowId}/publish`, {}, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    });
    console.log('[Flow] Published successfully');
  } catch (pubErr) {
    console.error('[Flow] Publish failed (Flow created as draft):', pubErr.response?.data || pubErr.message);
    return { success: true, flowId, published: false, error: pubErr.response?.data };
  }

  return { success: true, flowId, published: true };
}

// ─── UPDATE FLOW JSON ────────────────────────────────────────
async function updateFlowJson(flowId) {
  const token = metaConfig.getMessagingToken();
  const flowJson = buildDeliveryFlowJson();

  const form = new FormData();
  form.append('file', Buffer.from(JSON.stringify(flowJson)), {
    filename: 'flow.json',
    contentType: 'application/json',
  });
  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');

  const { data } = await axios.post(`${metaConfig.graphUrl}/${flowId}/assets`, form, {
    headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() },
    timeout: 15000,
  });

  console.log('[Flow] Updated JSON for Flow:', flowId);
  return data;
}

// ─── PUBLISH FLOW ────────────────────────────────────────────
async function publishFlow(flowId) {
  const token = metaConfig.getMessagingToken();
  const { data } = await axios.post(`${metaConfig.graphUrl}/${flowId}/publish`, {}, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 10000,
  });
  return data;
}

// ─── GET FLOW PREVIEW ────────────────────────────────────────
async function getFlowPreview(flowId) {
  const token = metaConfig.getMessagingToken();
  const { data } = await axios.get(`${metaConfig.graphUrl}/${flowId}`, {
    params: { fields: 'id,name,status,categories,preview.invalidate(false)' },
    headers: { Authorization: `Bearer ${token}` },
    timeout: 10000,
  });
  return data;
}

// ─── DEPRECATE FLOW ──────────────────────────────────────────
async function deprecateFlow(flowId) {
  const token = metaConfig.getMessagingToken();
  const { data } = await axios.post(`${metaConfig.graphUrl}/${flowId}/deprecate`, {}, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 10000,
  });
  return data;
}

// ─── FORMAT ADDRESSES FOR FLOW ───────────────────────────────
// Converts saved addresses from DB format to NavigationList item format.
// Respects NavigationList limits: title=30, description=20, metadata=80.
function formatAddressesForFlow(addresses) {
  const items = addresses.slice(0, 19).map(addr => ({
    id: String(addr._id || addr.id),
    'main-content': {
      title: (addr.label || 'Saved').substring(0, 30),
      description: (addr.area || addr.city || addr.full_address?.split(',')[1]?.trim() || '').substring(0, 20),
      metadata: (addr.full_address || addr.address || '').substring(0, 80),
    },
    ...(addr.is_default ? { badge: 'Default' } : {}),
  }));

  // Add "New Address" as last item (max 20 total)
  items.push({
    id: 'new_address',
    'main-content': {
      title: '+ Add New Address',
      description: 'New location',
      metadata: 'Enter a Google Maps link or type your address',
    },
  });

  return items;
}

// ─── FEEDBACK/RATING FLOW ────────────────────────────────────
function buildFeedbackFlowJson() {
  return {
    version: '6.2',
    screens: [
      {
        id: 'RATING_SCREEN',
        title: 'Rate Your Order',
        terminal: true,
        success: true,
        data: {
          order_number: { type: 'string', __example__: '#ZM-20260328-0001' },
          order_id: { type: 'string', __example__: 'ord_123' },
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextHeading', text: 'How was your order?' },
            { type: 'TextBody', text: 'Your feedback helps improve the experience for everyone.' },
            {
              type: 'Dropdown', label: 'Food Quality', name: 'food_rating', required: true,
              'data-source': [
                { id: '5', title: '⭐⭐⭐⭐⭐ Excellent' },
                { id: '4', title: '⭐⭐⭐⭐ Great' },
                { id: '3', title: '⭐⭐⭐ Good' },
                { id: '2', title: '⭐⭐ Fair' },
                { id: '1', title: '⭐ Poor' },
              ],
            },
            {
              type: 'Dropdown', label: 'Delivery Experience', name: 'delivery_rating', required: true,
              'data-source': [
                { id: '5', title: '⭐⭐⭐⭐⭐ Excellent' },
                { id: '4', title: '⭐⭐⭐⭐ Great' },
                { id: '3', title: '⭐⭐⭐ Good' },
                { id: '2', title: '⭐⭐ Fair' },
                { id: '1', title: '⭐ Poor' },
              ],
            },
            { type: 'TextInput', label: 'Comments (optional)', 'input-type': 'text', name: 'comment', required: false, 'helper-text': 'Tell us more about your experience' },
            {
              type: 'Footer', label: 'Submit Rating',
              'on-click-action': {
                name: 'complete',
                payload: {
                  food_rating: '${form.food_rating}',
                  delivery_rating: '${form.delivery_rating}',
                  comment: '${form.comment}',
                },
              },
            },
          ],
        },
      },
    ],
  };
}

async function createFeedbackFlow(wabaId) {
  const token = metaConfig.getMessagingToken();
  const flowJson = buildFeedbackFlowJson();

  console.log('[Flow] Creating feedback Flow for WABA:', wabaId);

  try {
    const { data } = await axios.post(
      `${metaConfig.graphUrl}/${wabaId}/flows`,
      { name: 'GullyBite Order Rating', categories: ['OTHER'], flow_json: JSON.stringify(flowJson), publish: true },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20000 }
    );
    console.log('[Flow] Feedback Flow created:', data.id);
    return { success: true, flowId: data.id, published: !data.validation_errors?.length };
  } catch (err) {
    console.error('[Flow] Feedback Flow creation failed:', err.response?.data || err.message);
    return { success: false, error: err.response?.data?.error?.message || err.message, validation_errors: err.response?.data?.validation_errors };
  }
}

module.exports = {
  buildDeliveryFlowJson,
  createDeliveryFlow,
  updateFlowJson,
  publishFlow,
  getFlowPreview,
  deprecateFlow,
  formatAddressesForFlow,
  buildFeedbackFlowJson,
  createFeedbackFlow,
};
