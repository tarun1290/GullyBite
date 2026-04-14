// src/scripts/test-adaptive-limits.js
// QA harness for the trust-score + adaptive-rate-limit system.
//
// Uses an in-memory fake for the user_trust Mongo collection so the test
// runs with no DB. If MONGODB_URI is set, the real driver is used and you
// can watch docs land in the user_trust collection.
//
// Scenarios (from spec Section 7):
//   1. new user spams             → adaptive limit blocks
//   2. trusted user               → smooth (higher limits, no 429)
//   3. repeated failed payments   → trust drops → tighter payment limit
//   4. normal usage               → unaffected (stays under limits)
//
// Run: node src/scripts/test-adaptive-limits.js

'use strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

// ─── In-memory Mongo fake (only when real DB is not configured) ──
if (!process.env.MONGODB_URI) {
  const fakeStore = new Map(); // collName → Map(id → doc)
  function collFake(name) {
    if (!fakeStore.has(name)) fakeStore.set(name, new Map());
    const rows = fakeStore.get(name);
    return {
      async findOne(q) {
        for (const d of rows.values()) {
          if (Object.entries(q).every(([k, v]) => d[k] === v)) return d;
        }
        return null;
      },
      async findOneAndUpdate(q, u, opts = {}) {
        let doc = await this.findOne(q);
        if (!doc) {
          if (!opts.upsert) return { value: null };
          doc = { ...(u.$setOnInsert || {}) };
          const id = Math.random().toString(36).slice(2);
          rows.set(id, doc);
        }
        if (u.$inc) for (const [k, v] of Object.entries(u.$inc)) doc[k] = (doc[k] || 0) + v;
        if (u.$set) Object.assign(doc, u.$set);
        return { value: doc };
      },
      async updateOne(q, u, opts = {}) {
        let doc = await this.findOne(q);
        if (!doc) {
          if (!opts.upsert) return { matchedCount: 0 };
          doc = { ...q, ...(u.$setOnInsert || {}) };
          const id = Math.random().toString(36).slice(2);
          rows.set(id, doc);
        }
        if (u.$set) Object.assign(doc, u.$set);
        if (u.$inc) for (const [k, v] of Object.entries(u.$inc)) doc[k] = (doc[k] || 0) + v;
        return { matchedCount: 1 };
      },
    };
  }
  // Patch the database module's col() before anything else requires it.
  require.cache[require.resolve('../config/database')] = {
    exports: {
      col: collFake,
      newId: () => Math.random().toString(36).slice(2),
      mapId: d => d,
      mapIds: d => d,
      ensureConnected: (_req, _res, next) => next(),
    },
  };
}

const trust = require('../services/trustScore');
const { adaptiveRateLimit, RateLimitExceededError, isBlocked } = require('../middleware/rateLimit');

let failed = 0;
const ok = (n) => console.log(`  ✓ ${n}`);
const fail = (n, e) => { failed++; console.log(`  ✗ ${n} — ${e?.message || e}`); };

async function expectPass(label, fn) {
  try { await fn(); ok(label); } catch (e) { fail(label, e); }
}
async function expectThrow(label, fn) {
  try { await fn(); fail(label, 'expected throw'); }
  catch (e) { e instanceof RateLimitExceededError ? ok(label) : fail(label, e); }
}

(async () => {
  console.log('\n[1] New user spams — medium-tier msg limit (5/10s) kicks in');
  const newUser = `u_new_${Date.now()}`;
  const t0 = await trust.getTrust(newUser);
  (t0.tier === 'medium' ? ok : l => fail(l, `tier=${t0.tier}`))(`new user starts at medium (score=${t0.trust_score})`);
  for (let i = 1; i <= 5; i++) {
    await expectPass(`wa msg ${i}/5`, () => adaptiveRateLimit('wa', newUser));
  }
  await expectThrow('wa msg 6 blocked', () => adaptiveRateLimit('wa', newUser));

  console.log('\n[2] Trusted user — high-tier lets bursts through (15/10s messaging)');
  const vip = `u_vip_${Date.now()}`;
  // 10 successful orders + 5 payments pushes them past 70 → high tier
  for (let i = 0; i < 10; i++) await trust.recordEvent(vip, 'order_success');
  for (let i = 0; i < 5; i++) await trust.recordEvent(vip, 'payment_success');
  const tVip = await trust.getTrust(vip);
  (tVip.tier === 'high' ? ok : l => fail(l, `tier=${tVip.tier} score=${tVip.trust_score}`))('VIP reached high tier');
  // 10 messages fit comfortably in a high-tier window (limit=15)
  for (let i = 1; i <= 10; i++) {
    await expectPass(`vip msg ${i}/10`, () => adaptiveRateLimit('wa', vip));
  }

  console.log('\n[3] Repeated failed payments — trust drops → stricter payment limit');
  const flaky = `u_flaky_${Date.now()}`;
  // 5 payment failures: 50 + 5*(-5) = 25 → low tier
  for (let i = 0; i < 5; i++) await trust.recordEvent(flaky, 'payment_failed');
  const tFlaky = await trust.getTrust(flaky);
  (tFlaky.tier === 'low' ? ok : l => fail(l, `tier=${tFlaky.tier} score=${tFlaky.trust_score}`))('flaky user dropped to low tier');
  // Low tier payment limit: 2 per 120s
  await expectPass('pay 1 allowed', () => adaptiveRateLimit('payment', flaky));
  await expectPass('pay 2 allowed', () => adaptiveRateLimit('payment', flaky));
  await expectThrow('pay 3 blocked (low tier cap=2)', () => adaptiveRateLimit('payment', flaky));

  console.log('\n[4] Normal usage — well inside medium tier');
  const normal = `u_normal_${Date.now()}`;
  await expectPass('1 msg',   () => adaptiveRateLimit('wa', normal));
  await expectPass('1 order', () => adaptiveRateLimit('order', normal));
  await expectPass('1 pay',   () => adaptiveRateLimit('payment', normal));

  console.log('\n[5] Spam event actively penalises trust');
  const spammer = `u_spam_${Date.now()}`;
  const before = await trust.getTrust(spammer);
  await trust.recordEvent(spammer, 'spam');
  const after = await trust.getTrust(spammer);
  (after.trust_score === before.trust_score - 10 ? ok : l => fail(l, `score went ${before.trust_score}→${after.trust_score}`))('spam event applied -10');

  console.log('\n[6] Score clamps at [0,100]');
  const capped = `u_cap_${Date.now()}`;
  for (let i = 0; i < 20; i++) await trust.recordEvent(capped, 'payment_success');
  const tCap = await trust.getTrust(capped);
  (tCap.trust_score <= 100 ? ok : l => fail(l, `score=${tCap.trust_score}`))('upper clamp at 100');
  const floor = `u_floor_${Date.now()}`;
  for (let i = 0; i < 20; i++) await trust.recordEvent(floor, 'spam');
  const tFloor = await trust.getTrust(floor);
  (tFloor.trust_score >= 0 ? ok : l => fail(l, `score=${tFloor.trust_score}`))('lower clamp at 0');

  console.log(`\nDone. ${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}.`);
  process.exit(failed === 0 ? 0 : 1);
})();
