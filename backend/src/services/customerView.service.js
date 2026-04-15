'use strict';

// Phase 6.2: restaurant-scoped customer list.
// Filters customer_metrics by restaurant_stats.restaurant_id, projects
// the matching stats element, and joins customers for name+phone.
//
// Phone is ALWAYS masked here — this endpoint is for the ops dashboard,
// not for privileged admin access. The formatPhone() caller passes
// canSeeFull:false unconditionally.

const { col } = require('../config/database');
const { formatPhone } = require('../utils/maskPhone');

const SORT_FIELDS = {
  orders:     { 'stat.order_count':    -1 },
  last_order: { 'stat.last_order_at':  -1 },
  spent:      { 'stat.total_spent_rs': -1 },
};

async function listCustomers({ restaurantId, sort = 'orders', limit = 50, skip = 0 }) {
  if (!restaurantId) return { items: [], total: 0 };

  const sortSpec = SORT_FIELDS[sort] || SORT_FIELDS.orders;
  const perPage = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const pageSkip = Math.max(Number(skip) || 0, 0);

  const pipeline = [
    { $match: { 'restaurant_stats.restaurant_id': restaurantId } },
    {
      $addFields: {
        stat: {
          $first: {
            $filter: {
              input: '$restaurant_stats',
              as: 's',
              cond: { $eq: ['$$s.restaurant_id', restaurantId] },
            },
          },
        },
      },
    },
    { $sort: sortSpec },
    { $skip: pageSkip },
    { $limit: perPage },
    {
      $lookup: {
        from: 'customers',
        localField: 'customer_id',
        foreignField: '_id',
        as: 'cust',
      },
    },
    {
      $project: {
        _id: 1,
        phone_hash: 1,
        customer_type: 1,
        tags: 1,
        stat: 1,
        cust_name: { $first: '$cust.name' },
        cust_phone: { $first: '$cust.wa_phone' },
      },
    },
  ];

  const [rows, total] = await Promise.all([
    col('customer_metrics').aggregate(pipeline).toArray(),
    col('customer_metrics').countDocuments({ 'restaurant_stats.restaurant_id': restaurantId }),
  ]);

  const items = rows.map(r => ({
    _id: r._id,
    name: r.cust_name || null,
    phone: formatPhone(r.cust_phone, { canSeeFull: false }),
    phone_masked: true,
    order_count: r.stat?.order_count || 0,
    total_spent_rs: r.stat?.total_spent_rs || 0,
    last_order_at: r.stat?.last_order_at || null,
    customer_type: r.customer_type || null,
    tags: r.tags || [],
  }));

  return { items, total };
}

// Phase 6.3: global admin view across all restaurants. No restaurant
// filter is applied to restaurant_stats — the whole array is returned
// as restaurant_breakdown. Phone masking is caller-driven; the route
// must pass `canSeeFull` from `req.canSeeFullPhones` (middleware), not
// from request input.
async function listCustomersGlobal({
  restaurantId = null,
  customerType = null,
  minOrders = null,
  canSeeFull = false,
  limit = 50,
  skip = 0,
  sort = 'orders',
}) {
  const perPage = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const pageSkip = Math.max(Number(skip) || 0, 0);

  const filter = {};
  if (restaurantId) filter['restaurant_stats.restaurant_id'] = restaurantId;
  if (customerType) filter.customer_type = customerType;
  if (minOrders != null && !Number.isNaN(Number(minOrders))) {
    filter.total_orders = { $gte: Number(minOrders) };
  }

  const sortSpec = {
    orders:     { total_orders:   -1 },
    spent:      { total_spent_rs: -1 },
    last_order: { last_order_at:  -1 },
  }[sort] || { total_orders: -1 };

  const pipeline = [
    { $match: filter },
    { $sort: sortSpec },
    { $skip: pageSkip },
    { $limit: perPage },
    {
      $lookup: {
        from: 'customers',
        localField: 'customer_id',
        foreignField: '_id',
        as: 'cust',
      },
    },
    {
      $project: {
        _id: 1,
        phone_hash: 1,
        customer_type: 1,
        tags: 1,
        total_orders: 1,
        total_spent_rs: 1,
        last_order_at: 1,
        restaurant_stats: 1,
        cust_name: { $first: '$cust.name' },
        cust_phone: { $first: '$cust.wa_phone' },
      },
    },
  ];

  const [rows, total] = await Promise.all([
    col('customer_metrics').aggregate(pipeline).toArray(),
    col('customer_metrics').countDocuments(filter),
  ]);

  const items = rows.map(r => ({
    _id: r._id,
    name: r.cust_name || null,
    phone: formatPhone(r.cust_phone, { canSeeFull }),
    phone_masked: !canSeeFull,
    total_orders: r.total_orders || 0,
    total_spent_rs: r.total_spent_rs || 0,
    last_order_at: r.last_order_at || null,
    customer_type: r.customer_type || null,
    tags: r.tags || [],
    restaurant_breakdown: (r.restaurant_stats || []).map(s => ({
      restaurant_id: s.restaurant_id,
      order_count: s.order_count || 0,
      total_spent_rs: s.total_spent_rs || 0,
      last_order_at: s.last_order_at || null,
    })),
  }));

  return { items, total };
}

module.exports = { listCustomers, listCustomersGlobal };
