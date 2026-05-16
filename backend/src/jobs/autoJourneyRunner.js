'use strict';

// Hourly auto-journey scan. Handles three journeys whose triggers are
// time-based rather than event-based:
//   - winback_short: customer hit the configured day-of-inactivity
//   - winback_long:  same idea, default 30 days
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
const marketingCampaigns = require('../services/marketingCampaigns');

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

// Most frequently ordered item for a (restaurant, customer) pair across
// all DELIVERED orders. Used to personalise the reorder_suggestion
// journey's `top_item` variable so the WA template can name the dish
// the customer keeps coming back for ("Missing your usual Chicken
// Biryani?").
//
// Reads from the `order_items` collection rather than the `orders.items`
// denormalised array because that array is only populated by
// services/orderCreate.service.js — the conversational
// (services/order.js) and WA Checkout (webhooks/checkout.js) paths
// don't write it. order_items rows are written by every creation path
// and carry restaurant_id + item_name + quantity, so they're the
// authoritative line-item store.
//
// Counts by occurrence ($sum: 1) rather than total quantity ordered —
// "frequently ordered" semantically means "appears in many orders",
// not "high-volume single order". A dish ordered once per visit across
// 5 visits ranks higher than 10 of something in a single order.
//
// Returns null when the customer has no delivered orders at this
// restaurant; caller passes empty overrideVariables so the template
// resolves `top_item` from the variables[] schema's example/default.
async function getTopOrderedItem(restaurantId, customerId) {
  if (!restaurantId || !customerId) return null;
  const deliveredIds = await col('orders').distinct('_id', {
    restaurant_id: String(restaurantId),
    customer_id: String(customerId),
    status: 'DELIVERED',
  });
  if (!deliveredIds.length) return null;

  const result = await col('order_items').aggregate([
    { $match: { order_id: { $in: deliveredIds.map(String) } } },
    { $group: { _id: '$item_name', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 1 },
  ]).toArray();
  return result[0]?._id || null;
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

// Expired-draft scanner. Cancels marketing_campaigns rows that were
// created via the two-step flow but never confirmed within the 24h
// confirmation_before window (set in routes/marketingCampaigns.js
// POST /create). Operators occasionally start a campaign + walk away
// — without this sweep those drafts would sit in the dashboard
// indefinitely and clutter the campaigns list. Cancelling here keeps
// status:'cancelled' as the canonical terminal-without-send state, so
// reporting / filters that exclude cancelled drafts stay correct.
//
// Single updateMany so the sweep is one round-trip per tick regardless
// of how many drafts have aged out. Wrapped at the call site (in
// run()) so a Mongo blip during the sweep never blocks the journey
// totals or the summary log that follows.
async function scanExpiredDrafts() {
  const now = new Date();
  const result = await col('marketing_campaigns').updateMany(
    { status: 'draft', confirmed_before: { $lte: now } },
    { $set: {
        status: 'cancelled',
        cancelled_at: now,
        cancellation_reason: 'confirmation_timeout',
        updated_at: now,
    } },
  );
  log.info(
    { matched: result.matchedCount, modified: result.modifiedCount },
    `expired draft scanner: cancelled ${result.modifiedCount} unconfirmed campaigns`,
  );
}

// Scheduled-send scanner. Picks up marketing_campaigns rows that
// routes/marketingCampaigns.js created with `status: 'scheduled'` + a
// future `send_at`, and dispatches them via marketingCampaigns.sendCampaign
// once their send time arrives. No restaurant filter — one pass covers
// every tenant. sendCampaign itself is idempotent against the
// 'sending'/'sent' guard so a slow tick that overlaps the next one is
// safe. Each dispatch wrapped individually so one failure cannot block
// the rest of the batch.
async function scanScheduledCampaigns() {
  const now = new Date();
  const due = await col('marketing_campaigns').find(
    { status: 'scheduled', send_at: { $lte: now } },
    { projection: { _id: 1, restaurant_id: 1 } },
  ).toArray();

  log.info({ count: due.length }, `scheduled campaign scanner: found ${due.length} due`);

  for (const c of due) {
    try {
      await marketingCampaigns.sendCampaign(c._id);
      log.info({ campaignId: c._id, restaurantId: c.restaurant_id }, 'dispatched campaignId');
    } catch (err) {
      log.warn({
        err,
        campaignId: c._id,
        restaurantId: c.restaurant_id,
      }, `dispatch failed campaignId — ${err?.message || 'error'}`);
    }
  }
}

async function run() {
  const startedAt = new Date();
  try {
    const hour = istHour();
    const restaurants = await col('restaurants').find(
      { campaigns_enabled: true, marketing_wa_status: 'active' },
      { projection: { _id: 1 } },
    ).toArray();

    let totals = { winback_short: 0, winback_long: 0, reorder_suggestion: 0, birthday: 0, loyalty_expiry: 0, expired: 0 };

    for (const r of restaurants) {
      const cfg = await col('auto_journey_config').findOne({ restaurant_id: r._id });
      if (!cfg) continue;

      if (cfg.winback_short?.enabled) {
        const triggerDay = Number(cfg.winback_short.trigger_day) || 14;
        totals.winback_short += await runWindowJourney(r, 'winback_short', triggerDay);
      }
      if (cfg.winback_long?.enabled) {
        const triggerDay = Number(cfg.winback_long.trigger_day) || 30;
        totals.winback_long += await runWindowJourney(r, 'winback_long', triggerDay);
      }

      // ─── REORDER_SUGGESTION ─────────────────────────────────
      // Same days_since_last_order window pattern as winback_short /
      // winback_long, BUT diverges from runWindowJourney to look up
      // each customer's top-ordered item at this restaurant and pass
      // it as a `top_item` overrideVariable. Customers with no
      // delivered orders fall through to executeJourney with empty
      // overrides — the template's variables[] declaration provides a
      // safe fallback string.
      //
      // The 7-day default sits inside the (winback_short=14d) window —
      // a customer reaches reorder_suggestion before either winback,
      // so the journey ordering is reorder → winback_short → winback_long
      // as inactivity deepens. The 48h frequency cap inside
      // executeJourney prevents a customer from getting two journey
      // sends within the same window if multiple thresholds happen to
      // fire close together.
      if (cfg.reorder_suggestion?.enabled) {
        const triggerDay = Number(cfg.reorder_suggestion.trigger_day) || 7;
        if (Number.isFinite(triggerDay) && triggerDay > 0) {
          const profiles = await col('customer_rfm_profiles').find({
            restaurant_id: r._id,
            days_since_last_order: { $gt: triggerDay - 1, $lte: triggerDay },
          }).toArray();
          for (const p of profiles) {
            if (!p?.customer_id) continue;
            const topItem = await getTopOrderedItem(r._id, p.customer_id).catch(() => null);
            await journeyExecutor.executeJourney(
              r._id,
              p.customer_id,
              'reorder_suggestion',
              topItem ? { last_item: topItem } : {},
            );
            totals.reorder_suggestion++;
            await sleep(CUSTOMER_GAP_MS);
          }
        }
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

    // Scheduled-send sweep — independent of the restaurant loop above.
    // Wrapped in its own try/catch so a marketing_campaigns query / send
    // failure can never affect the per-journey totals or the summary log.
    try {
      await scanScheduledCampaigns();
    } catch (err) {
      log.error({ err }, 'scheduled campaign scanner crashed');
    }

    // Expired-draft sweep — sibling to scanScheduledCampaigns. Same
    // isolation: a Mongo blip here cannot affect journey totals or
    // the scheduled-campaign sweep above (which already ran).
    try {
      await scanExpiredDrafts();
    } catch (err) {
      log.error({ err }, 'expired draft scanner crashed');
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
