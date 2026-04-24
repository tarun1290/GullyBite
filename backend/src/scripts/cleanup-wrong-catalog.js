#!/usr/bin/env node
// One-time cleanup script — delete orphan feeds and wrong catalogs
// Run from backend/ directory:
//   node src/scripts/cleanup-wrong-catalog.js           (live mode)
//   node src/scripts/cleanup-wrong-catalog.js --dry-run  (preview only)

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env'), quiet: true });
if (!process.env.MONGODB_URI) require('dotenv').config({ path: path.join(__dirname, '../../.env'), quiet: true });

const { MongoClient } = require('mongodb');
const axios = require('axios');
const readline = require('readline');

const MONGO_URI  = process.env.MONGODB_URI;
const MONGO_DB   = process.env.MONGODB_DB || 'gullybite';
const TOKEN      = process.env.META_SYSTEM_USER_TOKEN;
const API_VER    = process.env.WA_API_VERSION || 'v25.0';
const GRAPH      = `https://graph.facebook.com/${API_VER}`;
const DRY_RUN    = process.argv.includes('--dry-run');
const WRONG_CATALOG_ID = '1457487692763828';

let db;
const summary = { feeds_deleted: 0, catalogs_cleaned: 0, branches_fixed: 0, errors: [] };

// ── Helpers ──
async function metaGet(path, params = {}) {
  const resp = await axios.get(`${GRAPH}/${path}`, { params: { access_token: TOKEN, ...params }, timeout: 15000 });
  return resp.data;
}
async function metaPost(path, body = {}) {
  const resp = await axios.post(`${GRAPH}/${path}`, body, { headers: { Authorization: `Bearer ${TOKEN}` }, timeout: 15000 });
  return resp.data;
}
async function metaDelete(path) {
  const resp = await axios.delete(`${GRAPH}/${path}`, { params: { access_token: TOKEN }, timeout: 15000 });
  return resp.data;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim().toLowerCase()); }));
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  GULLYBITE CATALOG CLEANUP SCRIPT');
  console.log(DRY_RUN ? '  MODE: DRY RUN (no changes)' : '  MODE: LIVE (will modify data)');
  console.log('═══════════════════════════════════════════════════════════\n');

  if (!MONGO_URI) { console.error('MONGODB_URI not set'); process.exit(1); }
  if (!TOKEN) { console.error('META_SYSTEM_USER_TOKEN not set'); process.exit(1); }

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(MONGO_DB);
  console.log('Connected to MongoDB:', MONGO_DB);
  console.log('Meta API:', GRAPH);
  console.log('Token:', TOKEN.substring(0, 15) + '...\n');

  // ═══════════════════════════════════════════════════════
  // STEP 1: Find and delete orphan feeds
  // ═══════════════════════════════════════════════════════
  console.log('── STEP 1: Check for orphan feeds ──────────────────────\n');

  const restaurants = await db.collection('restaurants').find({}).toArray();
  console.log(`Found ${restaurants.length} restaurant(s)\n`);

  for (const rest of restaurants) {
    console.log(`Restaurant: "${rest.business_name}" (${rest._id})`);
    console.log(`  meta_catalog_id: ${rest.meta_catalog_id || 'NONE'}`);
    console.log(`  meta_feed_id:    ${rest.meta_feed_id || 'NONE'}`);

    if (rest.meta_feed_id) {
      try {
        const feedData = await metaGet(rest.meta_feed_id, { fields: 'id,name,schedule,product_catalog' });
        const feedCatalogId = feedData.product_catalog?.id || null;
        console.log(`  Feed "${feedData.name}" → catalog: ${feedCatalogId}`);

        if (feedCatalogId && feedCatalogId !== rest.meta_catalog_id) {
          console.log(`  ⚠️  ORPHAN FEED: feed points to catalog ${feedCatalogId} but restaurant uses ${rest.meta_catalog_id}`);

          if (DRY_RUN) {
            console.log(`  [DRY RUN] Would delete feed ${rest.meta_feed_id} and clear meta_feed_id`);
          } else {
            const ans = await ask(`  Delete orphan feed ${rest.meta_feed_id}? (y/n) `);
            if (ans === 'y') {
              try {
                await metaDelete(rest.meta_feed_id);
                await db.collection('restaurants').updateOne({ _id: rest._id }, { $unset: { meta_feed_id: '' } });
                console.log(`  ✅ Feed deleted and meta_feed_id cleared`);
                summary.feeds_deleted++;
              } catch (delErr) {
                console.error(`  ❌ Feed delete failed: ${delErr.response?.data?.error?.message || delErr.message}`);
                summary.errors.push(`Feed ${rest.meta_feed_id}: ${delErr.message}`);
              }
            } else {
              console.log('  Skipped.');
            }
          }
        } else if (feedCatalogId === rest.meta_catalog_id) {
          console.log('  ✅ Feed correctly points to active catalog');
        }
      } catch (feedErr) {
        const errMsg = feedErr.response?.data?.error?.message || feedErr.message;
        if (feedErr.response?.status === 404 || errMsg.includes('does not exist')) {
          console.log(`  Feed ${rest.meta_feed_id} no longer exists on Meta — clearing from DB`);
          if (!DRY_RUN) {
            await db.collection('restaurants').updateOne({ _id: rest._id }, { $unset: { meta_feed_id: '' } });
          }
        } else {
          console.error(`  ❌ Feed check failed: ${errMsg}`);
        }
      }
    }
    console.log('');
  }

  // Check branch catalog_id mismatches
  console.log('── Check branch catalog_id alignment ──\n');
  for (const rest of restaurants) {
    const branches = await db.collection('branches').find({ restaurant_id: rest._id }).toArray();
    for (const br of branches) {
      if (br.catalog_id && rest.meta_catalog_id && br.catalog_id !== rest.meta_catalog_id) {
        console.log(`  ⚠️  Branch "${br.name}" (${br._id}): catalog_id=${br.catalog_id} != restaurant meta_catalog_id=${rest.meta_catalog_id}`);
        if (!DRY_RUN) {
          await db.collection('branches').updateOne({ _id: br._id }, { $set: { catalog_id: rest.meta_catalog_id } });
          console.log(`  ✅ Fixed: set branch catalog_id to ${rest.meta_catalog_id}`);
          summary.branches_fixed++;
        } else {
          console.log(`  [DRY RUN] Would set branch catalog_id to ${rest.meta_catalog_id}`);
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  // STEP 2: Clean up wrong catalog (1457487692763828)
  // ═══════════════════════════════════════════════════════
  console.log('\n── STEP 2: Clean up wrong catalog ─────────────────────\n');
  console.log(`Target: catalog ${WRONG_CATALOG_ID} ("test 01")`);

  // 2a: Delete all feeds on the wrong catalog
  try {
    const feedsResp = await metaGet(`${WRONG_CATALOG_ID}/product_feeds`, { fields: 'id,name' });
    const feeds = feedsResp.data || [];
    console.log(`  Found ${feeds.length} feed(s) on wrong catalog`);
    for (const feed of feeds) {
      console.log(`  Feed: "${feed.name}" (${feed.id})`);
      if (DRY_RUN) {
        console.log(`  [DRY RUN] Would delete feed ${feed.id}`);
      } else {
        const ans = await ask(`  Delete feed "${feed.name}" (${feed.id})? (y/n) `);
        if (ans === 'y') {
          try {
            await metaDelete(feed.id);
            console.log(`  ✅ Feed ${feed.id} deleted`);
            summary.feeds_deleted++;
          } catch (e) {
            console.error(`  ❌ Delete failed: ${e.response?.data?.error?.message || e.message}`);
            summary.errors.push(`Feed ${feed.id}: ${e.message}`);
          }
        }
      }
    }
  } catch (e) {
    console.log(`  Could not list feeds: ${e.response?.data?.error?.message || e.message}`);
  }

  // 2b: Unlink from WABAs
  const waAccounts = await db.collection('whatsapp_accounts').find({}).toArray();
  for (const wa of waAccounts) {
    if (wa.waba_id) {
      console.log(`\n  Unlinking from WABA ${wa.waba_id}...`);
      if (DRY_RUN) {
        console.log(`  [DRY RUN] Would call DELETE /${wa.waba_id}/product_catalogs {catalog_id: ${WRONG_CATALOG_ID}}`);
      } else {
        try {
          await axios.delete(`${GRAPH}/${wa.waba_id}/product_catalogs`, {
            data: { catalog_id: WRONG_CATALOG_ID },
            headers: { Authorization: `Bearer ${TOKEN}` },
            timeout: 15000,
          });
          console.log(`  ✅ Unlinked from WABA ${wa.waba_id}`);
        } catch (e) {
          const msg = e.response?.data?.error?.message || e.message;
          if (msg.includes('not linked') || msg.includes('does not exist')) {
            console.log(`  Already not linked to WABA ${wa.waba_id}`);
          } else {
            console.error(`  ❌ Unlink failed: ${msg}`);
          }
        }
      }
    }
  }

  // 2c: Delete the catalog itself
  console.log(`\n  Deleting catalog ${WRONG_CATALOG_ID}...`);
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would call DELETE /${WRONG_CATALOG_ID}`);
  } else {
    const ans = await ask(`  DELETE catalog ${WRONG_CATALOG_ID}? This is irreversible. (y/n) `);
    if (ans === 'y') {
      try {
        await metaDelete(WRONG_CATALOG_ID);
        console.log(`  ✅ Catalog ${WRONG_CATALOG_ID} deleted`);
        summary.catalogs_cleaned++;
      } catch (e) {
        console.error(`  ❌ Catalog delete failed: ${e.response?.data?.error?.message || e.message}`);
        summary.errors.push(`Catalog ${WRONG_CATALOG_ID}: ${e.message}`);
      }
    }
  }

  // 2d: Clean up MongoDB references
  console.log('\n  Cleaning MongoDB references...');
  const wrongRefs = {
    restaurants: await db.collection('restaurants').countDocuments({ meta_catalog_id: WRONG_CATALOG_ID }),
    branches: await db.collection('branches').countDocuments({ catalog_id: WRONG_CATALOG_ID }),
    wa_accounts: await db.collection('whatsapp_accounts').countDocuments({ catalog_id: WRONG_CATALOG_ID }),
  };
  console.log(`  References found: restaurants=${wrongRefs.restaurants}, branches=${wrongRefs.branches}, wa_accounts=${wrongRefs.wa_accounts}`);

  if (DRY_RUN) {
    console.log('  [DRY RUN] Would null out all references');
  } else {
    if (wrongRefs.restaurants) await db.collection('restaurants').updateMany({ meta_catalog_id: WRONG_CATALOG_ID }, { $set: { meta_catalog_id: null, meta_catalog_name: null } });
    if (wrongRefs.branches) await db.collection('branches').updateMany({ catalog_id: WRONG_CATALOG_ID }, { $set: { catalog_id: null } });
    if (wrongRefs.wa_accounts) await db.collection('whatsapp_accounts').updateMany({ catalog_id: WRONG_CATALOG_ID }, { $set: { catalog_id: null } });
    console.log('  ✅ All MongoDB references cleared');
  }

  // ═══════════════════════════════════════════════════════
  // STEP 3: Verify correct catalog connection
  // ═══════════════════════════════════════════════════════
  console.log('\n── STEP 3: Verify correct catalog ─────────────────────\n');

  for (const rest of restaurants) {
    console.log(`Restaurant: "${rest.business_name}"`);
    const restCatalogId = rest.meta_catalog_id;
    console.log(`  DB meta_catalog_id: ${restCatalogId || 'NONE'}`);

    const wa = waAccounts.find(w => w.restaurant_id === rest._id);
    if (!wa) { console.log('  No WA account found\n'); continue; }
    console.log(`  WABA ID: ${wa.waba_id}, Phone: ${wa.phone_number_id}`);

    // Check WABA connected catalogs
    if (wa.waba_id) {
      try {
        const wabaCats = await metaGet(`${wa.waba_id}/product_catalogs`, { fields: 'id,name' });
        const connected = (wabaCats.data || []).map(c => `${c.name} (${c.id})`).join(', ') || 'NONE';
        console.log(`  WABA catalogs: ${connected}`);
        const hasCorrect = (wabaCats.data || []).some(c => c.id === restCatalogId);
        console.log(`  Correct catalog connected: ${hasCorrect ? '✅ YES' : '❌ NO'}`);
      } catch (e) {
        console.log(`  Could not fetch WABA catalogs: ${e.response?.data?.error?.message || e.message}`);
      }
    }

    // Check commerce settings
    if (wa.phone_number_id) {
      try {
        const cs = await metaGet(`${wa.phone_number_id}/whatsapp_commerce_settings`);
        const settings = cs.data?.[0] || {};
        console.log(`  Commerce settings:`);
        console.log(`    Catalog visible: ${settings.is_catalog_visible ? '✅' : '❌'}`);
        console.log(`    Cart enabled:    ${settings.is_cart_enabled ? '✅' : '❌'}`);
        console.log(`    Catalog ID:      ${settings.id || 'NONE'}`);
      } catch (e) {
        console.log(`  Commerce settings: not configured (${e.response?.data?.error?.message || e.message})`);
      }
    }
    console.log('');
  }

  // ═══════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Feeds deleted:     ${summary.feeds_deleted}`);
  console.log(`  Catalogs cleaned:  ${summary.catalogs_cleaned}`);
  console.log(`  Branches fixed:    ${summary.branches_fixed}`);
  console.log(`  Errors:            ${summary.errors.length}`);
  if (summary.errors.length) {
    summary.errors.forEach(e => console.log(`    - ${e}`));
  }
  if (DRY_RUN) console.log('\n  ⚠️  DRY RUN — no changes were made. Run without --dry-run to apply.');
  console.log('═══════════════════════════════════════════════════════════');

  await client.close();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
