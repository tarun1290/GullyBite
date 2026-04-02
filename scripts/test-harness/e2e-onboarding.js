#!/usr/bin/env node
/**
 * E2E Simulation: Restaurant Onboarding + Menu Upload + Catalog Sync
 */
const path = require('path');
const SRC  = path.join(__dirname, '..', '..', 'backend', 'src');

// ── Mock DB ──
const dbPath = path.join(SRC, 'config', 'database.js');
const store = {};
const mockCol = (name) => {
  if (!store[name]) store[name] = [];
  return {
    findOne: async (f) => store[name].find(d => { for (const [k,v] of Object.entries(f||{})) { if (typeof v !== 'object' && d[k] !== v) return false; } return true; }) || null,
    find: (f) => ({ sort: () => ({ limit: () => ({ toArray: async () => store[name] }), toArray: async () => store[name] }), toArray: async () => store[name] }),
    insertOne: async (doc) => { store[name].push(doc); return { insertedId: doc._id }; },
    insertMany: async (docs) => { store[name].push(...docs); },
    updateOne: async (f, u) => {
      const doc = store[name].find(d => { for (const [k,v] of Object.entries(f||{})) { if (typeof v !== 'object' && d[k] !== v) return false; } return true; });
      if (doc && u.$set) Object.assign(doc, u.$set);
      if (doc && u.$setOnInsert && !store[name].some(d => d._id === doc._id)) Object.assign(doc, u.$setOnInsert);
      return { modifiedCount: doc ? 1 : 0 };
    },
    updateMany: async () => ({ modifiedCount: 0 }),
    countDocuments: async () => store[name].length,
    aggregate: () => ({ toArray: async () => [] }),
    deleteOne: async () => ({ deletedCount: 1 }),
  };
};
require.cache[require.resolve(dbPath)] = { id: dbPath, filename: dbPath, loaded: true, exports: { col: mockCol, newId: () => 'id-'+Math.random().toString(36).slice(2,10), mapId: d => d?{...d,id:String(d._id)}:null, mapIds: d => (d||[]).map(x=>({...x,id:String(x._id)})), connect: async()=>{}, ensureConnected:(r,s,n)=>n() } };
const memPath = path.join(SRC, 'config', 'memcache.js');
require.cache[require.resolve(memPath)] = { id: memPath, filename: memPath, loaded: true, exports: { get:()=>null, set:()=>{}, del:()=>{}, getCached: async(k,fn)=>fn() } };
const wsPath = path.join(SRC, 'services', 'websocket.js');
require.cache[require.resolve(wsPath)] = { id: wsPath, filename: wsPath, loaded: true, exports: { broadcastToRestaurant:()=>{}, broadcastToAdmin:()=>{}, broadcastOrder:()=>{} } };
const logPath = path.join(SRC, 'services', 'activityLog.js');
require.cache[require.resolve(logPath)] = { id: logPath, filename: logPath, loaded: true, exports: { logActivity:()=>{} } };
process.env.META_SYSTEM_USER_TOKEN = 'test-token';
process.env.META_BUSINESS_ID = 'biz-001';
process.env.WA_API_VERSION = 'v25.0';

let passed = 0, failed = 0;
function pass(s, d) { passed++; console.log(`\x1b[32mPASS: ${s}\x1b[0m${d?' — '+d:''}`); }
function fail(s, d) { failed++; console.log(`\x1b[31mFAIL: ${s} — ${d}\x1b[0m`); }

async function run() {
  console.log('\n╔═══════════════════════════════════════╗');
  console.log('║  E2E: Restaurant Onboarding           ║');
  console.log('╚═══════════════════════════════════════╝\n');

  // ── STEP 1: Restaurant document ──
  const restDoc = {
    _id: 'rest-test', business_name: 'Test Kitchen', brand_name: 'Test Kitchen',
    owner_name: 'Chef Test', phone: '919999999999', city: 'Bangalore',
    menu_gst_mode: 'included', delivery_fee_customer_pct: 100,
    packaging_charge_rs: 10, packaging_gst_pct: 18, status: 'active',
    approval_status: 'approved', onboarding_step: 2,
  };
  store.restaurants = [restDoc];
  const required = ['_id', 'business_name', 'status', 'onboarding_step'];
  const missing = required.filter(f => !restDoc[f]);
  if (missing.length) return fail('Step 1: Restaurant doc', `missing: ${missing.join(', ')}`);
  pass('Step 1: Restaurant created', restDoc.business_name);

  // ── STEP 2: Branch with address ──
  function slugify(str, maxLen = 40) { return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, maxLen); }

  const branchDoc = {
    _id: 'br-test', restaurant_id: 'rest-test', name: 'Koramangala',
    branch_slug: slugify('Koramangala', 20), address: '5th Block, Koramangala, Bangalore',
    city: 'Bangalore', latitude: 12.9352, longitude: 77.6245,
    delivery_radius_km: 5, is_open: true, accepts_orders: true,
    opening_time: '10:00', closing_time: '22:00',
  };
  store.branches = [branchDoc];

  if (!branchDoc.latitude || !branchDoc.longitude) return fail('Step 2: Branch GPS', 'missing coordinates');
  if (!branchDoc.branch_slug) return fail('Step 2: Branch slug', 'missing slug');
  if (branchDoc.branch_slug !== 'koramangala') return fail('Step 2: Branch slug', `expected 'koramangala', got '${branchDoc.branch_slug}'`);
  pass('Step 2: Branch created', `${branchDoc.name} (${branchDoc.branch_slug}) at ${branchDoc.latitude},${branchDoc.longitude}`);

  // ── STEP 3: Menu items with variants ──
  function makeRetailerId(branchSlug, name, size) {
    const itemSlug = slugify(name, 40);
    if (size) return `${branchSlug}-${itemSlug}-${slugify(size, 15)}`;
    return `${branchSlug}-${itemSlug}`;
  }
  function makeItemGroupId(branchSlug, name) { return `${branchSlug}-${slugify(name, 40)}`; }

  const uploadItems = [
    { title: 'Chicken Biryani', price: '249', size: 'Single', category: 'Biryani', food_type: 'non_veg' },
    { title: 'Chicken Biryani', price: '599', size: 'Family', category: 'Biryani', food_type: 'non_veg' },
    { title: 'Dal Makhani', price: '219', category: 'Main Course', food_type: 'veg' },
    { title: 'Butter Naan', price: '49', category: 'Breads', food_type: 'veg' },
    { title: 'Paneer Tikka', price: '269', category: 'Starters', food_type: 'veg' },
    { title: 'Mango Lassi', price: '99', size: 'Regular', category: 'Beverages', food_type: 'veg' },
    { title: 'Mango Lassi', price: '149', size: 'Large', category: 'Beverages', food_type: 'veg' },
  ];

  // Simulate the upload processing
  const createdItems = [];
  for (const raw of uploadItems) {
    const sizeVal = raw.size || null;
    const rid = makeRetailerId(branchDoc.branch_slug, raw.title, sizeVal);
    const autoGroupId = sizeVal ? makeItemGroupId(branchDoc.branch_slug, raw.title) : null;
    const pricePaise = Math.round(parseFloat(raw.price) * 100);

    const item = {
      _id: 'item-' + Math.random().toString(36).slice(2, 8),
      restaurant_id: restDoc._id,
      branch_id: branchDoc._id,
      name: raw.title,
      description: raw.title,
      price_paise: pricePaise,
      retailer_id: rid,
      item_group_id: autoGroupId,
      size: sizeVal,
      food_type: raw.food_type || 'veg',
      is_available: true,
      product_tags: [],
    };
    createdItems.push(item);
  }
  store.menu_items = createdItems;

  // Verify retailer_id format
  const rid1 = createdItems[0].retailer_id;
  if (rid1 !== 'koramangala-chicken-biryani-single') return fail('Step 3: retailer_id', `expected 'koramangala-chicken-biryani-single', got '${rid1}'`);
  pass('Step 3: retailer_id format', rid1);

  // Verify variant grouping
  const biryanis = createdItems.filter(i => i.name === 'Chicken Biryani');
  const biryaniGroupIds = biryanis.map(i => i.item_group_id);
  if (biryaniGroupIds[0] !== biryaniGroupIds[1]) return fail('Step 3: item_group_id', `variants have different group IDs: ${biryaniGroupIds.join(', ')}`);
  if (biryaniGroupIds[0] !== 'koramangala-chicken-biryani') return fail('Step 3: item_group_id format', `expected 'koramangala-chicken-biryani', got '${biryaniGroupIds[0]}'`);
  pass('Step 3: Variant grouping', `Chicken Biryani: 2 sizes, group=${biryaniGroupIds[0]}`);

  const lassis = createdItems.filter(i => i.name === 'Mango Lassi');
  if (lassis[0].item_group_id !== lassis[1].item_group_id) return fail('Step 3: Lassi variants', 'different group IDs');
  pass('Step 3: Lassi variant grouping', `group=${lassis[0].item_group_id}`);

  // Non-variant items should have null item_group_id
  const dal = createdItems.find(i => i.name === 'Dal Makhani');
  if (dal.item_group_id !== null) return fail('Step 3: Non-variant item_group_id', `expected null, got '${dal.item_group_id}'`);
  pass('Step 3: Non-variant has null item_group_id', 'correct');

  pass('Step 3: Menu upload', `${createdItems.length} items created`);

  // ── STEP 4: Meta catalog payload ──
  const catalog = require(path.join(SRC, 'services', 'catalog.js'));

  const metaPayloads = createdItems.map(item => catalog.mapMenuItemToMetaProduct(item, restDoc, branchDoc));
  const payloadErrors = [];

  for (let i = 0; i < metaPayloads.length; i++) {
    const mp = metaPayloads[i];
    if (!mp.title) payloadErrors.push(`item ${i}: missing title`);
    if (!mp.price || !mp.price.includes('INR')) payloadErrors.push(`item ${i}: bad price format '${mp.price}'`);
    if (!mp.id) payloadErrors.push(`item ${i}: missing retailer_id`);
    if (!mp.image_link) payloadErrors.push(`item ${i}: missing image_link`);
    if (mp.description && mp.description.length < 10) payloadErrors.push(`item ${i}: description too short`);
  }

  if (payloadErrors.length) return fail('Step 4: Meta payload', payloadErrors.join('; '));
  pass('Step 4: Meta catalog payload', `${metaPayloads.length} items mapped correctly`);

  // Verify variant items share item_group_id in Meta payload
  const metaBiryanis = metaPayloads.filter(p => p.title === 'Chicken Biryani');
  if (metaBiryanis.length !== 2) return fail('Step 4: Variant count', `expected 2 biryani payloads, got ${metaBiryanis.length}`);
  if (metaBiryanis[0].item_group_id !== metaBiryanis[1].item_group_id) return fail('Step 4: Variant group in Meta', 'different group IDs in Meta payload');
  pass('Step 4: Variants in Meta payload', `same item_group_id=${metaBiryanis[0].item_group_id}`);

  // ── STEP 5: Validate all items pass Meta compliance ──
  let validCount = 0;
  for (const item of createdItems) {
    const v = catalog.validateItemForMeta(item);
    if (!v.valid) return fail('Step 5: Meta validation', `${item.name}: ${v.errors.join(', ')}`);
    validCount++;
  }
  pass('Step 5: Meta compliance', `${validCount}/${createdItems.length} items pass validation`);

  // ── STEP 6: Flow structure check ──
  const fm = require(path.join(SRC, 'services', 'flowManager.js'));
  const flow = fm.buildDeliveryFlowJson();
  if (!flow.screens || flow.screens.length < 3) return fail('Step 6: Delivery Flow', `only ${flow.screens?.length} screens`);
  pass('Step 6: Delivery Flow', `v${flow.version}, ${flow.screens.length} screens`);

  const addrs = [{ _id: 'a1', label: 'Home', full_address: '5th Block Koramangala' }];
  const flowAddrs = fm.formatAddressesForFlow(addrs);
  if (!flowAddrs.length || !flowAddrs[0].id) return fail('Step 6: Flow addresses', 'bad format');
  pass('Step 6: Flow address formatting', `${flowAddrs.length} address(es)`);

  // ── SUMMARY ──
  console.log(`\n═══════════════════════════════════════`);
  console.log(`  E2E ONBOARDING: ${passed} passed, ${failed} failed`);
  console.log(`═══════════════════════════════════════`);
  return failed;
}

run().then(f => process.exit(f > 0 ? 1 : 0)).catch(e => { console.error(e); process.exit(1); });
