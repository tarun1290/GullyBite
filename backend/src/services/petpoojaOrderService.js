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
      const priceRs = it.price_rs ?? (it.price_paise / 100);
      return {
        id: posId,
        name: it.name,
        price: priceRs,
        quantity: it.quantity,
      };
    });

    const callbackBase = process.env.PETPOOJA_CALLBACK_BASE_URL || '';
    const callbackUrl = callbackBase
      ? `${callbackBase.replace(/\/$/, '')}/webhooks/petpooja/callback`
      : '';

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
          name : customer?.name || '',
          phone: customer?.phone || '',
          email: '',
        },
        Order: {
          orderID  : order.order_number,
          orderType: 'Delivery',
          orderDate: order.created_at instanceof Date
            ? order.created_at.toISOString()
            : new Date(order.created_at || Date.now()).toISOString(),
          totalCost: order.total_rs,
        },
        OrderItem: orderItems,
        Tax     : [],
        Discount: [],
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
