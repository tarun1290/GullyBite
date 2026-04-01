#!/usr/bin/env node
// Fix prices 100x too high + trigger catalog sync
// Run: cd backend && node src/scripts/fix-prices-and-sync.js

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

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  FIX PRICES + CATALOG SYNC');
  console.log('  ' + new Date().toISOString());
  console.log('═══════════════════════════════════════════════════════════\n');

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(MONGO_DB);
  console.log('✅ MongoDB connected\n');

  // ── Fix A: Correct prices 100x too high ──────────────────
  console.log('─── Fix A: Price correction (÷100 where >₹10,000) ─────');
  const overpriced = await db.collection('menu_items').find({ price_paise: { $gt: 1000000 } }).toArray();
  console.log(`  Found ${overpriced.length} items with price >₹10,000\n`);

  if (overpriced.length) {
    // Preview first 5
    console.log('  Preview (first 5):');
    console.log('  ┌──────────────────────────────────┬──────────────┬──────────────┐');
    console.log('  │ Item Name                        │ Current (₹)  │ Corrected (₹)│');
    console.log('  ├──────────────────────────────────┼──────────────┼──────────────┤');
    for (const item of overpriced.slice(0, 5)) {
      const cur = (item.price_paise / 100).toFixed(0);
      const fix = (Math.round(item.price_paise / 100) / 100).toFixed(0);
      const name = (item.name || '').padEnd(34).slice(0, 34);
      console.log(`  │ ${name}│ ${cur.padStart(12)} │ ${fix.padStart(12)} │`);
    }
    console.log('  └──────────────────────────────────┴──────────────┴──────────────┘\n');

    // Apply fix
    let fixed = 0;
    for (const item of overpriced) {
      const $set = {
        price_paise: Math.round(item.price_paise / 100),
        catalog_sync_status: 'pending',
      };
      if (item.sale_price_paise && item.sale_price_paise > 1000000) {
        $set.sale_price_paise = Math.round(item.sale_price_paise / 100);
      }
      await db.collection('menu_items').updateOne({ _id: item._id }, { $set });
      fixed++;
    }
    console.log(`  ✅ Corrected ${fixed} items\n`);
  }

  // ── Fix B: Ensure sync status is pending ─────────────────
  console.log('─── Fix B: Reset sync status ──────────────────────────');
  const resetResult = await db.collection('menu_items').updateMany(
    { catalog_sync_status: { $ne: 'pending' } },
    { $set: { catalog_sync_status: 'pending' } }
  );
  console.log(`  Reset: ${resetResult.modifiedCount} items to "pending"\n`);

  // ── Fix C: Trigger full catalog sync ─────────────────────
  console.log('─── Fix C: Catalog sync ───────────────────────────────');

  // The catalog service uses the server's DB connection via col(), not our client.
  // We need to initialize it properly.
  // Approach: set up the server's DB connection first
  const { connect } = require('../config/database');
  await connect();
  console.log('  Server DB connection established');

  const catalog = require('../services/catalog');
  const restaurants = await db.collection('restaurants').find({}).toArray();

  for (const r of restaurants) {
    if (!r.meta_catalog_id) { console.log(`  ${r.business_name}: No catalog — skipping`); continue; }
    console.log(`  Syncing ${r.business_name}...`);
    try {
      const result = await catalog.syncRestaurantCatalog(String(r._id));
      console.log(`  ✅ Synced: ${result.totalSynced || 0} | Failed: ${result.totalFailed || 0}`);
      if (result.branches) {
        for (const b of result.branches) {
          console.log(`    Branch "${b.branchName || '?'}": ${b.updated || 0} synced, ${b.failed || 0} failed${b.error ? ' — ' + b.error : ''}`);
        }
      }
    } catch (e) {
      console.error(`  ❌ Sync failed: ${e.message}`);
    }
  }
  console.log('');

  // ── Fix D: Verify on Meta ────────────────────────────────
  console.log('─── Fix D: Verify on Meta ─────────────────────────────');
  for (const r of restaurants) {
    if (!r.meta_catalog_id) continue;
    try {
      // Product count
      const { data: catInfo } = await axios.get(`${GRAPH}/${r.meta_catalog_id}`, {
        params: { fields: 'name,product_count', access_token: TOKEN }, timeout: 10000,
      });
      const localCount = await db.collection('menu_items').countDocuments({
        restaurant_id: String(r._id), retailer_id: { $exists: true, $ne: null },
      });
      console.log(`  Catalog "${catInfo.name}": ${catInfo.product_count || 0} products on Meta | ${localCount} items locally`);

      // Sample products with prices
      const { data: products } = await axios.get(`${GRAPH}/${r.meta_catalog_id}/products`, {
        params: { fields: 'retailer_id,name,price', limit: 5, access_token: TOKEN }, timeout: 10000,
      });
      if (products.data?.length) {
        console.log('  Sample products on Meta:');
        for (const p of products.data) {
          console.log(`    ${p.retailer_id} — ${p.name} — ${p.price}`);
        }
      } else {
        console.log('  ⚠️ No products found on Meta (sync may still be processing)');
      }
    } catch (e) {
      console.error(`  ❌ Meta verification failed: ${e.response?.data?.error?.message || e.message}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  DONE');
  console.log('═══════════════════════════════════════════════════════════\n');

  await client.close();
  process.exit(0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
