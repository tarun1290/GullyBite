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
// Per-customer monthly send cap for manual blasts. Window is the
// current calendar month in IST (resets at midnight on the 1st). Auto
// journeys are gated separately by the 48h cap inside journeyExecutor —
// this cap covers operator-initiated blasts only and is bypassed when
// target_segment === 'journey_trigger'.
const MONTHLY_BLAST_CAP = 4;

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
    // WABA quality gate. RED rating means Meta has flagged the number
    // for excessive block/report signals; another mass blast through it
    // could push the number to suspension. Abort the whole campaign and
    // tag the failure so the dashboard can surface the reason.
    if (restaurant.marketing_wa_quality_rating === 'RED') {
      await finalize(campaignId, 'failed', { error_message: 'WABA quality rating red' });
      return { ok: false, reason: 'waba_quality_red' };
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

    // Build recipient list. Three paths:
    //   1. 'journey_trigger' — auto-journey single-customer dispatch.
    //      Targets exactly one customer via campaign.journey_customer_id;
    //      RFM profile is optional (welcome may fire before nightly RFM
    //      rebuild has materialised a profile for a brand-new customer).
    //   2. 'captain_acquired_90d' — GBREF (City Captain) acquisition cohort:
    //      customers stamped with captain_acquired_at in the last 90 days
    //      whose converting referral belongs to THIS restaurant. customers
    //      is global identity (no restaurant_id), so scope via referrals
    //      → customers join on captain_referral_id. Avoids the orders-join
    //      over-include where a customer captain-acquired by restaurant A
    //      who later ordered at B would otherwise show up in B's segment.
    //   3. Manual blast — 'all' or an RFM label joins profiles→customers.
    let recipients;
    if (campaign.target_segment === 'journey_trigger' && campaign.journey_customer_id) {
      const cid = String(campaign.journey_customer_id);
      const [customer, profile] = await Promise.all([
        col('customers').findOne({ _id: cid }, { projection: { _id: 1, wa_phone: 1, name: 1 } }),
        col('customer_rfm_profiles').findOne({ restaurant_id: restaurantId, customer_id: cid }),
      ]);
      recipients = (customer?.wa_phone) ? [{ customer, profile: profile || { customer_id: cid } }] : [];
    } else if (campaign.target_segment === 'captain_acquired_90d') {
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const restaurantReferrals = await col('referrals').find(
        { restaurant_id: restaurantId, source: 'gbref' },
        { projection: { _id: 1 } },
      ).toArray();
      const referralIds = restaurantReferrals.map((r) => r._id);
      let captainCustomers = [];
      if (referralIds.length) {
        captainCustomers = await col('customers').find(
          {
            captain_referral_id: { $in: referralIds },
            captain_acquired_at: { $gte: ninetyDaysAgo },
            wa_phone: { $exists: true, $ne: null },
          },
          { projection: { _id: 1, wa_phone: 1, name: 1 } },
        ).toArray();
      }
      // RFM profile is best-effort — captain-acquired customers newer
      // than the nightly RFM rebuild may not have one yet (mirrors the
      // journey_trigger branch's profile-optional treatment).
      const profileMap = new Map();
      if (captainCustomers.length) {
        const profs = await col('customer_rfm_profiles').find({
          restaurant_id: restaurantId,
          customer_id: { $in: captainCustomers.map((c) => c._id) },
        }).toArray();
        for (const p of profs) profileMap.set(p.customer_id, p);
      }
      recipients = captainCustomers.map((c) => ({
        customer: c,
        profile: profileMap.get(c._id) || { customer_id: c._id },
      }));
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

    // Pre-load the marketing block-list for this restaurant. One query
    // up front beats per-recipient findOne by orders of magnitude on
    // segment-of-thousands sends. The blocked set is small (tens to
    // low-hundreds typically) so loading the full set into memory is
    // bounded. journey_trigger sends still consult this — a single
    // findOne for one recipient is the same cost as a Set lookup.
    const blockedSet = new Set();
    {
      const blocked = await col('marketing_blocklist').find(
        { restaurant_id: restaurantId },
        { projection: { customer_id: 1 } },
      ).toArray();
      for (const b of blocked) blockedSet.add(String(b.customer_id));
    }

    // Pre-compute per-customer manual-blast send count for the current
    // calendar month (IST). Skipped for journey_trigger campaigns —
    // those are auto-journey single-recipient sends that have their
    // own 48h cap inside journeyExecutor. We aggregate the map once up
    // front so the inner loop is O(1) per recipient instead of N
    // round-trips to Mongo.
    const sendCountByCustomer = new Map();
    if (campaign.target_segment !== 'journey_trigger') {
      const now = new Date();
      // First-of-month at 00:00 IST, expressed as UTC. IST is UTC+5:30,
      // so subtracting 5h30m from IST midnight yields the correct UTC
      // instant (e.g. Mar 1 00:00 IST = Feb 28 18:30 UTC).
      const istShiftMs = 5.5 * 60 * 60 * 1000;
      const istNow = new Date(now.getTime() + istShiftMs);
      const istMonthStartUtc = new Date(
        Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), 1, 0, 0, 0) - istShiftMs,
      );
      const monthCampaignIds = (await col('marketing_campaigns').find(
        {
          restaurant_id: restaurantId,
          status: 'sent',
          sent_at: { $gte: istMonthStartUtc },
        },
        { projection: { _id: 1 } },
      ).toArray()).map((c) => c._id);
      if (monthCampaignIds.length > 0) {
        const sends = await col('campaign_message_map').aggregate([
          { $match: { campaign_id: { $in: monthCampaignIds }, customer_id: { $ne: null } } },
          { $group: { _id: '$customer_id', n: { $sum: 1 } } },
        ]).toArray();
        for (const s of sends) sendCountByCustomer.set(s._id, s.n);
      }
    }

    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
      const batch = recipients.slice(i, i + BATCH_SIZE);
      for (const { customer, profile } of batch) {
        // Marketing block-list — STOP / UNSUBSCRIBE recipients. Hard
        // line ahead of the cap check: blocked customers never receive
        // any manual blast regardless of frequency window.
        if (blockedSet.has(String(customer._id))) {
          await col('marketing_campaigns').updateOne(
            { _id: campaignId },
            { $inc: { 'stats.skipped': 1 }, $set: { updated_at: new Date() } },
          ).catch(() => {});
          log.debug({ restaurantId, customerId: customer._id }, 'customer blocked');
          continue;
        }
        // Per-customer monthly cap. Cumulative across all manual blasts
        // this calendar month (IST). journey_trigger sends bypass this
        // — skip-list was empty in that branch so the count is 0.
        const priorCount = sendCountByCustomer.get(customer._id) || 0;
        if (priorCount >= MONTHLY_BLAST_CAP) {
          await col('marketing_campaigns').updateOne(
            { _id: campaignId },
            { $inc: { 'stats.skipped': 1 }, $set: { updated_at: new Date() } },
          ).catch(() => {});
          log.debug({ restaurantId, customerId: customer._id, priorCount }, 'monthly cap reached customerId');
          continue;
        }
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
              // Stored so the monthly-cap aggregate above can group sends
              // by customer without re-joining via campaign metadata.
              customer_id: customer._id ? String(customer._id) : null,
              created_at: new Date(),
            }).catch(() => {}); // unique index collision = already mapped
          }
          // Bump the in-memory month counter so subsequent recipients in
          // this same campaign run respect the cap without re-querying.
          sendCountByCustomer.set(customer._id, (sendCountByCustomer.get(customer._id) || 0) + 1);

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
