// src/config/redis.js
// Optional Redis client used for rate limiting, blocking and abuse scoring.
//
// If REDIS_URL is set AND the `redis` npm package is installed, a real client
// is used. Otherwise this module exposes an in-memory shim with the same
// surface (INCR / EXPIRE / GET / SET / DEL) so the rate-limit layer works
// identically in local dev and on Vercel even without Redis provisioned.
//
// The shim is fine for single-process deployments. For multi-instance
// production (EC2 autoscale, multiple Vercel regions hitting the same store)
// set REDIS_URL to get atomic cross-process counters.

'use strict';

const log = require('../utils/logger').child({ component: 'redis' });

let client = null;      // resolved client (real or shim)
let ready = false;
let mode = 'memory';    // 'redis' | 'memory'

// ─── IN-MEMORY SHIM ──────────────────────────────────────────────
// Implements the subset of commands rateLimit.js actually uses.
// Keys with TTL are cleaned lazily on read.
function buildMemoryShim() {
  const store = new Map(); // key → { value, expiresAt|null }

  const isExpired = e => e && e.expiresAt !== null && Date.now() > e.expiresAt;
  const purge = k => { const e = store.get(k); if (isExpired(e)) store.delete(k); };

  return {
    async incr(key) {
      purge(key);
      const e = store.get(key) || { value: 0, expiresAt: null };
      e.value = Number(e.value) + 1;
      store.set(key, e);
      return e.value;
    },
    async expire(key, seconds) {
      const e = store.get(key);
      if (!e) return 0;
      e.expiresAt = Date.now() + seconds * 1000;
      return 1;
    },
    async ttl(key) {
      const e = store.get(key);
      if (!e) return -2;
      if (e.expiresAt === null) return -1;
      const left = Math.ceil((e.expiresAt - Date.now()) / 1000);
      return left > 0 ? left : -2;
    },
    async get(key) {
      purge(key);
      const e = store.get(key);
      return e ? String(e.value) : null;
    },
    async set(key, value, opts = {}) {
      const entry = { value, expiresAt: null };
      if (opts.EX) entry.expiresAt = Date.now() + opts.EX * 1000;
      else if (opts.PX) entry.expiresAt = Date.now() + opts.PX;
      store.set(key, entry);
      return 'OK';
    },
    async del(key) {
      return store.delete(key) ? 1 : 0;
    },
    async exists(key) {
      purge(key);
      return store.has(key) ? 1 : 0;
    },
    // Lua-style atomic INCR+EXPIRE-if-new. The real Redis path uses a
    // pipeline; here we just do it inline.
    async incrWithTtl(key, ttlSec) {
      purge(key);
      const e = store.get(key) || { value: 0, expiresAt: null };
      e.value = Number(e.value) + 1;
      if (e.value === 1 || e.expiresAt === null) {
        e.expiresAt = Date.now() + ttlSec * 1000;
      }
      store.set(key, e);
      const ttl = Math.max(1, Math.ceil((e.expiresAt - Date.now()) / 1000));
      return { count: e.value, ttl };
    },
    _mode: 'memory',
  };
}

// ─── REAL REDIS WRAPPER ──────────────────────────────────────────
function wrapRedis(rc) {
  return {
    async incr(key) { return rc.incr(key); },
    async expire(key, seconds) { return rc.expire(key, seconds); },
    async ttl(key) { return rc.ttl(key); },
    async get(key) { return rc.get(key); },
    async set(key, value, opts = {}) {
      if (opts.EX) return rc.set(key, value, { EX: opts.EX });
      if (opts.PX) return rc.set(key, value, { PX: opts.PX });
      return rc.set(key, value);
    },
    async del(key) { return rc.del(key); },
    async exists(key) { return rc.exists(key); },
    // Atomic counter + first-request expiry. Uses MULTI so the TTL
    // always lands on the same slot as the INCR — no race where a second
    // caller sees count=2 but ttl=-1.
    async incrWithTtl(key, ttlSec) {
      const tx = rc.multi().incr(key);
      tx.expire(key, ttlSec, 'NX');
      tx.ttl(key);
      const [count, , ttl] = await tx.exec();
      return { count: Number(count), ttl: Number(ttl) > 0 ? Number(ttl) : ttlSec };
    },
    _mode: 'redis',
  };
}

async function init() {
  if (client) return client;
  const url = process.env.REDIS_URL;
  if (!url) {
    client = buildMemoryShim();
    ready = true;
    mode = 'memory';
    log.info('REDIS_URL not set — using in-memory rate-limit store');
    return client;
  }
  try {
    // Lazy require so `redis` is an optional dep. If not installed we
    // transparently fall back to the shim.
    // eslint-disable-next-line global-require
    const { createClient } = require('redis');
    const rc = createClient({ url });
    rc.on('error', err => log.error({ err }, 'Redis client error'));
    await rc.connect();
    client = wrapRedis(rc);
    ready = true;
    mode = 'redis';
    log.info('Redis connected — rate-limit store = redis');
  } catch (err) {
    log.warn({ err: err.message }, 'Redis init failed — falling back to in-memory store');
    client = buildMemoryShim();
    ready = true;
    mode = 'memory';
  }
  return client;
}

// Eager-ish init: kick it off at require-time so the first request
// doesn't pay the connect cost. Failures are swallowed into the shim.
const readyPromise = init().catch(() => { client = client || buildMemoryShim(); ready = true; });

async function getClient() {
  if (!ready) await readyPromise;
  return client;
}

module.exports = { getClient, get mode() { return mode; } };
