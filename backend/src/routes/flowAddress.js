// src/routes/flowAddress.js
//
// Endpoint-mode handler for the Delivery Address WhatsApp Flow.
// Runtime callbacks only — form submissions are delivered as nfm_reply
// to webhooks/whatsapp.js (the existing path), NOT through this endpoint.
//
// Three request shapes reach this handler:
//
//   action = "ping"           → Meta health check
//   action = "INIT"           → customer opened the flow
//   action = "data_exchange"  → customer typed in "Search area / locality"
//                                (populates the Dropdown options)
//   action = "BACK"           → customer tapped back
//
// The terminal `complete` actions on CONFIRM_DELIVERY (select path) and
// ADD_ADDRESS (new-address path) are delivered by Meta as nfm_reply to
// the messaging webhook. webhooks/whatsapp.js handleDeliveryFlowResponse
// owns that path — it branches on responseData.action ('select_address'
// | 'new_address'), resolves the branch, sends the menu.
//
// Crypto: re-uses the RSA-2048 + AES-128-GCM stack from
// services/checkout-crypto.js. Responses are AES-GCM encrypted with the
// request's key + a flipped IV, returned as text/plain base64.
//
// Addresses are stored per wa_id (global, cross-tenant) — never scoped
// to restaurant_id / branch_id. See services/address.js for the writer.

'use strict';

const express = require('express');
const axios = require('axios');
const router = express.Router();

const { decryptWithKey, encryptWithFlippedIv } = require('../services/checkout-crypto');
const { col } = require('../config/database');
const log = require('../utils/logger').child({ component: 'flow-address' });

const DECRYPT_FAIL_STATUS = 421;

// Google Places (New) Autocomplete. Reusing GOOGLE_MAPS_API_KEY — same
// Google Cloud project, Places API enabled alongside Geocoding. Place
// Details resolution lives in services/location.js:placeDetails (also
// called from webhooks/whatsapp.js when the ADD_ADDRESS completion lands
// on nfm_reply).
const PLACES_AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';

router.post('/', express.json({ limit: '256kb' }), async (req, res) => {
  let decrypted;
  try {
    decrypted = decryptWithKey({
      encrypted_aes_key: req.body?.encrypted_aes_key,
      encrypted_payload: req.body?.encrypted_flow_data || req.body?.encrypted_payload,
      iv: req.body?.initial_vector || req.body?.iv,
      tag: req.body?.tag,
    });
  } catch (err) {
    log.warn({ err: err.message }, 'decrypt_failed');
    return res.status(DECRYPT_FAIL_STATUS).send('Decryption failed');
  }

  const { data: payload, aesKey, requestIv } = decrypted;
  const action  = payload?.action;
  const screen  = payload?.screen;
  const version = payload?.version || '6.2';
  const flow_token = payload?.flow_token;

  log.info({ action, screen, flow_token }, 'flow_address.request');

  let responseData;
  try {
    if (action === 'ping') {
      responseData = { version, data: { status: 'active' } };
    } else if (action === 'INIT') {
      responseData = await handleInit(payload, version);
    } else if (action === 'data_exchange') {
      responseData = await handleDataExchange(payload, version);
    } else if (action === 'BACK') {
      responseData = { version, screen: screen || 'SELECT_ADDRESS', data: {} };
    } else {
      responseData = { version, data: {} };
    }
  } catch (err) {
    log.error({ err, action }, 'handler_failed');
    responseData = {
      version,
      data: { error: { message: err.message || 'internal error' } },
    };
  }

  try {
    const out = encryptWithFlippedIv(responseData, aesKey, requestIv);
    res.set('Content-Type', 'text/plain');
    return res.status(200).send(out);
  } catch (err) {
    log.error({ err }, 'encrypt_failed');
    return res.status(DECRYPT_FAIL_STATUS).send('Encryption failed');
  }
});

// ─── INIT ─────────────────────────────────────────────────────
// Flow just opened. If the customer already has saved addresses, show
// SELECT_ADDRESS; otherwise start them on ADD_ADDRESS.
async function handleInit(payload, version) {
  const waId = _extractWaId(payload);
  const addresses = waId ? await _getAddressesByWaId(waId) : [];

  if (addresses.length > 0) {
    const mapped = addresses.map((a) => ({
      id: String(a._id || a.id),
      title: _formatAddressTitle(a),
    }));
    return {
      version,
      screen: 'SELECT_ADDRESS',
      data: { addresses: mapped },
    };
  }

  return {
    version,
    screen: 'ADD_ADDRESS',
    data: { locality_options: [{ id: 'placeholder', title: 'Type to search...' }] },
  };
}

// ─── DATA EXCHANGE (locality search) ──────────────────────────
// Customer typed into "Search area / locality". Call Google Places
// Autocomplete (New API) biased to India and return mapped options.
async function handleDataExchange(payload, version) {
  const query = String(payload?.data?.query || payload?.data?.locality_search || '').trim();
  if (!query) {
    return {
      version,
      screen: 'ADD_ADDRESS',
      data: { locality_options: [{ id: 'placeholder', title: 'Type to search...' }] },
    };
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    log.warn('GOOGLE_MAPS_API_KEY not set — returning empty results');
    return {
      version,
      screen: 'ADD_ADDRESS',
      data: { locality_options: [{ id: 'none', title: 'Places API not configured' }] },
    };
  }

  try {
    const { data } = await axios.post(
      PLACES_AUTOCOMPLETE_URL,
      {
        input: query,
        includedRegionCodes: ['in'],
        languageCode: 'en',
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text',
        },
        timeout: 8000,
      }
    );

    const suggestions = Array.isArray(data?.suggestions) ? data.suggestions : [];
    const options = suggestions
      .map((s) => s.placePrediction)
      .filter(Boolean)
      .slice(0, 10)
      .map((p) => ({
        id: p.placeId,
        title: (p.text?.text || '').substring(0, 80) || 'Unknown place',
      }));

    if (options.length === 0) {
      options.push({ id: 'none', title: 'No matches — try a different search' });
    }

    return {
      version,
      screen: 'ADD_ADDRESS',
      data: { locality_options: options },
    };
  } catch (err) {
    log.warn({ err: err.message, status: err.response?.status }, 'places_autocomplete_failed');
    return {
      version,
      screen: 'ADD_ADDRESS',
      data: { locality_options: [{ id: 'none', title: 'Search failed — please retry' }] },
    };
  }
}

// ─── HELPERS ──────────────────────────────────────────────────

// Meta Flow endpoints do not ship wa_id by default. We pass it through
// `flow_action_payload.data.wa_id` when sending the flow (see
// whatsapp.sendFlow callers). Fall back to reading from the top-level
// payload in case Meta echoes it there.
function _extractWaId(payload) {
  return payload?.data?.wa_id
      || payload?.wa_id
      || payload?.data?.phone_number
      || null;
}

async function _getAddressesByWaId(waId) {
  const normalized = String(waId).replace(/^\+/, '');
  return col('customer_addresses')
    .find({ $or: [{ wa_phone: normalized }, { wa_phone: `+${normalized}` }] })
    .sort({ is_default: -1, created_at: -1 })
    .limit(10)
    .toArray();
}

function _formatAddressTitle(a) {
  const label = a.label || 'Address';
  const line = a.full_address || [a.building_floor, a.street, a.area_locality, a.city].filter(Boolean).join(', ');
  return `${label} — ${line}`.substring(0, 80);
}

module.exports = router;
