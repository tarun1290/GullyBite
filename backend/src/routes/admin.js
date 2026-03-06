// src/routes/admin.js
// Admin-only REST API for the GullyBite management dashboard.
// All routes (except /auth) require: Authorization: Bearer <ADMIN_KEY>

const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
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
// Verify admin key — frontend calls this on login.
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
// Platform-wide summary numbers for the dashboard header.
router.get('/stats', async (req, res) => {
  try {
    const [restaurants, orders, revenue, customers, logs] = await Promise.all([
      db.query(`SELECT COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE status='active') AS active
                FROM restaurants`),
      db.query(`SELECT COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE status='DELIVERED') AS delivered,
                  COUNT(*) FILTER (WHERE status='PENDING')   AS pending,
                  COUNT(*) FILTER (WHERE status='CANCELLED') AS cancelled,
                  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS today
                FROM orders`),
      db.query(`SELECT COALESCE(SUM(total_rs),0) AS total_rs,
                  COALESCE(SUM(total_rs) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours'),0) AS today_rs,
                  COALESCE(SUM(total_rs) FILTER (WHERE created_at > NOW() - INTERVAL '7 days'),0) AS week_rs
                FROM orders WHERE status != 'CANCELLED'`),
      db.query(`SELECT COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS today
                FROM customers`),
      db.query(`SELECT COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE NOT processed) AS unprocessed,
                  COUNT(*) FILTER (WHERE error_message IS NOT NULL) AS errors
                FROM webhook_logs`),
    ]);

    res.json({
      restaurants: restaurants.rows[0],
      orders     : orders.rows[0],
      revenue    : revenue.rows[0],
      customers  : customers.rows[0],
      logs       : logs.rows[0],
    });
  } catch (err) {
    console.error('[Admin] stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/restaurants ──────────────────────────────
// All restaurants with order counts and revenue.
router.get('/restaurants', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        r.id, r.business_name, r.owner_name, r.email, r.phone,
        r.status, r.onboarding_step, r.created_at,
        COUNT(DISTINCT b.id)   AS branch_count,
        COUNT(DISTINCT o.id)   AS order_count,
        COALESCE(SUM(o.total_rs) FILTER (WHERE o.status != 'CANCELLED'), 0) AS revenue_rs
      FROM restaurants r
      LEFT JOIN branches b ON b.restaurant_id = r.id
      LEFT JOIN orders   o ON o.restaurant_id = r.id
      GROUP BY r.id
      ORDER BY r.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/branches ──────────────────────────────────
router.get('/branches', async (req, res) => {
  try {
    const { restaurant_id } = req.query;
    const params = [];
    const where  = restaurant_id ? `WHERE b.restaurant_id = $${params.push(restaurant_id)}` : '';
    const { rows } = await db.query(`
      SELECT
        b.id, b.name, b.address, b.city,
        b.latitude, b.longitude, b.delivery_radius_km, b.delivery_fee_rs,
        b.is_open, b.accepts_orders,
        b.catalog_id, b.catalog_synced_at, b.created_at,
        r.business_name,
        COUNT(DISTINCT mi.id) AS menu_item_count,
        COUNT(DISTINCT o.id)  AS order_count
      FROM branches b
      JOIN restaurants r ON r.id = b.restaurant_id
      LEFT JOIN menu_items mi ON mi.branch_id = b.id
      LEFT JOIN orders     o  ON o.branch_id  = b.id
      ${where}
      GROUP BY b.id, r.business_name
      ORDER BY b.created_at DESC
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/orders ────────────────────────────────────
// All orders across all restaurants. Supports filtering + pagination.
router.get('/orders', async (req, res) => {
  try {
    const {
      status, restaurant_id, branch_id,
      limit = 50, offset = 0,
      date_from, date_to,
    } = req.query;

    const conditions = [];
    const params     = [];

    if (status)        conditions.push(`o.status = $${params.push(status)}`);
    if (restaurant_id) conditions.push(`o.restaurant_id = $${params.push(restaurant_id)}`);
    if (branch_id)     conditions.push(`o.branch_id = $${params.push(branch_id)}`);
    if (date_from)     conditions.push(`o.created_at >= $${params.push(date_from)}`);
    if (date_to)       conditions.push(`o.created_at <= $${params.push(date_to)}`);

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [data, total] = await Promise.all([
      db.query(`
        SELECT
          o.id, o.order_number, o.status,
          o.subtotal_rs, o.delivery_fee_rs, o.total_rs,
          o.created_at, o.updated_at,
          r.business_name,
          b.name AS branch_name,
          c.wa_phone, c.name AS customer_name
        FROM orders o
        JOIN restaurants r ON r.id = o.restaurant_id
        JOIN branches    b ON b.id = o.branch_id
        JOIN customers   c ON c.id = o.customer_id
        ${where}
        ORDER BY o.created_at DESC
        LIMIT $${params.push(parseInt(limit))} OFFSET $${params.push(parseInt(offset))}
      `, params),
      db.query(`SELECT COUNT(*) AS total FROM orders o ${where}`, params.slice(0, conditions.length)),
    ]);

    res.json({ orders: data.rows, total: parseInt(total.rows[0].total) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/logs ─────────────────────────────────────
// Webhook logs with filtering and pagination.
router.get('/logs', async (req, res) => {
  try {
    const {
      source, event_type, processed,
      date_from, date_to,
      limit = 50, offset = 0,
      has_error,
    } = req.query;

    const conditions = [];
    const params     = [];

    if (source)     conditions.push(`source = $${params.push(source)}`);
    if (event_type) conditions.push(`event_type ILIKE $${params.push('%' + event_type + '%')}`);
    if (processed !== undefined && processed !== '') {
      conditions.push(`processed = $${params.push(processed === 'true')}`);
    }
    if (has_error === 'true')  conditions.push(`error_message IS NOT NULL`);
    if (has_error === 'false') conditions.push(`error_message IS NULL`);
    if (date_from)  conditions.push(`received_at >= $${params.push(date_from)}`);
    if (date_to)    conditions.push(`received_at <= $${params.push(date_to)}`);

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [data, total] = await Promise.all([
      db.query(`
        SELECT id, source, event_type, phone_number_id,
               processed, error_message, received_at, processed_at,
               payload
        FROM webhook_logs
        ${where}
        ORDER BY received_at DESC
        LIMIT $${params.push(parseInt(limit))} OFFSET $${params.push(parseInt(offset))}
      `, params),
      db.query(`SELECT COUNT(*) AS total FROM webhook_logs ${where}`, params.slice(0, conditions.length)),
    ]);

    res.json({ logs: data.rows, total: parseInt(total.rows[0].total) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/logs/:id ──────────────────────────────────
// Full payload for a single log entry.
router.get('/logs/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM webhook_logs WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/customers ─────────────────────────────────
router.get('/customers', async (req, res) => {
  try {
    const { limit = 50, offset = 0, search } = req.query;
    const params = [];
    const where  = search
      ? `WHERE c.wa_phone ILIKE $${params.push('%' + search + '%')} OR c.name ILIKE $${params.push('%' + search + '%')}`
      : '';

    const { rows } = await db.query(`
      SELECT
        c.id, c.wa_phone, c.name, c.created_at,
        COUNT(DISTINCT o.id) AS order_count,
        COALESCE(SUM(o.total_rs) FILTER (WHERE o.status != 'CANCELLED'), 0) AS lifetime_rs
      FROM customers c
      LEFT JOIN orders o ON o.customer_id = c.id
      ${where}
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT $${params.push(parseInt(limit))} OFFSET $${params.push(parseInt(offset))}
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/admin/restaurants/:id ────────────────────────
// Suspend / reactivate a restaurant.
router.patch('/restaurants/:id', express.json(), async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active', 'suspended', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const { rows } = await db.query(
      'UPDATE restaurants SET status=$1 WHERE id=$2 RETURNING id, business_name, status',
      [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/admin/run-settlement ──────────────────────────
router.post('/run-settlement', async (req, res) => {
  res.json({ message: 'Settlement started' });
  runSettlement().catch(console.error);
});

module.exports = router;
