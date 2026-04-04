#!/usr/bin/env node
// create-checkout-template.js
// Creates a checkout button template via Meta Graph API.
//
// Usage: META_SYSTEM_USER_TOKEN=... node backend/scripts/create-checkout-template.js
//
// The template must be approved by Meta before it can be sent.
// Approval usually takes minutes to a few hours.

'use strict';

const axios = require('axios');

const WABA_ID = '1587562225840851';
const API_VERSION = 'v25.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;
const TOKEN = process.env.META_SYSTEM_USER_TOKEN;

if (!TOKEN) {
  console.error('ERROR: META_SYSTEM_USER_TOKEN env var is required');
  process.exit(1);
}

async function main() {
  console.log('[Template] Creating checkout button template on WABA', WABA_ID);

  const templatePayload = {
    name: 'order_checkout_v1',
    language: 'en_US',
    category: 'MARKETING',
    components: [
      {
        type: 'HEADER',
        format: 'TEXT',
        text: '🛒 Order Ready for Checkout',
      },
      {
        type: 'BODY',
        text: 'Hi {{1}}! Your order from {{2}} is ready for checkout. Review your items and pay securely below.',
        example: {
          body_text: [['Tarun', 'beyond snacks']],
        },
      },
      {
        type: 'FOOTER',
        text: 'Powered by GullyBite',
      },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'order_details',
            text: 'Buy now',
          },
        ],
      },
    ],
  };

  try {
    const res = await axios.post(
      `${BASE_URL}/${WABA_ID}/message_templates`,
      templatePayload,
      { headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } }
    );

    console.log('\n=== DONE ===');
    console.log('Template ID:', res.data.id);
    console.log('Status:', res.data.status);
    console.log('\nAdd to .env: CHECKOUT_TEMPLATE_NAME=order_checkout_v1');
    console.log('The template needs Meta approval before it can be sent.');
  } catch (e) {
    console.error('[Template] Creation failed:', JSON.stringify(e.response?.data || e.message, null, 2));
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
