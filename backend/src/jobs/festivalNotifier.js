// src/jobs/festivalNotifier.js
// Daily 08:00 IST scan of `festivals_calendar`. For every festival whose
// notification_date falls within today (IST), drop a bell notification
// of type `festival_reminder` into `restaurant_notifications` for every
// active restaurant — but only if we haven't already dropped one for
// the same (restaurant, festival_slug) pair. The 3-minute per-tenant
// throttle keeps the inserts well under Mongo's throughput ceiling.

'use strict';

const cron = require('node-cron');
const { col, newId } = require('../config/database');
const log = require('../utils/logger').child({ component: 'festivalNotifier' });

const JOB_NAME = 'festivalNotifier';

const PER_RESTAURANT_DELAY_MS = 50;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Midnight-IST boundaries around now(). IST = UTC+05:30 → midnight IST
// is 18:30 UTC of the previous calendar day.
function istDayBounds(now = new Date()) {
  const offsetMs = (5 * 60 + 30) * 60 * 1000;
  const istNow = new Date(now.getTime() + offsetMs);
  const y = istNow.getUTCFullYear();
  const m = istNow.getUTCMonth();
  const d = istNow.getUTCDate();
  const startIstUtcMs = Date.UTC(y, m, d) - offsetMs;
  const endIstUtcMs = startIstUtcMs + 24 * 60 * 60 * 1000;
  return { start: new Date(startIstUtcMs), end: new Date(endIstUtcMs) };
}

async function run() {
  const startedAt = Date.now();
  try {
    const { start, end } = istDayBounds();

    const festivals = await col('festivals_calendar').find({
      is_active: true,
      notification_date: { $gte: start, $lt: end },
    }).toArray();

    if (!festivals.length) {
      log.info({ window: { start, end } }, 'no festivals require notification today');
      return { festivals: 0, notifications: 0, restaurants: 0 };
    }

    const restaurants = await col('restaurants').find(
      { status: 'active' },
      { projection: { _id: 1 } },
    ).toArray();

    log.info({ festivals: festivals.length, restaurants: restaurants.length }, 'festival notifier tick');

    let notificationsCreated = 0;

    for (const festival of festivals) {
      for (const r of restaurants) {
        const restaurantId = String(r._id);
        try {
          // Per-restaurant idempotency: never double-notify for the
          // same (restaurant, festival.slug) pair.
          const existing = await col('restaurant_notifications').findOne({
            restaurant_id: restaurantId,
            type: 'festival_reminder',
            'data.festival_slug': festival.slug,
          }, { projection: { _id: 1 } });
          if (existing) continue;

          const title = `${festival.name} is in 2 days`;
          const body = festival.suggested_message_hint
            || `Send a festive campaign to your customers for ${festival.name}`;

          await col('restaurant_notifications').insertOne({
            _id: newId(),
            restaurant_id: restaurantId,
            type: 'festival_reminder',
            title,
            body,
            data: {
              festival_slug: festival.slug,
              festival_name: festival.name,
              festival_date: festival.date,
              default_template_use_case: festival.default_template_use_case || 'festival',
              suggested_message_hint: festival.suggested_message_hint || null,
            },
            is_read: false,
            created_at: new Date(),
          });
          notificationsCreated++;
        } catch (err) {
          log.warn({ err, restaurantId, slug: festival.slug }, 'festival notification insert failed');
        }
        await sleep(PER_RESTAURANT_DELAY_MS);
      }
    }

    const tookMs = Date.now() - startedAt;
    log.info({
      festivals: festivals.length,
      restaurants: restaurants.length,
      notifications: notificationsCreated,
      tookMs,
    }, 'festival notifier done');

    return {
      festivals: festivals.length,
      restaurants: restaurants.length,
      notifications: notificationsCreated,
    };
  } catch (err) {
    log.error({ err }, 'festival notifier tick crashed');
    throw err;
  }
}

function schedule() {
  const expr = process.env.FESTIVAL_NOTIFIER_CRON || '0 8 * * *';
  cron.schedule(expr, () => {
    run().catch((err) => log.error({ err }, 'festival notifier crashed'));
  }, { timezone: 'Asia/Kolkata' });
  log.info({ expr }, 'festival notifier scheduled');
}

module.exports = { run, schedule, JOB_NAME, istDayBounds };
