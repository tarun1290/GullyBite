#!/usr/bin/env node
'use strict';

// publishDeliveryAddressFlow.js
//
// Uploads the local delivery-address Flow JSON to Meta as a new asset
// version on the existing flow_id, validates the response, and (only on
// clean validation) publishes the new version. Manual: Tarun runs this
// after reviewing the JSON locally — there is no auto-trigger from the
// build or from request handlers.
//
// Usage:
//   cd backend && npm run flow:publish
//   # or directly:
//   node backend/scripts/publishDeliveryAddressFlow.js
//
// Env required:
//   META_SYSTEM_USER_TOKEN — long-lived system user token (NEVER use the
//                            retired WA_CATALOG_TOKEN)
//   WA_API_VERSION         — optional, defaults to v25.0 via metaConfig
//
// Exits 0 on success, 1 on any error (env missing, JSON read failed,
// validation_errors present, upload/publish failed).
//
// Note: Meta CDN can take a few hours to roll the published version to
// existing customer sessions. If the old form persists briefly after a
// publish, that is expected propagation latency, not a script failure.

require('dotenv').config({
  path: require('path').resolve(__dirname, '../../.env'),
  quiet: true,
});

const fs = require('fs');
const path = require('path');
const { uploadFlowAsset, publishFlow } = require('../src/services/metaFlowsApi');

// Hard-coded target — this script ONLY republishes the GullyBite Delivery
// Address Flow. Other flows (feedback, etc.) get their own scripts.
const FLOW_ID = '1295858815785776';
const FLOW_JSON_PATH = path.resolve(__dirname, '../flows/address-flow.json');

function logErr(msg, extra) {
  if (extra !== undefined) console.error(`[META_FLOW] ${msg}`, extra);
  else console.error(`[META_FLOW] ${msg}`);
}
function logInfo(msg, extra) {
  if (extra !== undefined) console.log(`[META_FLOW] ${msg}`, extra);
  else console.log(`[META_FLOW] ${msg}`);
}

async function main() {
  if (!process.env.META_SYSTEM_USER_TOKEN) {
    logErr('META_SYSTEM_USER_TOKEN is not set — refusing to call Meta API');
    process.exit(1);
  }

  let flowJsonRaw;
  try {
    flowJsonRaw = fs.readFileSync(FLOW_JSON_PATH, 'utf8');
  } catch (e) {
    logErr(`Failed to read ${FLOW_JSON_PATH}: ${e.message}`);
    process.exit(1);
  }

  let flowJson;
  try {
    flowJson = JSON.parse(flowJsonRaw);
  } catch (e) {
    logErr(`Flow JSON is not valid JSON: ${e.message}`);
    process.exit(1);
  }

  const screenIds = (flowJson.screens || []).map((s) => s.id).join(', ');
  logInfo(`Uploading flow JSON to Meta — flow_id=${FLOW_ID}, screens=[${screenIds}]`);

  let uploadResp;
  try {
    uploadResp = await uploadFlowAsset(FLOW_ID, flowJsonRaw);
  } catch (e) {
    const apiErr = e.response?.data?.error;
    logErr(`Upload failed: ${apiErr?.message || e.message}`, apiErr || undefined);
    process.exit(1);
  }

  const validationErrors = uploadResp?.validation_errors;
  if (Array.isArray(validationErrors) && validationErrors.length) {
    logErr(`Upload returned ${validationErrors.length} validation error(s) — aborting publish:`);
    for (const ve of validationErrors) {
      const where = ve.pointers?.[0]?.path || ve.pointers?.[0]?.line || '(unknown)';
      logErr(`  • ${ve.error || ve.error_type || 'error'} @ ${where}: ${ve.message || ve.error_user_msg || JSON.stringify(ve)}`);
    }
    process.exit(1);
  }

  logInfo(`Upload accepted — proceeding to publish flow_id=${FLOW_ID}`);

  let publishResp;
  try {
    publishResp = await publishFlow(FLOW_ID);
  } catch (e) {
    const apiErr = e.response?.data?.error;
    logErr(`Publish failed: ${apiErr?.message || e.message}`, apiErr || undefined);
    process.exit(1);
  }

  // Meta returns { success: true } on a clean publish; surface anything
  // unexpected so the operator can decide whether the publish actually
  // landed.
  const succeeded = publishResp?.success === true || publishResp?.id === FLOW_ID;
  if (!succeeded) {
    logErr('Publish response did not confirm success — please verify manually:', publishResp);
    process.exit(1);
  }

  logInfo(`Published flow ${FLOW_ID} successfully.`);
  logInfo('Note: Meta CDN may take a few hours to roll the new version to all customer sessions.');
  process.exit(0);
}

main().catch((e) => {
  logErr(`Unexpected error: ${e.stack || e.message}`);
  process.exit(1);
});
