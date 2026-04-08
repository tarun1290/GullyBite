// src/services/cart-recovery.js
// Abandoned cart persistence, recovery message sending, and re-engagement handling.
//
// Abandoned carts are stored persistently (separate from conversation session_data).
// Recovery messages are sent on a timed schedule via cron:
//   Reminder 1 (30 min): free service message within 24h window
//   Reminder 2 (4 hours): free service message within 24h window
//   Reminder 3 (24 hours): paid Meta template message (disabled until template approved)

'use strict';

const { col, newId } = require('../config/database');
const config = require('../config/cart-recovery-config');
const log = require('../utils/logger').child({ component: 'CartRecovery' });

// ─── TRACK ABANDONED CART ────────────────────────────────
// Called at each abandonment point (address pending, review pending, payment pending/failed).
// Upserts by customer+restaurant so a single ordering session has one cart record.
async function trackAbandonedCart({
  restaurantId, branchId, customerId, customerPhone, customerName,
  cartItems, cartTotal, itemCount, catalogId,
  abandonmentStage, abandonmentReason, deliveryAddress, lastCustomerMessageAt,
}) {
  if ((cartTotal || 0) < config.min_cart_value_rs) {
    log.info({ cartTotal, minCartValue: config.min_cart_value_rs }, 'Skipping — cart below minimum');
    return null;
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.cart_expiry_days * 24 * 3600 * 1000);

  // Upsert: update existing pending cart for same customer+restaurant, or create new
  const result = await col('abandoned_carts').findOneAndUpdate(
    {
      customer_phone: customerPhone,
      restaurant_id: restaurantId,
      recovery_status: { $in: ['pending', 'reminder_1_sent', 'reminder_2_sent'] },
      created_at: { $gt: new Date(now.getTime() - 30 * 60 * 1000) }, // within 30 min
    },
    {
      $set: {
        branch_id: branchId || null,
        customer_id: customerId,
        customer_name: customerName || null,
        cart_items: cartItems || [],
        cart_total: cartTotal || 0,
        item_count: itemCount || 0,
        catalog_id: catalogId || null,
        abandonment_stage: abandonmentStage,
        abandonment_reason: abandonmentReason || null,
        delivery_address: deliveryAddress || null,
        last_customer_message_at: lastCustomerMessageAt || now,
        updated_at: now,
        expires_at: expiresAt,
      },
      $setOnInsert: {
        _id: newId(),
        restaurant_id: restaurantId,
        customer_phone: customerPhone,
        recovery_status: 'pending',
        reminders_sent: [],
        recovered_at: null,
        recovered_order_id: null,
        opted_out: false,
        created_at: now,
      },
    },
    { upsert: true, returnDocument: 'after' }
  );

  log.info({ abandonmentStage, phone: customerPhone?.slice(-4), cartTotal, itemCount }, 'Cart tracked');
  return result;
}

// ─── ENRICH CART ITEMS ──────────────────────────────────
// Look up menu_items by retailer_id to get name + image for recovery messages
async function enrichCartItems(productItems) {
  if (!productItems?.length) return [];
  const retailerIds = productItems.map(i => i.product_retailer_id).filter(Boolean);
  const menuItems = retailerIds.length
    ? await col('menu_items').find({ retailer_id: { $in: retailerIds } }).toArray()
    : [];
  const lookup = Object.fromEntries(menuItems.map(m => [m.retailer_id, m]));

  return productItems.map(i => {
    const mi = lookup[i.product_retailer_id] || {};
    return {
      product_retailer_id: i.product_retailer_id,
      quantity: i.quantity || 1,
      item_price: i.item_price || mi.price_paise ? (mi.price_paise / 100) : 0,
      currency: i.currency || 'INR',
      item_name: mi.name || i.product_retailer_id,
      item_image_url: mi.image_url || null,
    };
  });
}

// ─── MARK CART AS RECOVERED ─────────────────────────────
// Called when a customer completes an order
async function markRecovered(customerPhone, restaurantId, orderId) {
  const cart = await col('abandoned_carts').findOneAndUpdate(
    {
      customer_phone: customerPhone,
      restaurant_id: restaurantId,
      recovery_status: { $in: ['pending', 'reminder_1_sent', 'reminder_2_sent', 'reminder_3_sent'] },
    },
    {
      $set: {
        recovery_status: 'recovered',
        recovered_at: new Date(),
        recovered_order_id: orderId,
        updated_at: new Date(),
      },
    },
    { sort: { created_at: -1 } }
  );

  if (cart?.reminders_sent?.length > 0) {
    log.info({ phone: customerPhone?.slice(-4), reminders: cart.reminders_sent.length }, 'Cart recovered');
    // Mark last reminder as clicked
    const lastIdx = cart.reminders_sent.length - 1;
    await col('abandoned_carts').updateOne(
      { _id: cart._id },
      { $set: { [`reminders_sent.${lastIdx}.clicked`]: true } }
    );
  }
  return cart;
}

// ─── SEND RECOVERY REMINDER ────────────────────────────
// Sends a single reminder for an abandoned cart
async function sendRecoveryReminder(abandonedCartId, reminderNumber) {
  const cart = await col('abandoned_carts').findOne({ _id: abandonedCartId });
  if (!cart) return { sent: false, reason: 'cart_not_found' };
  if (cart.recovery_status === 'recovered' || cart.recovery_status === 'expired' || cart.opted_out) {
    return { sent: false, reason: cart.recovery_status };
  }

  // Check customer hasn't placed a new order since abandonment
  const recentOrder = await col('orders').findOne({
    customer_id: cart.customer_id,
    restaurant_id: cart.restaurant_id,
    created_at: { $gte: cart.created_at },
    status: { $nin: ['CANCELLED', 'PAYMENT_FAILED'] },
  });
  if (recentOrder) {
    await col('abandoned_carts').updateOne({ _id: cart._id }, { $set: { recovery_status: 'recovered', recovered_order_id: String(recentOrder._id), recovered_at: recentOrder.created_at, updated_at: new Date() } });
    return { sent: false, reason: 'already_ordered' };
  }

  // Check operating hours
  if (config.operating_hours_check) {
    const now = new Date();
    const istHour = (now.getUTCHours() + 5 + (now.getUTCMinutes() >= 30 ? 1 : 0)) % 24;
    if (istHour < config.earliest_send_hour || istHour >= config.latest_send_hour) {
      return { sent: false, reason: 'outside_operating_hours' };
    }
  }

  // Get restaurant's WA account for sending
  const waAcc = await col('whatsapp_accounts').findOne({ restaurant_id: cart.restaurant_id, is_active: true });
  if (!waAcc?.phone_number_id) return { sent: false, reason: 'no_wa_account' };

  const restaurant = await col('restaurants').findOne({ _id: cart.restaurant_id });
  const restName = restaurant?.business_name || 'our restaurant';
  const customerName = cart.customer_name || 'there';
  const itemCount = cart.item_count || cart.cart_items?.length || 0;
  const cartTotal = Math.round(cart.cart_total || 0);
  const wa = require('./whatsapp');
  const metaConfig = require('../config/meta');
  const pid = waAcc.phone_number_id;
  const token = metaConfig.systemUserToken;
  const to = cart.customer_phone;

  // Check 24-hour service window
  const lastMsg = cart.last_customer_message_at ? new Date(cart.last_customer_message_at) : cart.created_at;
  const hoursSinceMsg = (Date.now() - lastMsg.getTime()) / 3600000;
  const withinServiceWindow = hoursSinceMsg < 24;

  let messageType = 'service_message';
  let templateName = null;
  let waMessageId = null;

  try {
    if (reminderNumber === 1) {
      // Gentle nudge — item list + total
      const itemLines = (cart.cart_items || []).slice(0, 5).map(i =>
        `• ${i.item_name || i.product_retailer_id} x${i.quantity} — ₹${Math.round(i.item_price * i.quantity)}`
      ).join('\n');
      const moreLine = cart.cart_items?.length > 5 ? `\n...and ${cart.cart_items.length - 5} more items` : '';

      const result = await wa.sendText(pid, token, to,
        `Hey ${customerName}! 👋\n\n` +
        `You left some delicious items in your cart:\n${itemLines}${moreLine}\n\n` +
        `Total: *₹${cartTotal}*\n\n` +
        `Ready to complete your order? Just say *Order* to pick up where you left off! 🍽️`
      );
      waMessageId = result?.messages?.[0]?.id || null;
    } else if (reminderNumber === 2) {
      const result = await wa.sendText(pid, token, to,
        `Hi ${customerName}, your cart from *${restName}* is still waiting! 🛒\n\n` +
        `${itemCount} item${itemCount > 1 ? 's' : ''} worth *₹${cartTotal}*\n\n` +
        `Items may go out of stock — complete your order before they do!\n` +
        `Type *Order* to continue.`
      );
      waMessageId = result?.messages?.[0]?.id || null;
    } else if (reminderNumber === 3) {
      if (!config.reminder_3_enabled) return { sent: false, reason: 'reminder_3_disabled' };
      if (!withinServiceWindow) {
        // Must use template
        messageType = 'template_message';
        templateName = config.reminder_3_template_name;
        const result = await wa.sendTemplate(pid, token, to, {
          name: templateName,
          language: 'en',
          components: [{ type: 'body', parameters: [
            { type: 'text', text: customerName },
            { type: 'text', text: String(itemCount) },
            { type: 'text', text: String(cartTotal) },
            { type: 'text', text: restName },
          ] }],
        });
        waMessageId = result?.messages?.[0]?.id || null;
      } else {
        // Still in service window — use free text
        const result = await wa.sendText(pid, token, to,
          `Hi ${customerName}, just a final reminder — your cart from *${restName}* has ${itemCount} item${itemCount > 1 ? 's' : ''} worth *₹${cartTotal}*.\n\n` +
          `Your favorites are waiting! Reply *Order* to complete. 🍽️\n\n` +
          `_Reply STOP to opt out of reminders_`
        );
        waMessageId = result?.messages?.[0]?.id || null;
      }
    }

    // Update cart document
    const statusKey = `reminder_${reminderNumber}_sent`;
    await col('abandoned_carts').updateOne(
      { _id: cart._id },
      {
        $set: { recovery_status: statusKey, updated_at: new Date() },
        $push: {
          reminders_sent: {
            reminder_number: reminderNumber,
            sent_at: new Date(),
            message_type: messageType,
            template_name: templateName,
            wa_message_id: waMessageId,
            delivered: false,
            read: false,
            clicked: false,
          },
        },
      }
    );

    log.info({ reminderNumber, phone: to?.slice(-4), messageType, cartId: cart._id }, 'Sent recovery reminder');
    return { sent: true, reminderNumber, messageType, waMessageId };
  } catch (err) {
    log.error({ err, reminderNumber, phone: to?.slice(-4) }, 'Reminder send failed');
    return { sent: false, reason: 'send_failed', error: err.message };
  }
}

// ─── HANDLE RE-ENGAGEMENT ───────────────────────────────
// Called when a customer messages "Order"/"Cart" after receiving a recovery reminder
async function handleReEngagement(customerPhone, restaurantId) {
  const cart = await col('abandoned_carts').findOne({
    customer_phone: customerPhone,
    restaurant_id: restaurantId,
    recovery_status: { $in: ['reminder_1_sent', 'reminder_2_sent', 'reminder_3_sent'] },
  }, { sort: { created_at: -1 } });

  if (!cart) return null;

  // Check which items are still available
  const retailerIds = (cart.cart_items || []).map(i => i.product_retailer_id).filter(Boolean);
  const available = retailerIds.length
    ? await col('menu_items').find({ retailer_id: { $in: retailerIds }, is_available: true }).toArray()
    : [];
  const availableIds = new Set(available.map(i => i.retailer_id));
  const validItems = (cart.cart_items || []).filter(i => availableIds.has(i.product_retailer_id));
  const removedItems = (cart.cart_items || []).filter(i => !availableIds.has(i.product_retailer_id));

  // Mark last reminder as clicked
  if (cart.reminders_sent?.length) {
    const lastIdx = cart.reminders_sent.length - 1;
    await col('abandoned_carts').updateOne(
      { _id: cart._id },
      { $set: { [`reminders_sent.${lastIdx}.clicked`]: true, updated_at: new Date() } }
    );
  }

  return {
    cartId: cart._id,
    validItems,
    removedItems,
    branchId: cart.branch_id,
    deliveryAddress: cart.delivery_address,
    abandonmentStage: cart.abandonment_stage,
    cartTotal: cart.cart_total,
  };
}

// ─── OPT OUT ────────────────────────────────────────────
async function optOut(customerPhone, restaurantId) {
  await col('abandoned_carts').updateMany(
    { customer_phone: customerPhone, restaurant_id: restaurantId, recovery_status: { $in: ['pending', 'reminder_1_sent', 'reminder_2_sent', 'reminder_3_sent'] } },
    { $set: { recovery_status: 'opted_out', opted_out: true, updated_at: new Date() } }
  );
  // Flag customer to prevent future recovery
  await col('customers').updateOne(
    { wa_phone: customerPhone },
    { $set: { recovery_opted_out: true } }
  );
  log.info({ phone: customerPhone?.slice(-4) }, 'Customer opted out of recovery');
}

// ─── CRON: PROCESS PENDING REMINDERS ────────────────────
// Called every 5 minutes by the cron endpoint
async function processRecoveryQueue() {
  const now = new Date();
  let sent = 0;
  const MAX = config.max_reminders_per_cron_run;

  // Reminder 1: pending carts > 30 min old, < 24h old
  if (sent < MAX) {
    const r1Cutoff = new Date(now.getTime() - config.reminder_1_delay_minutes * 60000);
    const maxAge = new Date(now.getTime() - 24 * 3600000);
    const pending = await col('abandoned_carts').find({
      recovery_status: 'pending',
      created_at: { $lte: r1Cutoff, $gte: maxAge },
      opted_out: { $ne: true },
    }).limit(MAX - sent).toArray();

    for (const cart of pending) {
      if (sent >= MAX) break;
      const result = await sendRecoveryReminder(cart._id, 1);
      if (result.sent) sent++;
    }
  }

  // Reminder 2: reminder_1_sent carts > 4h old
  if (sent < MAX) {
    const r2Cutoff = new Date(now.getTime() - config.reminder_2_delay_minutes * 60000);
    const pending = await col('abandoned_carts').find({
      recovery_status: 'reminder_1_sent',
      created_at: { $lte: r2Cutoff },
      opted_out: { $ne: true },
    }).limit(MAX - sent).toArray();

    for (const cart of pending) {
      if (sent >= MAX) break;
      const result = await sendRecoveryReminder(cart._id, 2);
      if (result.sent) sent++;
    }
  }

  // Reminder 3: reminder_2_sent carts > 24h old (if enabled)
  if (sent < MAX && config.reminder_3_enabled) {
    const r3Cutoff = new Date(now.getTime() - config.reminder_3_delay_minutes * 60000);
    const maxAge = new Date(now.getTime() - config.cart_expiry_days * 24 * 3600000);
    const pending = await col('abandoned_carts').find({
      recovery_status: 'reminder_2_sent',
      created_at: { $lte: r3Cutoff, $gte: maxAge },
      opted_out: { $ne: true },
    }).limit(MAX - sent).toArray();

    for (const cart of pending) {
      if (sent >= MAX) break;
      const result = await sendRecoveryReminder(cart._id, 3);
      if (result.sent) sent++;
    }
  }

  // Expire old carts
  const expiryDate = new Date(now.getTime() - config.cart_expiry_days * 24 * 3600000);
  const expired = await col('abandoned_carts').updateMany(
    {
      recovery_status: { $in: ['pending', 'reminder_1_sent', 'reminder_2_sent', 'reminder_3_sent'] },
      created_at: { $lte: expiryDate },
    },
    { $set: { recovery_status: 'expired', updated_at: now } }
  );

  log.info({ sent, expired: expired.modifiedCount || 0 }, 'Cron recovery run complete');
  return { sent, expired: expired.modifiedCount || 0 };
}

// ─── RECOVERY ANALYTICS ─────────────────────────────────
async function getRecoveryAnalytics(restaurantId, periodDays = 7) {
  const since = new Date(Date.now() - periodDays * 24 * 3600000);

  const carts = await col('abandoned_carts').find({
    restaurant_id: restaurantId,
    created_at: { $gte: since },
  }).toArray();

  const totalAbandoned = carts.length;
  const recovered = carts.filter(c => c.recovery_status === 'recovered');
  const totalRecovered = recovered.length;
  const recoveryRate = totalAbandoned ? Math.round(totalRecovered / totalAbandoned * 1000) / 10 : 0;

  // Revenue recovered
  let revenueRecovered = 0;
  for (const c of recovered) {
    if (c.recovered_order_id) {
      const order = await col('orders').findOne({ _id: c.recovered_order_id });
      revenueRecovered += order?.total_rs || c.cart_total || 0;
    }
  }

  // By stage
  const stages = ['address_pending', 'review_pending', 'payment_pending', 'payment_failed'];
  const byStage = {};
  for (const s of stages) {
    const stageCarts = carts.filter(c => c.abandonment_stage === s);
    byStage[s] = {
      abandoned: stageCarts.length,
      recovered: stageCarts.filter(c => c.recovery_status === 'recovered').length,
    };
  }

  // By reminder
  const byReminder = {};
  for (let r = 1; r <= 3; r++) {
    const withReminder = carts.filter(c => c.reminders_sent?.some(rs => rs.reminder_number === r));
    byReminder[`reminder_${r}`] = {
      sent: withReminder.length,
      delivered: withReminder.filter(c => c.reminders_sent.find(rs => rs.reminder_number === r)?.delivered).length,
      read: withReminder.filter(c => c.reminders_sent.find(rs => rs.reminder_number === r)?.read).length,
      recovered: withReminder.filter(c => c.recovery_status === 'recovered').length,
    };
  }

  // Avg recovery time
  const recoveryTimes = recovered.filter(c => c.recovered_at && c.created_at).map(c => (new Date(c.recovered_at) - new Date(c.created_at)) / 60000);
  const avgRecoveryTimeMinutes = recoveryTimes.length ? Math.round(recoveryTimes.reduce((a, b) => a + b, 0) / recoveryTimes.length) : 0;

  const remindersSentTotal = carts.reduce((sum, c) => sum + (c.reminders_sent?.length || 0), 0);
  const templatesSent = carts.reduce((sum, c) => sum + (c.reminders_sent?.filter(r => r.message_type === 'template_message').length || 0), 0);

  return {
    total_abandoned: totalAbandoned,
    total_recovered: totalRecovered,
    recovery_rate: recoveryRate,
    revenue_recovered: Math.round(revenueRecovered),
    by_stage: byStage,
    by_reminder: byReminder,
    avg_recovery_time_minutes: avgRecoveryTimeMinutes,
    reminders_sent_total: remindersSentTotal,
    messaging_cost_inr: Math.round(templatesSent * 0.48 * 100) / 100,
  };
}

module.exports = {
  trackAbandonedCart,
  enrichCartItems,
  markRecovered,
  sendRecoveryReminder,
  handleReEngagement,
  optOut,
  processRecoveryQueue,
  getRecoveryAnalytics,
};
