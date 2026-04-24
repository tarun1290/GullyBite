#!/usr/bin/env node
// Diagnostic script — run from backend/ directory:
//   node src/scripts/diagnose-catalog.js

'use strict';

const path = require('path');
// Try multiple .env locations
require('dotenv').config({ path: path.join(__dirname, '../../../.env'), quiet: true });
if (!process.env.MONGODB_URI) require('dotenv').config({ path: path.join(__dirname, '../../.env'), quiet: true });

const { MongoClient } = require('mongodb');
const axios = require('axios');

const MONGO_URI = process.env.MONGODB_URI;
const MONGO_DB = process.env.MONGODB_DB || 'gullybite';
const META_TOKEN = process.env.META_SYSTEM_USER_TOKEN;
const API_VERSION = process.env.WA_API_VERSION || 'v25.0';
const GRAPH = `https://graph.facebook.com/${API_VERSION}`;

let db;

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  GULLYBITE CATALOG PIPELINE DIAGNOSTIC');
  console.log('  ' + new Date().toISOString());
  console.log('═══════════════════════════════════════════════════════════\n');

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(MONGO_DB);
  console.log('✅ MongoDB connected\n');

  const summary = {};

  // ── A: RESTAURANT STATE ──────────────────────────────────
  console.log('─── A: RESTAURANT STATE ───────────────────────────────');
  const restaurants = await db.collection('restaurants').find({}).toArray();
  summary.totalRestaurants = restaurants.length;
  summary.approvedWithCatalog = 0;
  for (const r of restaurants) {
    const hasCatalog = !!r.meta_catalog_id;
    if (r.approval_status === 'approved' && hasCatalog) summary.approvedWithCatalog++;
    console.log(`  ${r.business_name || r.brand_name || r._id}`);
    console.log(`    _id: ${r._id}`);
    console.log(`    approval_status: ${r.approval_status || 'NOT SET'}`);
    console.log(`    meta_catalog_id: ${r.meta_catalog_id || '❌ NULL'}`);
    console.log(`    meta_catalog_name: ${r.meta_catalog_name || '—'}`);
    console.log(`    meta_business_id: ${r.meta_business_id || '—'}`);
    console.log(`    last_catalog_sync: ${r.last_catalog_sync || '—'}`);
    console.log(`    catalog_sync_enabled: ${r.catalog_sync_enabled ?? 'not set'}`);
    console.log('');
  }

  // ── B: WHATSAPP ACCOUNT STATE ────────────────────────────
  console.log('─── B: WHATSAPP ACCOUNT STATE ─────────────────────────');
  for (const r of restaurants) {
    const accounts = await db.collection('whatsapp_accounts').find({ restaurant_id: String(r._id) }).toArray();
    if (!accounts.length) accounts.push(...(await db.collection('whatsapp_accounts').find({ restaurant_id: r._id }).toArray()));
    if (!accounts.length) { console.log(`  ${r.business_name}: NO WHATSAPP ACCOUNTS\n`); continue; }
    for (const a of accounts) {
      console.log(`  ${r.business_name} — WA Account:`);
      console.log(`    waba_id: ${a.waba_id || '—'}`);
      console.log(`    phone_number_id: ${a.phone_number_id || '—'}`);
      console.log(`    catalog_id: ${a.catalog_id || '—'}`);
      console.log(`    catalog_linked: ${a.catalog_linked ?? '—'}`);
      console.log(`    cart_enabled: ${a.cart_enabled ?? '—'}`);
      console.log(`    catalog_visible: ${a.catalog_visible ?? '—'}`);
      console.log(`    is_active: ${a.is_active}`);
      console.log('');
    }
  }

  // ── C: BRANCH STATE ──────────────────────────────────────
  console.log('─── C: BRANCH STATE ───────────────────────────────────');
  let totalBranches = 0, branchesWithCatalog = 0, branchesSynced = 0;
  for (const r of restaurants) {
    const branches = await db.collection('branches').find({ restaurant_id: String(r._id) }).toArray();
    if (!branches.length) {
      const alt = await db.collection('branches').find({ restaurant_id: r._id }).toArray();
      branches.push(...alt);
    }
    for (const b of branches) {
      totalBranches++;
      if (b.catalog_id) branchesWithCatalog++;
      if (b.catalog_synced_at) branchesSynced++;
      const mismatch = b.catalog_id && r.meta_catalog_id && String(b.catalog_id) !== String(r.meta_catalog_id);
      console.log(`  ${b.name} (${b._id})`);
      console.log(`    branch_slug: ${b.branch_slug || '—'}`);
      console.log(`    catalog_id: ${b.catalog_id || '❌ NULL'}`);
      console.log(`    meta_product_set_id: ${b.meta_product_set_id || '—'}`);
      console.log(`    catalog_synced_at: ${b.catalog_synced_at || '—'}`);
      console.log(`    accepts_orders: ${b.accepts_orders}`);
      if (mismatch) console.log(`    ⚠️ MISMATCH: branch.catalog_id (${b.catalog_id}) ≠ restaurant.meta_catalog_id (${r.meta_catalog_id})`);
      console.log('');
    }
  }
  summary.totalBranches = totalBranches;
  summary.branchesWithCatalog = branchesWithCatalog;
  summary.branchesSynced = branchesSynced;

  // ── D: MENU ITEMS STATE ──────────────────────────────────
  console.log('─── D: MENU ITEMS STATE ───────────────────────────────');
  const allItems = await db.collection('menu_items').find({}).toArray();
  const synced = allItems.filter(i => i.catalog_sync_status === 'synced').length;
  const pending = allItems.filter(i => i.catalog_sync_status === 'pending').length;
  const errored = allItems.filter(i => i.catalog_sync_status === 'error').length;
  const noRestaurantId = allItems.filter(i => !i.restaurant_id).length;
  const noRetailerId = allItems.filter(i => !i.retailer_id).length;
  const noBranchId = allItems.filter(i => !i.branch_id).length;

  console.log(`  Total items: ${allItems.length}`);
  console.log(`  Synced: ${synced} | Pending: ${pending} | Error: ${errored} | Other: ${allItems.length - synced - pending - errored}`);
  console.log(`  Missing restaurant_id: ${noRestaurantId}`);
  console.log(`  Missing retailer_id: ${noRetailerId}`);
  console.log(`  Missing branch_id (orphaned): ${noBranchId}`);
  console.log(`\n  Sample items:`);
  for (const item of allItems.slice(0, 3)) {
    console.log(`    ${item.name} — retailer_id: ${item.retailer_id || '❌ NULL'} | branch_id: ${item.branch_id || '❌ NULL'} | restaurant_id: ${item.restaurant_id || '❌ NULL'} | sync: ${item.catalog_sync_status || '—'} | price_paise: ${item.price_paise}`);
  }
  summary.totalItems = allItems.length;
  summary.synced = synced;
  summary.pending = pending;
  summary.errored = errored;
  summary.noRestaurantId = noRestaurantId;
  summary.noRetailerId = noRetailerId;
  summary.noBranchId = noBranchId;
  console.log('');

  // ── E: META TOKEN VALIDATION ─────────────────────────────
  console.log('─── E: META TOKEN VALIDATION ──────────────────────────');
  summary.tokenValid = false;
  summary.tokenScopes = [];
  if (!META_TOKEN) {
    console.log('  ❌ No catalog token found (META_SYSTEM_USER_TOKEN unset)');
  } else {
    console.log(`  Token source: META_SYSTEM_USER_TOKEN`);
    console.log(`  Token length: ${META_TOKEN.length} chars`);
    try {
      const { data } = await axios.get('https://graph.facebook.com/debug_token', {
        params: { input_token: META_TOKEN, access_token: META_TOKEN },
        timeout: 10000,
      });
      const d = data.data || {};
      console.log(`  is_valid: ${d.is_valid}`);
      console.log(`  type: ${d.type}`);
      console.log(`  expires_at: ${d.expires_at === 0 ? 'Never' : d.expires_at ? new Date(d.expires_at * 1000).toISOString() : '—'}`);
      console.log(`  scopes: ${(d.scopes || []).join(', ')}`);
      summary.tokenValid = d.is_valid !== false;
      summary.tokenScopes = d.scopes || [];
      if (!d.scopes?.includes('catalog_management')) {
        console.log('  ⚠️ ⚠️ ⚠️  MISSING SCOPE: catalog_management — CATALOG SYNC WILL FAIL');
      }
    } catch (e) {
      console.log(`  ❌ Token debug failed: ${e.response?.data?.error?.message || e.message}`);
    }
  }
  console.log('');

  // ── F: META CATALOG VERIFICATION ─────────────────────────
  console.log('─── F: META CATALOG VERIFICATION ──────────────────────');
  summary.catalogExistsOnMeta = false;
  summary.metaProductCount = 0;
  for (const r of restaurants) {
    if (!r.meta_catalog_id) { console.log(`  ${r.business_name}: No catalog ID — skipping\n`); continue; }
    try {
      const { data } = await axios.get(`${GRAPH}/${r.meta_catalog_id}`, {
        params: { fields: 'name,product_count,vertical', access_token: META_TOKEN },
        timeout: 10000,
      });
      console.log(`  ${r.business_name} — Catalog ${r.meta_catalog_id}:`);
      console.log(`    name: ${data.name}`);
      console.log(`    product_count: ${data.product_count}`);
      console.log(`    vertical: ${data.vertical}`);
      summary.catalogExistsOnMeta = true;
      summary.metaProductCount = data.product_count || 0;
    } catch (e) {
      console.log(`  ${r.business_name} — ❌ STALE CATALOG ID (${r.meta_catalog_id}): ${e.response?.data?.error?.message || e.message}`);
    }

    try {
      const { data } = await axios.get(`${GRAPH}/${r.meta_catalog_id}/products`, {
        params: { fields: 'retailer_id,name', limit: 5, access_token: META_TOKEN },
        timeout: 10000,
      });
      console.log(`    First ${(data.data || []).length} products on Meta:`);
      for (const p of (data.data || [])) {
        console.log(`      ${p.retailer_id} — ${p.name}`);
      }
    } catch (e) {
      console.log(`    ❌ Product fetch failed: ${e.response?.data?.error?.message || e.message}`);
    }
    console.log('');
  }

  // ── G: APPROVAL STATUS IMPACT ────────────────────────────
  console.log('─── G: APPROVAL STATUS IMPACT ─────────────────────────');
  const unapproved = restaurants.filter(r => r.approval_status !== 'approved');
  if (unapproved.length) {
    console.log('  ⚠️ RESTAURANTS NOT APPROVED:');
    for (const r of unapproved) {
      console.log(`    ${r.business_name} — status: ${r.approval_status || 'NOT SET'}`);
    }
    console.log('  These restaurants CANNOT use: Create Catalog, Delete Catalog, Merge Catalogs, Sync Catalog');
    console.log('  The requireApproved middleware returns 403 silently.\n');
  } else {
    console.log('  All restaurants are approved ✅\n');
  }
  summary.unapprovedCount = unapproved.length;

  // ── H: CATALOG ID CONSISTENCY ────────────────────────────
  console.log('─── H: CATALOG ID CONSISTENCY ─────────────────────────');
  let inconsistencies = 0;
  for (const r of restaurants) {
    const wa = await db.collection('whatsapp_accounts').findOne({ restaurant_id: String(r._id), is_active: true });
    const branches = await db.collection('branches').find({ restaurant_id: String(r._id) }).toArray();
    const ids = new Set();
    if (r.meta_catalog_id) ids.add(String(r.meta_catalog_id));
    if (wa?.catalog_id) ids.add(String(wa.catalog_id));
    for (const b of branches) { if (b.catalog_id) ids.add(String(b.catalog_id)); }
    if (ids.size > 1) {
      inconsistencies++;
      console.log(`  ⚠️ ${r.business_name}: MULTIPLE CATALOG IDS FOUND`);
      console.log(`    restaurant.meta_catalog_id: ${r.meta_catalog_id || 'null'}`);
      console.log(`    whatsapp_accounts.catalog_id: ${wa?.catalog_id || 'null'}`);
      for (const b of branches) console.log(`    branch "${b.name}".catalog_id: ${b.catalog_id || 'null'}`);
    } else {
      console.log(`  ${r.business_name}: consistent (${[...ids][0] || 'no catalog'})`);
    }
  }
  summary.catalogInconsistencies = inconsistencies;
  console.log('');

  // ── I: META API WRITE TEST ───────────────────────────────
  console.log('─── I: META API WRITE TEST ────────────────────────────');
  summary.writeTestResult = 'skipped';
  const testRestaurant = restaurants.find(r => r.meta_catalog_id);
  if (!testRestaurant) {
    console.log('  No restaurant with catalog ID — skipping write test\n');
  } else {
    const catalogId = testRestaurant.meta_catalog_id;
    try {
      const { data, status } = await axios.post(`${GRAPH}/${catalogId}/items_batch`, {
        item_type: 'PRODUCT_ITEM',
        requests: JSON.stringify([{
          method: 'UPDATE',
          retailer_id: 'test-diagnostic-item',
          data: {
            id: 'test-diagnostic-item',
            title: 'Diagnostic Test Item (DELETE ME)',
            description: 'Testing catalog sync pipeline — safe to delete',
            availability: 'out of stock',
            condition: 'new',
            price: '1.00 INR',
            link: 'https://gullybite.com/test',
            image_link: '',
            brand: 'GullyBite Test',
            google_product_category: 'Food, Beverages & Tobacco > Food Items',
          },
        }]),
      }, {
        headers: { Authorization: `Bearer ${META_TOKEN}` },
        timeout: 15000,
      });
      console.log(`  Write test: HTTP ${status}`);
      console.log(`  Response: ${JSON.stringify(data).substring(0, 300)}`);
      summary.writeTestResult = status >= 200 && status < 300 ? 'SUCCESS' : `HTTP ${status}`;

      // Cleanup
      try {
        await axios.post(`${GRAPH}/${catalogId}/items_batch`, {
          item_type: 'PRODUCT_ITEM',
          requests: JSON.stringify([{ method: 'DELETE', retailer_id: 'test-diagnostic-item' }]),
        }, { headers: { Authorization: `Bearer ${META_TOKEN}` }, timeout: 10000 });
        console.log('  Cleanup: test item deleted ✅');
      } catch (ce) {
        console.log(`  Cleanup: delete failed (non-critical): ${ce.response?.data?.error?.message || ce.message}`);
      }
    } catch (e) {
      console.log(`  ❌ Write test FAILED: ${e.response?.status} — ${e.response?.data?.error?.message || e.message}`);
      if (e.response?.data) console.log(`  Full error: ${JSON.stringify(e.response.data).substring(0, 500)}`);
      summary.writeTestResult = `FAILED: ${e.response?.data?.error?.message || e.message}`;
    }
    console.log('');
  }

  // ── SUMMARY ──────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Restaurants: ${summary.totalRestaurants} total, ${summary.approvedWithCatalog} approved with catalog`);
  console.log(`  Branches: ${summary.totalBranches} total, ${summary.branchesWithCatalog} with catalog_id, ${summary.branchesSynced} synced`);
  console.log(`  Menu Items: ${summary.totalItems} total`);
  console.log(`    synced: ${summary.synced} | pending: ${summary.pending} | error: ${summary.errored}`);
  console.log(`    missing restaurant_id: ${summary.noRestaurantId} | missing retailer_id: ${summary.noRetailerId} | orphaned: ${summary.noBranchId}`);
  console.log(`  Token: ${summary.tokenValid ? '✅ valid' : '❌ invalid'} | scopes: ${summary.tokenScopes.join(', ') || 'none'}`);
  console.log(`  Catalog on Meta: ${summary.catalogExistsOnMeta ? '✅ exists' : '❌ not found'} | products: ${summary.metaProductCount}`);
  console.log(`  Consistency: ${summary.catalogInconsistencies === 0 ? '✅ all consistent' : `⚠️ ${summary.catalogInconsistencies} mismatches`}`);
  console.log(`  Approval gate: ${summary.unapprovedCount === 0 ? '✅ all approved' : `⚠️ ${summary.unapprovedCount} unapproved`}`);
  console.log(`  Meta write test: ${summary.writeTestResult}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  await client.close();
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
