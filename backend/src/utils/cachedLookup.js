// src/utils/cachedLookup.js
// Cached MongoDB lookups for hot-path data (branch, restaurant, whatsapp_accounts).
// Uses in-memory memcache with 5-minute TTL. Writes always go to DB first.

'use strict';

const { col } = require('../config/database');
const memcache = require('../config/memcache');

const TTL = 300; // 5 minutes

async function getBranch(branchId) {
  const key = `branch:${branchId}`;
  let cached = memcache.get(key);
  if (cached) return cached;
  cached = await col('branches').findOne({ _id: branchId });
  if (cached) memcache.set(key, cached, TTL);
  return cached;
}

async function getRestaurant(restaurantId) {
  const key = `restaurant:${restaurantId}`;
  let cached = memcache.get(key);
  if (cached) return cached;
  cached = await col('restaurants').findOne({ _id: restaurantId });
  if (cached) memcache.set(key, cached, TTL);
  return cached;
}

async function getWaAccount(phoneNumberId) {
  const key = `wa_account:${phoneNumberId}`;
  let cached = memcache.get(key);
  if (cached) return cached;
  cached = await col('whatsapp_accounts').findOne({ phone_number_id: phoneNumberId, is_active: true });
  if (cached) memcache.set(key, cached, TTL);
  return cached;
}

module.exports = { getBranch, getRestaurant, getWaAccount };
