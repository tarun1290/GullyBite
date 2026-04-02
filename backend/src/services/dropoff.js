// src/services/dropoff.js
// Drop-off detection, funnel analytics, and abandoned cart recovery

const { col, newId } = require('../config/database');

// ─── STATE → FUNNEL STAGE MAPPING ────────────────────────
const STATE_TO_STAGE = {
  GREETING:                    'initiated',
  SELECTING_ADDRESS:           'address',
  AWAITING_LOCATION:           'address',
  AWAITING_ADDRESS_FORM:       'address',
  SHOWING_CATALOG:             'browsing',
  AWAITING_COUPON:             'browsing',
  AWAITING_POINTS_REDEEM:      'browsing',
  ORDER_REVIEW:                'cart',
  AWAITING_PHONE_FOR_PAYMENT:  'payment_pending',
  AWAITING_PAYMENT:            'payment_pending',
  AWAITING_FEEDBACK:           'completed',
  SELECTING_ISSUE_CATEGORY:    'completed',
  SELECTING_ISSUE_ORDER:       'completed',
  AWAITING_ISSUE_DESCRIPTION:  'completed',
};

const COMPLETED_STAGES = new Set(['completed']);
const FUNNEL_ORDER = ['initiated', 'address', 'browsing', 'cart', 'payment_pending', 'completed'];

// Abandonment thresholds (hours) — early stages tolerate longer before being "abandoned"
const ABANDON_HOURS = {
  initiated:       24,
  address:         24,
  browsing:        12,
  cart:             2,
  payment_pending:  2,
};

// ─── GET DROP-OFFS ───────────────────────────────────────
async function getDropoffs(restaurantId, options = {}) {
  const {
    from = new Date(Date.now() - 30 * 24 * 3600 * 1000),
    to = new Date(),
    stage: filterStage,
    limit = 50,
    includeDetails = true,
  } = options;

  // Build the wa_account_id filter from restaurant_id
  let waFilter = {};
  if (restaurantId) {
    const waAccounts = await col('whatsapp_accounts').find({ restaurant_id: restaurantId }).toArray();
    const waIds = waAccounts.map(w => String(w._id));
    if (!waIds.length) return _emptyResult();
    waFilter = { wa_account_id: { $in: waIds } };
  }

  const now = new Date();

  // Query all conversations in the date range
  const convs = await col('conversations').find({
    ...waFilter,
    last_msg_at: { $gte: from, $lte: to },
  }).toArray();

  // Classify each conversation into a funnel stage
  const stageCounts = { initiated: 0, address: 0, browsing: 0, cart: 0, payment_pending: 0, payment_failed: 0, completed: 0 };
  const dropoffList = [];

  for (const conv of convs) {
    const stage = STATE_TO_STAGE[conv.state] || 'initiated';

    // Check for orders to determine completion
    const hasOrder = conv.active_order_id
      ? await col('orders').findOne({ _id: conv.active_order_id, status: { $nin: ['CANCELLED', 'PAYMENT_FAILED'] } })
      : null;

    if (hasOrder || COMPLETED_STAGES.has(stage)) {
      stageCounts.completed++;
      continue;
    }

    // Check payment failure
    if (conv.active_order_id) {
      const failedOrder = await col('orders').findOne({ _id: conv.active_order_id, status: { $in: ['CANCELLED', 'PAYMENT_FAILED'] } });
      if (failedOrder && failedOrder.cancel_reason?.includes('expired')) {
        stageCounts.payment_failed++;
        continue;
      }
    }

    stageCounts[stage] = (stageCounts[stage] || 0) + 1;

    // Check if abandoned (stale enough)
    const hoursSince = (now - new Date(conv.last_msg_at)) / 3600000;
    const threshold = ABANDON_HOURS[stage] || 24;
    const isAbandoned = hoursSince >= threshold;

    if (isAbandoned && (!filterStage || filterStage === stage)) {
      dropoffList.push({
        conversation_id: String(conv._id),
        customer_id: conv.customer_id,
        stage,
        state: conv.state,
        session_data: conv.session_data || {},
        last_activity: conv.last_msg_at,
        hours_since_activity: Math.round(hoursSince * 10) / 10,
        wa_account_id: conv.wa_account_id,
      });
    }
  }

  // Enrich dropoffs with customer details if requested
  if (includeDetails && dropoffList.length) {
    const customerIds = [...new Set(dropoffList.map(d => d.customer_id))];
    const customers = await col('customers').find({ _id: { $in: customerIds } }).toArray();
    const custMap = {};
    for (const c of customers) custMap[String(c._id)] = c;

    for (const d of dropoffList) {
      const cust = custMap[d.customer_id];
      d.customer_phone = cust?.wa_phone || cust?.bsuid || null;
      d.customer_name = cust?.name || null;

      // Extract cart info for cart-stage dropoffs
      if (d.stage === 'cart' && d.session_data?.cart) {
        d.cart_items = d.session_data.cart.map(i => `${i.name} x${i.qty}`);
        d.cart_total_rs = d.session_data.totalRs || d.session_data.subtotalRs || 0;
      }
      if (d.session_data?.branchId) {
        const branch = await col('branches').findOne({ _id: d.session_data.branchId });
        d.branch_name = branch?.name || null;
      }
      // Clean up session_data from response (too large)
      delete d.session_data;
    }
  }

  // Build funnel (cumulative — each stage includes those who passed through it)
  const total = convs.length;
  const passedAddress = total - stageCounts.initiated;
  const passedBrowsing = passedAddress - stageCounts.address;
  const passedCart = passedBrowsing - stageCounts.browsing;
  const passedPayment = passedCart - stageCounts.cart;
  const completed = stageCounts.completed;

  const funnel = [
    { stage: 'Initiated', count: total, pct: 100 },
    { stage: 'Address Selected', count: passedAddress, pct: total ? Math.round(passedAddress / total * 1000) / 10 : 0 },
    { stage: 'Viewed Menu', count: passedBrowsing, pct: total ? Math.round(passedBrowsing / total * 1000) / 10 : 0 },
    { stage: 'Added to Cart', count: passedCart, pct: total ? Math.round(passedCart / total * 1000) / 10 : 0 },
    { stage: 'Payment Started', count: passedPayment, pct: total ? Math.round(passedPayment / total * 1000) / 10 : 0 },
    { stage: 'Order Completed', count: completed, pct: total ? Math.round(completed / total * 1000) / 10 : 0 },
  ];

  return {
    summary: {
      total_initiated: total,
      dropped_at_address: stageCounts.address,
      dropped_at_browsing: stageCounts.browsing,
      dropped_at_cart: stageCounts.cart,
      dropped_at_payment: stageCounts.payment_pending,
      payment_failed: stageCounts.payment_failed,
      completed: stageCounts.completed,
      completion_rate: total ? Math.round(completed / total * 1000) / 10 : 0,
    },
    funnel,
    dropoffs: dropoffList.slice(0, limit),
  };
}

// ─── GET SINGLE DROP-OFF DETAIL ──────────────────────────
async function getDropoffDetails(conversationId) {
  const conv = await col('conversations').findOne({ _id: conversationId });
  if (!conv) return null;

  const customer = conv.customer_id ? await col('customers').findOne({ _id: conv.customer_id }) : null;
  const session = conv.session_data || {};
  const branch = session.branchId ? await col('branches').findOne({ _id: session.branchId }) : null;
  const waAccount = conv.wa_account_id ? await col('whatsapp_accounts').findOne({ _id: conv.wa_account_id }) : null;
  const restaurant = waAccount?.restaurant_id ? await col('restaurants').findOne({ _id: waAccount.restaurant_id }) : null;

  const stage = STATE_TO_STAGE[conv.state] || 'initiated';
  const hoursSince = (Date.now() - new Date(conv.last_msg_at)) / 3600000;

  return {
    conversation_id: String(conv._id),
    customer_id: conv.customer_id,
    customer_phone: customer?.wa_phone || customer?.bsuid || null,
    customer_name: customer?.name || null,
    restaurant_name: restaurant?.business_name || null,
    branch_name: branch?.name || null,
    stage,
    state: conv.state,
    cart_items: session.cart?.map(i => ({ name: i.name, qty: i.qty, price_rs: i.unitPriceRs })) || [],
    cart_total_rs: session.totalRs || session.subtotalRs || 0,
    delivery_address: session.deliveryAddress || null,
    coupon: session.coupon || null,
    active_order_id: conv.active_order_id || null,
    last_activity: conv.last_msg_at,
    hours_since_activity: Math.round(hoursSince * 10) / 10,
    created_at: conv.created_at,
  };
}

// ─── GET RECOVERABLE DROP-OFFS ───────────────────────────
// High-intent abandoned carts suitable for recovery messages
async function getRecoverableDropoffs(restaurantId) {
  const waAccounts = await col('whatsapp_accounts').find({ restaurant_id: restaurantId }).toArray();
  const waIds = waAccounts.map(w => String(w._id));
  if (!waIds.length) return [];

  const now = new Date();
  const twoHoursAgo = new Date(now - 2 * 3600000);
  const fortyEightHoursAgo = new Date(now - 48 * 3600000);

  // Find cart/payment-stage conversations, 2-48 hours old
  const convs = await col('conversations').find({
    wa_account_id: { $in: waIds },
    state: { $in: ['ORDER_REVIEW', 'AWAITING_PHONE_FOR_PAYMENT', 'AWAITING_PAYMENT'] },
    last_msg_at: { $gte: fortyEightHoursAgo, $lte: twoHoursAgo },
    is_active: true,
  }).toArray();

  // Exclude customers who already placed an order since
  const results = [];
  for (const conv of convs) {
    const recentOrder = await col('orders').findOne({
      customer_id: conv.customer_id,
      restaurant_id: restaurantId,
      created_at: { $gte: conv.last_msg_at },
      status: { $nin: ['CANCELLED', 'PAYMENT_FAILED'] },
    });
    if (recentOrder) continue; // already ordered since — skip

    // Check no recovery already sent recently
    const recentRecovery = await col('recovery_attempts').findOne({
      conversation_id: String(conv._id),
      sent_at: { $gte: fortyEightHoursAgo },
    });
    if (recentRecovery) continue;

    const customer = await col('customers').findOne({ _id: conv.customer_id });
    const session = conv.session_data || {};

    results.push({
      conversation_id: String(conv._id),
      customer_id: conv.customer_id,
      customer_phone: customer?.wa_phone || customer?.bsuid || null,
      customer_name: customer?.name || null,
      stage: STATE_TO_STAGE[conv.state] || 'cart',
      state: conv.state,
      cart_items: session.cart?.map(i => `${i.name} x${i.qty}`) || [],
      cart_total_rs: session.totalRs || session.subtotalRs || 0,
      branch_id: session.branchId || null,
      last_activity: conv.last_msg_at,
      hours_since_activity: Math.round((now - new Date(conv.last_msg_at)) / 3600000 * 10) / 10,
    });
  }

  return results;
}

// ─── GET RECOVERY STATS ──────────────────────────────────
async function getRecoveryStats(restaurantId, from, to) {
  const match = { restaurant_id: restaurantId };
  if (from) match.sent_at = { $gte: new Date(from) };
  if (to) match.sent_at = { ...match.sent_at, $lte: new Date(to) };

  const attempts = await col('recovery_attempts').find(match).toArray();
  let recovered = 0;

  for (const a of attempts) {
    const order = await col('orders').findOne({
      customer_id: a.customer_id,
      restaurant_id: restaurantId,
      created_at: { $gte: a.sent_at, $lte: new Date(new Date(a.sent_at).getTime() + 24 * 3600000) },
      status: { $nin: ['CANCELLED', 'PAYMENT_FAILED'] },
    });
    if (order) recovered++;
  }

  return {
    total_sent: attempts.length,
    recovered,
    recovery_rate: attempts.length ? Math.round(recovered / attempts.length * 1000) / 10 : 0,
  };
}

function _emptyResult() {
  return {
    summary: { total_initiated: 0, dropped_at_address: 0, dropped_at_browsing: 0, dropped_at_cart: 0, dropped_at_payment: 0, payment_failed: 0, completed: 0, completion_rate: 0 },
    funnel: FUNNEL_ORDER.map(s => ({ stage: s, count: 0, pct: 0 })),
    dropoffs: [],
  };
}

module.exports = {
  getDropoffs,
  getDropoffDetails,
  getRecoverableDropoffs,
  getRecoveryStats,
};
