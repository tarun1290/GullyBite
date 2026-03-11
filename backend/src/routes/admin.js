// src/routes/admin.js
// Admin-only REST API for the GullyBite management dashboard.
// All routes (except /auth) require: Authorization: Bearer <ADMIN_KEY>

const express = require('express');
const router  = express.Router();
const { col, newId, mapId, mapIds } = require('../config/database');
const { runSettlement } = require('../jobs/settlement');

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────
const requireAdmin = (req, res, next) => {
  const header = req.headers['authorization'] || '';
  const key    = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

// ─── POST /api/admin/auth ─────────────────────────────────────
router.post('/auth', express.json(), (req, res) => {
  const { key } = req.body;
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Invalid admin key' });
  }
  res.json({ ok: true });
});

// All routes below require admin auth
router.use(requireAdmin);

// ─── GET /api/admin/stats ─────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const lastWeek  = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      totalRestaurants, activeRestaurants,
      totalOrders, deliveredOrders, pendingOrders, cancelledOrders, todayOrders,
      allNonCancelledOrders, todayOrders2, weekOrders,
      totalCustomers, todayCustomers,
      totalLogs, unprocessedLogs, errorLogs,
    ] = await Promise.all([
      col('restaurants').countDocuments({}),
      col('restaurants').countDocuments({ status: 'active' }),
      col('orders').countDocuments({}),
      col('orders').countDocuments({ status: 'DELIVERED' }),
      col('orders').countDocuments({ status: 'PENDING' }),
      col('orders').countDocuments({ status: 'CANCELLED' }),
      col('orders').countDocuments({ created_at: { $gt: yesterday } }),
      col('orders').find({ status: { $ne: 'CANCELLED' } }).project({ total_rs: 1 }).toArray(),
      col('orders').find({ status: { $ne: 'CANCELLED' }, created_at: { $gt: yesterday } }).project({ total_rs: 1 }).toArray(),
      col('orders').find({ status: { $ne: 'CANCELLED' }, created_at: { $gt: lastWeek } }).project({ total_rs: 1 }).toArray(),
      col('customers').countDocuments({}),
      col('customers').countDocuments({ created_at: { $gt: yesterday } }),
      col('webhook_logs').countDocuments({}),
      col('webhook_logs').countDocuments({ processed: false }),
      col('webhook_logs').countDocuments({ error_message: { $ne: null } }),
    ]);

    const sumRs = (arr) => arr.reduce((s, o) => s + (parseFloat(o.total_rs) || 0), 0);

    res.json({
      restaurants: { total: totalRestaurants, active: activeRestaurants },
      orders     : { total: totalOrders, delivered: deliveredOrders, pending: pendingOrders, cancelled: cancelledOrders, today: todayOrders },
      revenue    : { total_rs: sumRs(allNonCancelledOrders), today_rs: sumRs(todayOrders2), week_rs: sumRs(weekOrders) },
      customers  : { total: totalCustomers, today: todayCustomers },
      logs       : { total: totalLogs, unprocessed: unprocessedLogs, errors: errorLogs },
    });
  } catch (err) {
    console.error('[Admin] stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/restaurants ──────────────────────────────
router.get('/restaurants', async (req, res) => {
  try {
    const restaurants = await col('restaurants').find({}).sort({ created_at: -1 }).toArray();

    const enriched = await Promise.all(restaurants.map(async r => {
      const rid = String(r._id);
      const branches = await col('branches').find({ restaurant_id: rid }).project({ _id: 1 }).toArray();
      const branchIds = branches.map(b => String(b._id));

      const orders = await col('orders').find({ branch_id: { $in: branchIds } }).project({ total_rs: 1, status: 1 }).toArray();
      const revenue_rs = orders
        .filter(o => o.status !== 'CANCELLED')
        .reduce((s, o) => s + (parseFloat(o.total_rs) || 0), 0);

      const out = mapId(r);
      delete out.password_hash;
      delete out.meta_access_token;
      return { ...out, branch_count: branches.length, order_count: orders.length, revenue_rs };
    }));

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/branches ──────────────────────────────────
router.get('/branches', async (req, res) => {
  try {
    const { restaurant_id } = req.query;
    const filter = restaurant_id ? { restaurant_id } : {};
    const branches = await col('branches').find(filter).sort({ created_at: -1 }).toArray();

    const enriched = await Promise.all(branches.map(async b => {
      const bid = String(b._id);
      const restaurant = await col('restaurants').findOne({ _id: b.restaurant_id }, { projection: { business_name: 1 } });
      const [menuCount, orderCount] = await Promise.all([
        col('menu_items').countDocuments({ branch_id: bid }),
        col('orders').countDocuments({ branch_id: bid }),
      ]);
      return { ...mapId(b), business_name: restaurant?.business_name, menu_item_count: menuCount, order_count: orderCount };
    }));

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/orders ────────────────────────────────────
router.get('/orders', async (req, res) => {
  try {
    const {
      status, restaurant_id, branch_id,
      limit = 50, offset = 0,
      date_from, date_to,
    } = req.query;

    const filter = {};
    if (status)    filter.status    = status;
    if (branch_id) filter.branch_id = branch_id;
    if (date_from || date_to) {
      filter.created_at = {};
      if (date_from) filter.created_at.$gte = new Date(date_from);
      if (date_to)   filter.created_at.$lte = new Date(date_to);
    }

    // If filtering by restaurant, find branch IDs first
    if (restaurant_id) {
      const branches = await col('branches').find({ restaurant_id }).project({ _id: 1 }).toArray();
      filter.branch_id = { $in: branches.map(b => String(b._id)) };
    }

    const [orders, total] = await Promise.all([
      col('orders').find(filter).sort({ created_at: -1 }).skip(parseInt(offset)).limit(parseInt(limit)).toArray(),
      col('orders').countDocuments(filter),
    ]);

    const enriched = await Promise.all(orders.map(async o => {
      const [branch, customer] = await Promise.all([
        col('branches').findOne({ _id: o.branch_id }, { projection: { name: 1, restaurant_id: 1 } }),
        col('customers').findOne({ _id: o.customer_id }, { projection: { name: 1, wa_phone: 1 } }),
      ]);
      const restaurant = branch
        ? await col('restaurants').findOne({ _id: branch.restaurant_id }, { projection: { business_name: 1 } })
        : null;
      return {
        ...mapId(o),
        business_name: restaurant?.business_name,
        branch_name:   branch?.name,
        wa_phone:      customer?.wa_phone,
        customer_name: customer?.name,
      };
    }));

    res.json({ orders: enriched, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/logs ─────────────────────────────────────
router.get('/logs', async (req, res) => {
  try {
    const {
      source, event_type, processed,
      date_from, date_to,
      limit = 50, offset = 0,
      has_error,
    } = req.query;

    const filter = {};
    if (source)     filter.source     = source;
    if (event_type) filter.event_type = { $regex: event_type, $options: 'i' };
    if (processed !== undefined && processed !== '') filter.processed = processed === 'true';
    if (has_error === 'true')  filter.error_message = { $ne: null };
    if (has_error === 'false') filter.error_message = null;
    if (date_from || date_to) {
      filter.received_at = {};
      if (date_from) filter.received_at.$gte = new Date(date_from);
      if (date_to)   filter.received_at.$lte = new Date(date_to);
    }

    const [docs, total] = await Promise.all([
      col('webhook_logs').find(filter).sort({ received_at: -1 }).skip(parseInt(offset)).limit(parseInt(limit)).toArray(),
      col('webhook_logs').countDocuments(filter),
    ]);

    res.json({ logs: mapIds(docs), total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/logs/:id ──────────────────────────────────
router.get('/logs/:id', async (req, res) => {
  try {
    const doc = await col('webhook_logs').findOne({ _id: req.params.id });
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json(mapId(doc));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/customers ─────────────────────────────────
router.get('/customers', async (req, res) => {
  try {
    const { limit = 50, offset = 0, search } = req.query;

    const filter = {};
    if (search) {
      filter.$or = [
        { wa_phone: { $regex: search, $options: 'i' } },
        { name:     { $regex: search, $options: 'i' } },
      ];
    }

    const customers = await col('customers').find(filter).sort({ created_at: -1 })
      .skip(parseInt(offset)).limit(parseInt(limit)).toArray();

    const enriched = await Promise.all(customers.map(async c => {
      const orders = await col('orders').find({ customer_id: String(c._id) }).project({ total_rs: 1, status: 1 }).toArray();
      const lifetime_rs = orders.filter(o => o.status !== 'CANCELLED').reduce((s, o) => s + (parseFloat(o.total_rs) || 0), 0);
      return { ...mapId(c), order_count: orders.length, lifetime_rs };
    }));

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/admin/restaurants/:id ────────────────────────
router.patch('/restaurants/:id', express.json(), async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active', 'suspended', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const updated = await col('restaurants').findOneAndUpdate(
      { _id: req.params.id },
      { $set: { status, updated_at: new Date() } },
      { returnDocument: 'after', projection: { _id: 1, business_name: 1, status: 1 } }
    );
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(mapId(updated));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/admin/run-settlement ──────────────────────────
router.post('/run-settlement', async (req, res) => {
  res.json({ message: 'Settlement started' });
  runSettlement().catch(console.error);
});

// ─── GET /api/admin/applications ─────────────────────────────
router.get('/applications', async (req, res) => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const docs = await col('restaurants').find({
      $or: [
        { approval_status: 'pending' },
        { approval_status: 'rejected' },
        { approval_status: 'approved', approved_at: { $gt: sevenDaysAgo } },
      ],
    }).toArray();

    // Sort: pending first, rejected second, approved last; then by submitted_at desc
    const statusOrder = { pending: 0, rejected: 1, approved: 2 };
    docs.sort((a, b) => {
      const diff = (statusOrder[a.approval_status] || 2) - (statusOrder[b.approval_status] || 2);
      if (diff !== 0) return diff;
      const aTime = a.submitted_at ? new Date(a.submitted_at).getTime() : 0;
      const bTime = b.submitted_at ? new Date(b.submitted_at).getTime() : 0;
      return bTime - aTime;
    });

    res.json(mapIds(docs).map(r => {
      const { password_hash, meta_access_token, ...rest } = r;
      return rest;
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/admin/applications/:id/approve ───────────────
router.patch('/applications/:id/approve', express.json(), async (req, res) => {
  try {
    const { notes } = req.body;
    const now = new Date();
    const updated = await col('restaurants').findOneAndUpdate(
      { _id: req.params.id },
      { $set: { approval_status: 'approved', approval_notes: notes || null, approved_at: now, status: 'active', updated_at: now } },
      { returnDocument: 'after', projection: { _id: 1, business_name: 1, email: 1 } }
    );
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, restaurant: mapId(updated) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/admin/applications/:id/reject ────────────────
router.patch('/applications/:id/reject', express.json(), async (req, res) => {
  try {
    const { notes } = req.body;
    if (!notes) return res.status(400).json({ error: 'Rejection reason is required' });
    const now = new Date();
    const updated = await col('restaurants').findOneAndUpdate(
      { _id: req.params.id },
      { $set: { approval_status: 'rejected', approval_notes: notes, updated_at: now } },
      { returnDocument: 'after', projection: { _id: 1, business_name: 1, email: 1 } }
    );
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, restaurant: mapId(updated) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/admin/applications/:id/verify-gst ────────────
router.patch('/applications/:id/verify-gst', express.json(), async (req, res) => {
  try {
    const { verified } = req.body; // true or false
    await col('restaurants').updateOne(
      { _id: req.params.id },
      { $set: { gst_verified: !!verified, gst_verified_at: verified ? new Date() : null, updated_at: new Date() } }
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── PATCH /api/admin/applications/:id/verify-fssai ──────────
router.patch('/applications/:id/verify-fssai', express.json(), async (req, res) => {
  try {
    const { verified } = req.body;
    await col('restaurants').updateOne(
      { _id: req.params.id },
      { $set: { fssai_verified: !!verified, fssai_verified_at: verified ? new Date() : null, updated_at: new Date() } }
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── REFERRALS ────────────────────────────────────────────────────

// POST /api/admin/referrals
router.post('/referrals', express.json(), async (req, res) => {
  try {
    const { restaurantId, customerWaPhone, customerName, notes } = req.body;
    if (!restaurantId || !customerWaPhone)
      return res.status(400).json({ error: 'restaurantId and customerWaPhone are required' });

    const now = new Date();
    // Expire old active referrals for same restaurant+customer
    await col('referrals').updateMany(
      { restaurant_id: restaurantId, customer_wa_phone: customerWaPhone, status: 'active' },
      { $set: { status: 'expired', updated_at: now } }
    );

    const expiresAt = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const referral = {
      _id: newId(),
      restaurant_id: restaurantId,
      customer_wa_phone: customerWaPhone.trim(),
      customer_name: customerName || null,
      notes: notes || null,
      status: 'active',
      expires_at: expiresAt,
      orders_count: 0,
      total_order_value_rs: 0,
      referral_fee_rs: 0,
      created_at: now,
      updated_at: now,
    };
    await col('referrals').insertOne(referral);
    res.json(mapId(referral));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/referrals/stats
router.get('/referrals/stats', async (req, res) => {
  try {
    const all = await col('referrals').find({}).toArray();
    const total     = all.length;
    const active    = all.filter(r => r.status === 'active').length;
    const converted = all.filter(r => r.status === 'converted').length;
    const expired   = all.filter(r => r.status === 'expired').length;
    const total_orders          = all.reduce((s, r) => s + (r.orders_count || 0), 0);
    const total_order_value_rs  = all.reduce((s, r) => s + (parseFloat(r.total_order_value_rs) || 0), 0);
    const total_referral_fee_rs = all.reduce((s, r) => s + (parseFloat(r.referral_fee_rs) || 0), 0);
    res.json({ total, active, converted, expired, total_orders, total_order_value_rs, total_referral_fee_rs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/referrals
router.get('/referrals', async (req, res) => {
  try {
    const now = new Date();
    await col('referrals').updateMany(
      { status: 'active', expires_at: { $lt: now } },
      { $set: { status: 'expired', updated_at: now } }
    );

    const referrals = await col('referrals').find({}).sort({ created_at: -1 }).limit(200).toArray();

    const enriched = await Promise.all(referrals.map(async r => {
      const restaurant = await col('restaurants').findOne({ _id: r.restaurant_id }, { projection: { business_name: 1 } });
      const wa_acc     = await col('whatsapp_accounts').findOne({ restaurant_id: r.restaurant_id, is_active: true }, { projection: { phone_display: 1 } });
      return {
        ...mapId(r),
        restaurant_name:    restaurant?.business_name,
        restaurant_wa_phone:wa_acc?.phone_display,
      };
    }));

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/settlements ──────────────────────────────
router.get('/settlements', async (req, res) => {
  try {
    const { restaurant_id, status, limit = 50, offset = 0 } = req.query;
    const filter = {};
    if (restaurant_id) filter.restaurant_id = restaurant_id;
    if (status) filter.payout_status = status;

    const [settlements, total] = await Promise.all([
      col('settlements').find(filter).sort({ created_at: -1 }).skip(parseInt(offset)).limit(parseInt(limit)).toArray(),
      col('settlements').countDocuments(filter),
    ]);

    const enriched = await Promise.all(settlements.map(async s => {
      const restaurant = await col('restaurants').findOne({ _id: s.restaurant_id }, { projection: { business_name: 1 } });
      return { ...mapId(s), business_name: restaurant?.business_name || '—' };
    }));

    res.json({ settlements: enriched, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/settlements/stats ───────────────────────
router.get('/settlements/stats', async (req, res) => {
  try {
    const all = await col('settlements').find({}).toArray();
    const total = all.length;
    const pending    = all.filter(s => s.payout_status === 'pending').length;
    const processing = all.filter(s => s.payout_status === 'processing').length;
    const completed  = all.filter(s => s.payout_status === 'completed').length;
    const failed     = all.filter(s => s.payout_status === 'failed').length;
    const total_payout_rs = all.reduce((sum, s) => sum + (parseFloat(s.net_payout_rs) || 0), 0);
    const total_fee_rs    = all.reduce((sum, s) => sum + (parseFloat(s.platform_fee_rs) || 0), 0);
    res.json({ total, pending, processing, completed, failed, total_payout_rs, total_fee_rs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/admin/clear-cache ─────────────────────────────
// Clears stale/test data: expired tokens, orphan sessions, temp records
router.post('/clear-cache', async (req, res) => {
  try {
    const results = {};

    // Clear expired Meta tokens
    const expiredTokens = await col('restaurants').updateMany(
      { meta_token_expires_at: { $lt: new Date() } },
      { $unset: { meta_access_token: '', meta_token_expires_at: '' } }
    );
    results.expired_tokens_cleared = expiredTokens.modifiedCount;

    // Clear stale/abandoned signups (no onboarding completed, older than 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const staleSignups = await col('restaurants').deleteMany({
      onboarding_step: { $lt: 2 },
      created_at: { $lt: thirtyDaysAgo },
      meta_user_id: { $exists: false },
    });
    results.stale_signups_removed = staleSignups.deletedCount;

    // Clear orphan whatsapp_accounts with no matching restaurant
    const allRestIds = (await col('restaurants').find({}, { projection: { _id: 1 } }).toArray()).map(r => r._id);
    const orphanWA = await col('whatsapp_accounts').deleteMany({
      restaurant_id: { $nin: allRestIds },
    });
    results.orphan_wa_accounts_removed = orphanWA.deletedCount;

    res.json({ ok: true, cleared: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
