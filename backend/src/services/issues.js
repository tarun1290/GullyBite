// src/services/issues.js
// Issue management — creation, routing, lifecycle, resolution
'use strict';

const { col, newId } = require('../config/database');
const { logActivity } = require('./activityLog');

// ─── CATEGORY → ROUTING MAP ─────────────────────────────────────────
const ROUTING_MAP = {
  food_quality:           'restaurant',
  missing_item:           'restaurant',
  wrong_order:            'restaurant',
  portion_size:           'restaurant',
  packaging:              'restaurant',
  hygiene:                'restaurant',
  delivery_late:          'admin_delivery',
  delivery_not_received:  'admin_delivery',
  delivery_damaged:       'admin_delivery',
  rider_behavior:         'admin_delivery',
  wrong_address:          'admin_delivery',
  wrong_charge:           'admin_financial',
  refund_request:         'admin_financial',
  payment_failed:         'admin_financial',
  coupon_issue:           'admin_financial',
  general:                'restaurant',
  app_issue:              'admin',
};

const PRIORITY_MAP = {
  payment_failed:         'critical',
  delivery_not_received:  'critical',
  hygiene:                'critical',
  wrong_charge:           'high',
  refund_request:         'high',
  wrong_order:            'high',
  delivery_damaged:       'high',
  missing_item:           'medium',
  delivery_late:          'medium',
  food_quality:           'medium',
  rider_behavior:         'medium',
  portion_size:           'low',
  packaging:              'low',
  general:                'low',
  coupon_issue:           'low',
  app_issue:              'low',
  wrong_address:          'medium',
};

const SLA_HOURS = { critical: 2, high: 6, medium: 24, low: 48 };

const CATEGORY_LABELS = {
  food_quality: '🍕 Food Quality',
  missing_item: '📦 Missing Item',
  wrong_order: '❌ Wrong Order',
  portion_size: '📏 Portion Size',
  packaging: '📦 Packaging',
  hygiene: '🧹 Hygiene',
  delivery_late: '🕐 Late Delivery',
  delivery_not_received: '🚫 Not Received',
  delivery_damaged: '💥 Damaged in Delivery',
  rider_behavior: '🛵 Rider Behaviour',
  wrong_address: '📍 Wrong Address',
  wrong_charge: '💸 Wrong Charge',
  refund_request: '💰 Refund Request',
  payment_failed: '⚠️ Payment Failed',
  coupon_issue: '🏷️ Coupon Issue',
  general: '💬 General',
  app_issue: '📱 App Issue',
};

// ─── ISSUE NUMBER GENERATOR ─────────────────────────────────────────
async function nextIssueNumber() {
  const year = new Date().getFullYear();
  const result = await col('counters').findOneAndUpdate(
    { _id: `issue_${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  const seq = String(result.seq || result.value?.seq || 1).padStart(4, '0');
  return `ISS-${year}-${seq}`;
}

// ─── CREATE ISSUE ───────────────────────────────────────────────────
async function createIssue({
  customerId, customerName, customerPhone,
  orderId, orderNumber,
  restaurantId, branchId,
  category, subcategory,
  description, media = [],
  source = 'whatsapp', // 'whatsapp' | 'dashboard' | 'system'
}) {
  const issueNumber = await nextIssueNumber();
  const priority = PRIORITY_MAP[category] || 'medium';
  const routedTo = ROUTING_MAP[category] || 'restaurant';
  const slaHours = SLA_HOURS[priority];
  const slaDeadline = new Date(Date.now() + slaHours * 60 * 60 * 1000);

  const now = new Date();
  const issue = {
    _id: newId(),
    issue_number: issueNumber,
    customer_id: customerId,
    customer_name: customerName || null,
    customer_phone: customerPhone || null,
    order_id: orderId || null,
    order_number: orderNumber || null,
    restaurant_id: restaurantId,
    branch_id: branchId || null,
    category,
    subcategory: subcategory || null,
    priority,
    routed_to: routedTo,
    description: description || '',
    media: media || [],
    status: 'open',
    assigned_to: null,
    resolution_type: null,
    resolution_notes: null,
    refund_amount_rs: null,
    refund_id: null,
    credit_amount_rs: null,
    messages: [{
      _id: newId(),
      sender_type: 'customer',
      sender_name: customerName || 'Customer',
      text: description || '',
      media: media || [],
      sent_via: source,
      created_at: now,
    }],
    escalated_at: null,
    escalated_by: null,
    escalation_reason: null,
    created_at: now,
    first_response_at: null,
    resolved_at: null,
    closed_at: null,
    updated_at: now,
    sla_deadline: slaDeadline,
  };

  await col('issues').insertOne(issue);

  logActivity({
    actorType: 'customer', actorId: customerId, actorName: customerName,
    action: 'issue.created', category: 'issue',
    description: `Issue ${issueNumber} created: ${category}`,
    restaurantId, branchId,
    resourceType: 'issue', resourceId: issue._id,
    metadata: { issue_number: issueNumber, category, priority, routed_to: routedTo, order_id: orderId },
  });

  return issue;
}

// ─── GET / QUERY ────────────────────────────────────────────────────
async function getIssue(issueId) {
  return col('issues').findOne({ _id: issueId });
}

async function getIssueByNumber(issueNumber) {
  return col('issues').findOne({ issue_number: issueNumber });
}

async function listIssues(filters = {}, { page = 1, limit = 30 } = {}) {
  const match = {};
  if (filters.restaurantId)  match.restaurant_id = filters.restaurantId;
  if (filters.customerId)    match.customer_id = filters.customerId;
  if (filters.orderId)       match.order_id = filters.orderId;
  if (filters.category)      match.category = filters.category;
  if (filters.priority)      match.priority = filters.priority;
  if (filters.routedTo)      match.routed_to = filters.routedTo;

  if (filters.status === 'open_all') {
    match.status = { $in: ['open', 'assigned', 'in_progress', 'waiting_customer', 'reopened'] };
  } else if (filters.status === 'escalated') {
    match.status = 'escalated_to_admin';
  } else if (filters.status === 'sla_breached') {
    match.sla_deadline = { $lt: new Date() };
    match.status = { $nin: ['resolved', 'closed'] };
  } else if (filters.status) {
    match.status = filters.status;
  }

  if (filters.adminQueue) {
    match.routed_to = { $in: ['admin', 'admin_delivery', 'admin_financial'] };
    if (!filters.status) match.status = { $nin: ['resolved', 'closed'] };
  }

  if (filters.search) {
    const re = { $regex: filters.search, $options: 'i' };
    match.$or = [
      { issue_number: re }, { customer_name: re }, { customer_phone: re },
      { order_number: re }, { description: re },
    ];
  }

  const skip = (page - 1) * limit;
  const sort = { priority: -1, created_at: -1 };
  if (filters.sortBy === 'newest') sort.created_at = -1;
  if (filters.sortBy === 'sla') sort.sla_deadline = 1;

  const [docs, total] = await Promise.all([
    col('issues').find(match).sort(sort).skip(skip).limit(limit).toArray(),
    col('issues').countDocuments(match),
  ]);

  return { issues: docs, total, page, limit, pages: Math.ceil(total / limit) };
}

// ─── STATUS TRANSITIONS ────────────────────────────────────────────
async function updateStatus(issueId, newStatus, { actorType, actorName, actorId } = {}) {
  const now = new Date();
  const update = { $set: { status: newStatus, updated_at: now } };

  if (newStatus === 'resolved') update.$set.resolved_at = now;
  if (newStatus === 'closed')   update.$set.closed_at = now;

  const sysMsg = {
    _id: newId(),
    sender_type: 'system',
    sender_name: 'System',
    text: `Status changed to ${newStatus} by ${actorName || actorType || 'system'}`,
    media: [],
    sent_via: 'auto',
    created_at: now,
  };
  update.$push = { messages: sysMsg };

  await col('issues').updateOne({ _id: issueId }, update);

  const issue = await col('issues').findOne({ _id: issueId });
  logActivity({
    actorType: actorType || 'system', actorId, actorName,
    action: 'issue.status_changed', category: 'issue',
    description: `Issue ${issue?.issue_number} → ${newStatus}`,
    restaurantId: issue?.restaurant_id,
    resourceType: 'issue', resourceId: issueId,
    metadata: { new_status: newStatus },
  });

  return issue;
}

// ─── ADD MESSAGE TO THREAD ──────────────────────────────────────────
async function addMessage(issueId, { senderType, senderName, text, media = [], sentVia = 'dashboard', internal = false }) {
  const now = new Date();
  const msg = {
    _id: newId(),
    sender_type: senderType,
    sender_name: senderName || senderType,
    text,
    media,
    sent_via: sentVia,
    internal: !!internal,
    created_at: now,
  };

  const updateOps = { $push: { messages: msg }, $set: { updated_at: now } };

  // Track first response time (first non-system, non-customer message)
  if (senderType !== 'customer' && senderType !== 'system') {
    const issue = await col('issues').findOne({ _id: issueId });
    if (issue && !issue.first_response_at) {
      updateOps.$set.first_response_at = now;
    }
  }

  await col('issues').updateOne({ _id: issueId }, updateOps);
  return msg;
}

// ─── ASSIGN ─────────────────────────────────────────────────────────
async function assignIssue(issueId, assignedTo, { actorType, actorName, actorId } = {}) {
  const now = new Date();
  await col('issues').updateOne({ _id: issueId }, {
    $set: { assigned_to: assignedTo, status: 'assigned', updated_at: now },
    $push: { messages: {
      _id: newId(), sender_type: 'system', sender_name: 'System',
      text: `Assigned to ${assignedTo} by ${actorName || actorType}`,
      media: [], sent_via: 'auto', created_at: now,
    }},
  });
  return col('issues').findOne({ _id: issueId });
}

// ─── ESCALATE TO ADMIN ─────────────────────────────────────────────
async function escalateToAdmin(issueId, { escalatedBy, reason, routeTo = 'admin' }) {
  const now = new Date();
  await col('issues').updateOne({ _id: issueId }, {
    $set: {
      status: 'escalated_to_admin', routed_to: routeTo,
      escalated_at: now, escalated_by: escalatedBy, escalation_reason: reason,
      updated_at: now,
    },
    $push: { messages: {
      _id: newId(), sender_type: 'system', sender_name: 'System',
      text: `Escalated to GullyBite admin. Reason: ${reason}`,
      media: [], sent_via: 'auto', created_at: now,
    }},
  });

  const issue = await col('issues').findOne({ _id: issueId });
  logActivity({
    actorType: 'restaurant', actorId: escalatedBy, actorName: escalatedBy,
    action: 'issue.escalated', category: 'issue',
    description: `Issue ${issue?.issue_number} escalated to admin: ${reason}`,
    restaurantId: issue?.restaurant_id,
    resourceType: 'issue', resourceId: issueId,
    metadata: { reason, routed_to: routeTo },
    severity: 'warning',
  });

  return issue;
}

// ─── RESOLVE ────────────────────────────────────────────────────────
async function resolveIssue(issueId, { resolutionType, resolutionNotes, refundAmountRs, refundId, creditAmountRs, actorType, actorName, actorId }) {
  const now = new Date();
  const sets = {
    status: 'resolved', resolved_at: now, updated_at: now,
    resolution_type: resolutionType || null,
    resolution_notes: resolutionNotes || null,
  };
  if (refundAmountRs != null)  sets.refund_amount_rs = refundAmountRs;
  if (refundId)                sets.refund_id = refundId;
  if (creditAmountRs != null)  sets.credit_amount_rs = creditAmountRs;

  const resolvedByLabel = actorName || actorType || 'system';
  let sysText = `Resolved by ${resolvedByLabel}: ${resolutionType || 'no_action'}`;
  if (resolutionNotes) sysText += ` — ${resolutionNotes}`;
  if (refundAmountRs) sysText += ` | Refund: ₹${refundAmountRs}`;

  await col('issues').updateOne({ _id: issueId }, {
    $set: sets,
    $push: { messages: {
      _id: newId(), sender_type: 'system', sender_name: 'System',
      text: sysText, media: [], sent_via: 'auto', created_at: now,
    }},
  });

  const issue = await col('issues').findOne({ _id: issueId });
  logActivity({
    actorType: actorType || 'system', actorId, actorName,
    action: 'issue.resolved', category: 'issue',
    description: `Issue ${issue?.issue_number} resolved: ${resolutionType || 'no_action'}`,
    restaurantId: issue?.restaurant_id,
    resourceType: 'issue', resourceId: issueId,
    metadata: { resolution_type: resolutionType, refund_amount_rs: refundAmountRs },
  });

  return issue;
}

// ─── REOPEN ─────────────────────────────────────────────────────────
async function reopenIssue(issueId, { actorType, actorName, actorId, reason }) {
  const now = new Date();
  await col('issues').updateOne({ _id: issueId }, {
    $set: { status: 'reopened', resolved_at: null, closed_at: null, updated_at: now },
    $push: { messages: {
      _id: newId(), sender_type: 'system', sender_name: 'System',
      text: `Reopened by ${actorName || actorType}${reason ? ': ' + reason : ''}`,
      media: [], sent_via: 'auto', created_at: now,
    }},
  });
  return col('issues').findOne({ _id: issueId });
}

// ─── ISSUE STATS ────────────────────────────────────────────────────
async function getIssueStats(filters = {}) {
  const match = {};
  if (filters.restaurantId) match.restaurant_id = filters.restaurantId;
  if (filters.adminQueue) match.routed_to = { $in: ['admin', 'admin_delivery', 'admin_financial'] };

  const now = new Date();
  const [total, open, inProgress, escalated, resolved, slaBreached, byCategory, byPriority] = await Promise.all([
    col('issues').countDocuments(match),
    col('issues').countDocuments({ ...match, status: { $in: ['open', 'assigned', 'reopened'] } }),
    col('issues').countDocuments({ ...match, status: 'in_progress' }),
    col('issues').countDocuments({ ...match, status: 'escalated_to_admin' }),
    col('issues').countDocuments({ ...match, status: { $in: ['resolved', 'closed'] } }),
    col('issues').countDocuments({ ...match, sla_deadline: { $lt: now }, status: { $nin: ['resolved', 'closed'] } }),
    col('issues').aggregate([
      { $match: match },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray(),
    col('issues').aggregate([
      { $match: match },
      { $group: { _id: '$priority', count: { $sum: 1 } } },
    ]).toArray(),
  ]);

  return { total, open, in_progress: inProgress, escalated, resolved, sla_breached: slaBreached, by_category: byCategory, by_priority: byPriority };
}

// ─── REFUND VIA ISSUE (admin only) ─────────────────────────────────
async function processRefund(issueId, { amountRs, actorName, actorId }) {
  const issue = await col('issues').findOne({ _id: issueId });
  if (!issue || !issue.order_id) throw new Error('Issue or order not found');

  // Use existing payment service
  const paymentSvc = require('./payment');
  const refund = await paymentSvc.issueRefund(issue.order_id, `Issue ${issue.issue_number}: refund`);
  if (!refund) throw new Error('No paid payment found for this order');

  // Update issue with refund details
  const refundAmountRs = amountRs || (refund.amount / 100);
  await resolveIssue(issueId, {
    resolutionType: amountRs && amountRs < (refund.amount / 100) ? 'refund_partial' : 'refund_full',
    resolutionNotes: `Razorpay refund processed`,
    refundAmountRs,
    refundId: refund.id,
    actorType: 'admin', actorName, actorId,
  });

  // Flag order for settlement deduction
  await col('orders').updateOne({ _id: issue.order_id }, {
    $set: { refund_amount_rs: refundAmountRs, refund_issue_id: issueId, updated_at: new Date() },
  });

  return { refund, issue: await col('issues').findOne({ _id: issueId }) };
}

module.exports = {
  ROUTING_MAP, PRIORITY_MAP, SLA_HOURS, CATEGORY_LABELS,
  createIssue, getIssue, getIssueByNumber, listIssues,
  updateStatus, addMessage, assignIssue,
  escalateToAdmin, resolveIssue, reopenIssue,
  getIssueStats, processRefund,
};
