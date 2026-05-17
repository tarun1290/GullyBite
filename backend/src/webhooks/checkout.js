// src/webhooks/checkout.js
// WhatsApp Checkout webhook handler
// Handles: shipping callback, coupon validation, order creation
// WhatsApp sends encrypted payloads — we decrypt and process

'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { col, newId } = require('../config/database');
const { decryptCheckoutPayload, verifyCheckoutSignature } = require('../services/checkout-crypto');
const { calculateOrderCharges } = require('../services/charges');
const orderSvc = require('../services/order');
const couponSvc = require('../services/coupon');
const customerIdentity = require('../services/customerIdentity');
const { isBsuid } = customerIdentity;
const { hashPhone } = require('../utils/phoneHash');
const log = require('../utils/logger').child({ component: 'checkout' });

// ─── WEBHOOK VERIFICATION ───────────────────────────────────────
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  // Constant-time verify-token comparison. Mirrors the canonical
  // POST X-Hub-Signature-256 idiom used across these webhook files
  // (webhooks/catalog.js:47-50): Buffer.from() both sides →
  // Buffer.byteLength length guard → crypto.timingSafeEqual (throws
  // on unequal length, so the guard runs first). The POST handler
  // here delegates signature verification to verifyCheckoutSignature
  // (services/checkout-crypto.js), so the catalog.js webhook idiom is
  // the in-repo reference. Fail closed: unset/empty expected token,
  // missing provided token, or any mismatch → 403, never echo
  // hub.challenge.
  const expectedVerifyToken = process.env.WA_CHECKOUT_VERIFY_TOKEN;
  if (!expectedVerifyToken || !token) {
    return res.sendStatus(403);
  }
  const provBuf = Buffer.from(token);
  const expBuf  = Buffer.from(expectedVerifyToken);
  // timingSafeEqual throws on unequal-length buffers — guard first
  const tokenOk =
    Buffer.byteLength(token) === Buffer.byteLength(expectedVerifyToken) &&
    crypto.timingSafeEqual(provBuf, expBuf);
  if (mode === 'subscribe' && tokenOk) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── INCOMING CHECKOUT EVENTS ───────────────────────────────────
router.post('/', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  try {
    // ─── MANDATORY SIGNATURE VERIFICATION (fail-closed) ──────────
    // Both the x-hub-signature-256 header AND the webhook secret are
    // REQUIRED. We NEVER parse or process an unsigned/unverifiable
    // payload — a spoofed "paid" checkout event must not be able to
    // mint fake paid orders or ledger credits. Order is strict:
    // header present → secret configured → signature valid → only
    // then JSON.parse + process. Each failure path returns exactly
    // one response and stops.
    const sig = req.headers['x-hub-signature-256']?.replace('sha256=', '');

    // 1. No signature header → reject before any parsing.
    if (!sig) {
      req.log.warn('Rejected checkout webhook: missing x-hub-signature-256 header');
      return res.sendStatus(401);
    }

    // 2. Secret not configured → server misconfiguration. Fail closed
    //    (500) rather than silently accepting unverifiable webhooks.
    if (!process.env.WA_CHECKOUT_WEBHOOK_SECRET) {
      req.log.error('FATAL: WA_CHECKOUT_WEBHOOK_SECRET not configured — rejecting checkout webhook');
      return res.sendStatus(500);
    }

    // 3. Verify the HMAC-SHA256 signature over the raw body.
    //    verifyCheckoutSignature (services/checkout-crypto.js) already
    //    uses crypto.timingSafeEqual internally, so the comparison is
    //    constant-time — we do NOT duplicate that here. timingSafeEqual
    //    throws a RangeError when the two buffers differ in length
    //    (an attacker-supplied signature can be any length), so the
    //    call is wrapped: any throw is treated as a verification
    //    failure (fail closed), never a fall-through to processing.
    let sigValid = false;
    try {
      sigValid = verifyCheckoutSignature(req.body, sig);
    } catch (verifyErr) {
      req.log.warn({ err: verifyErr }, 'Checkout signature verification errored — treating as invalid');
      sigValid = false;
    }
    // 4. Signature mismatch → reject. Never process.
    if (!sigValid) {
      req.log.error('Invalid signature');
      return res.sendStatus(401);
    }

    const event = JSON.parse(req.body);
    const entry = event?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value) return res.sendStatus(200);

    const eventType = value.event || value.type;

    switch (eventType) {
      case 'shipping':
        return await handleShipping(value, res);
      case 'coupon': {
        // Coupon validation — routes through services/coupon.js so
        // per_user_limit, first_order_only, and branch_ids checks all
        // fire. An earlier in-file duplicate covered only a subset.
        try {
          const data = value.encrypted_payload
            ? decryptCheckoutPayload(value)
            : value;
          const code = (data.coupon_code || '').toUpperCase().trim();
          const subtotalRs = (data.order_subtotal?.amount || 0) / 100;
          const waAccount = await col('whatsapp_accounts').findOne({ catalog_id: data.catalog_id });
          if (!waAccount) return res.json({ valid: false, error: 'Store not found' });

          const restaurantId = waAccount.restaurant_id;
          const customerPhone = data.customer_phone || data.phone;
          const branches = await col('branches').find({ restaurant_id: restaurantId }).toArray();
          const branchId = branches[0] ? String(branches[0]._id) : null;
          const customer = customerPhone
            ? await customerIdentity.getOrCreateCustomer({ wa_phone: customerPhone })
            : null;
          const isFirstOrder = customer?.id
            ? await couponSvc.isCustomerFirstOrder(customer.id, restaurantId).catch(() => false)
            : true;
          const result = await couponSvc.validateCoupon(code, restaurantId, subtotalRs, {
            customerId: customer?.id || null,
            branchId,
            isFirstOrder,
          });
          if (!result.valid) {
            return res.json({ valid: false, error: result.message || 'Invalid coupon' });
          }
          const c = result.coupon;
          const description = c?.description || (c?.discount_type === 'percent'
            ? `${c.discount_value}% off`
            : c?.discount_type === 'free_delivery'
              ? 'Free delivery'
              : `₹${c?.discount_value || 0} off`);
          return res.json({
            valid: true,
            discount: {
              amount: Math.round((result.discountRs || 0) * 100),
              currency: 'INR',
              description,
            },
          });
        } catch (err) {
          log.error({ err }, 'Coupon error');
          return res.json({ valid: false, error: 'Could not validate coupon' });
        }
      }
      case 'order':
        res.sendStatus(200); // Respond immediately
        await handleOrder(value).catch(err =>
          log.error({ err }, 'Order processing failed')
        );
        return;
      default:
        req.log.info({ eventType }, 'Unknown event type');
        return res.sendStatus(200);
    }
  } catch (err) {
    req.log.error({ err }, 'Webhook error');
    res.sendStatus(500);
  }
});

// ─── SHIPPING CALLBACK ─────────────────────────────────────────
// WhatsApp asks: "What are the shipping options for this address?"
// We respond with available delivery options and fees
async function handleShipping(value, res) {
  try {
    const data = value.encrypted_payload
      ? decryptCheckoutPayload(value)
      : value;

    const catalogId = data.catalog_id;
    const address = data.shipping_address;

    // Find restaurant by catalog
    const waAccount = await col('whatsapp_accounts').findOne({ catalog_id: catalogId });
    if (!waAccount) return res.json({ shipping_options: [] });

    const restaurant = await col('restaurants').findOne({ _id: waAccount.restaurant_id });
    if (!restaurant) return res.json({ shipping_options: [] });

    // Calculate delivery fee
    const { guard } = require('../utils/smartModule');
    const defaultFee = parseFloat(process.env.DEFAULT_DELIVERY_FEE) || 40;
    let deliveryFeeRs = 0;
    const branches = await col('branches').find({ restaurant_id: waAccount.restaurant_id }).toArray();
    if (branches[0] && address?.latitude && address?.longitude) {
      const { calculateDynamicDeliveryFee } = require('../services/dynamicPricing');
      const quote = await guard('DYNAMIC_PRICING', {
        fn: () => calculateDynamicDeliveryFee(
          String(branches[0]._id),
          parseFloat(address.latitude),
          parseFloat(address.longitude),
          { customerName: address.name, customerPhone: data.customer_phone }
        ),
        fallback: { deliveryFeeRs: defaultFee },
        label: 'checkoutDeliveryQuote',
        context: { branchId: String(branches[0]._id) },
      });
      deliveryFeeRs = quote.deliveryFeeRs || 0;
    }

    const deliveryFeePaise = Math.round(deliveryFeeRs * 100);

    res.json({
      shipping_options: [
        {
          id: 'standard',
          title: 'Standard Delivery',
          description: deliveryFeeRs > 0 ? `Delivery to your address (₹${deliveryFeeRs.toFixed(0)})` : 'Free delivery',
          price: { amount: deliveryFeePaise, currency: 'INR' },
        },
        ...(restaurant.pickup_enabled ? [{
          id: 'pickup',
          title: 'Self Pickup',
          description: 'Pick up from the restaurant',
          price: { amount: 0, currency: 'INR' },
        }] : []),
      ],
    });
  } catch (err) {
    log.error({ err }, 'Shipping error');
    res.json({ shipping_options: [] });
  }
}

// ─── ORDER CREATION ─────────────────────────────────────────────
// WhatsApp sends the final confirmed order — we create it in our system
async function handleOrder(value) {
  const data = value.encrypted_payload
    ? decryptCheckoutPayload(value)
    : value;

  // Idempotency: prevent duplicate order creation from Meta retries.
  // Key = catalog + customer + sorted item fingerprint (same cart = same key).
  const { once } = require('../utils/idempotency');
  const itemFingerprint = (data.product_items || data.items || [])
    .map(i => `${i.product_retailer_id || i.retailer_id}:${i.quantity || 1}`)
    .sort()
    .join('|');
  const checkoutKey = `${data.catalog_id}:${data.customer_phone || data.phone || 'anon'}:${itemFingerprint}`;
  const isNew = await once('checkout_order', checkoutKey, { catalogId: data.catalog_id });
  if (!isNew) {
    log.info({ checkoutKey }, 'Duplicate checkout order — skipping');
    return;
  }

  const catalogId = data.catalog_id;
  const waAccount = await col('whatsapp_accounts').findOne({ catalog_id: catalogId });
  if (!waAccount) throw new Error('Store not found for catalog');

  const restaurant = await col('restaurants').findOne({ _id: waAccount.restaurant_id });
  if (!restaurant) throw new Error('Restaurant not found');

  const branches = await col('branches').find({ restaurant_id: waAccount.restaurant_id }).toArray();
  const branch = branches[0];
  if (!branch) throw new Error('No branch found');

  const branchId = String(branch._id);

  // Parse items from checkout
  const productItems = (data.product_items || data.items || []).map(item => ({
    product_retailer_id: item.product_retailer_id || item.retailer_id,
    quantity: parseInt(item.quantity) || 1,
  }));

  // Resolve menu items
  const retailerIds = productItems.map(p => p.product_retailer_id);
  const menuItems = await col('menu_items').find({
    branch_id: branchId,
    retailer_id: { $in: retailerIds },
  }).toArray();

  const menuByRetailerId = {};
  menuItems.forEach(m => { menuByRetailerId[m.retailer_id] = m; });

  // Re-check stock at checkout time. Meta catalog can lag MongoDB by 5–30 min,
  // so an MPM that included an item which has since been marked unavailable
  // can still arrive here. Reject with the item name(s) so the customer sees
  // a useful message; abort before any order is written.
  const unavailable = [];
  for (const pi of productItems) {
    const menu = menuByRetailerId[pi.product_retailer_id];
    if (!menu) {
      unavailable.push({ product_retailer_id: pi.product_retailer_id, item_name: null, reason: 'not_in_menu' });
    } else if (menu.is_available === false) {
      unavailable.push({ product_retailer_id: menu.retailer_id, item_name: menu.name, reason: 'out_of_stock' });
    }
  }
  if (unavailable.length > 0) {
    log.warn({
      catalog_id: catalogId,
      customer_phone: data.customer_phone || data.phone,
      unavailable,
    }, 'checkout rejected: items unavailable');
    const names = unavailable.map(u => u.item_name).filter(Boolean).join(', ') || 'one or more items';
    throw new Error(`Sorry, ${names} is out of stock. Please refresh your cart.`);
  }

  const orderItems = [];
  let subtotalRs = 0;
  for (const pi of productItems) {
    const menu = menuByRetailerId[pi.product_retailer_id];
    if (!menu) continue;
    const priceRs = (menu.price_paise || 0) / 100;
    const lineTotal = priceRs * pi.quantity;
    subtotalRs += lineTotal;
    orderItems.push({
      menu_item_id: String(menu._id),
      retailer_id: menu.retailer_id,
      name: menu.name,
      variant_value: menu.variant_value || null,
      price_rs: priceRs,
      quantity: pi.quantity,
      line_total_rs: lineTotal,
    });
  }

  // Delivery fee
  const shippingOption = data.shipping_option || {};
  const deliveryFeeRs = (shippingOption.price?.amount || 0) / 100;
  const isPickup = shippingOption.id === 'pickup';

  // Discount — RE-VALIDATED below after customer creation. Never trust
  // `data.discount.amount` from the Meta payload: the coupon may have
  // been deactivated, hit its usage cap, or expired between apply_coupon
  // and the final order callback. The discount that lands on the order
  // must come from a live `validateCoupon()` against current DB state,
  // matching the conversational flow's behaviour.
  const couponCode = (data.coupon_code || '').toUpperCase().trim();
  let discountRs = 0;
  // Set to the rejected code if revalidation fails — used after the
  // order is inserted to send the customer a "no longer valid" notice.
  let invalidCouponCode = null;
  // Captured from validateCoupon when re-validation succeeds so the
  // order doc can record coupon_id / coupon_code / coupon_scope and
  // the platform-funded paise figure (settlement attribution).
  let appliedCoupon = null;

  // Customer info
  const customerPhone = data.customer_phone || data.phone;
  const customerName = data.shipping_address?.name || data.customer_name || '';
  const deliveryAddress = data.shipping_address
    ? [data.shipping_address.address_line1, data.shipping_address.address_line2, data.shipping_address.city].filter(Boolean).join(', ')
    : '';

  // [BSUID] Use universal identity resolution for customer creation.
  // Meta may supply a BSUID on the checkout payload; pass it through so
  // downstream unification ties this order to the same customer record
  // regardless of entry path (catalog chat vs. checkout endpoint).
  // [BSUID] Detect BSUID-format identifier on the checkout payload before
  // identity resolution. Meta may surface the WhatsApp Username (w-prefixed,
  // 20+ chars) on any of several fields depending on rollout phase, so check
  // the explicit bsuid fields plus the raw wa_id / customer_phone slots.
  const sightedBsuidCheckout =
    [data.bsuid, data.customer_bsuid, data.wa_id, data.customer_phone, data.phone]
      .find(v => v && isBsuid(String(v))) || null;

  const customer = await customerIdentity.getOrCreateCustomer({
    wa_phone: customerPhone,
    bsuid: data.bsuid || data.customer_bsuid || sightedBsuidCheckout || null,
    profile_name: customerName,
  });

  // Fire-and-forget BSUID sighting stamp. Never block the order path.
  if (sightedBsuidCheckout) {
    setImmediate(() => {
      const now = new Date();
      col('customers').updateOne(
        { _id: customer.id },
        { $set: { bsuid: sightedBsuidCheckout, bsuid_seen_at: now } }
      ).then(() => {
        log.info(`[BSUID] Detected on checkout for customer ${sightedBsuidCheckout.slice(0, 12)}…`);
      }).catch(err => log.warn({ err }, '[BSUID] checkout stamp failed'));
    });
  }

  // Live coupon revalidation — runs AFTER customer creation so the
  // service can enforce per-user-limit and first-order-only checks.
  // A rejection here zeroes the discount; the customer is messaged
  // after the order is inserted (further down).
  if (couponCode) {
    const isFirstOrder = await couponSvc
      .isCustomerFirstOrder(customer.id, waAccount.restaurant_id)
      .catch(() => false);
    const result = await couponSvc
      .validateCoupon(couponCode, waAccount.restaurant_id, subtotalRs, {
        customerId: customer.id,
        branchId,
        isFirstOrder,
      })
      .catch(err => {
        log.warn({ err, couponCode }, 'validateCoupon threw — treating coupon as invalid');
        return { valid: false, reason: 'service_error' };
      });
    if (result.valid) {
      discountRs = result.discountRs || 0;
      appliedCoupon = result.coupon || null;
    } else {
      invalidCouponCode = couponCode;
      log.info({ couponCode, reason: result.reason }, 'Coupon no longer valid at order finalization — discount cleared');
    }
  }

  const charges = calculateOrderCharges(
    restaurant,
    subtotalRs,
    isPickup ? 0 : deliveryFeeRs,
    discountRs
  );

  // Phase 6: identity-layer key, denormalized onto the order so
  // customer_metrics aggregates don't need to join customers. Same
  // compute path as services/order.js so both entry points produce
  // identical hashes for the same phone.
  let orderPhoneHash = null;
  try {
    orderPhoneHash = hashPhone(customerPhone);
  } catch (err) {
    log.warn({ err }, 'phone_hash compute failed');
  }

  // Create order
  const orderId = newId();
  const orderNumber = `WC${Date.now().toString(36).toUpperCase()}`;

  // ─── DISPLAY ORDER ID (per-restaurant, daily-resetting) ─────
  // Same pattern as services/order.js: ABBR-MMDD-NNN where ABBR is the
  // restaurant's order_abbr (fallback 'ZM') and NNN is an atomic
  // counter from the `counters` collection keyed on
  // (restaurantId, MMDD). `restaurant` is already loaded above for
  // calculateOrderCharges, so order_abbr is in memory — no extra DB hit.
  // Wrapped in try/catch so a counter hiccup never blocks order
  // creation; consumers fall back to order_number when null.
  let displayOrderId = null;
  try {
    const restaurantId = waAccount.restaurant_id;
    if (restaurantId) {
      // Counter key uses YYYYMMDD so docs reset on calendar-year
      // rollover; display string still uses only MMDD per the
      // customer-facing format ABBR-MMDD-NNN.
      const now = new Date();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const yyyy = String(now.getFullYear());
      const mmdd = `${mm}${dd}`;
      const yyyymmdd = `${yyyy}${mm}${dd}`;
      const { getNextOrderSeq } = require('../utils/orderSeq');
      const abbr = restaurant?.order_abbr || 'ZM';
      const dispSeq = await getNextOrderSeq(restaurantId, yyyymmdd);
      displayOrderId = `${abbr}-${mmdd}-${String(dispSeq).padStart(3, '0')}`;
    }
  } catch (err) {
    log.warn({ err: err?.message, restaurantId: waAccount.restaurant_id }, 'display_order_id generation failed — falling back to order_number');
  }

  // Coupon attribution captured from the LIVE validateCoupon result
  // (not from the Meta payload). Mirrors services/order.js so both
  // entry points produce the same shape on the order doc.
  const couponScope = appliedCoupon
    ? (appliedCoupon.restaurant_id == null ? 'platform' : 'restaurant')
    : null;
  const platformDiscountPaise = couponScope === 'platform'
    ? Math.round((Number(discountRs) || 0) * 100)
    : 0;
  const orderCouponId = appliedCoupon
    ? String(appliedCoupon._id || appliedCoupon.id || '')
    : null;
  const orderCouponCode = appliedCoupon ? (appliedCoupon.code || null) : null;

  const order = {
    _id: orderId,
    order_number: orderNumber,
    display_order_id: displayOrderId,
    restaurant_id: waAccount.restaurant_id,
    branch_id: branchId,
    phone_hash: orderPhoneHash,
    customer_id: customer.id,
    customer_name: customerName,
    customer_phone: customerPhone,
    delivery_address: deliveryAddress,
    delivery_lat: data.shipping_address?.latitude ? parseFloat(data.shipping_address.latitude) : null,
    delivery_lng: data.shipping_address?.longitude ? parseFloat(data.shipping_address.longitude) : null,
    order_type: isPickup ? 'pickup' : 'delivery',
    source: 'wa_checkout',
    coupon_id: orderCouponId,
    coupon_code: orderCouponCode,
    coupon_scope: couponScope,
    platform_discount_paise: platformDiscountPaise,
    ...charges,
    total_rs: charges.customer_total_rs,
    item_count: orderItems.reduce((s, i) => s + i.quantity, 0),
    // Always inserted as PENDING_PAYMENT — even when Meta tells us
    // payment_status='paid' on the same payload, we route the PAID
    // transition through the strict state engine below so:
    //   1. order_state_log captures the PENDING_PAYMENT → PAID move
    //   2. The state-engine listeners (notification, analytics) fire
    //   3. The flip-guard around payment_status idempotently controls
    //      the ledger credit, so a duplicate webhook doesn't double-pay
    status: 'PENDING_PAYMENT',
    payment_status: 'pending',
    settlement_id: null,
    // 20-minute payment window — mirrors services/order.js. The
    // order_details message builder reads this to render the "Pay by
    // HH:MM IST" disclaimer; the WA Native checkout already runs through
    // Meta's own checkout UI so the field doubles as a server-side guard
    // against late captures rather than a customer-facing countdown.
    expires_at: new Date(Date.now() + 20 * 60 * 1000),
    created_at: new Date(),
  };

  await col('orders').insertOne(order);

  // Insert order items
  for (const item of orderItems) {
    await col('order_items').insertOne({
      _id: newId(),
      order_id: String(orderId),
      ...item,
      created_at: new Date(),
    });
  }

  log.info({ orderNumber, totalRs: charges.customer_total_rs, itemCount: orderItems.length }, 'Order created');

  // ─── COUPON REDEMPTION TRACKING ─────────────────────────────
  // The conversational path runs incrementUsage + recordRedemption
  // inside the order-creation transaction (services/order.js). This
  // webhook inserts the order directly without a session, so we mirror
  // the calls here, post-insert. Both are wrapped — a redemption
  // tracking failure must NEVER fail the order (Meta has already
  // accepted the customer's payment / order intent).
  //
  // discount_paise stores the actual customer-facing discount on the
  // redemption row regardless of scope, matching services/order.js. The
  // funding source is captured separately via coupon_scope so reporting
  // can attribute platform spend without ambiguity.
  if (appliedCoupon) {
    const couponDiscountPaise = Math.round((Number(discountRs) || 0) * 100);
    const couponDocId = String(appliedCoupon._id || appliedCoupon.id || '');
    try {
      await couponSvc.incrementUsage(couponDocId);
    } catch (err) {
      log.warn({ err, orderNumber, couponId: couponDocId }, 'incrementUsage failed — non-fatal');
    }
    try {
      await couponSvc.recordRedemption(
        couponDocId,
        customer.id,
        String(orderId),
        null, // no transactional session in this path
        couponDiscountPaise,
        couponScope,
      );
    } catch (err) {
      log.warn({ err, orderNumber, couponId: couponDocId }, 'recordRedemption failed — non-fatal');
    }
  }

  // Coupon-invalid notice — sent only when revalidation rejected the
  // applied code. Fire-and-forget: Meta has already accepted the order,
  // so a WA send failure here must never propagate.
  if (invalidCouponCode) {
    try {
      const wa = require('../services/whatsapp');
      const metaConfig = require('../config/meta');
      const pid = waAccount.phone_number_id;
      const token = metaConfig.systemUserToken || waAccount.access_token;
      if (pid && token && customerPhone) {
        await wa.sendText(
          pid,
          token,
          customerPhone,
          `⚠️ The coupon *${invalidCouponCode}* is no longer valid. Your order has been placed at the full price of ₹${(charges.customer_total_rs || 0).toFixed(0)}.`
        );
      }
    } catch (err) {
      log.warn({ err, orderNumber, invalidCouponCode }, 'Coupon-invalid notice send failed');
    }
  }

  // ─── POST-ORDER HOOKS (fire-and-forget, must never fail the webhook) ──
  // The HTTP 200 was already sent before handleOrder ran, so these hooks
  // run off-path. Each is wrapped in its own try/catch so one failure
  // can't cascade. Mirrors services/order.js:_createOrderImpl post-commit.
  //
  // Phase 6 customer_metrics aggregation + BSUID unification side-effects.
  setImmediate(() => {
    try {
      require('../services/customerIdentityLayer').recordOrderCreated({
        waPhone: customerPhone,
        customerId: customer.id,
        restaurantId: waAccount.restaurant_id,
        name: customerName,
        totalRs: charges.customer_total_rs,
      }).catch(err => log.warn({ err, orderNumber }, 'recordOrderCreated failed'));
    } catch (err) { log.warn({ err, orderNumber }, 'recordOrderCreated dispatch failed'); }
  });

  // Trust score: +5 for reaching the created-order milestone.
  try {
    if (customer.id) {
      require('../services/trustScore')
        .recordEvent(String(customer.id), 'order_success')
        .catch(err => log.warn({ err, orderNumber }, 'trustScore.recordEvent failed'));
    }
  } catch (err) { log.warn({ err, orderNumber }, 'trustScore dispatch failed'); }

  // Loyalty earnPoints: NOT called here. order.js also doesn't award points
  // on create — the LOYALTY_AWARD job is enqueued by updateStatus() when the
  // order transitions to DELIVERED (see services/order.js:498). Since the
  // paid branch below calls orderSvc.updateStatus, and subsequent status
  // transitions (PREPARING → DISPATCHED → DELIVERED) flow through the same
  // state engine, loyalty fires at the correct milestone without a direct
  // earnPoints call from this webhook.

  // If already paid, confirm the order
  if (data.payment_status === 'paid') {
    // ─── PAYMENT-EXPIRY GATE ────────────────────────────────────
    // The customer paid via WA Native Checkout but the order's
    // payment window may have elapsed (20 min, set at creation).
    // Mirrors the Razorpay-webhook gate in webhooks/razorpay.js:
    // refund the captured amount, transition to EXPIRED_PAYMENT,
    // notify the customer, log the activity, then RETURN so the
    // PAID transition + ledger credit + fulfillment fan-out below
    // never run. Wrapped so a refund / WA-send blip never blocks
    // the webhook 200.
    //
    // Note: WA Native Checkout payments don't insert into the
    // `payments` collection the way the hosted-Razorpay path does,
    // so paymentSvc.issueRefund may return null (no payment row to
    // refund against). We log that case loudly — ops needs to
    // initiate a manual refund through the Meta/Razorpay native
    // checkout console for those orders.
    try {
      const ordExp = order; // in-memory order doc just inserted above
      if (ordExp?.expires_at && new Date() > new Date(ordExp.expires_at)) {
        const paymentSvc = require('../services/payment');
        const wa = require('../services/whatsapp');
        const { logActivity } = require('../services/activityLog');
        log.warn({ orderId, expiresAt: ordExp.expires_at }, 'WA Checkout payment captured past expiry — initiating refund');

        let refundOk = false;
        try {
          const refund = await paymentSvc.issueRefund(orderId, 'order_expired_post_payment');
          refundOk = !!refund?.id;
          if (!refundOk) {
            log.warn({ orderId }, 'No refundable payment row found for WA Native Checkout — manual refund required');
          }
        } catch (refundErr) {
          log.error({ err: refundErr, orderId }, 'Refund failed for expired-payment order — manual ops follow-up required');
        }

        try {
          const { transitionOrder } = require('../core/orderStateEngine');
          await transitionOrder(orderId, 'EXPIRED_PAYMENT', {
            actor: 'wa_checkout',
            actorType: 'system',
            metadata: { reason: 'expired_post_payment' },
          });
        } catch (statusErr) {
          log.warn({ err: statusErr, orderId }, 'EXPIRED_PAYMENT status flip failed');
        }

        // Customer WA notice — best-effort.
        try {
          const metaConfig = require('../config/meta');
          const pid = waAccount.phone_number_id;
          const token = metaConfig.systemUserToken || waAccount.access_token;
          if (pid && token && customerPhone) {
            const totalRs = Number(order.total_rs) || 0;
            await wa.sendText(
              pid, token, customerPhone,
              `⚠️ Your order timed out before payment was confirmed. A full refund of ₹${totalRs.toFixed(2)} has been initiated and will reflect in 3–5 business days. Please place a fresh order.`,
            );
          }
        } catch (waErr) {
          log.warn({ err: waErr, orderId }, 'WA notice for expired-payment failed');
        }

        logActivity({
          actorType: 'system', actorId: null, actorName: 'WA Checkout',
          action: 'order_expired_post_payment', category: 'payment',
          description: `Order ${order.order_number || orderId} expired before WA Native Checkout payment confirmation; full refund ${refundOk ? 'initiated' : 'FAILED'}`,
          restaurantId: waAccount.restaurant_id || null,
          resourceType: 'order', resourceId: orderId, severity: 'warning',
          metadata: { totalRs: order.total_rs, expiresAt: ordExp.expires_at, refundOk },
        });

        return; // Skip PAID flip, ledger credit, and fulfillment fan-out
      }
    } catch (gateErr) {
      log.error({ err: gateErr, orderId }, 'WA Checkout payment-expiry gate crashed — falling through');
    }

    // Drive the PENDING_PAYMENT → PAID transition through the strict
    // state engine so order_state_log + the order.updated event bus
    // fire correctly. The previous orderSvc.updateStatus call did the
    // same plumbing but masked the fact that we were doing a real
    // state change (the order was inserted as PAID up to this commit,
    // making updateStatus a no-op via idempotency).
    const { transitionOrder } = require('../core/orderStateEngine');
    try {
      await transitionOrder(orderId, 'PAID', {
        actor: 'wa_checkout',
        actorType: 'system',
        metadata: { method: 'whatsapp_native', provider: 'whatsapp_checkout' },
      });
    } catch (transErr) {
      // Already-PAID is the only realistic failure (concurrent webhook
      // already moved the row); transitionOrder treats that as idempotent
      // success internally, so this catch is true defence-in-depth.
      log.warn({ err: transErr, orderId }, 'wa_checkout: transitionOrder PAID failed');
    }

    // ─── IDEMPOTENT LEDGER CREDIT (OF-C1 fix) ──────────────────────
    // Mirrors the flip-guard pattern in razorpay.js so a duplicate
    // checkout webhook can NEVER double-credit:
    //   • The CAS update only matches when payment_status !== 'paid'
    //   • Whichever process flips it first wins and writes the credit
    //   • Concurrent / replay webhooks see matchedCount === 0 and skip
    // refId 'wa_checkout:<orderId>' lives in a separate namespace from
    // razorpay.js's 'rp_<paymentId>' ref_id, so the unique
    // (restaurant_id, ref_type, ref_id) ledger index never collides
    // across rails. Total fail-safe: even without the flip-guard, the
    // unique index would block a duplicate insert.
    try {
      const flip = await col('orders').updateOne(
        { _id: orderId, payment_status: { $ne: 'paid' } },
        { $set: { payment_status: 'paid', updated_at: new Date() } }
      );
      if (flip.matchedCount === 1) {
        const ord = await col('orders').findOne(
          { _id: orderId },
          { projection: {
              restaurant_id: 1,
              total_rs: 1,
              order_number: 1,
              customer_id: 1,
              coupon_scope: 1,
              coupon_code: 1,
              platform_discount_paise: 1,
          } }
        );
        if (ord?.restaurant_id) {
          const ledger = require('../services/ledger.service');
          await ledger.credit({
            restaurantId: ord.restaurant_id,
            amountPaise: Math.round((ord.total_rs || 0) * 100),
            refType: 'payment',
            refId: `wa_checkout:${String(orderId)}`,
            status: 'completed',
            notes: `WA Native Checkout payment — order ${ord.order_number}`,
          });
          log.info({ orderId, orderNumber: ord.order_number }, 'wa_checkout ledger credit written');

          // ─── PLATFORM COUPON COMPENSATION ─────────────────────────
          // Mirrors the razorpay.js path: when a customer redeems a
          // platform-wide coupon, GullyBite funds the discount so the
          // restaurant doesn't absorb it. The unique
          // (restaurant_id, ref_type, ref_id) index in restaurant_ledger
          // makes this idempotent across duplicate webhooks; the outer
          // flip-guard above already serializes the broader block.
          if (
            ord.coupon_scope === 'platform'
            && Number(ord.platform_discount_paise) > 0
          ) {
            await ledger.credit({
              restaurantId: ord.restaurant_id,
              amountPaise: Number(ord.platform_discount_paise),
              refType: 'platform_coupon_credit',
              refId: String(orderId),
              status: 'completed',
              notes: `Platform coupon compensation — ${ord.coupon_code || ''}`.trim(),
            });
          }

          // ─── PAYMENTS-ROW INSERT (refund-traceability fix) ──────
          // services/payment.js:issueRefund finds the row to refund via
          // payments.findOne({ order_id, status: 'paid' }) and calls
          // Razorpay's refund API with payment.rp_payment_id +
          // payment.amount_rs. Without a row here, every refund attempt
          // for a WA Native Checkout order returned null — the prompt-33
          // expiry gate logged "manual refund required" and ops had to
          // refund through Meta's console by hand.
          //
          // WA Native Checkout DOES route through Razorpay underneath
          // (per services/whatsapp.js's payment_settings.payment_gateway
          // .type: 'razorpay'), so when Meta forwards the captured
          // payment id we can refund it the same way the hosted-checkout
          // flow does. Meta's exact field shape varies by API version;
          // we read defensively from every plausible path. If none yield
          // a `pay_…`-shaped id, rp_payment_id stays null — issueRefund
          // will throw on null and the gate's catch records the manual-
          // refund-required state with the wa_payment_ref preserved for
          // ops follow-up.
          //
          // Idempotency: the outer flip-guard (line 686-689) already
          // serializes this entire block to one execution per order, so
          // a duplicate webhook can't double-insert. Belt-and-suspenders
          // duplicate-key catch below handles a hypothetical concurrent
          // run anyway.
          try {
            const candidates = [
              data?.payment?.transaction_id,
              data?.payment?.id,
              data?.payment?.reference_id,
              data?.payment_reference,
              data?.transaction_id,
              data?.razorpay_payment_id,
            ].filter(Boolean).map(String);
            const waPaymentRef = candidates[0] || null;
            const rzpId = candidates.find((c) => /^pay_/.test(c)) || null;

            const totalRs = Number(ord.total_rs) || 0;
            const paymentDoc = {
              _id: newId(),
              order_id: String(orderId),
              restaurant_id: ord.restaurant_id,
              customer_id: ord.customer_id || null,
              amount_rs: totalRs,
              // Paise mirror — present alongside amount_rs because (a) the
              // user-spec'd field name and (b) downstream paise-native
              // consumers (ledger reconciliation, settlement-export) can
              // read it without re-multiplying.
              amount_paise: Math.round(totalRs * 100),
              status: 'paid',
              payment_type: 'wa_native_checkout',
              payment_method: data?.payment?.method || null,
              // Razorpay payment id when Meta surfaces it; otherwise null
              // and issueRefund will throw → ops handles via console.
              rp_payment_id: rzpId,
              // Original Meta-side reference, regardless of shape. Lets
              // ops trace back to the WA checkout session even when Meta
              // didn't echo a Razorpay-shaped id.
              wa_payment_ref: waPaymentRef,
              paid_at: new Date(),
              created_at: new Date(),
              updated_at: new Date(),
            };
            try {
              await col('payments').insertOne(paymentDoc);
              log.info({
                orderId, orderNumber: ord.order_number,
                rzpId: rzpId || null,
                waPaymentRef: waPaymentRef || null,
                refundable: !!rzpId,
              }, 'wa_checkout payments row inserted');
            } catch (dupErr) {
              if (dupErr?.code === 11000 || /duplicate key/i.test(dupErr?.message || '')) {
                log.info({ orderId }, 'wa_checkout payments row already present — duplicate insert ignored');
              } else {
                throw dupErr;
              }
            }
          } catch (payErr) {
            // Insert failure must never block the credit flow above —
            // ops dashboard surfaces orders without payments rows via
            // the same reconciliation job that catches missing ledger
            // entries.
            log.warn({ err: payErr, orderId }, 'wa_checkout payments row insert failed — refunds will require manual ops');
          }
        }
      } else {
        log.info({ orderId }, 'wa_checkout: payment_status already paid — ledger credit skipped (race lost)');
      }
    } catch (ledgerErr) {
      // Ledger failure must NEVER block the checkout flow — Meta has
      // already accepted the customer's money; the ops dashboard surfaces
      // missing ledger entries via the reconciliation job.
      log.warn({ err: ledgerErr, orderId }, 'wa_checkout ledger credit failed — order still marked paid');
    }

    // Persistent-notification handshake — stamp notified_at + broadcast
    // new_paid_order so the dashboard pops the looping-sound modal.
    // Mirrors queue/postPaymentJobs._handleCustomerNotification so both
    // payment paths (Razorpay link + native checkout) trigger the same UX.
    try {
      const notifyAt = new Date();
      const stampRes = await col('orders').updateOne(
        { _id: orderId, notified_at: { $exists: false } },
        { $set: { notified_at: notifyAt } }
      );
      if (stampRes.modifiedCount > 0) {
        // Keep the legacy new_paid_order broadcast for the sound-modal UX —
        // dashboard listener emits the generic order.created alongside.
        const ws = require('../services/websocket');
        ws.broadcastOrder(waAccount.restaurant_id, 'new_paid_order', {
          orderId,
          orderNumber,
          customerName,
          // `|| ''` so the emit matches the frontend OrderPaidPayload's
          // `customerPhone: string` contract — local var could be
          // undefined when neither customer_phone nor phone is present
          // on the Meta checkout payload.
          customerPhone: customerPhone || '',
          totalRs: charges.customer_total_rs,
          itemCount: orderItems.reduce((s, i) => s + i.quantity, 0),
          items: orderItems.slice(0, 6).map(i => ({ name: i.name, quantity: i.quantity })),
          orderType: isPickup ? 'pickup' : 'delivery',
          notifiedAt: notifyAt.toISOString(),
        });
      }
    } catch (err) { log.warn({ err, orderNumber }, 'new_paid_order broadcast failed'); }

    // Event bus: fan out order.created + payment.completed. Listeners
    // (customer WhatsApp, manager notify, analytics) run async and isolated.
    const fullOrder = await orderSvc.getOrderDetails(orderId);
    const bus = require('../events');
    bus.emit('order.created', {
      orderId,
      restaurantId: waAccount.restaurant_id,
      customerPhone,
      items: orderItems.map(i => ({ name: i.name, quantity: i.quantity, unitPriceRs: i.unit_price_rs })),
      total: charges.customer_total_rs,
      _order: fullOrder,
    });
    bus.emit('payment.completed', {
      orderId,
      restaurantId: waAccount.restaurant_id,
      orderNumber,
      amountRs: charges.customer_total_rs,
      method: 'whatsapp_native',
      provider: 'whatsapp_checkout',
    });

    // Socket.io fan-out — fire-and-forget. WhatsApp Native checkout
    // creates the order AND captures payment in one webhook, so we
    // emit both order:new and order:paid here. Razorpay's webhook
    // path (src/webhooks/razorpay.js) emits order:paid for the
    // hosted-checkout flow — the conditional updateOne there
    // guarantees we only fire it once per order regardless of which
    // path won.
    try {
      const { emitToRestaurant, emitToAdmin } = require('../utils/socketEmit');
      const newOrderPayload = {
        orderId: String(orderId),
        orderNumber,
        customerName: fullOrder?.customer_name || null,
        totalRs: charges.customer_total_rs,
        createdAt: fullOrder?.created_at || new Date().toISOString(),
      };
      emitToRestaurant(waAccount.restaurant_id, 'new_order', newOrderPayload);
      // Mirror to admin:platform so platform-side dashboards can light
      // up the same lifecycle events without hitting the order DB.
      emitToAdmin('new_order', newOrderPayload);
      // 'new_paid_order' is already broadcast at line 846 via
      // broadcastOrder, which fans to both restaurant + admin rooms.
      // The standalone emitToRestaurant + emitToAdmin pair previously
      // here duplicated that with a slimmer payload — removed.
      // Admin live-feed event — slimmer payload tailored for the
      // platform overview (no customer phone, no createdAt, but adds
      // restaurantId so admin pages can route the toast to the right
      // tenant view). Distinct event name from 'new_order' so the
      // admin SocketProvider can toast it without re-toasting the
      // generic event.
      emitToAdmin('admin_order_new', {
        restaurantId: String(waAccount.restaurant_id),
        orderNumber,
        total: charges.customer_total_rs,
        branchName: fullOrder?.branch_name || null,
      });
    } catch (_e) { /* never block checkout completion on socket fan-out */ }

    // Auto-dispatch delivery
    if (!isPickup) {
      const deliveryService = require('../services/delivery');
      deliveryService.dispatchDelivery(orderId).catch(err =>
        log.error({ err, orderNumber }, 'Dispatch failed')
      );
    }
  }
}

module.exports = router;
