// src/services/order.js
// Manages the complete order lifecycle:
// customer lookup → conversation state → cart → order creation → status updates

const db = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const couponSvc = require('./coupon');

// ─── GET OR CREATE CUSTOMER ───────────────────────────────────
// Called every time we receive a message.
// If customer doesn't exist, we create them automatically.
// wa_phone: customer's number with country code, no plus (e.g. 919876543210)
const getOrCreateCustomer = async (waPhone, profileName = null) => {
  const { rows } = await db.query(
    'SELECT * FROM customers WHERE wa_phone = $1',
    [waPhone]
  );
  if (rows.length > 0) {
    // Update name if WhatsApp sent us their profile name
    if (profileName && rows[0].name !== profileName) {
      await db.query('UPDATE customers SET name=$1 WHERE wa_phone=$2', [profileName, waPhone]);
    }
    return rows[0];
  }
  // New customer — create them
  const { rows: created } = await db.query(
    'INSERT INTO customers (wa_phone, name) VALUES ($1, $2) RETURNING *',
    [waPhone, profileName]
  );
  return created[0];
};

// ─── GET OR CREATE CONVERSATION ───────────────────────────────
// Each (customer, WhatsApp number) pair has one active conversation.
// The conversation holds the "state" of where they are in the ordering flow.
const getOrCreateConversation = async (customerId, waAccountId) => {
  const { rows } = await db.query(
    'SELECT * FROM conversations WHERE customer_id=$1 AND wa_account_id=$2 AND is_active=TRUE',
    [customerId, waAccountId]
  );
  if (rows.length > 0) {
    // Update last message timestamp (important for 24h window tracking)
    await db.query('UPDATE conversations SET last_msg_at=NOW() WHERE id=$1', [rows[0].id]);
    return rows[0];
  }
  // Create fresh conversation
  const { rows: created } = await db.query(
    `INSERT INTO conversations (customer_id, wa_account_id, state, session_data)
     VALUES ($1, $2, 'GREETING', '{}') RETURNING *`,
    [customerId, waAccountId]
  );
  return created[0];
};

// ─── UPDATE CONVERSATION STATE ────────────────────────────────
// Called whenever the bot moves to the next step.
// stateUpdates: optional new data to merge into session_data JSON
const setState = async (convId, newState, sessionUpdates = {}) => {
  const { rows } = await db.query('SELECT session_data FROM conversations WHERE id=$1', [convId]);
  const current = rows[0]?.session_data || {};
  const merged = { ...current, ...sessionUpdates };

  await db.query(
    'UPDATE conversations SET state=$1, session_data=$2, last_msg_at=NOW() WHERE id=$3',
    [newState, JSON.stringify(merged), convId]
  );
  return merged;
};

// ─── PROCESS WHATSAPP CATALOG ORDER ──────────────────────────
// When customer places an order from the WhatsApp Catalog,
// Meta sends us: { product_items: [{ product_retailer_id, quantity }] }
// We look up each item in our DB and build the cart
const buildCartFromCatalogOrder = async (productItems, branchId) => {
  // Extract the retailer_ids from Meta's order payload
  const retailerIds = productItems.map((i) => i.product_retailer_id);

  // Look up items in our DB
  const { rows: menuItems } = await db.query(
    `SELECT * FROM menu_items WHERE retailer_id = ANY($1) AND branch_id = $2 AND is_available = TRUE`,
    [retailerIds, branchId]
  );

  // Map for quick lookup
  const itemMap = {};
  menuItems.forEach((m) => { itemMap[m.retailer_id] = m; });

  // Build cart with quantities and totals
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
      menuItemId: item.id,
      retailerId: item.retailer_id,
      name: item.name,
      qty,
      unitPriceRs: item.price_paise / 100,
      lineTotalRs: (item.price_paise / 100) * qty,
    });
  }

  const subtotalRs = cart.reduce((s, i) => s + i.lineTotalRs, 0);

  // Delivery fee comes from the branch's configured rate.
  // This will be replaced by a live 3PL quote (Dunzo/Borzo/Shadowfax)
  // once the 3PL integration is active. For now: branch-level config or env fallback.
  const { rows: branchRows } = await db.query(
    'SELECT delivery_fee_rs FROM branches WHERE id = $1',
    [branchId]
  );
  const deliveryFeeRs = parseFloat(branchRows[0]?.delivery_fee_rs)
                     || parseFloat(process.env.DEFAULT_DELIVERY_FEE)
                     || 40;

  const totalRs = subtotalRs + deliveryFeeRs;

  return { cart, subtotalRs, deliveryFeeRs, totalRs, unavailable };
};

const REFERRAL_FEE_PCT = 0.075; // 7.5%

// ─── CHECK ACTIVE REFERRAL ────────────────────────────────────
const findActiveReferral = async (client, waPhone, restaurantId) => {
  if (!waPhone || !restaurantId) return null;
  const { rows } = await client.query(
    `SELECT id FROM referrals
     WHERE restaurant_id = $1 AND customer_wa_phone = $2
       AND status = 'active' AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [restaurantId, waPhone]
  );
  return rows[0] || null;
};

// ─── CREATE ORDER ─────────────────────────────────────────────
// Called when customer taps "Confirm & Pay"
// Wraps everything in a transaction (all-or-nothing)
const createOrder = async ({ convId, customerId, branchId, cart, subtotalRs, deliveryFeeRs, totalRs, discountRs = 0, couponId = null, couponCode = null, deliveryAddress, deliveryLat, deliveryLng, waPhone }) => {
  return db.transaction(async (client) => {
    // Generate human-readable order number
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const { rows: cnt } = await client.query(
      "SELECT COUNT(*) FROM orders WHERE created_at::date = CURRENT_DATE"
    );
    const seq = String(parseInt(cnt[0].count) + 1).padStart(4, '0');
    const orderNumber = `ZM-${date}-${seq}`;

    // No platform commission — GullyBite earns fixed monthly fee only
    const platformFeeRs = 0;

    // ── REFERRAL CHECK ─────────────────────────────────────────
    const { rows: br } = await client.query(
      'SELECT restaurant_id FROM branches WHERE id = $1', [branchId]
    );
    const restaurantId  = br[0]?.restaurant_id;
    const referral      = await findActiveReferral(client, waPhone, restaurantId);
    const referralId    = referral?.id || null;
    const referralFeeRs = referral ? parseFloat((subtotalRs * REFERRAL_FEE_PCT).toFixed(2)) : 0;

    // Create the order
    const { rows: orders } = await client.query(
      `INSERT INTO orders
        (order_number, customer_id, branch_id, conversation_id,
         subtotal_rs, delivery_fee_rs, discount_rs, total_rs, platform_fee_rs,
         coupon_id, coupon_code,
         referral_id, referral_fee_rs,
         delivery_address, delivery_lat, delivery_lng, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'PENDING_PAYMENT')
       RETURNING *`,
      [orderNumber, customerId, branchId, convId,
       subtotalRs, deliveryFeeRs, discountRs, totalRs, platformFeeRs,
       couponId, couponCode,
       referralId, referralFeeRs,
       deliveryAddress, deliveryLat, deliveryLng]
    );
    const order = orders[0];

    // ── COUPON USAGE ────────────────────────────────────────────
    if (couponId) {
      await couponSvc.incrementUsage(client, couponId);
    }

    // Update referral totals if this order is attributed
    if (referralId) {
      await client.query(
        `UPDATE referrals SET
           status               = 'converted',
           orders_count         = orders_count + 1,
           total_order_value_rs = total_order_value_rs + $1,
           referral_fee_rs      = referral_fee_rs + $2,
           updated_at           = NOW()
         WHERE id = $3`,
        [subtotalRs, referralFeeRs, referralId]
      );
    }

    // Create order items
    for (const item of cart) {
      await client.query(
        `INSERT INTO order_items
          (order_id, menu_item_id, item_name, unit_price_rs, quantity, line_total_rs)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [order.id, item.menuItemId, item.name, item.unitPriceRs, item.qty, item.lineTotalRs]
      );
    }

    // Link order to conversation
    await client.query(
      'UPDATE conversations SET active_order_id=$1, state=$2 WHERE id=$3',
      [order.id, 'AWAITING_PAYMENT', convId]
    );

    return order;
  });
};

// ─── UPDATE ORDER STATUS ──────────────────────────────────────
// Central function for moving orders through their lifecycle
// Called by restaurant dashboard, payment webhook, delivery webhook
const updateStatus = async (orderId, newStatus, extra = {}) => {
  const tsCol = {
    PAID: 'paid_at',
    CONFIRMED: 'confirmed_at',
    PREPARING: 'preparing_at',
    PACKED: 'packed_at',
    DISPATCHED: 'dispatched_at',
    DELIVERED: 'delivered_at',
    CANCELLED: 'cancelled_at',
  }[newStatus];

  let setClauses = ['status = $2', 'updated_at = NOW()'];
  const params = [orderId, newStatus];

  if (tsCol) {
    setClauses.push(`${tsCol} = NOW()`);
  }
  if (extra.cancelReason) {
    params.push(extra.cancelReason);
    setClauses.push(`cancel_reason = $${params.length}`);
  }

  const { rows } = await db.query(
    `UPDATE orders SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
    params
  );

  // Update customer stats on delivery
  if (newStatus === 'DELIVERED' && rows[0]) {
    await db.query(
      `UPDATE customers SET
        total_orders = total_orders + 1,
        total_spent_rs = total_spent_rs + $1,
        last_order_at = NOW()
       WHERE id = $2`,
      [rows[0].total_rs, rows[0].customer_id]
    );
  }

  return rows[0];
};

// ─── GET FULL ORDER DETAILS ───────────────────────────────────
// Returns order + items + customer + restaurant WhatsApp credentials
// Used by webhooks to get everything needed to send notifications
const getOrderDetails = async (orderId) => {
  const { rows: orders } = await db.query(`
    SELECT
      o.*,
      c.wa_phone, c.name AS customer_name,
      b.name AS branch_name, b.address AS branch_address,
      r.business_name,
      wa.phone_number_id, wa.access_token
    FROM orders o
    JOIN customers c ON o.customer_id = c.id
    JOIN branches b ON o.branch_id = b.id
    JOIN restaurants r ON b.restaurant_id = r.id
    LEFT JOIN whatsapp_accounts wa ON wa.restaurant_id = r.id AND wa.is_active = TRUE
    WHERE o.id = $1
  `, [orderId]);

  if (!orders.length) return null;

  const { rows: items } = await db.query(
    'SELECT * FROM order_items WHERE order_id = $1',
    [orderId]
  );

  return { ...orders[0], items };
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