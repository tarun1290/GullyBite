// src/services/orderCreate.service.js
// Phase 1: canonical order-creation path.
//
// Responsibilities:
//   • Atomic daily per-tenant order number via `order_counters`.
//   • Freezes the delivery address as `address_snapshot` on the order.
//   • Denormalizes `items` (frozen copy) onto the order row so the
//     WhatsApp receipt / reorder flow can replay the order with a
//     single findOne — `order_items` rows are still the authoritative
//     per-line store.
//   • Writes restaurant_id onto order_items so analytics don't join.
//   • Advances the per-tenant customer_profile (LTV, last order).
//
// Non-responsibilities:
//   • Payment. Caller creates the payment record separately
//     (paymentSvc), keyed by the order_id returned here. The order is
//     born in status 'PENDING_PAYMENT' with payment_status 'unpaid'.
//   • Idempotency. Wrap this with utils/withIdempotency in the caller
//     if duplicate submissions are possible (WhatsApp double-tap etc.).

'use strict';

const { col, newId } = require('../config/database');
const addressBook = require('./addressBook.service');
const customerProfile = require('./customerProfile.service');

// Atomic daily counter. One row per (restaurant_id, yyyymmdd). $inc is
// atomic at the document level — concurrent callers never collide even
// without a distributed lock.
async function _nextOrderNumber(restaurantId) {
  const d = new Date();
  const yyyymmdd =
    d.getFullYear().toString() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0');
  const _id = `${restaurantId}:${yyyymmdd}`;

  const res = await col('order_counters').findOneAndUpdate(
    { _id },
    {
      $inc: { seq: 1 },
      $setOnInsert: { restaurant_id: String(restaurantId), date: yyyymmdd },
      $set: { updated_at: new Date() },
    },
    { upsert: true, returnDocument: 'after' }
  );
  const seq = res?.value?.seq || 1;
  // Human-readable: GB-<yyyymmdd>-<padded-seq>. Not globally unique on
  // its own — pair with restaurant_id in display if needed.
  return `GB-${yyyymmdd}-${String(seq).padStart(4, '0')}`;
}

function _round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// Create an order from a cart.
//   restaurantId, customerId, cart (from cart.service.getCart)
//   options: { brandId?, deliveryFeeRs?, discountRs?, menuVersion? }
//
// Returns { order, orderItems, order_number }.
async function createOrder({ restaurantId, customerId, cart, options = {} } = {}) {
  if (!restaurantId) throw new Error('createOrder: restaurantId is required');
  if (!customerId)   throw new Error('createOrder: customerId is required');
  if (!cart || !Array.isArray(cart.items) || cart.items.length === 0) {
    throw new Error('createOrder: cart is empty');
  }
  if (!cart.address_id) throw new Error('createOrder: cart.address_id is required');

  const address = await addressBook.findById(cart.address_id);
  if (!address || String(address.customer_id) !== String(customerId)) {
    throw new Error('createOrder: address does not belong to this customer');
  }

  const subtotal_rs     = _round2(cart.items.reduce((a, it) => a + (Number(it.unit_price_rs) || 0) * (Number(it.qty) || 0), 0));
  const delivery_fee_rs = _round2(options.deliveryFeeRs || 0);
  const discount_rs     = _round2(options.discountRs || 0);
  const total_rs        = _round2(subtotal_rs + delivery_fee_rs - discount_rs);

  const order_number = await _nextOrderNumber(restaurantId);
  const now = new Date();
  const order = {
    _id: newId(),
    order_number,
    restaurant_id: String(restaurantId),
    branch_id: cart.branch_id ? String(cart.branch_id) : null,
    brand_id: options.brandId ? String(options.brandId) : null,
    customer_id: String(customerId),

    subtotal_rs,
    delivery_fee_rs,
    discount_rs,
    total_rs,

    status: 'PENDING_PAYMENT',
    payment_status: 'unpaid',

    items: cart.items.map((it) => ({
      menu_item_id: String(it.menu_item_id),
      name: String(it.name),
      qty: Number(it.qty) || 0,
      unit_price_rs: Number(it.unit_price_rs) || 0,
      line_total_rs: _round2((Number(it.unit_price_rs) || 0) * (Number(it.qty) || 0)),
    })),

    address_snapshot: addressBook.snapshot(address),
    delivery_address: address.address_line || null,

    menu_version: options.menuVersion || null,

    created_at: now,
    updated_at: now,
  };

  // order_items: per-line rows (authoritative). Carry restaurant_id so
  // per-tenant analytics don't need a join through orders.
  const orderItems = order.items.map((li) => ({
    _id: newId(),
    order_id: order._id,
    restaurant_id: order.restaurant_id,
    menu_item_id: li.menu_item_id,
    item_name: li.name,
    unit_price_rs: li.unit_price_rs,
    quantity: li.qty,
    line_total_rs: li.line_total_rs,
  }));

  await col('orders').insertOne(order);
  if (orderItems.length) await col('order_items').insertMany(orderItems);

  // Advance per-tenant profile. Best-effort — profile drift doesn't
  // block order creation, and recovery jobs can rebuild from orders.
  try {
    await customerProfile.recordOrder(restaurantId, customerId, {
      total_rs: order.total_rs,
      ordered_at: order.created_at,
    });
  } catch (_) { /* swallow */ }

  return { order, order_items: orderItems, order_number };
}

module.exports = { createOrder };
