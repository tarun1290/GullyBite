#!/usr/bin/env node
// Check and publish the delivery address WhatsApp Flow
// Run: cd backend && node src/scripts/check-flow-status.js

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env'), quiet: true });
if (!process.env.MONGODB_URI) require('dotenv').config({ path: path.join(__dirname, '../../.env'), quiet: true });

const { MongoClient } = require('mongodb');
const axios = require('axios');

const MONGO_URI = process.env.MONGODB_URI;
const MONGO_DB = process.env.MONGODB_DB || 'gullybite';
const TOKEN = process.env.META_SYSTEM_USER_TOKEN;
const API_VERSION = process.env.WA_API_VERSION || 'v25.0';
const GRAPH = `https://graph.facebook.com/${API_VERSION}`;

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  CHECK WHATSAPP FLOW STATUS');
  console.log('═══════════════════════════════════════════════\n');

  if (!TOKEN) { console.error('❌ META_SYSTEM_USER_TOKEN not set'); process.exit(1); }

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(MONGO_DB);

  // Get Flow ID from platform_settings
  const setting = await db.collection('platform_settings').findOne({ _id: 'whatsapp_flow' });
  if (!setting?.flow_id) {
    console.log('❌ No delivery address Flow found in platform_settings');
    console.log('   Create one via: Admin Dashboard → Flow Builder → Create Flow');

    // Also check restaurants for flow_id
    const restaurants = await db.collection('restaurants').find({ flow_id: { $ne: null } }).toArray();
    if (restaurants.length) {
      console.log(`\n   Found flow_id on ${restaurants.length} restaurant(s):`);
      for (const r of restaurants) console.log(`     ${r.business_name}: flow_id = ${r.flow_id}`);
    }
    await client.close();
    return;
  }

  const flowId = setting.flow_id;
  console.log(`Flow ID: ${flowId}`);
  console.log(`Stored status: ${setting.flow_status || 'unknown'}\n`);

  // Check status on Meta
  try {
    const { data } = await axios.get(`${GRAPH}/${flowId}`, {
      params: { fields: 'id,name,status,categories,validation_errors', access_token: TOKEN },
      timeout: 15000,
    });

    console.log('Meta API Response:');
    console.log(`  Name: ${data.name}`);
    console.log(`  Status: ${data.status}`);
    console.log(`  Categories: ${(data.categories || []).join(', ')}`);

    if (data.validation_errors?.length) {
      console.log(`  Validation Errors:`);
      for (const e of data.validation_errors) {
        console.log(`    - ${e.error}: ${e.message}${e.path ? ' at ' + e.path : ''}`);
      }
    }

    if (data.status === 'DRAFT') {
      console.log('\n⚠️ Flow is in DRAFT — publishing now...');
      try {
        const pubRes = await axios.post(`${GRAPH}/${flowId}/publish`, {}, {
          headers: { Authorization: `Bearer ${TOKEN}` },
          timeout: 15000,
        });
        console.log('✅ Published!', JSON.stringify(pubRes.data));

        // Update platform_settings
        await db.collection('platform_settings').updateOne(
          { _id: 'whatsapp_flow' },
          { $set: { flow_status: 'PUBLISHED', updated_at: new Date() } }
        );
        console.log('✅ Database updated to PUBLISHED');
      } catch (pubErr) {
        console.error('❌ Publish failed:', pubErr.response?.data?.error?.message || pubErr.message);
        if (pubErr.response?.data) console.log('   Full error:', JSON.stringify(pubErr.response.data).slice(0, 500));
      }
    } else if (data.status === 'PUBLISHED') {
      console.log('\n✅ Flow is already PUBLISHED and active');
    } else {
      console.log(`\n⚠️ Flow status: ${data.status} — may need attention`);
    }
  } catch (err) {
    console.error('❌ Failed to check Flow status:', err.response?.data?.error?.message || err.message);
  }

  await client.close();
  console.log('\nDone.');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
