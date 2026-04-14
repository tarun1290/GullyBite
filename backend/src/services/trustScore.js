// src/services/trustScore.js
// Per-user trust score (0–100). Persisted in Mongo (user_trust), cached
// in-process for hot reads since getLimits() runs on every gated request.
//
// Score starts at 50 (neutral) for new users and moves based on behaviour:
//   order_success:    +5
//   payment_success: +10
//   payment_failed:  -5
//   spam:           -10
//
// Tiers:
//   low    < 30        → tighten limits (card-testers, first-time spammers)
//   medium 30 – 70     → spec defaults
//   high   > 70        → relaxed limits (loyal customers; prevents them
//                        from hitting 429s on genuine bursts — e.g. a
//                        repeat customer placing a party order quickly)

'use strict';

const { col } = require('../config/database');
const memcache = require('../config/memcache');
const log = require('../utils/logger').child({ component: 'trustScore' });

const COLL = 'user_trust';
const CACHE_PREFIX = 'trust:';
const CACHE_TTL_SEC = 60;
const DEFAULT_SCORE = 50;

const DELTAS = {
  order_success:    +5,
  payment_success: +10,
  payment_failed:   -5,
  spam:            -10,
};

function tierOf(score) {
  if (score >= 70) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

async function getTrust(userId) {
  if (!userId) return { user_id: null, trust_score: DEFAULT_SCORE, tier: tierOf(DEFAULT_SCORE) };
  const key = `${CACHE_PREFIX}${userId}`;
  const cached = memcache.get(key);
  if (cached) return cached;
  let doc;
  try {
    doc = await col(COLL).findOne({ user_id: String(userId) });
  } catch (err) {
    // Fail-open with neutral trust — a DB blip shouldn't lock anyone out.
    log.warn({ err: err.message, userId }, 'trust lookup failed — returning default');
    return { user_id: String(userId), trust_score: DEFAULT_SCORE, tier: 'medium' };
  }
  const score = doc ? doc.trust_score : DEFAULT_SCORE;
  const result = { user_id: String(userId), trust_score: score, tier: tierOf(score) };
  memcache.set(key, result, CACHE_TTL_SEC);
  return result;
}

async function recordEvent(userId, eventType) {
  if (!userId || !(eventType in DELTAS)) return null;
  const delta = DELTAS[eventType];
  const now = new Date();
  try {
    // Read-modify-write: we need the starting score to be DEFAULT_SCORE
    // for brand-new users rather than 0. A plain $inc upsert would
    // initialise missing fields to 0; $setOnInsert + $inc on the same
    // path throws a conflict in Mongo. Cheapest correct path is a
    // findOne → compute → updateOne(upsert). The window for a race is
    // one event per user per ~1ms — acceptable for a score system where
    // events already compound over minutes.
    const existing = await col(COLL).findOne({ user_id: String(userId) });
    const current = existing ? Number(existing.trust_score) : DEFAULT_SCORE;
    const next = Math.max(0, Math.min(100, current + delta));
    await col(COLL).updateOne(
      { user_id: String(userId) },
      {
        $set: { trust_score: next, updated_at: now },
        $setOnInsert: { user_id: String(userId), created_at: now },
      },
      { upsert: true }
    );
    memcache.del(`${CACHE_PREFIX}${userId}`);
    log.info({ userId, eventType, delta, score: next, tier: tierOf(next) }, 'Trust score updated');
    return { user_id: String(userId), trust_score: next, tier: tierOf(next), delta };
  } catch (err) {
    log.error({ err: err.message, userId, eventType }, 'trust recordEvent failed');
    return null;
  }
}

// ─── ADAPTIVE LIMIT TABLE ────────────────────────────────────────
// Mapping tier → {bucket: [limit, windowSec]}. The medium row mirrors the
// fixed spec from the previous rate-limit pass (5/10, 2/60, 3/120) so
// behaviour for unknown / neutral users is unchanged. Low tier is roughly
// half, high tier is ~2-3x. Tune these in one place and every gated call
// site picks it up.
const LIMIT_TABLE = {
  low:    { messaging: [3,  10], order: [1, 60],  payment: [2, 120] },
  medium: { messaging: [5,  10], order: [2, 60],  payment: [3, 120] },
  high:   { messaging: [15, 10], order: [5, 60],  payment: [6, 120] },
};

/**
 * Returns the {limit, windowSec} tuple for a given user + bucket.
 * `user` may be a userId string OR a pre-fetched trust record (from
 * getTrust) — the latter avoids a double lookup inside a request.
 */
async function getLimits(user) {
  let trust;
  if (user && typeof user === 'object' && user.tier) trust = user;
  else trust = await getTrust(user);
  return { tier: trust.tier, trust_score: trust.trust_score, ...LIMIT_TABLE[trust.tier] };
}

module.exports = {
  getTrust,
  recordEvent,
  getLimits,
  tierOf,
  DELTAS,
  LIMIT_TABLE,
  _COLL: COLL,
};
