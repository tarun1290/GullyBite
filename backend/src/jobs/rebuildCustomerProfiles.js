// src/jobs/rebuildCustomerProfiles.js
// Nightly RFM rebuild. Reads orders per active tenant, aggregates by
// customer_id, computes R/F/M via services/rfm.js, and upserts the
// result into customer_rfm_profiles. Never runs in the live order
// path — this is a batch rollup. Cron is always on; the dashboard
// surface that consumes it is gated by restaurants.campaigns_enabled.

'use strict';

const { col, newId } = require('../config/database');
const { computeRFMScores } = require('../services/rfm');
const log = require('../utils/logger').child({ component: 'rfm-rebuild' });

const JOB_NAME = 'rebuildCustomerProfiles';
const THROTTLE_MS = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Aggregate all PAID orders for a tenant, grouped by customer_id.
// Returns [{ customer_id, order_count, total_spend_rs, first_order_at,
// last_order_at, avg_order_value_rs, days_since_last_order }]. Orders
// without a customer_id are skipped — they cannot be rolled up.
async function _aggregateOrdersForTenant(restaurantId, now) {
  const cursor = col('orders').aggregate([
    {
      $match: {
        restaurant_id: restaurantId,
        payment_status: 'paid',
        customer_id: { $ne: null },
      },
    },
    {
      $group: {
        _id: '$customer_id',
        order_count: { $sum: 1 },
        total_spend_rs: { $sum: '$total_rs' },
        first_order_at: { $min: '$created_at' },
        last_order_at: { $max: '$created_at' },
      },
    },
  ], { allowDiskUse: true });

  const rows = await cursor.toArray();
  return rows.map((r) => {
    const orderCount = Number(r.order_count) || 0;
    const totalSpend = Number(r.total_spend_rs) || 0;
    const last = r.last_order_at ? new Date(r.last_order_at) : null;
    const daysSince = last
      ? Math.max(0, Math.floor((now - last.getTime()) / (24 * 60 * 60 * 1000)))
      : 9999;
    return {
      customer_id: r._id,
      order_count: orderCount,
      total_spend_rs: Number(totalSpend.toFixed(2)),
      avg_order_value_rs: orderCount > 0
        ? Number((totalSpend / orderCount).toFixed(2))
        : 0,
      first_order_at: r.first_order_at || null,
      last_order_at: r.last_order_at || null,
      days_since_last_order: daysSince,
    };
  });
}

async function _rebuildTenant(restaurantId, now) {
  const aggregated = await _aggregateOrdersForTenant(restaurantId, now);
  if (aggregated.length === 0) return 0;

  const scored = computeRFMScores(aggregated);
  const rebuildAt = new Date(now);

  const bulk = scored.map((c) => ({
    updateOne: {
      filter: { restaurant_id: restaurantId, customer_id: c.customer_id },
      update: {
        $set: {
          restaurant_id: restaurantId,
          customer_id: c.customer_id,
          r_score: c.r_score,
          f_score: c.f_score,
          m_score: c.m_score,
          rfm_label: c.rfm_label,
          order_count: c.order_count,
          total_spend_rs: c.total_spend_rs,
          avg_order_value_rs: c.avg_order_value_rs,
          first_order_at: c.first_order_at,
          last_order_at: c.last_order_at,
          days_since_last_order: c.days_since_last_order,
          last_rebuild_at: rebuildAt,
        },
        $setOnInsert: { _id: newId() },
      },
      upsert: true,
    },
  }));

  await col('customer_rfm_profiles').bulkWrite(bulk, { ordered: false });
  return scored.length;
}

async function run() {
  const started = new Date();
  const now = started.getTime();
  log.info({ jobName: JOB_NAME }, 'rfm rebuild started');

  const restaurants = await col('restaurants')
    .find({ status: 'active' })
    .project({ _id: 1 })
    .toArray();

  let restaurantsProcessed = 0;
  let customersProcessed = 0;
  const errors = [];

  for (const r of restaurants) {
    try {
      const n = await _rebuildTenant(String(r._id), now);
      customersProcessed += n;
      restaurantsProcessed++;
    } catch (err) {
      log.warn({ err, restaurantId: r._id }, 'rfm rebuild tenant failed');
      errors.push({
        restaurant_id: String(r._id),
        message: err?.message || String(err),
      });
    }
    await sleep(THROTTLE_MS);
  }

  const completed = new Date();
  const status = errors.length === 0
    ? 'success'
    : (restaurantsProcessed > 0 ? 'partial' : 'failed');

  await col('job_logs').insertOne({
    _id: newId(),
    job_name: JOB_NAME,
    started_at: started,
    completed_at: completed,
    duration_ms: completed.getTime() - started.getTime(),
    restaurants_processed: restaurantsProcessed,
    customers_processed: customersProcessed,
    status,
    errors,
    created_at: new Date(),
  }).catch((err) => log.warn({ err }, 'job_log write failed'));

  log.info({
    jobName: JOB_NAME,
    restaurantsProcessed,
    customersProcessed,
    errorCount: errors.length,
    durationMs: completed.getTime() - started.getTime(),
    status,
  }, 'rfm rebuild complete');

  return { restaurantsProcessed, customersProcessed, errors, status };
}

function schedule() {
  const cron = require('node-cron');
  // Nightly 02:00 IST. Equivalent semantics to the spec's 20:30 UTC
  // window; chosen to match the repo's `timezone: 'Asia/Kolkata'`
  // convention (reconciliation, settlement) and stay off the daytime
  // order path.
  const expr = process.env.RFM_REBUILD_CRON || '0 2 * * *';
  cron.schedule(expr, () => {
    run().catch((err) => log.error({ err }, 'rfm rebuild run crashed'));
  }, { timezone: 'Asia/Kolkata' });
  log.info({ expr }, 'rfm rebuild scheduled');
}

module.exports = { run, schedule, JOB_NAME };
