// src/routes/admin.js
// Admin-only REST API for the GullyBite management dashboard.
// All routes (except /auth + /auth/setup) require a valid admin JWT via
// Authorization: Bearer <token>. See middleware/adminAuth.js.

const express = require('express');
const router  = express.Router();
const { col, newId, mapId, mapIds } = require('../config/database');
const { runSettlement } = require('../jobs/settlement');
const { logActivity } = require('../services/activityLog');
const issueSvc = require('../services/issues');
const axios = require('axios');
const metaConfig = require('../config/meta');
const financials = require('../services/financials');
const wa = require('../services/whatsapp');
const ws = require('../services/websocket');
const { CONFIRMED_ORDER_STATES } = require('../core/orderStateEngine');
const slugify = require('../utils/slugify');
const log = require('../utils/logger').child({ component: 'admin' });

// ─── AUTH MIDDLEWARE (RBAC) ───────────────────────────────────
const bcrypt = require('bcryptjs');
const { requireAdminAuth, signAdminToken } = require('../middleware/adminAuth');
const { rateLimitFn } = require('../middleware/rateLimit');

// Legacy compatibility: simple requireAdmin still works for existing route-level guards
const requireAdmin = requireAdminAuth();

// Admin login limiter: 10 attempts per 15 min per IP.
const adminLoginLimiter = rateLimitFn(
  (r) => `admin_auth:${r.ip || r.headers['x-forwarded-for'] || 'unknown'}`,
  10,
  15 * 60,
  { message: 'Too many login attempts. Please try again in a few minutes.' }
);

// ─── AUTH ENDPOINTS ─────────────────────────────────────────
// POST /api/admin/auth — JWT-based admin login (email + password)
router.post('/auth', adminLoginLimiter, express.json(), async (req, res) => {
  const { email, password } = req.body;

  // JWT-based email+password login
  if (email && password) {
    try {
      const user = await col('admin_users').findOne({ email: email.toLowerCase().trim(), is_active: true });
      if (!user) return res.status(403).json({ error: 'Invalid email or password' });
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(403).json({ error: 'Invalid email or password' });

      const token = signAdminToken(user);
      await col('admin_users').updateOne({ _id: user._id }, { $set: { last_login: new Date() }, $inc: { login_count: 1 } });
      logActivity({ actorType: 'admin', actorId: String(user._id), actorName: user.name, action: 'admin.login', category: 'auth', description: `Admin ${user.email} logged in`, severity: 'info' });

      return res.json({ ok: true, token, user: { id: String(user._id), name: user.name, email: user.email, role: 'admin', admin_tier: user.role, permissions: user.permissions } });
    } catch (e) { return res.status(500).json({ success: false, message: "Internal server error" }); }
  }

  // Check if any admin users exist (for first-run setup detection)
  if (req.body.check_setup) {
    const count = await col('admin_users').countDocuments({});
    return res.json({ setup_required: count === 0 });
  }

  return res.status(403).json({ error: 'Invalid credentials' });
});

// GET /api/admin/auth/setup-status — public endpoint so the AdminLogin page
// can decide between showing the setup form (first-run) vs the login form.
// Response is deliberately minimal: boolean only, no counts or emails.
router.get('/auth/setup-status', adminLoginLimiter, async (req, res) => {
  try {
    const count = await col('admin_users').countDocuments({ role: 'super_admin' });
    return res.json({ needs_setup: count === 0 });
  } catch (e) {
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// POST /api/admin/auth/setup — first-run super admin creation. Rejects with
// 403 setup_already_complete once any super_admin exists. The server-side
// recheck inside the handler is the actual gate; the setup-status endpoint
// is only a UI hint and cannot be relied on for authorization.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
router.post('/auth/setup', adminLoginLimiter, express.json(), async (req, res) => {
  try {
    const superCount = await col('admin_users').countDocuments({ role: 'super_admin' });
    if (superCount > 0) return res.status(403).json({ error: 'setup_already_complete' });

    const { email, password, name } = req.body || {};
    const emailStr = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const nameStr = typeof name === 'string' ? name.trim() : '';
    const pwStr = typeof password === 'string' ? password : '';

    if (!EMAIL_RE.test(emailStr)) return res.status(400).json({ error: 'invalid_email' });
    if (pwStr.length < 12) return res.status(400).json({ error: 'password_too_short' });
    if (nameStr.length < 2) return res.status(400).json({ error: 'name_too_short' });

    const hash = await bcrypt.hash(pwStr, 12);
    const user = {
      _id: newId(), email: emailStr, password_hash: hash,
      name: nameStr, phone: null, role: 'super_admin', permissions: {},
      is_active: true, last_login: null, login_count: 0, token_version: 0,
      created_by: 'setup', created_at: new Date(), updated_at: new Date(),
    };
    await col('admin_users').createIndex({ email: 1 }, { unique: true }).catch(() => {});
    try {
      await col('admin_users').insertOne(user);
    } catch (insertErr) {
      // Duplicate-key race: someone else inserted the same email / a super_admin
      // between our super_admin check and this insert. Treat as "already complete".
      if (insertErr?.code === 11000) {
        return res.status(403).json({ error: 'setup_already_complete' });
      }
      throw insertErr;
    }
    logActivity({ actorType: 'admin', actorId: String(user._id), actorName: user.name, action: 'admin.setup', category: 'auth', description: `First-run super admin created: ${user.email}`, severity: 'info' });
    const token = signAdminToken(user);
    return res.json({ ok: true, token, user: { id: user._id, name: user.name, email: user.email, role: 'admin', admin_tier: user.role, permissions: {} } });
  } catch (e) {
    log.error({ err: e }, 'admin /auth/setup failed');
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// GET /api/admin/auth/me — current admin user profile
router.get('/auth/me', requireAdminAuth(), async (req, res) => {
  const u = req.adminUser;
  res.json({ id: u._id, name: u.name, email: u.email, role: 'admin', admin_tier: u.role, permissions: u.permissions || {}, phone: u.phone });
});

// POST /api/admin/auth/change-password
router.post('/auth/change-password', requireAdminAuth(), express.json(), async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: 'Both passwords required' });
    if (new_password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const user = await col('admin_users').findOne({ _id: req.adminUser._id });
    if (!user?.password_hash) return res.status(400).json({ error: 'Cannot change password for legacy accounts' });
    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) return res.status(403).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(new_password, 12);
    await col('admin_users').updateOne(
      { _id: user._id },
      { $set: { password_hash: hash, updated_at: new Date() }, $inc: { token_version: 1 } }
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/admin/auth/logout — invalidates every outstanding token for this admin
router.post('/auth/logout', requireAdminAuth(), async (req, res) => {
  try {
    await col('admin_users').updateOne(
      { _id: req.adminUser._id },
      { $inc: { token_version: 1 }, $set: { updated_at: new Date() } }
    );
    res.json({ message: 'Logged out successfully' });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── ADMIN USER MANAGEMENT (super_admin only) ────────────────
router.get('/users', requireAdminAuth('admin_users', 'manage'), async (req, res) => {
  try {
    const users = await col('admin_users').find({}, { projection: { password_hash: 0 } }).sort({ created_at: -1 }).toArray();
    res.json(mapIds(users));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.post('/users', requireAdminAuth('admin_users', 'manage'), express.json(), async (req, res) => {
  try {
    const { email, password, name, phone, role, permissions } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (role === 'super_admin') return res.status(400).json({ error: 'Cannot create additional super admins' });
    const hash = await bcrypt.hash(password, 12);
    const user = {
      _id: newId(), email: email.toLowerCase().trim(), password_hash: hash,
      name: name || '', phone: phone || null, role: role || 'admin', permissions: permissions || {},
      is_active: true, last_login: null, login_count: 0, token_version: 0, created_by: req.adminUser?._id || 'admin', created_at: new Date(), updated_at: new Date(),
    };
    await col('admin_users').insertOne(user);
    logActivity({
      actorType: 'admin', actorId: String(req.adminUser?._id), actorName: req.adminUser?.name || req.adminUser?.email,
      action: 'admin.user.created', category: 'admin_users',
      description: `Admin user created: ${email} (role: ${role || 'admin'})`,
      resourceType: 'admin_user', resourceId: String(user._id), severity: 'warning',
    });
    const { password_hash, ...safe } = user;
    res.json(mapId(safe));
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ error: 'Email already in use' });
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

router.put('/users/:id', requireAdminAuth('admin_users', 'manage'), express.json(), async (req, res) => {
  try {
    const { name, phone, role, permissions, is_active, customer_full_phone } = req.body;
    const target = await col('admin_users').findOne({ _id: req.params.id });
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'super_admin' && req.adminUser._id !== target._id) return res.status(403).json({ error: 'Cannot modify super admin' });
    const $set = { updated_at: new Date() };
    if (name !== undefined) $set.name = name;
    if (phone !== undefined) $set.phone = phone;
    if (role !== undefined && role !== 'super_admin') $set.role = role;
    if (permissions !== undefined) $set.permissions = permissions;
    if (is_active !== undefined) $set.is_active = is_active;

    // CRIT-3B-01: customer_full_phone is a sensitive PII-escalation toggle.
    // Only super_admin can grant/revoke it. Non-super_admin requests are
    // silently ignored (per spec) so routine edits don't 403 just because
    // the UI sent the field for read-back parity.
    if (customer_full_phone !== undefined && req.adminUser?.role === 'super_admin') {
      const nextPerms = permissions !== undefined
        ? { ...(permissions || {}) }
        : { ...(target.permissions || {}) };
      nextPerms.customer_full_phone = !!customer_full_phone;
      $set.permissions = nextPerms;
    }
    // Deactivation must invalidate any outstanding JWT for this admin
    const $update = { $set };
    if (is_active === false) $update.$inc = { token_version: 1 };
    await col('admin_users').updateOne({ _id: req.params.id }, $update);
    logActivity({
      actorType: 'admin', actorId: String(req.adminUser?._id), actorName: req.adminUser?.name || req.adminUser?.email,
      action: 'admin.user.updated', category: 'admin_users',
      description: `Admin user updated: ${target.email}${is_active === false ? ' (deactivated)' : ''}`,
      resourceType: 'admin_user', resourceId: req.params.id, severity: is_active === false ? 'warning' : 'info',
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.post('/users/:id/reset-password', requireAdminAuth('admin_users', 'manage'), express.json(), async (req, res) => {
  try {
    const { new_password } = req.body;
    if (!new_password || new_password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const hash = await bcrypt.hash(new_password, 12);
    await col('admin_users').updateOne(
      { _id: req.params.id },
      { $set: { password_hash: hash, updated_at: new Date() }, $inc: { token_version: 1 } }
    );
    logActivity({
      actorType: 'admin', actorId: String(req.adminUser?._id), actorName: req.adminUser?.name || req.adminUser?.email,
      action: 'admin.user.password_reset', category: 'admin_users',
      description: `Admin password reset for user ${req.params.id}`,
      resourceType: 'admin_user', resourceId: req.params.id, severity: 'warning',
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// All routes below require admin auth (any level)
router.use(requireAdminAuth());

// ─── PLATFORM ALERTS ────────────────────────────────────────
router.get('/alerts', async (req, res) => {
  try {
    const alerts = await col('platform_alerts').find({ acknowledged: false }).sort({ created_at: -1 }).limit(20).toArray();
    res.json(alerts);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.post('/alerts/:id/acknowledge', async (req, res) => {
  try {
    await col('platform_alerts').updateOne({ _id: req.params.id }, { $set: { acknowledged: true, acknowledged_at: new Date() } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── GET /api/admin/stats ─────────────────────────────────────
// ─── BRANCH-FIRST INSIGHTS ────────────────────────────────────
// Unassigned product count, branch activity, sync skip metrics —
// vocabulary mirrors middleware/branchGuard.js REASONS.
router.get('/branch-insights', requireAdmin, async (req, res) => {
  try {
    const restaurantId = req.query.restaurant_id || null;
    const productScope = restaurantId ? { restaurant_id: restaurantId } : {};
    const branchScope  = restaurantId ? { restaurant_id: restaurantId } : {};
    const since        = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const skipScope    = { at: { $gte: since } };

    const [
      totalProducts, unassignedProducts,
      totalBranches, activeBranches, branchesMissingFssai,
      skipAgg,
    ] = await Promise.all([
      col('menu_items').countDocuments(productScope),
      col('menu_items').countDocuments({
        ...productScope,
        $or: [{ is_unassigned: true }, { branch_ids: { $size: 0 } }, { branch_ids: { $exists: false } }],
      }),
      col('branches').countDocuments(branchScope),
      col('branches').countDocuments({ ...branchScope, is_active: { $ne: false } }),
      col('branches').countDocuments({
        ...branchScope,
        $or: [{ fssai_number: { $exists: false } }, { fssai_number: null }, { fssai_number: '' }],
      }),
      col('catalog_sync_skips').aggregate([
        { $match: skipScope },
        { $group: { _id: '$reason', count: { $sum: 1 } } },
      ]).toArray().catch(() => []),
    ]);

    const skipped_by_reason = Object.fromEntries(skipAgg.map(s => [s._id, s.count]));
    const skipped_total = skipAgg.reduce((s, r) => s + r.count, 0);

    res.json({
      products: { total: totalProducts, unassigned: unassignedProducts, assigned: totalProducts - unassignedProducts },
      branches: { total: totalBranches, active: activeBranches, missing_fssai: branchesMissingFssai },
      sync_last_7d: { skipped_total, skipped_by_reason },
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    log.error({ err: e }, 'branch-insights failed');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ─── SYNC LOGS ────────────────────────────────────────────────
// Per-product Meta sync audit. Filters: restaurant_id, status,
// from/to (ISO), branch_id, reason. Results capped at 500/page.
router.get('/sync-logs', requireAdmin, async (req, res) => {
  try {
    const { restaurant_id, status, branch_id, reason, from, to } = req.query;
    const limit  = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const q = {};
    if (restaurant_id) q.restaurant_id = restaurant_id;
    if (status)        q.status = status;
    if (branch_id)     q.branch_id = branch_id;
    if (reason)        q.reason = reason;
    if (from || to) {
      q.timestamp = {};
      if (from) q.timestamp.$gte = new Date(from);
      if (to)   q.timestamp.$lte = new Date(to);
    }

    const [rows, total] = await Promise.all([
      col('sync_logs').find(q).sort({ timestamp: -1 }).skip(offset).limit(limit).toArray(),
      col('sync_logs').countDocuments(q),
    ]);

    // Hydrate display names for the admin table — keeps the frontend
    // simple by avoiding per-row joins on the client.
    const restIds   = [...new Set(rows.map(r => r.restaurant_id))];
    const productIds= [...new Set(rows.map(r => r.product_id))];
    const branchIds = [...new Set(rows.map(r => r.branch_id))];
    const [rests, prods, brs] = await Promise.all([
      col('restaurants').find({ _id: { $in: restIds } }).toArray(),
      col('menu_items').find({ _id: { $in: productIds } }).toArray(),
      col('branches').find({ _id: { $in: branchIds } }).toArray(),
    ]);
    const rN = Object.fromEntries(rests.map(r => [r._id, r.business_name || r.brand_name]));
    const pN = Object.fromEntries(prods.map(p => [p._id, p.name]));
    const bN = Object.fromEntries(brs.map(b => [b._id, b.name]));

    res.json({
      total, limit, offset,
      logs: rows.map(r => ({
        id: r._id,
        restaurant_id: r.restaurant_id, restaurant_name: rN[r.restaurant_id] || '—',
        product_id: r.product_id,       product_name:    pN[r.product_id] || '—',
        branch_id: r.branch_id,         branch_name:     bN[r.branch_id] || '—',
        status: r.status, reason: r.reason, timestamp: r.timestamp,
        suggestion: r.suggestion || null,
      })),
    });
  } catch (e) {
    log.error({ err: e }, 'sync-logs query failed');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ─── META SYNC ALERTS ───────────────────────────────────────
// Lists rows from the new `alerts` collection (META_SYNC_FAILURE,
// etc). Distinct from the legacy `/alerts` endpoint above which
// reads the older `platform_alerts` collection — kept for back-compat.
router.get('/meta-alerts', requireAdmin, async (req, res) => {
  try {
    const { restaurant_id, status, type, from, to } = req.query;
    const limit  = Math.min(parseInt(req.query.limit, 10) || 100, 500);

    const q = {};
    if (restaurant_id) q.restaurant_id = restaurant_id;
    if (status)        q.status = status;
    if (type)          q.type = type;
    if (from || to) {
      q.timestamp = {};
      if (from) q.timestamp.$gte = new Date(from);
      if (to)   q.timestamp.$lte = new Date(to);
    }

    const [rows, total] = await Promise.all([
      col('alerts').find(q).sort({ timestamp: -1 }).limit(limit).toArray(),
      col('alerts').countDocuments(q),
    ]);

    const restIds = [...new Set(rows.map(r => r.restaurant_id))];
    const rests   = await col('restaurants').find({ _id: { $in: restIds } }).toArray();
    const rN      = Object.fromEntries(rests.map(r => [r._id, r.business_name || r.brand_name]));

    res.json({
      total, limit,
      alerts: rows.map(r => ({
        id: r._id,
        restaurant_id: r.restaurant_id, restaurant_name: rN[r.restaurant_id] || '—',
        type: r.type, message: r.message,
        failure_rate: r.failure_rate, context: r.context || {},
        status: r.status, timestamp: r.timestamp,
      })),
    });
  } catch (e) {
    log.error({ err: e }, 'meta-alerts query failed');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Resolve a meta-alert (flip status: active → resolved).
router.post('/meta-alerts/:id/resolve', requireAdmin, async (req, res) => {
  try {
    await col('alerts').updateOne(
      { _id: req.params.id },
      { $set: { status: 'resolved', resolved_at: new Date() } },
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

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
      col('orders').countDocuments({ status: { $in: CONFIRMED_ORDER_STATES } }),
      col('orders').countDocuments({ status: 'DELIVERED' }),
      col('orders').countDocuments({ status: { $in: ['PENDING_PAYMENT', 'PAYMENT_FAILED'] } }),
      col('orders').countDocuments({ status: 'CANCELLED' }),
      col('orders').countDocuments({ status: { $in: CONFIRMED_ORDER_STATES }, created_at: { $gt: yesterday } }),
      col('orders').find({ status: { $in: CONFIRMED_ORDER_STATES } }).project({ total_rs: 1 }).toArray(),
      col('orders').find({ status: { $in: CONFIRMED_ORDER_STATES }, created_at: { $gt: yesterday } }).project({ total_rs: 1 }).toArray(),
      col('orders').find({ status: { $in: CONFIRMED_ORDER_STATES }, created_at: { $gt: lastWeek } }).project({ total_rs: 1 }).toArray(),
      col('customers').countDocuments({}),
      col('customers').countDocuments({ created_at: { $gt: yesterday } }),
      col('webhook_logs').countDocuments({}),
      col('webhook_logs').countDocuments({ processed: false }),
      col('webhook_logs').countDocuments({ error_message: { $ne: null } }),
    ]);

    const sumRs = (arr) => arr.reduce((s, o) => s + (parseFloat(o.total_rs) || 0), 0);

    // Fetch missed-sale count separately (non-blocking)
    const [expiredCount, paymentFailedCount] = await Promise.all([
      col('orders').countDocuments({ status: 'EXPIRED' }),
      col('orders').countDocuments({ status: 'PAYMENT_FAILED' }),
    ]);

    res.json({
      restaurants: { total: totalRestaurants, active: activeRestaurants },
      orders     : { total: totalOrders, delivered: deliveredOrders, pending: pendingOrders, cancelled: cancelledOrders, today: todayOrders },
      revenue    : { total_rs: sumRs(allNonCancelledOrders), today_rs: sumRs(todayOrders2), week_rs: sumRs(weekOrders) },
      customers  : { total: totalCustomers, today: todayCustomers },
      missed_sales: { expired: expiredCount, payment_failed: paymentFailedCount, total: expiredCount + paymentFailedCount },
      logs       : { total: totalLogs, unprocessed: unprocessedLogs, errors: errorLogs },
    });
  } catch (err) {
    req.log.error({ err }, 'Stats error');
    res.status(500).json({ success: false, message: "Internal server error" });
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
    res.status(500).json({ success: false, message: "Internal server error" });
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
        col('orders').countDocuments({ branch_id: bid, status: { $in: CONFIRMED_ORDER_STATES } }),
      ]);
      return { ...mapId(b), business_name: restaurant?.business_name, menu_item_count: menuCount, order_count: orderCount };
    }));

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ success: false, message: "Internal server error" });
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
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ─── PROROUTING ISSUE MANAGEMENT ─────────────────────────────
// Admin-only tools for raising, tracking, and closing Prorouting
// (3PL) disputes against a delivery. Used when RTO auto-raise misses
// an edge case, or ops needs to open a manual complaint (wrong item,
// damaged packaging, etc.). All three sit behind requireAdmin.

// POST /api/admin/orders/:orderId/issue — raise a manual issue
router.post('/orders/:orderId/issue', requireAdmin, async (req, res) => {
  try {
    const order = await col('orders').findOne({ _id: req.params.orderId });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.prorouting_order_id) return res.status(400).json({ error: 'Delivery not yet dispatched' });
    if (order.prorouting_issue_id) {
      return res.status(400).json({ error: `Issue already exists: ${order.prorouting_issue_id}` });
    }

    const { sub_category, short_desc, long_desc } = req.body || {};
    if (!sub_category) return res.status(400).json({ error: 'sub_category is required' });

    const prorouting = require('../services/prorouting');
    let result;
    try {
      result = await prorouting.raiseIssue(order.prorouting_order_id, sub_category, short_desc, long_desc);
    } catch (e) {
      if (e?.name === 'DuplicateIssueError') {
        return res.status(409).json({ error: e.message });
      }
      return res.status(502).json({ success: false, message: "Upstream service unavailable" });
    }

    await col('orders').updateOne(
      { _id: order._id },
      { $set: {
          prorouting_issue_id: result.issue_id,
          prorouting_issue_state: result.issue_state,
          updated_at: new Date(),
        } }
    );

    logActivity({
      actorType: 'admin', actorId: req.adminUser?._id || null, actorName: req.adminUser?.name || 'admin',
      action: 'prorouting.issue_raised', category: 'delivery',
      description: `Raised ${sub_category} issue for order #${order.order_number}`,
      resourceType: 'order', resourceId: String(order._id), severity: 'info',
      metadata: { sub_category, issue_id: result.issue_id },
    });

    res.json({ issue_id: result.issue_id, issue_state: result.issue_state });
  } catch (err) {
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// GET /api/admin/orders/:orderId/issue — fetch latest issue status
router.get('/orders/:orderId/issue', requireAdmin, async (req, res) => {
  try {
    const order = await col('orders').findOne({ _id: req.params.orderId });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.prorouting_issue_id) return res.status(404).json({ error: 'No issue raised for this order' });

    const prorouting = require('../services/prorouting');
    let issue;
    try {
      issue = await prorouting.getIssueStatus(order.prorouting_issue_id);
    } catch (e) {
      return res.status(502).json({ success: false, message: "Upstream service unavailable" });
    }

    const latestState = issue?.status || issue?.state || null;
    if (latestState && latestState !== order.prorouting_issue_state) {
      await col('orders').updateOne(
        { _id: order._id },
        { $set: { prorouting_issue_state: latestState, updated_at: new Date() } }
      );
    }

    res.json(issue);
  } catch (err) {
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// POST /api/admin/orders/:orderId/issue/close — resolve + close the dispute
router.post('/orders/:orderId/issue/close', requireAdmin, async (req, res) => {
  try {
    const order = await col('orders').findOne({ _id: req.params.orderId });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.prorouting_issue_id) return res.status(404).json({ error: 'No issue raised for this order' });

    const { rating, refund_by_lsp, refund_to_client } = req.body || {};
    if (!rating || !['THUMBS-UP', 'THUMBS-DOWN'].includes(rating)) {
      return res.status(400).json({ error: "rating must be 'THUMBS-UP' or 'THUMBS-DOWN'" });
    }

    const prorouting = require('../services/prorouting');
    let result;
    try {
      result = await prorouting.closeIssue(order.prorouting_issue_id, rating, !!refund_by_lsp, !!refund_to_client);
    } catch (e) {
      return res.status(502).json({ success: false, message: "Upstream service unavailable" });
    }

    await col('orders').updateOne(
      { _id: order._id },
      { $set: { prorouting_issue_state: 'Closed', updated_at: new Date() } }
    );

    logActivity({
      actorType: 'admin', actorId: req.adminUser?._id || null, actorName: req.adminUser?.name || 'admin',
      action: 'prorouting.issue_closed', category: 'delivery',
      description: `Closed Prorouting issue ${order.prorouting_issue_id} with rating ${rating}`,
      resourceType: 'order', resourceId: String(order._id), severity: 'info',
      metadata: { rating, refund_by_lsp: !!refund_by_lsp, refund_to_client: !!refund_to_client },
    });

    res.json({ message: result.message });
  } catch (err) {
    res.status(500).json({ success: false, message: "Internal server error" });
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
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ─── GET /api/admin/logs/:id ──────────────────────────────────
router.get('/logs/:id', async (req, res) => {
  try {
    const doc = await col('webhook_logs').findOne({ _id: req.params.id });
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json(mapId(doc));
  } catch (err) {
    res.status(500).json({ success: false, message: "Internal server error" });
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
      const confirmedOrders = orders.filter(o => CONFIRMED_ORDER_STATES.includes(o.status));
      const lifetime_rs = confirmedOrders.reduce((s, o) => s + (parseFloat(o.total_rs) || 0), 0);
      return { ...mapId(c), order_count: confirmedOrders.length, lifetime_rs };
    }));

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ success: false, message: "Internal server error" });
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
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ─── POST /api/admin/settlements/run ─────────────────────────
// Phase 5 — Manually trigger an on-demand ledger-balance settlement
// for a single restaurant. Separate from /run-settlement (which runs
// the legacy weekly cycle across all tenants).
router.post('/settlements/run', requireAdmin, express.json(), async (req, res) => {
  try {
    const restaurantId = req.body?.restaurant_id;
    if (!restaurantId) return res.status(400).json({ error: 'restaurant_id required' });
    const payout_mode = req.body?.payout_mode === 'manual' ? 'manual' : 'auto';

    // Cross-system guard: refuse if any v2 per-order payout is in flight or
    // recently paid for this restaurant. Phase 5 drains the ledger balance,
    // and v2 per-order payouts haven't yet been reconciled out of the
    // ledger — running both at once would double-pay the same orders.
    // 30-day lookback is generous; older v2 rows are guaranteed already
    // reflected in the ledger via the payout webhook.
    const periodStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const conflicting = await col('order_settlements').findOne({
      restaurant_id: String(restaurantId),
      status: { $in: ['paid', 'processing'] },
      created_at: { $gte: periodStart },
    });
    if (conflicting) {
      return res.status(409).json({
        error: 'Payout conflict',
        message: 'A v2 per-order payout is already in progress for this period. Resolve it before running a manual settlement.',
        conflicting_settlement_id: conflicting._id,
        conflicting_status: conflicting.status,
      });
    }

    const settlementSvc = require('../services/settlement.service');
    const result = await settlementSvc.executeSettlement(String(restaurantId), { trigger: 'admin', payout_mode });

    logActivity({
      actorType: 'admin', actorId: req.adminUser?._id || null, actorName: req.adminUser?.email || 'Admin',
      action: 'settlement.payout_triggered', category: 'billing',
      description: `Admin triggered ledger settlement for ${restaurantId}: ${JSON.stringify(result)}`,
      restaurantId: String(restaurantId), resourceType: 'settlement',
      resourceId: result.settlement_id || null, severity: 'info', metadata: result,
    });

    res.json(result);
  } catch (e) {
    log.error({ err: e }, 'admin.settlements.run failed');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ─── POST /api/admin/settlements/:id/retry ───────────────────
// Manual retry of a failed Phase 5 settlement. Cron recovery lives
// in jobs/settlementPayout.js. Uses the same provider-fallback loop.
router.post('/settlements/:id/retry', requireAdmin, express.json(), async (req, res) => {
  try {
    const settlementSvc = require('../services/settlement.service');
    const result = await settlementSvc.retrySettlement(req.params.id);

    logActivity({
      actorType: 'admin', actorId: req.adminUser?._id || null, actorName: req.adminUser?.email || 'Admin',
      action: 'settlement.retry', category: 'billing',
      description: `Admin retried settlement ${req.params.id}: ${JSON.stringify(result)}`,
      resourceType: 'settlement', resourceId: req.params.id, severity: 'info', metadata: result,
    });

    res.json(result);
  } catch (e) {
    log.error({ err: e }, 'admin.settlements.retry failed');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ─── COUPON CODES (promo coupons for checkout endpoint) ─────
// Distinct from /coupon-templates (Meta marketing templates with a
// copy_code button) — these are the actual discount rules applied by
// services/coupon.js and the WhatsApp Checkout endpoint.
router.get('/coupons', requireAdmin, async (req, res) => {
  try {
    const { restaurant_id } = req.query;
    if (!restaurant_id) return res.status(400).json({ error: 'restaurant_id required' });
    const rows = await col('coupons')
      .find({ restaurant_id: String(restaurant_id) })
      .sort({ created_at: -1 })
      .toArray();
    res.json({ items: rows.map(r => ({ ...r, id: String(r._id) })), count: rows.length });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.post('/coupons', requireAdmin, express.json(), async (req, res) => {
  try {
    const couponSvc = require('../services/coupon');
    const doc = await couponSvc.createCoupon(req.body || {});
    logActivity({
      actorType: 'admin', actorId: req.adminUser?._id || null, actorName: req.adminUser?.email || 'Admin',
      action: 'coupon.created', category: 'billing',
      description: `Coupon ${doc.code} created for restaurant ${doc.restaurant_id}`,
      restaurantId: doc.restaurant_id, resourceType: 'coupon', resourceId: doc.id, severity: 'info',
    });
    res.json(doc);
  } catch (e) {
    if (/required|must|>/.test(e.message)) res.status(400).json({ error: e.message });
    else res.status(500).json({ success: false, message: "Internal server error" });
  }
});

router.patch('/coupons/:id', requireAdmin, express.json(), async (req, res) => {
  try {
    const allowed = ['is_active', 'description', 'valid_from', 'valid_until', 'usage_limit', 'per_user_limit'];
    const set = {};
    for (const k of allowed) if (k in req.body) {
      set[k] = k.startsWith('valid_') && req.body[k] ? new Date(req.body[k]) : req.body[k];
    }
    if (!Object.keys(set).length) return res.status(400).json({ error: 'no updatable fields' });
    set.updated_at = new Date();
    const r = await col('coupons').findOneAndUpdate(
      { _id: req.params.id },
      { $set: set },
      { returnDocument: 'after' },
    );
    if (!r) return res.status(404).json({ error: 'not found' });
    res.json({ ...r, id: String(r._id) });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── COUPON TEMPLATES ────────────────────────────────────────
// Marketing templates with a copy_code button, managed per restaurant WABA.
// Thin wrappers over services/couponTemplate.service.js.
router.post('/coupon-templates', requireAdmin, express.json(), async (req, res) => {
  try {
    const { restaurant_id, name, header_text, body_text, example_code } = req.body || {};
    if (!restaurant_id) return res.status(400).json({ error: 'restaurant_id required' });
    if (!name)          return res.status(400).json({ error: 'name required' });
    if (!body_text)     return res.status(400).json({ error: 'body_text required' });
    if (!example_code)  return res.status(400).json({ error: 'example_code required' });

    const svc = require('../services/couponTemplate.service');
    const result = await svc.createCouponTemplate({
      restaurantId: String(restaurant_id),
      name: String(name),
      headerText: header_text || null,
      bodyText: String(body_text),
      exampleCode: String(example_code),
    });

    logActivity({
      actorType: 'admin', actorId: req.adminUser?._id || null, actorName: req.adminUser?.email || 'Admin',
      action: 'coupon_template.created', category: 'template',
      description: `Coupon template "${name}" submitted for restaurant ${restaurant_id}`,
      restaurantId: String(restaurant_id), resourceType: 'template',
      resourceId: result.template_id, severity: 'info', metadata: result,
    });

    res.json(result);
  } catch (e) {
    if (/required|must be/i.test(e.message)) res.status(400).json({ error: e.message, meta: e.meta || undefined });
    else res.status(500).json({ success: false, message: "Internal server error" });
  }
});

router.get('/coupon-templates', requireAdmin, async (req, res) => {
  try {
    const { restaurant_id } = req.query;
    if (!restaurant_id) return res.status(400).json({ error: 'restaurant_id required' });
    const svc = require('../services/couponTemplate.service');
    const items = await svc.listCouponTemplates(String(restaurant_id));
    res.json({ items, count: items.length });
  } catch (e) {
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ─── POST /api/admin/settlements/confirm ─────────────────────
// Phase 5.1 — Ops confirms a manual (or stuck auto) payout landed at
// the bank. Flips ledger pending→completed and settlement→completed,
// stores the bank reference / UTR on the settlement row.
router.post('/settlements/confirm', requireAdmin, express.json(), async (req, res) => {
  try {
    const { payout_id, external_reference } = req.body || {};
    if (!payout_id) return res.status(400).json({ error: 'payout_id required' });
    if (!external_reference) return res.status(400).json({ error: 'external_reference required' });

    const settlementSvc = require('../services/settlement.service');
    const result = await settlementSvc.confirmPayout(String(payout_id), { externalReference: String(external_reference) });

    logActivity({
      actorType: 'admin', actorId: req.adminUser?._id || null, actorName: req.adminUser?.email || 'Admin',
      action: 'settlement.payout_confirmed', category: 'billing',
      description: `Admin confirmed payout ${payout_id} (ref ${external_reference}): ${JSON.stringify(result)}`,
      resourceType: 'settlement', resourceId: result.settlement_id || null, severity: 'info',
      metadata: { payout_id, external_reference, ...result },
    });

    res.json(result);
  } catch (e) {
    log.error({ err: e }, 'admin.settlements.confirm failed');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ─── POST /api/admin/settlements/fail ────────────────────────
// Phase 5.1 — Ops marks a payout as failed (wire rejected, wrong
// account, etc.). Un-reserves the pending ledger debit or writes a
// compensating credit if the ledger was already completed.
router.post('/settlements/fail', requireAdmin, express.json(), async (req, res) => {
  try {
    const { payout_id, reason } = req.body || {};
    if (!payout_id) return res.status(400).json({ error: 'payout_id required' });

    const settlementSvc = require('../services/settlement.service');
    const result = await settlementSvc.failPayout(String(payout_id), reason || 'admin_marked_failed');

    logActivity({
      actorType: 'admin', actorId: req.adminUser?._id || null, actorName: req.adminUser?.email || 'Admin',
      action: 'settlement.payout_failed', category: 'billing',
      description: `Admin failed payout ${payout_id}: ${reason || 'admin_marked_failed'}`,
      resourceType: 'settlement', resourceId: result.settlement_id || null, severity: 'warn',
      metadata: { payout_id, reason, ...result },
    });

    res.json(result);
  } catch (e) {
    log.error({ err: e }, 'admin.settlements.fail failed');
    res.status(500).json({ success: false, message: "Internal server error" });
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
    runSettlement().catch(err => log.error({ err }, 'Settlement run failed'));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
    res.status(500).json({ success: false, message: "Internal server error" });
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
      log.error({ err }, 'Directory auto-list failed')
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
      } catch (e) { log.error({ err: e }, 'Auto-suggest failed'); }
    })();

    logActivity({
      actorType: 'admin', actorId: null, actorName: 'Admin',
      action: 'restaurant.approved', category: 'auth',
      description: `Restaurant "${updated.business_name}" approved`,
      restaurantId: req.params.id, resourceType: 'restaurant', resourceId: req.params.id, severity: 'info',
    });
    res.json({ ok: true, restaurant: mapId(updated) });
  } catch (err) {
    res.status(500).json({ success: false, message: "Internal server error" });
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
    res.status(500).json({ success: false, message: "Internal server error" });
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
  } catch (err) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (err) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── REFERRALS ────────────────────────────────────────────────────

// POST /api/admin/referrals
router.post('/referrals', express.json(), async (req, res) => {
  try {
    const { restaurantId, customerWaPhone, customerName, notes } = req.body;
    if (!restaurantId || !customerWaPhone)
      return res.status(400).json({ error: 'restaurantId and customerWaPhone are required' });

    const refAttr = require('../services/referralAttribution');
    const referral = await refAttr.createReferral({
      restaurantId,
      customerPhone: customerWaPhone.trim(),
      customerName: customerName || null,
      source: 'admin',
      notes: notes || null,
    });
    res.json(mapId(referral));
  } catch (err) {
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// GET /api/admin/referrals/commission-report — payout/commission reporting
router.get('/referrals/commission-report', async (req, res) => {
  try {
    const refAttr = require('../services/referralAttribution');
    const report = await refAttr.getCommissionReport({
      from: req.query.from, to: req.query.to, restaurantId: req.query.restaurant_id,
    });
    res.json(report);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/admin/referrals/conflict-audit/:phone — attribution conflict audit
router.get('/referrals/conflict-audit/:phone', async (req, res) => {
  try {
    const refAttr = require('../services/referralAttribution');
    const audit = await refAttr.getConflictAudit(req.params.phone, req.query.restaurant_id);
    res.json(audit);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── REFERRAL LINKS (GBREF code-based tracking) ──────────────

function _generateRefCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return code;
}

// GET /api/admin/referrals/links — list all referral links with stats
router.get('/referrals/links', async (req, res) => {
  try {
    const filter = {};
    if (req.query.restaurant_id) filter.restaurant_id = req.query.restaurant_id;
    if (req.query.status) filter.status = req.query.status;
    const links = await col('referral_links').find(filter).sort({ created_at: -1 }).limit(200).toArray();

    // Enrich with conversion stats
    const enriched = await Promise.all(links.map(async link => {
      const sessions = await col('referrals').find({ referral_code: link.code }).toArray();
      const converted = sessions.filter(s => s.status === 'converted');
      return {
        ...mapId(link),
        conversions: converted.length,
        total_sessions: sessions.length,
        total_commission: converted.reduce((s, c) => s + (c.referral_fee_rs || 0), 0),
      };
    }));
    res.json(enriched);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/admin/referrals/links — generate a new GBREF link
router.post('/referrals/links', express.json(), async (req, res) => {
  try {
    const { restaurant_id, campaign_name } = req.body;
    if (!restaurant_id) return res.status(400).json({ error: 'restaurant_id is required' });

    const restaurant = await col('restaurants').findOne({ _id: restaurant_id });
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    const waAcc = await col('whatsapp_accounts').findOne({ restaurant_id, is_active: true });
    const phone = waAcc?.wa_phone_number?.replace(/[^0-9]/g, '') || '';
    if (!phone) return res.status(400).json({ error: 'Restaurant has no WhatsApp number configured' });

    // Generate unique code with retry
    let code;
    for (let attempt = 0; attempt < 10; attempt++) {
      code = _generateRefCode();
      const exists = await col('referral_links').findOne({ code });
      if (!exists) break;
      if (attempt === 9) return res.status(500).json({ error: 'Could not generate unique code — try again' });
    }

    const waLink = `https://wa.me/${phone}?text=${encodeURIComponent('Hi 👋 GBREF-' + code)}`;
    const link = {
      _id: newId(),
      code,
      restaurant_id,
      restaurant_name: restaurant.business_name || restaurant.brand_name || '',
      restaurant_phone: phone,
      campaign_name: campaign_name || null,
      wa_link: waLink,
      click_count: 0,
      status: 'active',
      created_by: 'admin',
      created_at: new Date(),
      expires_at: null,
    };
    await col('referral_links').insertOne(link);

    req.log.info({ code, restaurantName: restaurant.business_name, phone: phone?.slice(-4) }, 'Referral link created');
    res.json({ ...mapId(link), wa_link: waLink });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/admin/referral-link-requests — pending GBREF link requests from
// restaurants. Each row is enriched with the restaurant's display name so
// the admin dashboard can render the "Pending Requests" panel without a
// second roundtrip.
router.get('/referral-link-requests', async (req, res) => {
  try {
    const requests = await col('referral_link_requests')
      .find({ status: 'pending' })
      .sort({ created_at: -1 })
      .limit(50)
      .toArray();

    const restaurantIds = [...new Set(requests.map(r => r.restaurant_id).filter(Boolean))];
    const restaurants = restaurantIds.length
      ? await col('restaurants').find(
          { _id: { $in: restaurantIds } },
          { projection: { business_name: 1, brand_name: 1 } }
        ).toArray()
      : [];
    const nameById = Object.fromEntries(
      restaurants.map(r => [String(r._id), r.brand_name || r.business_name || String(r._id)])
    );

    const enriched = requests.map(r => ({
      ...mapId(r),
      restaurant_name: nameById[String(r.restaurant_id)] || null,
    }));
    res.json({ requests: enriched });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/admin/referral-link-requests/:id/resolve — mark a pending
// request as resolved (called after admin generates the link via the
// existing POST /referrals/links endpoint). Idempotent: re-resolving a
// resolved row is a no-op.
router.post('/referral-link-requests/:id/resolve', express.json(), async (req, res) => {
  try {
    await col('referral_link_requests').updateOne(
      { _id: req.params.id, status: 'pending' },
      { $set: { status: 'resolved', resolved_at: new Date(), resolved_by: req.adminUser?._id || null } }
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// PUT /api/admin/referrals/links/:id — update status or campaign name
router.put('/referrals/links/:id', express.json(), async (req, res) => {
  try {
    const { status, campaign_name } = req.body;
    const $set = { updated_at: new Date() };
    if (status) $set.status = status;
    if (campaign_name !== undefined) $set.campaign_name = campaign_name;
    await col('referral_links').updateOne({ _id: req.params.id }, { $set });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// DELETE /api/admin/referrals/links/:id — soft delete (set expired)
router.delete('/referrals/links/:id', async (req, res) => {
  try {
    await col('referral_links').updateOne({ _id: req.params.id }, { $set: { status: 'expired', updated_at: new Date() } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/admin/referrals/link-stats — aggregate link stats
router.get('/referrals/link-stats', async (req, res) => {
  try {
    const links = await col('referral_links').find({}).toArray();
    const active = links.filter(l => l.status === 'active').length;
    const totalClicks = links.reduce((s, l) => s + (l.click_count || 0), 0);
    const sessions = await col('referrals').find({ source: 'gbref' }).toArray();
    const converted = sessions.filter(s => s.status === 'converted');
    const totalCommission = converted.reduce((s, c) => s + (c.referral_fee_rs || 0), 0);
    res.json({
      total_links: links.length,
      active_links: active,
      total_clicks: totalClicks,
      total_sessions: sessions.length,
      total_conversions: converted.length,
      conversion_rate: sessions.length ? Math.round(converted.length / sessions.length * 1000) / 10 : 0,
      total_commission: Math.round(totalCommission * 100) / 100,
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.post('/wallets/refund', async (req, res) => {
  try {
    const { restaurantId, amount, description } = req.body;
    if (!restaurantId || !amount) return res.status(400).json({ error: 'restaurantId and amount required' });
    const walletSvc = require('../services/wallet');
    const result = await walletSvc.refund(restaurantId, amount, description || 'Admin refund');
    if (!result) return res.status(404).json({ error: 'Wallet not found' });
    logActivity({
      actorType: 'admin', actorId: String(req.adminUser?._id), actorName: req.adminUser?.name || req.adminUser?.email,
      action: 'admin.wallet.refund', category: 'payments',
      description: `Manual wallet refund: ₹${amount} to restaurant ${restaurantId}`,
      resourceType: 'wallet', resourceId: restaurantId, severity: 'warning',
    });
    res.json({ success: true, balance: result.balance_rs });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
    const lateNight = all.filter(r => r.is_late_night_referral).length;
    const avg_window = total > 0 ? Math.round(all.reduce((s, r) => s + (r.attribution_window_hours || 8), 0) / total * 10) / 10 : 0;
    res.json({ total, active, converted, expired, late_night_referrals: lateNight, avg_attribution_window_hours: avg_window, total_orders, total_order_value_rs, total_referral_fee_rs });
  } catch (err) {
    res.status(500).json({ success: false, message: "Internal server error" });
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
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ─── GET /api/admin/settlements ──────────────────────────────
router.get('/settlements', async (req, res) => {
  try {
    const { restaurant_id, status, from, to, limit = 50, offset = 0 } = req.query;
    const filter = {};
    if (restaurant_id) filter.restaurant_id = restaurant_id;
    if (status) filter.payout_status = status;
    if (from || to) {
      filter.created_at = {};
      if (from) filter.created_at.$gte = new Date(from);
      if (to)   filter.created_at.$lt  = new Date(new Date(to).getTime() + 24 * 60 * 60 * 1000);
    }

    const [settlements, total] = await Promise.all([
      col('settlements').find(filter).sort({ created_at: -1 }).skip(parseInt(offset)).limit(parseInt(limit)).toArray(),
      col('settlements').countDocuments(filter),
    ]);

    const enriched = await Promise.all(settlements.map(async s => {
      const restaurant = await col('restaurants').findOne({ _id: s.restaurant_id }, { projection: { business_name: 1 } });
      return {
        ...mapId(s),
        business_name: restaurant?.business_name || '—',
        // Phase 5.2 — Meta marketing cost deduction (0 on pre-integration rows).
        meta_cost_total_paise: s.meta_cost_total_paise || 0,
        meta_message_count:    s.meta_message_count || 0,
      };
    }));

    res.json({ settlements: enriched, total });
  } catch (err) {
    res.status(500).json({ success: false, message: "Internal server error" });
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
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ─── GET /api/admin/settlements/:id/meta-breakdown ──────────
// Phase 5.2 — per-settlement marketing_messages breakdown.
//
// Security posture:
//   • Gated by requireAdminAuth('marketing_messages','read'). The
//     middleware attaches req.admin and sets req.canSeeFullPhones only
//     for super_admin or roles with the customer_full_phone permission.
//   • Full phone visibility follows req.canSeeFullPhones verbatim — no
//     fallback, no override via query/body.
//   • Access is audit-logged (logActivity) so admin reads of PII are
//     always traceable to admin_id + settlement + restaurant.
router.get('/settlements/:id/meta-breakdown', requireAdminAuth('marketing_messages', 'read'), async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id || id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(id)) {
      return res.status(400).json({ error: 'Invalid settlement id' });
    }

    const settlement = await col('settlements').findOne(
      { _id: id },
      { projection: { _id: 1, restaurant_id: 1, meta_message_ids: 1, meta_cost_total_paise: 1, meta_message_count: 1 } },
    );
    if (!settlement) return res.status(404).json({ error: 'Settlement not found' });

    const ids = Array.isArray(settlement.meta_message_ids) ? settlement.meta_message_ids : [];
    let rows = [];
    if (ids.length) {
      rows = await col('marketing_messages')
        .find({ _id: { $in: ids } })
        // Explicit projection — keeps phone_hash / raw_meta_payload out
        // of memory entirely. Raw phones only come from customers.wa_phone
        // via enrichRows, and only when canSeeFullPhones is true.
        .project({
          _id: 1, restaurant_id: 1, waba_id: 1, customer_id: 1, customer_name: 1,
          message_id: 1, message_type: 1, category: 1, cost: 1, currency: 1,
          status: 1, sent_at: 1, delivered_at: 1,
        })
        .sort({ sent_at: -1 })
        .toArray();
    }
    const { enrichRows } = require('./marketingMessages');
    const items = await enrichRows(rows, { canSeeFullPhones: !!req.canSeeFullPhones });

    // Audit log — admin PII access. Never log raw phone or waba_id
    // values beyond the restaurant id. Metadata is deliberately small.
    logActivity({
      actorType: 'admin',
      actorId: String(req.admin?._id || req.admin?.id || ''),
      actorName: req.admin?.name || req.admin?.email || 'admin',
      action: 'admin.meta_breakdown.read',
      category: 'pii_access',
      description: `Admin viewed settlement meta breakdown for ${settlement.restaurant_id}`,
      restaurantId: settlement.restaurant_id,
      resourceType: 'settlement',
      resourceId: settlement._id,
      severity: 'info',
      metadata: {
        endpoint: '/api/admin/settlements/:id/meta-breakdown',
        message_count: items.length,
        phones_unmasked: !!req.canSeeFullPhones,
      },
    });

    res.json({
      settlement_id:         settlement._id,
      restaurant_id:         settlement.restaurant_id,
      meta_cost_total_paise: settlement.meta_cost_total_paise || 0,
      meta_message_count:    settlement.meta_message_count || 0,
      items,
    });
  } catch (err) {
    req.log?.error({ err, settlementId: req.params.id }, 'admin.meta_breakdown failed');
    res.status(500).json({ error: 'Failed to load settlement breakdown' });
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
  } catch (err) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── DIRECTORY ───────────────────────────────────────────────
const directory = require('../services/directory');

router.get('/directory/listings', async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const result = await directory.getAllListings({ limit: parseInt(limit), offset: parseInt(offset) });
    res.json(result);
  } catch (err) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.get('/directory/stats', async (req, res) => {
  try {
    res.json(await directory.getStats());
  } catch (err) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.patch('/directory/listings/:id/toggle', async (req, res) => {
  try {
    const { isActive } = req.body;
    await col('directory_listings').updateOne(
      { _id: req.params.id },
      { $set: { is_active: !!isActive, updated_at: new Date() } }
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.post('/directory/sync-all', async (req, res) => {
  res.json({ message: 'Directory sync started' });
  try {
    const restaurants = await col('restaurants').find({ approval_status: 'approved', status: 'active' }).toArray();
    for (const r of restaurants) {
      await directory.listRestaurant(String(r._id)).catch(e =>
        log.error({ err: e, restaurantName: r.business_name }, 'Directory sync failed for restaurant')
      );
    }
    log.info({ count: restaurants.length }, 'Directory synced all listings');
  } catch (err) { log.error({ err }, 'Directory sync-all error'); }
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
  } catch (err) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.get('/checkout/status', async (req, res) => {
  try {
    const configured = !!process.env.WA_CHECKOUT_PRIVATE_KEY_B64;
    const verifyToken = process.env.WA_CHECKOUT_VERIFY_TOKEN || '(not set)';
    const webhookSecret = !!process.env.WA_CHECKOUT_WEBHOOK_SECRET;
    res.json({ configured, verifyToken: configured ? verifyToken : null, webhookSecret });
  } catch (err) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
      col('orders').find({ restaurant_id: id, status: { $in: CONFIRMED_ORDER_STATES } }).project({ total_rs: 1 }).toArray(),
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

    req.log.info({ restaurantId: id, restaurantName: restaurant.business_name }, 'Deleted restaurant — archived as internal record');
    res.json({ ok: true, archived: true, business_name: restaurant.business_name });
  } catch (err) {
    req.log.error({ err }, 'Delete restaurant error');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ─── GET /api/admin/archived-restaurants ─────────────────────
router.get('/archived-restaurants', async (req, res) => {
  try {
    const docs = await col('archived_restaurants').find({}).sort({ deleted_at: -1 }).toArray();
    res.json(mapIds(docs));
  } catch (err) {
    res.status(500).json({ success: false, message: "Internal server error" });
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
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ─── GET /api/admin/ratings/stats ─────────────────────────────
router.get('/ratings/stats', async (req, res) => {
  try {
    const allRatings = await col('order_ratings').find({}).toArray();
    const total = allRatings.length;

    if (!total) {
      return res.json({ avg_taste: 0, avg_packing: 0, avg_delivery: 0, avg_value: 0, avg_overall: 0, avg_food: 0, total: 0, distribution: {}, restaurant_breakdown: [], problem_areas: [], recent_negative: [] });
    }

    const avg = (field) => +(allRatings.reduce((s, r) => s + (r[field] || 0), 0) / total).toFixed(1);
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of allRatings) {
      const star = Math.max(1, Math.min(5, Math.round(r.overall_rating || r.food_rating || 3)));
      distribution[star] = (distribution[star] || 0) + 1;
    }

    // Per-restaurant breakdown
    const byRest = {};
    for (const r of allRatings) {
      const rid = r.restaurant_id || 'unknown';
      if (!byRest[rid]) byRest[rid] = { ratings: [], restaurant_id: rid };
      byRest[rid].ratings.push(r);
    }
    const restaurants = await col('restaurants').find({}, { projection: { business_name: 1 } }).toArray();
    const restNames = {};
    for (const r of restaurants) restNames[String(r._id)] = r.business_name;

    const restaurant_breakdown = Object.values(byRest).map(g => {
      const cnt = g.ratings.length;
      const ra = (f) => +(g.ratings.reduce((s, r) => s + (r[f] || 0), 0) / cnt).toFixed(1);
      return {
        restaurant_id: g.restaurant_id, restaurant_name: restNames[g.restaurant_id] || 'Unknown',
        avg_overall: ra('overall_rating'), avg_taste: ra('taste_rating'), avg_packing: ra('packing_rating'),
        avg_delivery: ra('delivery_rating'), avg_value: ra('value_rating'), total_reviews: cnt,
      };
    }).sort((a, b) => a.avg_overall - b.avg_overall);

    // Problem areas (categories < 3.0)
    const categories = ['taste_rating', 'packing_rating', 'delivery_rating', 'value_rating'];
    const catLabels = { taste_rating: 'Taste', packing_rating: 'Packing', delivery_rating: 'Delivery', value_rating: 'Value' };
    const problem_areas = categories
      .map(c => ({ category: catLabels[c], avg: avg(c) }))
      .filter(c => c.avg > 0 && c.avg < 3.0);

    // Recent negative feedback
    const recent_negative = allRatings
      .filter(r => (r.overall_rating || r.food_rating || 5) < 3 && r.comment)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 10)
      .map(r => ({
        order_id: r.order_id, restaurant_name: restNames[r.restaurant_id] || '',
        overall_rating: r.overall_rating || r.food_rating, comment: r.comment, created_at: r.created_at,
      }));

    res.json({
      avg_taste: avg('taste_rating'), avg_packing: avg('packing_rating'),
      avg_delivery: avg('delivery_rating'), avg_value: avg('value_rating'),
      avg_overall: avg('overall_rating'), avg_food: avg('food_rating'),
      total, distribution, restaurant_breakdown, problem_areas, recent_negative,
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// DELETE /api/admin/blocked-phones/:id — unblock a phone
router.delete('/blocked-phones/:id', async (req, res) => {
  try {
    const result = await col('blocked_phones').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/admin/templates/sync — pull all templates from Meta into local DB.
// Auto-discovers the platform WABA when waba_id is not supplied — same pattern
// as GET /api/admin/flows. Front-end no longer needs to pass it.
router.post('/templates/sync', express.json(), async (req, res) => {
  try {
    let { waba_id } = req.body;
    if (!waba_id) {
      const wa = await col('whatsapp_accounts').findOne({ is_active: true });
      waba_id = wa?.waba_id;
    }
    if (!waba_id) return res.status(400).json({ error: 'No active WABA found' });
    const result = await templateSvc.syncTemplates(waba_id);
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
    logActivity({
      actorType: 'admin', actorId: String(req.adminUser?._id), actorName: req.adminUser?.name || req.adminUser?.email,
      action: 'admin.template.updated', category: 'templates',
      description: `Template updated: metaId=${req.params.metaId}`,
      resourceType: 'template', resourceId: req.params.metaId, severity: 'info',
    });
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
    logActivity({
      actorType: 'admin', actorId: String(req.adminUser?._id), actorName: req.adminUser?.name || req.adminUser?.email,
      action: 'admin.template.deleted', category: 'templates',
      description: `Template deleted: ${name} from WABA ${waba_id}`,
      resourceType: 'template', resourceId: name, severity: 'warning',
    });
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/admin/templates/seed — force re-seed default mappings
router.post('/templates/seed', async (req, res) => {
  try {
    await templateSvc.seedDefaultMappings();
    const mappings = await templateSvc.getEventMappings();
    res.json({ seeded: true, mappings });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/admin/templates/gallery — predefined template library
router.get('/templates/gallery', (req, res) => {
  const templates = require('../config/predefined-templates');
  res.json(templates);
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/admin/templates/test-send — Send a test template to a phone number
router.post('/templates/test-send', express.json(), async (req, res) => {
  try {
    const { template_name, language, phone, variables } = req.body;
    if (!template_name || !phone) return res.status(400).json({ error: 'template_name and phone required' });

    const wa = await col('whatsapp_accounts').findOne({ is_active: true });
    if (!wa?.phone_number_id) return res.status(400).json({ error: 'No active WA account' });

    const waService = require('../services/whatsapp');
    const components = [];
    if (variables?.length) {
      components.push({ type: 'body', parameters: variables.map(v => ({ type: 'text', text: String(v) })) });
    }

    await waService.sendTemplate(wa.phone_number_id, metaConfig.getMessagingToken(), phone, {
      name: template_name, language: language || 'en', components,
    });

    // Log the test send
    await col('order_notifications').insertOne({
      _id: newId(), event: 'test_send', template_name, to_phone: phone,
      variables: variables || [], status: 'sent', sent_at: new Date(),
    });

    res.json({ success: true, message: `Template "${template_name}" sent to ${phone}` });
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    res.status(500).json({ error: msg });
  }
});

// ─── BSUID MIGRATION READINESS ─────────────────────────────────
// GET /api/admin/bsuid-readiness — surfaces customer-identity stats
// for the June 2026 Meta BSUID rollout. Phone-only customers are
// "at risk" of being created as duplicates if they switch to BSUID-only
// messaging before our CASE 5 lookup has stamped their meta_bsuid.
// They get linked automatically on their next message that carries a
// contact.user_id from Meta.
router.get('/bsuid-readiness', async (req, res) => {
  try {
    const [total, withBsuid, withMetaBsuid, phoneOnly] = await Promise.all([
      col('customers').countDocuments({}),
      col('customers').countDocuments({ bsuid: { $exists: true, $ne: null } }),
      col('customers').countDocuments({ meta_bsuid: { $exists: true, $ne: null } }),
      col('customers').countDocuments({
        wa_phone: { $exists: true, $ne: null },
        bsuid: { $exists: false },
      }),
    ]);
    res.json({
      total_customers: total,
      with_bsuid: withBsuid,
      with_meta_bsuid: withMetaBsuid,
      phone_only: phoneOnly,
      readiness_pct: total > 0 ? Math.round((withBsuid / total) * 100) : 0,
      migration_note: 'Meta BSUID rollout expected June 2026. Phone-only customers will be linked on their next message.',
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── BUSINESS USERNAMES ────────────────────────────────────────
const usernameSvc = require('../services/username');

// GET /api/admin/usernames — all restaurants with username status
router.get('/usernames', async (req, res) => {
  try {
    const { search, status } = req.query;
    const data = await usernameSvc.getAllUsernameStatuses({ search, statusFilter: status });
    res.json(data);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/admin/usernames/:waAccountId/check — check availability
router.post('/usernames/:waAccountId/check', express.json(), async (req, res) => {
  try {
    const result = await usernameSvc.checkUsernameAvailability(req.body.username, req.params.waAccountId);
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/admin/usernames/sync-all — sync all WABAs
router.post('/usernames/sync-all', async (req, res) => {
  try {
    const result = await usernameSvc.syncAllUsernames();
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/admin/usernames/auto-suggest — generate suggestions for all
router.post('/usernames/auto-suggest', async (req, res) => {
  try {
    const result = await usernameSvc.autoSuggestAll();
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
        log.warn({ err, restaurantId: req.params.id }, 'Verification status fetch failed');
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
        log.warn({ err, restaurantId: req.params.id }, 'Messaging limit fetch failed');
      }
    }

    res.json(stored);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// CRIT-2B-10: override per-restaurant daily campaign send cap. 0 disables
// cap entirely; omit/null falls back to CAMPAIGN_DEFAULT_DAILY_CAP.
router.patch('/restaurants/:id/campaign-cap', requireAdminAuth('restaurants', 'manage'), express.json(), async (req, res) => {
  try {
    const raw = req.body?.campaign_daily_cap;
    if (raw === null || raw === undefined || raw === '') {
      await col('restaurants').updateOne(
        { _id: req.params.id },
        { $unset: { campaign_daily_cap: '' }, $set: { updated_at: new Date() } },
      );
      return res.json({ ok: true, campaign_daily_cap: null });
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 1000) {
      return res.status(400).json({ error: 'campaign_daily_cap must be a non-negative integer <= 1000' });
    }
    await col('restaurants').updateOne(
      { _id: req.params.id },
      { $set: { campaign_daily_cap: Math.floor(n), updated_at: new Date() } },
    );
    res.json({ ok: true, campaign_daily_cap: Math.floor(n) });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ═══════════════════════════════════════════════════════════════
// STAFF PIN — generate / status
// Plain PIN is returned ONLY by /generate (once); /status never leaks it.
// ═══════════════════════════════════════════════════════════════
router.post('/restaurants/:restaurantId/staff-pin/generate', requireAdminAuth('restaurants', 'manage'), async (req, res) => {
  try {
    const { generateStaffPin } = require('../services/staffPin');
    const { pin, updatedAt } = await generateStaffPin(req.params.restaurantId);
    return res.json({ success: true, pin, staff_pin_updated_at: updatedAt });
  } catch (e) {
    if (e.message === 'restaurant not found') return res.status(404).json({ error: 'Restaurant not found' });
    log.error({ err: e, restaurantId: req.params.restaurantId }, 'staff-pin generate failed');
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

router.get('/restaurants/:restaurantId/staff-pin/status', requireAdminAuth('restaurants', 'read'), async (req, res) => {
  try {
    const r = await col('restaurants').findOne(
      { _id: req.params.restaurantId },
      { projection: { staff_pin: 1, staff_pin_updated_at: 1 } }
    );
    if (!r) return res.status(404).json({ error: 'Restaurant not found' });
    return res.json({
      success: true,
      has_pin: !!r.staff_pin,
      staff_pin_updated_at: r.staff_pin_updated_at || null,
    });
  } catch (e) {
    log.error({ err: e, restaurantId: req.params.restaurantId }, 'staff-pin status failed');
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
      catalogTokenSource: metaConfig.systemUserToken ? 'META_SYSTEM_USER_TOKEN' : 'NONE',
      appId: metaConfig.appId || null,
      appSecret: !!metaConfig.appSecret,
      businessId: metaConfig.businessId || null,
      apiVersion: metaConfig.apiVersion,
      ...result,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Internal server error" });
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/admin/activity/stats — aggregated stats
router.get('/activity/stats', async (req, res) => {
  try {
    const stats = await actLog.getActivityStats();
    res.json(stats);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/admin/activity/errors — recent errors + critical
router.get('/activity/errors', async (req, res) => {
  try {
    const result = await actLog.getErrors({
      page: parseInt(req.query.page) || 1,
      limit: parseInt(req.query.limit) || 50,
    });
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/admin/webhooks/:id — single webhook with full payload
router.get('/webhooks/:id', async (req, res) => {
  try {
    const log = await col('webhook_logs').findOne({ _id: req.params.id });
    if (!log) return res.status(404).json({ error: 'Not found' });
    res.json(log);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/admin/issues/stats — global issue stats
router.get('/issues/stats', async (req, res) => {
  try {
    const filters = {};
    if (req.query.restaurant_id) filters.restaurantId = req.query.restaurant_id;
    if (req.query.admin_queue === 'true') filters.adminQueue = true;
    const stats = await issueSvc.getIssueStats(filters);
    res.json(stats);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── FINANCIAL ENDPOINTS ────────────────────────────────────────

// GET /api/admin/financials/overview
router.get('/financials/overview', async (req, res) => {
  try {
    const overview = await financials.getPlatformOverview(req.query.period, req.query.from, req.query.to);
    res.json(overview);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/admin/financials/restaurant/:id
router.get('/financials/restaurant/:id', async (req, res) => {
  try {
    const summary = await financials.getFinancialSummary(req.params.id, req.query.period || '30d', req.query.from, req.query.to);
    res.json(summary);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
      col('payments').find(match, {
        projection: {
          _id: 1, order_id: 1, status: 1, amount_rs: 1, currency: 1,
          rp_payment_id: 1, rp_order_id: 1, method: 1,
          created_at: 1, updated_at: 1, captured_at: 1,
        },
      }).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
      col('payments').countDocuments(match),
    ]);
    res.json({ payments, total, page, pages: Math.ceil(total / limit) });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
      col('payments').find(match, {
        projection: {
          _id: 1, order_id: 1, status: 1, amount_rs: 1, currency: 1,
          rp_payment_id: 1, rp_order_id: 1, rp_refund_id: 1, method: 1,
          refund_reason: 1, created_at: 1, updated_at: 1, refunded_at: 1,
        },
      }).sort({ updated_at: -1 }).skip(skip).limit(limit).toArray(),
      col('payments').countDocuments(match),
    ]);
    res.json({ refunds, total, page, pages: Math.ceil(total / limit) });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/admin/financials/tax
router.get('/financials/tax', async (req, res) => {
  try {
    const summary = await financials.getPlatformTaxSummary(req.query.fy);
    res.json(summary);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
          log.info({ catalogId: branchWithCatalog.catalog_id, restaurantName: rest.business_name }, 'Promoted catalog to main');
        } else {
          results.skipped++;
        }
      } catch (err) {
        results.errors.push(`${rest.business_name}: ${err.message}`);
      }
    }

    res.json({ success: true, ...results, total: restaurants.length });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/admin/migrate-catalog-architecture
// Full migration: branch_slug, branch-encoded retailer_ids, item_group_ids, catalog promotion
router.post('/migrate-catalog-architecture', requireAdmin, async (req, res) => {
  try {
    const stats = { branches_slugged: 0, items_retagged: 0, groups_set: 0, errors: [] };

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

    log.info(stats, 'Catalog architecture migration complete');
    res.json({ success: true, ...stats });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/admin/flow/create — create Flow on Meta + save to platform_settings
// Body: { force?: boolean, endpoint_uri?: string }
// `force=true` ignores the early-return guard and creates a brand-new Flow.
// Needed when migrating a published Flow (which Meta forbids editing) — we
// create a new Flow and re-point the DB in one go.
router.post('/flow/create', async (req, res) => {
  try {
    const force = !!req.body?.force;
    const endpointUri = req.body?.endpoint_uri || undefined;
    const existing = await col('platform_settings').findOne({ _id: 'whatsapp_flow' });
    if (existing?.flow_id && !force) {
      return res.json({ success: true, already_exists: true, flow_id: existing.flow_id, hint: 'pass { force: true } to create a new Flow (e.g. when migrating a published Flow)' });
    }

    // Use the platform WABA (from first active WA account or env)
    const wa = await col('whatsapp_accounts').findOne({ is_active: true });
    const wabaId = wa?.waba_id;
    if (!wabaId) return res.status(400).json({ error: 'No active WABA found on platform.' });

    const result = await flowMgr.createDeliveryFlow(wabaId, { endpointUri });
    if (!result.success) return res.status(400).json(result);

    const oldFlowId = existing?.flow_id || null;
    await col('platform_settings').updateOne(
      { _id: 'whatsapp_flow' },
      { $set: { flow_id: result.flowId, flow_name: 'GullyBite Delivery Address', flow_status: result.published ? 'PUBLISHED' : 'DRAFT', flow_json_version: '6.2', endpoint_uri: result.endpoint_uri || null, auto_assign_new: true, updated_at: new Date() }, $setOnInsert: { created_at: new Date() } },
      { upsert: true }
    );

    // If forcing a recreate, repoint every restaurant that was still on
    // the old Flow so the platform doesn't leave orphaned references.
    let repointed = 0;
    if (force && oldFlowId) {
      const r = await col('restaurants').updateMany(
        { flow_id: oldFlowId },
        { $set: { flow_id: result.flowId, updated_at: new Date() } }
      );
      repointed = r.modifiedCount;
    }

    res.json({ success: true, flow_id: result.flowId, published: result.published, endpoint_uri: result.endpoint_uri || null, old_flow_id: oldFlowId, restaurants_repointed: repointed });
  } catch (e) {
    log.error({ err: e }, 'Flow create error');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// GET /api/admin/flow/preview — get Flow preview URL
router.get('/flow/preview', async (req, res) => {
  try {
    const setting = await col('platform_settings').findOne({ _id: 'whatsapp_flow' });
    if (!setting?.flow_id) return res.status(404).json({ error: 'No Flow created yet.' });
    const data = await flowMgr.getFlowPreview(setting.flow_id);
    res.json(data);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/admin/flow/update — re-upload Flow JSON (DRAFT flows only)
// Body: { endpoint_uri?: string } — override the default endpoint URL
router.post('/flow/update', async (req, res) => {
  try {
    const setting = await col('platform_settings').findOne({ _id: 'whatsapp_flow' });
    if (!setting?.flow_id) return res.status(404).json({ error: 'No Flow created yet.' });
    const endpointUri = req.body?.endpoint_uri || undefined;
    const data = await flowMgr.updateFlowJson(setting.flow_id, { endpointUri });
    await col('platform_settings').updateOne(
      { _id: 'whatsapp_flow' },
      { $set: { endpoint_uri: data.endpoint_uri || null, updated_at: new Date() } }
    );
    res.json({ success: true, ...data });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/admin/flow/publish — publish a draft Flow
router.post('/flow/publish', async (req, res) => {
  try {
    const setting = await col('platform_settings').findOne({ _id: 'whatsapp_flow' });
    if (!setting?.flow_id) return res.status(404).json({ error: 'No Flow created yet.' });
    const data = await flowMgr.publishFlow(setting.flow_id);
    await col('platform_settings').updateOne({ _id: 'whatsapp_flow' }, { $set: { flow_status: 'PUBLISHED', updated_at: new Date() } });
    res.json({ success: true, ...data });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
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
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/admin/flow/assign-all — assign platform Flow to all restaurants
router.post('/flow/assign-all', async (req, res) => {
  try {
    const setting = await col('platform_settings').findOne({ _id: 'whatsapp_flow' });
    if (!setting?.flow_id) return res.status(404).json({ error: 'No Flow created yet.' });
    const result = await col('restaurants').updateMany({}, { $set: { flow_id: setting.flow_id } });
    res.json({ success: true, assigned: result.modifiedCount });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.post('/flow/toggle-auto-assign', async (req, res) => {
  try {
    const { enabled } = req.body;
    await col('platform_settings').updateOne(
      { _id: 'whatsapp_flow' },
      { $set: { auto_assign_new: !!enabled, updated_at: new Date() } }
    );
    res.json({ success: true, auto_assign_new: !!enabled });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/admin/flows — List ALL Flows from Meta API for the platform WABA
router.get('/flows', async (req, res) => {
  try {
    const wa = await col('whatsapp_accounts').findOne({ is_active: true });
    if (!wa?.waba_id) return res.status(400).json({ error: 'No active WABA found' });
    const token = metaConfig.getMessagingToken();
    const { data } = await axios.get(`${metaConfig.graphUrl}/${wa.waba_id}/flows`, {
      params: { access_token: token, fields: 'id,name,status,categories,validation_errors,json_version,data_api_version,updated_at', limit: 50 },
      timeout: 15000,
    });
    res.json({ flows: data.data || [], waba_id: wa.waba_id });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ── Static /flows/* routes MUST come before /flows/:flowId for Express matching ──

// GET /api/admin/flows/assignments — Current Flow assignments
router.get('/flows/assignments', async (req, res) => {
  try {
    const delivery = await col('platform_settings').findOne({ _id: 'whatsapp_flow' });
    const feedback = await col('platform_settings').findOne({ _id: 'feedback_flow' });
    res.json({ delivery: { flow_id: delivery?.flow_id || null, flow_name: delivery?.flow_name || null, flow_status: delivery?.flow_status || null, auto_assign: delivery?.auto_assign_new || false }, feedback: { flow_id: feedback?.flow_id || null, flow_name: feedback?.flow_name || null, flow_status: feedback?.flow_status || null } });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// PUT /api/admin/flows/assignments — Update Flow assignments
router.put('/flows/assignments', async (req, res) => {
  try {
    const { type, flow_id, flow_name } = req.body;
    if (!type || !['delivery', 'feedback'].includes(type)) return res.status(400).json({ error: 'type must be delivery or feedback' });
    const settingId = type === 'delivery' ? 'whatsapp_flow' : 'feedback_flow';
    await col('platform_settings').updateOne(
      { _id: settingId },
      { $set: { flow_id, flow_name: flow_name || null, flow_status: 'PUBLISHED', updated_at: new Date() }, $setOnInsert: { created_at: new Date() } },
      { upsert: true }
    );
    if (type === 'delivery' && flow_id) {
      await col('restaurants').updateMany({}, { $set: { flow_id } });
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/admin/flows/templates — Built-in Flow JSON templates
router.get('/flows/templates', async (req, res) => {
  try {
    res.json({ templates: [
      { id: 'delivery_address', name: 'Delivery Address (Full)', json: flowMgr.buildDeliveryFlowJson() },
      { id: 'feedback_rating', name: 'Order Rating (4 Categories)', json: flowMgr.buildFeedbackFlowJson() },
      { id: 'blank', name: 'Blank Skeleton', json: { version: '6.2', screens: [{ id: 'SCREEN_1', title: 'Screen Title', terminal: true, success: true, data: {}, layout: { type: 'SingleColumnLayout', children: [{ type: 'TextHeading', text: 'Heading' }, { type: 'TextBody', text: 'Body text' }, { type: 'Footer', label: 'Submit', 'on-click-action': { name: 'complete', payload: {} } }] } }] } },
      { id: 'lead_capture', name: 'Lead Capture / Contact Form', json: { version: '6.2', screens: [{ id: 'CONTACT', title: 'Contact Us', terminal: true, success: true, layout: { type: 'SingleColumnLayout', children: [{ type: 'TextHeading', text: 'Get in Touch' }, { type: 'TextInput', label: 'Your name', 'input-type': 'text', name: 'name', required: true }, { type: 'TextInput', label: 'Phone number', 'input-type': 'phone', name: 'phone', required: true }, { type: 'TextInput', label: 'Email', 'input-type': 'email', name: 'email', required: false }, { type: 'Dropdown', label: 'Inquiry type', name: 'inquiry_type', required: true, 'data-source': [{ id: 'general', title: 'General Inquiry' }, { id: 'partnership', title: 'Partnership' }, { id: 'catering', title: 'Catering' }, { id: 'feedback', title: 'Feedback' }] }, { type: 'TextInput', label: 'Message', 'input-type': 'text', name: 'message', required: false, 'helper-text': 'Tell us how we can help' }, { type: 'Footer', label: 'Submit', 'on-click-action': { name: 'complete', payload: { name: '${form.name}', phone: '${form.phone}', email: '${form.email}', inquiry_type: '${form.inquiry_type}', message: '${form.message}' } } }] } }] } },
      { id: 'table_booking', name: 'Table Booking', json: { version: '6.2', screens: [{ id: 'BOOKING', title: 'Book a Table', terminal: false, data: {}, layout: { type: 'SingleColumnLayout', children: [{ type: 'TextHeading', text: 'Reserve Your Table' }, { type: 'TextInput', label: 'Guest name', 'input-type': 'text', name: 'guest_name', required: true }, { type: 'TextInput', label: 'Phone', 'input-type': 'phone', name: 'guest_phone', required: true }, { type: 'DatePicker', label: 'Date', name: 'booking_date', required: true }, { type: 'Dropdown', label: 'Time slot', name: 'time_slot', required: true, 'data-source': [{ id: '12:00', title: '12:00 PM' }, { id: '13:00', title: '1:00 PM' }, { id: '14:00', title: '2:00 PM' }, { id: '19:00', title: '7:00 PM' }, { id: '20:00', title: '8:00 PM' }, { id: '21:00', title: '9:00 PM' }] }, { type: 'Dropdown', label: 'Party size', name: 'party_size', required: true, 'data-source': [{ id: '1', title: '1 person' }, { id: '2', title: '2 people' }, { id: '3-4', title: '3-4 people' }, { id: '5-6', title: '5-6 people' }, { id: '7+', title: '7+ people' }] }, { type: 'TextInput', label: 'Special requests', 'input-type': 'text', name: 'special_requests', required: false }, { type: 'Footer', label: 'Review Booking', 'on-click-action': { name: 'navigate', next: { type: 'screen', name: 'CONFIRM_BOOKING' }, payload: { guest_name: '${form.guest_name}', guest_phone: '${form.guest_phone}', booking_date: '${form.booking_date}', time_slot: '${form.time_slot}', party_size: '${form.party_size}', special_requests: '${form.special_requests}' } } }] } }, { id: 'CONFIRM_BOOKING', title: 'Confirm Booking', terminal: true, success: true, data: { guest_name: { type: 'string', __example__: 'Tarun' }, time_slot: { type: 'string', __example__: '8:00 PM' }, party_size: { type: 'string', __example__: '2 people' } }, layout: { type: 'SingleColumnLayout', children: [{ type: 'TextHeading', text: 'Confirm Your Reservation' }, { type: 'TextBody', text: 'Please review your booking details and tap Confirm.' }, { type: 'Footer', label: 'Confirm Booking', 'on-click-action': { name: 'complete', payload: { action: 'table_booking', guest_name: '${data.guest_name}', guest_phone: '${data.guest_phone}', booking_date: '${data.booking_date}', time_slot: '${data.time_slot}', party_size: '${data.party_size}', special_requests: '${data.special_requests}' } } }] } }] } },
      { id: 'survey', name: 'Customer Survey', json: { version: '6.2', screens: [{ id: 'Q1', title: 'Quick Survey', terminal: false, layout: { type: 'SingleColumnLayout', children: [{ type: 'TextHeading', text: 'Help us improve!' }, { type: 'RadioButtonsGroup', label: 'How did you hear about us?', name: 'source', required: true, 'data-source': [{ id: 'social_media', title: 'Social media' }, { id: 'friend', title: 'Friend/Family' }, { id: 'google', title: 'Google search' }, { id: 'walk_in', title: 'Walked by' }, { id: 'other', title: 'Other' }] }, { type: 'Footer', label: 'Next', 'on-click-action': { name: 'navigate', next: { type: 'screen', name: 'Q2' }, payload: { source: '${form.source}' } } }] } }, { id: 'Q2', title: 'Your Preferences', terminal: false, data: { source: { type: 'string', __example__: 'social_media' } }, layout: { type: 'SingleColumnLayout', children: [{ type: 'TextHeading', text: 'What do you love?' }, { type: 'CheckboxGroup', label: 'Select all that apply', name: 'preferences', required: true, 'data-source': [{ id: 'taste', title: 'Great taste' }, { id: 'price', title: 'Good prices' }, { id: 'delivery', title: 'Fast delivery' }, { id: 'variety', title: 'Menu variety' }, { id: 'healthy', title: 'Healthy options' }] }, { type: 'Footer', label: 'Next', 'on-click-action': { name: 'navigate', next: { type: 'screen', name: 'Q3' }, payload: { source: '${data.source}', preferences: '${form.preferences}' } } }] } }, { id: 'Q3', title: 'Feedback', terminal: true, success: true, data: { source: { type: 'string', __example__: 'social_media' }, preferences: { type: 'string', __example__: 'taste' } }, layout: { type: 'SingleColumnLayout', children: [{ type: 'TextHeading', text: 'Any suggestions?' }, { type: 'TextInput', label: 'Your feedback', 'input-type': 'text', name: 'feedback', required: false, 'helper-text': 'Tell us anything — we read every response!' }, { type: 'Footer', label: 'Submit', 'on-click-action': { name: 'complete', payload: { action: 'survey_response', source: '${data.source}', preferences: '${data.preferences}', feedback: '${form.feedback}' } } }] } }] } },
      { id: 'order_preferences', name: 'Order Preferences', json: { version: '6.2', screens: [{ id: 'PREFERENCES', title: 'Your Preferences', terminal: true, success: true, layout: { type: 'SingleColumnLayout', children: [{ type: 'TextHeading', text: 'Customize Your Order' }, { type: 'CheckboxGroup', label: 'Dietary preferences', name: 'dietary', required: false, 'data-source': [{ id: 'veg', title: 'Vegetarian' }, { id: 'vegan', title: 'Vegan' }, { id: 'jain', title: 'Jain' }, { id: 'gluten_free', title: 'Gluten-free' }, { id: 'none', title: 'No restrictions' }] }, { type: 'RadioButtonsGroup', label: 'Spice level', name: 'spice_level', required: true, 'data-source': [{ id: 'mild', title: '\uD83C\uDF36 Mild' }, { id: 'medium', title: '\uD83C\uDF36\uD83C\uDF36 Medium' }, { id: 'hot', title: '\uD83C\uDF36\uD83C\uDF36\uD83C\uDF36 Hot' }, { id: 'extra_hot', title: '\uD83D\uDD25 Extra Hot' }] }, { type: 'TextInput', label: 'Special instructions', 'input-type': 'text', name: 'instructions', required: false, 'helper-text': 'Allergies, no onion/garlic, extra sauce, etc.' }, { type: 'Footer', label: 'Save Preferences', 'on-click-action': { name: 'complete', payload: { dietary: '${form.dietary}', spice_level: '${form.spice_level}', instructions: '${form.instructions}' } } }] } }] } },
    ]});
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/admin/flows/:flowId — Get single Flow details including JSON
router.get('/flows/:flowId', async (req, res) => {
  try {
    const token = metaConfig.getMessagingToken();
    const { data } = await axios.get(`${metaConfig.graphUrl}/${req.params.flowId}`, {
      params: { access_token: token, fields: 'id,name,status,categories,json_version,preview,validation_errors' },
      timeout: 15000,
    });
    res.json(data);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/admin/flows — Create a new Flow on Meta
router.post('/flows', async (req, res) => {
  try {
    const { name, categories, flow_json } = req.body;
    if (!name) return res.status(400).json({ error: 'Flow name is required' });
    const wa = await col('whatsapp_accounts').findOne({ is_active: true });
    if (!wa?.waba_id) return res.status(400).json({ error: 'No active WABA found' });
    const token = metaConfig.getMessagingToken();
    const body = { name, categories: categories || ['OTHER'] };
    if (flow_json) body.flow_json = typeof flow_json === 'string' ? flow_json : JSON.stringify(flow_json);
    const { data } = await axios.post(`${metaConfig.graphUrl}/${wa.waba_id}/flows`, body, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20000,
    });
    res.json({ success: true, flow_id: data.id, validation_errors: data.validation_errors });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/admin/flows/:flowId/publish — Publish a DRAFT Flow
router.post('/flows/:flowId/publish', async (req, res) => {
  try { await flowMgr.publishFlow(req.params.flowId); res.json({ success: true }); }
  catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/admin/flows/:flowId/deprecate — Deprecate a PUBLISHED Flow
router.post('/flows/:flowId/deprecate', async (req, res) => {
  try { await flowMgr.deprecateFlow(req.params.flowId); res.json({ success: true }); }
  catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// PUT /api/admin/flows/:flowId — Update Flow JSON (DRAFT only)
router.put('/flows/:flowId', async (req, res) => {
  try {
    const { flow_json } = req.body;
    if (!flow_json) return res.status(400).json({ error: 'flow_json is required' });
    const token = metaConfig.getMessagingToken();
    const jsonStr = typeof flow_json === 'string' ? flow_json : JSON.stringify(flow_json);
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', Buffer.from(jsonStr), { filename: 'flow.json', contentType: 'application/json' });
    form.append('name', 'flow.json');
    form.append('asset_type', 'FLOW_JSON');
    const { data } = await axios.post(`${metaConfig.graphUrl}/${req.params.flowId}/assets`, form, {
      headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() }, timeout: 20000,
    });
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// GET /api/admin/flows/:flowId/json — Download Flow JSON asset
// Returns: { flow_json, asset_id, name, status }
// The frontend's normalizeFlow() unwraps flow_json automatically.
router.get('/flows/:flowId/json', async (req, res) => {
  try {
    const token = metaConfig.getMessagingToken();
    // Fetch flow metadata and assets in parallel for the editor header
    const [metaResult, assetsResult] = await Promise.allSettled([
      axios.get(`${metaConfig.graphUrl}/${req.params.flowId}`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { fields: 'id,name,status,categories,json_version' },
        timeout: 10000,
      }),
      axios.get(`${metaConfig.graphUrl}/${req.params.flowId}/assets`, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 10000,
      }),
    ]);

    if (assetsResult.status !== 'fulfilled') {
      throw assetsResult.reason;
    }
    const assets = assetsResult.value.data;
    const flowAsset = (assets.data || []).find(a => a.asset_type === 'FLOW_JSON');
    if (!flowAsset?.download_url) return res.status(404).json({ error: 'No Flow JSON asset found' });

    const { data: flowJson } = await axios.get(flowAsset.download_url, { timeout: 10000 });

    const meta = metaResult.status === 'fulfilled' ? metaResult.value.data : {};
    res.json({
      flow_json: flowJson,
      asset_id: flowAsset.id,
      name: meta.name || null,
      status: meta.status || null,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// DELETE /api/admin/flows/:flowId — Delete a DRAFT Flow
router.delete('/flows/:flowId', async (req, res) => {
  try {
    const token = metaConfig.getMessagingToken();
    await axios.delete(`${metaConfig.graphUrl}/${req.params.flowId}`, { params: { access_token: token }, timeout: 15000 });
    // Clear from platform_settings if it was assigned
    await col('platform_settings').updateMany({ flow_id: req.params.flowId }, { $set: { flow_id: null, flow_status: null, updated_at: new Date() } });
    await col('restaurants').updateMany({ flow_id: req.params.flowId }, { $set: { flow_id: null } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});


// ─── ADMIN WABA MANAGEMENT ───────────────────────────────────

// GET /api/admin/waba/config — get admin WABA config
router.get('/waba/config', async (req, res) => {
  try {
    const config = await col('admin_waba_config').findOne({ _id: 'admin_waba' });
    res.json(config || { _id: 'admin_waba', status: 'disconnected' });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// PUT /api/admin/waba/config — connect/update admin WABA
router.put('/waba/config', express.json(), async (req, res) => {
  try {
    const { waba_id, business_id, referral_commission_pct, referral_gst_pct, referral_window_hours } = req.body;
    const $set = { updated_at: new Date() };
    if (waba_id) {
      // Validate with Meta
      const token = metaConfig.getMessagingToken();
      const { data } = await axios.get(`${metaConfig.graphUrl}/${waba_id}`, {
        params: { access_token: token, fields: 'name,currency,timezone_id,account_review_status' }, timeout: 10000,
      });
      $set.waba_id = waba_id;
      $set.waba_name = data.name;
      $set.currency = data.currency;
      $set.timezone_id = data.timezone_id;
      $set.account_review_status = data.account_review_status;
      $set.status = 'connected';
      $set.connected_at = new Date();
    }
    if (business_id) $set.business_id = business_id;
    if (referral_commission_pct !== undefined) $set.referral_commission_pct = referral_commission_pct;
    if (referral_gst_pct !== undefined) $set.referral_gst_pct = referral_gst_pct;
    if (referral_window_hours !== undefined) $set.referral_window_hours = referral_window_hours;
    await col('admin_waba_config').updateOne({ _id: 'admin_waba' }, { $set, $setOnInsert: { created_at: new Date() } }, { upsert: true });
    const updated = await col('admin_waba_config').findOne({ _id: 'admin_waba' });
    res.json(updated);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/admin/waba/numbers — list admin numbers
router.get('/waba/numbers', async (req, res) => {
  try {
    const numbers = await col('admin_numbers').find({}).sort({ created_at: -1 }).toArray();
    res.json(mapIds(numbers));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/admin/waba/numbers — add admin number (validates with Meta)
router.post('/waba/numbers', express.json(), async (req, res) => {
  try {
    const { phone_number_id, label, purpose, assigned_to } = req.body;
    if (!phone_number_id) return res.status(400).json({ error: 'phone_number_id is required' });
    const token = metaConfig.getMessagingToken();
    const { data } = await axios.get(`${metaConfig.graphUrl}/${phone_number_id}`, {
      params: { access_token: token, fields: 'display_phone_number,verified_name,quality_rating,messaging_limit,name_status,is_official_business_account,throughput' },
      timeout: 10000,
    });
    const doc = {
      _id: newId(), phone_number_id,
      display_phone_number: data.display_phone_number || '',
      display_name: data.verified_name || label || '',
      verified_name: data.verified_name || '',
      purpose: purpose || 'general', assigned_to: assigned_to || null, label: label || data.verified_name || '',
      quality_rating: data.quality_rating || null,
      messaging_limit_tier: data.messaging_limit?.tier || null,
      name_status: data.name_status || null,
      is_official_business_account: data.is_official_business_account || false,
      throughput_level: data.throughput?.level || 'STANDARD',
      quality_last_checked: new Date(),
      is_active: true, webhook_registered: false,
      messages_sent_today: 0, messages_received_today: 0,
      created_at: new Date(), updated_at: new Date(),
    };
    await col('admin_numbers').insertOne(doc);
    res.json(mapId(doc));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// PUT /api/admin/waba/numbers/:id — update label, purpose, etc.
router.put('/waba/numbers/:id', express.json(), async (req, res) => {
  try {
    const { label, purpose, assigned_to, is_active } = req.body;
    const $set = { updated_at: new Date() };
    if (label !== undefined) $set.label = label;
    if (purpose !== undefined) $set.purpose = purpose;
    if (assigned_to !== undefined) $set.assigned_to = assigned_to;
    if (is_active !== undefined) $set.is_active = is_active;
    await col('admin_numbers').updateOne({ _id: req.params.id }, { $set });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/admin/waba/numbers/:id/refresh — refresh quality data from Meta
router.post('/waba/numbers/:id/refresh', async (req, res) => {
  try {
    const num = await col('admin_numbers').findOne({ _id: req.params.id });
    if (!num) return res.status(404).json({ error: 'Number not found' });
    const token = metaConfig.getMessagingToken();
    const { data } = await axios.get(`${metaConfig.graphUrl}/${num.phone_number_id}`, {
      params: { access_token: token, fields: 'quality_rating,messaging_limit,name_status,is_official_business_account,throughput' },
      timeout: 10000,
    });
    await col('admin_numbers').updateOne({ _id: num._id }, { $set: {
      quality_rating: data.quality_rating, messaging_limit_tier: data.messaging_limit?.tier,
      name_status: data.name_status, is_official_business_account: data.is_official_business_account,
      throughput_level: data.throughput?.level, quality_last_checked: new Date(), updated_at: new Date(),
    }});
    res.json({ success: true, quality_rating: data.quality_rating, messaging_limit_tier: data.messaging_limit?.tier });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/admin/waba/send — send message from admin number
router.post('/waba/send', express.json(), async (req, res) => {
  try {
    const { phone_number_id, to, type, text, template, buttons } = req.body;
    if (!phone_number_id || !to) return res.status(400).json({ error: 'phone_number_id and to are required' });
    const token = metaConfig.getMessagingToken();
    let result;
    if (type === 'template' && template) {
      result = await wa.sendTemplate(phone_number_id, token, to, template);
    } else if (type === 'buttons' && buttons) {
      result = await wa.sendButtons(phone_number_id, token, to, buttons);
    } else {
      result = await wa.sendText(phone_number_id, token, to, text || '');
    }
    // Log outgoing
    col('admin_messages').insertOne({
      _id: newId(), admin_number_id: phone_number_id, phone_number_id,
      customer_phone: to, direction: 'outgoing',
      message_type: type || 'text', message_content: text || template?.name || 'message',
      wa_message_id: result?.messages?.[0]?.id || null, timestamp: new Date(),
    }).catch(() => {});
    res.json({ success: true, wa_message_id: result?.messages?.[0]?.id });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/admin/waba/messages — recent admin messages
router.get('/waba/messages', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const msgs = await col('admin_messages').find({}).sort({ timestamp: -1 }).limit(limit).toArray();
    res.json(mapIds(msgs));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/admin/waba/webhook-info — webhook registration info
router.get('/waba/webhook-info', (req, res) => {
  res.json({
    webhook_url: `${process.env.BASE_URL}/webhooks/directory`,
    verify_token: process.env.WEBHOOK_VERIFY_TOKEN || '(not set)',
    instructions: 'Go to Meta Developer Console → your app → WhatsApp → Configuration → Edit webhook URL → paste the URL and verify token above',
  });
});

// ─── FINANCE CONFIG ──────────────────────────────────────────
const financeConfig = require('../config/financeConfig');

// GET /api/admin/finance/config — current finance configuration
router.get('/finance/config', (req, res) => {
  res.json({
    ...financeConfig.FINANCE_CONFIG,
    computed: {
      currentFY: require('../services/financials').getCurrentFYLabel ? require('../services/financials').getCurrentFYLabel() : null,
    },
  });
});

// GET /api/admin/finance/restaurant-status/:restaurantId — restaurant billing status
router.get('/finance/restaurant-status/:restaurantId', async (req, res) => {
  try {
    const restaurant = await col('restaurants').findOne({ _id: req.params.restaurantId });
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
    res.json({
      restaurantId: req.params.restaurantId,
      businessName: restaurant.business_name,
      commissionRatePct: financeConfig.getPlatformFeePercent(restaurant),
      isFirstBillingMonth: financeConfig.isFirstBillingMonth(restaurant),
      platformFeeWaived: !financeConfig.shouldDeductPlatformFee(restaurant),
      platformFeeGstWaived: !financeConfig.shouldDeductPlatformFeeGst(restaurant),
      billingStartDate: restaurant.billing_start_date || restaurant.approved_at || restaurant.created_at,
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── CATALOG COMPRESSION ENGINE ──────────────────────────────
const compression = require('../services/catalogCompression');

// POST /api/admin/compression/rebuild/:restaurantId — full rebuild
router.post('/compression/rebuild/:restaurantId', async (req, res) => {
  try {
    const { dryRun, includeMedia } = req.body || {};
    const result = await compression.rebuildCompressedCatalog(req.params.restaurantId, { dryRun: !!dryRun, includeMedia: !!includeMedia });
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/admin/compression/summary/:restaurantId — compression stats
router.get('/compression/summary/:restaurantId', async (req, res) => {
  try {
    const summary = await compression.getCompressionSummary(req.params.restaurantId);
    res.json(summary);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/admin/compression/branch-preview/:restaurantId/:branchId — branch mapping preview
router.get('/compression/branch-preview/:restaurantId/:branchId', async (req, res) => {
  try {
    const preview = await compression.getBranchMappingPreview(req.params.restaurantId, req.params.branchId);
    res.json(preview);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/admin/compression/runs/:restaurantId — compression run history
router.get('/compression/runs/:restaurantId', async (req, res) => {
  try {
    const runs = await col('catalog_compression_runs').find({ restaurantId: req.params.restaurantId }).sort({ startedAt: -1 }).limit(20).toArray();
    res.json(runs);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── MPM STRATEGY ────────────────────────────────────────────
const mpmStrategy = require('../services/mpmStrategy');

// GET /api/admin/mpm-preview/:restaurantId/:branchId — preview MPM strategy output
router.get('/mpm-preview/:restaurantId/:branchId', async (req, res) => {
  try {
    const preview = await mpmStrategy.getMPMPreview(req.params.branchId, req.params.restaurantId);
    res.json(preview);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── REORDER INTELLIGENCE ────────────────────────────────────
const reorderIntel = require('../services/reorderIntelligence');

// GET /api/admin/reorder-preview/:restaurantId/:branchId/:customerId
router.get('/reorder-preview/:restaurantId/:branchId/:customerId', async (req, res) => {
  try {
    const { restaurantId, branchId, customerId } = req.params;
    // Get available items for the branch (same source as MPM strategy)
    const items = await col('menu_items').find({ branch_id: branchId, is_available: true }).toArray();
    const preview = await reorderIntel.getReorderPreview(customerId, branchId, restaurantId, items);
    res.json(preview);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── CONTACT BOOK (BSUID → Phone mapping) ───────────────────
router.get('/waba/contact-book-status', async (req, res) => {
  try {
    const accounts = await col('whatsapp_accounts').find({ is_active: true }).toArray();
    const results = accounts.map(a => ({
      waba_id: a.waba_id,
      restaurant_id: a.restaurant_id,
      contact_book_enabled: !!a.contact_book_enabled,
      contact_book_enabled_at: a.contact_book_enabled_at || null,
    }));
    const totalCustomers = await col('customers').countDocuments({});
    const withBsuid = await col('customers').countDocuments({ bsuid: { $exists: true, $ne: null } });
    const withPhone = await col('customers').countDocuments({ wa_phone: { $exists: true, $ne: null } });
    res.json({ wabas: results, customers: { total: totalCustomers, with_bsuid: withBsuid, with_phone: withPhone, phone_only: withPhone - withBsuid } });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.post('/waba/:wabaId/enable-contact-book', async (req, res) => {
  try {
    const { wabaId } = req.params;
    const token = metaConfig.getMessagingToken();
    // Enable Contact Book via Meta API
    const { data } = await axios.post(
      `${metaConfig.graphUrl}/${wabaId}`,
      { contact_book_enabled: true },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
    );
    await col('whatsapp_accounts').updateMany(
      { waba_id: wabaId },
      { $set: { contact_book_enabled: true, contact_book_enabled_at: new Date() } }
    );
    logActivity({ actorType: 'admin', action: 'waba.contact_book_enabled', category: 'settings', description: `Contact Book enabled for WABA ${wabaId}`, severity: 'info' });
    res.json({ success: true, waba_id: wabaId });
  } catch (e) {
    req.log.error({ err: e, wabaId }, 'contact book enable failed');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

router.post('/waba/enable-all-contact-books', async (req, res) => {
  try {
    const accounts = await col('whatsapp_accounts').find({ is_active: true, contact_book_enabled: { $ne: true } }).toArray();
    const wabaIds = [...new Set(accounts.map(a => a.waba_id).filter(Boolean))];
    const token = metaConfig.getMessagingToken();
    let enabled = 0, failed = 0;
    for (const wabaId of wabaIds) {
      try {
        await axios.post(`${metaConfig.graphUrl}/${wabaId}`, { contact_book_enabled: true }, { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 });
        await col('whatsapp_accounts').updateMany({ waba_id: wabaId }, { $set: { contact_book_enabled: true, contact_book_enabled_at: new Date() } });
        enabled++;
      } catch (e) {
        req.log.error({ err: e, wabaId }, 'contact book enable failed for WABA');
        failed++;
      }
    }
    logActivity({ actorType: 'admin', action: 'waba.contact_book_bulk_enabled', category: 'settings', description: `Contact Book bulk enable: ${enabled} enabled, ${failed} failed`, severity: 'info' });
    res.json({ success: true, enabled, failed, already_enabled: accounts.length - wabaIds.length });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── MM LITE (Marketing Messages Lite) ──────────────────────
router.get('/mm-lite/status', async (req, res) => {
  try {
    const setting = await col('platform_settings').findOne({ _id: 'mm_lite' });
    res.json({ enabled: !!setting?.enabled, updated_at: setting?.updated_at || null });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.post('/mm-lite/toggle', async (req, res) => {
  try {
    const { enabled } = req.body;
    await col('platform_settings').updateOne(
      { _id: 'mm_lite' },
      { $set: { enabled: !!enabled, updated_at: new Date() }, $setOnInsert: { created_at: new Date() } },
      { upsert: true }
    );
    res.json({ success: true, enabled: !!enabled });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── FEEDBACK FLOW ──────────────────────────────────────────
router.post('/flow/create-feedback', async (req, res) => {
  try {
    const existing = await col('platform_settings').findOne({ _id: 'feedback_flow' });
    if (existing?.flow_id) return res.json({ success: true, already_exists: true, flow_id: existing.flow_id });

    const wa = await col('whatsapp_accounts').findOne({ is_active: true });
    if (!wa?.waba_id) return res.status(400).json({ error: 'No active WABA found.' });

    const result = await flowMgr.createFeedbackFlow(wa.waba_id);
    if (!result.success) return res.status(400).json(result);

    await col('platform_settings').updateOne(
      { _id: 'feedback_flow' },
      { $set: { flow_id: result.flowId, flow_status: result.published ? 'PUBLISHED' : 'DRAFT', updated_at: new Date() }, $setOnInsert: { created_at: new Date() } },
      { upsert: true }
    );

    res.json({ success: true, flow_id: result.flowId });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.get('/flow/feedback-status', async (req, res) => {
  try {
    const setting = await col('platform_settings').findOne({ _id: 'feedback_flow' });
    res.json(setting || { flow_id: null });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── DROP-OFF / FUNNEL ANALYTICS (PLATFORM-WIDE) ───────────
const dropoff = require('../services/dropoff');

// GET /api/admin/analytics/funnel — platform-wide conversion funnel
router.get('/analytics/funnel', async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from) : undefined;
    const to = req.query.to ? new Date(req.query.to) : undefined;

    if (req.query.group_by === 'restaurant') {
      const restaurants = await col('restaurants').find({}, { projection: { business_name: 1 } }).toArray();
      const funnels = [];
      for (const r of restaurants) {
        const result = await dropoff.getDropoffs(String(r._id), { from, to, includeDetails: false });
        funnels.push({ restaurant_id: String(r._id), restaurant_name: r.business_name, ...result.summary, funnel: result.funnel });
      }
      return res.json({ group_by: 'restaurant', data: funnels });
    }

    const result = await dropoff.getDropoffs(null, { from, to, includeDetails: false });
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/admin/analytics/dropoffs — platform-wide dropoff list with restaurant names
router.get('/analytics/dropoffs', async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from) : undefined;
    const to = req.query.to ? new Date(req.query.to) : undefined;
    const result = await dropoff.getDropoffs(null, {
      from, to, stage: req.query.stage, limit: parseInt(req.query.limit) || 100, includeDetails: true,
    });

    if (result.dropoffs?.length) {
      const waIds = [...new Set(result.dropoffs.map(d => d.wa_account_id).filter(Boolean))];
      const waAccs = await col('whatsapp_accounts').find({ _id: { $in: waIds } }).toArray();
      const waMap = {};
      for (const w of waAccs) waMap[String(w._id)] = w;
      const restIds = [...new Set(Object.values(waMap).map(w => w.restaurant_id))];
      const rests = await col('restaurants').find({ _id: { $in: restIds } }).toArray();
      const restMap = {};
      for (const r of rests) restMap[String(r._id)] = r.business_name;
      for (const d of result.dropoffs) {
        const wa = waMap[d.wa_account_id];
        d.restaurant_name = wa ? (restMap[wa.restaurant_id] || null) : null;
        delete d.wa_account_id;
      }
    }
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ═══════════════════════════════════════════════════════════════
// RECONCILIATION TOOLS
// Internal debug tools for payment/order and settlement/payout mismatches.
// ═══════════════════════════════════════════════════════════════

// ─── PAYMENT ↔ ORDER RECONCILIATION ──────────────────────────
// Finds mismatches between the orders and payments collections:
//   - Orders marked PAID but no payment record exists
//   - Orders marked PAID but payment record says failed/expired
//   - Payment records marked paid but order status isn't PAID/CONFIRMED/etc.
//   - Orphan payments with no matching order
//   - Orders stuck in PENDING_PAYMENT beyond expiry
//
// GET /api/admin/reconciliation/payments?days=7&restaurantId=xxx
router.get('/reconciliation/payments', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const since = new Date(Date.now() - days * 86400000);
    const restaurantFilter = req.query.restaurantId ? { restaurant_id: req.query.restaurantId } : {};

    // 1. All recent orders
    const orders = await col('orders').find({
      created_at: { $gte: since },
      ...restaurantFilter,
    }, { projection: {
      _id: 1, order_number: 1, status: 1, payment_status: 1,
      total_rs: 1, restaurant_id: 1, created_at: 1, settlement_id: 1,
    }}).toArray();

    const orderIds = orders.map(o => String(o._id));

    // 2. All payments for those orders
    const payments = await col('payments').find({
      order_id: { $in: orderIds },
    }, { projection: {
      _id: 1, order_id: 1, status: 1, amount_rs: 1, payment_type: 1,
      rp_order_id: 1, rp_payment_id: 1, created_at: 1, paid_at: 1,
    }}).toArray();

    const paymentsByOrderId = {};
    for (const p of payments) {
      if (!paymentsByOrderId[p.order_id]) paymentsByOrderId[p.order_id] = [];
      paymentsByOrderId[p.order_id].push(p);
    }

    // 3. Detect anomalies
    const anomalies = [];
    const paidStatuses = new Set(['PAID', 'CONFIRMED', 'PREPARING', 'PACKED', 'DISPATCHED', 'DELIVERED']);

    for (const order of orders) {
      const oid = String(order._id);
      const orderPayments = paymentsByOrderId[oid] || [];

      // A: Order is in a paid/post-paid state but no payment record
      if (paidStatuses.has(order.status) && orderPayments.length === 0) {
        anomalies.push({
          type: 'ORDER_PAID_NO_PAYMENT',
          severity: 'critical',
          order_id: oid,
          order_number: order.order_number,
          order_status: order.status,
          total_rs: order.total_rs,
          description: `Order ${order.order_number} is ${order.status} but has no payment record`,
        });
      }

      // B: Order paid, but payment record says failed/expired
      if (paidStatuses.has(order.status) && orderPayments.length > 0) {
        const hasPaid = orderPayments.some(p => p.status === 'paid');
        if (!hasPaid) {
          anomalies.push({
            type: 'ORDER_PAID_PAYMENT_MISMATCH',
            severity: 'critical',
            order_id: oid,
            order_number: order.order_number,
            order_status: order.status,
            payment_statuses: orderPayments.map(p => p.status),
            total_rs: order.total_rs,
            description: `Order ${order.order_number} is ${order.status} but payment(s) show: ${orderPayments.map(p => p.status).join(', ')}`,
          });
        }
      }

      // C: Order stuck in PENDING_PAYMENT for >30 min
      if (order.status === 'PENDING_PAYMENT') {
        const ageMs = Date.now() - new Date(order.created_at).getTime();
        if (ageMs > 30 * 60000) {
          anomalies.push({
            type: 'ORDER_STUCK_PENDING',
            severity: 'warning',
            order_id: oid,
            order_number: order.order_number,
            age_minutes: Math.round(ageMs / 60000),
            total_rs: order.total_rs,
            description: `Order ${order.order_number} stuck in PENDING_PAYMENT for ${Math.round(ageMs / 60000)} minutes`,
          });
        }
      }

      // D: Amount mismatch — order total doesn't match payment amount
      if (orderPayments.length > 0) {
        for (const p of orderPayments) {
          if (p.status === 'paid' && Math.abs(p.amount_rs - order.total_rs) > 0.01) {
            anomalies.push({
              type: 'AMOUNT_MISMATCH',
              severity: 'critical',
              order_id: oid,
              order_number: order.order_number,
              order_total_rs: order.total_rs,
              payment_amount_rs: p.amount_rs,
              diff_rs: Math.abs(p.amount_rs - order.total_rs),
              description: `Order ${order.order_number}: order total ₹${order.total_rs} ≠ payment ₹${p.amount_rs}`,
            });
          }
        }
      }
    }

    // E: Orphan payments — paid but no matching order found
    const allPayments = await col('payments').find({
      created_at: { $gte: since },
      status: 'paid',
    }, { projection: { _id: 1, order_id: 1, amount_rs: 1, rp_payment_id: 1, paid_at: 1 }}).toArray();

    const orderIdSet = new Set(orderIds);
    for (const p of allPayments) {
      if (!p.order_id || !orderIdSet.has(p.order_id)) {
        // Verify the order actually doesn't exist (not just filtered by date/restaurant)
        const orderExists = await col('orders').findOne({ _id: p.order_id }, { projection: { _id: 1 } });
        if (!orderExists) {
          anomalies.push({
            type: 'ORPHAN_PAYMENT',
            severity: 'warning',
            payment_id: String(p._id),
            order_id: p.order_id,
            amount_rs: p.amount_rs,
            rp_payment_id: p.rp_payment_id,
            description: `Payment ₹${p.amount_rs} (${p.rp_payment_id}) has no matching order`,
          });
        }
      }
    }

    // Sort: critical first, then warning
    anomalies.sort((a, b) => (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1));

    const summary = {
      period_days: days,
      total_orders: orders.length,
      total_payments: payments.length,
      anomaly_count: anomalies.length,
      critical: anomalies.filter(a => a.severity === 'critical').length,
      warnings: anomalies.filter(a => a.severity === 'warning').length,
      by_type: {},
    };
    for (const a of anomalies) {
      summary.by_type[a.type] = (summary.by_type[a.type] || 0) + 1;
    }

    res.json({ summary, anomalies });
  } catch (e) { req.log.error({ err: e }, 'Payment reconciliation failed'); res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── SETTLEMENT ↔ PAYOUT RECONCILIATION ─────────────────────
// Finds mismatches between settlements and payouts:
//   - Settlements stuck in 'pending' beyond 48h
//   - Settlements marked 'processing' with no payout ID
//   - Settlements where order counts don't match actual settled orders
//   - Payout amount vs settlement net_payout mismatch
//   - Orders marked as settled but settlement doesn't exist
//
// GET /api/admin/reconciliation/settlements?days=30&restaurantId=xxx
router.get('/reconciliation/settlements', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const since = new Date(Date.now() - days * 86400000);
    const restaurantFilter = req.query.restaurantId ? { restaurant_id: req.query.restaurantId } : {};

    // 1. All recent settlements
    const settlements = await col('settlements').find({
      created_at: { $gte: since },
      ...restaurantFilter,
    }).toArray();

    // 2. Get restaurant names for context
    const restIds = [...new Set(settlements.map(s => s.restaurant_id))];
    const restaurants = await col('restaurants').find(
      { _id: { $in: restIds } },
      { projection: { _id: 1, business_name: 1 } }
    ).toArray();
    const restNames = {};
    for (const r of restaurants) restNames[String(r._id)] = r.business_name;

    const anomalies = [];

    for (const s of settlements) {
      const sid = String(s._id);
      const name = restNames[s.restaurant_id] || s.restaurant_id;

      // A: Settlement stuck in 'pending' beyond 48h
      if (s.payout_status === 'pending') {
        const ageMs = Date.now() - new Date(s.created_at).getTime();
        if (ageMs > 48 * 3600000) {
          anomalies.push({
            type: 'SETTLEMENT_STUCK_PENDING',
            severity: 'warning',
            settlement_id: sid,
            restaurant: name,
            restaurant_id: s.restaurant_id,
            net_payout_rs: s.net_payout_rs,
            age_hours: Math.round(ageMs / 3600000),
            period: `${s.period_start?.toISOString?.()?.slice(0,10) || '?'} → ${s.period_end?.toISOString?.()?.slice(0,10) || '?'}`,
            description: `Settlement for ${name} stuck pending for ${Math.round(ageMs / 3600000)}h — ₹${s.net_payout_rs}`,
          });
        }
      }

      // B: Settlement 'processing' but no Razorpay payout ID
      if (s.payout_status === 'processing' && !s.rp_payout_id) {
        anomalies.push({
          type: 'PROCESSING_NO_PAYOUT_ID',
          severity: 'critical',
          settlement_id: sid,
          restaurant: name,
          restaurant_id: s.restaurant_id,
          net_payout_rs: s.net_payout_rs,
          description: `Settlement for ${name} is 'processing' but has no Razorpay payout ID`,
        });
      }

      // C: Payout failed — needs attention
      if (s.payout_status === 'failed') {
        anomalies.push({
          type: 'PAYOUT_FAILED',
          severity: 'critical',
          settlement_id: sid,
          restaurant: name,
          restaurant_id: s.restaurant_id,
          net_payout_rs: s.net_payout_rs,
          rp_payout_id: s.rp_payout_id,
          description: `Payout failed for ${name} — ₹${s.net_payout_rs} not transferred`,
        });
      }

      // D: Order count validation — verify settled order count matches
      const settledOrders = await col('orders').countDocuments({ settlement_id: sid });
      if (settledOrders !== s.orders_count) {
        anomalies.push({
          type: 'ORDER_COUNT_MISMATCH',
          severity: 'warning',
          settlement_id: sid,
          restaurant: name,
          expected_count: s.orders_count,
          actual_count: settledOrders,
          description: `Settlement for ${name} claims ${s.orders_count} orders but ${settledOrders} are actually linked`,
        });
      }

      // E: Negative net payout (restaurant owes money)
      if (s.net_payout_rs < 0) {
        anomalies.push({
          type: 'NEGATIVE_PAYOUT',
          severity: 'warning',
          settlement_id: sid,
          restaurant: name,
          net_payout_rs: s.net_payout_rs,
          description: `Settlement for ${name} has negative payout ₹${s.net_payout_rs} — deductions exceed revenue`,
        });
      }

      // F: Financial sanity — gross must be >= net
      if (s.gross_revenue_rs > 0 && s.net_payout_rs > s.gross_revenue_rs) {
        anomalies.push({
          type: 'NET_EXCEEDS_GROSS',
          severity: 'critical',
          settlement_id: sid,
          restaurant: name,
          gross_rs: s.gross_revenue_rs,
          net_rs: s.net_payout_rs,
          description: `Settlement for ${name}: net ₹${s.net_payout_rs} exceeds gross ₹${s.gross_revenue_rs}`,
        });
      }
    }

    // G: Orphan settled orders — orders with settlement_id that doesn't exist
    const allSettlementIds = settlements.map(s => String(s._id));
    const orphanOrders = await col('orders').find({
      settlement_id: { $ne: null, $nin: allSettlementIds },
      created_at: { $gte: since },
      ...restaurantFilter,
    }, { projection: { _id: 1, order_number: 1, settlement_id: 1, total_rs: 1 }}).limit(50).toArray();

    for (const o of orphanOrders) {
      // Verify the settlement truly doesn't exist
      const exists = await col('settlements').findOne({ _id: o.settlement_id }, { projection: { _id: 1 } });
      if (!exists) {
        anomalies.push({
          type: 'ORPHAN_SETTLED_ORDER',
          severity: 'warning',
          order_id: String(o._id),
          order_number: o.order_number,
          settlement_id: o.settlement_id,
          total_rs: o.total_rs,
          description: `Order ${o.order_number} references settlement ${o.settlement_id} which does not exist`,
        });
      }
    }

    anomalies.sort((a, b) => (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1));

    const summary = {
      period_days: days,
      total_settlements: settlements.length,
      total_payout_rs: settlements.reduce((s, x) => s + (x.net_payout_rs || 0), 0),
      completed: settlements.filter(s => s.payout_status === 'completed').length,
      pending: settlements.filter(s => s.payout_status === 'pending').length,
      processing: settlements.filter(s => s.payout_status === 'processing').length,
      failed: settlements.filter(s => s.payout_status === 'failed').length,
      anomaly_count: anomalies.length,
      critical: anomalies.filter(a => a.severity === 'critical').length,
      warnings: anomalies.filter(a => a.severity === 'warning').length,
      by_type: {},
    };
    for (const a of anomalies) {
      summary.by_type[a.type] = (summary.by_type[a.type] || 0) + 1;
    }

    res.json({ summary, anomalies });
  } catch (e) { req.log.error({ err: e }, 'Settlement reconciliation failed'); res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN CAMPAIGNS
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// ADMIN CUSTOMERS — global identity view
// ═══════════════════════════════════════════════════════════════
//
// GET /api/admin/customers/identity?restaurant_id&customer_type&min_orders&sort&limit&skip
// Cross-tenant view into customer_metrics. Phone is masked unless the
// admin's role grants canSeeFullPhones (middleware-set, never request-
// driven). Full-phone access is audit-logged.
//
// Distinct path from the legacy /customers list (line ~572) — that
// endpoint returns a different shape keyed off the customers table.
router.get('/customers/identity', requireAdminAuth('marketing_messages', 'read'), async (req, res) => {
  try {
    const svc = require('../services/customerView.service');
    const canSeeFull = !!req.canSeeFullPhones;
    const data = await svc.listCustomersGlobal({
      restaurantId: req.query.restaurant_id || null,
      customerType: req.query.customer_type || null,
      minOrders:    req.query.min_orders || null,
      sort:         req.query.sort,
      limit:        req.query.limit,
      skip:         req.query.skip,
      canSeeFull,
    });

    if (canSeeFull) {
      logActivity({
        actorType: 'admin',
        actorId: String(req.admin?._id || req.admin?.id || ''),
        actorName: req.admin?.name || req.admin?.email || 'admin',
        action: 'admin.customers.read',
        category: 'pii_access',
        description: `Admin viewed customers list with full phones (${data.items.length} rows)`,
        severity: 'info',
        metadata: {
          endpoint: '/api/admin/customers',
          row_count: data.items.length,
          phones_unmasked: true,
          filters: {
            restaurant_id: req.query.restaurant_id || null,
            customer_type: req.query.customer_type || null,
          },
        },
      });
    }

    res.json(data);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/admin/campaigns/analytics — cross-tenant ROI
router.get('/campaigns/analytics', async (req, res) => {
  try {
    const roi = require('../services/campaignROI.service');
    const rows = await roi.getAnalytics({
      restaurantId: req.query.restaurant_id || req.query.restaurantId || null,
      from: req.query.from,
      to:   req.query.to,
    });
    res.json({ items: rows, total: rows.length });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/admin/campaigns — list all campaigns across restaurants
router.get('/campaigns', async (req, res) => {
  try {
    const filter = {};
    if (req.query.restaurantId) filter.restaurant_id = req.query.restaurantId;
    if (req.query.status) filter.status = req.query.status;

    const campaigns = await col('campaigns').find(filter).sort({ created_at: -1 }).limit(100).toArray();

    // Enrich with restaurant names
    const restIds = [...new Set(campaigns.map(c => c.restaurant_id))];
    const restaurants = await col('restaurants').find({ _id: { $in: restIds } }, { projection: { _id: 1, business_name: 1 } }).toArray();
    const restMap = {};
    for (const r of restaurants) restMap[String(r._id)] = r.business_name;

    const enriched = campaigns.map(c => ({
      ...c, id: String(c._id),
      restaurant_name: restMap[c.restaurant_id] || 'Unknown',
    }));

    res.json(enriched);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// PATCH /api/admin/campaigns/:id — admin can enable/disable campaigns
router.patch('/campaigns/:id', express.json(), async (req, res) => {
  try {
    const { status, is_active } = req.body;
    const $set = { updated_at: new Date() };
    if (status) $set.status = status;
    if (is_active !== undefined) $set.is_active = is_active;

    const updated = await col('campaigns').findOneAndUpdate(
      { _id: req.params.id },
      { $set },
      { returnDocument: 'after' }
    );
    if (!updated) return res.status(404).json({ error: 'Campaign not found' });
    res.json(updated);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ═══════════════════════════════════════════════════════════════
// MANUAL-BLAST MARKETING CAMPAIGNS (separate namespace from /campaigns
// which belongs to the legacy MPM catalog system).
// ═══════════════════════════════════════════════════════════════

// GET /api/admin/marketing-campaigns/overview — platform-wide stats.
router.get('/marketing-campaigns/overview', async (req, res) => {
  try {
    const all = await col('marketing_campaigns').find(
      {},
      { projection: { restaurant_id: 1, status: 1, stats: 1, created_at: 1, sent_at: 1 } },
    ).toArray();

    const by_status = {};
    let platform_revenue_attributed_rs = 0;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const perRestaurant = new Map();

    for (const c of all) {
      by_status[c.status] = (by_status[c.status] || 0) + 1;
      platform_revenue_attributed_rs += Number(c.stats?.revenue_attributed_rs || 0);
      const sentAt = c.sent_at ? new Date(c.sent_at) : null;
      if (sentAt && sentAt >= startOfMonth) {
        const rid = c.restaurant_id;
        perRestaurant.set(rid, (perRestaurant.get(rid) || 0) + 1);
      }
    }

    const topEntries = [...perRestaurant.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    const topIds = topEntries.map(([rid]) => rid);
    const restaurants = topIds.length
      ? await col('restaurants').find(
          { _id: { $in: topIds } },
          { projection: { _id: 1, business_name: 1 } },
        ).toArray()
      : [];
    const nameMap = {};
    for (const r of restaurants) nameMap[String(r._id)] = r.business_name;

    const top_restaurants_this_month = topEntries.map(([rid, count]) => ({
      restaurant_id: rid,
      restaurant_name: nameMap[rid] || 'Unknown',
      campaigns_sent: count,
    }));

    res.json({
      total_campaigns: all.length,
      by_status,
      top_restaurants_this_month,
      platform_revenue_attributed_rs: Number(platform_revenue_attributed_rs.toFixed(2)),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN PLATFORM COUPONS
// ═══════════════════════════════════════════════════════════════

// GET /api/admin/coupons — list platform-wide coupons
router.get('/coupons', async (req, res) => {
  try {
    const filter = req.query.restaurantId
      ? { restaurant_id: req.query.restaurantId }
      : {};
    const coupons = await col('coupons').find(filter).sort({ created_at: -1 }).limit(200).toArray();
    res.json(coupons.map(c => ({ ...c, id: String(c._id) })));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/admin/coupons — create platform-wide coupon (restaurant_id = null)
router.post('/coupons', express.json(), async (req, res) => {
  try {
    const { code, description, discountType, discountValue, minOrderRs, maxDiscountRs,
            usageLimit, perUserLimit, validFrom, validUntil, firstOrderOnly,
            restaurantId, branchIds, campaignId } = req.body;
    if (!code || !discountType) return res.status(400).json({ error: 'code and discountType required' });

    const couponCode = code.trim().toUpperCase();
    const scope = restaurantId || null; // null = platform-wide

    const existing = await col('coupons').findOne({ restaurant_id: scope, code: couponCode });
    if (existing) return res.status(409).json({ error: 'Coupon code already exists' });

    const now = new Date();
    const coupon = {
      _id: newId(),
      restaurant_id: scope,
      code: couponCode,
      description: description || null,
      discount_type: discountType,
      discount_value: parseFloat(discountValue) || 0,
      min_order_rs: minOrderRs || 0,
      max_discount_rs: maxDiscountRs || null,
      usage_limit: usageLimit || null,
      per_user_limit: perUserLimit || null,
      usage_count: 0,
      valid_from: validFrom ? new Date(validFrom) : null,
      valid_until: validUntil ? new Date(validUntil) : null,
      first_order_only: !!firstOrderOnly,
      branch_ids: branchIds?.length ? branchIds : null,
      campaign_id: campaignId || null,
      is_active: true,
      created_at: now,
      updated_at: now,
    };
    await col('coupons').insertOne(coupon);
    res.json({ ...coupon, id: String(coupon._id) });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN ANALYTICS (stub endpoints to prevent 404s)
// ═══════════════════════════════════════════════════════════════

// Overview — aggregated platform stats
router.get('/analytics/overview', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const since = new Date(Date.now() - days * 86400000);

    const [orders, restaurants, customers] = await Promise.all([
      col('orders').aggregate([
        { $match: { created_at: { $gte: since }, status: { $in: CONFIRMED_ORDER_STATES } } },
        { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: '$total_rs' }, avgOrder: { $avg: '$total_rs' } } },
      ]).toArray(),
      col('restaurants').countDocuments({ status: 'active' }),
      col('customers').countDocuments({ created_at: { $gte: since } }),
    ]);

    const agg = orders[0] || { count: 0, revenue: 0, avgOrder: 0 };
    res.json({
      period_days: days,
      total_orders: agg.count,
      total_revenue_rs: Math.round(agg.revenue || 0),
      avg_order_value_rs: Math.round(agg.avgOrder || 0),
      active_restaurants: restaurants,
      new_customers: customers,
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// Orders timeseries — confirmed orders only
router.get('/analytics/orders/timeseries', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const since = new Date(Date.now() - days * 86400000);
    const result = await col('orders').aggregate([
      { $match: { created_at: { $gte: since }, status: { $in: CONFIRMED_ORDER_STATES } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$created_at' } }, orders: { $sum: 1 }, revenue: { $sum: '$total_rs' } } },
      { $sort: { _id: 1 } },
    ]).toArray();
    res.json(result.map(r => ({ date: r._id, orders: r.orders, revenue_rs: Math.round(r.revenue) })));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// Orders by status — intentionally shows ALL statuses for the breakdown chart
router.get('/analytics/orders/by-status', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const since = new Date(Date.now() - days * 86400000);
    const result = await col('orders').aggregate([
      { $match: { created_at: { $gte: since } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray();
    res.json(result.map(r => ({ status: r._id, count: r.count })));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// Orders by hour — confirmed orders only
router.get('/analytics/orders/by-hour', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const since = new Date(Date.now() - days * 86400000);
    const result = await col('orders').aggregate([
      { $match: { created_at: { $gte: since }, status: { $in: CONFIRMED_ORDER_STATES } } },
      { $group: { _id: { $hour: '$created_at' }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray();
    res.json(result.map(r => ({ hour: r._id, count: r.count })));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// Orders by day — confirmed orders only
router.get('/analytics/orders/by-day', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const since = new Date(Date.now() - days * 86400000);
    const result = await col('orders').aggregate([
      { $match: { created_at: { $gte: since }, status: { $in: CONFIRMED_ORDER_STATES } } },
      { $group: { _id: { $dayOfWeek: '$created_at' }, count: { $sum: 1 }, revenue: { $sum: '$total_rs' } } },
      { $sort: { _id: 1 } },
    ]).toArray();
    const dayNames = ['', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    res.json(result.map(r => ({ day: dayNames[r._id] || r._id, count: r.count, revenue_rs: Math.round(r.revenue) })));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// Customer segments
router.get('/analytics/customers/segments', async (req, res) => {
  try {
    const now = new Date();
    const d30 = new Date(now - 30 * 86400000);
    const d90 = new Date(now - 90 * 86400000);

    const [total, active30, active90, newLast30] = await Promise.all([
      col('customers').countDocuments({}),
      col('customers').countDocuments({ last_order_at: { $gte: d30 } }),
      col('customers').countDocuments({ last_order_at: { $gte: d90 } }),
      col('customers').countDocuments({ created_at: { $gte: d30 } }),
    ]);

    res.json({
      total,
      active_30d: active30,
      active_90d: active90,
      new_last_30d: newLast30,
      inactive: total - active90,
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// Customer overview
router.get('/analytics/customers/overview', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const since = new Date(Date.now() - days * 86400000);
    const [newCust, returning] = await Promise.all([
      col('customers').countDocuments({ created_at: { $gte: since } }),
      col('orders').aggregate([
        { $match: { created_at: { $gte: since }, status: { $in: CONFIRMED_ORDER_STATES } } },
        { $group: { _id: '$customer_id', orders: { $sum: 1 } } },
        { $match: { orders: { $gte: 2 } } },
        { $count: 'count' },
      ]).toArray(),
    ]);
    res.json({ new_customers: newCust, returning_customers: returning[0]?.count || 0, period_days: days });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// Restaurant ranking
router.get('/analytics/restaurants/ranking', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const since = new Date(Date.now() - days * 86400000);
    const result = await col('orders').aggregate([
      { $match: { created_at: { $gte: since }, status: { $in: CONFIRMED_ORDER_STATES } } },
      { $group: { _id: '$restaurant_id', orders: { $sum: 1 }, revenue: { $sum: '$total_rs' } } },
      { $sort: { revenue: -1 } },
      { $limit: 20 },
    ]).toArray();

    const restIds = result.map(r => r._id);
    const restaurants = await col('restaurants').find({ _id: { $in: restIds } }, { projection: { _id: 1, business_name: 1 } }).toArray();
    const nameMap = {};
    for (const r of restaurants) nameMap[String(r._id)] = r.business_name;

    res.json(result.map(r => ({
      restaurant_id: r._id,
      name: nameMap[r._id] || 'Unknown',
      orders: r.orders,
      revenue_rs: Math.round(r.revenue),
    })));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// Delivery performance
router.get('/analytics/delivery/performance', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const since = new Date(Date.now() - days * 86400000);
    const result = await col('deliveries').aggregate([
      { $match: { created_at: { $gte: since } } },
      { $group: {
        _id: '$status',
        count: { $sum: 1 },
        avg_cost: { $avg: '$cost_rs' },
      }},
    ]).toArray();
    res.json(result.map(r => ({ status: r._id, count: r.count, avg_cost_rs: Math.round(r.avg_cost || 0) })));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// Geographic analytics (cities)
router.get('/analytics/geographic/cities', async (req, res) => {
  try {
    const result = await col('restaurants').aggregate([
      { $match: { status: 'active', city: { $exists: true, $ne: null } } },
      { $group: { _id: '$city', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray();
    res.json(result.map(r => ({ city: r._id, restaurant_count: r.count })));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// Analytics filter helpers
router.get('/analytics/filters/cities', async (_req, res) => {
  try {
    const cities = await col('restaurants').distinct('city', { status: 'active', city: { $ne: null } });
    res.json(cities.sort());
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.get('/analytics/filters/areas', async (req, res) => {
  try {
    const filter = { status: 'active', area: { $ne: null } };
    if (req.query.city) filter.city = req.query.city;
    const areas = await col('restaurants').distinct('area', filter);
    res.json(areas.sort());
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ═══════════════════════════════════════════════════════════════
// LOGISTICS ANALYTICS
// Reads orders.logistics.* subdocument populated by the Prorouting 3PL
// integration. Until that integration is live, logistics fields will be
// absent from all orders — averages return null, sums return null.
// ═══════════════════════════════════════════════════════════════

const IST_TZ = 'Asia/Kolkata';
const IST_OFFSET = '+05:30';

function _parseISTBoundary(dateStr, end) {
  if (!dateStr) return null;
  // Full datetime passed in (length > 10 means includes time portion) — trust it
  if (String(dateStr).length > 10) return new Date(dateStr);
  const time = end ? 'T23:59:59.999' : 'T00:00:00.000';
  return new Date(dateStr + time + IST_OFFSET);
}

function _todayISTBoundary(end) {
  // en-CA locale formats as YYYY-MM-DD
  const dateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return _parseISTBoundary(dateStr, end);
}

const _r1 = (v) => v == null ? null : Math.round(v * 10) / 10;
const _r2 = (v) => v == null ? null : Math.round(v * 100) / 100;

router.get('/logistics/analytics', async (req, res) => {
  try {
    const { restaurantId, branchId, lsp } = req.query;
    const from = _parseISTBoundary(req.query.from, false) || _todayISTBoundary(false);
    const to   = _parseISTBoundary(req.query.to,   true)  || _todayISTBoundary(true);

    const baseMatch = { created_at: { $gte: from, $lte: to } };
    if (restaurantId) baseMatch.restaurant_id = restaurantId;
    if (branchId)     baseMatch.branch_id = branchId;
    if (lsp)          baseMatch['logistics.lspName'] = lsp;

    // Presence helper — counts docs where field is not null AND not missing.
    // Using ($type != 'missing') alone is unreliable across driver versions,
    // so compare $ifNull(field, null) !== null.
    const hasField = (path) => ({
      $sum: { $cond: [{ $ne: [{ $ifNull: [`$${path}`, null] }, null] }, 1, 0] },
    });
    const sumField = (path) => ({ $sum: { $ifNull: [`$${path}`, 0] } });

    const [agg] = await col('orders').aggregate([
      { $match: baseMatch },
      { $facet: {
          statuses: [
            { $group: { _id: '$status', count: { $sum: 1 } } },
          ],
          delivered: [
            { $match: { status: 'DELIVERED' } },
            { $group: {
                _id: null,
                avgDistanceKm:           { $avg: '$logistics.distanceKm' },
                avgLspFee:               { $avg: '$logistics.lspFee' },
                avgTotalFee:             { $avg: '$logistics.totalFee' },
                sumTotalFeeWithGst:      sumField('logistics.totalFeeWithGst'),
                cntTotalFeeWithGst:      hasField('logistics.totalFeeWithGst'),
                sumCod:                  sumField('logistics.codCollected'),
                cntCod:                  hasField('logistics.codCollected'),
                avgAgentAssignMinutes:   { $avg: '$logistics.agentAssignMinutes' },
                avgReachPickupMinutes:   { $avg: '$logistics.reachPickupMinutes' },
                avgReachDeliveryMinutes: { $avg: '$logistics.reachDeliveryMinutes' },
                avgDeliveryTotalMinutes: { $avg: '$logistics.deliveryTotalMinutes' },
                avgPickupWaitMinutes:    { $avg: '$logistics.pickupWaitMinutes' },
            }},
          ],
          pendingIssues: [
            { $match: {
                'logistics.hasIssue': true,
                $or: [
                  { 'logistics.issueResolved': { $ne: true } },
                  { 'logistics.issueResolved': { $exists: false } },
                ],
            }},
            { $count: 'count' },
          ],
          liabilityAccepted: [
            { $match: { 'logistics.liabilityAccepted': true } },
            { $count: 'count' },
          ],
          dailyByLsp: [
            { $match: { status: 'DELIVERED', 'logistics.lspName': { $nin: [null, ''] } } },
            { $group: {
                _id: {
                  date: { $dateToString: { format: '%Y-%m-%d', date: '$created_at', timezone: IST_TZ } },
                  lsp: '$logistics.lspName',
                },
                count: { $sum: 1 },
            }},
            { $sort: { '_id.date': 1, '_id.lsp': 1 } },
          ],
          dailyByStatus: [
            { $group: {
                _id: {
                  date: { $dateToString: { format: '%Y-%m-%d', date: '$created_at', timezone: IST_TZ } },
                  status: '$status',
                },
                count: { $sum: 1 },
            }},
            { $sort: { '_id.date': 1 } },
          ],
      }},
    ]).toArray();

    // Status map → deliveredOrders
    const statusMap = {};
    for (const s of (agg.statuses || [])) statusMap[s._id] = s.count;
    const deliveredOrders = statusMap['DELIVERED'] || 0;

    // Cancelled breakdown via order_state_log. Cancelled-in-range is defined
    // by the order's created_at (matches the rest of the range filter).
    let cancelledByClient = 0, cancelledBySystem = 0;
    const cancelledTotal = statusMap['CANCELLED'] || 0;
    if (cancelledTotal > 0) {
      const cancelledOrders = await col('orders').find(
        { ...baseMatch, status: 'CANCELLED' },
        { projection: { _id: 1 } },
      ).toArray();
      const ids = cancelledOrders.map(o => o._id);
      if (ids.length) {
        const actorAgg = await col('order_state_log').aggregate([
          { $match: { order_id: { $in: ids }, to_state: 'CANCELLED' } },
          { $sort: { timestamp: -1 } },
          // Keep only the most recent CANCELLED transition per order
          { $group: { _id: '$order_id', actor_type: { $first: '$actor_type' } } },
          { $group: { _id: '$actor_type', count: { $sum: 1 } } },
        ]).toArray();
        for (const r of actorAgg) {
          if (r._id === 'customer') cancelledByClient += r.count;
          else cancelledBySystem += r.count; // system | restaurant | admin | null
        }
        // Orders without an audit log entry fall through as systemic
        const loggedTotal = actorAgg.reduce((s, r) => s + r.count, 0);
        if (loggedTotal < ids.length) cancelledBySystem += (ids.length - loggedTotal);
      }
    }

    const d = (agg.delivered && agg.delivered[0]) || {};

    const summary = {
      deliveredOrders,
      cancelledByClient,
      cancelledBySystem,
      avgDistanceKm:           _r1(d.avgDistanceKm           ?? null),
      avgLspFee:               _r2(d.avgLspFee               ?? null),
      avgTotalFee:             _r2(d.avgTotalFee             ?? null),
      totalFeeWithGst:         d.cntTotalFeeWithGst > 0 ? _r2(d.sumTotalFeeWithGst) : null,
      codCollected:            d.cntCod             > 0 ? _r2(d.sumCod)             : null,
      avgAgentAssignMinutes:   _r1(d.avgAgentAssignMinutes   ?? null),
      avgReachPickupMinutes:   _r1(d.avgReachPickupMinutes   ?? null),
      avgReachDeliveryMinutes: _r1(d.avgReachDeliveryMinutes ?? null),
      avgDeliveryTotalMinutes: _r1(d.avgDeliveryTotalMinutes ?? null),
      avgPickupWaitMinutes:    _r1(d.avgPickupWaitMinutes    ?? null),
      pendingIssues:           (agg.pendingIssues[0]?.count)     || 0,
      liabilityAccepted:       (agg.liabilityAccepted[0]?.count) || 0,
    };

    const dailyByLsp = (agg.dailyByLsp || []).map(r => ({
      date: r._id.date, lsp: r._id.lsp, count: r.count,
    }));
    const dailyByStatus = (agg.dailyByStatus || []).map(r => ({
      date: r._id.date, status: r._id.status, count: r.count,
    }));

    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      filters: {
        restaurantId: restaurantId || null,
        branchId: branchId || null,
        lsp: lsp || null,
      },
      summary,
      dailyByLsp,
      dailyByStatus,
    });
  } catch (e) {
    log.error({ err: e }, 'logistics analytics failed');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN TAX REPORTS
// ═══════════════════════════════════════════════════════════════

// TDS Report — CSV download
router.get('/financials/tax/tds-report', async (req, res) => {
  try {
    const period = req.query.period || 'current-fy';
    const now = new Date();
    const fyStart = now.getMonth() >= 3
      ? new Date(now.getFullYear(), 3, 1)
      : new Date(now.getFullYear() - 1, 3, 1);

    const settlements = await col('settlements').find({
      tds_applicable: true,
      period_end: { $gte: fyStart },
    }).sort({ period_start: 1 }).toArray();

    // Enrich with restaurant names
    const restIds = [...new Set(settlements.map(s => s.restaurant_id))];
    const restaurants = await col('restaurants').find({ _id: { $in: restIds } }, { projection: { _id: 1, business_name: 1, pan: 1, gstin: 1 } }).toArray();
    const restMap = {};
    for (const r of restaurants) restMap[String(r._id)] = r;

    const header = 'Restaurant,PAN,GSTIN,Period Start,Period End,Gross Payout,TDS Rate %,TDS Amount,Net Payout,Settlement ID';
    const rows = settlements.map(s => {
      const r = restMap[s.restaurant_id] || {};
      return [
        `"${r.business_name || 'Unknown'}"`,
        r.pan || '',
        r.gstin || '',
        s.period_start?.toISOString().slice(0, 10) || '',
        s.period_end?.toISOString().slice(0, 10) || '',
        (s.net_payout_rs + (s.tds_amount_rs || 0)).toFixed(2),
        s.tds_rate_pct || 0,
        (s.tds_amount_rs || 0).toFixed(2),
        s.net_payout_rs.toFixed(2),
        String(s._id),
      ].join(',');
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="tds_report_${period}.csv"`);
    res.send([header, ...rows].join('\n'));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GSTR-1 Export — CSV download
router.get('/financials/tax/gstr1', async (req, res) => {
  try {
    const period = req.query.period || 'current-fy';
    const now = new Date();
    const fyStart = now.getMonth() >= 3
      ? new Date(now.getFullYear(), 3, 1)
      : new Date(now.getFullYear() - 1, 3, 1);

    const settlements = await col('settlements').find({
      period_end: { $gte: fyStart },
    }).sort({ period_start: 1 }).toArray();

    const restIds = [...new Set(settlements.map(s => s.restaurant_id))];
    const restaurants = await col('restaurants').find({ _id: { $in: restIds } }, { projection: { _id: 1, business_name: 1, gstin: 1 } }).toArray();
    const restMap = {};
    for (const r of restaurants) restMap[String(r._id)] = r;

    const header = 'Restaurant,GSTIN,Period,Food Revenue,Food GST (5%),Platform Fee,Platform Fee GST (18%),Packaging,Packaging GST (18%),Delivery Fee,Delivery GST (18%),Referral Fee,Referral GST (18%),Total GST Collected';
    const rows = settlements.map(s => {
      const r = restMap[s.restaurant_id] || {};
      const totalGst = (s.food_gst_collected_rs || 0) + (s.platform_fee_gst_rs || 0) + (s.packaging_gst_rs || 0) + (s.delivery_fee_restaurant_gst_rs || 0) + (s.referral_fee_gst_rs || 0);
      return [
        `"${r.business_name || 'Unknown'}"`,
        r.gstin || '',
        `${s.period_start?.toISOString().slice(0, 10) || ''} to ${s.period_end?.toISOString().slice(0, 10) || ''}`,
        (s.food_revenue_rs || 0).toFixed(2),
        (s.food_gst_collected_rs || 0).toFixed(2),
        (s.platform_fee_rs || 0).toFixed(2),
        (s.platform_fee_gst_rs || 0).toFixed(2),
        (s.packaging_collected_rs || 0).toFixed(2),
        (s.packaging_gst_rs || 0).toFixed(2),
        (s.delivery_fee_collected_rs || 0).toFixed(2),
        (s.delivery_fee_restaurant_gst_rs || 0).toFixed(2),
        (s.referral_fee_rs || 0).toFixed(2),
        (s.referral_fee_gst_rs || 0).toFixed(2),
        totalGst.toFixed(2),
      ].join(',');
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="gstr1_${period}.csv"`);
    res.send([header, ...rows].join('\n'));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ═══════════════════════════════════════════════════════════════
// PER-ORDER SETTLEMENTS V2 — Admin endpoints
// ═══════════════════════════════════════════════════════════════

// GET /api/admin/order-settlements — list all v2 settlements
router.get('/order-settlements', async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.restaurantId) filter.restaurant_id = req.query.restaurantId;
    if (req.query.orderId) filter.order_id = req.query.orderId;

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const skip = parseInt(req.query.skip) || 0;

    const [settlements, total] = await Promise.all([
      col('order_settlements').find(filter).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
      col('order_settlements').countDocuments(filter),
    ]);

    // Enrich with restaurant names
    const restIds = [...new Set(settlements.map(s => s.restaurant_id))];
    const restaurants = await col('restaurants').find({ _id: { $in: restIds } }, { projection: { _id: 1, business_name: 1 } }).toArray();
    const restMap = {};
    for (const r of restaurants) restMap[String(r._id)] = r.business_name;

    res.json({
      total,
      settlements: settlements.map(s => ({
        ...s,
        id: String(s._id),
        restaurant_name: restMap[s.restaurant_id] || 'Unknown',
      })),
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/admin/order-settlements/:id — single settlement detail with payout
router.get('/order-settlements/:id', async (req, res) => {
  try {
    const settlement = await col('order_settlements').findOne({ _id: req.params.id });
    if (!settlement) return res.status(404).json({ error: 'Settlement not found' });

    const payout = settlement.payout_id ? await col('payouts').findOne({ _id: settlement.payout_id }) : null;
    const order = await col('orders').findOne({ _id: settlement.order_id }, { projection: { order_number: 1, total_rs: 1, status: 1, delivered_at: 1 } });
    const restaurant = await col('restaurants').findOne({ _id: settlement.restaurant_id }, { projection: { business_name: 1, razorpay_fund_acct_id: 1 } });

    res.json({ settlement, payout, order, restaurant });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/admin/order-settlements/:id/retry — retry a failed payout
router.post('/order-settlements/:id/retry', express.json(), async (req, res) => {
  try {
    const payoutEngine = require('../services/payoutEngine');
    const result = await payoutEngine.retryFailedSettlement(req.params.id);
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/admin/order-settlements/retry-all — retry all failed payouts
router.post('/order-settlements/retry-all', express.json(), async (req, res) => {
  try {
    const payoutEngine = require('../services/payoutEngine');
    const result = await payoutEngine.retryAllFailedSettlements();
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/admin/order-settlements/:id/process — manually trigger payout for an eligible settlement
router.post('/order-settlements/:id/process', express.json(), async (req, res) => {
  try {
    const payoutEngine = require('../services/payoutEngine');
    const result = await payoutEngine.processSettlement(req.params.id);
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/admin/payouts — list all v2 payouts
router.get('/payouts', async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.restaurantId) filter.restaurant_id = req.query.restaurantId;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const payouts = await col('payouts').find(filter).sort({ created_at: -1 }).limit(limit).toArray();
    res.json(payouts);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/admin/jobs/rebuild-customer-profiles — manual trigger for the
// nightly RFM rebuild. Fires and forgets; response returns 202 immediately
// so the admin console doesn't block on the full sweep.
router.post('/jobs/rebuild-customer-profiles', requireAdminAuth('restaurants', 'manage'), async (req, res) => {
  const job = require('../jobs/rebuildCustomerProfiles');
  job.run().catch(() => { /* logged inside the job */ });
  res.status(202).json({ ok: true, job: job.JOB_NAME, scheduled_at: new Date() });
});

// GET /api/admin/jobs/logs — recent scheduled-job runs. Optional
// ?job_name= filter; defaults to newest first, capped at 100.
router.get('/jobs/logs', requireAdminAuth('restaurants', 'read'), async (req, res) => {
  try {
    const filter = {};
    if (req.query.job_name) filter.job_name = String(req.query.job_name);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const rows = await col('job_logs')
      .find(filter).sort({ started_at: -1 }).limit(limit).toArray();
    res.json(rows);
  } catch (e) { res.status(500).json({ success: false, message: 'Internal server error' }); }
});

// GET /api/admin/restaurants/marketing-wa-status — full health
// overview for the marketing WhatsApp number each restaurant has
// configured. Sorted by status then business name so flagged/errored
// tenants float to the top of ops triage.
router.get('/restaurants/marketing-wa-status', requireAdminAuth('restaurants', 'read'), async (req, res) => {
  try {
    const rows = await col('restaurants').find({}, {
      projection: {
        _id: 1,
        business_name: 1,
        brand_name: 1,
        marketing_wa_status: 1,
        marketing_wa_quality_rating: 1,
        marketing_wa_last_checked_at: 1,
        marketing_wa_error_message: 1,
      },
    }).toArray();

    const items = rows.map((r) => ({
      restaurant_id: String(r._id),
      name: r.business_name || r.brand_name || '—',
      marketing_wa_status: r.marketing_wa_status || 'not_configured',
      marketing_wa_quality_rating: r.marketing_wa_quality_rating || null,
      marketing_wa_last_checked_at: r.marketing_wa_last_checked_at || null,
      marketing_wa_error_message: r.marketing_wa_error_message || null,
    }));

    items.sort((a, b) => {
      const s = String(a.marketing_wa_status).localeCompare(String(b.marketing_wa_status));
      if (s !== 0) return s;
      return String(a.name).localeCompare(String(b.name));
    });
    res.json(items);
  } catch (e) { res.status(500).json({ success: false, message: 'Internal server error' }); }
});

// POST /api/admin/restaurants/:restaurantId/verify-marketing-wa —
// immediate manual verification trigger. Awaits the result so the
// admin UI can display the outcome inline.
router.post('/restaurants/:restaurantId/verify-marketing-wa', requireAdminAuth('restaurants', 'manage'), async (req, res) => {
  try {
    const { verifyMarketingWaNumber } = require('../services/marketingWaVerification');
    const result = await verifyMarketingWaNumber(req.params.restaurantId);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ success: false, message: 'Internal server error' }); }
});

// GET /api/admin/customers/overview — platform-wide RFM rollup.
// Returns total profiled customers + counts per segment + top 10
// tenants by customer count. Powers the admin dashboard snapshot.
router.get('/customers/overview', requireAdminAuth('restaurants', 'read'), async (req, res) => {
  try {
    const [total, perSegment, topTenants] = await Promise.all([
      col('customer_rfm_profiles').countDocuments({}),
      col('customer_rfm_profiles').aggregate([
        { $group: { _id: '$rfm_label', count: { $sum: 1 } } },
      ]).toArray(),
      col('customer_rfm_profiles').aggregate([
        { $group: { _id: '$restaurant_id', customers: { $sum: 1 } } },
        { $sort: { customers: -1 } },
        { $limit: 10 },
      ]).toArray(),
    ]);
    res.json({
      total_profiles: total,
      per_segment: perSegment.reduce((acc, r) => {
        acc[r._id] = r.count;
        return acc;
      }, {}),
      top_tenants: topTenants.map((r) => ({
        restaurant_id: r._id,
        customers: r.customers,
      })),
    });
  } catch (e) { res.status(500).json({ success: false, message: 'Internal server error' }); }
});

module.exports = router;
