#!/usr/bin/env node
'use strict';

// scripts/diagnose-product-sizes.js
//
// Read-only diagnostic. Inspects the data shape for items with multiple
// sizes/variants — field names, slug presence, availability flags — so
// any future code that consumes this surface (cart builders, MPM, retailer-id
// generators) can be written against verified ground truth.
//
// Run on EC2 from the repo root:
//   node --env-file=/home/ubuntu/GullyBite/.env backend/scripts/diagnose-product-sizes.js
//
// (Node resolves require('mongodb') by walking up from the script's
// directory, so the run command works from any cwd above the repo root.)
//
// No writes anywhere. Native MongoDB driver only.

const { MongoClient } = require('mongodb');

const TARGET_RESTAURANT_OR_BRANCH = 'c6ea1846-7aa8-4a65-b18d-2fea78960e26';

function header(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 70 - title.length - 4))}`);
}

// Strip image URLs and similar bulk fields so terminal output stays
// scannable. Sizes/variants arrays are kept intact — they're the focus.
function tidyDoc(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    if (/image|thumbnail|video|photo|s3_key/i.test(k) && typeof v === 'string' && v.length > 60) {
      out[k] = '<image-omitted>';
    } else {
      out[k] = v;
    }
  }
  return out;
}

function describeNestedShape(arr, label) {
  if (!Array.isArray(arr) || arr.length === 0) return;
  const fields = arr[0] && typeof arr[0] === 'object' ? Object.keys(arr[0]).sort() : [];
  const hasSlug = fields.includes('slug');
  const hasName = fields.includes('name');
  const hasAvail = fields.includes('available') || fields.includes('is_available');
  console.log(`    ${label} (length=${arr.length}):`);
  for (const entry of arr) console.log('      -', JSON.stringify(entry));
  console.log(`    ${label}[0] field set: ${fields.join(', ')}`);
  console.log(`    ${label}[0] has slug field   : ${hasSlug}`);
  console.log(`    ${label}[0] has name field   : ${hasName}`);
  console.log(`    ${label}[0] has availability : ${hasAvail}`);
}

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI not set — pass --env-file=.../.env');
    process.exit(2);
  }
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db('gullybite');

  // ── Collection survey ──────────────────────────────────────
  // The codebase uses `menu_items`, but the user-facing spec calls them
  // "products". Show counts for both so the diagnostic's source is
  // unambiguous and the rest of the output can be interpreted correctly.
  header('Collection survey (item-related)');
  const colls = await db.listCollections({}, { nameOnly: true }).toArray();
  const candidates = colls
    .map((c) => c.name)
    .filter((n) => /product|item|catalog/i.test(n))
    .sort();
  for (const name of candidates) {
    const n = await db.collection(name).countDocuments({});
    console.log(`  ${name.padEnd(28)} : ${n}`);
  }

  // Pick the actual source-of-truth collection. Prefer `products` if it
  // exists with rows; otherwise fall back to `menu_items` (the codebase's
  // canonical name).
  const productsCount = await db.collection('products').countDocuments({}).catch(() => 0);
  const menuItemsCount = await db.collection('menu_items').countDocuments({}).catch(() => 0);
  const sourceColl = productsCount > 0 ? 'products' : 'menu_items';
  console.log(`\n  source-of-truth this run: '${sourceColl}' (products=${productsCount}, menu_items=${menuItemsCount})`);

  // ── (1) Sample 3 docs with > 1 sizes or > 1 variants ──────
  header(`(1) Sample ${sourceColl} docs with > 1 sizes or > 1 variants`);
  const multi = await db.collection(sourceColl).find({
    $or: [
      { 'sizes.1':    { $exists: true } },
      { 'variants.1': { $exists: true } },
    ],
  }).limit(3).toArray();

  if (!multi.length) {
    console.log(`  (no docs with sizes.length > 1 or variants.length > 1 in '${sourceColl}')`);
    // Fallback diagnostic: this codebase models size variants as SEPARATE
    // menu_items rows linked by item_group_id, not as nested arrays. Show
    // a sample group so the user can compare.
    if (sourceColl === 'menu_items') {
      header('(1b) item_group_id sample (menu_items uses one-row-per-size)');
      const grouped = await db.collection('menu_items').aggregate([
        { $match: { item_group_id: { $ne: null } } },
        { $group: { _id: '$item_group_id', name: { $first: '$name' }, rows: { $push: { _id: '$_id', size: '$size', variant_value: '$variant_value', retailer_id: '$retailer_id', price_paise: '$price_paise', is_available: '$is_available' } }, count: { $sum: 1 } } },
        { $match: { count: { $gte: 2 } } },
        { $limit: 3 },
      ]).toArray();
      for (const g of grouped) {
        console.log(`  ── group '${g.name}' (item_group_id=${g._id}, ${g.count} rows) ──`);
        for (const r of g.rows) console.log('    -', JSON.stringify(r));
      }
    }
  } else {
    for (const p of multi) {
      console.log('  ── doc ──');
      console.log(`    _id          : ${p._id}`);
      console.log(`    name         : ${p.name || '(none)'}`);
      console.log(`    slug         : ${p.slug || '(none)'}`);
      console.log(`    retailer_id  : ${p.retailer_id || '(none)'}`);
      console.log(`    branch_id    : ${p.branch_id || '(none)'}`);
      console.log(`    branch_ids   : ${Array.isArray(p.branch_ids) ? JSON.stringify(p.branch_ids) : '(none)'}`);
      describeNestedShape(p.sizes, 'sizes');
      describeNestedShape(p.variants, 'variants');
      console.log('');
    }
  }

  // ── (2) Sample doc tied to the target id (could be restaurant or branch) ──
  header(`(2) Sample doc tied to id ${TARGET_RESTAURANT_OR_BRANCH}`);
  let sample = null;
  let foundIn = null;
  for (const coll of ['products', 'menu_items']) {
    const c = await db.collection(coll).countDocuments({}).catch(() => 0);
    if (!c) continue;
    sample = await db.collection(coll).findOne({
      $or: [
        { restaurant_id: TARGET_RESTAURANT_OR_BRANCH },
        { branch_id:     TARGET_RESTAURANT_OR_BRANCH },
        { branch_ids:    TARGET_RESTAURANT_OR_BRANCH },
      ],
    });
    if (sample) { foundIn = coll; break; }
  }
  if (!sample) {
    console.log(`  (no doc matches restaurant_id / branch_id / branch_ids = ${TARGET_RESTAURANT_OR_BRANCH})`);
  } else {
    console.log(`  found in collection: ${foundIn}`);
    console.log(JSON.stringify(tidyDoc(sample), null, 2).split('\n').map((l) => '  ' + l).join('\n'));
  }

  // ── (3) Recent retailer_id from order_items ──
  header('(3) Recent retailer_id from order_items');
  const recent = await db.collection('order_items')
    .find({ retailer_id: { $exists: true, $ne: null, $ne: '' } })
    .sort({ _id: -1 })
    .limit(1)
    .toArray();
  if (!recent.length) {
    console.log('  (no rows in order_items with a non-empty retailer_id)');
  } else {
    const r = recent[0];
    console.log(`  order_id    : ${r.order_id}`);
    console.log(`  item_name   : ${r.item_name}`);
    console.log(`  retailer_id : ${r.retailer_id}`);
    console.log(`  unit_price_rs: ${r.unit_price_rs}, quantity: ${r.quantity}, line_total_rs: ${r.line_total_rs}`);
  }

  await client.close();
})().catch((e) => { console.error('ERR:', e?.stack || e?.message || e); process.exit(1); });
