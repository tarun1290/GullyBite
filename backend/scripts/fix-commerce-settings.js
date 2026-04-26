require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { MongoClient } = require('mongodb');

async function main() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'gullybite');

  const restaurants = await db.collection('restaurants').find({
    meta_catalog_id: { $exists: true, $ne: null },
  }).toArray();

  const token = process.env.META_SYSTEM_USER_TOKEN;
  const apiVersion = process.env.META_API_VERSION || 'v21.0';
  const base = `https://graph.facebook.com/${apiVersion}`;

  for (const r of restaurants) {
    const wa = await db.collection('whatsapp_accounts').findOne(
      { restaurant_id: r._id.toString() }
    );
    if (!wa?.phone_number_id) {
      console.log(`SKIP ${r.business_name} — no phone_number_id`);
      continue;
    }

    const catalogId = r.meta_catalog_id || wa.catalog_id;
    if (!catalogId) {
      console.log(`SKIP ${r.business_name} — no catalog_id`);
      continue;
    }

    console.log(`\nFixing ${r.business_name}`);
    console.log(`  phone_number_id: ${wa.phone_number_id}`);
    console.log(`  catalog_id: ${catalogId}`);

    const res = await fetch(
      `${base}/${wa.phone_number_id}/whatsapp_commerce_settings`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          catalog_id: catalogId,
          is_catalog_visible: true,
          is_cart_enabled: true,
        }),
      }
    );
    const data = await res.json();

    if (data.success || data.id) {
      console.log(`  SUCCESS: commerce_settings updated`);
    } else {
      console.log(`  FAILED:`, JSON.stringify(data.error || data));
    }

    // Verify: GET back and confirm
    const verify = await fetch(
      `${base}/${wa.phone_number_id}/whatsapp_commerce_settings`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const vData = await verify.json();
    // Meta returns the linked catalog id under either `id` or `catalog_id`
    // depending on api version. Print both so we can see what's there.
    console.log(`  VERIFY raw: ${JSON.stringify(vData.data?.[0] || vData)}`);
    console.log(`  VERIFY catalog_id now: ${vData.data?.[0]?.catalog_id || vData.data?.[0]?.id || vData.catalog_id || 'unknown'}`);
    console.log(`  VERIFY is_cart_enabled: ${vData.data?.[0]?.is_cart_enabled ?? vData.is_cart_enabled}`);
  }

  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
