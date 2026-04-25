#!/usr/bin/env node
'use strict';

// recreateDeliveryAddressFlow.js
//
// One-shot migration script: deletes the old GullyBite Delivery Address
// Flow on Meta, creates a new Flow ("delivery address GullyBite",
// CUSTOMER_SATISFACTION), uploads the canonical JSON from
// backend/flows/address-flow.json, publishes it, then re-points all DB
// references at the new flow_id.
//
// Usage:
//   cd backend && npm run flow:recreate
//   # or directly:
//   node backend/scripts/recreateDeliveryAddressFlow.js
//
// Env required:
//   META_SYSTEM_USER_TOKEN — long-lived system user token
//   MONGODB_URI            — Mongo connection string used by config/database.js
//
// Pulls the WABA_ID from whatsapp_accounts.{is_active:true}.waba_id —
// matches the convention used by every other script in this folder.
//
// Exits 0 on full success, 1 on any failure. Each step logs its phase so
// the operator can resume from the right place if a partial failure
// occurs (e.g. Meta accepted the delete but the publish failed — DB still
// references the now-deleted flow_id).
//
// CAUTION: Step A (delete) is destructive and irreversible. There is a
// brief window between A and step F where the DB still references the
// deleted flow_id; greeting messages during that window will fall through
// the `if (restaurant?.flow_id)` guard once the DB is updated, but any
// send attempted between A and the platform_settings update at E will hit
// Meta with a deleted flow_id and fail. The script runs sequentially and
// finishes in seconds — production impact is small but non-zero.

require('dotenv').config({
  path: require('path').resolve(__dirname, '../../.env'),
  quiet: true,
});

const fs = require('fs');
const path = require('path');
const { connect, col } = require('../src/config/database');
const {
  createFlow,
  deleteFlow,
  uploadFlowAsset,
  publishFlow,
} = require('../src/services/metaFlowsApi');

const OLD_FLOW_ID = '1295858815785776';
const NEW_FLOW_NAME = 'delivery address GullyBite';
const NEW_FLOW_CATEGORIES = ['CUSTOMER_SATISFACTION'];
const FLOW_JSON_PATH = path.resolve(__dirname, '../flows/address-flow.json');

function logFlow(msg, extra) {
  if (extra !== undefined) console.log('[FLOW]', msg, extra);
  else console.log('[FLOW]', msg);
}
function logFlowErr(msg, extra) {
  if (extra !== undefined) console.error('[FLOW]', msg, extra);
  else console.error('[FLOW]', msg);
}
function logDb(msg, extra) {
  if (extra !== undefined) console.log('[DB]', msg, extra);
  else console.log('[DB]', msg);
}

async function main() {
  if (!process.env.META_SYSTEM_USER_TOKEN) {
    logFlowErr('META_SYSTEM_USER_TOKEN is not set — aborting');
    process.exit(1);
  }

  // ── Load Flow JSON from disk before touching Meta ──
  // Failing here means we never delete the old flow.
  let flowJsonRaw;
  try {
    flowJsonRaw = fs.readFileSync(FLOW_JSON_PATH, 'utf8');
    JSON.parse(flowJsonRaw); // sanity-check valid JSON
  } catch (e) {
    logFlowErr(`Cannot read/parse Flow JSON at ${FLOW_JSON_PATH}: ${e.message}`);
    process.exit(1);
  }

  // ── Connect Mongo + look up WABA_ID ──
  await connect();
  const waAccount = await col('whatsapp_accounts').findOne({ is_active: true });
  const wabaId = waAccount?.waba_id;
  if (!wabaId) {
    logFlowErr('No active row in whatsapp_accounts (is_active:true) — cannot determine WABA_ID. Aborting.');
    process.exit(1);
  }
  logFlow(`Using WABA ${wabaId}`);

  // ── Step A: delete old flow ──
  logFlow(`Deleting old flow ${OLD_FLOW_ID}...`);
  try {
    await deleteFlow(OLD_FLOW_ID);
    logFlow('Old flow deleted.');
  } catch (e) {
    const apiErr = e.response?.data?.error;
    logFlowErr(`Delete failed: ${apiErr?.message || e.message}`, apiErr || undefined);
    process.exit(1);
  }

  // ── Step B: create new flow container ──
  let newFlowId;
  try {
    const created = await createFlow(wabaId, {
      name: NEW_FLOW_NAME,
      categories: NEW_FLOW_CATEGORIES,
    });
    newFlowId = created?.id;
    if (!newFlowId) {
      logFlowErr('Create response missing id — aborting', created);
      process.exit(1);
    }
    logFlow(`Created new flow: ${newFlowId}`);
  } catch (e) {
    const apiErr = e.response?.data?.error;
    logFlowErr(`Create failed: ${apiErr?.message || e.message}`, apiErr || undefined);
    process.exit(1);
  }

  // ── Step C: upload Flow JSON ──
  let uploadResp;
  try {
    uploadResp = await uploadFlowAsset(newFlowId, flowJsonRaw);
  } catch (e) {
    const apiErr = e.response?.data?.error;
    logFlowErr(`JSON upload failed: ${apiErr?.message || e.message}`, apiErr || undefined);
    process.exit(1);
  }

  const validationErrors = uploadResp?.validation_errors;
  if (Array.isArray(validationErrors) && validationErrors.length) {
    logFlowErr(`Upload returned ${validationErrors.length} validation error(s) — aborting publish:`);
    for (const ve of validationErrors) {
      const where = ve.pointers?.[0]?.path || ve.pointers?.[0]?.line || '(unknown)';
      console.error(`[FLOW VALIDATION ERROR]   • ${ve.error || ve.error_type || 'error'} @ ${where}: ${ve.message || ve.error_user_msg || JSON.stringify(ve)}`);
    }
    process.exit(1);
  }
  logFlow('JSON uploaded successfully.');

  // ── Step D: publish ──
  try {
    const publishResp = await publishFlow(newFlowId);
    const ok = publishResp?.success === true || publishResp?.id === newFlowId;
    if (!ok) {
      logFlowErr('Publish response did not confirm success — aborting before DB update', publishResp);
      process.exit(1);
    }
  } catch (e) {
    const apiErr = e.response?.data?.error;
    logFlowErr(`Publish failed: ${apiErr?.message || e.message}`, apiErr || undefined);
    process.exit(1);
  }
  logFlow(`Published new flow ${newFlowId} successfully.`);

  // ── Step E: update platform_settings ──
  try {
    await col('platform_settings').updateOne(
      { _id: 'whatsapp_flow' },
      { $set: { flow_id: newFlowId, updated_at: new Date() } }
    );
    logDb(`Updated platform_settings.whatsapp_flow.flow_id → ${newFlowId}`);
  } catch (e) {
    logFlowErr(`platform_settings update failed: ${e.message}`);
    process.exit(1);
  }

  // ── Step F: updateMany on restaurants ──
  let restaurantModified = 0;
  try {
    const result = await col('restaurants').updateMany(
      { flow_id: OLD_FLOW_ID },
      { $set: { flow_id: newFlowId } }
    );
    restaurantModified = result?.modifiedCount ?? 0;
    logDb(`Updated ${restaurantModified} restaurant(s) flow_id → ${newFlowId}`);
  } catch (e) {
    logFlowErr(`restaurants updateMany failed: ${e.message}`);
    process.exit(1);
  }

  // ── Summary ──
  console.log('');
  console.log(`✓ Old flow ${OLD_FLOW_ID} deleted from Meta`);
  console.log(`✓ New flow created: ${newFlowId}`);
  console.log('✓ Flow JSON uploaded and validated');
  console.log('✓ Flow published on Meta');
  console.log('✓ platform_settings.whatsapp_flow.flow_id updated');
  console.log(`✓ ${restaurantModified} restaurant(s) updated`);
  console.log('');
  console.log('No env var update required — the backend reads the delivery flow_id');
  console.log('from MongoDB (platform_settings + restaurants.flow_id), not from env.');
  console.log('');
  console.log(`Note: scripts/publishDeliveryAddressFlow.js still hard-codes ${OLD_FLOW_ID}`);
  console.log(`      at line ~40. Update that constant to ${newFlowId} if you intend to`);
  console.log('      use `npm run flow:publish` for future re-publishes.');
  process.exit(0);
}

main().catch((e) => {
  logFlowErr(`Unexpected error: ${e.stack || e.message}`);
  process.exit(1);
});
