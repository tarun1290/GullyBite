// src/services/order.js
// Manages the complete order lifecycle:
// customer lookup → conversation state → cart → order creation → status updates

const { col, newId, mapId, mapIds, transaction } = require('../config/database');
const couponSvc = require('./coupon');
const { calculateOrderCharges } = require('./charges');
const { calculateDynamicDeliveryFee } = require('./dynamicPricing');
const log = require('../utils/logger').child({ component: 'Order' });
const Brand = require('../models/Brand');

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
// CRIT-2A-04: `loyaltyTier` is threaded through so the delivery-fee
// waiver applies at cart-preview time (same value the customer sees on
// the confirmation screen). Null/unknown tiers fall through to the
// existing paid-delivery math.
const buildCartFromCatalogOrder = async (productItems, branchId, deliveryLat = null, deliveryLng = null, orderDetails = {}, loyaltyTier = null) => {
  const retailerIds = productItems.map(i => i.product_retailer_id);

  // Branch-first: match items by either the legacy scalar OR the new
  // branch_ids[] membership so post-migration products are picked up
  // without breaking pre-migration rows.
  const menuItems = await col('menu_items').find({
    retailer_id: { $in: retailerIds },
    is_available: true,
    $or: [{ branch_id: branchId }, { branch_ids: branchId }],
  }).toArray();

  // Apply branch-first guard: drop unassigned products / inactive branch /
  // missing FSSAI. These would have failed silently as "unavailable"
  // anyway, but the structured reason lets us surface a clear message.
  const branchGuard = require('../middleware/branchGuard');
  const branchSvc   = require('./branch.service');
  const guardBranch = await branchSvc.getBranch(branchId);
  const guardSkips  = [];

  const itemMap = {};
  menuItems.forEach(m => {
    const check = branchGuard.checkProductForBranch(m, guardBranch);
    if (check.ok) itemMap[m.retailer_id] = m;
    else guardSkips.push({ retailer_id: m.retailer_id, reason: check.reason });
  });

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

  const charges = calculateOrderCharges(restaurantConfig, subtotalRs, deliveryFeeRs, 0, loyaltyTier);

  return {
    cart, subtotalRs,
    deliveryFeeRs: charges.customer_delivery_rs,
    totalRs: charges.customer_total_rs,
    charges, unavailable,
    branch_guard_skips: guardSkips, // surfaced for logging / WA messaging
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
// [IDEMPOTENCY] Accepts an optional `idempotencyKey` parameter. When passed,
// the entire order-creation body is wrapped in withIdempotency() so a double-
// click on the Pay button (or a webhook retry, or a stuck client retry)
// returns the SAME order — same _id, same order_number — instead of creating
// a duplicate.
//
// Callers should compute the key via `withIdempotency.keys.order(customerId,
// branchId, cart)` which fingerprints the cart contents. The key is stable
// for as long as the cart contents are the same; if the user adds/removes
// items, the fingerprint changes and a fresh order is allowed.
//
// If no idempotencyKey is passed, behaviour is unchanged (legacy callers
// continue to work — no migration required).
const createOrder = async (params) => {
  // Per-user order rate limit — ADAPTIVE based on trust tier:
  //   low:    1/60s    medium: 2/60s    high: 5/60s
  // Centralised here so every entry point (WA text, WA buttons, dashboard
  // manual order) is covered without call-site bookkeeping. Idempotency-
  // replayed orders don't hit this because the idemKey cache returns
  // before _createOrderImpl runs.
  if (params && params.customerId) {
    const { adaptiveRateLimit, RateLimitExceededError } = require('../middleware/rateLimit');
    try {
      await adaptiveRateLimit('order', String(params.customerId));
    } catch (err) {
      if (err instanceof RateLimitExceededError) {
        log.warn({ customerId: params.customerId, retryAfterMs: err.retryAfterMs }, 'Order rate limit hit');
        throw err;
      }
      throw err;
    }
  }
  if (params && params.idempotencyKey) {
    const { withIdempotency, keys: idemKeys } = require('../utils/withIdempotency');
    return withIdempotency(
      params.idempotencyKey,
      'order',
      () => _createOrderImpl(params),
      { referenceId: params.customerId || null }
    );
  }
  return _createOrderImpl(params);
};

const _createOrderImpl = async ({ convId, customerId, branchId, cart, subtotalRs, deliveryFeeRs, totalRs, discountRs = 0, couponId = null, couponCode = null, deliveryAddress, deliveryLat, deliveryLng, waPhone, charges = null, deliveryFeeBreakdown = null, deliveryQuote = null, structuredAddress = null, addressSource = null, receiverName = null, receiverPhone = null, deliveryInstructions = null, brandId = null, phoneNumberId = null, businessId = null, proroutingEstimatePrice = null, proroutingQuoteId = null, customerDeliveryFee = null, totalDeliveryFee = null, needsManualDispatch = false }) => {
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

  // ─── BRAND RESOLUTION (additive, non-blocking) ─────────────
  // Priority: explicit brandId from caller → infer via phoneNumberId
  // from the message/webhook context (req.brand_id equivalent) →
  // leave null (legacy single-brand path). Any failure falls through
  // to null so the existing order flow continues working identically
  // for non-brand-aware callers.
  let resolvedBrandId = brandId || null;
  let resolvedBusinessId = businessId || null;
  try {
    if (!resolvedBrandId && phoneNumberId) {
      const brand = await Brand.findByPhoneNumberId(phoneNumberId);
      if (brand) {
        resolvedBrandId = brand._id;
        resolvedBusinessId = resolvedBusinessId || brand.business_id || null;
      }
    } else if (resolvedBrandId && !resolvedBusinessId) {
      const brand = await Brand.findById(resolvedBrandId);
      if (brand) resolvedBusinessId = brand.business_id || null;
    }
  } catch (err) {
    log.warn({ err, brandId: resolvedBrandId, phoneNumberId }, 'Brand resolution failed on order create — continuing without brand');
  }
  log.info({ orderBrandId: resolvedBrandId, businessId: resolvedBusinessId, phoneNumberId, routing: resolvedBrandId ? 'brand' : 'default' }, 'Order brand routing resolved');

  const referral      = await findActiveReferral(waPhone, restaurantId);
  const referralId    = referral?.id || null;
  const referralFeeRs = referral ? calculateReferralCommission(subtotalRs).commission_amount : 0;

  const effectiveTotal = charges ? charges.customer_total_rs : totalRs;

  // ─── CAMPAIGN ATTRIBUTION ─────────────────────────────────
  // Best-effort look-up of the most recent campaign send to this phone
  // within the attribution window. Sets attributed_campaign_id on the
  // order so ROI analytics can join orders → campaigns without scanning.
  // Failure is silent — attribution must never block checkout.
  let attributedCampaignId = null;
  let attributedMessageId = null;
  try {
    const { findAttribution } = require('./campaignAttribution');
    const attr = await findAttribution({ restaurantId, waPhone });
    if (attr) {
      attributedCampaignId = attr.campaign_id;
      attributedMessageId = attr.message_id;
    }
  } catch (err) {
    log.warn({ err, waPhone: !!waPhone }, 'campaign attribution lookup failed');
  }

  // Phase 6: identity-layer key, denormalized onto the order so
  // customer_metrics aggregates don't need to join customers.
  let orderPhoneHash = null;
  try {
    orderPhoneHash = require('../utils/phoneHash').hashPhone(waPhone);
  } catch (err) {
    log.warn({ err }, 'phone_hash compute failed');
  }

  const orderId = newId();
  const order = {
    _id: orderId,
    order_number: orderNumber,
    restaurant_id: restaurantId || null,
    phone_hash: orderPhoneHash,
    attributed_campaign_id: attributedCampaignId,
    attributed_message_id: attributedMessageId,
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
    // Prorouting (3PL) integration. These fields are populated only when
    // the checkout handler called /estimate successfully. When they are
    // null the order falls back to the flat/dynamic delivery fee path and
    // no 3PL dispatch is attempted. `needs_manual_dispatch` is flipped on
    // when /estimate OR /createasync fails so ops can reroute.
    prorouting_estimate_price:  proroutingEstimatePrice,
    prorouting_quote_id:        proroutingQuoteId,
    prorouting_order_id:        null,
    prorouting_status:          null,
    customer_delivery_fee:      customerDeliveryFee,
    total_delivery_fee:         totalDeliveryFee,
    needs_manual_dispatch:      !!needsManualDispatch,
    // Optional brand mapping — null preserves legacy single-brand behavior.
    brand_id: resolvedBrandId,
    business_id: resolvedBusinessId,
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

  // ─── TRANSACTIONAL WRITE ───────────────────────────────────
  // orders + order_items + deliveries + conversation update (+ coupon
  // and referral side-effects when applicable) must all commit together.
  // A crash mid-write without a transaction used to leave orphan
  // order_items rows pointing at a non-existent order, or a delivery row
  // with no matching order. With the wrapper below, the cluster rolls
  // back everything on any failure. Coupon redemption is intentionally
  // included so a double-submit can't "spend" the coupon without
  // producing an order.
  //
  // Runs without a session on standalone Mongo (local dev) — see
  // withTransaction.js for the fallback rationale.
  const { withTransaction } = require('../utils/withTransaction');
  await withTransaction(async (session) => {
    const sOpt = session ? { session } : {};

    await col('orders').insertOne(order, sOpt);

    if (couponId) {
      await couponSvc.incrementUsage(couponId, session);
      await couponSvc.recordRedemption(couponId, customerId, String(order._id), session);
    }

    if (referralId) {
      await col('referrals').updateOne(
        { _id: referralId },
        {
          $set:  { status: 'converted', updated_at: now },
          $inc:  { orders_count: 1, total_order_value_rs: subtotalRs, referral_fee_rs: referralFeeRs },
        },
        sOpt
      );
    }

    if (cart.length) {
      await col('order_items').insertMany(cart.map(item => ({
        _id: newId(),
        order_id: orderId,
        menu_item_id: item.menuItemId,
        item_name: item.name,
        unit_price_rs: item.unitPriceRs,
        quantity: item.qty,
        line_total_rs: item.lineTotalRs,
      })), sOpt);
    }

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
    }, sOpt);

    await col('conversations').updateOne(
      { _id: convId },
      { $set: { active_order_id: orderId, state: 'AWAITING_PAYMENT' } },
      sOpt
    );
  }, { label: `createOrder:${orderId}` });

  // Phase 6: identity-layer update. Fire-and-forget — must NOT block
  // order creation. The service swallows its own errors into the log.
  setImmediate(() => {
    require('./customerIdentityLayer').recordOrderCreated({
      waPhone,
      customerId,
      restaurantId,
      totalRs: effectiveTotal,
    }).catch(() => {});
  });

  // Trust score: +5 for reaching the created-order milestone. Placed
  // here (not at delivery) because a successfully composed + accepted
  // order is already a positive signal; delivery-stage refunds/cancels
  // are tracked via separate events if we add them later.
  if (customerId) {
    require('./trustScore').recordEvent(String(customerId), 'order_success').catch(() => {});
  }

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
    // Phase 4: replaced setTimeout with a durable SETTLEMENT_TRIGGER job.
    // Idempotent — payoutEngine.createSettlementForOrder has a unique
    // (order_id) constraint, so retries are safe.
    try {
      const { enqueue, JOB_TYPES } = require('../queue/postPaymentJobs');
      await enqueue(JOB_TYPES.SETTLEMENT_TRIGGER, { orderId: String(orderId) });
    } catch (e) { log.error({ err: e, orderId }, 'settlement job enqueue failed'); }

    // ─── LOYALTY AWARD + RATING REQUEST ──────────────────────
    // Phase 4: replaced setTimeout with a LOYALTY_AWARD job scheduled
    // 30 min out. Gives the customer time to finish the meal before
    // the rating ask lands.
    //
    // CRIT-2A-01 defense-in-depth: also stamp rating_request_due so the
    // /cron/rating-requests reconciliation sweep can catch orders whose
    // job was dropped. The cron skips any order where rating_requested_at
    // is already set, so the job firing first is always safe.
    const ratingDelayMs = 30 * 60 * 1000;
    try {
      const { enqueue, JOB_TYPES } = require('../queue/postPaymentJobs');
      await enqueue(
        JOB_TYPES.LOYALTY_AWARD,
        { orderId: String(orderId) },
        { delayMs: ratingDelayMs }
      );
    } catch (e) { log.error({ err: e, orderId }, 'loyalty job enqueue failed'); }
    try {
      await col('orders').updateOne(
        { _id: orderId, rating_request_due: { $exists: false } },
        { $set: { rating_request_due: new Date(Date.now() + ratingDelayMs) } },
      );
    } catch (e) { log.warn({ err: e, orderId }, 'rating_request_due stamp failed'); }
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
