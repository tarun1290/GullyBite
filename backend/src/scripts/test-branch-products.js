// src/scripts/test-branch-products.js
// QA for the branch-first product system.
// Mocks the db with an in-memory fake; no MongoDB required.

'use strict';
process.env.NODE_ENV = 'test';

// ─── In-memory Mongo fake ───────────────────────────────────────
const stores = new Map();
function coll(name) {
  if (!stores.has(name)) stores.set(name, new Map());
  const rows = stores.get(name);
  const matches = (d, q) => Object.entries(q).every(([k, v]) => {
    if (v && typeof v === 'object' && '$in' in v)     return v.$in.map(String).includes(String(d[k]));
    if (v && typeof v === 'object' && '$exists' in v) return v.$exists ? d[k] !== undefined : d[k] === undefined;
    if (v && typeof v === 'object' && '$ne' in v)     return d[k] !== v.$ne;
    if (v && typeof v === 'object' && '$size' in v)   return Array.isArray(d[k]) && d[k].length === v.$size;
    if (k === '$or') return v.some(cond => matches(d, cond));
    if (Array.isArray(d[k])) return d[k].map(String).includes(String(v));
    return d[k] === v;
  });
  return {
    async insertOne(doc) {
      const id = doc._id || Math.random().toString(36).slice(2);
      rows.set(id, { ...doc, _id: id });
      return { insertedId: id };
    },
    async findOne(q) { for (const d of rows.values()) if (matches(d, q)) return d; return null; },
    async updateOne(q, u, opts = {}) {
      let doc;
      for (const d of rows.values()) if (matches(d, q)) { doc = d; break; }
      if (!doc) {
        if (!opts.upsert) return { matchedCount: 0 };
        doc = { ...(u.$setOnInsert || {}), _id: (u.$setOnInsert && u.$setOnInsert._id) || Math.random().toString(36).slice(2) };
        rows.set(doc._id, doc);
      }
      if (u.$set)      Object.assign(doc, u.$set);
      if (u.$addToSet) for (const [k, v] of Object.entries(u.$addToSet)) { doc[k] = doc[k] || []; if (!doc[k].map(String).includes(String(v))) doc[k].push(v); }
      if (u.$pull)     for (const [k, v] of Object.entries(u.$pull))     { doc[k] = (doc[k] || []).filter(x => String(x) !== String(v)); }
      return { matchedCount: 1 };
    },
    async findOneAndUpdate(q, u, _opts) {
      await this.updateOne(q, u);
      const d = await this.findOne(q);
      return { value: d };
    },
    async deleteOne(q) { for (const [k, d] of [...rows.entries()]) if (matches(d, q)) { rows.delete(k); return { deletedCount: 1 }; } return { deletedCount: 0 }; },
    find(q) {
      const out = [...rows.values()].filter(d => matches(d, q || {}));
      return { toArray: async () => out, sort: () => ({ toArray: async () => out }) };
    },
  };
}

require.cache[require.resolve('../config/database')] = {
  exports: {
    col: coll,
    newId: () => Math.random().toString(36).slice(2),
    mapId:  d => d,
    mapIds: d => d,
    transaction: async (fn) => fn(null),
    ensureConnected: (_req, _res, next) => next(),
  },
};

// Stub the payment service so createBranch's Razorpay order creation
// runs without hitting the real API (and without needing RAZORPAY_KEY_ID
// in the env). Same require.cache pattern as the database mock above.
require.cache[require.resolve('../services/payment')] = {
  exports: {
    _getRzp: () => ({
      orders: {
        create: async (opts) => ({ id: 'rzp_test_' + Math.random().toString(36).slice(2), ...opts }),
      },
    }),
  },
};

const branchSvc  = require('../services/branch.service');
const productSvc = require('../services/product.service');
const catalogGuard = require('../services/catalog.service');

let failed = 0;
const ok   = (n) => console.log(`  ✓ ${n}`);
const fail = (n, e) => { failed++; console.log(`  ✗ ${n} — ${e?.message || e}`); };

(async () => {
  console.log('\n[1] Branch validation — FSSAI required, GST optional but validated');
  try {
    await branchSvc.createBranch({ restaurant_id: 'r1', name: 'A' });
    fail('no fssai rejected');
  } catch (e) { ok('missing fssai rejected'); }
  try {
    await branchSvc.createBranch({ restaurant_id: 'r1', name: 'A', fssai_number: '123' });
    fail('short fssai rejected');
  } catch (e) { ok('short fssai rejected'); }
  try {
    await branchSvc.createBranch({ restaurant_id: 'r1', name: 'A', fssai_number: '12345678901234', gst_number: 'not-a-gstin' });
    fail('bad gst rejected');
  } catch (e) { ok('bad gst rejected'); }
  const { branch: b } = await branchSvc.createBranch({ restaurant_id: 'r1', name: 'Downtown', city: 'BLR', fssai_number: '12345678901234' });
  (b.is_active === true && b.fssai_number === '12345678901234' ? ok : l => fail(l))('branch created with is_active=true');

  console.log('\n[2] Product created WITHOUT branch defaults to is_unassigned=true');
  const p = await productSvc.createProduct({ restaurant_id: 'r1', name: 'Biryani', price_rs: 250 });
  (p.is_unassigned === true && p.branch_ids.length === 0 ? ok : l => fail(l, JSON.stringify(p)))('unassigned flag set');

  console.log('\n[3] Unassigned list surfaces it; customer menu does NOT');
  const unassigned = await productSvc.listUnassignedProducts('r1');
  (unassigned.length === 1 && unassigned[0]._id === p._id ? ok : l => fail(l))('appears in /products/unassigned');
  const custMenu = await productSvc.listCustomerMenuForBranch(b._id);
  (custMenu.length === 0 ? ok : l => fail(l, `got ${custMenu.length}`))('hidden from customer menu');

  console.log('\n[4] Catalog sync guard — unassigned product is skipped');
  const { eligible: e1, skipped: s1 } = await catalogGuard.filterForSync(b._id, [p]);
  (e1.length === 0 && s1[0]?.reason === 'product_unassigned' ? ok : l => fail(l, JSON.stringify({ e1, s1 })))('skipped with product_unassigned');

  console.log('\n[5] Assign to branch → is_unassigned flips, override row created');
  const assigned = await productSvc.assignProductToBranch({
    product_id: p._id, branch_id: b._id, price: 270, tax_percentage: 5, availability: true,
  });
  (assigned.is_unassigned === false && assigned.branch_ids.includes(b._id) ? ok : l => fail(l))('product.is_unassigned = false');
  const bp = await coll('branch_products').findOne({ product_id: p._id, branch_id: b._id });
  (bp && bp.price_paise === 27000 ? ok : l => fail(l, JSON.stringify(bp)))('branch_products row created with override price');

  console.log('\n[6] Customer menu now shows override price');
  const menu2 = await productSvc.listCustomerMenuForBranch(b._id);
  (menu2.length === 1 && menu2[0].price_paise === 27000 ? ok : l => fail(l, JSON.stringify(menu2)))('override price applied');

  console.log('\n[7] Catalog sync guard — now eligible');
  const { eligible: e2, skipped: s2 } = await catalogGuard.filterForSync(b._id, [p]);
  (e2.length === 1 && s2.length === 0 ? ok : l => fail(l, JSON.stringify({ e2, s2 })))('passes all gates');

  console.log('\n[8] Branch missing FSSAI → sync guard blocks');
  const { branch: b2 } = await branchSvc.createBranch({ restaurant_id: 'r1', name: 'NoFssai', fssai_number: '99999999999999' });
  // Corrupt fssai post-create to simulate a legacy branch
  await coll('branches').updateOne({ _id: b2._id }, { $set: { fssai_number: null } });
  await productSvc.assignProductToBranch({ product_id: p._id, branch_id: b2._id, price: 280 });
  const { skipped: s3 } = await catalogGuard.filterForSync(b2._id, [p]);
  (s3.some(r => r.reason === 'branch_missing_fssai') ? ok : l => fail(l, JSON.stringify(s3)))('no-fssai branch blocked');

  console.log('\n[9] Inactive branch → blocked');
  await coll('branches').updateOne({ _id: b._id }, { $set: { is_active: false } });
  const { skipped: s4 } = await catalogGuard.filterForSync(b._id, [p]);
  (s4.some(r => r.reason === 'branch_inactive') ? ok : l => fail(l, JSON.stringify(s4)))('inactive branch blocked');
  const custMenu2 = await productSvc.listCustomerMenuForBranch(b._id);
  (custMenu2.length === 0 ? ok : l => fail(l))('customer menu empty for inactive branch');

  console.log('\n[10] Re-assign is idempotent (no duplicate branch in array)');
  const again = await productSvc.assignProductToBranch({ product_id: p._id, branch_id: b._id, price: 300 });
  const count = again.branch_ids.filter(x => String(x) === String(b._id)).length;
  (count === 1 ? ok : l => fail(l, `count=${count}`))('branch appears once in branch_ids');

  console.log(`\nDone. ${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}.`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
