// src/scripts/test-rate-limit.js
// QA harness for the rate-limit layer. Exercises the four scenarios from
// the spec against the in-process store (no network needed):
//
//   1. spam messages  → blocked after 5 hits in 10s AND abuse-score rising
//   2. rapid orders   → limited to 2 per 60s per user
//   3. retry loops    → payment 3 per 120s per user
//   4. normal users   → unaffected (stays under every limit)
//
// Run: node src/scripts/test-rate-limit.js
// Exits non-zero on any assertion failure so CI can gate on it.

'use strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const {
  rateLimit,
  RateLimitExceededError,
  blockUser,
  isBlocked,
  unblockUser,
  recordAbuseEvent,
} = require('../middleware/rateLimit');

let failed = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const fail = (name, err) => { failed++; console.log(`  ✗ ${name} — ${err?.message || err}`); };

async function expectPass(label, fn) {
  try { await fn(); ok(label); } catch (e) { fail(label, e); }
}
async function expectThrow(label, fn) {
  try { await fn(); fail(label, 'expected throw, got pass'); }
  catch (e) {
    if (e instanceof RateLimitExceededError) ok(label);
    else fail(label, e);
  }
}

(async () => {
  console.log('\n[1] Spam WhatsApp messages — 5 allowed per 10s');
  const phone = `919${Date.now()}`.slice(0, 12);
  for (let i = 1; i <= 5; i++) {
    await expectPass(`msg ${i}/5 allowed`, () => rateLimit(`wa:${phone}`, 5, 10));
  }
  await expectThrow('6th msg blocked', () => rateLimit(`wa:${phone}`, 5, 10));

  console.log('\n[1b] Abuse score drives 10-min block after repeated hits');
  const spammer = `919${Date.now()}1`.slice(0, 12);
  // 10 WA rate-limit hits should cross the abuse threshold
  let blockedByAbuse = false;
  for (let i = 0; i < 12; i++) {
    const r = await recordAbuseEvent(`wa:${spammer}`, 'rate_limit_hit_wa');
    if (r.blocked) { blockedByAbuse = true; break; }
  }
  (blockedByAbuse ? ok : (l) => fail(l, 'never blocked'))('abuse score crossed threshold');
  const check = await isBlocked(`wa:${spammer}`);
  (check.blocked ? ok : (l) => fail(l, 'block missing'))('blocked:<id> key present');

  console.log('\n[2] Rapid order creation — 2 per 60s per user');
  const userId = `user_${Date.now()}`;
  await expectPass('order 1/2 allowed', () => rateLimit(`order:${userId}`, 2, 60));
  await expectPass('order 2/2 allowed', () => rateLimit(`order:${userId}`, 2, 60));
  await expectThrow('order 3 blocked',  () => rateLimit(`order:${userId}`, 2, 60));

  console.log('\n[3] Payment retry loop — 3 per 120s per user');
  const payUser = `user_pay_${Date.now()}`;
  await expectPass('pay 1 allowed', () => rateLimit(`payment:${payUser}`, 3, 120));
  await expectPass('pay 2 allowed', () => rateLimit(`payment:${payUser}`, 3, 120));
  await expectPass('pay 3 allowed', () => rateLimit(`payment:${payUser}`, 3, 120));
  await expectThrow('pay 4 blocked', () => rateLimit(`payment:${payUser}`, 3, 120));

  console.log('\n[4] Normal user — well under every limit');
  const normal = `user_normal_${Date.now()}`;
  await expectPass('1 WA msg', () => rateLimit(`wa:${normal}`, 5, 10));
  await expectPass('1 order',  () => rateLimit(`order:${normal}`, 2, 60));
  await expectPass('1 payment',() => rateLimit(`payment:${normal}`, 3, 120));

  console.log('\n[5] Block / unblock roundtrip');
  const tgt = `user_block_${Date.now()}`;
  await blockUser(tgt, 60, 'test');
  const b1 = await isBlocked(tgt);
  (b1.blocked ? ok : (l) => fail(l, 'not blocked'))('blockUser sets flag');
  await unblockUser(tgt);
  const b2 = await isBlocked(tgt);
  (!b2.blocked ? ok : (l) => fail(l, 'still blocked'))('unblockUser clears flag');

  console.log(`\nDone. ${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}.`);
  process.exit(failed === 0 ? 0 : 1);
})();
