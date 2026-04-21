// src/services/smartSendTime.js
// Computes the "best send time" for a restaurant's marketing campaign
// from 90 days of paid order history. Returns null if the tenant has
// fewer than MIN_ORDERS in the window — the campaign wizard hides the
// Smart Send radio card in that case. Cached in the `_cache` collection
// for 24h so the aggregation doesn't re-run on every page load.

'use strict';

const { col } = require('../config/database');
const cache = require('../config/cache');
const log = require('../utils/logger').child({ component: 'smartSendTime' });

const WINDOW_DAYS = 90;
const MIN_ORDERS = 20;
const CACHE_TTL_SECONDS = 24 * 60 * 60;

function cacheKey(restaurantId) {
  return `smart_send_time_${restaurantId}`;
}

// 13 → "1:00 PM", 0 → "12:00 AM", 12 → "12:00 PM".
function formatHourLabel(hourIst) {
  const h = Number(hourIst) % 24;
  const period = h < 12 ? 'AM' : 'PM';
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}:00 ${period}`;
}

// Next occurrence (UTC Date) of the given IST hour from `now`. Rolls
// forward one calendar day if the hour has already passed today (IST).
function nextOccurrenceOfIstHour(hourIst, now = new Date()) {
  const offsetMs = (5 * 60 + 30) * 60 * 1000;
  const istNow = new Date(now.getTime() + offsetMs);
  const y = istNow.getUTCFullYear();
  const m = istNow.getUTCMonth();
  const d = istNow.getUTCDate();
  // Candidate = today at `hourIst` IST, expressed in UTC.
  let candidateUtcMs = Date.UTC(y, m, d, hourIst, 0, 0) - offsetMs;
  if (candidateUtcMs <= now.getTime()) {
    candidateUtcMs += 24 * 60 * 60 * 1000;
  }
  return new Date(candidateUtcMs);
}

async function _computeUncached(restaurantId) {
  const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const totalOrders = await col('orders').countDocuments({
    restaurant_id: String(restaurantId),
    payment_status: 'paid',
    created_at: { $gte: windowStart },
  });

  if (totalOrders < MIN_ORDERS) {
    return null;
  }

  const agg = await col('orders').aggregate([
    {
      $match: {
        restaurant_id: String(restaurantId),
        payment_status: 'paid',
        created_at: { $gte: windowStart },
      },
    },
    {
      $group: {
        _id: { $hour: { date: '$created_at', timezone: 'Asia/Kolkata' } },
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1 } },
    { $limit: 1 },
  ]).toArray();

  if (!agg.length || agg[0]._id == null) return null;

  const peakHourIst = Number(agg[0]._id);
  const orderCountAtPeak = Number(agg[0].count || 0);
  const nextOccurrence = nextOccurrenceOfIstHour(peakHourIst);

  return {
    peak_hour_ist: peakHourIst,
    peak_hour_label: formatHourLabel(peakHourIst),
    next_occurrence: nextOccurrence,
    order_count_at_peak: orderCountAtPeak,
    data_days: WINDOW_DAYS,
  };
}

async function getSmartSendTime(restaurantId) {
  if (!restaurantId) return null;
  try {
    const cached = await cache.getCached(
      cacheKey(restaurantId),
      () => _computeUncached(restaurantId),
      CACHE_TTL_SECONDS,
    );
    if (!cached) return null;
    // `next_occurrence` may have been cached yesterday — recompute it
    // against the cached peak_hour_ist so the returned datetime is
    // always in the future.
    return {
      ...cached,
      next_occurrence: nextOccurrenceOfIstHour(Number(cached.peak_hour_ist)),
    };
  } catch (err) {
    log.warn({ err, restaurantId }, 'getSmartSendTime failed');
    return null;
  }
}

async function invalidateSmartSendTime(restaurantId) {
  try { await cache.invalidateCache(cacheKey(restaurantId)); } catch (_) { /* best-effort */ }
}

module.exports = {
  getSmartSendTime,
  invalidateSmartSendTime,
  formatHourLabel,
  nextOccurrenceOfIstHour,
  WINDOW_DAYS,
  MIN_ORDERS,
};
