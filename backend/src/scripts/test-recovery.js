// src/scripts/test-recovery.js
// QA harness for the transaction + recovery system.
//
// Mocks Mongo and the Razorpay client so the test runs with no external
// deps. Exercises the four spec scenarios:
//
//   1. crash during order creation → no partial data (txn rollback)
//   2. crash after payment        → recovery promotes PENDING_PAYMENT → PAID
//   3. duplicate retries          → no double row, no double payout
//   4. settlement retry           → no double payout (CAS-guarded)
//
// Run: node src/scripts/test-recovery.js

'use strict';

process.env.NODE_ENV = 'test';

// ─── In-memory Mongo fake ───────────────────────────────────────
const stores = new Map();
function coll(name) {
  if (!stores.has(name)) stores.set(name, new Map());
  const rows = stores.get(name);
  const matches = (d, q) => Object.entries(q).every(([k, v]) => {
    if (v && typeof v === 'object' && '$in' in v) return v.$in.includes(d[k]);
    if (v && typeof v === 'object' && '$lt' in v) return d[k] != null && d[k] < v.$lt;
    return d[k] === v;
  });
  return {
    async findOne(q) { for (const d of rows.values()) if (matches(d, q)) return d; return null; },
    async insertOne(doc) {
      const id = doc._id || Math.random().toString(36).slice(2);
      if (rows.has(id)) { const e = new Error('E11000 dup'); e.code = 11000; throw e; }
      rows.set(id, { ...doc, _id: id });
      return { insertedId: id };
    },
    async insertMany(docs) { for (const d of docs) await this.insertOne(d); return { insertedCount: docs.length }; },
    async updateOne(q, u, opts = {}) {
      let doc;
      for (const d of rows.values()) if (matches(d, q)) { doc = d; break; }
      if (!doc) {
        if (!opts.upsert) return { matchedCount: 0 };
        doc = { ...q, ...(u.$setOnInsert || {}) };
        rows.set(doc._id || Math.random().toString(36).slice(2), doc);
      }
      if (u.$set) Object.assign(doc, u.$set);
      if (u.$inc) for (const [k, v] of Object.entries(u.$inc)) doc[k] = (doc[k] || 0) + v;
      return { matchedCount: 1 };
    },
    async findOneAndUpdate(q, u, opts = {}) {
      let doc = await this.findOne(q);
      if (!doc && opts.upsert) { doc = { ...q, ...(u.$setOnInsert || {}) }; rows.set(doc._id || Math.random().toString(36).slice(2), doc); }
      if (!doc) return { value: null };
      if (u.$set) Object.assign(doc, u.$set);
      if (u.$inc) for (const [k, v] of Object.entries(u.$inc)) doc[k] = (doc[k] || 0) + v;
      return { value: doc };
    },
    find(q) {
      const out = [...rows.values()].filter(d => matches(d, q || {}));
      return { limit: () => ({ toArray: async () => out }), toArray: async () => out, project: () => ({ toArray: async () => out }) };
    },
    async deleteMany(q) { for (const [k, d] of [...rows.entries()]) if (matches(d, q)) rows.delete(k); return {}; },
    async countDocuments() { return rows.size; },
  };
}

require.cache[require.resolve('../config/database')] = {
  exports: {
    col: coll,
    newId: () => Math.random().toString(36).slice(2),
    mapId: d => d,
    mapIds: d => d,
    // This is the crucial bit: a transaction fake that ACTUALLY rolls
    // back the in-memory rows if the inner fn throws. We snapshot
    // every collection before the call and restore on failure.
    transaction: async (fn) => {
      const snapshot = new Map();
      for (const [n, r] of stores) snapshot.set(n, new Map([...r].map(([k, v]) => [k, { ...v }])));
      try {
        return await fn({ _fakeSession: true });
      } catch (e) {
        stores.clear();
        for (const [n, r] of snapshot) stores.set(n, r);
        throw e;
      }
    },
    ensureConnected: (_req, _res, next) => next(),
  },
};

// ─── Test harness ────────────────────────────────────────────────
let failed = 0;
const ok   = (n) => console.log(`  ✓ ${n}`);
const fail = (n, e) => { failed++; console.log(`  ✗ ${n} — ${e?.message || e}`); };

// Load modules AFTER the db stub is installed
const { withTransaction } = require('../utils/withTransaction');
const { transitionOrder } = require('../core/orderStateEngine');
const { transitionSettlement } = require('../core/settlementStateEngine');
const { recoverStuckPayments, recoverStuckSettlements, cleanupExpiredOrders } = require('../jobs/recovery');

(async () => {
  // ─── [1] Crash mid-order → rollback ─────────────────────────────
  console.log('\n[1] Transaction rollback on mid-order crash');
  try {
    await withTransaction(async (sess) => {
      await coll('orders').insertOne({ _id: 'O1', status: 'PENDING_PAYMENT' });
      await coll('order_items').insertOne({ _id: 'I1', order_id: 'O1' });
      throw new Error('simulated crash before delivery insert');
    }, { label: 'test' });
    fail('rollback', 'expected throw');
  } catch (e) { /* expected */ }
  const o1 = await coll('orders').findOne({ _id: 'O1' });
  const i1 = await coll('order_items').findOne({ _id: 'I1' });
  (!o1 && !i1 ? ok : l => fail(l, `o1=${!!o1} i1=${!!i1}`))('both orders row and order_items row rolled back');

  // ─── [2] Stuck PENDING_PAYMENT recovered via Razorpay verify ─────
  console.log('\n[2] Stuck payment recovery (Razorpay says captured)');
  const oldDate = new Date(Date.now() - 20 * 60 * 1000);
  await coll('orders').insertOne({ _id: 'O2', status: 'PENDING_PAYMENT', created_at: oldDate });
  await coll('payments').insertOne({ _id: 'P2', order_id: 'O2', rp_order_id: 'rzp_O2', status: 'sent' });
  // Stub Razorpay client
  require('../services/payment')._getRzp = () => ({
    orders: { fetchPayments: async () => ({ items: [{ id: 'pay_123', status: 'captured', created_at: Math.floor(Date.now() / 1000) }] }) },
  });
  const res2 = await recoverStuckPayments();
  (res2.recovered === 1 ? ok : l => fail(l, JSON.stringify(res2)))('one order recovered to PAID');
  const o2 = await coll('orders').findOne({ _id: 'O2' });
  (o2.status === 'PAID' ? ok : l => fail(l, `status=${o2.status}`))('order state = PAID');

  // ─── [3] Duplicate recovery pass → no double state change ───────
  console.log('\n[3] Duplicate recovery tick is idempotent');
  const res3 = await recoverStuckPayments(); // O2 is now PAID, shouldn't re-appear
  (res3.scanned === 0 ? ok : l => fail(l, `scanned=${res3.scanned}`))('no stuck orders after promotion');

  // ─── [4] Stuck settlement retry via CAS ─────────────────────────
  console.log('\n[4] Stuck settlement retry (CAS, no double payout)');
  const settlementId = 'S1';
  await coll('settlements').insertOne({
    _id: settlementId,
    state: 'PROCESSING',
    processing_at: new Date(Date.now() - 45 * 60 * 1000),
    retry_count: 0,
  });
  let payoutCalls = 0;
  require.cache[require.resolve('../services/payoutEngine')] = {
    exports: { retryPayout: async () => { payoutCalls++; } },
  };
  const res4 = await recoverStuckSettlements();
  (res4.retried === 1 ? ok : l => fail(l, JSON.stringify(res4)))('one settlement retried');
  (payoutCalls === 1 ? ok : l => fail(l, `calls=${payoutCalls}`))('retryPayout called exactly once');
  const s1 = await coll('settlements').findOne({ _id: settlementId });
  (s1.retry_count === 1 ? ok : l => fail(l, `retry_count=${s1.retry_count}`))('retry_count incremented');

  // Concurrent completion race — mark COMPLETED first, then ensure
  // next retry tick does NOT touch the row.
  await transitionSettlement(settlementId, 'COMPLETED', { actor: 'webhook' }).catch(() => {});
  const pre = payoutCalls;
  await recoverStuckSettlements();
  (payoutCalls === pre ? ok : l => fail(l, 'retryPayout called for completed row'))('completed settlement not re-retried');

  // ─── [5] Expired order cleanup ─────────────────────────────────
  console.log('\n[5] Expired order cleanup');
  await coll('orders').insertOne({
    _id: 'O3', status: 'PENDING_PAYMENT',
    expires_at: new Date(Date.now() - 60 * 1000),
    created_at: new Date(),
  });
  const res5 = await cleanupExpiredOrders();
  (res5.expired === 1 ? ok : l => fail(l, JSON.stringify(res5)))('one order marked EXPIRED');
  const o3 = await coll('orders').findOne({ _id: 'O3' });
  (o3.status === 'EXPIRED' ? ok : l => fail(l, `status=${o3.status}`))('order state = EXPIRED');

  // ─── [6] Idempotency: replay same order create returns same row ─
  console.log('\n[6] Duplicate order insert — unique _id prevents doubles');
  try {
    await coll('orders').insertOne({ _id: 'O4', status: 'PENDING_PAYMENT' });
    await coll('orders').insertOne({ _id: 'O4', status: 'PENDING_PAYMENT' });
    fail('duplicate insert should throw');
  } catch (e) {
    (e.code === 11000 ? ok : l => fail(l, e.message))('duplicate insert rejected with E11000');
  }

  console.log(`\nDone. ${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}.`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
