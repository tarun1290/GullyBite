#!/usr/bin/env node
// create-feedback-flow.js
// Creates and publishes a WhatsApp Flow for post-order feedback/rating.
// Uses nfm_reply (no-endpoint) approach — runs entirely on-device.
//
// Usage: META_SYSTEM_USER_TOKEN=... MONGODB_URI=... node backend/scripts/create-feedback-flow.js
//
// The Flow collects 4 ratings (taste, packing, delivery, value) + optional comment.
// On submit, it returns these fields plus flow_token (for order identification).

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const axios = require('axios');
const FormData = require('form-data');
const metaConfig = require('../src/config/meta');

const WABA_ID = '1587562225840851';
const BASE_URL = metaConfig.graphUrl;
const TOKEN = process.env.META_SYSTEM_USER_TOKEN;

if (!TOKEN) {
  console.error('ERROR: META_SYSTEM_USER_TOKEN env var is required');
  process.exit(1);
}

// ── Flow JSON (WhatsApp Flows v6.2, nfm_reply / no-endpoint) ──
const flowJson = {
  version: '6.2',
  screens: [
    {
      id: 'RATING_SCREEN',
      title: 'Rate Your Order',
      data: {
        flow_token:   { type: 'string', '__example__': 'rating_abc123' },
        order_number: { type: 'string', '__example__': 'GB-001' },
        order_id:     { type: 'string', '__example__': 'abc123' },
      },
      terminal: true,
      layout: {
        type: 'SingleColumnLayout',
        children: [
          {
            type: 'TextHeading',
            text: 'How was your experience?',
          },
          {
            type: 'TextSubheading',
            text: 'Rate each aspect of your order',
          },
          {
            type: 'Dropdown',
            name: 'taste_rating',
            label: 'Taste & Food Quality',
            required: true,
            'data-source': [
              { id: '5', title: '\u2b50\u2b50\u2b50\u2b50\u2b50 Excellent' },
              { id: '4', title: '\u2b50\u2b50\u2b50\u2b50 Great' },
              { id: '3', title: '\u2b50\u2b50\u2b50 Good' },
              { id: '2', title: '\u2b50\u2b50 Fair' },
              { id: '1', title: '\u2b50 Poor' },
            ],
          },
          {
            type: 'Dropdown',
            name: 'packing_rating',
            label: 'Packaging',
            required: true,
            'data-source': [
              { id: '5', title: '\u2b50\u2b50\u2b50\u2b50\u2b50 Excellent' },
              { id: '4', title: '\u2b50\u2b50\u2b50\u2b50 Great' },
              { id: '3', title: '\u2b50\u2b50\u2b50 Good' },
              { id: '2', title: '\u2b50\u2b50 Fair' },
              { id: '1', title: '\u2b50 Poor' },
            ],
          },
          {
            type: 'Dropdown',
            name: 'delivery_rating',
            label: 'Delivery Speed',
            required: true,
            'data-source': [
              { id: '5', title: '\u2b50\u2b50\u2b50\u2b50\u2b50 Excellent' },
              { id: '4', title: '\u2b50\u2b50\u2b50\u2b50 Great' },
              { id: '3', title: '\u2b50\u2b50\u2b50 Good' },
              { id: '2', title: '\u2b50\u2b50 Fair' },
              { id: '1', title: '\u2b50 Poor' },
            ],
          },
          {
            type: 'Dropdown',
            name: 'value_rating',
            label: 'Value for Money',
            required: true,
            'data-source': [
              { id: '5', title: '\u2b50\u2b50\u2b50\u2b50\u2b50 Excellent' },
              { id: '4', title: '\u2b50\u2b50\u2b50\u2b50 Great' },
              { id: '3', title: '\u2b50\u2b50\u2b50 Good' },
              { id: '2', title: '\u2b50\u2b50 Fair' },
              { id: '1', title: '\u2b50 Poor' },
            ],
          },
          {
            type: 'TextArea',
            name: 'comment',
            label: 'Comments (optional)',
            required: false,
            'helper-text': 'Tell us more about your experience',
          },
          {
            type: 'Footer',
            label: 'Submit Rating',
            'on-click-action': {
              name: 'complete',
              payload: {
                flow_token:       '${data.flow_token}',
                taste_rating:     '${form.taste_rating}',
                packing_rating:   '${form.packing_rating}',
                delivery_rating:  '${form.delivery_rating}',
                value_rating:     '${form.value_rating}',
                comment:          '${form.comment}',
              },
            },
          },
        ],
      },
    },
  ],
};

async function main() {
  console.log('[Flow] Creating feedback Flow on WABA', WABA_ID);

  // Step 1: Create the Flow
  let flowId;
  try {
    const createRes = await axios.post(`${BASE_URL}/${WABA_ID}/flows`, {
      name: 'GullyBite Order Feedback',
      categories: ['OTHER'],
    }, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    flowId = createRes.data.id;
    console.log('[Flow] Created Flow ID:', flowId);
  } catch (e) {
    console.error('[Flow] Create failed:', e.response?.data || e.message);
    process.exit(1);
  }

  // Step 2: Upload the Flow JSON as an asset
  try {
    const jsonBuffer = Buffer.from(JSON.stringify(flowJson, null, 2));
    const form = new FormData();
    form.append('file', jsonBuffer, { filename: 'flow.json', contentType: 'application/json' });
    form.append('name', 'flow.json');
    form.append('asset_type', 'FLOW_JSON');

    await axios.post(`${BASE_URL}/${flowId}/assets`, form, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...form.getHeaders(),
      },
    });
    console.log('[Flow] Uploaded Flow JSON asset');
  } catch (e) {
    console.error('[Flow] Asset upload failed:', JSON.stringify(e.response?.data || e.message, null, 2));
    console.log('[Flow] Flow was created but not published. ID:', flowId);
    console.log('[Flow] Fix the JSON and re-upload manually, or delete and retry.');
    process.exit(1);
  }

  // Step 3: Publish the Flow
  try {
    await axios.post(`${BASE_URL}/${flowId}/publish`, {}, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    console.log('[Flow] Published successfully!');
  } catch (e) {
    console.error('[Flow] Publish failed:', e.response?.data || e.message);
    console.log('[Flow] Flow was uploaded but not published. ID:', flowId);
    console.log('[Flow] You may need to publish it manually from Meta Business Manager.');
  }

  // Step 4: Save to MongoDB platform_settings
  try {
    const { connect, col } = require('../src/config/database');
    await connect();
    await col('platform_settings').updateOne(
      { _id: 'feedback_flow' },
      { $set: { flow_id: flowId, updated_at: new Date() } },
      { upsert: true }
    );
    console.log('[Flow] Saved to platform_settings (feedback_flow)');
  } catch (e) {
    console.warn('[Flow] MongoDB save failed (non-fatal):', e.message);
    console.log('[Flow] Add to .env manually: RATING_FLOW_ID=' + flowId);
  }

  console.log('\n=== DONE ===');
  console.log('Flow ID:', flowId);
  console.log('Add to .env: RATING_FLOW_ID=' + flowId);

  // Exit cleanly (MongoDB connection may keep process alive)
  setTimeout(() => process.exit(0), 1000);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
