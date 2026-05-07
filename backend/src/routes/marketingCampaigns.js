'use strict';

// Manual-blast campaign routes. Mounted at
//   /api/restaurant/marketing-campaigns
// and is intentionally a DIFFERENT URL namespace from the legacy
// /api/restaurant/campaigns (which drives MPM catalog promos via
// routes/restaurant.js). Both systems coexist — legacy = catalog,
// marketing_campaigns = template-based blasts.

const express = require('express');
const { col, newId } = require('../config/database');
const log = require('../utils/logger');
const { requireAuth } = require('./auth');
const marketingCampaigns = require('../services/marketingCampaigns');
const { JOURNEY_TYPES } = require('../services/journeyExecutor');

const router = express.Router();
router.use(requireAuth);

const TERMINAL_STATUSES = new Set(['sent', 'failed', 'cancelled']);

function projectCampaign(doc) {
  if (!doc) return null;
  return {
    id: doc._id,
    restaurant_id: doc.restaurant_id,
    template_id: doc.template_id,
    display_name: doc.display_name,
    use_case: doc.use_case,
    status: doc.status,
    target_segment: doc.target_segment,
    target_count: doc.target_count || 0,
    actual_sent_count: doc.actual_sent_count || 0,
    send_at: doc.send_at || null,
    sent_at: doc.sent_at || null,
    completed_at: doc.completed_at || null,
    variable_values: doc.variable_values || {},
    stats: doc.stats || {},
    estimated_cost_rs: Number(doc.estimated_cost_rs) || 0,
    actual_cost_rs: Number(doc.actual_cost_rs) || 0,
    per_message_cost_rs: Number(doc.per_message_cost_rs) || 0,
    error_message: doc.error_message || null,
    created_at: doc.created_at,
    updated_at: doc.updated_at || null,
  };
}

// POST /api/restaurant/marketing-campaigns/create
// Body: { template_id, display_name, target_segment, variable_values, send_at? }
router.post('/create', async (req, res) => {
  const restaurantId = req.restaurantId;
  const { template_id, display_name, target_segment, variable_values, send_at } = req.body || {};

  if (!template_id || !display_name || !target_segment) {
    return res.status(400).json({ error: 'template_id, display_name, target_segment are required' });
  }

  const template = await col('campaign_templates').findOne({
    template_id: String(template_id),
    is_active: true,
    meta_approval_status: 'approved',
  });
  if (!template) return res.status(400).json({ error: 'Template not found, inactive, or not approved' });

  const vars = variable_values && typeof variable_values === 'object' ? variable_values : {};
  const missing = (template.variables || [])
    .filter((v) => v.source === 'restaurant_input' && v.required && !(vars[v.name] && String(vars[v.name]).trim()))
    .map((v) => v.name);
  if (missing.length) {
    return res.status(400).json({ error: `Missing required variables: ${missing.join(', ')}` });
  }

  let sendAtDate = null;
  if (send_at) {
    sendAtDate = new Date(send_at);
    if (isNaN(sendAtDate.getTime())) return res.status(400).json({ error: 'send_at is not a valid date' });
    if (sendAtDate.getTime() <= Date.now()) return res.status(400).json({ error: 'send_at must be in the future' });
  }

  // Recipient count for cost estimation. captain_acquired_90d is the
  // one segment that does NOT key off customer_rfm_profiles — it joins
  // referrals (for restaurant scoping) → customers (for the date filter).
  // Mirrors the equivalent branch in services/marketingCampaigns.sendCampaign
  // so the operator's pre-confirm estimate matches the actual dispatch.
  let targetCount = 0;
  if (target_segment === 'captain_acquired_90d') {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const restaurantReferrals = await col('referrals').find(
      { restaurant_id: restaurantId, source: 'gbref' },
      { projection: { _id: 1 } },
    ).toArray();
    const referralIds = restaurantReferrals.map((r) => r._id);
    if (referralIds.length) {
      targetCount = await col('customers').countDocuments({
        captain_referral_id: { $in: referralIds },
        captain_acquired_at: { $gte: ninetyDaysAgo },
        wa_phone: { $exists: true, $ne: null },
      });
    }
  } else {
    const recipFilter = { restaurant_id: restaurantId };
    if (target_segment !== 'all') recipFilter.rfm_label = target_segment;
    const profiles = await col('customer_rfm_profiles').find(recipFilter, { projection: { customer_id: 1 } }).toArray();
    const customerIds = profiles.map((p) => p.customer_id).filter(Boolean);
    if (customerIds.length) {
      targetCount = await col('customers').countDocuments({ _id: { $in: customerIds }, wa_phone: { $exists: true, $ne: null } });
    }
  }

  const perMessageCostRs = Number(template.per_message_cost_rs) || 0;
  const estimatedCostRs = Number((targetCount * perMessageCostRs).toFixed(2));

  // Wallet balance pre-check.
  const walletDoc = await col('waba_wallets').findOne({ restaurant_id: restaurantId });
  const balanceRs = walletDoc?.balance_rs || 0;
  if (balanceRs < estimatedCostRs) {
    return res.status(400).json({
      error: 'Insufficient wallet balance',
      balance_rs: balanceRs,
      estimated_cost_rs: estimatedCostRs,
    });
  }

  const now = new Date();
  // Two-step create→confirm flow. /create always lands a 'draft' that
  // does NOT dispatch; the operator must POST /:campaignId/confirm
  // within 24h to actually trigger send (or schedule). Drafts that
  // miss the confirmation window get cancelled by the auto-expiry
  // scanner in jobs/autoJourneyRunner.js. send_at is captured here as
  // intent — the confirm route reads it to decide between immediate
  // send and scheduled send.
  const CONFIRMATION_WINDOW_MS = 24 * 60 * 60 * 1000;
  const doc = {
    _id: newId(),
    restaurant_id: restaurantId,
    template_id: template.template_id,
    display_name: String(display_name).trim(),
    use_case: template.use_case,
    status: 'draft',
    target_segment: String(target_segment),
    target_count: targetCount,
    actual_sent_count: 0,
    send_at: sendAtDate,
    sent_at: null,
    completed_at: null,
    variable_values: vars,
    stats: {
      sent: 0, delivered: 0, read: 0, failed: 0,
      replied: 0, converted: 0, revenue_attributed_rs: 0,
      delivery_rate: 0, read_rate: 0, conversion_rate: 0,
    },
    estimated_cost_rs: estimatedCostRs,
    actual_cost_rs: 0,
    per_message_cost_rs: perMessageCostRs,
    confirmed_before: new Date(now.getTime() + CONFIRMATION_WINDOW_MS),
    created_at: now,
    updated_at: now,
  };
  await col('marketing_campaigns').insertOne(doc);

  return res.status(201).json({
    campaignId: doc._id,
    estimate: {
      recipient_count: targetCount,
      cost_per_message_rs: perMessageCostRs,
      total_cost_rs: estimatedCostRs,
      wallet_balance_rs: balanceRs,
      wallet_sufficient: balanceRs >= estimatedCostRs,
    },
  });
});

// POST /api/restaurant/marketing-campaigns/:campaignId/confirm
// Step 2 of the two-step create→confirm flow. Loads the draft, checks
// the 24h confirmation window, and either:
//   • flips to 'scheduled' when send_at is in the future (the
//     scanScheduledCampaigns sweep in jobs/autoJourneyRunner.js will
//     pick it up at send_at), or
//   • fires sendCampaign now for an immediate dispatch.
//
// Idempotency: status guard at the top — a second /confirm on the
// same campaign sees status !== 'draft' and returns 409. Belt-and-
// suspenders for double-clicks; sendCampaign also enforces its own
// guard against re-entry.
router.post('/:campaignId/confirm', async (req, res) => {
  const restaurantId = req.restaurantId;
  const campaign = await col('marketing_campaigns').findOne({
    _id: req.params.campaignId,
    restaurant_id: restaurantId,
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  if (campaign.status !== 'draft') {
    return res.status(409).json({ error: 'campaign_not_in_draft', status: campaign.status });
  }
  if (campaign.confirmed_before && new Date(campaign.confirmed_before) < new Date()) {
    return res.status(410).json({ error: 'campaign_confirmation_expired' });
  }

  const now = new Date();
  const sendAt = campaign.send_at ? new Date(campaign.send_at) : null;
  if (sendAt && sendAt > now) {
    // Schedule for future — the scanScheduledCampaigns sweep dispatches.
    // confirmed_before cleared so the expired-drafts scanner ignores
    // this row from now on (status === 'scheduled' would already gate it
    // out, but clearing the field keeps the doc shape clean).
    await col('marketing_campaigns').updateOne(
      { _id: campaign._id },
      { $set: { status: 'scheduled', updated_at: now }, $unset: { confirmed_before: '' } },
    );
    return res.status(200).json({ status: 'scheduled', send_at: sendAt });
  }

  // Immediate dispatch. Fire-and-forget — sendCampaign flips status to
  // 'sending' on entry and runs to terminal 'sent'/'failed'. Its own
  // guard at services/marketingCampaigns.js prevents re-entry on a
  // duplicate /confirm racing this one.
  marketingCampaigns.sendCampaign(campaign._id).catch((err) => {
    log.error({ err, campaignId: campaign._id }, 'sendCampaign failed in background');
  });
  return res.status(202).json({ status: 'sending' });
});

// POST /api/restaurant/marketing-campaigns/:campaignId/cancel
router.post('/:campaignId/cancel', async (req, res) => {
  const restaurantId = req.restaurantId;
  const result = await col('marketing_campaigns').findOneAndUpdate(
    { _id: req.params.campaignId, restaurant_id: restaurantId, status: { $in: ['draft', 'scheduled'] } },
    { $set: { status: 'cancelled', updated_at: new Date() } },
    { returnDocument: 'after' },
  );
  if (!result) {
    return res.status(404).json({ error: 'Campaign not found or not cancellable' });
  }
  res.json(projectCampaign(result));
});

// GET /api/restaurant/marketing-campaigns/journey-estimate?journey_type=...
// Cost + audience preview for the auto-journey settings UI. The audience
// queries mirror jobs/autoJourneyRunner.js exactly so the number shown
// to the operator matches what the next hourly tick would actually
// dispatch to. Event-driven journeys (welcome / milestone / cart_recovery)
// have no time-window cohort to count — they fire from webhooks /
// orderStateEngine — so audience is 0 with a `note: 'event-driven'`.
//
// Registered before GET '/' so the literal /journey-estimate path
// matches before the list route's pagination handler.
router.get('/journey-estimate', async (req, res) => {
  const restaurantId = req.restaurantId;
  const journeyType = String(req.query.journey_type || '').trim();

  if (!JOURNEY_TYPES.includes(journeyType)) {
    return res.status(400).json({ error: 'invalid journey_type', allowed: JOURNEY_TYPES });
  }

  // Per-restaurant journey config — drives the loyalty_expiry window
  // and the journey_enabled flag in the response.
  const cfg = (await col('auto_journey_config').findOne({ restaurant_id: restaurantId })) || {};

  // Approved template for the cost-per-message lookup. Absent template
  // means the audience would never get a send anyway — return 0 cost
  // and let the frontend surface the missing-template state.
  const template = await col('campaign_templates').findOne({
    use_case: journeyType,
    is_active: true,
    meta_approval_status: 'approved',
  });
  const costPerMessageRs = Number(template?.per_message_cost_rs) || 0;

  // Audience estimate. Window patterns match runWindowJourney /
  // runBirthday / loyalty_expiry paths in jobs/autoJourneyRunner.js
  // and the loyaltyEngine.findCustomersWithExpiringPoints filter.
  const EVENT_DRIVEN = new Set(['welcome', 'milestone', 'cart_recovery']);
  let estimatedAudience = 0;
  let note = null;

  if (EVENT_DRIVEN.has(journeyType)) {
    note = 'event-driven';
  } else if (journeyType === 'winback_short') {
    estimatedAudience = await col('customer_rfm_profiles').countDocuments({
      restaurant_id: restaurantId,
      days_since_last_order: { $gt: 13, $lte: 14 },
    });
  } else if (journeyType === 'winback_long') {
    estimatedAudience = await col('customer_rfm_profiles').countDocuments({
      restaurant_id: restaurantId,
      days_since_last_order: { $gt: 29, $lte: 30 },
    });
  } else if (journeyType === 'reorder_suggestion') {
    estimatedAudience = await col('customer_rfm_profiles').countDocuments({
      restaurant_id: restaurantId,
      days_since_last_order: { $gt: 6, $lte: 7 },
    });
  } else if (journeyType === 'birthday') {
    // Today's DD/MM in IST — mirrors autoJourneyRunner.js:istDayMonth.
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: '2-digit',
    });
    const parts = fmt.formatToParts(new Date());
    const dd = parts.find((p) => p.type === 'day')?.value || '';
    const mm = parts.find((p) => p.type === 'month')?.value || '';
    estimatedAudience = await col('customer_rfm_profiles').countDocuments({
      restaurant_id: restaurantId,
      birthday: `${dd}/${mm}`,
    });
  } else if (journeyType === 'loyalty_expiry') {
    // Mirrors loyaltyEngine.findCustomersWithExpiringPoints: counts
    // loyalty_points rows expiring in the configured window. Default
    // daysBeforeExpiry = 5; per-restaurant config can override.
    const daysBefore = Number(cfg?.loyalty_expiry?.days_before_expiry) || 5;
    const now = new Date();
    const windowEnd = new Date(now.getTime() + daysBefore * 24 * 60 * 60 * 1000);
    estimatedAudience = await col('loyalty_points').countDocuments({
      restaurant_id: restaurantId,
      expires_at: { $gt: now, $lte: windowEnd },
    });
  }

  // Wallet balance — same source the actual journey send checks against
  // before debiting (services/journeyExecutor.js:wallet pre-check).
  const wallet = await col('waba_wallets').findOne({ restaurant_id: restaurantId });
  const walletBalanceRs = Number(wallet?.balance_rs) || 0;
  const estimatedCostRs = Number((estimatedAudience * costPerMessageRs).toFixed(2));

  return res.json({
    journey_type: journeyType,
    estimated_audience: estimatedAudience,
    cost_per_message_rs: costPerMessageRs,
    estimated_cost_rs: estimatedCostRs,
    wallet_balance_rs: walletBalanceRs,
    wallet_sufficient: walletBalanceRs >= estimatedCostRs,
    journey_enabled: cfg?.[journeyType]?.enabled ?? false,
    ...(note && { note }),
  });
});

// GET /api/restaurant/marketing-campaigns?page=&limit=&status=
router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const filter = { restaurant_id: req.restaurantId };
  if (req.query.status) filter.status = String(req.query.status);

  const [rows, total] = await Promise.all([
    col('marketing_campaigns').find(filter)
      .sort({ created_at: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    col('marketing_campaigns').countDocuments(filter),
  ]);

  res.json({
    campaigns: rows.map(projectCampaign),
    page, limit, total, pages: Math.ceil(total / limit),
  });
});

// GET /api/restaurant/marketing-campaigns/stats/summary
// Registered BEFORE /:campaignId so the literal path wins.
router.get('/stats/summary', async (req, res) => {
  const restaurantId = req.restaurantId;
  const rows = await col('marketing_campaigns').find(
    { restaurant_id: restaurantId },
    { projection: { status: 1, stats: 1, actual_cost_rs: 1, created_at: 1 } },
  ).toArray();

  const startOfMonth = new Date();
  startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);

  let total_sent = 0, total_delivered = 0;
  let read_rate_sum = 0, conv_rate_sum = 0, rate_n = 0;
  let total_revenue = 0, total_cost = 0;
  let campaigns_this_month = 0;

  for (const r of rows) {
    const s = r.stats || {};
    total_sent += s.sent || 0;
    total_delivered += s.delivered || 0;
    total_revenue += s.revenue_attributed_rs || 0;
    total_cost += Number(r.actual_cost_rs) || 0;
    if (r.status === 'sent') {
      read_rate_sum += s.read_rate || 0;
      conv_rate_sum += s.conversion_rate || 0;
      rate_n++;
    }
    if (r.created_at && new Date(r.created_at) >= startOfMonth) campaigns_this_month++;
  }

  res.json({
    total_campaigns: rows.length,
    total_sent,
    total_delivered,
    average_read_rate: rate_n ? Number((read_rate_sum / rate_n).toFixed(2)) : 0,
    average_conversion_rate: rate_n ? Number((conv_rate_sum / rate_n).toFixed(2)) : 0,
    total_revenue_attributed_rs: Number(total_revenue.toFixed(2)),
    total_cost_rs: Number(total_cost.toFixed(2)),
    campaigns_this_month,
  });
});

// GET /api/restaurant/marketing-campaigns/:campaignId
router.get('/:campaignId', async (req, res) => {
  const doc = await col('marketing_campaigns').findOne({
    _id: req.params.campaignId,
    restaurant_id: req.restaurantId,
  });
  if (!doc) return res.status(404).json({ error: 'Campaign not found' });
  res.json(projectCampaign(doc));
});

// Signal that terminal-status rows shouldn't be mutated by accident
// from other routes — used only for the admin summary shape below.
router.TERMINAL_STATUSES = TERMINAL_STATUSES;

module.exports = router;
