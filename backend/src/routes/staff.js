'use strict';

// Staff POS router — per-user PIN auth, SSE live-order stream, order
// status updates, and menu availability toggles. Mounted at /api/staff
// in backend/ec2-server.js. All routes except POST /auth require a
// staff JWT (per-user, hydrated by middleware/staffAuth.requireStaffAuth).
//
// Auth model: each user has their own row in restaurant_users with
// role in {staff, manager}, phone, bcrypt'd PIN, branch_ids, and
// permissions. Managers log in through the same /auth flow as staff
// — the role split is purely about feature gating in the staff app
// (managers see branch-open/close, staff list, settlement, daily
// summary; staff don't). Owners use a different login path entirely.
// The legacy single shared restaurants.staff_pin is deprecated and
// no longer consulted by /auth (Option A migration).

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');

const { col } = require('../config/database');
const { requireStaffAuth, signStaffToken, resolveBranchScope, STAFF_APP_ROLES } = require('../middleware/staffAuth');
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

// NOTE: The legacy POST /auth handler (login via staff_access_token +
// name + pin) was removed on 2026-05-09. The new staff-auth contract
// owns POST /api/staff/auth → /, /logout, /me in routes/staffAuth.js,
// mounted BEFORE this router in ec2-server.js so the new handler wins.

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

// GET /api/staff/orders — orders for this staff member's scope.
//
// Two modes:
//   (a) no `date` param → "live" view: orders not in the terminal
//       set [DELIVERED, CANCELLED, REJECTED_BY_RESTAURANT,
//       RESTAURANT_TIMEOUT], newest first, limit 50. This includes
//       PAID, CONFIRMED, PREPARING, PACKED, and DISPATCHED so a rider-
//       picked-up order stays visible until it's actually delivered.
//   (b) `?date=YYYY-MM-DD` → past-orders view: every order created on
//       that calendar day in IST, regardless of status. Limit 200 so
//       a busy day doesn't truncate but the response stays bounded.
//
// Branch-filtered via X-Branch-Id (resolveBranchScope) — defaults to
// the JWT primary, "all" expands to the assigned set. Masked customer
// phones in both modes.
//
// Terminal statuses excluded from the "live" view. Mirrors the user's
// spec: live = NOT IN [DELIVERED, CANCELLED, REJECTED_BY_RESTAURANT,
// RESTAURANT_TIMEOUT].
const STAFF_LIVE_EXCLUDED_STATUSES = [
  'DELIVERED',
  'CANCELLED',
  'REJECTED_BY_RESTAURANT',
  'RESTAURANT_TIMEOUT',
];

// IST day boundary helper. Mirrors admin.js — dateStr is YYYY-MM-DD,
// `end` toggles between start-of-day (00:00:00.000 IST) and
// end-of-day (23:59:59.999 IST). Returns a UTC Date instance suitable
// for direct use in Mongo `$gte` / `$lte` queries against `created_at`.
const _STAFF_IST_OFFSET = '+05:30';
function _staffIstBoundary(dateStr, end) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) return null;
  const time = end ? 'T23:59:59.999' : 'T00:00:00.000';
  const d = new Date(dateStr + time + _STAFF_IST_OFFSET);
  return Number.isNaN(d.getTime()) ? null : d;
}

router.get('/orders', requireStaffAuth(), async (req, res) => {
  try {
    const scope = resolveBranchScope(req);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const filter = {
      restaurant_id: req.staff.restaurantId,
    };
    if (scope.branchIds.length) {
      filter.branch_id = { $in: scope.branchIds };
    }

    // Date filter — when present, scope to that IST calendar day and
    // drop the status filter (past view returns every status). When
    // absent, apply the live-view status exclusion list.
    const dateRaw = typeof req.query?.date === 'string' ? req.query.date.trim() : '';
    let limit = 50;
    if (dateRaw) {
      const start = _staffIstBoundary(dateRaw, false);
      const end = _staffIstBoundary(dateRaw, true);
      if (!start || !end) {
        return res.status(400).json({ error: 'Invalid date — expected YYYY-MM-DD' });
      }
      filter.created_at = { $gte: start, $lte: end };
      limit = 200;
    } else {
      filter.status = { $nin: STAFF_LIVE_EXCLUDED_STATUSES };
    }

    const orders = await col('orders')
      .find(filter)
      .sort({ created_at: -1 })
      .limit(limit)
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

// GET /api/staff/orders/:orderId — single-order detail for the staff app.
//
// Status-agnostic: returns the order regardless of where it sits in
// the state machine, so the detail page works for past orders (date
// view) and orders that have moved past PACKED. Branch-guarded the
// same way as the list — the order's branch must be in the scope set
// (X-Branch-Id-resolved). Cross-restaurant requests 404 to avoid
// leaking whether an id exists in another tenant.
router.get('/orders/:orderId', requireStaffAuth(), async (req, res) => {
  try {
    const scope = resolveBranchScope(req);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });

    const order = await col('orders').findOne({ _id: req.params.orderId });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (String(order.restaurant_id) !== String(req.staff.restaurantId)) {
      // Treat as 404 — don't reveal cross-tenant existence.
      return res.status(404).json({ error: 'Order not found' });
    }
    if (scope.branchIds.length && !scope.branchIds.includes(String(order.branch_id))) {
      return res.status(403).json({ error: 'Forbidden — order not in your branch' });
    }

    let customer = null;
    if (order.customer_id) {
      customer = await col('customers').findOne(
        { _id: order.customer_id },
        { projection: { _id: 1, name: 1, wa_phone: 1 } },
      );
    }

    return res.json({
      success: true,
      order: {
        id: String(order._id),
        order_number: order.order_number,
        customer_name: customer?.name || order.receiver_name || 'Customer',
        customer_phone_masked: maskPhone(customer?.wa_phone || order.receiver_phone || ''),
        total_rs: order.total_rs,
        total_amount: order.total_rs,
        subtotal_rs: order.subtotal_rs ?? null,
        delivery_fee_rs: order.delivery_fee_rs ?? null,
        discount_rs: order.discount_rs ?? null,
        status: order.status,
        payment_status: order.payment_status || null,
        branch_id: order.branch_id || null,
        accepted_at: order.confirmed_at || order.acknowledged_at || null,
        delivered_at: order.delivered_at || null,
        created_at: order.created_at,
        items: Array.isArray(order.items)
          ? order.items.map((i) => ({
              name: i.name,
              quantity: i.quantity ?? i.qty,
              price_rs: i.unit_price_rs ?? i.price_rs ?? null,
            }))
          : [],
      },
    });
  } catch (e) {
    log.error({ err: e, orderId: req.params.orderId }, 'staff get order failed');
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
    // Permission-gated: requires mark_ready
    // Per the patched 10-key staff permissions contract, the staff-side
    // CONFIRMED→PREPARING→PACKED transitions are all governed by
    // mark_ready (the legacy manage_orders key is retired on the staff
    // side; owner JWTs continue to use manage_orders via routes/auth.js).
    // No legacy fallback — staff rows must carry the new key shape.
    if (!req.staff.permissions?.mark_ready) {
      return res.status(403).json({ error: 'Permission denied: mark_ready' });
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
    // Branch guard: validate the order's branch is in the scope set
    // (X-Branch-Id-resolved). For PATCH endpoints we don't strictly
    // need the X-Branch-Id header — the resource itself carries the
    // branch — but we still honour the header so a staff member who
    // selected a single branch in the UI can't accidentally act on a
    // different branch's order via a stale orderId in flight.
    const scope = resolveBranchScope(req);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    if (scope.branchIds.length && !scope.branchIds.includes(String(order.branch_id))) {
      return res.status(403).json({ error: 'Forbidden — order not in your branch' });
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
    const scope = resolveBranchScope(req);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const filter = { restaurant_id: req.staff.restaurantId };
    if (scope.branchIds.length) {
      filter.branch_id = { $in: scope.branchIds };
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
    // Branch guard via X-Branch-Id-resolved scope (same pattern as the
    // orders/:id/status guard above).
    const scope = resolveBranchScope(req);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    if (scope.branchIds.length && !scope.branchIds.includes(String(item.branch_id))) {
      return res.status(403).json({ error: 'Forbidden — item not in your branch' });
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
