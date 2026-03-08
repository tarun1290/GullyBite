// src/services/order.js
// Manages the complete order lifecycle:
// customer lookup → conversation state → cart → order creation → status updates

const { col, newId, mapId, mapIds, transaction } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const couponSvc = require('./coupon');
const { calculateOrderCharges } = require('./charges');

// ─── GET OR CREATE CUSTOMER ───────────────────────────────────
const getOrCreateCustomer = async (waPhone, profileName = null) => {
  const existing = await col('customers').findOne({ wa_phone: waPhone });
  if (existing) {
    if (profileName && existing.name !== profileName) {
      await col('customers').updateOne({ wa_phone: waPhone }, { $set: { name: profileName } });
    }
    return mapId(existing);
  }
  const now = new Date();
  const customer = {
    _id: newId(),
    wa_phone: waPhone,
    name: profileName || null,
    total_orders: 0,
    total_spent_rs: 0,
    last_order_at: null,
    created_at: now,
  };
  await col('customers').insertOne(customer);
  return mapId(customer);
};

// ─── GET OR CREATE CONVERSATION ───────────────────────────────
const getOrCreateConversation = async (customerId, waAccountId) => {
  const existing = await col('conversations').findOne({
    customer_id: customerId,
    wa_account_id: waAccountId,
    is_active: true,
  });
  if (existing) {
    await col('conversations').updateOne({ _id: existing._id }, { $set: { last_msg_at: new Date() } });
    return mapId(existing);
  }
  const now = new Date();
  const conv = {
    _id: newId(),
    customer_id: customerId,
    wa_account_id: waAccountId,
    state: 'GREETING',
    session_data: {},
    is_active: true,
    active_order_id: null,
    last_msg_at: now,
    created_at: now,
  };
  await col('conversations').insertOne(conv);
  return mapId(conv);
};

// ─── UPDATE CONVERSATION STATE ────────────────────────────────
const setState = async (convId, newState, sessionUpdates = {}) => {
  const conv = await col('conversations').findOne({ _id: convId });
  const current = conv?.session_data || {};
  const merged = { ...current, ...sessionUpdates };

  await col('conversations').updateOne(
    { _id: convId },
    { $set: { state: newState, session_data: merged, last_msg_at: new Date() } }
  );
  return merged;
};

// ─── PROCESS WHATSAPP CATALOG ORDER ──────────────────────────
const buildCartFromCatalogOrder = async (productItems, branchId) => {
  const retailerIds = productItems.map(i => i.product_retailer_id);

  const menuItems = await col('menu_items').find({
    retailer_id: { $in: retailerIds },
    branch_id: branchId,
    is_available: true,
  }).toArray();

  const itemMap = {};
  menuItems.forEach(m => { itemMap[m.retailer_id] = m; });

  const cart = [];
  const unavailable = [];

  for (const ordered of productItems) {
    const item = itemMap[ordered.product_retailer_id];
    if (!item) {
      unavailable.push(ordered.product_retailer_id);
      continue;
    }
    const qty = parseInt(ordered.quantity) || 1;
    cart.push({
      menuItemId: String(item._id),
      retailerId: item.retailer_id,
      name: item.name,
      qty,
      unitPriceRs: item.price_paise / 100,
      lineTotalRs: (item.price_paise / 100) * qty,
    });
  }

  const subtotalRs = cart.reduce((s, i) => s + i.lineTotalRs, 0);

  const branch = await col('branches').findOne({ _id: branchId });
  const restaurant = branch
    ? await col('restaurants').findOne({ _id: branch.restaurant_id })
    : null;

  const deliveryFeeRs = parseFloat(branch?.delivery_fee_rs)
                     || parseFloat(process.env.DEFAULT_DELIVERY_FEE)
                     || 40;

  const restaurantConfig = {
    delivery_fee_customer_pct: restaurant?.delivery_fee_customer_pct ?? 100,
    menu_gst_mode:             restaurant?.menu_gst_mode             ?? 'included',
    menu_gst_pct:              restaurant?.menu_gst_pct              ?? 5,
    packaging_charge_rs:       restaurant?.packaging_charge_rs       ?? 0,
    packaging_gst_pct:         restaurant?.packaging_gst_pct         ?? 18,
  };

  const charges = calculateOrderCharges(restaurantConfig, subtotalRs, deliveryFeeRs, 0);

  return { cart, subtotalRs, deliveryFeeRs: charges.customer_delivery_rs, totalRs: charges.customer_total_rs, charges, unavailable };
};

const REFERRAL_FEE_PCT = 0.075; // 7.5%

// ─── CHECK ACTIVE REFERRAL ────────────────────────────────────
const findActiveReferral = async (waPhone, restaurantId) => {
  if (!waPhone || !restaurantId) return null;
  const now = new Date();
  const referral = await col('referrals').findOne({
    restaurant_id: restaurantId,
    customer_wa_phone: waPhone,
    status: 'active',
    expires_at: { $gt: now },
  }, { sort: { created_at: -1 } });
  return referral ? mapId(referral) : null;
};

// ─── CREATE ORDER ─────────────────────────────────────────────
const createOrder = async ({ convId, customerId, branchId, cart, subtotalRs, deliveryFeeRs, totalRs, discountRs = 0, couponId = null, couponCode = null, deliveryAddress, deliveryLat, deliveryLng, waPhone, charges = null }) => {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');

  // Generate sequential order number (count today's orders)
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayCount = await col('orders').countDocuments({ created_at: { $gte: todayStart } });
  const seq = String(todayCount + 1).padStart(4, '0');
  const orderNumber = `ZM-${dateStr}-${seq}`;

  const platformFeeRs = 0;

  const branch = await col('branches').findOne({ _id: branchId });
  const restaurantId = branch?.restaurant_id;
  const referral      = await findActiveReferral(waPhone, restaurantId);
  const referralId    = referral?.id || null;
  const referralFeeRs = referral ? parseFloat((subtotalRs * REFERRAL_FEE_PCT).toFixed(2)) : 0;

  const effectiveTotal = charges ? charges.customer_total_rs : totalRs;

  const orderId = newId();
  const order = {
    _id: orderId,
    order_number: orderNumber,
    customer_id: customerId,
    branch_id: branchId,
    conversation_id: convId,
    subtotal_rs: subtotalRs,
    delivery_fee_rs: charges ? charges.customer_delivery_rs : deliveryFeeRs,
    discount_rs: discountRs,
    total_rs: effectiveTotal,
    platform_fee_rs: platformFeeRs,
    coupon_id: couponId,
    coupon_code: couponCode,
    referral_id: referralId,
    referral_fee_rs: referralFeeRs,
    delivery_address: deliveryAddress,
    delivery_lat: deliveryLat,
    delivery_lng: deliveryLng,
    food_gst_rs:                charges?.food_gst_rs                ?? 0,
    delivery_fee_total_rs:      charges?.delivery_fee_total_rs      ?? (charges ? charges.customer_delivery_rs : deliveryFeeRs),
    customer_delivery_rs:       charges?.customer_delivery_rs       ?? deliveryFeeRs,
    customer_delivery_gst_rs:   charges?.customer_delivery_gst_rs   ?? 0,
    restaurant_delivery_rs:     charges?.restaurant_delivery_rs     ?? 0,
    restaurant_delivery_gst_rs: charges?.restaurant_delivery_gst_rs ?? 0,
    packaging_rs:               charges?.packaging_rs               ?? 0,
    packaging_gst_rs:           charges?.packaging_gst_rs           ?? 0,
    status: 'PENDING_PAYMENT',
    paid_at: null,
    confirmed_at: null,
    preparing_at: null,
    packed_at: null,
    dispatched_at: null,
    delivered_at: null,
    cancelled_at: null,
    cancel_reason: null,
    created_at: now,
    updated_at: now,
  };

  await col('orders').insertOne(order);

  // Coupon usage
  if (couponId) {
    await couponSvc.incrementUsage(couponId);
  }

  // Update referral totals
  if (referralId) {
    await col('referrals').updateOne(
      { _id: referralId },
      {
        $set:  { status: 'converted', updated_at: now },
        $inc:  { orders_count: 1, total_order_value_rs: subtotalRs, referral_fee_rs: referralFeeRs },
      }
    );
  }

  // Create order items
  for (const item of cart) {
    await col('order_items').insertOne({
      _id: newId(),
      order_id: orderId,
      menu_item_id: item.menuItemId,
      item_name: item.name,
      unit_price_rs: item.unitPriceRs,
      quantity: item.qty,
      line_total_rs: item.lineTotalRs,
    });
  }

  // Link order to conversation
  await col('conversations').updateOne(
    { _id: convId },
    { $set: { active_order_id: orderId, state: 'AWAITING_PAYMENT' } }
  );

  return mapId(order);
};

// ─── UPDATE ORDER STATUS ──────────────────────────────────────
const updateStatus = async (orderId, newStatus, extra = {}) => {
  const tsField = {
    PAID:       'paid_at',
    CONFIRMED:  'confirmed_at',
    PREPARING:  'preparing_at',
    PACKED:     'packed_at',
    DISPATCHED: 'dispatched_at',
    DELIVERED:  'delivered_at',
    CANCELLED:  'cancelled_at',
  }[newStatus];

  const $set = { status: newStatus, updated_at: new Date() };
  if (tsField) $set[tsField] = new Date();
  if (extra.cancelReason) $set.cancel_reason = extra.cancelReason;

  const updated = await col('orders').findOneAndUpdate(
    { _id: orderId },
    { $set },
    { returnDocument: 'after' }
  );

  // Update customer stats on delivery
  if (newStatus === 'DELIVERED' && updated) {
    await col('customers').updateOne(
      { _id: updated.customer_id },
      {
        $inc: { total_orders: 1, total_spent_rs: parseFloat(updated.total_rs) || 0 },
        $set: { last_order_at: new Date() },
      }
    );
  }

  return updated ? mapId(updated) : null;
};

// ─── GET FULL ORDER DETAILS ───────────────────────────────────
const getOrderDetails = async (orderId) => {
  const order = await col('orders').findOne({ _id: orderId });
  if (!order) return null;

  const [customer, branch, items] = await Promise.all([
    col('customers').findOne({ _id: order.customer_id }),
    col('branches').findOne({ _id: order.branch_id }),
    col('order_items').find({ order_id: orderId }).toArray(),
  ]);

  const restaurant = branch ? await col('restaurants').findOne({ _id: branch.restaurant_id }) : null;
  const wa_acc = restaurant
    ? await col('whatsapp_accounts').findOne({ restaurant_id: String(restaurant._id), is_active: true })
    : null;

  return {
    ...mapId(order),
    wa_phone:        customer?.wa_phone,
    customer_name:   customer?.name,
    branch_name:     branch?.name,
    branch_address:  branch?.address,
    business_name:   restaurant?.business_name,
    phone_number_id: wa_acc?.phone_number_id,
    access_token:    wa_acc?.access_token,
    items:           mapIds(items),
  };
};

module.exports = {
  getOrCreateCustomer,
  getOrCreateConversation,
  setState,
  buildCartFromCatalogOrder,
  createOrder,
  updateStatus,
  getOrderDetails,
};
