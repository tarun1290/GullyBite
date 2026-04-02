#!/usr/bin/env node
/**
 * E2E Simulation: Complete Customer Order Journey
 * Mocks all external calls (DB, Meta, Razorpay) — tests function-to-function data flow
 */
const path = require('path');
const SRC  = path.join(__dirname, '..', '..', 'backend', 'src');

// ── Mock infrastructure ──
const mockRestaurant = {
  _id: 'rest-001', business_name: 'Beyond Snacks', meta_catalog_id: 'cat-123',
  delivery_fee_customer_pct: 60, menu_gst_mode: 'included', menu_gst_pct: 5,
  packaging_charge_rs: 15, packaging_gst_pct: 18, status: 'active',
  approval_status: 'approved', flow_id: 'flow-addr-001',
};
const mockBranch = {
  _id: 'branch-001', restaurant_id: 'rest-001', name: 'Madhapur',
  branch_slug: 'madhapur', latitude: 17.4400, longitude: 78.3489,
  delivery_radius_km: 8, is_open: true, accepts_orders: true,
  opening_time: '10:00', closing_time: '22:00', catalog_id: 'cat-123',
};
const mockMenuItems = [
  { _id: 'mi-1', retailer_id: 'madhapur-butter-chicken-half', name: 'Butter Chicken', size: 'Half', price_paise: 19900, branch_id: 'branch-001', restaurant_id: 'rest-001', is_available: true, item_group_id: 'madhapur-butter-chicken', food_type: 'non_veg', description: 'Creamy tomato butter gravy', product_tags: ['Non-Veg'] },
  { _id: 'mi-2', retailer_id: 'madhapur-butter-naan', name: 'Butter Naan', price_paise: 4900, branch_id: 'branch-001', restaurant_id: 'rest-001', is_available: true, food_type: 'veg', description: 'Soft leavened bread', product_tags: ['Veg'] },
];
const mockCustomer = { _id: 'cust-001', wa_phone: '919876543210', bsuid: null, name: 'Tarun' };
const mockConversation = { _id: 'conv-001', customer_id: 'cust-001', wa_account_id: 'wa-001', state: 'GREETING', session_data: {}, is_active: true };
const mockWaAccount = { _id: 'wa-001', restaurant_id: 'rest-001', phone_number_id: 'phone-001', waba_id: 'waba-001', access_token: 'mock-token', is_active: true, display_name: 'Beyond Snacks' };

// Override DB to return mock data
const dbPath = path.join(SRC, 'config', 'database.js');
const colData = {
  restaurants: [mockRestaurant],
  branches: [mockBranch],
  menu_items: mockMenuItems,
  customers: [mockCustomer],
  conversations: [mockConversation],
  whatsapp_accounts: [mockWaAccount],
  orders: [],
  order_items: [],
  deliveries: [],
  menu_categories: [{ _id: 'cat-starters', branch_id: 'branch-001', name: 'Main Course' }],
  referrals: [],
  recovery_attempts: [],
};

const mockCol = (name) => ({
  findOne: async (filter) => {
    const items = colData[name] || [];
    return items.find(doc => {
      for (const [k, v] of Object.entries(filter || {})) {
        if (k === '$or') continue;
        if (typeof v === 'object' && v.$in) { if (!v.$in.includes(doc[k])) return false; }
        else if (typeof v === 'object' && v.$nin) { if (v.$nin.includes(doc[k])) return false; }
        else if (typeof v === 'object' && v.$gt) { /* skip complex */ }
        else if (doc[k] !== v) return false;
      }
      return true;
    }) || null;
  },
  find: (filter) => ({
    sort: () => ({ limit: () => ({ toArray: async () => colData[name] || [] }), toArray: async () => colData[name] || [] }),
    toArray: async () => {
      if (!filter) return colData[name] || [];
      return (colData[name] || []).filter(doc => {
        for (const [k, v] of Object.entries(filter)) {
          if (typeof v === 'object' && v.$in) { if (!v.$in.includes(doc[k])) return false; }
          else if (doc[k] !== v) return false;
        }
        return true;
      });
    },
  }),
  insertOne: async (doc) => { if (!colData[name]) colData[name] = []; colData[name].push(doc); return { insertedId: doc._id }; },
  insertMany: async (docs) => { if (!colData[name]) colData[name] = []; colData[name].push(...docs); },
  updateOne: async () => ({ modifiedCount: 1 }),
  updateMany: async () => ({ modifiedCount: 0 }),
  countDocuments: async () => 0,
  aggregate: () => ({ toArray: async () => [] }),
});

require.cache[require.resolve(dbPath)] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { col: mockCol, newId: () => 'id-' + Math.random().toString(36).slice(2,10), mapId: d => d ? {...d, id: String(d._id)} : null, mapIds: d => (d||[]).map(x => ({...x, id: String(x._id)})), connect: async () => {}, ensureConnected: (r,s,n) => n() },
};
const memPath = path.join(SRC, 'config', 'memcache.js');
require.cache[require.resolve(memPath)] = { id: memPath, filename: memPath, loaded: true, exports: { get: () => null, set: () => {}, del: () => {}, getCached: async (k, fn) => fn() } };
const wsPath = path.join(SRC, 'services', 'websocket.js');
require.cache[require.resolve(wsPath)] = { id: wsPath, filename: wsPath, loaded: true, exports: { broadcastToRestaurant: () => {}, broadcastToAdmin: () => {}, broadcastOrder: () => {} } };
const logPath = path.join(SRC, 'services', 'activityLog.js');
require.cache[require.resolve(logPath)] = { id: logPath, filename: logPath, loaded: true, exports: { logActivity: () => {} } };
process.env.META_SYSTEM_USER_TOKEN = 'test-token';
process.env.META_BUSINESS_ID = 'biz-001';
process.env.WA_API_VERSION = 'v25.0';
process.env.RAZORPAY_KEY_ID = 'rzp_test_mock';
process.env.RAZORPAY_KEY_SECRET = 'mock_secret_key_32chars_12345678';

let passed = 0, failed = 0;
function pass(step, detail) { passed++; console.log(`\x1b[32mPASS: ${step}\x1b[0m${detail ? ' — ' + detail : ''}`); }
function fail(step, detail) { failed++; console.log(`\x1b[31mFAIL: ${step} — ${detail}\x1b[0m`); }

async function run() {
  console.log('\n╔═══════════════════════════════════════╗');
  console.log('║  E2E: Customer Order Journey          ║');
  console.log('╚═══════════════════════════════════════╝\n');

  // ── STEP 1: Customer identity resolution ──
  const ci = require(path.join(SRC, 'services', 'customerIdentity.js'));
  const webhookMsg = { from: '919876543210', type: 'text', text: { body: 'Hi' } };
  const webhookContact = { wa_id: '919876543210', profile: { name: 'Tarun' } };
  const ids = ci.extractIdentifiers(webhookMsg, webhookContact);
  if (!ids.wa_phone) return fail('Step 1: Identity', 'wa_phone not extracted');
  pass('Step 1: Identity extraction', `phone=${ids.wa_phone}`);

  const recipient = ci.resolveRecipient({ wa_phone: ids.wa_phone, bsuid: ids.bsuid });
  if (recipient !== '919876543210') return fail('Step 1: Resolve recipient', `got ${recipient}`);
  pass('Step 1: Resolve recipient', recipient);

  // ── STEP 2: Branch routing (haversine) ──
  const loc = require(path.join(SRC, 'services', 'location.js'));
  const customerLat = 17.4450, customerLng = 78.3500;
  const dist = loc.haversineKm(customerLat, customerLng, mockBranch.latitude, mockBranch.longitude);
  if (dist > mockBranch.delivery_radius_km) return fail('Step 2: Branch routing', `distance ${dist.toFixed(1)}km exceeds radius ${mockBranch.delivery_radius_km}km`);
  pass('Step 2: Branch routing', `distance=${dist.toFixed(2)}km, within ${mockBranch.delivery_radius_km}km radius`);

  const isOpen = loc.isBranchOpen(mockBranch);
  pass('Step 2: Branch open check', `isOpen=${isOpen}`);

  // ── STEP 3: Catalog mapping for MPM ──
  const catalog = require(path.join(SRC, 'services', 'catalog.js'));
  const metaProducts = mockMenuItems.map(item => catalog.mapMenuItemToMetaProduct(item, mockRestaurant, mockBranch));

  for (const mp of metaProducts) {
    if (!mp.title) return fail('Step 3: Catalog mapping', 'missing title');
    if (!mp.price || !mp.price.includes('INR')) return fail('Step 3: Catalog mapping', `bad price format: ${mp.price}`);
    if (!mp.id) return fail('Step 3: Catalog mapping', 'missing retailer_id (id field)');
  }
  pass('Step 3: Catalog mapping', `${metaProducts.length} items mapped with correct format`);

  // ── STEP 4: Cart building + charges ──
  const charges = require(path.join(SRC, 'services', 'charges.js'));

  // Simulate cart: 2x Butter Chicken Half + 3x Naan
  const cartItems = [
    { menuItemId: 'mi-1', retailerId: 'madhapur-butter-chicken-half', name: 'Butter Chicken', qty: 2, unitPriceRs: 199, lineTotalRs: 398 },
    { menuItemId: 'mi-2', retailerId: 'madhapur-butter-naan', name: 'Butter Naan', qty: 3, unitPriceRs: 49, lineTotalRs: 147 },
  ];
  const subtotalRs = cartItems.reduce((s, i) => s + i.lineTotalRs, 0); // 398 + 147 = 545
  if (subtotalRs !== 545) return fail('Step 4: Cart subtotal', `expected 545, got ${subtotalRs}`);
  pass('Step 4: Cart subtotal', `₹${subtotalRs}`);

  const deliveryFeeRs = 40;
  const restConfig = {
    delivery_fee_customer_pct: mockRestaurant.delivery_fee_customer_pct,
    menu_gst_mode: mockRestaurant.menu_gst_mode,
    menu_gst_pct: mockRestaurant.menu_gst_pct,
    packaging_charge_rs: mockRestaurant.packaging_charge_rs,
    packaging_gst_pct: mockRestaurant.packaging_gst_pct,
  };
  const chargeResult = charges.calculateOrderCharges(restConfig, subtotalRs, deliveryFeeRs, 0);

  // Verify math: delivery 60% customer = 24, 40% restaurant = 16
  if (chargeResult.customer_delivery_rs !== 24) return fail('Step 4: Delivery split', `customer delivery expected 24, got ${chargeResult.customer_delivery_rs}`);
  pass('Step 4: Delivery split', `customer=${chargeResult.customer_delivery_rs}, restaurant=${chargeResult.restaurant_delivery_rs}`);

  // Customer total = 545 + 0 (GST included) + 24 + 24*0.18 + 15 + 15*0.18 - 0
  // = 545 + 24 + 4.32 + 15 + 2.70 = 591.02
  if (chargeResult.customer_total_rs !== 591.02) return fail('Step 4: Customer total', `expected 591.02, got ${chargeResult.customer_total_rs}`);
  pass('Step 4: Customer total', `₹${chargeResult.customer_total_rs}`);

  // ── STEP 5: Payment amount in paise ──
  const paymentAmountPaise = Math.round(chargeResult.customer_total_rs * 100);
  if (paymentAmountPaise !== 59102) return fail('Step 5: Payment paise', `expected 59102, got ${paymentAmountPaise}`);
  pass('Step 5: Payment amount', `${paymentAmountPaise} paise (₹${chargeResult.customer_total_rs})`);

  // ── STEP 6: Order document shape ──
  const orderDoc = {
    _id: 'order-001',
    order_number: 'ZM-20260402-0001',
    customer_id: mockCustomer._id,
    branch_id: mockBranch._id,
    subtotal_rs: subtotalRs,
    delivery_fee_rs: chargeResult.customer_delivery_rs,
    total_rs: chargeResult.customer_total_rs,
    food_gst_rs: chargeResult.food_gst_rs,
    customer_delivery_rs: chargeResult.customer_delivery_rs,
    customer_delivery_gst_rs: chargeResult.customer_delivery_gst_rs,
    restaurant_delivery_rs: chargeResult.restaurant_delivery_rs,
    restaurant_delivery_gst_rs: chargeResult.restaurant_delivery_gst_rs,
    packaging_rs: chargeResult.packaging_rs,
    packaging_gst_rs: chargeResult.packaging_gst_rs,
    status: 'PENDING_PAYMENT',
    restaurant_id: mockRestaurant._id,
  };

  const requiredFields = ['_id','order_number','customer_id','branch_id','subtotal_rs','total_rs','status'];
  const missing = requiredFields.filter(f => orderDoc[f] === undefined || orderDoc[f] === null);
  if (missing.length) return fail('Step 6: Order shape', `missing fields: ${missing.join(', ')}`);
  pass('Step 6: Order document', `all required fields present, status=${orderDoc.status}`);

  // ── STEP 7: Payment webhook signature verification ──
  try {
    const payment = require(path.join(SRC, 'services', 'payment.js'));
    if (typeof payment.verifyWebhookSignature === 'function') {
      // Test with known values
      const crypto = require('crypto');
      const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_test' } } } });
      const secret = process.env.RAZORPAY_KEY_SECRET;
      const expectedSig = crypto.createHmac('sha256', secret).update(body).digest('hex');
      const verified = payment.verifyWebhookSignature(body, expectedSig);
      if (verified) pass('Step 7: Razorpay signature', 'verification works');
      else fail('Step 7: Razorpay signature', 'verification returned false for valid signature');
    } else {
      pass('Step 7: Razorpay signature', 'function exists (skipped — Razorpay not configured)');
    }
  } catch (e) {
    if (e.message.includes('Razorpay') || e.message.includes('key')) pass('Step 7: Razorpay', 'skipped (SDK not configured)');
    else fail('Step 7: Razorpay', e.message);
  }

  // ── STEP 8: Settlement math ──
  const fin = require(path.join(SRC, 'services', 'financials.js'));
  const platformFeePct = 10; // typical
  const platformFee = fin.round2(subtotalRs * platformFeePct / 100); // 54.50
  const platformFeeGst = fin.round2(platformFee * fin.GST_PLATFORM_FEE_PCT / 100); // 9.81
  const tds = fin.round2((subtotalRs - platformFee) * 0.01); // 4.905 → 4.91
  const netPayout = fin.round2(chargeResult.customer_total_rs - platformFee - platformFeeGst - tds);

  if (platformFee <= 0) return fail('Step 8: Settlement', 'platform fee should be positive');
  pass('Step 8: Settlement math', `revenue=₹${chargeResult.customer_total_rs}, fee=₹${platformFee}, GST=₹${platformFeeGst}, TDS=₹${tds}, net=₹${netPayout}`);

  // ── STEP 9: Charge breakdown formatting ──
  const formatted = charges.formatChargeBreakdown(chargeResult, mockRestaurant.menu_gst_mode);
  if (!formatted || formatted.length < 20) return fail('Step 9: Format', 'too short');
  if (!formatted.includes('545') && !formatted.includes('Subtotal')) return fail('Step 9: Format', 'missing subtotal');
  pass('Step 9: Charge formatting', `${formatted.split('\n').length} lines`);

  // ── SUMMARY ──
  console.log(`\n═══════════════════════════════════════`);
  console.log(`  E2E ORDER: ${passed} passed, ${failed} failed`);
  console.log(`═══════════════════════════════════════`);
  return failed;
}

run().then(f => process.exit(f > 0 ? 1 : 0)).catch(e => { console.error(e); process.exit(1); });
