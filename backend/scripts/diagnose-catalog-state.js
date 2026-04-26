require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { MongoClient } = require('mongodb');

async function main() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'gullybite');

  // Schema note: this codebase uses `restaurants._id` as the foreign key.
  // There is no `restaurants.restaurant_id` field. All other collections
  // reference it via `restaurant_id`.
  const restaurant = await db.collection('restaurants').findOne(
    {},
    { projection: { business_name: 1, meta_catalog_id: 1, meta_business_id: 1 } }
  );
  console.log('\n=== RESTAURANT ===');
  console.log(JSON.stringify(restaurant, null, 2));
  const restaurantId = restaurant._id;

  const wa = await db.collection('whatsapp_accounts').findOne(
    { restaurant_id: restaurantId }
  );
  console.log('\n=== WHATSAPP_ACCOUNTS ===');
  console.log(JSON.stringify({
    restaurant_id: wa?.restaurant_id,
    catalog_id: wa?.catalog_id,
    catalog_linked: wa?.catalog_linked,
    cart_enabled: wa?.cart_enabled,
    catalog_visible: wa?.catalog_visible,
    phone_number_id: wa?.phone_number_id,
    waba_id: wa?.waba_id
  }, null, 2));

  const branches = await db.collection('branches').find(
    { restaurant_id: restaurantId },
    { projection: { name: 1, catalog_id: 1, is_active: 1 } }
  ).toArray();
  console.log('\n=== BRANCHES ===');
  console.log(JSON.stringify(branches, null, 2));

  const itemCount = await db.collection('menu_items').countDocuments(
    { restaurant_id: restaurantId, is_available: true }
  );
  const sampleItems = await db.collection('menu_items').find(
    { restaurant_id: restaurantId, is_available: true },
    { projection: { name: 1, retailer_id: 1, branch_id: 1 } }
  ).limit(5).toArray();
  console.log('\n=== MENU ITEMS ===');
  console.log('Available count:', itemCount);
  console.log('Sample items:', JSON.stringify(sampleItems, null, 2));

  // Per-branch availability — what the address-flow router actually sees
  // when it dispatches to buildBranchMPMs(branch_id).
  console.log('\n=== ITEMS BY BRANCH (active branches only) ===');
  for (const b of branches.filter((b) => b.is_active)) {
    const n = await db.collection('menu_items').countDocuments({
      branch_id: b._id, is_available: true,
    });
    console.log(`  ${b.name} (${b._id}): ${n} available`);
  }

  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
