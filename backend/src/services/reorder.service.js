// src/services/reorder.service.js
// Phase 1: "order it again" flow.
//
// lastOrders(restaurantId, customerId, { limit })
//   → most recent N orders the customer has placed at this tenant,
//     with their frozen items array. Used to render the WhatsApp
//     "Reorder" list.
//
// reorder(restaurantId, customerId, orderId)
//   → rebuilds the cart from a prior order, filtering out items
//     that are currently unavailable or whose price has moved. The
//     skipped list is returned so the flow can tell the customer
//     "2 items weren't available, added the rest".
//
// Menu-version drift: orders.menu_version pins the catalog snapshot
// at order time, but the authoritative source for "is this item
// still orderable now?" is menu_items.is_available at read time.

'use strict';

const { col } = require('../config/database');
const cartSvc = require('./cart.service');

async function lastOrders(restaurantId, customerId, { limit = 5 } = {}) {
  if (!restaurantId || !customerId) return [];
  return col('orders')
    .find({ restaurant_id: String(restaurantId), customer_id: String(customerId) })
    .project({ order_number: 1, total_rs: 1, items: 1, status: 1, created_at: 1, branch_id: 1 })
    .sort({ created_at: -1 })
    .limit(Math.max(1, Math.min(20, Number(limit) || 5)))
    .toArray();
}

// Rebuild the cart from a prior order. Returns:
//   { cart, added: [{menu_item_id,name,qty,unit_price_rs}],
//     skipped: [{menu_item_id,name,reason}] }
//
// reasons: 'unavailable' | 'missing' | 'price_changed'
async function reorder(restaurantId, customerId, orderId) {
  if (!restaurantId || !customerId || !orderId) {
    throw new Error('reorder: restaurantId, customerId, orderId required');
  }
  const order = await col('orders').findOne({
    _id: String(orderId),
    restaurant_id: String(restaurantId),
    customer_id: String(customerId),
  });
  if (!order) throw new Error('reorder: order not found');
  if (!Array.isArray(order.items) || order.items.length === 0) {
    // Legacy orders without frozen items array — fall back to order_items rows.
    const rows = await col('order_items').find({ order_id: order._id }).toArray();
    order.items = rows.map((r) => ({
      menu_item_id: r.menu_item_id,
      name: r.item_name,
      qty: r.quantity,
      unit_price_rs: r.unit_price_rs,
    }));
  }

  const menuIds = order.items.map((it) => String(it.menu_item_id));
  const current = await col('menu_items')
    .find({ _id: { $in: menuIds } })
    .project({ _id: 1, name: 1, is_available: 1, price_paise: 1, food_type: 1, image_url: 1 })
    .toArray();
  const byId = new Map(current.map((m) => [String(m._id), m]));

  // Clear any existing active cart so reorder doesn't stack on top of
  // whatever the customer had in progress. The customer can always
  // add more after — this is the less-surprising behavior.
  await cartSvc.clearCart(restaurantId, customerId);

  const added = [];
  const skipped = [];
  for (const it of order.items) {
    const menu = byId.get(String(it.menu_item_id));
    if (!menu) { skipped.push({ menu_item_id: it.menu_item_id, name: it.name, reason: 'missing' }); continue; }
    if (!menu.is_available) { skipped.push({ menu_item_id: it.menu_item_id, name: menu.name || it.name, reason: 'unavailable' }); continue; }

    const currentPriceRs = menu.price_paise != null ? menu.price_paise / 100 : Number(it.unit_price_rs) || 0;
    await cartSvc.addToCart(restaurantId, customerId, {
      menu_item_id: String(menu._id),
      name: menu.name || it.name,
      qty: Number(it.qty) || 1,
      unit_price_rs: currentPriceRs,
      food_type: menu.food_type || null,
      image_url: menu.image_url || null,
    }, { branchId: order.branch_id });

    added.push({
      menu_item_id: String(menu._id),
      name: menu.name || it.name,
      qty: Number(it.qty) || 1,
      unit_price_rs: currentPriceRs,
      price_changed: Math.abs(currentPriceRs - (Number(it.unit_price_rs) || 0)) > 0.01,
    });
  }

  const cart = await cartSvc.getCart(restaurantId, customerId);
  return { cart, added, skipped };
}

module.exports = { lastOrders, reorder };
