#!/usr/bin/env node
// diagnose-mpm.js — Standalone diagnostic for WhatsApp MPM error 131009
// Usage: node backend/scripts/diagnose-mpm.js

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), quiet: true });

const axios = require('axios');
const { connect, col } = require('../src/config/database');
const metaConfig = require('../src/config/meta');
const { buildBranchMPMs } = require('../src/services/mpmBuilder');

const RESTAURANT_ID = '01fdf7d3-8d43-4ab6-ba34-8162da2c9f60';
const WABA_ID = 1587562225840851;

const graphUrl = metaConfig.graphUrl;
const token = metaConfig.systemUserToken;

// ── Result tracking ─────────────────────────────────────────────
const results = {
  token: 'SKIP',
  restaurantDoc: 'SKIP',
  whatsappAccount: 'SKIP',
  branches: 'SKIP',
  commerceSettings: 'SKIP',
  catalogOnMeta: 'SKIP',
  productsSample: 'SKIP',
  mpmDryRun: 'SKIP',
  catalogIdsMatch: 'SKIP',
};

let restaurantDoc = null;
let waAccount = null;
let branchesList = [];
let commerceData = null;
let metaCatalogData = null;

// ── Helpers ─────────────────────────────────────────────────────
function pass(label) { console.log(`[PASS] ${label}`); }
function fail(label, err) { console.log(`[FAIL] ${label} — ${err}`); }
function info(msg) { console.log(`[INFO] ${msg}`); }
function divider(title) { console.log(`\n${'='.repeat(60)}\n  CHECK: ${title}\n${'='.repeat(60)}`); }

// ── Check 1: Token validity ─────────────────────────────────────
async function check1_token() {
  divider('1 — Token validity');
  try {
    if (!token) throw new Error('META_SYSTEM_USER_TOKEN not set in env');
    const res = await axios.get(`${graphUrl}/me`, { params: { access_token: token }, timeout: 15000 });
    info(`App/User name: ${res.data.name || res.data.id}`);
    info(`ID: ${res.data.id}`);
    results.token = 'PASS';
    pass('Token is valid');
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    results.token = 'FAIL';
    fail('Token validity', msg);
  }
}

// ── Check 2: Restaurant document ────────────────────────────────
async function check2_restaurant() {
  divider('2 — Restaurant document');
  try {
    restaurantDoc = await col('restaurants').findOne({ _id: RESTAURANT_ID });
    if (!restaurantDoc) throw new Error('Restaurant not found in MongoDB');
    info(`business_name: ${restaurantDoc.business_name || restaurantDoc.name}`);
    info(`meta_catalog_id: ${restaurantDoc.meta_catalog_id || 'NOT SET'}`);
    results.restaurantDoc = 'PASS';
    pass('Restaurant document found');
  } catch (err) {
    results.restaurantDoc = 'FAIL';
    fail('Restaurant document', err.message);
  }
}

// ── Check 3: WhatsApp account ───────────────────────────────────
async function check3_whatsappAccount() {
  divider('3 — WhatsApp account');
  try {
    waAccount = await col('whatsapp_accounts').findOne({ restaurant_id: RESTAURANT_ID });
    if (!waAccount) throw new Error('WhatsApp account not found in MongoDB');
    info(`phone_number_id: ${waAccount.phone_number_id}`);
    info(`catalog_id: ${waAccount.catalog_id || 'NOT SET'}`);
    results.whatsappAccount = 'PASS';
    pass('WhatsApp account found');
  } catch (err) {
    results.whatsappAccount = 'FAIL';
    fail('WhatsApp account', err.message);
  }
}

// ── Check 4: Branches ───────────────────────────────────────────
async function check4_branches() {
  divider('4 — Branches');
  try {
    branchesList = await col('branches').find({ restaurant_id: RESTAURANT_ID }).toArray();
    if (!branchesList.length) throw new Error('No branches found');
    for (const b of branchesList) {
      info(`Branch: ${b.name || b.branch_name} | _id: ${b._id} | catalog_id: ${b.catalog_id || 'NOT SET'}`);
    }
    results.branches = 'PASS';
    pass(`${branchesList.length} branch(es) found`);
  } catch (err) {
    results.branches = 'FAIL';
    fail('Branches', err.message);
  }
}

// ── Check 5: Commerce settings ──────────────────────────────────
async function check5_commerceSettings() {
  divider('5 — Commerce settings (Meta)');
  try {
    if (!waAccount?.phone_number_id) throw new Error('No phone_number_id — skipping');
    const res = await axios.get(`${graphUrl}/${waAccount.phone_number_id}/whatsapp_commerce_settings`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
    commerceData = res.data?.data?.[0] || res.data;
    info(`Commerce settings response: ${JSON.stringify(commerceData, null, 2)}`);
    results.commerceSettings = 'PASS';
    pass('Commerce settings retrieved');
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    results.commerceSettings = 'FAIL';
    fail('Commerce settings', msg);
  }
}

// ── Check 6: Catalog on Meta ────────────────────────────────────
async function check6_catalogOnMeta() {
  divider('6 — Catalog on Meta');
  try {
    const catId = restaurantDoc?.meta_catalog_id;
    if (!catId) throw new Error('No meta_catalog_id on restaurant doc — skipping');
    const res = await axios.get(`${graphUrl}/${catId}`, {
      params: { fields: 'id,name,product_count', access_token: token },
      timeout: 15000,
    });
    metaCatalogData = res.data;
    info(`Catalog ID: ${res.data.id}`);
    info(`Catalog name: ${res.data.name}`);
    info(`Product count: ${res.data.product_count}`);
    results.catalogOnMeta = 'PASS';
    pass('Catalog exists on Meta');
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    results.catalogOnMeta = 'FAIL';
    fail('Catalog on Meta', msg);
  }
}

// ── Check 7: Products sample ────────────────────────────────────
async function check7_productsSample() {
  divider('7 — Products sample (first 10)');
  try {
    const catId = restaurantDoc?.meta_catalog_id;
    if (!catId) throw new Error('No meta_catalog_id — skipping');
    const res = await axios.get(`${graphUrl}/${catId}/products`, {
      params: { fields: 'retailer_id', limit: 10, access_token: token },
      timeout: 15000,
    });
    const products = res.data?.data || [];
    info(`Returned ${products.length} product(s)`);
    for (const p of products) {
      info(`  retailer_id: ${p.retailer_id}`);
    }
    results.productsSample = 'PASS';
    pass('Products retrieved');
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    results.productsSample = 'FAIL';
    fail('Products sample', msg);
  }
}

// ── Check 8: MPM dry run ────────────────────────────────────────
async function check8_mpmDryRun() {
  divider('8 — MPM dry run');
  let totalMPMs = 0;
  let totalProducts = 0;
  let allSectionTitlesOk = true;

  try {
    if (!branchesList.length) throw new Error('No branches to test');

    for (const branch of branchesList) {
      info(`\nBranch: ${branch.name || branch.branch_name} (${branch._id})`);
      try {
        const mpms = await buildBranchMPMs(branch._id, RESTAURANT_ID);
        if (!mpms || !mpms.length) {
          info('  No MPMs returned');
          continue;
        }
        info(`  MPM count: ${mpms.length}`);
        totalMPMs += mpms.length;

        for (let i = 0; i < mpms.length; i++) {
          const mpm = mpms[i];
          const sections = mpm.sections || mpm.action?.sections || [];
          info(`  MPM #${i + 1}: ${sections.length} section(s)`);

          for (const sec of sections) {
            const title = sec.title || '';
            const prodCount = (sec.product_items || sec.product_retailer_ids || []).length;
            totalProducts += prodCount;
            info(`    Section: "${title}" — ${prodCount} product(s) — title length: ${title.length}`);
            if (title.length > 24) {
              fail(`Section title too long (${title.length} chars)`, `"${title}"`);
              allSectionTitlesOk = false;
            }
          }
        }
      } catch (branchErr) {
        fail(`MPM build for branch ${branch._id}`, branchErr.message);
        allSectionTitlesOk = false;
      }
    }

    if (totalMPMs === 0) throw new Error('No MPMs built for any branch');
    if (!allSectionTitlesOk) throw new Error('One or more section titles exceed 24 chars');

    results.mpmDryRun = 'PASS';
    pass(`MPM dry run OK — ${totalMPMs} MPM(s), ${totalProducts} total product(s)`);
  } catch (err) {
    results.mpmDryRun = 'FAIL';
    fail('MPM dry run', err.message);
  }

  // Store for summary
  results._mpmCount = totalMPMs;
  results._mpmProducts = totalProducts;
}

// ── Check 9: Catalog-phone link ─────────────────────────────────
function check9_catalogPhoneLink() {
  divider('9 — Catalog-phone link (IDs match?)');
  try {
    const dbCatalog = restaurantDoc?.meta_catalog_id;
    const linkedCatalog = commerceData?.id || commerceData?.catalog_id;
    info(`MongoDB meta_catalog_id: ${dbCatalog || 'NOT SET'}`);
    info(`Commerce settings catalog: ${linkedCatalog || 'NOT SET'}`);

    if (!dbCatalog) throw new Error('meta_catalog_id missing from restaurant doc');
    if (!linkedCatalog) throw new Error('No catalog linked in commerce settings');
    if (String(dbCatalog) !== String(linkedCatalog)) {
      throw new Error(`MISMATCH: DB has ${dbCatalog}, Meta has ${linkedCatalog}`);
    }

    results.catalogIdsMatch = 'PASS';
    pass('Catalog IDs match');
  } catch (err) {
    results.catalogIdsMatch = 'FAIL';
    fail('Catalog-phone link', err.message);
  }
}

// ── Auto-fix A: Commerce settings ───────────────────────────────
async function fixA_commerceSettings() {
  console.log('\n[FIX A] Ensuring commerce settings link correct catalog...');
  try {
    if (!waAccount?.phone_number_id) { info('No phone_number_id — cannot fix'); return; }
    const res = await axios.post(
      `${graphUrl}/${waAccount.phone_number_id}/whatsapp_commerce_settings`,
      { is_catalog_visible: true, is_cart_enabled: true },
      { params: { access_token: token }, timeout: 15000 }
    );
    info(`Fix A result: ${JSON.stringify(res.data)}`);

    // Re-check
    info('Re-checking commerce settings...');
    const recheck = await axios.get(`${graphUrl}/${waAccount.phone_number_id}/whatsapp_commerce_settings`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
    commerceData = recheck.data?.data?.[0] || recheck.data;
    info(`Re-check response: ${JSON.stringify(commerceData, null, 2)}`);
    pass('Fix A applied');
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    fail('Fix A', msg);
  }
}

// ── Auto-fix B: WhatsApp account catalog_id ─────────────────────
async function fixB_whatsappAccountCatalog() {
  console.log('\n[FIX B] Syncing whatsapp_accounts catalog_id with meta_catalog_id...');
  try {
    const correctCatalog = restaurantDoc?.meta_catalog_id;
    if (!correctCatalog) { info('No meta_catalog_id to sync from — skipping'); return; }
    if (String(waAccount?.catalog_id) === String(correctCatalog)) { info('Already correct — skipping'); return; }

    const updateRes = await col('whatsapp_accounts').updateOne(
      { restaurant_id: RESTAURANT_ID },
      { $set: { catalog_id: correctCatalog, updated_at: new Date() } }
    );
    info(`Updated ${updateRes.modifiedCount} whatsapp_accounts doc(s) — catalog_id -> ${correctCatalog}`);

    // Re-check
    waAccount = await col('whatsapp_accounts').findOne({ restaurant_id: RESTAURANT_ID });
    info(`Re-check catalog_id: ${waAccount?.catalog_id}`);
    pass('Fix B applied');
  } catch (err) {
    fail('Fix B', err.message);
  }
}

// ── Auto-fix C: Branch catalog_ids ──────────────────────────────
async function fixC_branchCatalogs() {
  console.log('\n[FIX C] Syncing branch catalog_ids with meta_catalog_id...');
  try {
    const correctCatalog = restaurantDoc?.meta_catalog_id;
    if (!correctCatalog) { info('No meta_catalog_id to sync from — skipping'); return; }

    let fixed = 0;
    for (const branch of branchesList) {
      if (String(branch.catalog_id) === String(correctCatalog)) continue;
      const updateRes = await col('branches').updateOne(
        { _id: branch._id },
        { $set: { catalog_id: correctCatalog, updated_at: new Date() } }
      );
      info(`Branch ${branch.name || branch.branch_name} (${branch._id}): catalog_id -> ${correctCatalog} (modified: ${updateRes.modifiedCount})`);
      fixed++;
    }

    if (fixed === 0) { info('All branches already have correct catalog_id'); return; }

    // Re-check
    branchesList = await col('branches').find({ restaurant_id: RESTAURANT_ID }).toArray();
    for (const b of branchesList) {
      info(`Re-check branch ${b.name || b.branch_name}: catalog_id = ${b.catalog_id}`);
    }
    pass(`Fix C applied — updated ${fixed} branch(es)`);
  } catch (err) {
    fail('Fix C', err.message);
  }
}

// ── Summary ─────────────────────────────────────────────────────
function printSummary() {
  const linkedCatalog = commerceData?.id || commerceData?.catalog_id || 'UNKNOWN';
  const isVisible = commerceData?.is_catalog_visible ?? 'UNKNOWN';
  const isCart = commerceData?.is_cart_enabled ?? 'UNKNOWN';
  const productCount = metaCatalogData?.product_count ?? 'UNKNOWN';

  console.log('\n' + '='.repeat(60));
  console.log('=== DIAGNOSIS SUMMARY ===');
  console.log('='.repeat(60));
  console.log(`Token: ${results.token}`);
  console.log(`Restaurant doc: ${results.restaurantDoc} (meta_catalog_id: ${restaurantDoc?.meta_catalog_id || 'NOT SET'})`);
  console.log(`WhatsApp account: ${results.whatsappAccount} (phone: ${waAccount?.phone_number_id || 'NOT SET'})`);
  console.log(`Commerce settings: ${results.commerceSettings} (linked catalog: ${linkedCatalog}, visible: ${isVisible}, cart: ${isCart})`);
  console.log(`Catalog on Meta: ${results.catalogOnMeta} (products: ${productCount})`);
  console.log(`Catalog IDs match: ${results.catalogIdsMatch}`);
  console.log(`MPM dry run: ${results.mpmDryRun} (${results._mpmCount || 0} MPMs, ${results._mpmProducts || 0} total products)`);

  // Determine root cause
  const failures = Object.entries(results).filter(([k, v]) => v === 'FAIL' && !k.startsWith('_'));
  if (failures.length === 0) {
    console.log('\nROOT CAUSE: None — all checks passed');
    console.log('FIX NEEDED: None — MPM should work. If 131009 persists, check Meta rate limits or retry.');
  } else {
    const causes = [];
    if (results.token === 'FAIL') causes.push('Invalid or expired Meta token');
    if (results.catalogIdsMatch === 'FAIL') causes.push('Catalog ID mismatch between MongoDB and Meta commerce settings');
    if (results.commerceSettings === 'FAIL') causes.push('Commerce settings not configured on phone number');
    if (results.catalogOnMeta === 'FAIL') causes.push('Catalog does not exist or is inaccessible on Meta');
    if (results.mpmDryRun === 'FAIL') causes.push('MPM build failed (section titles too long or no products)');
    if (results.restaurantDoc === 'FAIL') causes.push('Restaurant document missing');
    if (results.whatsappAccount === 'FAIL') causes.push('WhatsApp account document missing');
    if (results.branches === 'FAIL') causes.push('No branches found');

    console.log(`\nROOT CAUSE: ${causes.join('; ')}`);
    console.log(`FIX NEEDED: ${causes.map(c => c.replace(/^/, 'Fix: ')).join('; ')}`);
  }
  console.log('='.repeat(60));
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(60));
  console.log('  MPM Error 131009 — Diagnostic Script');
  console.log(`  Restaurant: ${RESTAURANT_ID}`);
  console.log(`  WABA: ${WABA_ID}`);
  console.log(`  Graph URL: ${graphUrl}`);
  console.log('='.repeat(60));

  // Connect to MongoDB
  info('Connecting to MongoDB...');
  await connect();
  info('MongoDB connected');

  // Run all checks sequentially
  await check1_token();
  await check2_restaurant();
  await check3_whatsappAccount();
  await check4_branches();
  await check5_commerceSettings();
  await check6_catalogOnMeta();
  await check7_productsSample();
  await check8_mpmDryRun();
  check9_catalogPhoneLink();

  // Print summary before fixes
  printSummary();

  // ── Auto-fixes ──────────────────────────────────────────────
  const needFixA = results.commerceSettings === 'FAIL' || results.catalogIdsMatch === 'FAIL';
  const needFixB = waAccount && restaurantDoc?.meta_catalog_id &&
    String(waAccount.catalog_id) !== String(restaurantDoc.meta_catalog_id);
  const needFixC = branchesList.some(b =>
    !b.catalog_id || String(b.catalog_id) !== String(restaurantDoc?.meta_catalog_id)
  );

  if (needFixA || needFixB || needFixC) {
    console.log('\n' + '='.repeat(60));
    console.log('  AUTO-FIX SECTION');
    console.log('='.repeat(60));

    if (needFixA) await fixA_commerceSettings();
    if (needFixB) await fixB_whatsappAccountCatalog();
    if (needFixC) await fixC_branchCatalogs();

    // Re-run catalog match check after fixes
    console.log('\n[RE-CHECK] Catalog-phone link after fixes...');
    check9_catalogPhoneLink();

    // Re-print summary
    printSummary();
  }

  info('\nDiagnostic complete.');
}

// ── Entry point ─────────────────────────────────────────────────
try {
  main().catch(err => {
    console.error('[FATAL]', err);
    process.exit(1);
  });
} catch (err) {
  console.error('[FATAL]', err);
  process.exit(1);
}

// Allow async operations to finish, then exit cleanly
setTimeout(() => process.exit(0), 2000);
