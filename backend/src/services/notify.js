// src/services/notify.js
// Manager & owner push notifications via WhatsApp
// All sends are fire-and-forget — failures must NEVER break order flow

const { col } = require('../config/database');
const wa = require('./whatsapp');

// ─── INTERNAL HELPER: SEND TO ALL NOTIFICATION RECIPIENTS ────
const sendManagerNotification = async (restaurantId, branchId, message) => {
  try {
    // Get WA account for this restaurant
    const waAccount = await col('whatsapp_accounts').findOne({
      restaurant_id: restaurantId,
      is_active: true,
    });
    if (!waAccount?.phone_number_id || !waAccount?.access_token) {
      console.warn('[Notify] No active WA account for restaurant', restaurantId);
      return;
    }

    const pid = waAccount.phone_number_id;
    const token = waAccount.access_token;
    const businessPhone = waAccount.wa_phone_number || waAccount.display_phone_number || null;

    // Collect recipient phones
    const phones = new Set();

    // Branch manager phone
    if (branchId) {
      const branch = await col('branches').findOne({ _id: branchId });
      if (branch?.manager_phone) {
        phones.add(normalizePhone(branch.manager_phone));
      }
    }

    // Restaurant-level notification phones
    const restaurant = await col('restaurants').findOne({ _id: restaurantId });
    if (restaurant?.notification_phones?.length) {
      for (const p of restaurant.notification_phones) {
        if (p) phones.add(normalizePhone(p));
      }
    }

    // Filter out the business WA number itself (can't send to self)
    const bizNormalized = businessPhone ? normalizePhone(businessPhone) : null;
    if (bizNormalized) phones.delete(bizNormalized);

    // Check notification settings — if not set, default to enabled
    const settings = restaurant?.notification_settings || {};

    if (phones.size === 0) return;

    // Send to each recipient — all independent, don't let one failure stop others
    const promises = [...phones].map(phone =>
      wa.sendText(pid, token, phone, message).catch(err =>
        console.error(`[Notify] Failed to send to ${phone}:`, err.message)
      )
    );
    await Promise.allSettled(promises);
  } catch (err) {
    console.error('[Notify] sendManagerNotification error:', err.message);
  }
};

// ─── NORMALIZE PHONE ─────────────────────────────────────────
// Ensure format: 919876543210 (no + prefix, no spaces)
const normalizePhone = (phone) => {
  if (!phone) return '';
  let p = String(phone).replace(/[\s\-\+\(\)]/g, '');
  // If starts with 0, assume India — replace leading 0 with 91
  if (p.startsWith('0')) p = '91' + p.slice(1);
  // If 10 digits (no country code), prepend 91
  if (/^\d{10}$/.test(p)) p = '91' + p;
  return p;
};

// ─── NOTIFY: NEW ORDER (payment confirmed) ───────────────────
const notifyNewOrder = async (order) => {
  try {
    if (!order) return;

    // Check notification settings
    const restaurant = await col('restaurants').findOne({ _id: order.branch_id ? (await col('branches').findOne({ _id: order.branch_id }))?.restaurant_id : null });
    const settings = restaurant?.notification_settings || {};
    if (settings.new_order === false) return;

    const branch = await col('branches').findOne({ _id: order.branch_id });
    const customer = order.customer_name || order.wa_phone || 'Unknown';
    const itemCount = order.items?.length || '?';
    const restaurantId = branch?.restaurant_id;

    if (!restaurantId) return;

    const message =
      `🔔 *New Order!*\n\n` +
      `Order #${order.order_number}\n` +
      `Customer: ${customer}\n` +
      `Items: ${itemCount} items — ₹${parseFloat(order.total_rs || 0).toFixed(0)}\n` +
      `Branch: ${branch?.name || '—'}\n\n` +
      `Open dashboard to manage →`;

    await sendManagerNotification(restaurantId, order.branch_id, message);
  } catch (err) {
    console.error('[Notify] notifyNewOrder error:', err.message);
  }
};

// ─── NOTIFY: ORDER STATUS CHANGE ─────────────────────────────
const notifyOrderStatusChange = async (order, oldStatus, newStatus) => {
  try {
    if (!order) return;

    // Only notify for critical transitions
    const criticalStatuses = ['PAID', 'CANCELLED', 'REFUNDED'];
    if (!criticalStatuses.includes(newStatus)) return;

    const branch = await col('branches').findOne({ _id: order.branch_id });
    const restaurantId = branch?.restaurant_id;
    if (!restaurantId) return;

    // Check notification settings
    const restaurant = await col('restaurants').findOne({ _id: restaurantId });
    const settings = restaurant?.notification_settings || {};

    let message;

    if (newStatus === 'PAID') {
      if (settings.payment === false) return;
      message =
        `✅ *Payment Received*\n\n` +
        `Order #${order.order_number} — ₹${parseFloat(order.total_rs || 0).toFixed(0)}\n` +
        `Customer: ${order.customer_name || order.wa_phone || 'Unknown'}\n` +
        `Branch: ${branch?.name || '—'}\n\n` +
        `Please confirm and start preparing!`;
    } else if (newStatus === 'CANCELLED') {
      if (settings.cancelled === false) return;
      const reason = order.cancel_reason || 'No reason provided';
      message =
        `❌ *Order Cancelled*\n\n` +
        `Order #${order.order_number} — ₹${parseFloat(order.total_rs || 0).toFixed(0)}\n` +
        `Reason: ${reason}\n` +
        `Branch: ${branch?.name || '—'}`;
    } else if (newStatus === 'REFUNDED') {
      message =
        `💸 *Refund Processed*\n\n` +
        `Order #${order.order_number} — ₹${parseFloat(order.total_rs || 0).toFixed(0)}\n` +
        `Branch: ${branch?.name || '—'}`;
    }

    if (message) {
      await sendManagerNotification(restaurantId, order.branch_id, message);
    }
  } catch (err) {
    console.error('[Notify] notifyOrderStatusChange error:', err.message);
  }
};

// ─── NOTIFY: LOW ACTIVITY ────────────────────────────────────
const notifyLowActivity = async (branchId) => {
  try {
    const branch = await col('branches').findOne({ _id: branchId });
    if (!branch || !branch.is_open) return;

    const restaurantId = branch.restaurant_id;
    const restaurant = await col('restaurants').findOne({ _id: restaurantId });
    const settings = restaurant?.notification_settings || {};
    if (settings.low_activity === false) return;

    // Check if any orders in last 2 hours
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const recentOrders = await col('orders').countDocuments({
      branch_id: branchId,
      created_at: { $gte: twoHoursAgo },
    });

    if (recentOrders > 0) return;

    const message =
      `⚠️ *Low Activity Alert*\n\n` +
      `No orders in the last 2 hours at *${branch.name}*.\n` +
      `Is the branch still open?`;

    await sendManagerNotification(restaurantId, branchId, message);
  } catch (err) {
    console.error('[Notify] notifyLowActivity error:', err.message);
  }
};

module.exports = {
  sendManagerNotification,
  notifyNewOrder,
  notifyOrderStatusChange,
  notifyLowActivity,
};
