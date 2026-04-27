'use strict';

// Staff POS router — per-user PIN auth, SSE live-order stream, order
// status updates, and menu availability toggles. Mounted at /api/staff
// in backend/ec2-server.js. All routes except POST /auth require a
// staff JWT (per-user, hydrated by middleware/staffAuth.requireStaffAuth).
//
// Auth model: each staff member has their own row in restaurant_users
// with role='staff', phone, bcrypt'd PIN, branch_ids, and permissions.
// The legacy single shared restaurants.staff_pin is deprecated and no
// longer consulted by /auth (Option A migration).

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');

const { col } = require('../config/database');
const { requireStaffAuth, signStaffToken } = require('../middleware/staffAuth');
const { rateLimitFn } = require('../middleware/rateLimit');
const sse = require('../services/sseConnections');
const expoPush = require('../services/expoPush');
const { maskPhone } = require('../utils/maskPhone');
const orderSvc = require('../services/order');
const log = require('../utils/logger').child({ component: 'staff' });

const PUSH_TOKEN_CAP = 10;

// Staff PIN auth: 5 attempts / 15 min / IP. Generic 401 on failure —
// do not reveal whether the slug exists.
const staffAuthLimiter = rateLimitFn(
  (r) => `staff_auth:${r.ip || r.headers['x-forwarded-for'] || 'unknown'}`,
  5,
  15 * 60,
  { message: 'Too many attempts. Please try again later.' }
);

// POST /api/staff/auth — { staff_access_token, name, pin } → { token, restaurant, staffUser }
//
// Per-user, per-branch auth. The staff_access_token is a UUID stored
// on a branch document (see /restaurant/branches/:id/staff-link/generate).
// Resolving the token gives us restaurantId + branchId; we then find
// staff users in restaurant_users whose name matches (case-insensitive)
// AND whose branch_ids either contains this branch or is empty (= all
// branches). PIN is bcrypt-compared against the matching candidates.
//
// Generic 401 on any failure — never reveal whether the token, name,
// or PIN was wrong.
router.post('/auth', staffAuthLimiter, express.json(), async (req, res) => {
  try {
    const { staff_access_token, name, pin } = req.body || {};
    if (!staff_access_token || !name || !pin || !/^\d{4}$/.test(String(pin))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Resolve branch from the token. Single doc lookup — staff_access_token
    // should be unique across branches (UUID v4 collision space) so we
    // don't bother indexing on it for now; if branches grow large enough
    // to matter, a sparse unique index keeps this O(log n).
    const branch = await col('branches').findOne(
      { staff_access_token: String(staff_access_token) },
      { projection: {
          _id: 1, restaurant_id: 1, name: 1,
      } },
    );
    if (!branch) return res.status(401).json({ error: 'Invalid credentials' });

    const r = await col('restaurants').findOne(
      { _id: branch.restaurant_id },
      { projection: {
          _id: 1, store_slug: 1, business_name: 1, brand_name: 1, logo_url: 1,
      } },
    );
    if (!r) return res.status(401).json({ error: 'Invalid credentials' });

    // Escape user input before regex compile so '.', '$', etc. in the
    // submitted name can't broaden the match. Anchor + case-insensitive.
    const safeName = String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nameRegex = new RegExp(`^${safeName}$`, 'i');

    // Candidates: name match within this restaurant, role:'staff',
    // active, and either scoped to this branch (branch_ids contains
    // branchId) or unscoped (branch_ids is empty / missing — which
    // means all branches).
    const candidates = await col('restaurant_users').find({
      restaurant_id: branch.restaurant_id,
      role: 'staff',
      is_active: true,
      name: { $regex: nameRegex },
      $or: [
        { branch_ids: branch._id },
        { branch_ids: { $size: 0 } },
        { branch_ids: { $exists: false } },
      ],
    }).toArray();

    if (!candidates.length) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // PIN match against each candidate. Stop at first match — there
    // shouldn't be name collisions within a branch in practice, but
    // even if there are, PIN uniqueness disambiguates.
    let matched = null;
    for (const c of candidates) {
      if (!c.pin_hash) continue;
      // eslint-disable-next-line no-await-in-loop
      const ok = await bcrypt.compare(String(pin), c.pin_hash);
      if (ok) { matched = c; break; }
    }
    if (!matched) return res.status(401).json({ error: 'Invalid credentials' });

    const now = new Date();
    await col('restaurant_users').updateOne(
      { _id: matched._id },
      { $set: { last_login_at: now } },
    );

    // JWT now carries branchId (singular) — the token-resolved branch
    // is the staff session's working branch even if the user is
    // actually authorised for multiple. Branch-filtered SSE / order /
    // menu queries downstream all read this single value.
    const token = signStaffToken({
      userId: matched._id,
      restaurantId: String(r._id),
      restaurantSlug: r.store_slug || null,
      branchId: String(branch._id),
      permissions: matched.permissions || {},
      tokenVersion: Number(matched.token_version || 0),
    });

    return res.json({
      success: true,
      token,
      restaurant: {
        id: String(r._id),
        name: r.brand_name || r.business_name,
        slug: r.store_slug || null,
        logo_url: r.logo_url || null,
      },
      staffUser: {
        id: String(matched._id),
        name: matched.name,
        branchId: String(branch._id),
        permissions: matched.permissions || {},
      },
    });
  } catch (e) {
    log.error({ err: e }, 'staff auth failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/staff/stream — SSE. EventSource can't set Authorization, so
// the middleware also accepts ?token=<jwt>.
router.get('/stream', requireStaffAuth(), (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  sse.addConnection(req.staff.restaurantId, res, req.staff.branchIds);
  res.write(`event: connected\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  // Never end the response here — addConnection wires close/error cleanup.
});

// POST /api/staff/push-token — register / update an Expo push token for
// this device. Dedupe by device_id; cap total tokens per restaurant at
// PUSH_TOKEN_CAP (oldest evicted).
router.post('/push-token', requireStaffAuth(), express.json(), async (req, res) => {
  try {
    const { token, device_id } = req.body || {};
    if (!expoPush.isValidExpoToken(token)) {
      return res.status(400).json({ error: 'Invalid Expo push token' });
    }
    if (!device_id || typeof device_id !== 'string') {
      return res.status(400).json({ error: 'device_id required' });
    }

    const restaurant = await col('restaurants').findOne(
      { _id: req.staff.restaurantId },
      { projection: { push_tokens: 1 } }
    );
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    const now = new Date();
    const existing = Array.isArray(restaurant.push_tokens) ? restaurant.push_tokens : [];
    const idx = existing.findIndex(e => e && e.device_id === device_id);
    let next;
    if (idx >= 0) {
      next = existing.slice();
      next[idx] = { token, device_id, registered_at: now };
    } else {
      next = existing.concat({ token, device_id, registered_at: now });
      if (next.length > PUSH_TOKEN_CAP) {
        next.sort((a, b) => new Date(a.registered_at || 0) - new Date(b.registered_at || 0));
        next = next.slice(next.length - PUSH_TOKEN_CAP);
      }
    }

    await col('restaurants').updateOne(
      { _id: req.staff.restaurantId },
      { $set: { push_tokens: next, updated_at: now } }
    );
    return res.json({ success: true, count: next.length });
  } catch (e) {
    log.error({ err: e }, 'push-token register failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/staff/push-token — body: { device_id }
router.delete('/push-token', requireStaffAuth(), express.json(), async (req, res) => {
  try {
    const { device_id } = req.body || {};
    if (!device_id || typeof device_id !== 'string') {
      return res.status(400).json({ error: 'device_id required' });
    }
    await col('restaurants').updateOne(
      { _id: req.staff.restaurantId },
      { $pull: { push_tokens: { device_id } }, $set: { updated_at: new Date() } }
    );
    return res.json({ success: true });
  } catch (e) {
    log.error({ err: e }, 'push-token delete failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/staff/orders — currently-actionable orders for this staff
// member: status IN [PAID, CONFIRMED, PREPARING, PACKED], newest first,
// limit 50. Branch-filtered when the staff JWT carries non-empty
// branchIds. Masked customer phones.
router.get('/orders', requireStaffAuth(), async (req, res) => {
  try {
    const filter = {
      restaurant_id: req.staff.restaurantId,
      status: { $in: ['PAID', 'CONFIRMED', 'PREPARING', 'PACKED'] },
    };
    if (Array.isArray(req.staff.branchIds) && req.staff.branchIds.length) {
      filter.branch_id = { $in: req.staff.branchIds };
    }
    const orders = await col('orders')
      .find(filter)
      .sort({ created_at: -1 })
      .limit(50)
      .toArray();

    const customerIds = [...new Set(orders.map(o => o.customer_id).filter(Boolean))];
    const customers = customerIds.length
      ? await col('customers')
          .find({ _id: { $in: customerIds } }, { projection: { _id: 1, name: 1, wa_phone: 1 } })
          .toArray()
      : [];
    const custById = new Map(customers.map(c => [String(c._id), c]));

    const payload = orders.map(o => {
      const c = custById.get(String(o.customer_id));
      return {
        id: String(o._id),
        order_number: o.order_number,
        customer_name: c?.name || o.receiver_name || 'Customer',
        customer_phone_masked: maskPhone(c?.wa_phone || o.receiver_phone || ''),
        total_rs: o.total_rs,
        total_amount: o.total_rs,
        status: o.status,
        payment_status: o.payment_status || null,
        branch_id: o.branch_id || null,
        accepted_at: o.confirmed_at || o.acknowledged_at || null,
        created_at: o.created_at,
        items: Array.isArray(o.items)
          ? o.items.map(i => ({ name: i.name, quantity: i.quantity }))
          : [],
      };
    });
    return res.json({ success: true, orders: payload });
  } catch (e) {
    log.error({ err: e, restaurantId: req.staff.restaurantId }, 'staff list orders failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/staff/orders/:orderId/status — staff-allowed transitions
// only: CONFIRMED → PREPARING and PREPARING → PACKED. Staff cannot
// transition to DISPATCHED, DELIVERED, CANCELLED, or any fault state —
// those go through the owner dashboard or order-state-machine triggers.
//
// Lowercase status in body maps to the canonical uppercase DB enum.
// Transitions go through the state engine so invariants (audit log,
// timestamps, referral reversal) hold.
const STATUS_MAP = {
  preparing: 'PREPARING',
  ready:     'PACKED',
  packed:    'PACKED',
};
// Staff can only move FROM these states.
const STAFF_ALLOWED_FROM = new Set(['CONFIRMED', 'PREPARING']);

router.patch('/orders/:orderId/status', requireStaffAuth(), express.json(), async (req, res) => {
  try {
    if (!req.staff.permissions?.manage_orders) {
      return res.status(403).json({ error: 'Permission denied: manage_orders' });
    }
    const incoming = String(req.body?.status || '').toLowerCase();
    const newStatus = STATUS_MAP[incoming];
    if (!newStatus) {
      return res.status(400).json({ error: `Invalid status. Allowed: ${Object.keys(STATUS_MAP).join(', ')}` });
    }

    const order = await col('orders').findOne(
      { _id: req.params.orderId },
      { projection: { _id: 1, restaurant_id: 1, branch_id: 1, status: 1 } }
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (String(order.restaurant_id) !== String(req.staff.restaurantId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    // Branch guard: scoped staff can only act on their branches.
    if (Array.isArray(req.staff.branchIds) && req.staff.branchIds.length) {
      if (!req.staff.branchIds.map(String).includes(String(order.branch_id))) {
        return res.status(403).json({ error: 'Forbidden — order not in your branch' });
      }
    }
    // Restrict the FROM state. Staff can't kick a PAID order straight
    // to PREPARING — owner has to /accept first to move PAID → CONFIRMED.
    if (!STAFF_ALLOWED_FROM.has(order.status)) {
      return res.status(409).json({
        error: `Cannot transition order from ${order.status} via staff endpoint`,
      });
    }

    const updated = await orderSvc.updateStatus(req.params.orderId, newStatus, {
      actor: req.staff.userId || 'staff',
      actorType: 'staff',
    });

    // SSE push happens automatically via the order.updated bus event
    // → events/listeners/sseListener.onOrderUpdated → sse.pushToRestaurant.
    // No manual push here; the listener is the single source of truth so
    // every transition (here, /accept, /decline, fault handlers) fans
    // out identically without callsite duplication.

    const finalStatus = updated?.status || newStatus;
    const orderNumber = updated?.order_number || req.params.orderId;
    res.json({ success: true, status: finalStatus });

    // Fire-and-forget Expo push — runs AFTER res.json() so the response
    // is already on the wire. setImmediate detaches from the request
    // lifecycle; errors are swallowed inside expoPush.sendPush.
    setImmediate(async () => {
      try {
        const r = await col('restaurants').findOne(
          { _id: req.staff.restaurantId },
          { projection: { push_tokens: 1 } }
        );
        const tokens = (r?.push_tokens || []).map(e => e?.token).filter(Boolean);
        if (!tokens.length) return;
        expoPush.sendPush(tokens, {
          title: 'Order Updated',
          body: `Order #${orderNumber} is now ${incoming}`,
          data: { type: 'order_update', order_id: String(req.params.orderId), status: incoming },
        }).catch(() => {});
      } catch (err) { log.warn({ err: err.message }, 'expo push after status update failed'); }
    });
    return;
  } catch (e) {
    log.error({ err: e, orderId: req.params.orderId }, 'staff status update failed');
    return res.status(500).json({ error: e?.message || 'Internal server error' });
  }
});

// GET /api/staff/menu — items grouped by category_name. Branch-filtered
// when the staff JWT carries non-empty branchIds.
router.get('/menu', requireStaffAuth(), async (req, res) => {
  try {
    const filter = { restaurant_id: req.staff.restaurantId };
    if (Array.isArray(req.staff.branchIds) && req.staff.branchIds.length) {
      filter.branch_id = { $in: req.staff.branchIds };
    }
    const items = await col('menu_items')
      .find(
        filter,
        { projection: { _id: 1, name: 1, price_paise: 1, is_available: 1, image_url: 1, category_name: 1, category_id: 1, branch_id: 1 } }
      )
      .toArray();

    const grouped = new Map();
    for (const it of items) {
      const cat = it.category_name || 'Uncategorized';
      if (!grouped.has(cat)) grouped.set(cat, []);
      grouped.get(cat).push({
        id: String(it._id),
        name: it.name,
        price_rs: (it.price_paise || 0) / 100,
        is_available: !!it.is_available,
        image_url: it.image_url || null,
        category: cat,
      });
    }
    const categories = Array.from(grouped, ([name, menu_items]) => ({ name, items: menu_items }));
    return res.json({ success: true, categories });
  } catch (e) {
    log.error({ err: e, restaurantId: req.staff.restaurantId }, 'staff menu fetch failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Shared availability handler — used by both /menu/:id/availability
// (existing path) and /items/:id/availability (spec'd path). Accepts
// either `is_available` or `available` in the body. Gated by manage_menu
// + branch scope.
async function _setItemAvailability(req, res) {
  try {
    if (!req.staff.permissions?.manage_menu) {
      return res.status(403).json({ error: 'Permission denied: manage_menu' });
    }
    const raw = typeof req.body?.is_available === 'boolean'
      ? req.body.is_available
      : (typeof req.body?.available === 'boolean' ? req.body.available : null);
    if (raw === null) {
      return res.status(400).json({ error: 'is_available (or available) must be boolean' });
    }
    const item = await col('menu_items').findOne(
      { _id: req.params.itemId },
      { projection: { _id: 1, restaurant_id: 1, branch_id: 1 } },
    );
    if (!item) return res.status(404).json({ error: 'Menu item not found' });
    if (String(item.restaurant_id) !== String(req.staff.restaurantId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (Array.isArray(req.staff.branchIds) && req.staff.branchIds.length) {
      if (!req.staff.branchIds.map(String).includes(String(item.branch_id))) {
        return res.status(403).json({ error: 'Forbidden — item not in your branch' });
      }
    }
    await col('menu_items').updateOne(
      { _id: req.params.itemId },
      { $set: { is_available: raw, updated_at: new Date() } },
    );
    return res.json({ success: true, is_available: raw });
  } catch (e) {
    log.error({ err: e, itemId: req.params.itemId }, 'staff availability toggle failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// PATCH /api/staff/menu/:itemId/availability — existing path.
router.patch('/menu/:itemId/availability', requireStaffAuth(), express.json(), _setItemAvailability);

// PATCH /api/staff/items/:itemId/availability — alternate path per spec.
// Mirrors /menu/:itemId/availability so frontends written against the
// spec'd path also work.
router.patch('/items/:itemId/availability', requireStaffAuth(), express.json(), _setItemAvailability);

module.exports = router;
