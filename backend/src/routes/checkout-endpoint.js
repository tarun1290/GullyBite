// src/routes/checkout-endpoint.js
// Meta WhatsApp Checkout "endpoint" (beta) — dynamic coupon/shipping
// callbacks during the order_details flow.
//
// This is ADDITIVE. The existing order_details interactive path
// (services/whatsapp.js sendPaymentRequest) is the primary payment
// flow and remains the default; this endpoint is only invoked when
// Meta is configured to link the checkout to this URL.
//
// Reuses the existing Flows/Checkout ECDH + AES-128-GCM crypto from
// services/checkout-crypto.js. Never rewrites that implementation.

'use strict';

const express = require('express');
const router = express.Router();
const { decryptWithKey, encryptWithFlippedIv } = require('../services/checkout-crypto');
const couponSvc = require('../services/coupon');
const { col } = require('../config/database');
const { getClient: getRedis } = require('../config/redis');
const log = require('../utils/logger').child({ component: 'checkout-endpoint' });

// Meta spec: return 421 when we cannot decrypt or version-negotiate.
// The client will fetch new keys and retry.
const DECRYPT_FAIL_STATUS = 421;

// Body parser dedicated to this route — the rest of /api uses express.json
// at mount time; we need raw-then-JSON to accept application/json payloads
// from Meta without touching the global stack.
router.post('/', express.json({ limit: '256kb' }), async (req, res) => {
  // ── 1. DECRYPT ─────────────────────────────────────────────
  let decrypted;
  try {
    decrypted = decryptWithKey({
      encrypted_aes_key: req.body?.encrypted_aes_key,
      encrypted_payload: req.body?.encrypted_flow_data || req.body?.encrypted_payload,
      iv: req.body?.initial_vector || req.body?.iv,
      tag: req.body?.tag,
    });
  } catch (err) {
    log.warn({ err: err.message }, 'checkout_endpoint.decrypt_failed');
    return res.status(DECRYPT_FAIL_STATUS).send('Decryption failed');
  }

  const { data: payload, aesKey, requestIv } = decrypted;
  const subAction = payload?.sub_action;
  const version = payload?.version || '1.0';

  log.info({ subAction, version }, 'checkout_endpoint.request');

  // ── 2. ROUTE ──────────────────────────────────────────────
  let responseData;
  try {
    switch (subAction) {
      case 'get_coupons':   responseData = await handleGetCoupons(payload);   break;
      case 'apply_coupon':  responseData = await handleApplyCoupon(payload);  break;
      case 'remove_coupon': responseData = await handleRemoveCoupon(payload); break;
      case 'apply_shipping':
        // GullyBite uses digital-goods — shipping is handled via in-order
        // line items, not Meta's shipping block. Return the order unchanged
        // so the Flow does not break.
        responseData = await handleShippingNoop(payload);
        break;
      default:
        responseData = { version, sub_action: subAction || 'unknown', data: {} };
    }
  } catch (err) {
    log.error({ err, subAction }, 'checkout_endpoint.handler_failed');
    responseData = {
      version,
      sub_action: subAction,
      data: { error: { message: err.message || 'internal error' } },
    };
  }

  // ── 3. ENCRYPT + RESPOND ──────────────────────────────────
  try {
    const out = encryptWithFlippedIv(responseData, aesKey, requestIv);
    res.set('Content-Type', 'text/plain');
    return res.status(200).send(out);
  } catch (err) {
    log.error({ err }, 'checkout_endpoint.encrypt_failed');
    return res.status(DECRYPT_FAIL_STATUS).send('Encryption failed');
  }
});

// ─── HELPERS ──────────────────────────────────────────────

// reference_id is a short id issued by sendCheckoutButtonTemplate and
// stored in checkout_refs. Map it back to restaurant_id. Fall back to
// catalog_id if Meta includes it (some endpoint payloads do).
async function _resolveRestaurantId(payload) {
  const order = payload?.data?.order_details?.order || payload?.order_details?.order;
  const params = payload?.data?.order_details || payload?.order_details || {};
  const refId = params.reference_id || payload?.reference_id;

  if (refId) {
    const ref = await col('checkout_refs').findOne({ _id: String(refId) });
    if (ref?.restaurant_id) return ref.restaurant_id;
    // Format gb_<rid>_<short> — extract inline.
    const m = String(refId).match(/^gb_([a-f0-9-]{8,36})/i);
    if (m) {
      const r = await col('restaurants').findOne({ _id: m[1] }, { projection: { _id: 1 } });
      if (r?._id) return String(r._id);
    }
  }

  const catalogId = payload?.data?.catalog_id || payload?.catalog_id;
  if (catalogId) {
    const wa = await col('whatsapp_accounts').findOne({ catalog_id: catalogId });
    if (wa?.restaurant_id) return String(wa.restaurant_id);
  }

  return null;
}

function _orderTotals(orderIn, { discountPaise = 0 } = {}) {
  const subtotal = orderIn?.subtotal?.value || 0;
  const tax      = orderIn?.tax?.value || 0;
  const shipping = orderIn?.shipping?.value || 0;
  const total    = Math.max(0, subtotal + tax + shipping - discountPaise);
  return { subtotal, tax, shipping, total };
}

// ─── get_coupons ──────────────────────────────────────────
async function handleGetCoupons(payload) {
  const restaurantId = await _resolveRestaurantId(payload);
  const coupons = restaurantId ? await couponSvc.getActiveCouponsForRestaurant(restaurantId) : [];
  return {
    version: payload.version || '1.0',
    sub_action: 'get_coupons',
    data: {
      coupons: coupons.map(c => ({
        code: c.code,
        id: c.coupon_id || c.code.toLowerCase(),
        description: c.description || c.code,
      })),
    },
  };
}

// ─── apply_coupon ─────────────────────────────────────────
async function handleApplyCoupon(payload) {
  const body = payload.data || payload;
  const orderIn = body.order_details?.order || body.order || {};
  const code = (body.input?.coupon?.code || body.coupon?.code || '').toUpperCase().trim();
  const subtotalPaise = orderIn.subtotal?.value || 0;
  const customerPhone = body.input?.user_id || body.user_id || null;

  // ─── IDEMPOTENCY GUARD (Meta retry safety) ──────────────────────
  // Meta redrives apply_coupon when its earlier attempt didn't ack in
  // time. Re-running validateCoupon on a retry races the per-user-limit
  // and global-usage checks against any concurrent order create that
  // already started using this coupon. Caching the prior valid response
  // for the (reference_id, coupon_code) pair lets retries return the
  // same answer without touching the DB.
  //
  // Only successful applies are cached — error responses must self-heal
  // on retry (e.g. transient lookup failure → "Store not found").
  // The cache is keyed on reference_id (per-checkout-session, fresh
  // each MPM send) so a customer who removes and re-applies the same
  // code in a future checkout still hits the live validator. Skip the
  // cache when reference_id or code is missing — without a stable key
  // the cache becomes a footgun (different sessions colliding).
  const referenceId =
    body.order_details?.reference_id
    || orderIn?.reference_id
    || payload?.reference_id
    || '';
  const cacheKey = referenceId && code ? `checkout:apply:${referenceId}:${code}` : null;
  let redis = null;
  if (cacheKey) {
    try {
      redis = await getRedis();
      const cached = await redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached);
        } catch (parseErr) {
          log.warn({ err: parseErr, cacheKey }, 'apply_coupon cache parse failed — falling through to live validate');
        }
      }
    } catch (err) {
      log.warn({ err, cacheKey }, 'apply_coupon cache read failed — proceeding without cache');
      redis = null;
    }
  }

  const restaurantId = await _resolveRestaurantId(payload);
  if (!restaurantId) {
    return _applyCouponResponse(payload, orderIn, 0, { error: 'Store not found' });
  }

  const result = await couponSvc.applyCoupon({
    restaurantId, code, subtotalPaise, customerId: customerPhone,
  });

  if (!result.valid) {
    return _applyCouponResponse(payload, orderIn, 0, { error: result.error });
  }

  const response = _applyCouponResponse(payload, orderIn, result.discountPaise, {
    description: result.description,
  });

  // 5-minute TTL — covers Meta's retry window comfortably without
  // pinning a stale answer past the natural checkout lifecycle.
  if (cacheKey && redis) {
    try {
      await redis.set(cacheKey, JSON.stringify(response), { EX: 300 });
    } catch (err) {
      log.warn({ err, cacheKey }, 'apply_coupon cache write failed — non-fatal');
    }
  }

  return response;
}

function _applyCouponResponse(payload, orderIn, discountPaise, extra = {}) {
  const { subtotal, tax, shipping, total } = _orderTotals(orderIn, { discountPaise });
  const order = {
    ...orderIn,
    subtotal: { value: subtotal, offset: 100 },
    tax:      { value: tax,      offset: 100 },
    ...(shipping > 0 && { shipping: { value: shipping, offset: 100 } }),
    total_amount: { value: total, offset: 100 },
  };
  if (discountPaise > 0) {
    order.discount = {
      value: discountPaise,
      offset: 100,
      description: extra.description || 'Discount',
    };
  }
  return {
    version: payload.version || '1.0',
    sub_action: 'apply_coupon',
    data: {
      order,
      ...(extra.error && { error: { message: extra.error } }),
    },
  };
}

// ─── remove_coupon ────────────────────────────────────────
async function handleRemoveCoupon(payload) {
  const body = payload.data || payload;
  const orderIn = body.order_details?.order || body.order || {};
  const { subtotal, tax, shipping, total } = _orderTotals(orderIn, { discountPaise: 0 });

  const { discount, ...rest } = orderIn;
  const order = {
    ...rest,
    subtotal: { value: subtotal, offset: 100 },
    tax:      { value: tax,      offset: 100 },
    ...(shipping > 0 && { shipping: { value: shipping, offset: 100 } }),
    discount: { value: 0, offset: 100, description: '' },
    total_amount: { value: total, offset: 100 },
  };
  return {
    version: payload.version || '1.0',
    sub_action: 'remove_coupon',
    data: { order },
  };
}

// ─── apply_shipping (no-op for digital-goods) ─────────────
async function handleShippingNoop(payload) {
  const body = payload.data || payload;
  const orderIn = body.order_details?.order || body.order || {};
  const discountPaise = orderIn?.discount?.value || 0;
  const { subtotal, tax, shipping, total } = _orderTotals(orderIn, { discountPaise });
  const order = {
    ...orderIn,
    subtotal: { value: subtotal, offset: 100 },
    tax:      { value: tax,      offset: 100 },
    ...(shipping > 0 && { shipping: { value: shipping, offset: 100 } }),
    total_amount: { value: total, offset: 100 },
  };
  return {
    version: payload.version || '1.0',
    sub_action: 'apply_shipping',
    data: {
      order,
      // Informational only — digital-goods flows do not surface shipping
      // options; the order is returned unchanged so Meta does not stall.
      notice: 'shipping_not_applicable',
    },
  };
}

module.exports = router;
