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

  // Recipient count for cost estimation.
  const recipFilter = { restaurant_id: restaurantId };
  if (target_segment !== 'all') recipFilter.rfm_label = target_segment;
  const profiles = await col('customer_rfm_profiles').find(recipFilter, { projection: { customer_id: 1 } }).toArray();
  const customerIds = profiles.map((p) => p.customer_id).filter(Boolean);
  let targetCount = 0;
  if (customerIds.length) {
    targetCount = await col('customers').countDocuments({ _id: { $in: customerIds }, wa_phone: { $exists: true, $ne: null } });
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
  const initialStatus = sendAtDate ? 'scheduled' : 'draft';
  const doc = {
    _id: newId(),
    restaurant_id: restaurantId,
    template_id: template.template_id,
    display_name: String(display_name).trim(),
    use_case: template.use_case,
    status: initialStatus,
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
    created_at: now,
    updated_at: now,
  };
  await col('marketing_campaigns').insertOne(doc);

  if (!sendAtDate) {
    // Fire-and-forget immediate send.
    marketingCampaigns.sendCampaign(doc._id).catch((err) => {
      log.error({ err, campaignId: doc._id }, 'sendCampaign failed in background');
    });
    return res.status(202).json(projectCampaign(doc));
  }
  return res.status(201).json(projectCampaign(doc));
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
