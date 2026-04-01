// src/config/memcache.js
// Simple in-memory TTL cache using a Map.
// For hot data that's read frequently and changed rarely.
// NOT a replacement for MongoDB — writes always go to DB first.

'use strict';

const _store = new Map(); // key → { value, expiresAt }

function get(key) {
  const entry = _store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _store.delete(key); return null; }
  return entry.value;
}

function set(key, value, ttlSeconds = 300) {
  _store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

function del(key) {
  _store.delete(key);
}

function clear() {
  _store.clear();
}

function invalidatePrefix(prefix) {
  for (const key of _store.keys()) {
    if (key.startsWith(prefix)) _store.delete(key);
  }
}

module.exports = { get, set, del, clear, invalidatePrefix };
