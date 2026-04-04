#!/usr/bin/env node
// update-delivery-flow.js
// Updates the delivery address Flow JSON on Meta and publishes it.
// NOTE: Published Flows CANNOT be updated. This script creates a NEW Flow,
// uploads the JSON, publishes it, and updates the DB to use the new Flow ID.
//
// Usage: node backend/scripts/update-delivery-flow.js

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const flowMgr = require('../src/services/flowManager');
const { connect, col } = require('../src/config/database');

async function main() {
  await connect();

  // Get WABA ID
  const waAccount = await col('whatsapp_accounts').findOne({ is_active: true });
  const wabaId = waAccount?.waba_id;
  if (!wabaId) {
    console.error('No active WABA found. Check whatsapp_accounts collection.');
    process.exit(1);
  }
  console.log('WABA ID:', wabaId);

  // Check current Flow
  const setting = await col('platform_settings').findOne({ _id: 'whatsapp_flow' });
  const oldFlowId = setting?.flow_id;
  console.log('Current Flow ID:', oldFlowId || 'none');

  // Print the Flow JSON for review
  const flowJson = flowMgr.buildDeliveryFlowJson();
  console.log('\nFlow JSON screens:');
  for (const screen of flowJson.screens) {
    const childCount = screen.layout?.children?.length || 0;
    console.log(`  ${screen.id} (${screen.terminal ? 'terminal' : 'non-terminal'}) — ${childCount} components`);
  }

  // Try updating existing draft, or create new
  if (oldFlowId) {
    try {
      // Check if existing Flow is a draft (can be updated)
      const meta = require('../src/config/meta');
      const axios = require('axios');
      const status = await axios.get(`${meta.graphUrl}/${oldFlowId}?fields=status`, {
        headers: { Authorization: `Bearer ${meta.systemUserToken}` },
      });
      if (status.data.status === 'DRAFT') {
        console.log('\nExisting Flow is DRAFT — updating in place...');
        await flowMgr.updateFlowJson(oldFlowId);
        console.log('JSON uploaded. Publishing...');
        await flowMgr.publishFlow(oldFlowId);
        console.log('Published!');
        console.log('\n=== DONE === Flow ID unchanged:', oldFlowId);
        setTimeout(() => process.exit(0), 1000);
        return;
      }
      console.log(`\nExisting Flow status: ${status.data.status} — cannot update. Creating new Flow.`);
    } catch (e) {
      console.warn('Could not check existing Flow:', e.message);
    }
  }

  // Create new Flow
  console.log('\nCreating new Flow...');
  const result = await flowMgr.createDeliveryFlow(wabaId);
  const newFlowId = result.flowId;
  console.log('New Flow ID:', newFlowId, 'Published:', result.published);

  // Update platform_settings
  await col('platform_settings').updateOne(
    { _id: 'whatsapp_flow' },
    { $set: { flow_id: newFlowId, flow_status: result.published ? 'PUBLISHED' : 'DRAFT', updated_at: new Date() } },
    { upsert: true }
  );

  // Update all restaurants that referenced the old Flow
  if (oldFlowId) {
    const updated = await col('restaurants').updateMany(
      { flow_id: oldFlowId },
      { $set: { flow_id: newFlowId, updated_at: new Date() } }
    );
    console.log(`Updated ${updated.modifiedCount} restaurant(s) from old Flow ${oldFlowId} to new ${newFlowId}`);
  }

  // Also set for any restaurant without a flow_id
  const restWithout = await col('restaurants').updateMany(
    { $or: [{ flow_id: null }, { flow_id: { $exists: false } }] },
    { $set: { flow_id: newFlowId, updated_at: new Date() } }
  );
  if (restWithout.modifiedCount) console.log(`Assigned Flow to ${restWithout.modifiedCount} restaurant(s) without one`);

  console.log(`\n=== DONE ===`);
  console.log(`Old Flow ID: ${oldFlowId || 'none'}`);
  console.log(`New Flow ID: ${newFlowId}`);
  if (!result.published) console.log('⚠️ Flow is in DRAFT. Publish from Meta Business Manager or run again.');

  setTimeout(() => process.exit(0), 1000);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
