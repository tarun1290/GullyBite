'use strict';

// Auto-journey executor. Single entry point for all six journeys
// (welcome, winback_short, reactivation, birthday, loyalty_expiry,
// milestone). The event hooks (Razorpay webhook) and cron runner both
// call into executeJourney — they never build the campaign doc or
// dispatch messages themselves.
//
// Send path reuses services/marketingCampaigns.sendCampaign so wallet
// deduction, webhook stat tracking, and message mapping all stay
// unified. We materialise a one-recipient marketing_campaigns doc with
// target_segment='journey_trigger' so sendCampaign's RFM join still
// resolves to exactly this customer. A dedicated profile filter
// short-circuit keeps the targeting exact.

const { col, newId } = require('../config/database');
const log = require('../utils/logger').child({ component: 'journey' });
const marketingCampaigns = require('./marketingCampaigns');

const DEFAULT_JOURNEY_CONFIG = {
  welcome:        { enabled: false, template_id: null, custom_variable_values: {} },
  winback_short:  { enabled: false, trigger_day: 14, template_id: null, custom_variable_values: {} },
  reactivation:   { enabled: false, trigger_day: 30, template_id: null, custom_variable_values: {} },
  birthday:       { enabled: false, template_id: null, custom_variable_values: {}, send_hour_ist: 10 },
  loyalty_expiry: { enabled: false, days_before_expiry: 5, template_id: null, custom_variable_values: {} },
  milestone:      { enabled: false, trigger_orders: [5, 10, 25], template_id: null, custom_variable_values: {} },
};

const JOURNEY_TYPES = Object.keys(DEFAULT_JOURNEY_CONFIG);
const CAP_WINDOW_MS = 48 * 60 * 60 * 1000;

function defaultConfig(restaurantId) {
  return {
    restaurant_id: String(restaurantId),
    ...JSON.parse(JSON.stringify(DEFAULT_JOURNEY_CONFIG)),
  };
}

async function getConfig(restaurantId) {
  const row = await col('auto_journey_config').findOne({ restaurant_id: String(restaurantId) });
  if (!row) return defaultConfig(restaurantId);
  // Merge stored doc over defaults so a missing journey key doesn't crash.
  const merged = defaultConfig(restaurantId);
  for (const k of JOURNEY_TYPES) {
    if (row[k] && typeof row[k] === 'object') {
      merged[k] = { ...merged[k], ...row[k] };
    }
  }
  merged._id = row._id;
  merged.created_at = row.created_at;
  merged.updated_at = row.updated_at;
  return merged;
}

// Resolve which campaign_template to send for a given journey. If the
// config pinned a template_id we trust it as long as it's still active
// and approved; otherwise fall back to the first active+approved
// template whose use_case matches the journey.
async function pickTemplate(journeyType, configEntry) {
  if (configEntry?.template_id) {
    const picked = await col('campaign_templates').findOne({
      template_id: String(configEntry.template_id),
      is_active: true,
      meta_approval_status: 'approved',
    });
    if (picked) return picked;
    // Pinned id no longer usable — fall through to the use_case default.
  }
  const fallback = await col('campaign_templates').findOne({
    use_case: journeyType,
    is_active: true,
    meta_approval_status: 'approved',
  });
  return fallback || null;
}

// Main entry. Never throws — returns a plain `{ ok, reason }` shape so
// callers can log without crashing the webhook / cron tick.
async function executeJourney(restaurantId, customerId, journeyType, overrideVariables = {}) {
  try {
    if (!restaurantId || !customerId || !JOURNEY_TYPES.includes(journeyType)) {
      return { ok: false, reason: 'bad_args' };
    }

    const restaurant = await col('restaurants').findOne({ _id: String(restaurantId) });
    if (!restaurant) {
      log.debug({ restaurantId, journeyType }, 'journey: restaurant not found');
      return { ok: false, reason: 'no_restaurant' };
    }
    if (!restaurant.campaigns_enabled) {
      log.debug({ restaurantId, journeyType }, 'journey: campaigns_enabled false');
      return { ok: false, reason: 'campaigns_disabled' };
    }
    if (restaurant.marketing_wa_status !== 'active') {
      log.debug({ restaurantId, journeyType }, 'journey: marketing_wa_status not active');
      return { ok: false, reason: 'marketing_wa_not_active' };
    }

    const config = await getConfig(restaurantId);
    const entry = config[journeyType];
    if (!entry?.enabled) {
      log.debug({ restaurantId, journeyType }, 'journey: not enabled');
      return { ok: false, reason: 'journey_disabled' };
    }

    // Frequency cap — 48h, skipped for birthday.
    if (journeyType !== 'birthday') {
      const since = new Date(Date.now() - CAP_WINDOW_MS);
      const recent = await col('journey_send_log').findOne({
        restaurant_id: String(restaurantId),
        customer_id: String(customerId),
        sent_at: { $gte: since },
      });
      if (recent) {
        log.debug({ restaurantId, customerId, journeyType, capAgainst: recent.journey_type }, 'journey: frequency cap hit');
        return { ok: false, reason: 'frequency_cap' };
      }
    }

    const template = await pickTemplate(journeyType, entry);
    if (!template) {
      log.warn({ restaurantId, journeyType }, 'journey: no approved template for use_case');
      return { ok: false, reason: 'no_template' };
    }

    const customer = await col('customers').findOne(
      { _id: String(customerId) },
      { projection: { _id: 1, wa_phone: 1, name: 1 } },
    );
    if (!customer?.wa_phone) {
      log.debug({ restaurantId, customerId, journeyType }, 'journey: customer wa_phone missing');
      return { ok: false, reason: 'no_wa_phone' };
    }

    // Wallet pre-check. Let sendCampaign handle the actual debit but
    // short-circuit here so we don't materialise a campaign doc that
    // will just be rejected.
    const wallet = await col('waba_wallets').findOne({ restaurant_id: String(restaurantId) });
    const balanceRs = Number(wallet?.balance_rs || 0);
    const perMsgRs = Number(template.per_message_cost_rs) || 0;
    if (balanceRs < perMsgRs) {
      log.warn({ restaurantId, journeyType, balanceRs, perMsgRs }, 'Insufficient wallet balance for journey');
      return { ok: false, reason: 'insufficient_balance' };
    }

    // Merge variable values: journey custom overrides → call-site overrides.
    // auto/customer_data/system sources resolve inside sendCampaign at send time.
    const mergedVariables = {
      ...(entry.custom_variable_values || {}),
      ...(overrideVariables || {}),
    };

    const campaignId = newId();
    const now = new Date();
    const campaignDoc = {
      _id: campaignId,
      restaurant_id: String(restaurantId),
      template_id: template.template_id,
      display_name: `${journeyType} — auto`,
      use_case: template.use_case,
      status: 'draft',
      // Custom segment understood by services/marketingCampaigns.sendCampaign:
      // a single-recipient journey trigger — sendCampaign re-fetches by
      // segment, so we pair that with `journey_customer_id` below to
      // narrow profiles down to exactly one customer.
      target_segment: 'journey_trigger',
      journey_customer_id: String(customerId),
      journey_type: journeyType,
      target_count: 1,
      actual_sent_count: 0,
      send_at: null,
      sent_at: null,
      completed_at: null,
      variable_values: mergedVariables,
      stats: {
        sent: 0, delivered: 0, read: 0, failed: 0,
        replied: 0, converted: 0, revenue_attributed_rs: 0,
        delivery_rate: 0, read_rate: 0, conversion_rate: 0,
      },
      estimated_cost_rs: perMsgRs,
      actual_cost_rs: 0,
      per_message_cost_rs: perMsgRs,
      created_at: now,
      updated_at: now,
    };
    await col('marketing_campaigns').insertOne(campaignDoc);

    // Fire the existing sender. It re-reads the doc, runs its own
    // guards, debits wallet, and updates stats. We intentionally don't
    // await the terminal status — the log entry below is what drives
    // the frequency cap regardless of sender outcome.
    marketingCampaigns.sendCampaign(campaignId).catch((err) => {
      log.error({ err, campaignId, journeyType }, 'sendCampaign failed for journey');
    });

    await col('journey_send_log').insertOne({
      _id: newId(),
      restaurant_id: String(restaurantId),
      customer_id: String(customerId),
      journey_type: journeyType,
      sent_at: now,
      campaign_id: campaignId,
    }).catch((err) => log.warn({ err, campaignId }, 'journey_send_log insert failed'));

    return { ok: true, campaignId, journeyType };
  } catch (err) {
    log.error({ err, restaurantId, customerId, journeyType }, 'executeJourney crashed');
    return { ok: false, reason: 'error' };
  }
}

module.exports = {
  executeJourney,
  DEFAULT_JOURNEY_CONFIG,
  JOURNEY_TYPES,
  CAP_WINDOW_MS,
  defaultConfig,
  getConfig,
};
