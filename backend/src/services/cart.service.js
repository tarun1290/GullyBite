// src/services/cart.service.js
// Phase 1: durable per-tenant cart sessions. One active cart per
// (restaurant_id, customer_id) — re-adding the same menu_item increments
// its quantity rather than creating a duplicate line.
//
// Storage: cart_sessions in Mongo (TTL on expires_at auto-reaps
// abandoned carts — see src/config/indexes.js). Consistent with the
// existing message_jobs pattern; no Redis dependency.
//
// Item shape stored on the cart:
//   { menu_item_id, name, qty, unit_price_rs, food_type?, image_url? }
//
// Subtotal is always recomputed from the items array; callers never
// pass it in. This keeps the cart self-consistent even if a caller
// skips an add/remove round-trip.

'use strict';

const { col, newId } = require('../config/database');

const COLLECTION = 'cart_sessions';
const TTL_HOURS = 24;  // window for "abandoned" cleanup

function _expiresAt() {
  return new Date(Date.now() + TTL_HOURS * 60 * 60 * 1000);
}

function _recomputeSubtotal(items) {
  return (items || []).reduce((acc, it) => {
    const price = Number(it.unit_price_rs) || 0;
    const qty   = Number(it.qty) || 0;
    return acc + price * qty;
  }, 0);
}

function _key(restaurantId, customerId) {
  return { restaurant_id: String(restaurantId), customer_id: String(customerId) };
}

// Phase 2: when the customer has confirmed and we're awaiting payment,
// the cart is locked — no add / update / remove / setAddress. Writers
// throw `CART_LOCKED` which callers surface to the customer as
// "can't change cart while payment is in progress". clearCart /
// markCheckedOut are allowed because those represent finalization, not
// mutation of cart contents.
class CartLockedError extends Error {
  constructor() { super('Cart is locked — payment in progress'); this.code = 'CART_LOCKED'; }
}
function _assertWritable(cart) {
  if (cart && cart.status === 'locked') throw new CartLockedError();
}

async function getCart(restaurantId, customerId) {
  if (!restaurantId || !customerId) return null;
  return col(COLLECTION).findOne(_key(restaurantId, customerId));
}

// Returns true if the cart exists and has at least one item.
async function hasActiveCart(restaurantId, customerId) {
  const cart = await getCart(restaurantId, customerId);
  return !!(cart && Array.isArray(cart.items) && cart.items.length > 0);
}

async function _getOrCreate(restaurantId, customerId, { branchId } = {}) {
  if (!restaurantId || !customerId) throw new Error('_getOrCreate: ids required');
  const now = new Date();
  const res = await col(COLLECTION).findOneAndUpdate(
    _key(restaurantId, customerId),
    {
      $setOnInsert: {
        _id: newId(),
        restaurant_id: String(restaurantId),
        customer_id: String(customerId),
        branch_id: branchId ? String(branchId) : null,
        items: [],
        address_id: null,
        subtotal_rs: 0,
        status: 'active',
        created_at: now,
      },
      $set: { updated_at: now, expires_at: _expiresAt() },
    },
    { upsert: true, returnDocument: 'after' }
  );
  return res?.value || col(COLLECTION).findOne(_key(restaurantId, customerId));
}

// Add (or increment) an item. If the same menu_item_id is already in
// the cart, its qty increases rather than producing a duplicate line.
async function addToCart(restaurantId, customerId, item, { branchId } = {}) {
  if (!item?.menu_item_id || !item?.name || item?.unit_price_rs == null) {
    throw new Error('addToCart: item requires menu_item_id, name, unit_price_rs');
  }
  const existing = await getCart(restaurantId, customerId);
  _assertWritable(existing);
  const cart = await _getOrCreate(restaurantId, customerId, { branchId });
  const items = Array.isArray(cart.items) ? [...cart.items] : [];
  const idx = items.findIndex((it) => String(it.menu_item_id) === String(item.menu_item_id));
  const addQty = Math.max(1, Number(item.qty) || 1);

  if (idx >= 0) {
    items[idx].qty = (Number(items[idx].qty) || 0) + addQty;
  } else {
    items.push({
      menu_item_id: String(item.menu_item_id),
      name: String(item.name),
      qty: addQty,
      unit_price_rs: Number(item.unit_price_rs),
      food_type: item.food_type || null,
      image_url: item.image_url || null,
    });
  }

  const subtotal_rs = Math.round(_recomputeSubtotal(items) * 100) / 100;
  const branchPatch = branchId && !cart.branch_id ? { branch_id: String(branchId) } : {};
  await col(COLLECTION).updateOne(
    _key(restaurantId, customerId),
    { $set: { items, subtotal_rs, updated_at: new Date(), expires_at: _expiresAt(), ...branchPatch } }
  );
  return getCart(restaurantId, customerId);
}

async function updateQuantity(restaurantId, customerId, menuItemId, qty) {
  const cart = await getCart(restaurantId, customerId);
  if (!cart) return null;
  _assertWritable(cart);
  const items = (cart.items || []).map((it) => ({ ...it }));
  const idx = items.findIndex((it) => String(it.menu_item_id) === String(menuItemId));
  if (idx < 0) return cart;

  const nextQty = Math.max(0, Number(qty) || 0);
  if (nextQty === 0) items.splice(idx, 1);
  else items[idx].qty = nextQty;

  const subtotal_rs = Math.round(_recomputeSubtotal(items) * 100) / 100;
  await col(COLLECTION).updateOne(
    _key(restaurantId, customerId),
    { $set: { items, subtotal_rs, updated_at: new Date(), expires_at: _expiresAt() } }
  );
  return getCart(restaurantId, customerId);
}

async function removeFromCart(restaurantId, customerId, menuItemId) {
  return updateQuantity(restaurantId, customerId, menuItemId, 0);
}

async function setAddress(restaurantId, customerId, addressId) {
  const existing = await getCart(restaurantId, customerId);
  _assertWritable(existing);
  const cart = await _getOrCreate(restaurantId, customerId);
  await col(COLLECTION).updateOne(
    _key(restaurantId, customerId),
    { $set: { address_id: addressId ? String(addressId) : null, updated_at: new Date(), expires_at: _expiresAt() } }
  );
  return getCart(restaurantId, customerId);
}

// Mark the cart 'checked_out' rather than deleting — preserves a short
// audit trail. TTL still cleans it up after TTL_HOURS. orderCreate
// calls this after the order is successfully inserted.
async function markCheckedOut(restaurantId, customerId) {
  await col(COLLECTION).updateOne(
    _key(restaurantId, customerId),
    { $set: { status: 'checked_out', updated_at: new Date() } }
  );
}

// Phase 2: lock the cart while awaiting payment. Mutators throw
// CartLockedError after this point; clearCart (called on payment
// success) is still allowed because it represents finalization.
async function lockCart(restaurantId, customerId) {
  await col(COLLECTION).updateOne(
    _key(restaurantId, customerId),
    { $set: { status: 'locked', updated_at: new Date() } }
  );
  return getCart(restaurantId, customerId);
}

// Phase 2: release a locked cart (e.g., customer cancels the order
// while in AWAIT_PAYMENT — cart returns to 'active' so they can edit).
async function unlockCart(restaurantId, customerId) {
  await col(COLLECTION).updateOne(
    _key(restaurantId, customerId),
    { $set: { status: 'active', updated_at: new Date() } }
  );
  return getCart(restaurantId, customerId);
}

async function clearCart(restaurantId, customerId) {
  await col(COLLECTION).deleteOne(_key(restaurantId, customerId));
}

module.exports = {
  COLLECTION,
  CartLockedError,
  getCart,
  hasActiveCart,
  addToCart,
  updateQuantity,
  removeFromCart,
  setAddress,
  markCheckedOut,
  lockCart,
  unlockCart,
  clearCart,
};
