// src/webhooks/checkout.js
// WhatsApp Checkout webhook handler
// Handles: shipping callback, coupon validation, order creation
// WhatsApp sends encrypted payloads — we decrypt and process

'use strict';

const express = require('express');
const router = express.Router();
const { col, newId } = require('../config/database');
const { decryptCheckoutPayload, verifyCheckoutSignature } = require('../services/checkout-crypto');
const { calculateOrderCharges } = require('../services/charges');
const orderSvc = require('../services/order');
const customerIdentity = require('../services/customerIdentity');
const { isBsuid } = customerIdentity;
const { hashPhone } = require('../utils/phoneHash');
const log = require('../utils/logger').child({ component: 'checkout' });

// ─── WEBHOOK VERIFICATION ───────────────────────────────────────
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WA_CHECKOUT_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── INCOMING CHECKOUT EVENTS ───────────────────────────────────
router.post('/', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    // Verify signature if configured
    const sig = req.headers['x-hub-signature-256']?.replace('sha256=', '');
    if (process.env.WA_CHECKOUT_WEBHOOK_SECRET && sig) {
      if (!verifyCheckoutSignature(req.body, sig)) {
        req.log.error('Invalid signature');
        return res.sendStatus(401);
      }
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
      case 'coupon':
        return await handleCoupon(value, res);
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

// ─── COUPON VALIDATION ──────────────────────────────────────────
// WhatsApp asks: "Is this coupon code valid?"
async function handleCoupon(value, res) {
  try {
    const data = value.encrypted_payload
      ? decryptCheckoutPayload(value)
      : value;

    const code = (data.coupon_code || '').toUpperCase().trim();
    const catalogId = data.catalog_id;
    const subtotalPaise = data.order_subtotal?.amount || 0;
    const subtotalRs = subtotalPaise / 100;

    const waAccount = await col('whatsapp_accounts').findOne({ catalog_id: catalogId });
    if (!waAccount) return res.json({ valid: false, error: 'Store not found' });

    const coupon = await col('coupons').findOne({
      restaurant_id: waAccount.restaurant_id,
      code,
      is_active: true,
    });

    if (!coupon) return res.json({ valid: false, error: 'Invalid coupon code' });

    // Check validity period
    const now = new Date();
    if (coupon.valid_from && now < new Date(coupon.valid_from)) {
      return res.json({ valid: false, error: 'Coupon not yet active' });
    }
    if (coupon.valid_until && now > new Date(coupon.valid_until)) {
      return res.json({ valid: false, error: 'Coupon has expired' });
    }

    // Check minimum order
    if (coupon.min_order_rs && subtotalRs < coupon.min_order_rs) {
      return res.json({ valid: false, error: `Minimum order ₹${coupon.min_order_rs} required` });
    }

    // Check usage limit
    if (coupon.usage_limit && coupon.usage_count >= coupon.usage_limit) {
      return res.json({ valid: false, error: 'Coupon usage limit reached' });
    }

    // Calculate discount
    let discountRs = 0;
    if (coupon.discount_type === 'percent') {
      discountRs = subtotalRs * (coupon.discount_value / 100);
      if (coupon.max_discount_rs) discountRs = Math.min(discountRs, coupon.max_discount_rs);
    } else {
      discountRs = coupon.discount_value;
    }
    discountRs = Math.min(discountRs, subtotalRs); // Can't exceed subtotal

    res.json({
      valid: true,
      discount: {
        amount: Math.round(discountRs * 100),
        currency: 'INR',
        description: coupon.description || `${coupon.discount_type === 'percent' ? coupon.discount_value + '% off' : '₹' + coupon.discount_value + ' off'}`,
      },
    });
  } catch (err) {
    log.error({ err }, 'Coupon error');
    res.json({ valid: false, error: 'Could not validate coupon' });
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

  // Discount
  const discountRs = (data.discount?.amount || 0) / 100;

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
          { projection: { restaurant_id: 1, total_rs: 1, order_number: 1 } }
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
          customerPhone,
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
        total: charges.customer_total_rs,
        branchName: fullOrder?.branch_name || null,
        customerPhone,
        createdAt: fullOrder?.created_at || new Date().toISOString(),
      };
      const paidPayload = {
        orderId: String(orderId),
        amount: charges.customer_total_rs,
        paidAt: new Date().toISOString(),
      };
      emitToRestaurant(waAccount.restaurant_id, 'order:new', newOrderPayload);
      emitToRestaurant(waAccount.restaurant_id, 'order:paid', paidPayload);
      // Mirror to admin:platform so platform-side dashboards can light
      // up the same lifecycle events without hitting the order DB.
      emitToAdmin('order:new', newOrderPayload);
      emitToAdmin('order:paid', paidPayload);
      // Admin live-feed event — slimmer payload tailored for the
      // platform overview (no customer phone, no createdAt, but adds
      // restaurantId so admin pages can route the toast to the right
      // tenant view). Distinct event name from 'order:new' so the
      // admin SocketProvider can toast it without re-toasting the
      // generic event.
      emitToAdmin('admin:order_new', {
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
