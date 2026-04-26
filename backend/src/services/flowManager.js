// src/services/flowManager.js
// WhatsApp Flow management — creates, updates, and publishes Flows via Meta API.
// This file manages the Delivery Address Flow.
//
// The address Flow is now ENDPOINT-MODE (v6.2) — JSON lives at
// backend/flows/address-flow.json and the customer-facing search + submit
// path talks to routes/flowAddress.js. buildDeliveryFlowJson() loads that
// file at runtime. createDeliveryFlow + updateFlowJson also set
// endpoint_uri so Meta routes runtime callbacks to us.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const metaConfig = require('../config/meta');
const { col } = require('../config/database');
const FormData = require('form-data');
const log = require('../utils/logger').child({ component: 'Flow' });

// Where the endpoint-mode flow JSON lives on disk.
const ADDRESS_FLOW_JSON_PATH = path.resolve(__dirname, '../../flows/address-flow.json');

// Default endpoint for the address Flow. Overridable per deploy with
// ADDRESS_FLOW_ENDPOINT_URI. Must be HTTPS and reachable from Meta.
function addressFlowEndpointUri() {
  return process.env.ADDRESS_FLOW_ENDPOINT_URI
      || 'https://gullybite.duckdns.org/flow/address';
}

// ─── FLOW JSON DEFINITION ────────────────────────────────────
// Primary source: backend/flows/address-flow.json (endpoint-mode v6.2).
// Falls back to the legacy inline no-endpoint JSON only if the file
// cannot be read — this keeps a working flow available during an aborted
// migration but the file is the canonical source going forward.
function buildDeliveryFlowJson() {
  try {
    if (fs.existsSync(ADDRESS_FLOW_JSON_PATH)) {
      return JSON.parse(fs.readFileSync(ADDRESS_FLOW_JSON_PATH, 'utf8'));
    }
    log.warn({ path: ADDRESS_FLOW_JSON_PATH }, 'address-flow.json missing — falling back to legacy inline JSON');
  } catch (e) {
    log.error({ err: e, path: ADDRESS_FLOW_JSON_PATH }, 'Failed to read address-flow.json — falling back to legacy inline JSON');
  }
  return _legacyInlineDeliveryFlowJson();
}

// Legacy no-endpoint JSON. Retained as a fallback; new deploys should
// push flows/address-flow.json instead. DO NOT extend this — edit the
// JSON file.
function _legacyInlineDeliveryFlowJson() {
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
              text: 'Confirm your selection',
            },
            {
              type: 'TextBody',
              text: 'Tap Continue to proceed with your delivery address.',
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
        title: 'Delivery Address',
        terminal: true,
        success: true,
        data: {
          customer_name: { type: 'string', __example__: 'Tarun' },
          customer_phone: { type: 'string', __example__: '7382773430' },
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            // ── Receiver Details ──
            {
              type: 'TextHeading',
              text: 'Who is receiving?',
            },
            {
              type: 'TextInput',
              label: 'Receiver name',
              'input-type': 'text',
              name: 'receiver_name',
              required: true,
              'init-value': '${data.customer_name}',
              'helper-text': 'Person who will receive the order',
            },
            {
              type: 'TextInput',
              label: 'Receiver phone',
              'input-type': 'phone',
              name: 'receiver_phone',
              required: true,
              'init-value': '${data.customer_phone}',
              'helper-text': "We'll call this number if needed",
            },
            // ── Location Details ──
            {
              type: 'TextHeading',
              text: 'Delivery location',
            },
            {
              type: 'TextInput',
              label: 'Google Maps link',
              'input-type': 'text',
              name: 'maps_link',
              required: false,
              'helper-text': 'Paste a maps.app.goo.gl/... link',
            },
            {
              type: 'TextInput',
              label: 'Flat / Building / Floor',
              'input-type': 'text',
              name: 'building_floor',
              required: true,
              'helper-text': 'e.g. Flat 301, Tower B, 3rd Floor',
            },
            {
              type: 'TextInput',
              label: 'Street / Road',
              'input-type': 'text',
              name: 'street',
              required: false,
            },
            {
              type: 'TextInput',
              label: 'Area / Locality',
              'input-type': 'text',
              name: 'area_locality',
              required: true,
              'helper-text': 'e.g. Madhapur, Banjara Hills',
            },
            {
              type: 'TextInput',
              label: 'City',
              'input-type': 'text',
              name: 'city',
              required: true,
            },
            {
              type: 'TextInput',
              label: 'Pin code',
              'input-type': 'number',
              name: 'pincode',
              required: true,
              'min-chars': 6,
              'max-chars': 6,
              'helper-text': '6-digit postal code',
            },
            {
              type: 'TextInput',
              label: 'Landmark',
              'input-type': 'text',
              name: 'landmark',
              required: false,
              'helper-text': 'e.g. Near Inorbit Mall, Opp Metro',
            },
            // ── Delivery Instructions ──
            {
              type: 'TextInput',
              label: 'Delivery instructions',
              'input-type': 'text',
              name: 'delivery_instructions',
              required: false,
              'helper-text': 'e.g. Ring bell twice, leave at door',
            },
            // ── Save Label ──
            {
              type: 'Dropdown',
              label: 'Save address as',
              name: 'address_type',
              required: true,
              'data-source': [
                { id: 'home', title: '\uD83C\uDFE0 Home' },
                { id: 'office', title: '\uD83C\uDFE2 Office' },
                { id: 'other', title: '\uD83D\uDCCD Other' },
              ],
            },
            {
              type: 'TextInput',
              label: 'Address nickname',
              'input-type': 'text',
              name: 'address_nickname',
              required: false,
              'helper-text': "e.g. Mom's Place, Gym (for Other type)",
            },
            {
              type: 'Footer',
              label: 'Save & Deliver Here',
              'on-click-action': {
                name: 'complete',
                payload: {
                  action: 'new_address',
                  receiver_name: '${form.receiver_name}',
                  receiver_phone: '${form.receiver_phone}',
                  maps_link: '${form.maps_link}',
                  building_floor: '${form.building_floor}',
                  street: '${form.street}',
                  area_locality: '${form.area_locality}',
                  city: '${form.city}',
                  pincode: '${form.pincode}',
                  landmark: '${form.landmark}',
                  delivery_instructions: '${form.delivery_instructions}',
                  address_type: '${form.address_type}',
                  address_nickname: '${form.address_nickname}',
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
// endpointUri (optional) wires Meta's runtime callbacks (INIT /
// data_exchange / BACK) to our backend. Required for endpoint-mode
// flows; harmless for no-endpoint flows (Meta accepts but ignores).
async function createDeliveryFlow(wabaId, { endpointUri } = {}) {
  const token = metaConfig.getMessagingToken();
  const flowJson = buildDeliveryFlowJson();
  const uri = endpointUri || addressFlowEndpointUri();

  log.info({ wabaId, endpoint_uri: uri }, 'Creating delivery address Flow');

  const { data } = await axios.post(`${metaConfig.graphUrl}/${wabaId}/flows`, {
    name: 'GullyBite Delivery Address',
    categories: ['OTHER'],
    flow_json: JSON.stringify(flowJson),
    endpoint_uri: uri,
  }, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 15000,
  });

  if (data.error) {
    log.error({ error: data.error }, 'Flow creation failed');
    if (data.validation_errors?.length) {
      for (const err of data.validation_errors) {
        log.error({ validationError: err.error, path: err.pointers?.[0]?.path }, err.message);
      }
    }
    return { success: false, error: data.error, validation_errors: data.validation_errors };
  }

  const flowId = data.id;
  log.info({ flowId, endpoint_uri: uri }, 'Flow created');

  // Publish the Flow
  try {
    await axios.post(`${metaConfig.graphUrl}/${flowId}/publish`, {}, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    });
    log.info({ flowId }, 'Flow published successfully');
  } catch (pubErr) {
    log.error({ err: pubErr, flowId }, 'Publish failed (Flow created as draft)');
    return { success: true, flowId, published: false, endpoint_uri: uri, error: pubErr.response?.data };
  }

  return { success: true, flowId, published: true, endpoint_uri: uri };
}

// ─── UPDATE FLOW JSON ────────────────────────────────────────
// Uploads the latest JSON to a DRAFT Flow. Also re-sets endpoint_uri
// (Meta allows updating endpoint_uri on a DRAFT via POST /{flow-id}).
async function updateFlowJson(flowId, { endpointUri } = {}) {
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

  const uri = endpointUri || addressFlowEndpointUri();
  try {
    await axios.post(`${metaConfig.graphUrl}/${flowId}`,
      { endpoint_uri: uri },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
    );
    log.info({ flowId, endpoint_uri: uri }, 'Updated Flow JSON + endpoint_uri');
  } catch (e) {
    // Published flows or category mismatches can reject endpoint_uri
    // updates — the JSON asset upload above still succeeded, so log and
    // move on.
    log.warn({ flowId, err: e.response?.data || e.message }, 'endpoint_uri update failed — JSON asset still uploaded');
  }

  return { ...data, endpoint_uri: uri };
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
// Converts saved addresses from DB format to RadioButtonsGroup data-source
// items for the new flow JSON (flat shape: id/title/description/metadata —
// NOT the nested main-content shape used by the older NavigationList).
//
// Title prefers nickname (user-chosen, e.g. "Office", "Mom's house") over
// the Save-as label ("Home" / "Work" / "Other"). Old rows without nickname
// or structured fields fall back to whatever text is available so they
// still render.
//
// The "+ Add new address" synthetic option (id: "NEW") is appended by the
// CALLER (greeting handler), not here, so this function stays a pure
// per-address formatter.
function formatAddressesForFlow(addresses) {
  return addresses.slice(0, 19).map((addr) => {
    // v3 / v1 / v2 fallback chain — never crashes on missing fields
    const recipient  = addr?.recipient_name   || addr?.receiver_name   || '';
    const houseNum   = addr?.house_number     || addr?.building_floor  || addr?.flat_no || '';
    const buildingSt = addr?.building_street  || addr?.street          || '';
    const areaLoc    = addr?.area_locality    || addr?.area            || '';
    const phone      = addr?.delivery_phone   || addr?.receiver_phone  || '';
    const labelText  = addr?.nickname || addr?.label || 'Address';

    const structuredLine = [recipient, houseNum, buildingSt, areaLoc].filter(Boolean).join(', ');
    const description = structuredLine
      || addr?.formatted_address
      || addr?.full_address
      || addr?.address
      || '';

    const metaParts = [
      addr?.city || null,
      addr?.pincode || null,
      phone ? `📞 ${phone}` : null,
    ].filter(Boolean);
    const metadata = metaParts.join(' • ') || addr?.formatted_address || addr?.full_address || '';

    return {
      id: String(addr._id || addr.id),
      title: String(labelText).substring(0, 30),
      description: String(description).substring(0, 80),
      metadata: String(metadata).substring(0, 80),
    };
  });
}

// ─── FEEDBACK/RATING FLOW ────────────────────────────────────
// NOTE: After changing this JSON, you must either:
// 1. Delete the old Flow and create a new one (via admin dashboard -> Create Feedback Flow)
// 2. Or call updateFeedbackFlow(flowId) to update the existing flow on Meta
function buildFeedbackFlowJson() {
  const ratingOptions = [
    { id: '5', title: 'Excellent' },
    { id: '4', title: 'Great' },
    { id: '3', title: 'Good' },
    { id: '2', title: 'Fair' },
    { id: '1', title: 'Poor' },
  ];
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
            { type: 'TextBody', text: 'Rate each aspect to help us improve' },
            { type: 'Dropdown', label: 'Taste & Food Quality', name: 'taste_rating', required: true, 'data-source': ratingOptions },
            { type: 'Dropdown', label: 'Packaging', name: 'packing_rating', required: true, 'data-source': ratingOptions },
            { type: 'Dropdown', label: 'Delivery Experience', name: 'delivery_rating', required: true, 'data-source': ratingOptions },
            { type: 'Dropdown', label: 'Value for Money', name: 'value_rating', required: true, 'data-source': ratingOptions },
            { type: 'TextInput', label: 'Any suggestions? (optional)', 'input-type': 'text', name: 'comment', required: false, 'helper-text': 'Tell us what we can improve' },
            {
              type: 'Footer', label: 'Submit Feedback',
              'on-click-action': {
                name: 'complete',
                payload: {
                  taste_rating: '${form.taste_rating}',
                  packing_rating: '${form.packing_rating}',
                  delivery_rating: '${form.delivery_rating}',
                  value_rating: '${form.value_rating}',
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

async function updateFeedbackFlow(flowId) {
  const flowJson = buildFeedbackFlowJson();
  await updateFlowJson(flowId, flowJson);
  await publishFlow(flowId);
  log.info({ flowId }, 'Feedback Flow updated and published');
  return { success: true, flowId };
}

async function createFeedbackFlow(wabaId) {
  const token = metaConfig.getMessagingToken();
  const flowJson = buildFeedbackFlowJson();

  log.info({ wabaId }, 'Creating feedback Flow');

  try {
    const { data } = await axios.post(
      `${metaConfig.graphUrl}/${wabaId}/flows`,
      { name: 'GullyBite Order Rating', categories: ['OTHER'], flow_json: JSON.stringify(flowJson), publish: true },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20000 }
    );
    log.info({ flowId: data.id }, 'Feedback Flow created');
    return { success: true, flowId: data.id, published: !data.validation_errors?.length };
  } catch (err) {
    log.error({ err }, 'Feedback Flow creation failed');
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
  updateFeedbackFlow,
};
