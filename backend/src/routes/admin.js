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

    // Auto-list in WhatsApp directory (fire-and-forget)
    const directory = require('../services/directory');
    directory.listRestaurant(req.params.id).catch(err =>
      console.error('[Directory] Auto-list failed:', err.message)
    );

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

module.exports = router;
