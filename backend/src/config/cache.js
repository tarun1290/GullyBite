// src/config/cache.js
// MongoDB TTL-based cache layer.
// Uses a _cache collection with TTL index — no external cache service needed.

const { col } = require('./database');
const log = require('../utils/logger').child({ component: 'cache' });

let _indexCreated = false;

async function ensureIndex() {
  if (_indexCreated) return;
  try {
    await col('_cache').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, background: true });
    _indexCreated = true;
  } catch (_) {
    _indexCreated = true; // index may already exist
  }
}

/**
 * Get cached value or fetch from source.
 * @param {string} key - Cache key
 * @param {Function} fetcher - Async function to get fresh data if cache miss
 * @param {number} ttlSeconds - Cache TTL in seconds (default 300 = 5min)
 * @returns {*} Cached or fresh data
 */
async function getCached(key, fetcher, ttlSeconds = 300) {
  try {
    await ensureIndex();
    const doc = await col('_cache').findOne({ _id: key, expiresAt: { $gt: new Date() } });
    if (doc) return doc.value;
  } catch (e) {
    log.warn({ err: e, key }, 'Cache read failed');
  }

  const fresh = await fetcher();

  if (fresh != null) {
    try {
      await col('_cache').updateOne(
        { _id: key },
        { $set: { value: fresh, expiresAt: new Date(Date.now() + ttlSeconds * 1000), updatedAt: new Date() } },
        { upsert: true }
      );
    } catch (e) {
      log.warn({ err: e, key }, 'Cache write failed');
    }
  }

  return fresh;
}

/**
 * Invalidate cache keys — exact keys or regex patterns with *.
 * @param  {...string} keys - Exact keys or patterns (e.g., "restaurant:abc:*")
 */
async function invalidateCache(...keys) {
  try {
    for (const key of keys) {
      if (key.includes('*')) {
        await col('_cache').deleteMany({ _id: { $regex: `^${key.replace(/\*/g, '.*')}` } });
      } else {
        await col('_cache').deleteOne({ _id: key });
      }
    }
  } catch (e) {
    log.warn({ err: e }, 'Cache invalidation failed');
  }
}

/**
 * Set a cache value directly.
 */
async function setCache(key, value, ttlSeconds = 300) {
  try {
    await ensureIndex();
    await col('_cache').updateOne(
      { _id: key },
      { $set: { value, expiresAt: new Date(Date.now() + ttlSeconds * 1000), updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (e) {
    log.warn({ err: e }, 'Cache set failed');
  }
}

module.exports = { getCached, invalidateCache, setCache };
