// src/services/order.js
// Manages the complete order lifecycle:
// customer lookup → conversation state → cart → order creation → status updates

const { col, newId, mapId, mapIds, transaction } = require('../config/database');
const couponSvc = require('./coupon');
const { calculateOrderCharges } = require('./charges');
const { calculateDynamicDeliveryFee } = require('./dynamicPricing');
const log = require('../utils/logger').child({ component: 'Order' });

// ─── GET OR CREATE CUSTOMER ───────────────────────────────────
// [BSUID] Delegates to customerIdentity.js for universal identity resolution
// Backward-compatible: accepts (waPhone, name) OR ({ bsuid, wa_phone, profile_name })
const customerIdentity = require('./customerIdentity');

const getOrCreateCustomer = async (waPhoneOrIdentifiers, profileName = null) => {
  // Support both old signature (phone, name) and new ({ bsuid, wa_phone, profile_name })
  if (typeof waPhoneOrIdentifiers === 'object' && waPhoneOrIdentifiers !== null) {
    return customerIdentity.getOrCreateCustomer(waPhoneOrIdentifiers);
  }
  // Legacy: plain phone string
  return customerIdentity.getOrCreateCustomer({
    wa_phone: waPhoneOrIdentifiers,
    profile_name: profileName,
  });
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
// deliveryLat/deliveryLng trigger 3PL quote for real delivery pricing
// orderDetails: { deliveryAddress, customerName, customerPhone } for 3PL API
const buildCartFromCatalogOrder = async (productItems, branchId, deliveryLat = null, deliveryLng = null, orderDetails = {}) => {
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

  const { getBranch, getRestaurant } = require('../utils/cachedLookup');
  const branch = await getBranch(branchId);
  const restaurant = branch ? await getRestaurant(branch.restaurant_id) : null;

  // 3PL delivery quote — gets real pricing from delivery partner
  const { guard } = require('../utils/smartModule');
  const defaultFee = parseFloat(process.env.DEFAULT_DELIVERY_FEE) || 40;
  const dynamicResult = await guard('DYNAMIC_PRICING', {
    fn: () => calculateDynamicDeliveryFee(branchId, deliveryLat, deliveryLng, orderDetails),
    fallback: { deliveryFeeRs: defaultFee, dynamic: false, breakdown: { totalFeeRs: defaultFee } },
    label: 'calculateDynamicDeliveryFee',
    context: { branchId },
  });
  const deliveryFeeRs = dynamicResult.deliveryFeeRs;

  const restaurantConfig = {
    delivery_fee_customer_pct: restaurant?.delivery_fee_customer_pct ?? 100,
    menu_gst_mode:             restaurant?.menu_gst_mode             ?? 'included',
    menu_gst_pct:              restaurant?.menu_gst_pct              ?? 5,
    packaging_charge_rs:       restaurant?.packaging_charge_rs       ?? 0,
    packaging_gst_pct:         restaurant?.packaging_gst_pct         ?? 18,
  };

  const charges = calculateOrderCharges(restaurantConfig, subtotalRs, deliveryFeeRs, 0);

  return {
    cart, subtotalRs,
    deliveryFeeRs: charges.customer_delivery_rs,
    totalRs: charges.customer_total_rs,
    charges, unavailable,
    deliveryFeeBreakdown: dynamicResult.breakdown,
    dynamicPricing: dynamicResult.dynamic,
    // 3PL quote data for session storage → used at dispatch time
    deliveryQuote: dynamicResult.dynamic ? {
      providerName:  dynamicResult.breakdown.providerName,
      providerFeeRs: dynamicResult.breakdown.baseFeeRs,
      quoteId:       dynamicResult.breakdown.quoteId,
      estimatedMins: dynamicResult.breakdown.estimatedMins,
      distanceKm:    dynamicResult.breakdown.distanceKm,
    } : null,
  };
};

// Referral commission calculated via centralized financial engine
const { calculateReferralCommission } = require('../core/financialEngine');

// ─── CHECK ACTIVE REFERRAL ────────────────────────────────────
// [BSUID] Accept phone or BSUID identifier for referral lookup
const findActiveReferral = async (identifier, restaurantId) => {
  if (!identifier || !restaurantId) return null;
  const now = new Date();
  // Try phone first, then BSUID
  const referral = await col('referrals').findOne({
    restaurant_id: restaurantId,
    $or: [{ customer_wa_phone: identifier }, { customer_bsuid: identifier }],
    status: 'active',
    expires_at: { $gt: now },
  }, { sort: { created_at: -1 } });
  return referral ? mapId(referral) : null;
};

// ─── CREATE ORDER ─────────────────────────────────────────────
const createOrder = async ({ convId, customerId, branchId, cart, subtotalRs, deliveryFeeRs, totalRs, discountRs = 0, couponId = null, couponCode = null, deliveryAddress, deliveryLat, deliveryLng, waPhone, charges = null, deliveryFeeBreakdown = null, deliveryQuote = null, structuredAddress = null, addressSource = null, receiverName = null, receiverPhone = null, deliveryInstructions = null }) => {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');

  // Generate sequential order number (count today's orders)
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayCount = await col('orders').countDocuments({ created_at: { $gte: todayStart } });
  const seq = String(todayCount + 1).padStart(4, '0');
  const orderNumber = `ZM-${dateStr}-${seq}`;

  const platformFeeRs = 0;

  const { getBranch } = require('../utils/cachedLookup');
  const branch = await getBranch(branchId);
  const restaurantId = branch?.restaurant_id;
  const referral      = await findActiveReferral(waPhone, restaurantId);
  const referralId    = referral?.id || null;
  const referralFeeRs = referral ? calculateReferralCommission(subtotalRs).commission_amount : 0;

  const effectiveTotal = charges ? charges.customer_total_rs : totalRs;

  const orderId = newId();
  const order = {
    _id: orderId,
    order_number: orderNumber,
    restaurant_id: restaurantId || null,
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
    structured_address: structuredAddress || null,  // [WhatsApp2026] Native address form fields
    address_source: addressSource || 'gps',         // gps | address_form | saved
    receiver_name: receiverName || null,
    receiver_phone: receiverPhone || null,
    delivery_instructions: deliveryInstructions || null,
    food_gst_rs:                charges?.food_gst_rs                ?? 0,
    delivery_fee_total_rs:      charges?.delivery_fee_total_rs      ?? (charges ? charges.customer_delivery_rs : deliveryFeeRs),
    customer_delivery_rs:       charges?.customer_delivery_rs       ?? deliveryFeeRs,
    customer_delivery_gst_rs:   charges?.customer_delivery_gst_rs   ?? 0,
    restaurant_delivery_rs:     charges?.restaurant_delivery_rs     ?? 0,
    restaurant_delivery_gst_rs: charges?.restaurant_delivery_gst_rs ?? 0,
    packaging_rs:               charges?.packaging_rs               ?? 0,
    packaging_gst_rs:           charges?.packaging_gst_rs           ?? 0,
    delivery_fee_breakdown:     deliveryFeeBreakdown                || null,
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

  // Coupon usage tracking
  if (couponId) {
    await couponSvc.incrementUsage(couponId);
    await couponSvc.recordRedemption(couponId, customerId, String(order._id));
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

  // Create order items (bulk insert instead of loop)
  if (cart.length) {
    await col('order_items').insertMany(cart.map(item => ({
      _id: newId(),
      order_id: orderId,
      menu_item_id: item.menuItemId,
      item_name: item.name,
      unit_price_rs: item.unitPriceRs,
      quantity: item.qty,
      line_total_rs: item.lineTotalRs,
    })));
  }

  // Create delivery record (pending dispatch until payment confirmed)
  await col('deliveries').insertOne({
    _id: newId(),
    order_id: orderId,
    provider: deliveryQuote?.providerName || process.env.DEFAULT_DELIVERY_PROVIDER || 'porter',
    provider_order_id: null,
    tracking_url: null,
    driver_name: null,
    driver_phone: null,
    driver_lat: null,
    driver_lng: null,
    status: 'pending',
    estimated_mins: deliveryQuote?.estimatedMins || null,
    cost_rs: deliveryQuote?.providerFeeRs || 0,
    quote_id: deliveryQuote?.quoteId || null,
    picked_up_at: null,
    delivered_at: null,
    created_at: now,
    updated_at: now,
  });

  // Link order to conversation
  await col('conversations').updateOne(
    { _id: convId },
    { $set: { active_order_id: orderId, state: 'AWAITING_PAYMENT' } }
  );

  return mapId(order);
};

// ─── UPDATE ORDER STATUS ──────────────────────────────────────
const updateStatus = async (orderId, newStatus, extra = {}) => {
  // Route through the strict state engine — validates transitions, prevents races, logs audit
  const { transitionOrder } = require('../core/orderStateEngine');
  const updated = await transitionOrder(orderId, newStatus, {
    actor: extra.actor || 'system',
    actorType: extra.actorType || 'system',
    cancelReason: extra.cancelReason,
  });

  // Reverse referral commission on cancellation
  if (newStatus === 'CANCELLED' && updated?.referral_id) {
    const { guard: guardRef } = require('../utils/smartModule');
    await guardRef('REFERRAL_ATTRIBUTION', {
      fn: () => {
        const refAttr = require('./referralAttribution');
        return refAttr.reverseCommission(orderId, extra.cancelReason || 'order_cancelled');
      },
      fallback: undefined,
      label: 'reverseCommission',
      context: { orderId },
    });
  }

  // Update customer stats on delivery
  if (newStatus === 'DELIVERED' && updated) {
    await col('customers').updateOne(
      { _id: updated.customer_id },
      {
        $inc: { total_orders: 1, total_spent_rs: parseFloat(updated.total_rs) || 0 },
        $set: { last_order_at: new Date() },
      }
    );

    // ─── PER-ORDER SETTLEMENT TRIGGER (v2) ───────────────────
    // Create a per-order settlement record. Idempotent — unique constraint on order_id.
    // Fire-and-forget to avoid blocking the delivery flow. Failures are logged.
    setTimeout(async () => {
      try {
        const payoutEngine = require('./payoutEngine');
        const settlement = await payoutEngine.createSettlementForOrder(orderId);
        if (settlement && settlement.status === 'eligible') {
          // Auto-process payout if enabled
          if (process.env.AUTO_PAYOUT_ON_DELIVERY === 'true') {
            await payoutEngine.processSettlement(String(settlement._id));
          }
        }
      } catch (e) {
        log.error({ err: e, orderId }, 'Per-order settlement creation failed');
      }
    }, 100);

    // Award loyalty points + send notification
    setTimeout(async () => {
      try {
        const customer = await col('customers').findOne({ _id: updated.customer_id });
        const waAcc    = await col('whatsapp_accounts').findOne({ restaurant_id: updated.restaurant_id, is_active: true });
        const metaConfig = require('../config/meta');
        const waToken = metaConfig.systemUserToken || waAcc?.access_token;
        // [BSUID] Use resolveRecipient — phone preferred, BSUID fallback
        const { resolveRecipient } = require('./customerIdentity');
        const toId = customer ? (customer.wa_phone || customer.bsuid) : null;
        if (toId && waAcc?.phone_number_id && waToken) {
          // Loyalty points
          try {
            const loyalty = require('./loyalty');
            const reward = await loyalty.earnPoints(updated.customer_id, updated.restaurant_id, orderId, updated.total_rs);
            if (reward.pointsEarned > 0) {
              const wa = require('./whatsapp');
              let msg = `🎉 You earned *${reward.pointsEarned} loyalty points*!\n💰 Balance: ${reward.newBalance} points\n🏅 Tier: ${reward.newTier.charAt(0).toUpperCase() + reward.newTier.slice(1)}\n\nRedeem points on your next order!`;
              if (reward.tierUpgraded) {
                msg = `🎊 *Congratulations!* You've been upgraded to *${reward.newTier.charAt(0).toUpperCase() + reward.newTier.slice(1)}*!\n\n` + msg;
              }
              await wa.sendText(waAcc.phone_number_id, waToken, toId, msg);
            }
          } catch (e) { log.error({ err: e }, 'Loyalty earn error'); }

          // Rating request (after loyalty msg)
          const { sendRatingRequest } = require('../webhooks/whatsapp');
          await sendRatingRequest(orderId, waAcc.phone_number_id, waToken, toId);
        }
      } catch (e) { log.error({ err: e }, 'Rating delayed send error'); }
    }, 30 * 60 * 1000); // 30 minutes after delivery — gives customer time to eat
  }

  // Fire-and-forget POS status sync
  if (updated && updated.pos_platform && updated.pos_external_id) {
    syncPOSStatus(updated).catch(() => {});
  }

  return updated ? mapId(updated) : null;
};

async function syncPOSStatus(order) {
  const integration = await col('restaurant_integrations').findOne({
    restaurant_id: order.restaurant_id,
    platform: order.pos_platform,
    is_active: true,
  });
  if (!integration) return;
  const svc = require(`./integrations/${order.pos_platform}`);
  if (svc.updateOrderStatus) {
    await svc.updateOrderStatus(integration, order.pos_external_id, order.status);
  }
}

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
    bsuid:           customer?.bsuid,
    identifier_type: customer?.identifier_type,
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
