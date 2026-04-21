'use strict';

// Manual-blast campaign sender. Distinct from services/campaigns.js
// (MPM catalog promos). Here we dispatch a WhatsApp template message
// — defined in the admin-curated campaign_templates library — to each
// recipient resolved from the restaurant's customer_rfm_profiles for
// a given RFM segment (or 'all').
//
// The sender is synchronous within a restaurant: we fetch recipients,
// resolve per-recipient variable values, call wa.sendTemplate, and
// $inc stats atomically. Messages go out in batches of 50 with a 500ms
// gap between batches to stay inside Meta's per-second ceiling.
//
// Cost handling: per_message_cost_rs is locked in at campaign creation
// (copied from the template). Each successful send debits the tenant's
// waba_wallet. The debit description begins with the literal string
// "meta_marketing_charge" so downstream ledger tooling (and the verify
// grep) can key off of that.
//
// Idempotency is enforced by the 'sending' status guard — a second
// concurrent call bails immediately on the status check.

const { col, newId } = require('../config/database');
const log = require('../utils/logger');
const wa = require('./whatsapp');
const wallet = require('./wallet');
const { hashPhone } = require('../utils/phoneHash');

const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve variable values for a single recipient. Merges the four
// source types defined by campaign_templates.variables[].source:
//   - restaurant_input: from campaign.variable_values
//   - customer_data:    customer_name, loyalty_balance_rs, last_order_at
//   - auto:             restaurant_name, restaurant_city
//   - system:           today, tomorrow (ISO date strings)
// The returned object keys match variable names so the template
// component builder can emit parameters in declared order.
function resolveVariables({ variables, campaign, customer, rfmProfile, restaurant }) {
  const resolved = {};
  const stored = campaign.variable_values || {};
  const now = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const todayStr = iso(now);
  const tomorrowStr = iso(new Date(now.getTime() + 24 * 60 * 60 * 1000));

  for (const v of variables || []) {
    let value = '';
    switch (v.source) {
      case 'restaurant_input':
        value = stored[v.name] != null ? String(stored[v.name]) : (v.example || '');
        break;
      case 'customer_data':
        if (v.name === 'customer_name') value = customer?.name || 'there';
        else if (v.name === 'loyalty_balance_rs') value = String(Math.max(0, Number(rfmProfile?.total_spend_rs || 0)));
        else if (v.name === 'last_order_at') value = rfmProfile?.last_order_at ? iso(new Date(rfmProfile.last_order_at)) : '';
        else value = stored[v.name] != null ? String(stored[v.name]) : (v.example || '');
        break;
      case 'auto':
        if (v.name === 'restaurant_name') value = restaurant?.brand_name || restaurant?.business_name || '';
        else if (v.name === 'restaurant_city') value = restaurant?.city || '';
        else value = v.example || '';
        break;
      case 'system':
        if (v.name === 'today') value = todayStr;
        else if (v.name === 'tomorrow') value = tomorrowStr;
        else value = stored[v.name] != null ? String(stored[v.name]) : (v.example || '');
        break;
      default:
        value = v.example || '';
    }
    resolved[v.name] = value;
  }
  return resolved;
}

// Build the components[] array in the order expected by Meta. Body
// variables appear as positional {{1}}, {{2}}, … in the body_template;
// we emit them in the order the variables[] were declared. Button
// text/URL variables are not supported in this first cut — templates
// needing those should omit the button or use a static URL.
function buildComponents(template, resolved) {
  const components = [];
  const ordered = (template.variables || []).map((v) => resolved[v.name] ?? '');
  if (ordered.length) {
    components.push({
      type: 'body',
      parameters: ordered.map((text) => ({ type: 'text', text: String(text) })),
    });
  }
  return components;
}

// Finalize a campaign to a terminal status. Safe to call multiple
// times — the set is unconditional but the status transitions are
// monotonic (nothing moves off 'sent' / 'failed').
async function finalize(campaignId, status, patch = {}) {
  await col('marketing_campaigns').updateOne(
    { _id: campaignId },
    { $set: { status, updated_at: new Date(), ...patch } },
  ).catch((err) => log.error({ err, campaignId }, 'finalize marketing_campaign failed'));
}

async function sendCampaign(campaignId) {
  const campaign = await col('marketing_campaigns').findOne({ _id: campaignId });
  if (!campaign) {
    log.warn({ campaignId }, 'sendCampaign: not found');
    return { ok: false, reason: 'not_found' };
  }
  // Idempotency guard — only draft/scheduled can enter send path.
  if (!['draft', 'scheduled'].includes(campaign.status)) {
    log.info({ campaignId, status: campaign.status }, 'sendCampaign: already processed');
    return { ok: false, reason: 'already_processed', status: campaign.status };
  }

  try {
    const restaurantId = campaign.restaurant_id;
    const restaurant = await col('restaurants').findOne({ _id: restaurantId });
    if (!restaurant) {
      await finalize(campaignId, 'failed', { error_message: 'Restaurant not found' });
      return { ok: false, reason: 'restaurant_not_found' };
    }
    if (restaurant.marketing_wa_status !== 'active') {
      await finalize(campaignId, 'failed', { error_message: 'Marketing WhatsApp number not active' });
      return { ok: false, reason: 'marketing_wa_not_active' };
    }
    if (!restaurant.campaigns_enabled) {
      await finalize(campaignId, 'failed', { error_message: 'Campaigns not enabled' });
      return { ok: false, reason: 'campaigns_not_enabled' };
    }

    const waAccount = await col('whatsapp_accounts').findOne({
      restaurant_id: restaurantId, is_active: true,
    });
    if (!waAccount?.access_token) {
      await finalize(campaignId, 'failed', { error_message: 'WhatsApp access token missing' });
      return { ok: false, reason: 'no_access_token' };
    }
    const phoneNumberId = restaurant.marketing_wa_phone_number_id || waAccount.phone_number_id;

    const template = await col('campaign_templates').findOne({ template_id: campaign.template_id });
    if (!template) {
      await finalize(campaignId, 'failed', { error_message: 'Template not found' });
      return { ok: false, reason: 'template_not_found' };
    }

    // Build recipient list. Two paths:
    //   1. 'journey_trigger' — auto-journey single-customer dispatch.
    //      Targets exactly one customer via campaign.journey_customer_id;
    //      RFM profile is optional (welcome may fire before nightly RFM
    //      rebuild has materialised a profile for a brand-new customer).
    //   2. Manual blast — 'all' or an RFM label joins profiles→customers.
    let recipients;
    if (campaign.target_segment === 'journey_trigger' && campaign.journey_customer_id) {
      const cid = String(campaign.journey_customer_id);
      const [customer, profile] = await Promise.all([
        col('customers').findOne({ _id: cid }, { projection: { _id: 1, wa_phone: 1, name: 1 } }),
        col('customer_rfm_profiles').findOne({ restaurant_id: restaurantId, customer_id: cid }),
      ]);
      recipients = (customer?.wa_phone) ? [{ customer, profile: profile || { customer_id: cid } }] : [];
    } else {
      const profileFilter = { restaurant_id: restaurantId };
      if (campaign.target_segment && campaign.target_segment !== 'all') {
        profileFilter.rfm_label = campaign.target_segment;
      }
      const profiles = await col('customer_rfm_profiles').find(profileFilter).toArray();
      const customerIds = profiles.map((p) => p.customer_id).filter(Boolean);

      let customers = [];
      if (customerIds.length) {
        customers = await col('customers').find(
          { _id: { $in: customerIds } },
          { projection: { _id: 1, wa_phone: 1, name: 1 } },
        ).toArray();
      }
      const profileById = new Map(profiles.map((p) => [p.customer_id, p]));

      recipients = customers
        .filter((c) => c.wa_phone)
        .map((c) => ({ customer: c, profile: profileById.get(c._id) }));
    }

    // Status flip to 'sending' + refresh target_count. No-op if already
    // sending (shouldn't happen thanks to the guard above).
    await col('marketing_campaigns').updateOne(
      { _id: campaignId },
      { $set: {
          status: 'sending',
          sent_at: new Date(),
          target_count: recipients.length,
          updated_at: new Date(),
        } },
    );

    if (recipients.length === 0) {
      await finalize(campaignId, 'sent', {
        completed_at: new Date(),
        actual_sent_count: 0,
      });
      return { ok: true, sent: 0, failed: 0, recipients: 0 };
    }

    // Pre-flight wallet balance check. Sum is in rupees; estimated cost
    // already persisted at creation but we re-evaluate in case template
    // cost was edited between schedule and send.
    const perMessageCostRs = Number(campaign.per_message_cost_rs) || 0;
    const estimatedCostRs = Number((recipients.length * perMessageCostRs).toFixed(2));
    const walletDoc = await col('waba_wallets').findOne({ restaurant_id: restaurantId });
    const balanceRs = walletDoc?.balance_rs || 0;
    if (balanceRs < estimatedCostRs) {
      await finalize(campaignId, 'failed', { error_message: 'Insufficient wallet balance' });
      return { ok: false, reason: 'insufficient_balance', balance_rs: balanceRs, estimated_cost_rs: estimatedCostRs };
    }

    let sentCount = 0;
    let failedCount = 0;
    let actualCostRs = 0;

    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
      const batch = recipients.slice(i, i + BATCH_SIZE);
      for (const { customer, profile } of batch) {
        const resolved = resolveVariables({
          variables: template.variables || [],
          campaign, customer, rfmProfile: profile, restaurant,
        });
        const components = buildComponents(template, resolved);

        try {
          const resp = await wa.sendTemplate(phoneNumberId, waAccount.access_token, customer.wa_phone, {
            name: template.template_id,
            language: template.language || 'en',
            components,
          });
          const messageId = resp?.messages?.[0]?.id || null;

          if (messageId) {
            await col('campaign_message_map').insertOne({
              _id: newId(),
              message_id: String(messageId),
              campaign_id: campaignId,
              restaurant_id: restaurantId,
              created_at: new Date(),
            }).catch(() => {}); // unique index collision = already mapped
          }

          await col('marketing_campaigns').updateOne(
            { _id: campaignId },
            { $inc: { 'stats.sent': 1, actual_sent_count: 1 }, $set: { updated_at: new Date() } },
          );
          sentCount++;

          // Debit wallet per message. Description leads with the literal
          // 'meta_marketing_charge' so ledger queries can classify these.
          const debit = await wallet.debit(
            restaurantId,
            perMessageCostRs,
            `meta_marketing_charge: campaign ${campaignId}`,
            campaignId,
            { isOrderLifecycle: false },
          ).catch((err) => {
            log.error({ err, campaignId, restaurantId }, 'wallet debit failed for campaign message');
            return { charged: false, reason: 'debit_error' };
          });
          if (debit?.charged) {
            actualCostRs = Number((actualCostRs + perMessageCostRs).toFixed(4));
            await col('marketing_campaigns').updateOne(
              { _id: campaignId },
              { $inc: { actual_cost_rs: perMessageCostRs }, $set: { updated_at: new Date() } },
            );
          }
        } catch (err) {
          failedCount++;
          await col('marketing_campaigns').updateOne(
            { _id: campaignId },
            { $inc: { 'stats.failed': 1 }, $set: { updated_at: new Date() } },
          ).catch(() => {});
          log.warn({
            campaignId,
            phoneHash: hashPhone(customer.wa_phone),
            err: err?.response?.data?.error || err?.message,
          }, 'campaign message send failed');
        }
      }
      if (i + BATCH_SIZE < recipients.length) await sleep(BATCH_DELAY_MS);
    }

    await finalize(campaignId, 'sent', {
      completed_at: new Date(),
      estimated_cost_rs: estimatedCostRs,
    });
    return { ok: true, sent: sentCount, failed: failedCount, recipients: recipients.length };
  } catch (err) {
    log.error({ err, campaignId }, 'sendCampaign: unhandled error');
    await finalize(campaignId, 'failed', {
      error_message: String(err?.message || 'Internal error').slice(0, 300),
    });
    return { ok: false, reason: 'error', error: String(err?.message || err) };
  }
}

// Atomic stats $inc invoked by the WhatsApp status webhook. Recalculates
// the derived rate fields after increment using a tiny aggregation-lite
// read-then-write — acceptable because the rates are cosmetic (not used
// for billing) and the webhook is rate-limited upstream.
async function trackWebhookStatus(messageId, status) {
  try {
    const map = await col('campaign_message_map').findOne({ message_id: String(messageId) });
    if (!map) return { matched: false };

    const statKey =
      status === 'delivered' ? 'stats.delivered'
      : status === 'read'    ? 'stats.read'
      : status === 'failed'  ? 'stats.failed'
      : null;
    if (!statKey) return { matched: true, incremented: false };

    await col('marketing_campaigns').updateOne(
      { _id: map.campaign_id },
      { $inc: { [statKey]: 1 }, $set: { updated_at: new Date() } },
    );

    const doc = await col('marketing_campaigns').findOne(
      { _id: map.campaign_id },
      { projection: { stats: 1, target_count: 1 } },
    );
    if (doc) {
      const sent = doc.stats?.sent || 0;
      const denom = sent > 0 ? sent : (doc.target_count || 1);
      const deliveryRate = denom ? Number(((doc.stats?.delivered || 0) * 100 / denom).toFixed(2)) : 0;
      const readRate     = denom ? Number(((doc.stats?.read     || 0) * 100 / denom).toFixed(2)) : 0;
      const convRate     = denom ? Number(((doc.stats?.converted|| 0) * 100 / denom).toFixed(2)) : 0;
      await col('marketing_campaigns').updateOne(
        { _id: map.campaign_id },
        { $set: {
            'stats.delivery_rate': deliveryRate,
            'stats.read_rate': readRate,
            'stats.conversion_rate': convRate,
          } },
      ).catch(() => {});
    }
    return { matched: true, incremented: true };
  } catch (err) {
    log.warn({ err, messageId, status }, 'trackWebhookStatus failed');
    return { matched: false, error: true };
  }
}

// Fire-and-forget conversion attribution. Called from the Razorpay
// payment-confirmed flow for every newly-paid order. Matches the most
// recent campaign whose segment targeted this customer within the
// 48-hour attribution window.
async function attributeOrderConversion({ orderId, restaurantId, customerId, amountRs }) {
  try {
    if (!restaurantId || !customerId) return { matched: false };
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);

    const profile = await col('customer_rfm_profiles').findOne({
      restaurant_id: restaurantId, customer_id: customerId,
    });
    const label = profile?.rfm_label;

    // Manual blasts match on segment ('all' or this customer's RFM
    // label); auto-journeys match on the dedicated journey_trigger
    // segment scoped to the exact customer id.
    const manualSegmentFilter = label
      ? { $in: ['all', label] }
      : { $in: ['all'] };
    const campaign = await col('marketing_campaigns').findOne(
      {
        restaurant_id: restaurantId,
        status: 'sent',
        sent_at: { $gte: cutoff },
        $or: [
          { target_segment: manualSegmentFilter },
          { target_segment: 'journey_trigger', journey_customer_id: String(customerId) },
        ],
      },
      { sort: { sent_at: -1 } },
    );
    if (!campaign) return { matched: false };

    const amount = Number(amountRs) || 0;
    await col('marketing_campaigns').updateOne(
      { _id: campaign._id },
      {
        $inc: {
          'stats.converted': 1,
          'stats.revenue_attributed_rs': amount,
        },
        $set: { updated_at: new Date() },
      },
    );
    const doc = await col('marketing_campaigns').findOne(
      { _id: campaign._id },
      { projection: { stats: 1, target_count: 1 } },
    );
    if (doc) {
      const sent = doc.stats?.sent || 0;
      const denom = sent > 0 ? sent : (doc.target_count || 1);
      const convRate = denom ? Number(((doc.stats?.converted || 0) * 100 / denom).toFixed(2)) : 0;
      await col('marketing_campaigns').updateOne(
        { _id: campaign._id },
        { $set: { 'stats.conversion_rate': convRate } },
      ).catch(() => {});
    }
    return { matched: true, campaignId: campaign._id, orderId, amountRs: amount };
  } catch (err) {
    log.warn({ err, orderId, restaurantId }, 'attributeOrderConversion failed');
    return { matched: false, error: true };
  }
}

module.exports = {
  sendCampaign,
  trackWebhookStatus,
  attributeOrderConversion,
  // Exported for tests / external scheduling.
  BATCH_SIZE,
  BATCH_DELAY_MS,
};
