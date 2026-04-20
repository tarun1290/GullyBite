'use strict';

// Staff POS router — PIN auth, SSE live-order stream, order status
// updates, and menu availability toggles. Mounted at /api/staff in
// backend/server.js. All routes except POST /auth require a staff JWT.

const express = require('express');
const router = express.Router();

const { col } = require('../config/database');
const { requireStaffAuth, signStaffToken } = require('../middleware/staffAuth');
const { rateLimitFn } = require('../middleware/rateLimit');
const { verifyStaffPin } = require('../services/staffPin');
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

// POST /api/staff/auth — { restaurant_slug, pin } → { token, restaurant }
router.post('/auth', staffAuthLimiter, express.json(), async (req, res) => {
  try {
    const { restaurant_slug, pin } = req.body || {};
    if (!restaurant_slug || !pin || !/^\d{4}$/.test(String(pin))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const r = await col('restaurants').findOne(
      { store_slug: String(restaurant_slug) },
      { projection: {
          _id: 1, store_slug: 1, business_name: 1, brand_name: 1, logo_url: 1,
          staff_pin: 1, default_branch_id: 1,
        } }
    );
    if (!r || !r.staff_pin) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const ok = await verifyStaffPin(r._id, String(pin));
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    // Optional single-branch hint for the UI (e.g. multi-branch chains
    // can still show which outlet this tablet is logged into).
    let branchName = null;
    if (r.default_branch_id) {
      const b = await col('branches').findOne(
        { _id: r.default_branch_id },
        { projection: { name: 1 } }
      );
      branchName = b?.name || null;
    }

    const token = signStaffToken({
      restaurantId: String(r._id),
      restaurantSlug: r.store_slug || null,
    });
    return res.json({
      success: true,
      token,
      restaurant: {
        id: String(r._id),
        name: r.brand_name || r.business_name,
        slug: r.store_slug || null,
        logo_url: r.logo_url || null,
        branch_name: branchName,
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

  sse.addConnection(req.staff.restaurantId, res);
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

// GET /api/staff/orders — last 24h, masked phones.
router.get('/orders', requireStaffAuth(), async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const orders = await col('orders')
      .find({ restaurant_id: req.staff.restaurantId, created_at: { $gte: since } })
      .sort({ created_at: -1 })
      .limit(500)
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
        status: o.status,
        payment_status: o.payment_status || null,
        created_at: o.created_at,
        items: Array.isArray(o.items) ? o.items : [],
      };
    });
    return res.json({ success: true, orders: payload });
  } catch (e) {
    log.error({ err: e, restaurantId: req.staff.restaurantId }, 'staff list orders failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/staff/orders/:orderId/status — lowercase status in body maps
// to the canonical uppercase DB enum. Transitions go through the state
// engine so invariants (audit log, timestamps, referral reversal) hold.
const STATUS_MAP = {
  confirmed:        'CONFIRMED',
  preparing:        'PREPARING',
  ready:            'PACKED',
  out_for_delivery: 'DISPATCHED',
  delivered:        'DELIVERED',
  cancelled:        'CANCELLED',
};

router.patch('/orders/:orderId/status', requireStaffAuth(), express.json(), async (req, res) => {
  try {
    const incoming = String(req.body?.status || '').toLowerCase();
    const newStatus = STATUS_MAP[incoming];
    if (!newStatus) {
      return res.status(400).json({ error: `Invalid status. Allowed: ${Object.keys(STATUS_MAP).join(', ')}` });
    }

    const order = await col('orders').findOne(
      { _id: req.params.orderId },
      { projection: { _id: 1, restaurant_id: 1 } }
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (String(order.restaurant_id) !== String(req.staff.restaurantId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const updated = await orderSvc.updateStatus(req.params.orderId, newStatus, {
      actor: 'staff',
      actorType: 'staff',
    });

    // Push updated order to all SSE clients for this restaurant.
    try {
      sse.pushOrderToRestaurant(req.staff.restaurantId, {
        id: String(updated?._id || req.params.orderId),
        order_number: updated?.order_number,
        status: updated?.status || newStatus,
        payment_status: updated?.payment_status || null,
        total_rs: updated?.total_rs,
        updated_at: new Date().toISOString(),
        event_type: 'status_change',
      });
    } catch (err) { log.warn({ err }, 'sse push after status update failed'); }

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

// GET /api/staff/menu — items grouped by category_name.
router.get('/menu', requireStaffAuth(), async (req, res) => {
  try {
    const items = await col('menu_items')
      .find(
        { restaurant_id: req.staff.restaurantId },
        { projection: { _id: 1, name: 1, price_paise: 1, is_available: 1, image_url: 1, category_name: 1, category_id: 1 } }
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

// PATCH /api/staff/menu/:itemId/availability
router.patch('/menu/:itemId/availability', requireStaffAuth(), express.json(), async (req, res) => {
  try {
    if (typeof req.body?.is_available !== 'boolean') {
      return res.status(400).json({ error: 'is_available must be boolean' });
    }
    const item = await col('menu_items').findOne(
      { _id: req.params.itemId },
      { projection: { _id: 1, restaurant_id: 1 } }
    );
    if (!item) return res.status(404).json({ error: 'Menu item not found' });
    if (String(item.restaurant_id) !== String(req.staff.restaurantId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await col('menu_items').updateOne(
      { _id: req.params.itemId },
      { $set: { is_available: req.body.is_available, updated_at: new Date() } }
    );
    return res.json({ success: true, is_available: req.body.is_available });
  } catch (e) {
    log.error({ err: e, itemId: req.params.itemId }, 'staff availability toggle failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
