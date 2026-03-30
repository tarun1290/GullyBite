// src/routes/admin.js
// Admin-only REST API for the GullyBite management dashboard.
// All routes (except /auth) require: Authorization: Bearer <ADMIN_KEY>

const express = require('express');
const router  = express.Router();
const { col, newId, mapId, mapIds } = require('../config/database');
const { runSettlement } = require('../jobs/settlement');
const { logActivity } = require('../services/activityLog');
const issueSvc = require('../services/issues');
const metaConfig = require('../config/meta');
const financials = require('../services/financials');
const ws = require('../services/websocket');

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
  logActivity({
    actorType: 'admin', actorId: null, actorName: 'Admin',
    action: 'admin.login', category: 'auth',
    description: 'Admin logged in', severity: 'info',
  });
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

      // Orders with full status breakdown
      const orders = await col('orders').find({ branch_id: { $in: branchIds } })
        .project({ total_rs: 1, status: 1, delivered_at: 1 }).toArray();

      const ordersByStatus = {
        total: orders.length,
        delivered: orders.filter(o => o.status === 'DELIVERED').length,
        pending: orders.filter(o => o.status === 'PENDING').length,
        confirmed: orders.filter(o => o.status === 'CONFIRMED').length,
        preparing: orders.filter(o => o.status === 'PREPARING').length,
        out_for_delivery: orders.filter(o => o.status === 'OUT_FOR_DELIVERY').length,
        cancelled: orders.filter(o => o.status === 'CANCELLED').length,
      };

      const revenue_rs = orders
        .filter(o => o.status !== 'CANCELLED')
        .reduce((s, o) => s + (parseFloat(o.total_rs) || 0), 0);

      // Fulfillment rate = delivered / (total - cancelled) * 100
      const nonCancelled = ordersByStatus.total - ordersByStatus.cancelled;
      const fulfillment_pct = nonCancelled > 0
        ? Math.round((ordersByStatus.delivered / nonCancelled) * 100)
        : 0;

      // Catalog count (menu items across all branches)
      const [catalogCount, issueCount] = await Promise.all([
        col('menu_items').countDocuments({ branch_id: { $in: branchIds } }),
        // Issues = cancelled orders + failed payments
        col('payments').countDocuments({ restaurant_id: rid, status: { $in: ['failed', 'refunded'] } }),
      ]);

      const issues = ordersByStatus.cancelled + issueCount;

      const out = mapId(r);
      delete out.password_hash;
      delete out.meta_access_token;
      return {
        ...out,
        branch_count: branches.length,
        catalog_count: catalogCount,
        orders: ordersByStatus,
        order_count: orders.length,
        fulfillment_pct,
        issues,
        revenue_rs,
      };
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
        col('customers').findOne({ _id: o.customer_id }, { projection: { name: 1, wa_phone: 1, bsuid: 1 } }),
      ]);
      const restaurant = branch
        ? await col('restaurants').findOne({ _id: branch.restaurant_id }, { projection: { business_name: 1 } })
        : null;
      return {
        ...mapId(o),
        business_name: restaurant?.business_name,
        branch_name:   branch?.name,
        wa_phone:      customer?.wa_phone || customer?.bsuid || '',
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
    if (status === 'suspended') {
      logActivity({
        actorType: 'admin', actorId: null, actorName: 'Admin',
        action: 'restaurant.suspended', category: 'auth',
        description: `Restaurant "${updated.business_name}" suspended`,
        restaurantId: req.params.id, resourceType: 'restaurant', resourceId: req.params.id, severity: 'warning',
      });
    }
    res.json(mapId(updated));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/admin/run-settlement ──────────────────────────
router.post('/run-settlement', async (req, res) => {
  try {
    logActivity({
      actorType: 'admin', actorId: null, actorName: 'Admin',
      action: 'settlement.generated', category: 'settlement',
      description: 'Settlement run triggered manually by admin',
      resourceType: 'settlement', resourceId: null, severity: 'info',
    });
    res.json({ message: 'Settlement started' });
    runSettlement().catch(console.error);
  } catch (e) { res.status(500).json({ error: e.message }); }
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

    ws.broadcastToAdmin('restaurant_status', { restaurantId: req.params.id, restaurantName: updated.business_name, status: 'approved' });

    // Auto-list in WhatsApp directory (fire-and-forget)
    const directory = require('../services/directory');
    directory.listRestaurant(req.params.id).catch(err =>
      console.error('[Directory] Auto-list failed:', err.message)
    );

    // [WhatsApp2026] Auto-generate username suggestions on approval (fire-and-forget)
    (async () => {
      try {
        const waAcc = await col('whatsapp_accounts').findOne({ restaurant_id: req.params.id, is_active: true });
        if (waAcc && !waAcc.username_suggestions?.length) {
          const restaurant = await col('restaurants').findOne({ _id: req.params.id });
          const suggestions = usernameSvc.generateUsernameSuggestions(
            restaurant?.brand_name || restaurant?.business_name,
            restaurant?.business_name,
            restaurant?.city,
            restaurant?.restaurant_type
          );
          if (suggestions.length) {
            await col('whatsapp_accounts').updateOne({ _id: waAcc._id }, {
              $set: { username_suggestions: suggestions, username_status: 'suggested', username_updated_at: new Date() },
            });
          }
        }
      } catch (e) { console.error('[WhatsApp2026] Auto-suggest failed:', e.message); }
    })();

    logActivity({
      actorType: 'admin', actorId: null, actorName: 'Admin',
      action: 'restaurant.approved', category: 'auth',
      description: `Restaurant "${updated.business_name}" approved`,
      restaurantId: req.params.id, resourceType: 'restaurant', resourceId: req.params.id, severity: 'info',
    });
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
    ws.broadcastToAdmin('restaurant_status', { restaurantId: req.params.id, restaurantName: updated.business_name, status: 'rejected' });
    logActivity({
      actorType: 'admin', actorId: null, actorName: 'Admin',
      action: 'restaurant.rejected', category: 'auth',
      description: `Restaurant "${updated.business_name}" rejected: ${notes}`,
      restaurantId: req.params.id, resourceType: 'restaurant', resourceId: req.params.id, severity: 'warning',
    });
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

// ─── WALLETS ─────────────────────────────────────────────────

router.get('/wallets', async (req, res) => {
  try {
    const walletSvc = require('../services/wallet');
    const wallets = await walletSvc.getAllWallets();
    const enriched = await Promise.all(wallets.map(async w => {
      const r = await col('restaurants').findOne({ _id: w.restaurant_id }, { projection: { business_name: 1 } });
      const spend = await walletSvc.getMonthlySpend(w.restaurant_id);
      return { ...w, restaurant_name: r?.business_name || '—', monthly_spend_rs: spend };
    }));
    const totalBalance = wallets.reduce((s, w) => s + (parseFloat(w.balance_rs) || 0), 0);
    const totalMonthly = enriched.reduce((s, w) => s + w.monthly_spend_rs, 0);
    const negativeCount = wallets.filter(w => w.balance_rs < 0).length;
    const lowCount = wallets.filter(w => w.balance_rs > 0 && w.balance_rs < (w.low_balance_threshold_rs || 100)).length;
    res.json({ wallets: enriched, summary: { totalBalance, totalMonthly, negativeCount, lowCount } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/wallets/refund', async (req, res) => {
  try {
    const { restaurantId, amount, description } = req.body;
    if (!restaurantId || !amount) return res.status(400).json({ error: 'restaurantId and amount required' });
    const walletSvc = require('../services/wallet');
    const result = await walletSvc.refund(restaurantId, amount, description || 'Admin refund');
    if (!result) return res.status(404).json({ error: 'Wallet not found' });
    res.json({ success: true, balance: result.balance_rs });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

// ─── GET /api/admin/settlements/:id/download ────────────────
router.get('/settlements/:id/download', async (req, res) => {
  try {
    const settlement = await col('settlements').findOne({ _id: req.params.id });
    if (!settlement) return res.status(404).json({ error: 'Settlement not found' });
    const { generateSettlementExcel } = require('../services/settlement-export');
    const { buffer, filename } = await generateSettlementExcel(req.params.id);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(buffer));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── DIRECTORY ───────────────────────────────────────────────
const directory = require('../services/directory');

router.get('/directory/listings', async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const result = await directory.getAllListings({ limit: parseInt(limit), offset: parseInt(offset) });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/directory/stats', async (req, res) => {
  try {
    res.json(await directory.getStats());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/directory/listings/:id/toggle', async (req, res) => {
  try {
    const { isActive } = req.body;
    await col('directory_listings').updateOne(
      { _id: req.params.id },
      { $set: { is_active: !!isActive, updated_at: new Date() } }
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/directory/sync-all', async (req, res) => {
  res.json({ message: 'Directory sync started' });
  try {
    const restaurants = await col('restaurants').find({ approval_status: 'approved', status: 'active' }).toArray();
    for (const r of restaurants) {
      await directory.listRestaurant(String(r._id)).catch(e =>
        console.error(`[Directory] Sync failed for ${r.business_name}:`, e.message)
      );
    }
    console.log(`[Directory] Synced ${restaurants.length} listings`);
  } catch (err) { console.error('[Directory] Sync-all error:', err.message); }
});

// ─── CHECKOUT CONFIG ─────────────────────────────────────────
router.post('/checkout/generate-keys', async (req, res) => {
  try {
    const { generateKeyPair } = require('../services/checkout-crypto');
    const keys = generateKeyPair();
    // Return keys — admin should set WA_CHECKOUT_PRIVATE_KEY_B64 env var
    // and upload publicKey to Meta's Checkout settings
    res.json({
      publicKey: keys.publicKey,
      privateKeyB64: keys.privateKeyB64,
      instructions: 'Set WA_CHECKOUT_PRIVATE_KEY_B64 in your .env to privateKeyB64. Upload publicKey to Meta Checkout settings.',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/checkout/status', async (req, res) => {
  try {
    const configured = !!process.env.WA_CHECKOUT_PRIVATE_KEY_B64;
    const verifyToken = process.env.WA_CHECKOUT_VERIFY_TOKEN || '(not set)';
    const webhookSecret = !!process.env.WA_CHECKOUT_WEBHOOK_SECRET;
    res.json({ configured, verifyToken: configured ? verifyToken : null, webhookSecret });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── DELETE /api/admin/restaurants/:id ────────────────────────
// Archives the restaurant internally, then deletes all live data
router.delete('/restaurants/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const restaurant = await col('restaurants').findOne({ _id: id });
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    // Get branch IDs for cascading delete
    const branches = await col('branches').find({ restaurant_id: id }, { projection: { _id: 1 } }).toArray();
    const branchIds = branches.map(b => b._id);

    // Gather summary stats for the archive
    const [orderCount, revenue, waAccounts] = await Promise.all([
      col('orders').countDocuments({ restaurant_id: id }),
      col('orders').find({ restaurant_id: id, status: { $ne: 'CANCELLED' } }).project({ total_rs: 1 }).toArray(),
      col('whatsapp_accounts').find({ restaurant_id: id }).toArray(),
    ]);
    const totalRevenue = revenue.reduce((s, o) => s + (parseFloat(o.total_rs) || 0), 0);

    // Archive to internal collection (never exposed to public APIs)
    const { password_hash, ...safeRestaurant } = restaurant;
    await col('archived_restaurants').insertOne({
      _id: newId(),
      original_id: id,
      restaurant: safeRestaurant,
      wa_phones: waAccounts.map(w => w.phone_display || w.phone_number_id),
      branch_count: branches.length,
      order_count: orderCount,
      total_revenue_rs: totalRevenue,
      deleted_by: 'admin',
      deleted_at: new Date(),
    });

    // Delete all live data
    await Promise.all([
      col('restaurants').deleteOne({ _id: id }),
      col('whatsapp_accounts').deleteMany({ restaurant_id: id }),
      col('branches').deleteMany({ restaurant_id: id }),
      col('menu_items').deleteMany({ restaurant_id: id }),
      col('menu_categories').deleteMany({ branch_id: { $in: branchIds } }),
      col('orders').deleteMany({ restaurant_id: id }),
      col('payments').deleteMany({ restaurant_id: id }),
      col('coupons').deleteMany({ restaurant_id: id }),
      col('settlements').deleteMany({ restaurant_id: id }),
      col('referrals').deleteMany({ restaurant_id: id }),
    ]);

    console.log(`[Admin] Deleted restaurant "${restaurant.business_name}" (${id}) — archived as internal record`);
    res.json({ ok: true, archived: true, business_name: restaurant.business_name });
  } catch (err) {
    console.error('[Admin] Delete restaurant error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/archived-restaurants ─────────────────────
router.get('/archived-restaurants', async (req, res) => {
  try {
    const docs = await col('archived_restaurants').find({}).sort({ deleted_at: -1 }).toArray();
    res.json(mapIds(docs));
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

    // Mark all unprocessed webhook logs as processed (legacy cleanup)
    const staleLogs = await col('webhook_logs').updateMany(
      { processed: false },
      { $set: { processed: true, processed_at: new Date() } }
    );
    results.stale_logs_marked_processed = staleLogs.modifiedCount;

    res.json({ ok: true, cleared: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/ratings/stats ─────────────────────────────
router.get('/ratings/stats', async (req, res) => {
  try {
    const allRatings = await col('order_ratings').find({}).toArray();
    const total = allRatings.length;

    if (!total) {
      return res.json({ avg_food: 0, avg_delivery: 0, total: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
    }

    const sumFood     = allRatings.reduce((s, r) => s + (r.food_rating || 0), 0);
    const sumDelivery = allRatings.reduce((s, r) => s + (r.delivery_rating || 0), 0);
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of allRatings) {
      const star = Math.max(1, Math.min(5, r.food_rating || 3));
      distribution[star] = (distribution[star] || 0) + 1;
    }

    res.json({
      avg_food:     +(sumFood / total).toFixed(1),
      avg_delivery: +(sumDelivery / total).toFixed(1),
      total,
      distribution,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// WEBHOOK RETRY & DEAD LETTER QUEUE
// ═══════════════════════════════════════════════════════════════

// GET /api/admin/webhook-retry/stats — retry & DLQ overview
router.get('/webhook-retry/stats', async (req, res) => {
  try {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [pendingRetries, inDlq, successLast24h, failedLast24h] = await Promise.all([
      col('webhook_logs').countDocuments({ retry_status: 'pending', moved_to_dlq: false }),
      col('webhook_logs').countDocuments({ moved_to_dlq: true, dismissed: { $ne: true } }),
      col('webhook_logs').countDocuments({ retry_status: 'success', retry_count: { $gte: 1 }, processed_at: { $gte: oneDayAgo } }),
      col('webhook_logs').countDocuments({ retry_status: { $in: ['exhausted', 'pending'] }, error_history: { $exists: true, $not: { $size: 0 } }, received_at: { $gte: oneDayAgo } }),
    ]);

    const totalRetried24h = successLast24h + failedLast24h;
    const successRate = totalRetried24h > 0 ? +((successLast24h / totalRetried24h) * 100).toFixed(1) : 0;

    // Average retries before success (last 24h)
    const successDocs = await col('webhook_logs').find(
      { retry_status: 'success', retry_count: { $gte: 1 }, processed_at: { $gte: oneDayAgo } },
      { projection: { retry_count: 1 } }
    ).toArray();
    const avgRetries = successDocs.length > 0
      ? +(successDocs.reduce((s, d) => s + (d.retry_count || 0), 0) / successDocs.length).toFixed(1)
      : 0;

    res.json({
      pending_retries: pendingRetries,
      in_dlq: inDlq,
      success_rate_24h: successRate,
      avg_retries_before_success: avgRetries,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/dlq — paginated dead letter queue
router.get('/dlq', async (req, res) => {
  try {
    const { source, limit = 50, offset = 0, dismissed } = req.query;
    const filter = { moved_to_dlq: true };
    if (source) filter.source = source;
    if (dismissed === 'true') filter.dismissed = true;
    else if (dismissed === 'false' || dismissed === undefined) filter.dismissed = { $ne: true };

    const [docs, total] = await Promise.all([
      col('webhook_logs').find(filter).sort({ dlq_at: -1 }).skip(parseInt(offset)).limit(parseInt(limit)).toArray(),
      col('webhook_logs').countDocuments(filter),
    ]);

    res.json({ entries: mapIds(docs), total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/dlq/:id/retry — manually retry a DLQ entry
router.post('/dlq/:id/retry', async (req, res) => {
  try {
    const result = await col('webhook_logs').updateOne(
      { _id: req.params.id, moved_to_dlq: true },
      {
        $set: {
          retry_count: 0,
          retry_status: 'pending',
          next_retry_at: new Date(),
          moved_to_dlq: false,
          dlq_at: null,
          dismissed: false,
        },
      }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'DLQ entry not found' });
    logActivity({
      actorType: 'admin', actorId: null, actorName: 'Admin',
      action: 'dlq.retried', category: 'webhook',
      description: `DLQ entry ${req.params.id} retried`,
      resourceType: 'webhook_log', resourceId: req.params.id, severity: 'info',
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/dlq/:id/dismiss — permanently dismiss a DLQ entry
router.post('/dlq/:id/dismiss', async (req, res) => {
  try {
    const result = await col('webhook_logs').updateOne(
      { _id: req.params.id },
      { $set: { dismissed: true, dismissed_at: new Date() } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Entry not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// ABUSE PROTECTION — BLOCKED PHONES & RATE LIMIT STATS
// ═══════════════════════════════════════════════════════════════

// GET /api/admin/blocked-phones — list all blocked numbers
router.get('/blocked-phones', async (req, res) => {
  try {
    const docs = await col('blocked_phones').find({}).sort({ blocked_at: -1 }).limit(200).toArray();
    // Mark expired ones
    const now = new Date();
    const enriched = docs.map(d => ({
      ...mapId(d),
      is_active: !d.expires_at || d.expires_at > now,
    }));
    res.json(enriched);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/blocked-phones — manually block a phone
router.post('/blocked-phones', async (req, res) => {
  try {
    const { wa_phone, reason, durationHours } = req.body;
    if (!wa_phone) return res.status(400).json({ error: 'wa_phone is required' });

    const now = new Date();
    const expiresAt = durationHours ? new Date(now.getTime() + durationHours * 60 * 60 * 1000) : null;

    await col('blocked_phones').updateOne(
      { wa_phone },
      {
        $set: {
          reason: reason || 'Manually blocked by admin',
          blocked_at: now,
          expires_at: expiresAt,
          blocked_by: 'admin',
        },
        $setOnInsert: { _id: newId() },
      },
      { upsert: true }
    );
    logActivity({
      actorType: 'admin', actorId: null, actorName: 'Admin',
      action: 'blocked_phone.added', category: 'abuse',
      description: `Phone ${wa_phone} blocked: ${reason || 'Manually blocked by admin'}`,
      severity: 'warning', metadata: { wa_phone, reason, durationHours },
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/admin/blocked-phones/:id — unblock a phone
router.delete('/blocked-phones/:id', async (req, res) => {
  try {
    const result = await col('blocked_phones').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/rate-limit/stats — rate limit & abuse overview
router.get('/rate-limit/stats', async (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const [rateLimitedToday, autoBlockedToday, activeBlocks, topPhones] = await Promise.all([
      col('webhook_logs').countDocuments({
        event_type: 'rate_limited',
        received_at: { $gte: todayStart },
      }),
      col('blocked_phones').countDocuments({
        blocked_by: 'auto',
        blocked_at: { $gte: todayStart },
      }),
      col('blocked_phones').countDocuments({
        $or: [{ expires_at: null }, { expires_at: { $gt: now } }],
      }),
      col('webhook_logs').aggregate([
        { $match: { event_type: 'rate_limited', received_at: { $gte: todayStart } } },
        { $group: { _id: '$error_message', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]).toArray(),
    ]);

    // Extract phone from "Rate limited: 919876543210" format
    const topRateLimited = topPhones.map(p => ({
      phone: (p._id || '').replace('Rate limited: ', ''),
      count: p.count,
    }));

    res.json({
      rate_limited_today: rateLimitedToday,
      auto_blocked_today: autoBlockedToday,
      active_blocks: activeBlocks,
      top_rate_limited: topRateLimited,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// 3PL DELIVERY STATS
// ═══════════════════════════════════════════════════════════════

// GET /api/admin/delivery/stats — platform-wide delivery stats
router.get('/delivery/stats', async (req, res) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [totalToday, deliveredToday, failedToday, activeNow, allDeliveredToday] = await Promise.all([
      col('deliveries').countDocuments({ created_at: { $gte: todayStart } }),
      col('deliveries').countDocuments({ status: 'delivered', delivered_at: { $gte: todayStart } }),
      col('deliveries').countDocuments({ status: { $in: ['failed', 'cancelled'] }, updated_at: { $gte: todayStart } }),
      col('deliveries').countDocuments({ status: { $in: ['pending', 'assigned', 'picked_up'] } }),
      col('deliveries').find({ status: 'delivered', delivered_at: { $gte: todayStart } }).toArray(),
    ]);

    // Average delivery time today
    let avgDeliveryMin = 0;
    const withTimes = allDeliveredToday.filter(d => d.delivered_at && d.created_at);
    if (withTimes.length) {
      const totalMin = withTimes.reduce((s, d) => s + (new Date(d.delivered_at) - new Date(d.created_at)) / 60000, 0);
      avgDeliveryMin = Math.round(totalMin / withTimes.length);
    }

    // 3PL cost today
    const costToday = allDeliveredToday.reduce((s, d) => s + (parseFloat(d.cost_rs) || 0), 0);

    const failureRate = totalToday > 0 ? Math.round(failedToday / totalToday * 100) : 0;

    res.json({
      total_today: totalToday,
      delivered_today: deliveredToday,
      failed_today: failedToday,
      active_now: activeNow,
      avg_delivery_min: avgDeliveryMin,
      cost_today_rs: Math.round(costToday * 100) / 100,
      failure_rate_pct: failureRate,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── TEMPLATE MANAGEMENT ────────────────────────────────────
const templateSvc = require('../services/template');

// GET /api/admin/templates?waba_id=xxx — list all templates from local DB
router.get('/templates', async (req, res) => {
  try {
    const { waba_id, status, name } = req.query;
    const filter = {};
    if (waba_id) filter.waba_id = waba_id;
    if (status) filter.status = status;
    if (name) filter.name = { $regex: name, $options: 'i' };
    const templates = await col('templates').find(filter).sort({ updated_at: -1 }).toArray();
    res.json(mapIds(templates));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/templates/sync — pull all templates from Meta into local DB
router.post('/templates/sync', express.json(), async (req, res) => {
  try {
    const { waba_id } = req.body;
    if (!waba_id) return res.status(400).json({ error: 'waba_id required' });
    const result = await templateSvc.syncTemplates(waba_id);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/templates — create a new template on Meta
router.post('/templates', express.json(), async (req, res) => {
  try {
    const { waba_id, name, category, language, components, allow_category_change } = req.body;
    if (!waba_id || !name || !components?.length) {
      return res.status(400).json({ error: 'waba_id, name, and components required' });
    }
    const result = await templateSvc.createTemplate(waba_id, {
      name, category, language, components, allow_category_change,
    });
    logActivity({
      actorType: 'admin', actorId: null, actorName: 'Admin',
      action: 'template.created', category: 'template',
      description: `Template "${name}" created on WABA ${waba_id}`,
      resourceType: 'template', resourceId: result?.id || name, severity: 'info',
    });
    res.json(result);
  } catch (e) {
    const metaErr = e.response?.data?.error;
    res.status(metaErr ? 400 : 500).json({ error: metaErr?.message || e.message });
  }
});

// PUT /api/admin/templates/:metaId — update template components on Meta
router.put('/templates/:metaId', express.json(), async (req, res) => {
  try {
    const { components } = req.body;
    if (!components?.length) return res.status(400).json({ error: 'components required' });
    const result = await templateSvc.updateTemplate(req.params.metaId, components);
    res.json(result);
  } catch (e) {
    const metaErr = e.response?.data?.error;
    res.status(metaErr ? 400 : 500).json({ error: metaErr?.message || e.message });
  }
});

// DELETE /api/admin/templates — delete template by name from Meta
router.delete('/templates', express.json(), async (req, res) => {
  try {
    const { waba_id, name } = req.body;
    if (!waba_id || !name) return res.status(400).json({ error: 'waba_id and name required' });
    const result = await templateSvc.deleteTemplate(waba_id, name);
    res.json(result);
  } catch (e) {
    const metaErr = e.response?.data?.error;
    res.status(metaErr ? 400 : 500).json({ error: metaErr?.message || e.message });
  }
});

// GET /api/admin/templates/mappings — get all event-to-template mappings
router.get('/templates/mappings', async (req, res) => {
  try {
    const mappings = await templateSvc.getEventMappings();
    res.json(mappings);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/admin/templates/mappings/:event — update an event mapping
router.put('/templates/mappings/:event', express.json(), async (req, res) => {
  try {
    const { template_name, variables, is_active, description } = req.body;
    const updates = {};
    if (template_name !== undefined) updates.template_name = template_name;
    if (variables !== undefined) updates.variables = variables;
    if (is_active !== undefined) updates.is_active = is_active;
    if (description !== undefined) updates.description = description;
    const result = await templateSvc.updateEventMapping(req.params.event, updates);
    logActivity({
      actorType: 'admin', actorId: null, actorName: 'Admin',
      action: 'template.mapping_updated', category: 'template',
      description: `Template mapping updated for event "${req.params.event}"`,
      resourceType: 'template_mapping', resourceId: req.params.event, severity: 'info',
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/templates/seed — force re-seed default mappings
router.post('/templates/seed', async (req, res) => {
  try {
    await templateSvc.seedDefaultMappings();
    const mappings = await templateSvc.getEventMappings();
    res.json({ seeded: true, mappings });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/templates/notifications — view recent template send logs
router.get('/templates/notifications', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const logs = await col('order_notifications')
      .find({})
      .sort({ sent_at: -1 })
      .limit(limit)
      .toArray();
    res.json(mapIds(logs));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── BUSINESS USERNAMES ────────────────────────────────────────
const usernameSvc = require('../services/username');

// GET /api/admin/usernames — all restaurants with username status
router.get('/usernames', async (req, res) => {
  try {
    const { search, status } = req.query;
    const data = await usernameSvc.getAllUsernameStatuses({ search, statusFilter: status });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/usernames/:waAccountId/check — check availability
router.post('/usernames/:waAccountId/check', express.json(), async (req, res) => {
  try {
    const result = await usernameSvc.checkUsernameAvailability(req.body.username, req.params.waAccountId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/usernames/:waAccountId/set-target — set pending_claim
router.post('/usernames/:waAccountId/set-target', express.json(), async (req, res) => {
  try {
    const result = await usernameSvc.setTargetUsername(req.params.waAccountId, req.body.username);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/admin/usernames/:waAccountId/confirm — confirm as active
router.post('/usernames/:waAccountId/confirm', express.json(), async (req, res) => {
  try {
    const result = await usernameSvc.confirmUsername(req.params.waAccountId, req.body.username);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/admin/usernames/:waAccountId/release — release username
router.post('/usernames/:waAccountId/release', async (req, res) => {
  try {
    const result = await usernameSvc.releaseUsername(req.params.waAccountId);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/admin/usernames/:waAccountId/sync — sync from Meta
router.post('/usernames/:waAccountId/sync', async (req, res) => {
  try {
    const result = await usernameSvc.syncUsernameFromMeta(req.params.waAccountId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/usernames/sync-all — sync all WABAs
router.post('/usernames/sync-all', async (req, res) => {
  try {
    const result = await usernameSvc.syncAllUsernames();
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/usernames/auto-suggest — generate suggestions for all
router.post('/usernames/auto-suggest', async (req, res) => {
  try {
    const result = await usernameSvc.autoSuggestAll();
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/usernames/:waAccountId/suggest — generate suggestions for one
router.post('/usernames/:waAccountId/suggest', async (req, res) => {
  try {
    const acc = await col('whatsapp_accounts').findOne({ _id: req.params.waAccountId });
    if (!acc) return res.status(404).json({ error: 'Account not found' });
    const restaurant = await col('restaurants').findOne({ _id: acc.restaurant_id });
    const suggestions = usernameSvc.generateUsernameSuggestions(
      restaurant?.brand_name || restaurant?.business_name,
      restaurant?.business_name,
      restaurant?.city,
      restaurant?.restaurant_type
    );
    await col('whatsapp_accounts').updateOne({ _id: acc._id }, {
      $set: { username_suggestions: suggestions, username_updated_at: new Date() },
    });
    res.json({ suggestions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── BUSINESS VERIFICATION STATUS ──────────────────────────────
// GET /api/admin/restaurants/:id/verification — check Meta verification status
router.get('/restaurants/:id/verification', async (req, res) => {
  try {
    const restaurant = await col('restaurants').findOne({ _id: req.params.id });
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    const stored = {
      business_verification_status: restaurant.business_verification_status || 'not_started',
      messaging_limit_tier: restaurant.messaging_limit_tier || null,
    };

    // Try to fetch from Meta if business ID available
    if (restaurant.meta_business_id && TOKEN()) {
      try {
        const axios = require('axios');
        const { data } = await axios.get(
          `${GRAPH()}/${restaurant.meta_business_id}`,
          { params: { fields: 'verification_status', access_token: TOKEN() }, timeout: 8000 }
        );
        if (data.verification_status) {
          const status = data.verification_status === 'verified' ? 'verified'
            : data.verification_status === 'pending' ? 'pending' : stored.business_verification_status;
          if (status !== stored.business_verification_status) {
            await col('restaurants').updateOne({ _id: req.params.id }, {
              $set: { business_verification_status: status, updated_at: new Date() },
            });
            stored.business_verification_status = status;
          }
        }
      } catch (err) {
        console.warn(`[WhatsApp2026] Verification status fetch failed:`, err.response?.data?.error?.message || err.message);
      }
    }

    // Fetch messaging limit for the WA account
    const waAcc = await col('whatsapp_accounts').findOne({ restaurant_id: req.params.id, is_active: true });
    if (waAcc?.phone_number_id && TOKEN()) {
      try {
        const axios = require('axios');
        const { data } = await axios.get(
          `${GRAPH()}/${waAcc.phone_number_id}`,
          { params: { fields: 'messaging_limit_tier,quality_rating', access_token: TOKEN() }, timeout: 8000 }
        );
        stored.messaging_limit_tier = data.messaging_limit_tier || null;
        stored.quality_rating = data.quality_rating || null;
        // Store on WA account
        await col('whatsapp_accounts').updateOne({ _id: waAcc._id }, {
          $set: { messaging_limit_tier: data.messaging_limit_tier, quality_rating: data.quality_rating, updated_at: new Date() },
        });
      } catch (err) {
        console.warn(`[WhatsApp2026] Messaging limit fetch failed:`, err.response?.data?.error?.message || err.message);
      }
    }

    res.json(stored);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/admin/restaurants/:id/verification — manually set verification status
router.patch('/restaurants/:id/verification', express.json(), async (req, res) => {
  try {
    const { status } = req.body;
    if (!['not_started', 'pending', 'verified', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    await col('restaurants').updateOne({ _id: req.params.id }, {
      $set: { business_verification_status: status, updated_at: new Date() },
    });
    res.json({ ok: true, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const GRAPH = () => metaConfig.graphUrl;
const TOKEN = () => metaConfig.systemUserToken;

// ═══════════════════════════════════════════════════════════════
// META TOKEN DEBUG
// ═══════════════════════════════════════════════════════════════
router.get('/meta/token-debug', async (req, res) => {
  try {
    const result = await metaConfig.verifyToken();
    res.json({
      systemUserToken: !!metaConfig.systemUserToken,
      catalogToken: !!metaConfig.catalogToken,
      catalogTokenSource: process.env.META_CATALOG_TOKEN ? 'META_CATALOG_TOKEN' : (metaConfig.systemUserToken ? 'META_SYSTEM_USER_TOKEN (fallback)' : 'NONE'),
      appId: metaConfig.appId || null,
      appSecret: !!metaConfig.appSecret,
      businessId: metaConfig.businessId || null,
      apiVersion: metaConfig.apiVersion,
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ACTIVITY MONITORING — GOD-VIEW
// ═══════════════════════════════════════════════════════════════

const actLog = require('../services/activityLog');

// GET /api/admin/activity — global activity feed
router.get('/activity', async (req, res) => {
  try {
    const result = await actLog.getActivities({
      restaurantId: req.query.restaurant_id,
      category: req.query.category,
      action: req.query.action,
      severity: req.query.severity,
      actorType: req.query.actor_type,
      from: req.query.from,
      to: req.query.to,
      search: req.query.search,
    }, {
      page: parseInt(req.query.page) || 1,
      limit: parseInt(req.query.limit) || 50,
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/activity/restaurant/:id — per-restaurant activity
router.get('/activity/restaurant/:id', async (req, res) => {
  try {
    const result = await actLog.getActivities({
      restaurantId: req.params.id,
      category: req.query.category,
      severity: req.query.severity,
      from: req.query.from,
      to: req.query.to,
    }, {
      page: parseInt(req.query.page) || 1,
      limit: parseInt(req.query.limit) || 50,
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/activity/stats — aggregated stats
router.get('/activity/stats', async (req, res) => {
  try {
    const stats = await actLog.getActivityStats();
    res.json(stats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/activity/errors — recent errors + critical
router.get('/activity/errors', async (req, res) => {
  try {
    const result = await actLog.getErrors({
      page: parseInt(req.query.page) || 1,
      limit: parseInt(req.query.limit) || 50,
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/admin/activity/:id/resolve — mark an error/critical event as resolved
router.put('/activity/:id/resolve', async (req, res) => {
  try {
    const result = await col('activity_logs').findOneAndUpdate(
      { _id: req.params.id },
      { $set: { resolved_at: new Date(), resolved_by: 'admin' } },
      { returnDocument: 'after' },
    );
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/webhooks/live — live webhook traffic
router.get('/webhooks/live', async (req, res) => {
  try {
    const match = {};
    if (req.query.source) match.source = req.query.source;
    if (req.query.restaurant_id) match.phone_number_id = { $exists: true }; // approximate filter
    if (req.query.processed === 'true') match.processed = true;
    if (req.query.processed === 'false') match.processed = false;

    const limit = parseInt(req.query.limit) || 30;
    const page = parseInt(req.query.page) || 1;
    const skip = (page - 1) * limit;
    const since = req.query.since ? new Date(req.query.since) : null;
    if (since) match.received_at = { $gt: since };

    const [logs, total] = await Promise.all([
      col('webhook_logs')
        .find(match)
        .sort({ received_at: -1 })
        .skip(skip)
        .limit(limit)
        .project({ payload: 0 }) // exclude large payloads in list view
        .toArray(),
      col('webhook_logs').countDocuments(match),
    ]);

    res.json({ webhooks: logs, total, page, pages: Math.ceil(total / limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/webhooks/:id — single webhook with full payload
router.get('/webhooks/:id', async (req, res) => {
  try {
    const log = await col('webhook_logs').findOne({ _id: req.params.id });
    if (!log) return res.status(404).json({ error: 'Not found' });
    res.json(log);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ISSUES ──────────────────────────────────────────────────────────

// GET /api/admin/issues — list all issues (with filters)
router.get('/issues', async (req, res) => {
  try {
    const { status, category, priority, routed_to, restaurant_id, search, admin_queue, page = 1, limit = 30 } = req.query;
    const filters = { status, category, priority, search };
    if (routed_to) filters.routedTo = routed_to;
    if (restaurant_id) filters.restaurantId = restaurant_id;
    if (admin_queue === 'true') filters.adminQueue = true;
    const result = await issueSvc.listIssues(filters, { page: parseInt(page), limit: parseInt(limit) });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/issues/stats — global issue stats
router.get('/issues/stats', async (req, res) => {
  try {
    const filters = {};
    if (req.query.restaurant_id) filters.restaurantId = req.query.restaurant_id;
    if (req.query.admin_queue === 'true') filters.adminQueue = true;
    const stats = await issueSvc.getIssueStats(filters);
    res.json(stats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/issues/:id — single issue detail
router.get('/issues/:id', async (req, res) => {
  try {
    const issue = await issueSvc.getIssue(req.params.id);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });

    // Enrich with delivery and payment context
    const enriched = { ...issue };
    if (issue.order_id) {
      const order = await col('orders').findOne({ _id: issue.order_id });
      if (order) enriched._order = { status: order.status, total_rs: order.total_rs, payment_status: order.payment_status };
      const delivery = await col('deliveries').findOne({ order_id: issue.order_id });
      if (delivery) enriched._delivery = { provider: delivery.provider, provider_order_id: delivery.provider_order_id, tracking_url: delivery.tracking_url, status: delivery.status, rider_name: delivery.rider_name, rider_phone: delivery.rider_phone };
      const payment = await col('payments').findOne({ order_id: issue.order_id, status: 'paid' });
      if (payment) enriched._payment = { rp_payment_id: payment.rp_payment_id, amount_rs: payment.amount_rs, method: payment.method };
    }
    res.json(enriched);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/admin/issues/:id/status — update status
router.put('/issues/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status required' });
    const updated = await issueSvc.updateStatus(req.params.id, status, {
      actorType: 'admin', actorName: 'GullyBite Admin',
    });
    if (!updated) return res.status(404).json({ error: 'Issue not found' });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/admin/issues/:id/assign — reassign issue
router.put('/issues/:id/assign', async (req, res) => {
  try {
    const { assigned_to, routed_to } = req.body;
    const issue = await issueSvc.getIssue(req.params.id);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });

    const updates = { updated_at: new Date() };
    if (assigned_to) updates.assigned_to = assigned_to;
    if (routed_to) updates.routed_to = routed_to;

    await col('issues').updateOne({ _id: req.params.id }, { $set: updates });
    const updated = await issueSvc.assignIssue(req.params.id, assigned_to || issue.assigned_to, {
      actorType: 'admin', actorName: 'GullyBite Admin',
    });
    logActivity({
      actorType: 'admin', actorId: null, actorName: 'Admin',
      action: 'issue.reassigned', category: 'issue',
      description: `Issue ${req.params.id} reassigned${assigned_to ? ` to ${assigned_to}` : ''}${routed_to ? ` (routed: ${routed_to})` : ''}`,
      resourceType: 'issue', resourceId: req.params.id, severity: 'info',
      metadata: { assigned_to, routed_to },
    });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/issues/:id/message — add message to issue thread
router.post('/issues/:id/message', async (req, res) => {
  try {
    const { text, internal, notify_customer } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });
    const issue = await issueSvc.getIssue(req.params.id);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });

    const msg = await issueSvc.addMessage(req.params.id, {
      senderType: 'admin',
      senderName: 'GullyBite Support',
      text, internal: !!internal, sentVia: 'dashboard',
    });

    // Send to customer via WhatsApp if requested and not internal
    if (notify_customer !== false && !internal) {
      try {
        const waAccount = await col('whatsapp_accounts').findOne({ restaurant_id: issue.restaurant_id });
        if (waAccount) {
          const wa = require('../services/whatsapp');
          const custId = require('../services/customerIdentity');
          const customer = await col('customers').findOne({ _id: issue.customer_id });
          if (customer) {
            const to = custId.resolveRecipient(customer);
            const sysToken = metaConfig.systemUserToken;
            await wa.sendText(waAccount.phone_number_id, sysToken, to,
              `Re: Issue #${issue.issue_number}\n\n${text}`
            );
          }
        }
      } catch (_) {}
    }

    res.json(msg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/issues/:id/refund — process refund (admin only)
router.post('/issues/:id/refund', async (req, res) => {
  try {
    const { amount_rs } = req.body;
    const result = await issueSvc.processRefund(req.params.id, {
      amountRs: amount_rs ? parseFloat(amount_rs) : undefined,
      actorName: 'GullyBite Admin',
    });

    // Notify customer about refund
    try {
      const issue = result.issue;
      const waAccount = await col('whatsapp_accounts').findOne({ restaurant_id: issue.restaurant_id });
      if (waAccount) {
        const wa = require('../services/whatsapp');
        const custId = require('../services/customerIdentity');
        const customer = await col('customers').findOne({ _id: issue.customer_id });
        if (customer) {
          const to = custId.resolveRecipient(customer);
          const sysToken = metaConfig.systemUserToken;
          const amt = result.issue.refund_amount_rs;
          await wa.sendText(waAccount.phone_number_id, sysToken, to,
            `Good news! A refund of ₹${amt} for order #${issue.order_number || ''} has been processed. It will reflect in 5-7 business days.\n\nRefund ref: ${result.refund?.id || ''}`
          );
        }
      }
    } catch (_) {}

    logActivity({
      actorType: 'admin', actorId: null, actorName: 'Admin',
      action: 'issue.refund_issued', category: 'issue',
      description: `Refund of ₹${result.issue?.refund_amount_rs || amount_rs || '?'} issued for issue ${req.params.id}`,
      resourceType: 'issue', resourceId: req.params.id, severity: 'info',
      metadata: { amount_rs: result.issue?.refund_amount_rs || amount_rs },
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/issues/:id/resolve — resolve issue
router.post('/issues/:id/resolve', async (req, res) => {
  try {
    const { resolution_type, resolution_notes, refund_amount_rs, credit_amount_rs } = req.body;
    const updated = await issueSvc.resolveIssue(req.params.id, {
      resolutionType: resolution_type || 'no_action',
      resolutionNotes: resolution_notes || null,
      refundAmountRs: refund_amount_rs ? parseFloat(refund_amount_rs) : null,
      creditAmountRs: credit_amount_rs ? parseFloat(credit_amount_rs) : null,
      actorType: 'admin', actorName: 'GullyBite Admin',
    });
    if (!updated) return res.status(404).json({ error: 'Issue not found' });

    // Notify customer
    try {
      const waAccount = await col('whatsapp_accounts').findOne({ restaurant_id: updated.restaurant_id });
      if (waAccount) {
        const wa = require('../services/whatsapp');
        const custId = require('../services/customerIdentity');
        const customer = await col('customers').findOne({ _id: updated.customer_id });
        if (customer) {
          const to = custId.resolveRecipient(customer);
          const sysToken = metaConfig.systemUserToken;
          await wa.sendText(waAccount.phone_number_id, sysToken, to,
            `Your issue #${updated.issue_number} has been resolved. ${resolution_notes || ''}\n\nIf you're still unsatisfied, reply REOPEN.`
          );
        }
      }
    } catch (_) {}

    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/issues/:id/reopen — reopen issue
router.post('/issues/:id/reopen', async (req, res) => {
  try {
    const updated = await issueSvc.reopenIssue(req.params.id, {
      actorType: 'admin', actorName: 'GullyBite Admin',
      reason: req.body.reason,
    });
    if (!updated) return res.status(404).json({ error: 'Issue not found' });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/issues/:id/flag-settlement — flag refund for settlement deduction
router.post('/issues/:id/flag-settlement', async (req, res) => {
  try {
    const { deduct_from, amount_rs, notes } = req.body;
    // deduct_from: "restaurant" | "platform" | "3pl"
    const issue = await issueSvc.getIssue(req.params.id);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });

    await col('issues').updateOne({ _id: req.params.id }, {
      $set: {
        settlement_flag: { deduct_from: deduct_from || 'restaurant', amount_rs: parseFloat(amount_rs) || issue.refund_amount_rs, notes },
        updated_at: new Date(),
      },
    });

    // If deducting from restaurant's settlement
    if (deduct_from === 'restaurant' && issue.order_id) {
      await col('orders').updateOne({ _id: issue.order_id }, {
        $set: { settlement_deduction_rs: parseFloat(amount_rs) || issue.refund_amount_rs, settlement_deduction_reason: `Issue ${issue.issue_number}`, updated_at: new Date() },
      });
    }

    await issueSvc.addMessage(req.params.id, {
      senderType: 'admin', senderName: 'GullyBite Admin',
      text: `Flagged for settlement: deduct ₹${amount_rs || issue.refund_amount_rs} from ${deduct_from || 'restaurant'}`,
      internal: true, sentVia: 'dashboard',
    });

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── FINANCIAL ENDPOINTS ────────────────────────────────────────

// GET /api/admin/financials/overview
router.get('/financials/overview', async (req, res) => {
  try {
    const overview = await financials.getPlatformOverview(req.query.period, req.query.from, req.query.to);
    res.json(overview);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/financials/restaurant/:id
router.get('/financials/restaurant/:id', async (req, res) => {
  try {
    const summary = await financials.getFinancialSummary(req.params.id, req.query.period || '30d', req.query.from, req.query.to);
    res.json(summary);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/financials/settlements
router.get('/financials/settlements', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const skip = (page - 1) * limit;
    const match = {};
    if (req.query.restaurant_id) match.restaurant_id = req.query.restaurant_id;
    if (req.query.status) match.payout_status = req.query.status;
    const [settlements, total] = await Promise.all([
      col('settlements').find(match).sort({ period_end: -1 }).skip(skip).limit(limit).toArray(),
      col('settlements').countDocuments(match),
    ]);
    // Enrich with restaurant names
    const restIds = [...new Set(settlements.map(s => s.restaurant_id))];
    const restaurants = restIds.length
      ? await col('restaurants').find({ _id: { $in: restIds } }, { projection: { business_name: 1 } }).toArray()
      : [];
    const rMap = Object.fromEntries(restaurants.map(r => [String(r._id), r.business_name]));
    const enriched = settlements.map(s => ({ ...s, business_name: rMap[s.restaurant_id] || s.restaurant_id }));
    res.json({ settlements: enriched, total, page, pages: Math.ceil(total / limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/financials/payments
router.get('/financials/payments', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const skip = (page - 1) * limit;
    const match = {};
    if (req.query.status) match.status = req.query.status;
    if (req.query.from || req.query.to) {
      match.created_at = {};
      if (req.query.from) match.created_at.$gte = new Date(req.query.from);
      if (req.query.to) match.created_at.$lte = new Date(req.query.to);
    }
    const [payments, total] = await Promise.all([
      col('payments').find(match).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
      col('payments').countDocuments(match),
    ]);
    res.json({ payments, total, page, pages: Math.ceil(total / limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/financials/refunds
router.get('/financials/refunds', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const skip = (page - 1) * limit;
    const match = { status: 'refunded' };
    if (req.query.from || req.query.to) {
      match.updated_at = {};
      if (req.query.from) match.updated_at.$gte = new Date(req.query.from);
      if (req.query.to) match.updated_at.$lte = new Date(req.query.to);
    }
    const [refunds, total] = await Promise.all([
      col('payments').find(match).sort({ updated_at: -1 }).skip(skip).limit(limit).toArray(),
      col('payments').countDocuments(match),
    ]);
    res.json({ refunds, total, page, pages: Math.ceil(total / limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/financials/tax
router.get('/financials/tax', async (req, res) => {
  try {
    const summary = await financials.getPlatformTaxSummary(req.query.fy);
    res.json(summary);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// IMAGE CLEANUP — ORPHAN DETECTION
// ═══════════════════════════════════════════════════════════════

// POST /api/admin/images/cleanup — find (and optionally delete) orphan S3 images
router.post('/images/cleanup', async (req, res) => {
  const restaurantId = req.query.restaurantId;
  const doDelete = req.query.delete === 'true';

  try {
    const imgSvc = require('../services/imageUpload');
    const prefix = restaurantId || '';

    // List all S3 keys
    const s3Objects = await imgSvc.listS3Keys(prefix);
    if (!s3Objects.length) return res.json({ orphans: 0, total_keys: 0, total_size_mb: 0 });

    // Collect all referenced S3 keys from the database
    const referencedKeys = new Set();

    const items = await col('menu_items').find(
      restaurantId ? { restaurant_id: restaurantId } : {},
      { projection: { image_s3_key: 1, thumbnail_s3_key: 1 } }
    ).toArray();
    items.forEach(i => { if (i.image_s3_key) referencedKeys.add(i.image_s3_key); if (i.thumbnail_s3_key) referencedKeys.add(i.thumbnail_s3_key); });

    const restaurants = await col('restaurants').find(
      restaurantId ? { _id: restaurantId } : {},
      { projection: { logo_s3_key: 1 } }
    ).toArray();
    restaurants.forEach(r => { if (r.logo_s3_key) referencedKeys.add(r.logo_s3_key); });

    const branches = await col('branches').find(
      restaurantId ? { restaurant_id: restaurantId } : {},
      { projection: { photo_s3_key: 1 } }
    ).toArray();
    branches.forEach(b => { if (b.photo_s3_key) referencedKeys.add(b.photo_s3_key); });

    // Find orphans (skip placeholders directory)
    const orphans = s3Objects.filter(o => !o.key.startsWith('placeholders/') && !referencedKeys.has(o.key));
    const orphanSizeMb = orphans.reduce((s, o) => s + (o.size || 0), 0) / (1024 * 1024);

    if (doDelete && orphans.length > 0) {
      await imgSvc.deleteImages(orphans.map(o => o.key));
    }

    res.json({
      total_keys: s3Objects.length,
      total_size_mb: parseFloat((s3Objects.reduce((s, o) => s + (o.size || 0), 0) / (1024 * 1024)).toFixed(2)),
      orphans: orphans.length,
      orphan_size_mb: parseFloat(orphanSizeMb.toFixed(2)),
      deleted: doDelete ? orphans.length : 0,
      orphan_keys: doDelete ? [] : orphans.slice(0, 100).map(o => o.key),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/images/stats — platform-wide image stats
router.get('/images/stats', async (req, res) => {
  try {
    const [total, withImage, rehosted, rehostFailed] = await Promise.all([
      col('menu_items').countDocuments({ is_available: true }),
      col('menu_items').countDocuments({ is_available: true, image_url: { $ne: null } }),
      col('menu_items').countDocuments({ image_source: 'pos_rehosted' }),
      col('menu_items').countDocuments({ image_rehost_failed: true }),
    ]);
    res.json({
      total, with_image: withImage, without_image: total - withImage,
      coverage_pct: total ? Math.round(withImage / total * 100) : 0,
      rehosted, rehost_failed: rehostFailed,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// CATALOG MIGRATION — promote branch catalogs to main restaurant catalog
// ═══════════════════════════════════════════════════════════════
const catalog = require('../services/catalog');

router.post('/migrate-catalogs', requireAdmin, async (req, res) => {
  try {
    const restaurants = await col('restaurants').find({ meta_catalog_id: { $in: [null, undefined, ''] } }).toArray();
    const results = { migrated: 0, skipped: 0, errors: [] };

    for (const rest of restaurants) {
      try {
        // Find any branch that has a catalog_id
        const branchWithCatalog = await col('branches').findOne({
          restaurant_id: String(rest._id),
          catalog_id: { $exists: true, $ne: null, $ne: '' },
        });

        if (branchWithCatalog) {
          // Promote branch catalog to restaurant main catalog
          await col('restaurants').updateOne(
            { _id: rest._id },
            { $set: {
              meta_catalog_id: branchWithCatalog.catalog_id,
              meta_catalog_name: `${rest.business_name || rest.name} Menu`,
              catalog_created_at: new Date(),
            }}
          );

          // Set same catalog_id on all branches
          await col('branches').updateMany(
            { restaurant_id: String(rest._id) },
            { $set: { catalog_id: branchWithCatalog.catalog_id } }
          );

          results.migrated++;
          console.log(`[Migration] Promoted catalog ${branchWithCatalog.catalog_id} to main for "${rest.business_name}"`);
        } else {
          results.skipped++;
        }
      } catch (err) {
        results.errors.push(`${rest.business_name}: ${err.message}`);
      }
    }

    res.json({ success: true, ...results, total: restaurants.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/migrate-catalog-architecture
// Full migration: branch_slug, branch-encoded retailer_ids, item_group_ids, catalog promotion
router.post('/migrate-catalog-architecture', requireAdmin, async (req, res) => {
  try {
    const stats = { branches_slugged: 0, items_retagged: 0, groups_set: 0, errors: [] };

    function slugify(str, max = 40) {
      return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, max);
    }

    // 1. Generate branch_slug for all branches missing one
    const branches = await col('branches').find({ $or: [{ branch_slug: null }, { branch_slug: { $exists: false } }] }).toArray();
    for (const b of branches) {
      const slug = slugify(b.name, 20) || String(b._id).slice(0, 8);
      await col('branches').updateOne({ _id: b._id }, { $set: { branch_slug: slug } });
      stats.branches_slugged++;
    }

    // Build branch_slug lookup
    const allBranches = await col('branches').find({}).toArray();
    const slugMap = {}; // branchId → slug
    for (const b of allBranches) slugMap[String(b._id)] = b.branch_slug || slugify(b.name, 20) || String(b._id).slice(0, 8);

    // 2. Re-generate retailer_ids to be branch-encoded for items with old format (ZM- prefix)
    const oldItems = await col('menu_items').find({ retailer_id: /^ZM-/ }).toArray();
    for (const item of oldItems) {
      const branchSlug = slugMap[item.branch_id] || 'branch';
      const sizeVal = item.size || item.variant_value || null;
      const itemSlug = slugify(item.name, 40);
      const newRetailerId = sizeVal
        ? `${branchSlug}-${itemSlug}-${slugify(sizeVal, 15)}`
        : `${branchSlug}-${itemSlug}`;

      const update = { retailer_id: newRetailerId, catalog_sync_status: 'pending' };

      // Auto-generate item_group_id for variants
      if (sizeVal && !item.item_group_id) {
        update.item_group_id = `${branchSlug}-${itemSlug}`;
        stats.groups_set++;
      }

      await col('menu_items').updateOne({ _id: item._id }, { $set: update });
      stats.items_retagged++;
    }

    // 3. Generate item_group_id for items with size but no group (non-ZM items too)
    const ungrouped = await col('menu_items').find({
      size: { $exists: true, $ne: null, $ne: '' },
      item_group_id: { $in: [null, undefined, ''] },
    }).toArray();
    for (const item of ungrouped) {
      const branchSlug = slugMap[item.branch_id] || 'branch';
      const groupId = `${branchSlug}-${slugify(item.name, 40)}`;
      await col('menu_items').updateOne({ _id: item._id }, { $set: { item_group_id: groupId } });
      stats.groups_set++;
    }

    console.log('[Migration] Catalog architecture migration complete:', stats);
    res.json({ success: true, ...stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// WHATSAPP FLOW MANAGEMENT (Platform-level)
// ═══════════════════════════════════════════════════════════════
const flowMgr = require('../services/flowManager');

// GET /api/admin/flow — get current platform Flow status
router.get('/flow', async (req, res) => {
  try {
    const setting = await col('platform_settings').findOne({ _id: 'whatsapp_flow' });
    const restaurantCount = await col('restaurants').countDocuments({ flow_id: { $ne: null } });
    const totalRestaurants = await col('restaurants').countDocuments({});
    res.json({ ...setting, assigned_restaurants: restaurantCount, total_restaurants: totalRestaurants });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/flow/create — create Flow on Meta + save to platform_settings
router.post('/flow/create', async (req, res) => {
  try {
    const existing = await col('platform_settings').findOne({ _id: 'whatsapp_flow' });
    if (existing?.flow_id) {
      return res.json({ success: true, already_exists: true, flow_id: existing.flow_id });
    }

    // Use the platform WABA (from first active WA account or env)
    const wa = await col('whatsapp_accounts').findOne({ is_active: true });
    const wabaId = wa?.waba_id;
    if (!wabaId) return res.status(400).json({ error: 'No active WABA found on platform.' });

    const result = await flowMgr.createDeliveryFlow(wabaId);
    if (!result.success) return res.status(400).json(result);

    await col('platform_settings').updateOne(
      { _id: 'whatsapp_flow' },
      { $set: { flow_id: result.flowId, flow_name: 'GullyBite Delivery Address', flow_status: result.published ? 'PUBLISHED' : 'DRAFT', flow_json_version: '6.2', auto_assign_new: true, updated_at: new Date() }, $setOnInsert: { created_at: new Date() } },
      { upsert: true }
    );

    res.json({ success: true, flow_id: result.flowId, published: result.published });
  } catch (e) {
    console.error('[Admin Flow] Create error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.error?.message || e.message, validation_errors: e.response?.data?.validation_errors });
  }
});

// GET /api/admin/flow/preview — get Flow preview URL
router.get('/flow/preview', async (req, res) => {
  try {
    const setting = await col('platform_settings').findOne({ _id: 'whatsapp_flow' });
    if (!setting?.flow_id) return res.status(404).json({ error: 'No Flow created yet.' });
    const data = await flowMgr.getFlowPreview(setting.flow_id);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.response?.data?.error?.message || e.message }); }
});

// POST /api/admin/flow/update — re-upload Flow JSON
router.post('/flow/update', async (req, res) => {
  try {
    const setting = await col('platform_settings').findOne({ _id: 'whatsapp_flow' });
    if (!setting?.flow_id) return res.status(404).json({ error: 'No Flow created yet.' });
    const data = await flowMgr.updateFlowJson(setting.flow_id);
    await col('platform_settings').updateOne({ _id: 'whatsapp_flow' }, { $set: { updated_at: new Date() } });
    res.json({ success: true, ...data });
  } catch (e) { res.status(500).json({ error: e.response?.data?.error?.message || e.message, validation_errors: e.response?.data?.validation_errors }); }
});

// POST /api/admin/flow/publish — publish a draft Flow
router.post('/flow/publish', async (req, res) => {
  try {
    const setting = await col('platform_settings').findOne({ _id: 'whatsapp_flow' });
    if (!setting?.flow_id) return res.status(404).json({ error: 'No Flow created yet.' });
    const data = await flowMgr.publishFlow(setting.flow_id);
    await col('platform_settings').updateOne({ _id: 'whatsapp_flow' }, { $set: { flow_status: 'PUBLISHED', updated_at: new Date() } });
    res.json({ success: true, ...data });
  } catch (e) { res.status(500).json({ error: e.response?.data?.error?.message || e.message }); }
});

// POST /api/admin/flow/deprecate — deprecate the Flow
router.post('/flow/deprecate', async (req, res) => {
  try {
    const setting = await col('platform_settings').findOne({ _id: 'whatsapp_flow' });
    if (!setting?.flow_id) return res.status(404).json({ error: 'No Flow created yet.' });
    await flowMgr.deprecateFlow(setting.flow_id);
    await col('platform_settings').updateOne({ _id: 'whatsapp_flow' }, { $set: { flow_status: 'DEPRECATED', flow_id: null, updated_at: new Date() } });
    // Clear flow_id from all restaurants
    await col('restaurants').updateMany({}, { $set: { flow_id: null } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.response?.data?.error?.message || e.message }); }
});

// POST /api/admin/flow/assign-all — assign platform Flow to all restaurants
router.post('/flow/assign-all', async (req, res) => {
  try {
    const setting = await col('platform_settings').findOne({ _id: 'whatsapp_flow' });
    if (!setting?.flow_id) return res.status(404).json({ error: 'No Flow created yet.' });
    const result = await col('restaurants').updateMany({}, { $set: { flow_id: setting.flow_id } });
    res.json({ success: true, assigned: result.modifiedCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/flow/toggle-auto-assign', async (req, res) => {
  try {
    const { enabled } = req.body;
    await col('platform_settings').updateOne(
      { _id: 'whatsapp_flow' },
      { $set: { auto_assign_new: !!enabled, updated_at: new Date() } }
    );
    res.json({ success: true, auto_assign_new: !!enabled });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
