// backend/scripts/push-feedback-flow.js
//
// One-off: upload the updated feedback Flow JSON to Meta and publish it.
//
// Run (on the EC2 host, where the prod env + token live):
//   cd /home/ubuntu/GullyBite
//   node --env-file=/home/ubuntu/GullyBite/.env backend/scripts/push-feedback-flow.js
//
// Requires env: META_SYSTEM_USER_TOKEN
// Reads: backend/src/scripts/feedback-flow-update.json  (produced by Step 1)
//
// Mirrors the proven prod asset-upload mechanism in
// src/services/flowManager.js (form-data + axios + form.getHeaders()).

'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

const FLOW_ID = '941765451575098';
const GRAPH = 'https://graph.facebook.com/v25.0';
const FLOW_JSON_PATH = path.resolve(__dirname, '../src/scripts/feedback-flow-update.json');

async function main() {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!token) {
    console.error('FATAL: META_SYSTEM_USER_TOKEN is not set in the environment.');
    process.exit(1);
  }

  if (!fs.existsSync(FLOW_JSON_PATH)) {
    console.error(`FATAL: flow JSON not found at ${FLOW_JSON_PATH}`);
    console.error('This file is produced by Step 1 (CheckboxGroup added to RATING_SCREEN). Create it first.');
    process.exit(1);
  }

  // Read + validate the JSON so we never push a malformed asset.
  const raw = fs.readFileSync(FLOW_JSON_PATH);
  try {
    JSON.parse(raw.toString('utf8'));
  } catch (e) {
    console.error(`FATAL: ${FLOW_JSON_PATH} is not valid JSON: ${e.message}`);
    process.exit(1);
  }

  // ── 1. Upload the JSON asset to the (draft) Flow ──
  const form = new FormData();
  form.append('file', raw, { filename: 'flow.json', contentType: 'application/json' });
  form.append('name', 'flow.json'); // matches prod flowManager.js; Meta accepts/expects it
  form.append('asset_type', 'FLOW_JSON');

  console.log(`Uploading FLOW_JSON asset to ${GRAPH}/${FLOW_ID}/assets ...`);
  let assetData;
  try {
    const res = await axios.post(`${GRAPH}/${FLOW_ID}/assets`, form, {
      headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() },
      timeout: 15000,
      maxBodyLength: Infinity,
    });
    assetData = res.data;
  } catch (e) {
    console.error('Asset upload FAILED:', JSON.stringify(e.response?.data || e.message, null, 2));
    process.exit(1);
  }
  console.log('Asset upload response:', JSON.stringify(assetData, null, 2));
  if (assetData && assetData.success !== true) {
    console.error('Asset upload did NOT return { success: true } — aborting before publish.');
    process.exit(1);
  }

  // ── 2. Publish the Flow ──
  console.log(`Publishing flow ${GRAPH}/${FLOW_ID}/publish ...`);
  try {
    const res = await axios.post(`${GRAPH}/${FLOW_ID}/publish`, {}, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
    console.log('Publish response:', JSON.stringify(res.data, null, 2));
  } catch (e) {
    console.error('Publish FAILED:', JSON.stringify(e.response?.data || e.message, null, 2));
    process.exit(1);
  }

  console.log('Done.');
}

main().catch((e) => {
  console.error('Unexpected error:', e && e.stack ? e.stack : e);
  process.exit(1);
});
