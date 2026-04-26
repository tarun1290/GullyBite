require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { MongoClient } = require('mongodb');

async function main() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'gullybite');

  const restaurant = await db.collection('restaurants').findOne({});
  const wa = await db.collection('whatsapp_accounts').findOne(
    { restaurant_id: restaurant._id }
  );

  const token = process.env.META_SYSTEM_USER_TOKEN;
  const catalogId = restaurant.meta_catalog_id || wa?.catalog_id;
  const phoneNumberId = wa?.phone_number_id;
  const wabaId = wa?.waba_id;
  const apiVersion = process.env.META_API_VERSION || 'v21.0';
  const base = `https://graph.facebook.com/${apiVersion}`;

  console.log('\n=== USING ===');
  console.log('catalogId:', catalogId);
  console.log('phoneNumberId:', phoneNumberId);
  console.log('wabaId:', wabaId);
  console.log('token present:', !!token, 'length:', token?.length);

  console.log('\n=== TEST 1: Catalog exists on Meta ===');
  const r1 = await fetch(`${base}/${catalogId}?fields=id,name,product_count`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log(JSON.stringify(await r1.json(), null, 2));

  console.log('\n=== TEST 2: First 5 items in Meta catalog ===');
  const r2 = await fetch(`${base}/${catalogId}/products?fields=retailer_id,name&limit=5`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log(JSON.stringify(await r2.json(), null, 2));

  console.log('\n=== TEST 3: Catalog linked to WABA ===');
  const r3 = await fetch(`${base}/${wabaId}/product_catalogs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log(JSON.stringify(await r3.json(), null, 2));

  console.log('\n=== TEST 4: Phone number commerce settings ===');
  const r4 = await fetch(`${base}/${phoneNumberId}/whatsapp_commerce_settings`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log(JSON.stringify(await r4.json(), null, 2));

  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
