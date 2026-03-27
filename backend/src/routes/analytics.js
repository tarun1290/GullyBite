// src/routes/analytics.js
// Admin analytics API — multi-dimensional filtering, aggregation pipelines.
// All endpoints require admin authentication.

'use strict';

const express = require('express');
const router = express.Router();
const { col, mapIds } = require('../config/database');

// Admin auth — same pattern as admin.js
router.use((req, res, next) => {
  const header = req.headers['authorization'] || '';
  const key = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  next();
});

// ─── SHARED FILTER BUILDER ──────────────────────────────────
function buildMatchFilter(query) {
  const match = {};
  if (query.from) match.created_at = { ...(match.created_at || {}), $gte: new Date(query.from) };
  if (query.to) match.created_at = { ...(match.created_at || {}), $lte: new Date(query.to) };
  if (!query.from && !query.to) {
    match.created_at = { $gte: new Date(Date.now() - 30 * 86400000) };
  }
  if (query.restaurant_id) match.restaurant_id = query.restaurant_id;
  if (query.branch_id) match.branch_id = query.branch_id;
  return match;
}

// Lookup branch info for city/area filtering — returns a pipeline prefix
function cityAreaPipeline(query) {
  const stages = [];
  if (query.city || query.area) {
    stages.push({ $lookup: { from: 'branches', localField: 'branch_id', foreignField: '_id', as: '_branch' } });
    stages.push({ $unwind: { path: '$_branch', preserveNullAndEmptyArrays: true } });
    if (query.city) stages.push({ $match: { '_branch.city': { $regex: new RegExp(query.city, 'i') } } });
    if (query.area) stages.push({ $match: { '_branch.area': { $regex: new RegExp(query.area, 'i') } } });
  }
  return stages;
}

function dateGroupExpr(granularity) {
  switch (granularity) {
    case 'hourly': return { $dateToString: { format: '%Y-%m-%dT%H:00', date: '$created_at', timezone: 'Asia/Kolkata' } };
    case 'weekly': return { $dateToString: { format: '%G-W%V', date: '$created_at', timezone: 'Asia/Kolkata' } };
    case 'monthly': return { $dateToString: { format: '%Y-%m', date: '$created_at', timezone: 'Asia/Kolkata' } };
    default: return { $dateToString: { format: '%Y-%m-%d', date: '$created_at', timezone: 'Asia/Kolkata' } };
  }
}

// ─── OVERVIEW KPIs ──────────────────────────────────────────
router.get('/overview', async (req, res) => {
  try {
    const match = buildMatchFilter(req.query);
    const cityArea = cityAreaPipeline(req.query);

    const pipeline = [
      ...cityArea,
      { $match: match },
      { $facet: {
        totals: [{ $group: {
          _id: null,
          order_count: { $sum: 1 },
          gmv: { $sum: { $cond: [{ $eq: ['$status', 'DELIVERED'] }, { $toDouble: '$total_rs' }, 0] } },
          total_rs_sum: { $sum: { $toDouble: '$total_rs' } },
          platform_fees: { $sum: { $toDouble: { $ifNull: ['$platform_fee_rs', 0] } } },
          customers: { $addToSet: '$customer_id' },
          restaurants: { $addToSet: '$restaurant_id' },
          delivered: { $sum: { $cond: [{ $eq: ['$status', 'DELIVERED'] }, 1, 0] } },
        }}],
        newCustomers: [
          { $group: { _id: '$customer_id', first: { $min: '$created_at' } } },
          { $match: { first: match.created_at || {} } },
          { $count: 'count' },
        ],
        repeatCustomers: [
          { $group: { _id: '$customer_id', cnt: { $sum: 1 } } },
          { $match: { cnt: { $gt: 1 } } },
          { $count: 'count' },
        ],
      }},
    ];

    const [result] = await col('orders').aggregate(pipeline).toArray();
    const t = result.totals[0] || { order_count: 0, gmv: 0, total_rs_sum: 0, platform_fees: 0, customers: [], restaurants: [], delivered: 0 };
    const customerCount = t.customers.length;
    const newCustomerCount = result.newCustomers[0]?.count || 0;
    const repeatCount = result.repeatCustomers[0]?.count || 0;

    // Previous period comparison
    const periodMs = (match.created_at?.$lte || new Date()).getTime() - (match.created_at?.$gte || new Date(Date.now() - 30 * 86400000)).getTime();
    const prevMatch = { ...match, created_at: { $gte: new Date((match.created_at?.$gte || new Date(Date.now() - 30 * 86400000)).getTime() - periodMs), $lt: match.created_at?.$gte || new Date(Date.now() - 30 * 86400000) } };
    const [prevResult] = await col('orders').aggregate([
      ...cityArea, { $match: prevMatch },
      { $group: { _id: null, order_count: { $sum: 1 }, gmv: { $sum: { $cond: [{ $eq: ['$status', 'DELIVERED'] }, { $toDouble: '$total_rs' }, 0] } } } },
    ]).toArray();
    const prev = prevResult || { order_count: 0, gmv: 0 };
    const pctChange = (cur, prv) => prv > 0 ? parseFloat(((cur - prv) / prv * 100).toFixed(1)) : cur > 0 ? 100 : 0;

    res.json({
      order_count: t.order_count,
      gmv: parseFloat(t.gmv.toFixed(2)),
      avg_order_value: t.order_count > 0 ? parseFloat((t.gmv / t.delivered || 0).toFixed(2)) : 0,
      customer_count: customerCount,
      new_customers: newCustomerCount,
      repeat_customers: repeatCount,
      repeat_rate: customerCount > 0 ? parseFloat((repeatCount / customerCount * 100).toFixed(1)) : 0,
      active_restaurants: t.restaurants.length,
      avg_orders_per_restaurant: t.restaurants.length > 0 ? parseFloat((t.order_count / t.restaurants.length).toFixed(1)) : 0,
      platform_revenue: parseFloat(t.platform_fees.toFixed(2)),
      completion_rate: t.order_count > 0 ? parseFloat((t.delivered / t.order_count * 100).toFixed(1)) : 0,
      change: {
        order_count: pctChange(t.order_count, prev.order_count),
        gmv: pctChange(t.gmv, prev.gmv),
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ORDER TIMESERIES ───────────────────────────────────────
router.get('/orders/timeseries', async (req, res) => {
  try {
    const match = buildMatchFilter(req.query);
    const granularity = req.query.granularity || 'daily';
    const data = await col('orders').aggregate([
      ...cityAreaPipeline(req.query),
      { $match: match },
      { $group: {
        _id: dateGroupExpr(granularity),
        order_count: { $sum: 1 },
        gmv: { $sum: { $cond: [{ $eq: ['$status', 'DELIVERED'] }, { $toDouble: '$total_rs' }, 0] } },
      }},
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: '$_id', order_count: 1, gmv: { $round: ['$gmv', 2] }, avg_order_value: { $round: [{ $cond: [{ $gt: ['$order_count', 0] }, { $divide: ['$gmv', '$order_count'] }, 0] }, 2] } } },
    ]).toArray();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ORDERS BY STATUS ───────────────────────────────────────
router.get('/orders/by-status', async (req, res) => {
  try {
    const match = buildMatchFilter(req.query);
    const data = await col('orders').aggregate([
      ...cityAreaPipeline(req.query),
      { $match: match },
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray();
    res.json(data.map(d => ({ status: d._id, count: d.count })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ORDERS BY HOUR ─────────────────────────────────────────
router.get('/orders/by-hour', async (req, res) => {
  try {
    const match = buildMatchFilter(req.query);
    const data = await col('orders').aggregate([
      ...cityAreaPipeline(req.query),
      { $match: match },
      { $group: { _id: { $hour: { date: '$created_at', timezone: 'Asia/Kolkata' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray();
    res.json(data.map(d => ({ hour: d._id, count: d.count })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ORDERS BY DAY OF WEEK ─────────────────────────────────
router.get('/orders/by-day', async (req, res) => {
  try {
    const match = buildMatchFilter(req.query);
    const data = await col('orders').aggregate([
      ...cityAreaPipeline(req.query),
      { $match: match },
      { $group: { _id: { $dayOfWeek: { date: '$created_at', timezone: 'Asia/Kolkata' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray();
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    res.json(data.map(d => ({ day: days[d._id - 1], count: d.count })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GEOGRAPHIC: CITIES ─────────────────────────────────────
router.get('/geographic/cities', async (req, res) => {
  try {
    const match = buildMatchFilter(req.query);
    const data = await col('orders').aggregate([
      { $match: match },
      { $lookup: { from: 'branches', localField: 'branch_id', foreignField: '_id', as: '_b' } },
      { $unwind: '$_b' },
      { $group: {
        _id: '$_b.city',
        order_count: { $sum: 1 },
        gmv: { $sum: { $cond: [{ $eq: ['$status', 'DELIVERED'] }, { $toDouble: '$total_rs' }, 0] } },
        customers: { $addToSet: '$customer_id' },
        restaurants: { $addToSet: '$restaurant_id' },
      }},
      { $project: { _id: 0, city: '$_id', order_count: 1, gmv: { $round: ['$gmv', 2] }, customer_count: { $size: '$customers' }, restaurant_count: { $size: '$restaurants' }, avg_order_value: { $round: [{ $cond: [{ $gt: ['$order_count', 0] }, { $divide: ['$gmv', '$order_count'] }, 0] }, 2] } } },
      { $sort: { gmv: -1 } },
    ]).toArray();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GEOGRAPHIC: AREAS (requires city filter) ───────────────
router.get('/geographic/areas', async (req, res) => {
  try {
    if (!req.query.city) return res.status(400).json({ error: 'city filter required' });
    const match = buildMatchFilter(req.query);
    const data = await col('orders').aggregate([
      { $match: match },
      { $lookup: { from: 'branches', localField: 'branch_id', foreignField: '_id', as: '_b' } },
      { $unwind: '$_b' },
      { $match: { '_b.city': { $regex: new RegExp(req.query.city, 'i') } } },
      { $group: {
        _id: '$_b.area',
        order_count: { $sum: 1 },
        gmv: { $sum: { $cond: [{ $eq: ['$status', 'DELIVERED'] }, { $toDouble: '$total_rs' }, 0] } },
        customers: { $addToSet: '$customer_id' },
        branches: { $addToSet: '$branch_id' },
      }},
      { $project: { _id: 0, area: { $ifNull: ['$_id', 'Unknown'] }, order_count: 1, gmv: { $round: ['$gmv', 2] }, customer_count: { $size: '$customers' }, branch_count: { $size: '$branches' }, avg_order_value: { $round: [{ $cond: [{ $gt: ['$order_count', 0] }, { $divide: ['$gmv', '$order_count'] }, 0] }, 2] } } },
      { $sort: { gmv: -1 } },
    ]).toArray();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── RESTAURANT RANKING ─────────────────────────────────────
router.get('/restaurants/ranking', async (req, res) => {
  try {
    const match = buildMatchFilter(req.query);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const sortField = req.query.sort || 'gmv';

    const data = await col('orders').aggregate([
      ...cityAreaPipeline(req.query),
      { $match: match },
      { $group: {
        _id: '$restaurant_id',
        order_count: { $sum: 1 },
        gmv: { $sum: { $cond: [{ $eq: ['$status', 'DELIVERED'] }, { $toDouble: '$total_rs' }, 0] } },
        customers: { $addToSet: '$customer_id' },
      }},
      { $lookup: { from: 'restaurants', localField: '_id', foreignField: '_id', as: '_r' } },
      { $unwind: { path: '$_r', preserveNullAndEmptyArrays: true } },
      { $project: {
        _id: 0,
        restaurant_id: '$_id',
        name: { $ifNull: ['$_r.business_name', '$_r.brand_name'] },
        city: '$_r.city',
        order_count: 1,
        gmv: { $round: ['$gmv', 2] },
        avg_order_value: { $round: [{ $cond: [{ $gt: ['$order_count', 0] }, { $divide: ['$gmv', '$order_count'] }, 0] }, 2] },
        customer_count: { $size: '$customers' },
      }},
      { $sort: { [sortField]: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit },
    ]).toArray();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── RESTAURANT DETAIL ──────────────────────────────────────
router.get('/restaurants/:id/detail', async (req, res) => {
  try {
    const rid = req.params.id;
    const match = { ...buildMatchFilter(req.query), restaurant_id: rid };

    const [timeseries, topItems, customerGrowth, statusDist] = await Promise.all([
      col('orders').aggregate([
        { $match: match },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$created_at', timezone: 'Asia/Kolkata' } }, order_count: { $sum: 1 }, gmv: { $sum: { $toDouble: '$total_rs' } } } },
        { $sort: { _id: 1 } },
      ]).toArray(),
      col('order_items').aggregate([
        { $lookup: { from: 'orders', localField: 'order_id', foreignField: '_id', as: '_o' } },
        { $unwind: '$_o' },
        { $match: { '_o.restaurant_id': rid, '_o.created_at': match.created_at } },
        { $group: { _id: '$name', qty: { $sum: '$qty' }, revenue: { $sum: { $multiply: ['$qty', { $toDouble: '$unit_price_rs' }] } } } },
        { $sort: { qty: -1 } },
        { $limit: 10 },
      ]).toArray(),
      col('orders').aggregate([
        { $match: match },
        { $group: { _id: '$customer_id', first: { $min: '$created_at' } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$first', timezone: 'Asia/Kolkata' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]).toArray(),
      col('orders').aggregate([
        { $match: match },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]).toArray(),
    ]);

    res.json({
      timeseries: timeseries.map(t => ({ date: t._id, order_count: t.order_count, gmv: parseFloat(t.gmv.toFixed(2)) })),
      top_items: topItems.map(i => ({ name: i._id, qty: i.qty, revenue: parseFloat(i.revenue.toFixed(2)) })),
      customer_growth: customerGrowth.map(c => ({ date: c._id, new_customers: c.count })),
      status_distribution: statusDist.map(s => ({ status: s._id, count: s.count })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── CUSTOMER OVERVIEW ──────────────────────────────────────
router.get('/customers/overview', async (req, res) => {
  try {
    const match = buildMatchFilter(req.query);

    const [totalCustomers, topBySpend, distribution] = await Promise.all([
      col('customers').countDocuments({}),
      col('orders').aggregate([
        ...cityAreaPipeline(req.query),
        { $match: match },
        { $group: { _id: '$customer_id', total_spent: { $sum: { $toDouble: '$total_rs' } }, order_count: { $sum: 1 } } },
        { $sort: { total_spent: -1 } },
        { $limit: 20 },
        { $lookup: { from: 'customers', localField: '_id', foreignField: '_id', as: '_c' } },
        { $unwind: { path: '$_c', preserveNullAndEmptyArrays: true } },
        { $project: { _id: 0, customer_id: '$_id', name: '$_c.name', phone: '$_c.wa_phone', total_spent: { $round: ['$total_spent', 2] }, order_count: 1 } },
      ]).toArray(),
      col('orders').aggregate([
        ...cityAreaPipeline(req.query),
        { $match: match },
        { $group: { _id: '$customer_id', cnt: { $sum: 1 } } },
        { $bucket: { groupBy: '$cnt', boundaries: [1, 2, 6, 11, 100000], default: 'other', output: { count: { $sum: 1 } } } },
      ]).toArray(),
    ]);

    const bucketLabels = { 1: '1 order', 2: '2-5 orders', 6: '6-10 orders', 11: '10+ orders' };
    res.json({
      total_registered: totalCustomers,
      top_by_spend: topBySpend,
      order_distribution: distribution.map(d => ({ bucket: bucketLabels[d._id] || `${d._id}+`, count: d.count })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── CUSTOMER SEGMENTS ──────────────────────────────────────
router.get('/customers/segments', async (req, res) => {
  try {
    const now = new Date();
    const d30 = new Date(now - 30 * 86400000);
    const d60 = new Date(now - 60 * 86400000);
    const d90 = new Date(now - 90 * 86400000);

    const data = await col('orders').aggregate([
      { $group: { _id: '$customer_id', first_order: { $min: '$created_at' }, last_order: { $max: '$created_at' }, total_spent: { $sum: { $toDouble: '$total_rs' } }, cnt: { $sum: 1 } } },
      { $addFields: {
        segment: { $switch: { branches: [
          { case: { $gte: ['$first_order', d30] }, then: 'new' },
          { case: { $gte: ['$last_order', d30] }, then: 'active' },
          { case: { $gte: ['$last_order', d60] }, then: 'at_risk' },
          { case: { $gte: ['$last_order', d90] }, then: 'lapsed' },
        ], default: 'lost' } },
      }},
      { $group: { _id: '$segment', count: { $sum: 1 }, gmv: { $sum: '$total_spent' }, avg_orders: { $avg: '$cnt' } } },
    ]).toArray();

    const segmentOrder = ['new', 'active', 'at_risk', 'lapsed', 'lost'];
    const sorted = segmentOrder.map(s => {
      const d = data.find(x => x._id === s) || { count: 0, gmv: 0, avg_orders: 0 };
      return { segment: s, count: d.count, gmv: parseFloat((d.gmv || 0).toFixed(2)), avg_orders: parseFloat((d.avg_orders || 0).toFixed(1)) };
    });
    res.json(sorted);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DELIVERY PERFORMANCE ───────────────────────────────────
router.get('/delivery/performance', async (req, res) => {
  try {
    const match = { ...buildMatchFilter(req.query), status: 'DELIVERED', delivered_at: { $exists: true } };
    const data = await col('orders').aggregate([
      ...cityAreaPipeline(req.query),
      { $match: match },
      { $addFields: { delivery_mins: { $divide: [{ $subtract: ['$delivered_at', '$created_at'] }, 60000] } } },
      { $facet: {
        avg: [{ $group: { _id: null, avg_mins: { $avg: '$delivery_mins' }, total: { $sum: 1 } } }],
        histogram: [
          { $bucket: { groupBy: '$delivery_mins', boundaries: [0, 20, 30, 45, 60, 1440], default: '60+', output: { count: { $sum: 1 } } } },
        ],
      }},
    ]).toArray();

    const avg = data[0]?.avg[0] || { avg_mins: 0, total: 0 };
    const bucketLabels = { 0: '0-20 min', 20: '20-30 min', 30: '30-45 min', 45: '45-60 min', 60: '60+ min' };
    res.json({
      avg_delivery_mins: parseFloat((avg.avg_mins || 0).toFixed(1)),
      total_delivered: avg.total,
      histogram: (data[0]?.histogram || []).map(h => ({ bucket: bucketLabels[h._id] || `${h._id}`, count: h.count })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DISTINCT CITIES (for filter dropdown) ──────────────────
router.get('/filters/cities', async (req, res) => {
  try {
    const cities = await col('branches').distinct('city', { city: { $ne: null, $ne: '' } });
    res.json(cities.filter(Boolean).sort());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DISTINCT AREAS (for filter dropdown, requires city) ────
router.get('/filters/areas', async (req, res) => {
  try {
    const filter = {};
    if (req.query.city) filter.city = { $regex: new RegExp(req.query.city, 'i') };
    const areas = await col('branches').distinct('area', filter);
    res.json(areas.filter(Boolean).sort());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
