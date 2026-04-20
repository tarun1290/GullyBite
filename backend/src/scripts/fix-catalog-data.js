#!/usr/bin/env node
// Migration script — fixes catalog data issues found by diagnostic.
// Run: cd backend && node src/scripts/fix-catalog-data.js

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
if (!process.env.MONGODB_URI) require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { MongoClient } = require('mongodb');
const axios = require('axios');

const MONGO_URI = process.env.MONGODB_URI;
const MONGO_DB = process.env.MONGODB_DB || 'gullybite';
const TOKEN = process.env.META_SYSTEM_USER_TOKEN;
const API_VERSION = process.env.WA_API_VERSION || 'v25.0';
const GRAPH = `https://graph.facebook.com/${API_VERSION}`;

function slugify(str, maxLen = 40) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, maxLen);
}

let db;

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  CATALOG DATA MIGRATION');
  console.log('  ' + new Date().toISOString());
  console.log('═══════════════════════════════════════════════════════════\n');

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(MONGO_DB);
  console.log('✅ MongoDB connected\n');

  // ── Fix A: Missing restaurant_id ─────────────────────────
  console.log('─── Fix A: Missing restaurant_id on menu items ─────────');
  const branches = await db.collection('branches').find({}).toArray();
  const branchMap = {};
  for (const b of branches) branchMap[String(b._id)] = String(b.restaurant_id);

  const itemsMissingRid = await db.collection('menu_items').find({
    $or: [{ restaurant_id: null }, { restaurant_id: { $exists: false } }],
    branch_id: { $nin: ['__all__', '__unassigned__', null] },
  }).toArray();

  let fixedRid = 0;
  for (const item of itemsMissingRid) {
    const rid = branchMap[String(item.branch_id)];
    if (rid) {
      await db.collection('menu_items').updateOne({ _id: item._id }, { $set: { restaurant_id: rid } });
      fixedRid++;
    }
  }
  console.log(`  Fixed: ${fixedRid} items (of ${itemsMissingRid.length} missing)\n`);

  // ── Fix B: Missing branch_slug ───────────────────────────
  console.log('─── Fix B: Missing branch_slug ────────────────────────');
  const branchesNoSlug = await db.collection('branches').find({
    $or: [{ branch_slug: null }, { branch_slug: '' }, { branch_slug: { $exists: false } }],
  }).toArray();

  for (const b of branchesNoSlug) {
    const newSlug = slugify(b.name, 20) || String(b._id).slice(0, 8);
    await db.collection('branches').updateOne({ _id: b._id }, { $set: { branch_slug: newSlug } });
    console.log(`  "${b.name}" → slug: "${newSlug}"`);
  }
  console.log(`  Fixed: ${branchesNoSlug.length} branches\n`);

  // Reload branches with updated slugs
  const updatedBranches = await db.collection('branches').find({}).toArray();
  const slugMap = {};
  for (const b of updatedBranches) slugMap[String(b._id)] = b.branch_slug || slugify(b.name, 20);

  // ── Fix C: Items with branch_id "__all__" ────────────────
  console.log('─── Fix C: Items with branch_id "__all__" ─────────────');
  const allBranchItems = await db.collection('menu_items').find({ branch_id: '__all__' }).toArray();
  if (allBranchItems.length) {
    const firstBranch = updatedBranches[0];
    if (firstBranch) {
      const result = await db.collection('menu_items').updateMany(
        { branch_id: '__all__' },
        { $set: { branch_id: String(firstBranch._id), restaurant_id: String(firstBranch.restaurant_id) } }
      );
      console.log(`  Reassigned ${result.modifiedCount} items from "__all__" to "${firstBranch.name}" (${firstBranch._id})`);
    }
  } else {
    console.log('  No items with branch_id "__all__"');
  }
  console.log('');

  // ── Fix D: Price sanity check ────────────────────────────
  console.log('─── Fix D: Price sanity check (>₹10,000) ─────────────');
  const expensiveItems = await db.collection('menu_items').find({ price_paise: { $gt: 1000000 } }).toArray();
  if (expensiveItems.length) {
    console.log('  ⚠️ Items with suspiciously high prices (>₹10,000):');
    for (const item of expensiveItems) {
      console.log(`    "${item.name}" — ₹${(item.price_paise / 100).toFixed(2)} (${item.price_paise} paise) — branch: ${item.branch_id}`);
    }
    console.log('  ACTION REQUIRED: Fix these manually in the dashboard');
  } else {
    console.log('  All prices look reasonable ✅');
  }
  console.log('');

  // ── Fix E: Reset sync status ─────────────────────────────
  console.log('─── Fix E: Reset sync status to "pending" ─────────────');
  const resetResult = await db.collection('menu_items').updateMany(
    { catalog_sync_status: { $in: ['synced', 'error'] } },
    { $set: { catalog_sync_status: 'pending' } }
  );
  console.log(`  Reset: ${resetResult.modifiedCount} items to "pending"\n`);

  // ── Fix F: Regenerate malformed retailer_ids ─────────────
  console.log('─── Fix F: Regenerate malformed retailer_ids ──────────');
  const allItems = await db.collection('menu_items').find({}).toArray();
  let regenCount = 0;
  const examples = [];

  // Build set of valid branch slugs
  const validSlugs = new Set(Object.values(slugMap));

  for (const item of allItems) {
    if (!item.retailer_id || !item.branch_id) continue;
    const branchSlug = slugMap[String(item.branch_id)];
    if (!branchSlug) continue;

    // Check if retailer_id starts with a valid branch slug
    const startsWithSlug = item.retailer_id.startsWith(branchSlug + '-');
    // Check for old malformed format (ZM-*, branch _id fragments, etc.)
    const isMalformed = item.retailer_id.startsWith('ZM-') ||
                        item.retailer_id.startsWith('branch-') ||
                        /^[a-f0-9]{6}-/.test(item.retailer_id);

    if (!startsWithSlug || isMalformed) {
      const oldId = item.retailer_id;
      const itemSlug = slugify(item.name, 40);
      const sizeSlug = item.size ? slugify(item.size, 15) : null;
      const newRetailerId = sizeSlug ? `${branchSlug}-${itemSlug}-${sizeSlug}` : `${branchSlug}-${itemSlug}`;
      const newGroupId = sizeSlug ? `${branchSlug}-${itemSlug}` : null;

      const $set = { retailer_id: newRetailerId, catalog_sync_status: 'pending' };
      if (newGroupId && item.item_group_id) $set.item_group_id = newGroupId;

      await db.collection('menu_items').updateOne({ _id: item._id }, { $set });
      regenCount++;
      if (examples.length < 5) examples.push({ name: item.name, old: oldId, new: newRetailerId });
    }
  }
  console.log(`  Regenerated: ${regenCount} retailer_ids`);
  if (examples.length) {
    console.log('  Examples:');
    for (const ex of examples) console.log(`    "${ex.name}": ${ex.old} → ${ex.new}`);
  }
  console.log('');

  // ── Fix G: Verify token and trigger sync ─────────────────
  console.log('─── Fix G: Token verification ─────────────────────────');
  if (!TOKEN) {
    console.error('  ❌ No token found. Set META_SYSTEM_USER_TOKEN and re-run.');
    await client.close();
    return;
  }

  try {
    const { data } = await axios.get('https://graph.facebook.com/debug_token', {
      params: { input_token: TOKEN, access_token: TOKEN }, timeout: 10000,
    });
    const d = data.data || {};
    console.log(`  Valid: ${d.is_valid} | Type: ${d.type} | Expires: ${d.expires_at === 0 ? 'Never' : d.expires_at}`);
    console.log(`  Scopes: ${(d.scopes || []).join(', ')}`);
    if (!d.is_valid) {
      console.error('  ❌ TOKEN IS INVALID — cannot sync. Generate a new System User Token.');
      await client.close();
      return;
    }
    if (!d.scopes?.includes('catalog_management')) {
      console.error('  ❌ Missing catalog_management scope — cannot sync catalogs.');
      await client.close();
      return;
    }
  } catch (e) {
    console.error(`  ❌ Token validation failed: ${e.response?.data?.error?.message || e.message}`);
    console.log('  Skipping sync — fix the token first.');
    await client.close();
    return;
  }

  // Trigger full catalog sync
  console.log('\n─── Triggering full catalog sync ──────────────────────');
  const restaurants = await db.collection('restaurants').find({}).toArray();
  for (const r of restaurants) {
    if (!r.meta_catalog_id) { console.log(`  ${r.business_name}: No catalog ID — skipping`); continue; }
    console.log(`  Syncing ${r.business_name} (catalog: ${r.meta_catalog_id})...`);
    try {
      // Use the catalog service directly
      const catalog = require('../services/catalog');
      const result = await catalog.syncRestaurantCatalog(String(r._id));
      console.log(`  ✅ Synced: ${result.totalSynced || 0} items, Failed: ${result.totalFailed || 0}`);
      if (result.totalFailed > 0) {
        const errors = result.branches?.filter(b => b.error).map(b => b.error) || [];
        errors.forEach(e => console.log(`    Error: ${e}`));
      }

      // Verify on Meta
      try {
        const { data } = await axios.get(`${GRAPH}/${r.meta_catalog_id}`, {
          params: { fields: 'product_count', access_token: TOKEN }, timeout: 10000,
        });
        const localCount = await db.collection('menu_items').countDocuments({
          restaurant_id: String(r._id), retailer_id: { $exists: true, $ne: null },
        });
        console.log(`  Meta product count: ${data.product_count || 0} | Local items: ${localCount}`);
      } catch (ve) {
        console.log(`  Could not verify Meta count: ${ve.response?.data?.error?.message || ve.message}`);
      }
    } catch (e) {
      console.error(`  ❌ Sync failed: ${e.message}`);
    }
  }

  // ── Summary ──────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  MIGRATION COMPLETE');
  console.log(`  restaurant_id fixed: ${fixedRid}`);
  console.log(`  branch_slug fixed: ${branchesNoSlug.length}`);
  console.log(`  __all__ items reassigned: ${allBranchItems.length}`);
  console.log(`  sync status reset: ${resetResult.modifiedCount}`);
  console.log(`  retailer_ids regenerated: ${regenCount}`);
  console.log(`  suspicious prices: ${expensiveItems.length}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  await client.close();
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
