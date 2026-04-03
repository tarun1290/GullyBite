#!/usr/bin/env node
// Diagnose why catalog is not visible in the Settings page
// Run: node backend/src/scripts/diagnose-catalog-visibility.js

'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
if (!process.env.MONGODB_URI) require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { MongoClient } = require('mongodb');
const axios = require('axios');

const MONGO_URI = process.env.MONGODB_URI;
const MONGO_DB  = process.env.MONGODB_DB || 'gullybite';
const TOKEN     = process.env.META_SYSTEM_USER_TOKEN;
const API_VER   = process.env.WA_API_VERSION || 'v25.0';
const GRAPH     = `https://graph.facebook.com/${API_VER}`;

async function main() {
  if (!MONGO_URI) { console.error('MONGODB_URI not set'); process.exit(1); }

  console.log('========================================');
  console.log('  CATALOG VISIBILITY DIAGNOSIS');
  console.log('========================================\n');

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(MONGO_DB);

  const rid = process.argv[2];
  const restaurant = rid
    ? await db.collection('restaurants').findOne({ _id: rid })
    : await db.collection('restaurants').findOne({});

  if (!restaurant) { console.error('No restaurant found'); process.exit(1); }
  console.log(`Restaurant: "${restaurant.business_name}" (${restaurant._id})\n`);

  // Check 1: DB state
  console.log('── DB STATE ──');
  console.log(`  meta_catalog_id:    ${restaurant.meta_catalog_id || 'NULL ❌'}`);
  console.log(`  meta_catalog_name:  ${restaurant.meta_catalog_name || 'NULL'}`);
  console.log(`  meta_business_id:   ${restaurant.meta_business_id || 'NULL'}`);
  console.log(`  approval_status:    ${restaurant.approval_status || 'NULL'}`);
  console.log(`  whatsapp_connected: ${restaurant.whatsapp_connected || false}`);
  console.log(`  cached catalogs:    ${restaurant.meta_available_catalogs?.length || 0}`);

  const wa = await db.collection('whatsapp_accounts').findOne({ restaurant_id: restaurant._id, is_active: true });
  console.log(`\n  WA account exists:  ${!!wa}`);
  if (wa) {
    console.log(`  waba_id:            ${wa.waba_id || 'NULL ❌'}`);
    console.log(`  phone_number_id:    ${wa.phone_number_id || 'NULL'}`);
    console.log(`  catalog_id:         ${wa.catalog_id || 'NULL'}`);
    console.log(`  cart_enabled:       ${wa.cart_enabled || false}`);
    console.log(`  catalog_linked:     ${wa.catalog_linked || false}`);
  }

  const branches = await db.collection('branches').find({ restaurant_id: restaurant._id }).toArray();
  console.log(`\n  Branches: ${branches.length}`);
  branches.forEach(b => console.log(`    - ${b.name}: catalog_id=${b.catalog_id || 'NULL'}`));

  const itemCount = await db.collection('menu_items').countDocuments({ restaurant_id: restaurant._id });
  console.log(`  Menu items: ${itemCount}`);

  // Check 2: Token
  console.log('\n── TOKEN ──');
  console.log(`  META_SYSTEM_USER_TOKEN: ${TOKEN ? TOKEN.substring(0, 15) + '... (' + TOKEN.length + ' chars)' : 'NOT SET ❌'}`);
  console.log(`  META_BUSINESS_ID:       ${process.env.META_BUSINESS_ID || 'NOT SET'}`);

  if (!TOKEN) { console.log('\n❌ DIAGNOSIS: No token — cannot call Meta API'); await client.close(); return; }

  // Check 3: Live Meta fetch
  console.log('\n── META API CHECKS ──');

  if (wa?.waba_id) {
    try {
      const resp = await axios.get(`${GRAPH}/${wa.waba_id}/product_catalogs`, { params: { access_token: TOKEN, fields: 'id,name,product_count' }, timeout: 15000 });
      const cats = resp.data?.data || [];
      console.log(`  WABA catalogs: ${cats.length}`);
      cats.forEach(c => console.log(`    - ${c.id} "${c.name}" (${c.product_count} products)`));
    } catch (e) { console.log(`  WABA catalogs: FAILED — ${e.response?.data?.error?.message || e.message}`); }
  } else { console.log('  WABA catalogs: SKIPPED (no waba_id)'); }

  const bizId = restaurant.meta_business_id || process.env.META_BUSINESS_ID;
  if (bizId) {
    try {
      const resp = await axios.get(`${GRAPH}/${bizId}/owned_product_catalogs`, { params: { access_token: TOKEN, fields: 'id,name,product_count,vertical' }, timeout: 15000 });
      const cats = resp.data?.data || [];
      console.log(`  Business catalogs: ${cats.length}`);
      cats.forEach(c => console.log(`    - ${c.id} "${c.name}" (${c.product_count} products, ${c.vertical})`));
    } catch (e) { console.log(`  Business catalogs: FAILED — ${e.response?.data?.error?.message || e.message}`); }
  } else { console.log('  Business catalogs: SKIPPED (no business_id)'); }

  if (restaurant.meta_catalog_id) {
    try {
      const resp = await axios.get(`${GRAPH}/${restaurant.meta_catalog_id}`, { params: { access_token: TOKEN, fields: 'id,name,product_count' }, timeout: 10000 });
      console.log(`  Active catalog check: ✅ ${resp.data.id} "${resp.data.name}" (${resp.data.product_count} products)`);
    } catch (e) { console.log(`  Active catalog check: ❌ FAILED — ${e.response?.data?.error?.message || e.message}`); }
  }

  // Summary
  console.log('\n── DIAGNOSIS ──');
  const issues = [];
  if (!restaurant.meta_catalog_id && !wa?.catalog_id) issues.push('NO_ACTIVE_CATALOG_ID: meta_catalog_id and wa catalog_id are both null');
  if (!wa?.waba_id) issues.push('NO_WABA_ID: cannot fetch catalogs from Meta');
  if (!TOKEN) issues.push('NO_TOKEN: META_SYSTEM_USER_TOKEN not set');
  if (!bizId) issues.push('NO_BUSINESS_ID: cannot fetch business catalogs');

  if (issues.length) {
    issues.forEach(i => console.log(`  ❌ ${i}`));
    console.log('\n  SUGGESTED FIX:');
    if (issues.some(i => i.startsWith('NO_ACTIVE_CATALOG_ID'))) console.log('  → Run: POST /api/restaurant/catalog-diagnosis/fix (auto-links existing catalog)');
    if (issues.some(i => i.startsWith('NO_WABA_ID'))) console.log('  → Re-connect WhatsApp via Meta Embedded Signup');
    if (issues.some(i => i.startsWith('NO_TOKEN'))) console.log('  → Set META_SYSTEM_USER_TOKEN in Vercel env vars');
    if (issues.some(i => i.startsWith('NO_BUSINESS_ID'))) console.log('  → Set META_BUSINESS_ID in Vercel env vars');
  } else {
    console.log('  ✅ All checks passed — catalog should be visible');
    console.log('  If still not visible, check browser console for frontend errors');
  }

  console.log('\n========================================');
  await client.close();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
