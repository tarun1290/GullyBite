'use strict';

// Hourly auto-journey scan. Handles three journeys whose triggers are
// time-based rather than event-based:
//   - winback_short: customer hit the configured day-of-inactivity
//   - reactivation:  same idea, default 30 days
//   - birthday:      customer's birthday matches today in the
//                    restaurant's configured send hour
// Event-driven journeys (welcome, milestone) are fired from the
// Razorpay webhook hooks — not here.
//
// All sends go through services/journeyExecutor.executeJourney which
// enforces the 48-hour frequency cap, wallet balance, and approved
// template checks. This job is strictly a scanner.

const cron = require('node-cron');
const { col } = require('../config/database');
const log = require('../utils/logger').child({ component: 'auto-journey-runner' });
const journeyExecutor = require('../services/journeyExecutor');
const loyaltyEngine = require('../services/loyaltyEngine');

const JOB_NAME = 'autoJourneyRunner';
const CUSTOMER_GAP_MS   = 50;
const RESTAURANT_GAP_MS = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Current hour in Asia/Kolkata, as an integer 0–23. Computed from
// Intl.DateTimeFormat to avoid pulling in moment-timezone.
function istHour() {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const hourPart = parts.find((p) => p.type === 'hour');
    return Number(hourPart?.value || 0);
  } catch {
    return new Date().getUTCHours();
  }
}

// Today's DD/MM in Asia/Kolkata.
function istDayMonth() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
  });
  const parts = fmt.formatToParts(new Date());
  const dd = parts.find((p) => p.type === 'day')?.value || '';
  const mm = parts.find((p) => p.type === 'month')?.value || '';
  return `${dd}/${mm}`;
}

async function runWindowJourney(restaurant, journeyType, triggerDay) {
  if (!Number.isFinite(triggerDay) || triggerDay <= 0) return 0;
  // Widen the match to [triggerDay-1, triggerDay] so hourly ticks don't
  // miss customers who cross the boundary between runs.
  const profiles = await col('customer_rfm_profiles').find({
    restaurant_id: restaurant._id,
    days_since_last_order: { $gt: triggerDay - 1, $lte: triggerDay },
  }).toArray();

  let fired = 0;
  for (const p of profiles) {
    if (!p?.customer_id) continue;
    await journeyExecutor.executeJourney(restaurant._id, p.customer_id, journeyType);
    fired++;
    await sleep(CUSTOMER_GAP_MS);
  }
  return fired;
}

async function runBirthday(restaurant) {
  const today = istDayMonth();
  const profiles = await col('customer_rfm_profiles').find({
    restaurant_id: restaurant._id,
    birthday: today,
  }).toArray();

  let fired = 0;
  for (const p of profiles) {
    if (!p?.customer_id) continue;
    await journeyExecutor.executeJourney(restaurant._id, p.customer_id, 'birthday');
    fired++;
    await sleep(CUSTOMER_GAP_MS);
  }
  return fired;
}

async function run() {
  const startedAt = new Date();
  try {
    const hour = istHour();
    const restaurants = await col('restaurants').find(
      { campaigns_enabled: true, marketing_wa_status: 'active' },
      { projection: { _id: 1 } },
    ).toArray();

    let totals = { winback_short: 0, reactivation: 0, birthday: 0, loyalty_expiry: 0, expired: 0 };

    for (const r of restaurants) {
      const cfg = await col('auto_journey_config').findOne({ restaurant_id: r._id });
      if (!cfg) continue;

      if (cfg.winback_short?.enabled) {
        const triggerDay = Number(cfg.winback_short.trigger_day) || 14;
        totals.winback_short += await runWindowJourney(r, 'winback_short', triggerDay);
      }
      if (cfg.reactivation?.enabled) {
        const triggerDay = Number(cfg.reactivation.trigger_day) || 30;
        totals.reactivation += await runWindowJourney(r, 'reactivation', triggerDay);
      }
      // Birthday runs when the current IST hour matches this
      // restaurant's configured send_hour_ist.
      if (cfg.birthday?.enabled) {
        const sendHour = Number(cfg.birthday.send_hour_ist);
        const resolvedHour = Number.isFinite(sendHour) ? sendHour : 10;
        if (hour === resolvedHour) {
          totals.birthday += await runBirthday(r);
        }
      }

      // Loyalty expiry: warn customers whose points will expire
      // within cfg.loyalty_expiry.days_before_expiry days, AND sweep
      // any already-expired rows for this restaurant. Both paths are
      // gated by loyalty_config.is_active inside the engine, so
      // restaurants that haven't turned on the program see no activity.
      if (cfg.loyalty_expiry?.enabled) {
        const daysBefore = Number(cfg.loyalty_expiry.days_before_expiry) || 5;

        try {
          const expiringCustomers = await loyaltyEngine.findCustomersWithExpiringPoints({
            restaurantId: r._id,
            daysBeforeExpiry: daysBefore,
          });
          const loyaltyCfg = await loyaltyEngine.getConfig(r._id);
          const ratio = Math.max(1, Number(loyaltyCfg?.points_to_rupee_ratio) || 1);
          for (const c of expiringCustomers) {
            if (!c?.customer_id) continue;
            const expiryValueRs = Math.floor((Number(c.expiring_points) || 0) / ratio);
            await journeyExecutor.executeJourney(r._id, c.customer_id, 'loyalty_expiry', {
              expiring_points: String(c.expiring_points),
              expiry_value_rs: String(expiryValueRs),
              days_until_expiry: String(daysBefore),
              balance: String(c.balance),
            });
            totals.loyalty_expiry++;
            await sleep(CUSTOMER_GAP_MS);
          }
        } catch (err) {
          log.warn({ err, restaurantId: r._id }, 'loyalty_expiry journey scan failed');
        }

        try {
          const sweep = await loyaltyEngine.expirePoints(r._id);
          totals.expired += Number(sweep?.total_expired) || 0;
        } catch (err) {
          log.warn({ err, restaurantId: r._id }, 'loyalty_expiry sweep failed');
        }
      }

      await sleep(RESTAURANT_GAP_MS);
    }

    log.info({
      restaurants: restaurants.length,
      hour,
      totals,
      durationMs: Date.now() - startedAt.getTime(),
    }, 'auto-journey scan complete');
  } catch (err) {
    log.error({ err }, 'auto-journey scan crashed');
  }
}

function schedule() {
  const expr = process.env.AUTO_JOURNEY_CRON || '0 * * * *';
  cron.schedule(expr, () => {
    run().catch((err) => log.error({ err }, 'auto-journey tick crashed'));
  }, { timezone: 'Asia/Kolkata' });
  log.info({ expr }, 'auto-journey runner scheduled');
}

module.exports = { run, schedule, JOB_NAME };
