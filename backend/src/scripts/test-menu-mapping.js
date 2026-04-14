// src/scripts/test-menu-mapping.js
// Pure-function QA for menuMapping.{autoMapColumns, normalizeProduct,
// transformUpload, insertNormalizedProducts}. No MongoDB required.

'use strict';
process.env.NODE_ENV = 'test';

// In-memory db fake — same shape as test-branch-products.js
const stores = new Map();
function coll(name) {
  if (!stores.has(name)) stores.set(name, new Map());
  const rows = stores.get(name);
  const matches = (d, q) => Object.entries(q).every(([k, v]) => {
    if (v && typeof v === 'object' && '$in' in v) return v.$in.map(String).includes(String(d[k]));
    return d[k] === v;
  });
  return {
    async insertOne(doc) {
      const id = doc._id || Math.random().toString(36).slice(2);
      rows.set(id, { ...doc, _id: id }); return { insertedId: id };
    },
    async findOne(q) { for (const d of rows.values()) if (matches(d, q)) return d; return null; },
    async updateOne(q, u) {
      for (const d of rows.values()) if (matches(d, q)) {
        if (u.$set) Object.assign(d, u.$set); return { matchedCount: 1 };
      } return { matchedCount: 0 };
    },
  };
}
require.cache[require.resolve('../config/database')] = {
  exports: { col: coll, newId: () => Math.random().toString(36).slice(2),
             mapId: d => d, mapIds: d => d, ensureConnected: (_q, _r, n) => n() },
};

const svc = require('../services/menuMapping');

let failed = 0;
const ok   = (n) => console.log(`  ✓ ${n}`);
const fail = (n, e) => { failed++; console.log(`  ✗ ${n} — ${e?.message || JSON.stringify(e)}`); };

(async () => {
  console.log('\n[1] autoMapColumns — keyword detection');
  const m1 = svc.autoMapColumns([{ 'Item Name': 'Burger', 'Cost': 120, 'Category': 'Mains', 'Description': 'Beef' }]);
  (m1.name === 'Item Name' && m1.price === 'Cost' && m1.category === 'Category' && m1.description === 'Description'
    ? ok : l => fail(l, m1))('basic mapping');

  const m2 = svc.autoMapColumns([{ 'Dish': 'Tikka', 'MRP': 250, 'Type': 'Veg', 'Photo': 'http://x' }]);
  (m2.name === 'Dish' && m2.price === 'MRP' && m2.category === 'Type' && m2.image === 'Photo'
    ? ok : l => fail(l, m2))('synonyms (Dish/MRP/Type/Photo)');

  const m3 = svc.autoMapColumns([{ 'Random': 1 }]);
  (Object.keys(m3).length === 0 ? ok : l => fail(l, m3))('unknown headers → empty mapping');

  console.log('\n[2] normalizeProduct — defaults & coercion');
  const n1 = svc.normalizeProduct({ name: 'Pizza', price: '₹  299' });
  (n1.price === 299 && n1.currency === 'INR' && n1.availability === true
    && n1.description === 'Pizza' && n1.category === 'General' && n1.normalized === true
    && n1.meta_status === 'ready' ? ok : l => fail(l, n1))('defaults filled, price coerced from "₹ 299"');

  const n2 = svc.normalizeProduct({ name: '', price: 'abc' });
  (n2.meta_status === 'incomplete' ? ok : l => fail(l, n2))('missing name+price → incomplete');

  const n3 = svc.normalizeProduct({ name: 'Salad', price: 100, availability: 'no' });
  (n3.availability === false ? ok : l => fail(l, n3))('availability "no" → false');

  const n4 = svc.normalizeProduct({ name: 'Soup', price: 80 });
  (n4.image_url && n4.image_url.length > 0 ? ok : l => fail(l, n4))('default placeholder image assigned');

  console.log('\n[3] transformUpload — uses stored mapping or auto-detects');
  await coll('menu_uploads').insertOne({
    _id: 'u1', restaurant_id: 'r1', file_type: 'xlsx',
    raw_data: [
      { 'Item Name': 'Idli', 'Price': 60, 'Category': 'Breakfast' },
      { 'Item Name': 'Dosa', 'Price': 90, 'Category': 'Breakfast' },
    ],
  });
  const t1 = await svc.transformUpload('u1');
  (t1.products.length === 2 && t1.products[0].name === 'Idli' && t1.products[0].price === 60
    ? ok : l => fail(l, t1))('auto-mapped transform produces canonical rows');

  console.log('\n[4] insertNormalizedProducts — stamps trace fields, defaults branch_ids=[]');
  const norm = t1.products.map(svc.normalizeProduct);
  const r = await svc.insertNormalizedProducts('r1', 'u1', norm);
  (r.inserted.length === 2 ? ok : l => fail(l, r))('both products inserted');

  const inserted0 = await coll('menu_items').findOne({ name: 'Idli' });
  (inserted0
    && inserted0.is_unassigned === true
    && Array.isArray(inserted0.branch_ids) && inserted0.branch_ids.length === 0
    && inserted0.source_upload_id === 'u1'
    && inserted0.normalized === true
    && inserted0.meta_status === 'ready'
    ? ok : l => fail(l, inserted0))('inserted row carries trace + branch-first defaults');

  console.log('\n[5] Manual override merges over auto-mapping');
  await coll('menu_uploads').insertOne({
    _id: 'u2', restaurant_id: 'r1', file_type: 'xlsx',
    raw_data: [{ 'Foo': 'Pasta', 'Bar': 199 }], // unknown headers
  });
  const t2 = await svc.transformUpload('u2', { name: 'Foo', price: 'Bar' });
  (t2.products[0].name === 'Pasta' && t2.products[0].price === 199
    ? ok : l => fail(l, t2))('explicit mapping bypasses auto-detection');

  console.log(`\nDone. ${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}.`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
