// src/config/cache.js
// Upstash Redis cache layer — graceful degradation if Redis unavailable.
// If UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are not set,
// all cache operations are no-ops and the app works normally (just slower).

let redis = null;

const CACHE_ENABLED = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

if (CACHE_ENABLED) {
  try {
    const { Redis } = require('@upstash/redis');
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    console.log('[Cache] ✅ Upstash Redis connected');
  } catch (e) {
    console.warn('[Cache] ⚠️ Failed to init Redis:', e.message);
  }
} else {
  console.log('[Cache] ⚠️ Redis not configured — running without cache');
}

/**
 * Get cached value or fetch from source.
 * @param {string} key - Cache key
 * @param {Function} fetcher - Async function to get fresh data if cache miss
 * @param {number} ttlSeconds - Cache TTL in seconds (default 300 = 5min)
 * @returns {*} Cached or fresh data
 */
async function getCached(key, fetcher, ttlSeconds = 300) {
  if (redis) {
    try {
      const cached = await redis.get(key);
      if (cached != null) {
        return typeof cached === 'string' ? JSON.parse(cached) : cached;
      }
    } catch (e) {
      console.warn('[Cache] Read failed for', key, ':', e.message);
    }
  }

  const fresh = await fetcher();

  if (redis && fresh != null) {
    try {
      await redis.set(key, JSON.stringify(fresh), { ex: ttlSeconds });
    } catch (e) {
      console.warn('[Cache] Write failed for', key, ':', e.message);
    }
  }

  return fresh;
}

/**
 * Invalidate cache keys matching a pattern.
 * @param  {...string} keys - Exact keys to delete (or patterns with *)
 */
async function invalidateCache(...keys) {
  if (!redis) return;
  try {
    const exactKeys = keys.filter(k => !k.includes('*'));
    const patterns = keys.filter(k => k.includes('*'));

    if (exactKeys.length) await redis.del(...exactKeys);

    for (const pattern of patterns) {
      let cursor = 0;
      do {
        const [nextCursor, matchedKeys] = await redis.scan(cursor, { match: pattern, count: 100 });
        cursor = nextCursor;
        if (matchedKeys.length) await redis.del(...matchedKeys);
      } while (cursor !== 0);
    }
  } catch (e) {
    console.warn('[Cache] Invalidation failed:', e.message);
  }
}

/**
 * Set a cache value directly.
 */
async function setCache(key, value, ttlSeconds = 300) {
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), { ex: ttlSeconds });
  } catch (e) {
    console.warn('[Cache] Set failed:', e.message);
  }
}

module.exports = { getCached, invalidateCache, setCache, CACHE_ENABLED };
