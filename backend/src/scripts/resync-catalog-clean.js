#!/usr/bin/env node
// Re-sync catalog after field mapping fix + re-register feed on correct catalog
// Run from backend/ directory:
//   node src/scripts/resync-catalog-clean.js --dry-run   (preview)
//   node src/scripts/resync-catalog-clean.js              (live)

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env'), quiet: true });
if (!process.env.MONGODB_URI) require('dotenv').config({ path: path.join(__dirname, '../../.env'), quiet: true });

const { MongoClient } = require('mongodb');
const axios = require('axios');

const MONGO_URI  = process.env.MONGODB_URI;
const MONGO_DB   = process.env.MONGODB_DB || 'gullybite';
const TOKEN      = process.env.META_SYSTEM_USER_TOKEN;
const API_VER    = process.env.WA_API_VERSION || 'v25.0';
const GRAPH      = `https://graph.facebook.com/${API_VER}`;
const BASE_URL   = process.env.BASE_URL;
if (!BASE_URL) { console.error('BASE_URL is not set; aborting.'); process.exit(1); }
const DRY_RUN    = process.argv.includes('--dry-run');

let db;
const summary = { stale_deleted: 0, branches_synced: 0, items_updated: 0, items_failed: 0, feeds_registered: 0, errors: [] };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  GULLYBITE CATALOG RE-SYNC + FEED RE-REGISTER');
  console.log(DRY_RUN ? '  MODE: DRY RUN' : '  MODE: LIVE');
  console.log('═══════════════════════════════════════════════════════════\n');

  if (!MONGO_URI) { console.error('MONGODB_URI not set'); process.exit(1); }
  if (!TOKEN) { console.error('META_SYSTEM_USER_TOKEN not set'); process.exit(1); }

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(MONGO_DB);
  console.log('Connected to MongoDB:', MONGO_DB);
  console.log('Meta API:', GRAPH, '\n');

  const restaurants = await db.collection('restaurants').find({}).toArray();
  console.log(`Found ${restaurants.length} restaurant(s)\n`);

  for (const rest of restaurants) {
    console.log(`\n══ Restaurant: "${rest.business_name}" ══`);
    const catalogId = rest.meta_catalog_id;
    if (!catalogId) {
      console.log('  No meta_catalog_id — skipping');
      continue;
    }
    console.log(`  Catalog: ${catalogId}`);

    // ─── STEP 2: Clear stale items ───────────────────────────
    console.log('\n  ── Clearing stale items ──');
    try {
      // Fetch all items on Meta catalog (paginated)
      const metaRetailerIds = new Set();
      let url = `${GRAPH}/${catalogId}/products?fields=id,retailer_id&limit=500&access_token=${TOKEN}`;
      while (url) {
        const resp = await axios.get(url, { timeout: 30000 });
        for (const p of (resp.data.data || [])) {
          if (p.retailer_id) metaRetailerIds.add(p.retailer_id);
        }
        url = resp.data.paging?.next || null;
      }
      console.log(`  Meta catalog has ${metaRetailerIds.size} items`);

      // Get all current retailer_ids from MongoDB for this restaurant
      const branches = await db.collection('branches').find({ restaurant_id: rest._id }).toArray();
      const branchIds = branches.map(b => b._id);
      const dbItems = await db.collection('menu_items').find(
        { branch_id: { $in: branchIds }, retailer_id: { $exists: true, $ne: null } },
        { projection: { retailer_id: 1 } }
      ).toArray();
      const dbRetailerIds = new Set(dbItems.map(i => i.retailer_id));
      console.log(`  MongoDB has ${dbRetailerIds.size} items`);

      // Find stale (on Meta but not in DB)
      const staleIds = [];
      for (const rid of metaRetailerIds) {
        if (!dbRetailerIds.has(rid)) staleIds.push(rid);
      }
      console.log(`  Stale items to delete: ${staleIds.length}`);

      if (staleIds.length && !DRY_RUN) {
        // Batch delete stale items via items_batch
        const BATCH = 4999;
        for (let i = 0; i < staleIds.length; i += BATCH) {
          const batch = staleIds.slice(i, i + BATCH);
          try {
            await axios.post(`${GRAPH}/${catalogId}/items_batch`, {
              item_type: 'PRODUCT_ITEM',
              requests: JSON.stringify(batch.map(rid => ({ method: 'DELETE', retailer_id: rid }))),
            }, { params: { access_token: TOKEN }, timeout: 30000 });
            summary.stale_deleted += batch.length;
            console.log(`  Deleted batch ${Math.floor(i / BATCH) + 1}: ${batch.length} items`);
          } catch (e) {
            console.error(`  Batch delete failed: ${e.response?.data?.error?.message || e.message}`);
            summary.errors.push(`Stale delete: ${e.message}`);
          }
          if (i + BATCH < staleIds.length) await sleep(1000);
        }
      } else if (staleIds.length && DRY_RUN) {
        console.log(`  [DRY RUN] Would delete ${staleIds.length} stale items`);
      }
    } catch (e) {
      console.error(`  Stale check failed: ${e.response?.data?.error?.message || e.message}`);
      summary.errors.push(`Stale check: ${e.message}`);
    }

    // ─── STEP 3: Re-sync all branches ────────────────────────
    console.log('\n  ── Re-syncing branches ──');

    // We need the real DB connection for syncBranchCatalog — override the database module
    // to use our live MongoClient connection
    const dbModule = require('../config/database');
    // Patch col() to use our live db if the module uses a different connection
    const origCol = dbModule.col;
    dbModule.col = (name) => db.collection(name);

    const catalog = require('../services/catalog');
    const branches = await db.collection('branches').find({ restaurant_id: rest._id }).toArray();

    for (const branch of branches) {
      console.log(`\n  Branch: "${branch.name}" (${branch._id})`);

      // Ensure branch has correct catalog_id
      if (!branch.catalog_id || branch.catalog_id !== catalogId) {
        console.log(`    Fixing catalog_id: ${branch.catalog_id || 'null'} → ${catalogId}`);
        if (!DRY_RUN) {
          await db.collection('branches').updateOne({ _id: branch._id }, { $set: { catalog_id: catalogId } });
        }
      }

      const itemCount = await db.collection('menu_items').countDocuments({ branch_id: branch._id });
      console.log(`    Menu items: ${itemCount}`);

      if (!itemCount) {
        console.log('    No items — skipping sync');
        continue;
      }

      if (DRY_RUN) {
        console.log(`    [DRY RUN] Would sync ${itemCount} items`);
        continue;
      }

      try {
        const result = await catalog.syncBranchCatalog(String(branch._id));
        console.log(`    ✅ Synced: ${result.updated} updated, ${result.failed} failed`);
        summary.branches_synced++;
        summary.items_updated += result.updated || 0;
        summary.items_failed += result.failed || 0;
        if (result.errors?.length) {
          result.errors.forEach(e => {
            console.log(`    ⚠️  ${e}`);
            summary.errors.push(e);
          });
        }
      } catch (e) {
        console.error(`    ❌ Sync failed: ${e.message}`);
        summary.errors.push(`Branch ${branch.name}: ${e.message}`);
      }

      // Rate limit: 2-second delay between branch syncs
      await sleep(2000);
    }

    // Restore original col
    dbModule.col = origCol;

    // ─── STEP 4: Re-register feed ────────────────────────────
    console.log('\n  ── Re-registering feed ──');

    const feedToken = rest.catalog_feed_token;
    if (!feedToken) {
      console.log('  No catalog_feed_token — skipping feed registration');
      continue;
    }

    const feedUrl = `${BASE_URL}/feed/${feedToken}`;
    const feedName = `${rest.business_name || 'GullyBite'} Live Menu Feed`;
    console.log(`  Feed URL: ${feedUrl}`);
    console.log(`  Feed name: ${feedName}`);

    if (rest.meta_feed_id) {
      console.log(`  Existing meta_feed_id: ${rest.meta_feed_id} — already registered`);
      continue;
    }

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would register feed on catalog ${catalogId}`);
      continue;
    }

    try {
      const feedRes = await axios.post(
        `${GRAPH}/${catalogId}/product_feeds`,
        { name: feedName, schedule: { interval: 'DAILY', url: feedUrl, hour: 2 } },
        { headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, timeout: 15000 }
      );
      const feedId = feedRes.data.id;
      await db.collection('restaurants').updateOne(
        { _id: rest._id },
        { $set: { meta_feed_id: feedId, catalog_feed_url: feedUrl, catalog_feed_registered_at: new Date() } }
      );
      console.log(`  ✅ Feed registered: ${feedId}`);
      summary.feeds_registered++;
    } catch (e) {
      console.error(`  ❌ Feed registration failed: ${e.response?.data?.error?.message || e.message}`);
      summary.errors.push(`Feed register: ${e.message}`);
    }
  }

  // ─── STEP 5: Verify ───────────────────────────────────────
  console.log('\n\n── Verification ──────────────────────────────────────\n');
  for (const rest of restaurants) {
    if (!rest.meta_catalog_id) continue;
    try {
      const resp = await axios.get(`${GRAPH}/${rest.meta_catalog_id}`, {
        params: { fields: 'id,name,product_count', access_token: TOKEN }, timeout: 15000,
      });
      console.log(`  "${rest.business_name}" → Catalog ${resp.data.id}: ${resp.data.product_count ?? '?'} products (${resp.data.name})`);
    } catch (e) {
      console.log(`  "${rest.business_name}" → Catalog check failed: ${e.response?.data?.error?.message || e.message}`);
    }
  }

  // Check for branches with null/mismatched catalog_id
  const badBranches = await db.collection('branches').find({
    $or: [{ catalog_id: null }, { catalog_id: { $exists: false } }],
  }).toArray();
  if (badBranches.length) {
    console.log(`\n  ⚠️  ${badBranches.length} branch(es) with no catalog_id:`);
    badBranches.forEach(b => console.log(`    - "${b.name}" (${b._id})`));
  } else {
    console.log('\n  ✅ All branches have catalog_id set');
  }

  // ─── SUMMARY ───────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Stale items deleted:  ${summary.stale_deleted}`);
  console.log(`  Branches synced:      ${summary.branches_synced}`);
  console.log(`  Items updated:        ${summary.items_updated}`);
  console.log(`  Items failed:         ${summary.items_failed}`);
  console.log(`  Feeds registered:     ${summary.feeds_registered}`);
  console.log(`  Errors:               ${summary.errors.length}`);
  if (summary.errors.length) summary.errors.forEach(e => console.log(`    - ${e}`));
  if (DRY_RUN) console.log('\n  ⚠️  DRY RUN — no changes were made.');
  console.log('═══════════════════════════════════════════════════════════');

  await client.close();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
