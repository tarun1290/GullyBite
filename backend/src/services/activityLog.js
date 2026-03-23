// src/services/activityLog.js
// Platform-wide activity logging — fire-and-forget, never blocks calling code.
// Collection: activity_logs
//   { _id, actor_type, actor_id, actor_name, action, category, description,
//     restaurant_id, branch_id, resource_type, resource_id, metadata,
//     severity, created_at }
//
// TTL: 90 days (set via MongoDB TTL index on created_at)

'use strict';

const { col, newId } = require('../config/database');

/**
 * Log a platform activity. Fire-and-forget — NEVER await this in calling code.
 *
 * @param {Object} opts
 * @param {"system"|"admin"|"restaurant"|"customer"|"webhook"} opts.actorType
 * @param {string} [opts.actorId]
 * @param {string} [opts.actorName]
 * @param {string} opts.action          - e.g. "order.created", "menu.item_added"
 * @param {string} opts.category        - e.g. "order", "menu", "catalog", "payment"
 * @param {string} opts.description     - human-readable summary
 * @param {string} [opts.restaurantId]
 * @param {string} [opts.branchId]
 * @param {string} [opts.resourceType]  - "order", "menu_item", "restaurant", etc.
 * @param {string} [opts.resourceId]
 * @param {Object} [opts.metadata]      - extra context (old/new values, error details)
 * @param {"info"|"warning"|"error"|"critical"} [opts.severity="info"]
 */
function logActivity(opts) {
  try {
    const doc = {
      _id: newId(),
      actor_type: opts.actorType || 'system',
      actor_id: opts.actorId || null,
      actor_name: opts.actorName || null,
      action: opts.action,
      category: opts.category || 'general',
      description: opts.description || '',
      restaurant_id: opts.restaurantId || null,
      branch_id: opts.branchId || null,
      resource_type: opts.resourceType || null,
      resource_id: opts.resourceId || null,
      metadata: opts.metadata || null,
      severity: opts.severity || 'info',
      created_at: new Date(),
    };

    // Fire-and-forget insert — never block, never throw
    col('activity_logs').insertOne(doc).catch(() => {});
  } catch (_) {
    // Silently swallow any error — logging must never break the caller
  }
}

/**
 * Query activity logs with filters and pagination.
 */
async function getActivities(filters = {}, { page = 1, limit = 50 } = {}) {
  const match = {};
  if (filters.restaurantId)  match.restaurant_id = filters.restaurantId;
  if (filters.category)      match.category = filters.category;
  if (filters.action)        match.action = filters.action;
  if (filters.severity)      match.severity = filters.severity;
  if (filters.actorType)     match.actor_type = filters.actorType;
  if (filters.from || filters.to) {
    match.created_at = {};
    if (filters.from) match.created_at.$gte = new Date(filters.from);
    if (filters.to)   match.created_at.$lte = new Date(filters.to);
  }
  if (filters.search) {
    match.description = { $regex: filters.search, $options: 'i' };
  }

  const skip = (page - 1) * limit;
  const [docs, total] = await Promise.all([
    col('activity_logs').find(match).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
    col('activity_logs').countDocuments(match),
  ]);

  return { activities: docs, total, page, limit, pages: Math.ceil(total / limit) };
}

/**
 * Get aggregated activity stats.
 */
async function getActivityStats() {
  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(now); weekStart.setDate(weekStart.getDate() - 7);
  const monthStart = new Date(now); monthStart.setDate(weekStart.getDate() - 30);

  const [todayCount, weekCount, monthCount, byCategory, bySeverity, topRestaurants] = await Promise.all([
    col('activity_logs').countDocuments({ created_at: { $gte: todayStart } }),
    col('activity_logs').countDocuments({ created_at: { $gte: weekStart } }),
    col('activity_logs').countDocuments({ created_at: { $gte: monthStart } }),
    col('activity_logs').aggregate([
      { $match: { created_at: { $gte: weekStart } } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray(),
    col('activity_logs').aggregate([
      { $match: { created_at: { $gte: weekStart } } },
      { $group: { _id: '$severity', count: { $sum: 1 } } },
    ]).toArray(),
    col('activity_logs').aggregate([
      { $match: { created_at: { $gte: weekStart }, restaurant_id: { $ne: null } } },
      { $group: { _id: '$restaurant_id', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]).toArray(),
  ]);

  const sevMap = Object.fromEntries(bySeverity.map(s => [s._id, s.count]));
  const totalWeek = weekCount || 1;
  const errorRate = ((sevMap.error || 0) + (sevMap.critical || 0)) / totalWeek;

  // Resolve restaurant names
  const restIds = topRestaurants.map(r => r._id).filter(Boolean);
  const restaurants = restIds.length
    ? await col('restaurants').find({ _id: { $in: restIds } }, { projection: { business_name: 1 } }).toArray()
    : [];
  const restMap = Object.fromEntries(restaurants.map(r => [String(r._id), r.business_name]));

  return {
    today: todayCount,
    week: weekCount,
    month: monthCount,
    by_category: byCategory.map(c => ({ category: c._id, count: c.count })),
    by_severity: bySeverity.map(s => ({ severity: s._id, count: s.count })),
    top_restaurants: topRestaurants.map(r => ({
      restaurant_id: r._id,
      name: restMap[r._id] || r._id,
      count: r.count,
    })),
    error_rate: parseFloat((errorRate * 100).toFixed(2)),
  };
}

/**
 * Get recent errors and critical events.
 */
async function getErrors({ page = 1, limit = 50 } = {}) {
  const skip = (page - 1) * limit;
  const match = { severity: { $in: ['error', 'critical'] } };
  const [docs, total] = await Promise.all([
    col('activity_logs').find(match).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
    col('activity_logs').countDocuments(match),
  ]);
  return { errors: docs, total, page, limit };
}

module.exports = {
  logActivity,
  getActivities,
  getActivityStats,
  getErrors,
};
