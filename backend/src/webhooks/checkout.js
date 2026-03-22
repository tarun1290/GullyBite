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
        console.error('[Checkout] Invalid signature');
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
          console.error('[Checkout] Order processing failed:', err.message)
        );
        return;
      default:
        console.log('[Checkout] Unknown event type:', eventType);
        return res.sendStatus(200);
    }
  } catch (err) {
    console.error('[Checkout] Webhook error:', err.message);
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
    let deliveryFeeRs = 0;
    try {
      const { calculateDynamicDeliveryFee } = require('../services/dynamicPricing');
      const branches = await col('branches').find({ restaurant_id: waAccount.restaurant_id }).toArray();
      if (branches[0] && address?.latitude && address?.longitude) {
        const quote = await calculateDynamicDeliveryFee(
          String(branches[0]._id),
          parseFloat(address.latitude),
          parseFloat(address.longitude),
          { customerName: address.name, customerPhone: data.customer_phone }
        );
        deliveryFeeRs = quote.deliveryFeeRs || 0;
      }
    } catch (e) {
      deliveryFeeRs = parseFloat(process.env.DEFAULT_DELIVERY_FEE || 40);
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
    console.error('[Checkout] Shipping error:', err.message);
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
    console.error('[Checkout] Coupon error:', err.message);
    res.json({ valid: false, error: 'Could not validate coupon' });
  }
}

// ─── ORDER CREATION ─────────────────────────────────────────────
// WhatsApp sends the final confirmed order — we create it in our system
async function handleOrder(value) {
  const data = value.encrypted_payload
    ? decryptCheckoutPayload(value)
    : value;

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

  // Calculate charges
  const charges = calculateOrderCharges(
    restaurant,
    subtotalRs,
    isPickup ? 0 : deliveryFeeRs,
    discountRs
  );

  // Customer info
  const customerPhone = data.customer_phone || data.phone;
  const customerName = data.shipping_address?.name || data.customer_name || '';
  const deliveryAddress = data.shipping_address
    ? [data.shipping_address.address_line1, data.shipping_address.address_line2, data.shipping_address.city].filter(Boolean).join(', ')
    : '';

  // Find or create customer
  let customer = await col('customers').findOne({
    restaurant_id: waAccount.restaurant_id,
    wa_phone: customerPhone,
  });
  if (!customer) {
    customer = {
      _id: newId(),
      restaurant_id: waAccount.restaurant_id,
      wa_phone: customerPhone,
      name: customerName,
      total_orders: 0,
      total_spent_rs: 0,
      created_at: new Date(),
    };
    await col('customers').insertOne(customer);
  }

  // Create order
  const orderId = newId();
  const orderNumber = `WC${Date.now().toString(36).toUpperCase()}`;
  const order = {
    _id: orderId,
    order_number: orderNumber,
    restaurant_id: waAccount.restaurant_id,
    branch_id: branchId,
    customer_id: String(customer._id),
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
    status: 'PENDING',
    payment_status: data.payment_status === 'paid' ? 'paid' : 'pending',
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

  console.log(`[Checkout] Order ${orderNumber} created — ₹${charges.customer_total_rs} (${orderItems.length} items)`);

  // If already paid, confirm the order
  if (data.payment_status === 'paid') {
    await orderSvc.updateStatus(orderId, 'PAID');

    // Send confirmation via restaurant's WA
    const wa = require('../services/whatsapp');
    await wa.sendStatusUpdate(
      waAccount.phone_number_id, waAccount.access_token, customerPhone,
      'CONFIRMED', { orderNumber }
    ).catch(() => {});

    // Notify manager
    const notify = require('../services/notify');
    const fullOrder = await orderSvc.getOrderDetails(orderId);
    if (fullOrder) notify.notifyNewOrder(fullOrder).catch(() => {});

    // Auto-dispatch delivery
    if (!isPickup) {
      const deliveryService = require('../services/delivery');
      deliveryService.dispatchDelivery(orderId).catch(err =>
        console.error(`[Checkout] Dispatch failed for ${orderNumber}:`, err.message)
      );
    }
  }
}

module.exports = router;
