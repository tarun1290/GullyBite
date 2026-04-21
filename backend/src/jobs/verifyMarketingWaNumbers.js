// src/jobs/verifyMarketingWaNumbers.js
// Nightly sweep of every restaurant that has configured a marketing
// WhatsApp number. Calls the verification service per tenant with a
// 200ms throttle so Meta's rate limiter stays happy. Skips tenants
// still in 'not_configured' — they don't have a number to check.

'use strict';

const { col } = require('../config/database');
const { verifyMarketingWaNumber } = require('../services/marketingWaVerification');
const log = require('../utils/logger').child({ component: 'marketing-wa-cron' });

const COLLECTION = 'restaurants';
const THROTTLE_MS = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  const started = Date.now();
  const rows = await col(COLLECTION)
    .find({
      marketing_wa_phone_number_id: { $ne: null },
      marketing_wa_status: { $ne: 'not_configured' },
    })
    .project({
      _id: 1,
      marketing_wa_phone_number_id: 1,
      marketing_wa_waba_id: 1,
      marketing_wa_status: 1,
    })
    .toArray();

  let checked = 0;
  let active = 0;
  let flagged = 0;
  let errors = 0;

  for (const r of rows) {
    try {
      const result = await verifyMarketingWaNumber(String(r._id));
      checked++;
      if (result?.status === 'active') active++;
      else if (result?.status === 'flagged') flagged++;
      else if (result?.status === 'error') errors++;
    } catch (err) {
      log.warn({ err: err?.message, restaurantId: r._id }, 'marketing wa verify failed for tenant');
      errors++;
    }
    await sleep(THROTTLE_MS);
  }

  const durationMs = Date.now() - started;
  log.info({ total: rows.length, checked, active, flagged, errors, durationMs }, 'marketing wa verification run complete');
  return { total: rows.length, checked, active, flagged, errors, durationMs };
}

function schedule() {
  const cron = require('node-cron');
  // Daily 03:00 IST — off the daytime order path, and after the
  // 02:00 RFM rebuild so the two don't contend on connection pool.
  const expr = process.env.MARKETING_WA_VERIFY_CRON || '0 3 * * *';
  cron.schedule(expr, () => {
    run().catch((err) => log.error({ err }, 'marketing wa verification run crashed'));
  }, { timezone: 'Asia/Kolkata' });
  log.info({ expr }, 'marketing wa verification scheduled');
}

module.exports = { run, schedule, COLLECTION };
