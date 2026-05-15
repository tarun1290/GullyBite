// src/services/petpoojaOrderService.js
//
// Outbound Petpooja POS order service. Mirrors our orders into the
// restaurant's Petpooja system so the kitchen ticket lands in the
// same screen the staff already use.
//
// Per-branch credentials live in `restaurant_integrations` (keyed by
// platform + branch_id + is_active). The collection is currently
// undeclared in schemas/collections.js, so writers MUST include all
// of: app_key, app_secret, access_token, outlet_id (Petpooja's restID).
//
// Both functions are non-throwing by contract — pushOrderToPos stamps
// `petpooja_push_failed` on the order doc when something blows up so
// ops can sweep + retry, and cancelOrderOnPos swallows every error
// (decline path is best-effort; we already cancelled on our side).
//
// Endpoints default to the AWS API Gateway URLs from Petpooja's
// integration docs and are env-overridable.

'use strict';

const axios = require('axios');
const { col } = require('../config/database');
const log = require('../utils/logger').child({ component: 'PetpoojaOrders' });

const TIMEOUT_MS = 15_000;

const SAVE_ORDER_URL = process.env.PETPOOJA_SAVE_ORDER_URL
  || 'https://47pfzh5sf2.execute-api.ap-southeast-1.amazonaws.com/V1/save_order';

const UPDATE_ORDER_URL = process.env.PETPOOJA_UPDATE_ORDER_URL
  || 'https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/update_order_status';

async function _findIntegration(branchId) {
  return col('restaurant_integrations').findOne({
    platform: 'petpooja',
    branch_id: branchId,
    is_active: true,
  });
}

function _hasCredentials(integration) {
  return !!(
    integration
    && integration.app_key
    && integration.app_secret
    && integration.access_token
    && integration.outlet_id
  );
}

// ── Petpooja /save_order tax helpers ─────────────────────────
// Approximate Indian restaurant GST. subtotal_rs is pre-tax;
// delivery + packing are treated as tax-exempt here.
function computeTax(order) {
  // 5% GST on (subtotal − discount)
  const taxable = (order.subtotal_rs || 0) - (order.discount_rs || 0);
  return Math.max(0, taxable * 0.05).toFixed(2);
}

function buildItemTax(price, qty) {
  // 2.5% CGST + 2.5% SGST on item line total
  const base = price * qty;
  const each = parseFloat((base * 0.025).toFixed(2));
  return [
    { id: 'CGST', name: 'CGST', tax_percentage: '2.5', amount: String(each) },
    { id: 'SGST', name: 'SGST', tax_percentage: '2.5', amount: String(each) },
  ];
}

function buildOrderTax(order) {
  const taxable = Math.max(0, (order.subtotal_rs || 0) - (order.discount_rs || 0));
  const each = parseFloat((taxable * 0.025).toFixed(2));
  return [
    { id: 'CGST', title: 'CGST', type: 'P', price: '2.5%', tax: String(each), restaurant_liable_amt: String(each) },
    { id: 'SGST', title: 'SGST', type: 'P', price: '2.5%', tax: String(each), restaurant_liable_amt: String(each) },
  ];
}

async function pushOrderToPos(orderId) {
  try {
    const order = await col('orders').findOne({ _id: orderId });
    if (!order) {
      log.info({ orderId }, 'pushOrderToPos: order not found — stale job, skipping');
      return;
    }
    if (order.status !== 'PAID') {
      log.info({ orderId, status: order.status }, 'pushOrderToPos: order not in PAID — skipping');
      return;
    }
    if (order.petpooja_order_id) {
      log.info({ orderId, petpoojaOrderId: order.petpooja_order_id }, 'pushOrderToPos: already pushed — skipping');
      return;
    }

    const integration = await _findIntegration(order.branch_id);
    if (!_hasCredentials(integration)) {
      log.warn({ orderId, branchId: order.branch_id }, 'pushOrderToPos: no petpooja integration for branch');
      return;
    }

    const [customer, branch, menuItems] = await Promise.all([
      order.customer_id ? col('customers').findOne({ _id: order.customer_id }) : null,
      order.branch_id ? col('branches').findOne({ _id: order.branch_id }) : null,
      col('menu_items').find({ branch_id: order.branch_id, pos_platform: 'petpooja' }).toArray(),
    ]);

    // Map our menu_item _id → Petpooja pos_item_id. The order's denorm
    // items array references the internal menu_item id; Petpooja's
    // /save_order needs the matching POS-side itemid. Items missing
    // from the map fall back to their name as id (warn, not abort) so
    // a partial mapping doesn't drop the whole order on the floor.
    const posIdByItemId = new Map();
    for (const mi of menuItems || []) {
      if (mi._id && mi.pos_item_id) {
        posIdByItemId.set(String(mi._id), String(mi.pos_item_id));
      }
    }

    const orderItems = (Array.isArray(order.items) ? order.items : []).map((it) => {
      const localId = it._id ? String(it._id) : (it.item_id ? String(it.item_id) : null);
      let posId = localId ? posIdByItemId.get(localId) : null;
      if (!posId) {
        log.warn({ orderId, itemId: localId, name: it.name }, 'pushOrderToPos: pos_item_id missing for line — falling back to name');
        posId = it.name || 'unknown';
      }
      const rawPrice = it.price_rs ?? (it.price_paise != null ? it.price_paise / 100 : null);
      const itemPrice = (Number.isFinite(rawPrice) && rawPrice >= 0) ? rawPrice : 0;
      const itemQty = it.quantity || 1;
      const rawAddons = Array.isArray(it.addons)
        ? it.addons
        : (Array.isArray(it.addon_items) ? it.addon_items : []);
      return {
        id            : posId,
        name          : it.name,
        price         : itemPrice.toFixed(2),
        final_price   : itemPrice.toFixed(2),
        quantity      : String(itemQty),
        tax_inclusive : 'false',
        gst_liability : 'restaurant',
        variation_id  : it.variation_id || '',
        variation_name: it.variation_name || it.size || '',
        item_tax      : buildItemTax(itemPrice, itemQty),
        addon_items   : rawAddons.map((ad) => ({
          id      : ad.id || ad.addon_id || '',
          name    : ad.name,
          price   : (ad.price_rs || 0).toFixed(2),
          quantity: String(ad.quantity || 1),
        })),
      };
    });

    const callbackBase = process.env.PETPOOJA_CALLBACK_BASE_URL || '';
    const callbackUrl = callbackBase
      ? `${callbackBase.replace(/\/$/, '')}/webhooks/petpooja/callback`
      : '';

    const createdAt = order.created_at instanceof Date
      ? order.created_at
      : new Date(order.created_at || Date.now());
    const createdAtIso = createdAt.toISOString();

    const payload = {
      app_key      : integration.app_key,
      app_secret   : integration.app_secret,
      access_token : integration.access_token,
      restID       : integration.outlet_id,
      device_type  : 'Web',
      callback_url : callbackUrl,
      res_name     : branch?.name || order.restaurant_id || '',
      address      : branch?.address || '',
      OrderInfo: {
        Customer: {
          name     : customer?.name || 'Customer',
          phone    : customer?.phone || '',
          email    : '',
          address  : order.address_snapshot?.formatted_address || order.delivery_address || '',
          latitude : order.address_snapshot?.latitude || '',
          longitude: order.address_snapshot?.longitude || '',
        },
        Order: {
          orderID          : order.order_number,
          preorder_date    : createdAtIso.slice(0, 10),
          preorder_time    : createdAtIso.slice(11, 19),
          advanced_order   : 'N',
          order_type       : 'H',
          total            : (order.total_rs || 0).toFixed(2),
          tax_total        : computeTax(order),
          discount_total   : order.discount_rs ? order.discount_rs.toFixed(2) : '',
          discount_type    : order.discount_rs ? 'F' : '',
          description      : '',
          created_on       : createdAtIso.replace('T', ' ').slice(0, 19),
          dc_tax_percentage: '0',
          pc_tax_percentage: '0',
          payment_type     : 'ONLINE',
          delivery_charges : (order.delivery_fee_rs || 0).toFixed(2),
          enable_delivery  : '0',
          callback_url     : callbackUrl,
        },
        OrderItem: orderItems,
        Tax      : buildOrderTax(order),
      },
    };

    let response;
    try {
      response = await axios.post(SAVE_ORDER_URL, payload, { timeout: TIMEOUT_MS });
    } catch (err) {
      log.error({
        orderId,
        errMessage: err?.message || String(err),
        upstreamStatus: err?.response?.status,
        upstreamBody: err?.response?.data,
      }, 'pushOrderToPos: petpooja /save_order failed');
      await col('orders').updateOne(
        { _id: orderId },
        { $set: { petpooja_push_failed: true, updated_at: new Date() } },
      ).catch(() => {});
      return;
    }

    const ok = response?.data?.success === true || response?.status === 200;
    if (!ok) {
      log.error({ orderId, status: response?.status, body: response?.data }, 'pushOrderToPos: petpooja returned non-success');
      await col('orders').updateOne(
        { _id: orderId },
        { $set: { petpooja_push_failed: true, updated_at: new Date() } },
      ).catch(() => {});
      return;
    }

    const petpoojaOrderId = response?.data?.orderID || 'pushed';
    await col('orders').updateOne(
      { _id: orderId },
      { $set: {
          petpooja_order_id: String(petpoojaOrderId),
          petpooja_pushed_at: new Date(),
          updated_at: new Date(),
        } },
    );
    log.info({ orderId, petpoojaOrderId }, 'pushOrderToPos: order pushed to petpooja');
  } catch (err) {
    log.error({
      orderId,
      errMessage: err?.message || String(err),
      errStack: err?.stack,
    }, 'pushOrderToPos: unexpected failure');
    await col('orders').updateOne(
      { _id: orderId },
      { $set: { petpooja_push_failed: true, updated_at: new Date() } },
    ).catch(() => {});
  }
}

async function cancelOrderOnPos(orderId, reason) {
  try {
    const order = await col('orders').findOne({ _id: orderId });
    if (!order) {
      log.info({ orderId }, 'cancelOrderOnPos: order not found — nothing to cancel');
      return;
    }
    if (!order.petpooja_order_id) {
      log.info({ orderId }, 'cancelOrderOnPos: no petpooja_order_id — nothing to cancel');
      return;
    }

    const integration = await _findIntegration(order.branch_id);
    if (!_hasCredentials(integration)) {
      log.warn({ orderId, branchId: order.branch_id }, 'cancelOrderOnPos: no petpooja integration for branch');
      return;
    }

    const payload = {
      app_key      : integration.app_key,
      app_secret   : integration.app_secret,
      access_token : integration.access_token,
      restID       : integration.outlet_id,
      clientorderID: order.order_number,
      orderID      : '',
      status       : '-1',
      cancelReason : (reason || 'Order cancelled').toString().slice(0, 200),
    };

    const response = await axios.post(UPDATE_ORDER_URL, payload, { timeout: TIMEOUT_MS });
    log.info({
      orderId,
      orderNumber: order.order_number,
      petpoojaOrderId: order.petpooja_order_id,
      status: response?.status,
      body: response?.data,
    }, 'cancelOrderOnPos: petpooja /update_order_status returned');
  } catch (err) {
    log.warn({
      orderId,
      errMessage: err?.message || String(err),
      upstreamStatus: err?.response?.status,
      upstreamBody: err?.response?.data,
    }, 'cancelOrderOnPos: petpooja cancel failed (swallowed)');
  }
}

module.exports = {
  pushOrderToPos,
  cancelOrderOnPos,
};
