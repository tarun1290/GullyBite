// src/routes/customer.js
// Phase 1 (Commit A): customer-facing endpoints, scoped to the
// addressBook + profile surfaces only. Cart / reorder / order-create
// land in Commit B alongside the WhatsApp flow handler.
//
// Mount in server.js as:
//
//   app.use('/api/customer', express.json(), require('./src/routes/customer'));
//
// Identity model (MVP): the caller passes X-Customer-Phone or
// X-Customer-Id; tenantGuard resolves it into req.customer. No JWT yet
// — these endpoints are called by the dashboard on behalf of a
// customer, or by the WhatsApp flow handler with an already-resolved
// customer id.

'use strict';

const express = require('express');
const router = express.Router();

const { requireTenant, requireCustomer } = require('../middleware/tenantGuard');
const addressBook = require('../services/addressBook.service');
const customerProfile = require('../services/customerProfile.service');
const cartSvc = require('../services/cart.service');
const reorderSvc = require('../services/reorder.service');
const orderCreateSvc = require('../services/orderCreate.service');
const { col } = require('../config/database');

// ─── PROFILE ──────────────────────────────────────────────────
// GET /api/customer/:restaurant_id/profile
// Returns the caller's per-tenant profile (LTV, prefs, last order).
router.get('/:restaurant_id/profile', requireTenant, requireCustomer, async (req, res, next) => {
  try {
    const profile = await customerProfile.getOrCreate(req.tenant.id, req.customer.id);
    res.json({
      customer: req.customer,
      profile: {
        total_orders: profile.total_orders || 0,
        total_spent_rs: profile.total_spent_rs || 0,
        last_order_at: profile.last_order_at || null,
        preferences: profile.preferences || {},
      },
    });
  } catch (err) { next(err); }
});

// ─── ADDRESSES ────────────────────────────────────────────────
// Addresses are global (not per-tenant) — the tenant guard is still
// required here so an unknown restaurant can't be used to pivot into
// the address book, but the returned list is the customer's full
// cross-tenant address set.

// GET /api/customer/:restaurant_id/addresses
router.get('/:restaurant_id/addresses', requireTenant, requireCustomer, async (req, res, next) => {
  try {
    const addresses = await addressBook.list(req.customer.id);
    res.json({ addresses });
  } catch (err) { next(err); }
});

// POST /api/customer/:restaurant_id/addresses
// body: { label, address_line, landmark, pincode, city, state, latitude, longitude, is_default }
router.post('/:restaurant_id/addresses', requireTenant, requireCustomer, async (req, res, next) => {
  try {
    const addr = await addressBook.create(req.customer.id, req.body || {});
    res.status(201).json({ address: addr });
  } catch (err) {
    if (err?.message?.includes('required')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

// PATCH /api/customer/:restaurant_id/addresses/:id
router.patch('/:restaurant_id/addresses/:id', requireTenant, requireCustomer, async (req, res, next) => {
  try {
    const updated = await addressBook.update(req.params.id, req.customer.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'address not found' });
    res.json({ address: updated });
  } catch (err) { next(err); }
});

// PUT /api/customer/:restaurant_id/addresses/:id/default
router.put('/:restaurant_id/addresses/:id/default', requireTenant, requireCustomer, async (req, res, next) => {
  try {
    const updated = await addressBook.setDefault(req.params.id, req.customer.id);
    if (!updated) return res.status(404).json({ error: 'address not found' });
    res.json({ address: updated });
  } catch (err) { next(err); }
});

// DELETE /api/customer/:restaurant_id/addresses/:id
router.delete('/:restaurant_id/addresses/:id', requireTenant, requireCustomer, async (req, res, next) => {
  try {
    const ok = await addressBook.remove(req.params.id, req.customer.id);
    if (!ok) return res.status(404).json({ error: 'address not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ─── CART ─────────────────────────────────────────────────────
// GET /api/customer/:restaurant_id/cart
router.get('/:restaurant_id/cart', requireTenant, requireCustomer, async (req, res, next) => {
  try {
    const cart = await cartSvc.getCart(req.tenant.id, req.customer.id);
    res.json({ cart });
  } catch (err) { next(err); }
});

// POST /api/customer/:restaurant_id/cart/items
// body: { menu_item_id, name, qty?, unit_price_rs, branch_id? }
router.post('/:restaurant_id/cart/items', requireTenant, requireCustomer, async (req, res, next) => {
  try {
    const cart = await cartSvc.addToCart(
      req.tenant.id,
      req.customer.id,
      req.body || {},
      { branchId: req.body?.branch_id }
    );
    res.status(201).json({ cart });
  } catch (err) {
    if (err?.code === 'CART_LOCKED') return res.status(409).json({ error: err.message, code: 'CART_LOCKED' });
    if (err?.message?.startsWith('addToCart:')) return res.status(400).json({ error: err.message });
    next(err);
  }
});

// PATCH /api/customer/:restaurant_id/cart/items/:menu_item_id  body: { qty }
router.patch('/:restaurant_id/cart/items/:menu_item_id', requireTenant, requireCustomer, async (req, res, next) => {
  try {
    const cart = await cartSvc.updateQuantity(req.tenant.id, req.customer.id, req.params.menu_item_id, req.body?.qty);
    res.json({ cart });
  } catch (err) {
    if (err?.code === 'CART_LOCKED') return res.status(409).json({ error: err.message, code: 'CART_LOCKED' });
    next(err);
  }
});

// DELETE /api/customer/:restaurant_id/cart/items/:menu_item_id
router.delete('/:restaurant_id/cart/items/:menu_item_id', requireTenant, requireCustomer, async (req, res, next) => {
  try {
    const cart = await cartSvc.removeFromCart(req.tenant.id, req.customer.id, req.params.menu_item_id);
    res.json({ cart });
  } catch (err) {
    if (err?.code === 'CART_LOCKED') return res.status(409).json({ error: err.message, code: 'CART_LOCKED' });
    next(err);
  }
});

// PUT /api/customer/:restaurant_id/cart/address  body: { address_id }
router.put('/:restaurant_id/cart/address', requireTenant, requireCustomer, async (req, res, next) => {
  try {
    const cart = await cartSvc.setAddress(req.tenant.id, req.customer.id, req.body?.address_id);
    res.json({ cart });
  } catch (err) {
    if (err?.code === 'CART_LOCKED') return res.status(409).json({ error: err.message, code: 'CART_LOCKED' });
    next(err);
  }
});

// DELETE /api/customer/:restaurant_id/cart — abandon cart (delete row)
router.delete('/:restaurant_id/cart', requireTenant, requireCustomer, async (req, res, next) => {
  try {
    await cartSvc.clearCart(req.tenant.id, req.customer.id);
    res.status(204).end();
  } catch (err) { next(err); }
});

// ─── ORDERS ───────────────────────────────────────────────────
// GET /api/customer/:restaurant_id/orders
router.get('/:restaurant_id/orders', requireTenant, requireCustomer, async (req, res, next) => {
  try {
    const orders = await col('orders')
      .find({ restaurant_id: req.tenant.id, customer_id: req.customer.id })
      .project({ order_number: 1, total_rs: 1, status: 1, payment_status: 1, items: 1, created_at: 1 })
      .sort({ created_at: -1 })
      .limit(20)
      .toArray();
    res.json({ orders });
  } catch (err) { next(err); }
});

// POST /api/customer/:restaurant_id/orders — create order from active cart
// body: { delivery_fee_rs?, discount_rs?, brand_id?, menu_version? }
router.post('/:restaurant_id/orders', requireTenant, requireCustomer, async (req, res, next) => {
  try {
    const cart = await cartSvc.getCart(req.tenant.id, req.customer.id);
    if (!cart) return res.status(400).json({ error: 'no active cart' });

    const { order, order_items } = await orderCreateSvc.createOrder({
      restaurantId: req.tenant.id,
      customerId: req.customer.id,
      cart,
      options: {
        brandId: req.body?.brand_id || null,
        deliveryFeeRs: req.body?.delivery_fee_rs,
        discountRs: req.body?.discount_rs,
        menuVersion: req.body?.menu_version,
      },
    });
    await cartSvc.markCheckedOut(req.tenant.id, req.customer.id);
    res.status(201).json({ order, order_items });
  } catch (err) {
    if (err?.message?.startsWith('createOrder:')) return res.status(400).json({ error: err.message });
    next(err);
  }
});

// ─── REORDER ──────────────────────────────────────────────────
// GET /api/customer/:restaurant_id/reorder — last N orders (for picker)
router.get('/:restaurant_id/reorder', requireTenant, requireCustomer, async (req, res, next) => {
  try {
    const limit = Number(req.query?.limit) || 5;
    const orders = await reorderSvc.lastOrders(req.tenant.id, req.customer.id, { limit });
    res.json({ orders });
  } catch (err) { next(err); }
});

// POST /api/customer/:restaurant_id/reorder/:order_id — rebuild cart from order
router.post('/:restaurant_id/reorder/:order_id', requireTenant, requireCustomer, async (req, res, next) => {
  try {
    const result = await reorderSvc.reorder(req.tenant.id, req.customer.id, req.params.order_id);
    res.json(result);
  } catch (err) {
    if (err?.message?.startsWith('reorder:')) return res.status(400).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
