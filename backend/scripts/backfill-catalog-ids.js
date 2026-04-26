// One-time backfill: populate missing catalog_id fields across collections
// for any restaurant where one source has it and another doesn't.
//
// Idempotent — only patches when the target field is missing or falsy. Safe
// to re-run. Does NOT modify Meta. Does NOT touch records that already have
// a catalog_id set.
//
// Schema note: this codebase uses `restaurants._id` as the foreign key.
// There is no `restaurants.restaurant_id` field — other collections
// reference it via `restaurant_id`.

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { MongoClient } = require('mongodb');

async function main() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'gullybite');

  const restaurants = await db.collection('restaurants').find({}).toArray();

  for (const r of restaurants) {
    const rid = r._id;
    const wa = await db.collection('whatsapp_accounts').findOne({ restaurant_id: rid });

    // Authoritative catalog_id: prefer restaurants.meta_catalog_id, then
    // fall back to whatsapp_accounts.catalog_id.
    const catalogId = r.meta_catalog_id || wa?.catalog_id;
    if (!catalogId) {
      console.log(`SKIP ${r.business_name} (${rid}) — no catalog_id found anywhere`);
      continue;
    }

    if (!r.meta_catalog_id) {
      await db.collection('restaurants').updateOne(
        { _id: rid },
        { $set: { meta_catalog_id: catalogId } }
      );
      console.log(`PATCHED restaurant ${r.business_name} → meta_catalog_id: ${catalogId}`);
    }

    if (wa && !wa.catalog_id) {
      await db.collection('whatsapp_accounts').updateOne(
        { restaurant_id: rid },
        { $set: { catalog_id: catalogId, catalog_linked: true, cart_enabled: true, catalog_visible: true } }
      );
      console.log(`PATCHED whatsapp_accounts for ${r.business_name} → catalog_id: ${catalogId}`);
    }

    const branchResult = await db.collection('branches').updateMany(
      { restaurant_id: rid, catalog_id: { $exists: false } },
      { $set: { catalog_id: catalogId } }
    );
    if (branchResult.modifiedCount > 0) {
      console.log(`PATCHED ${branchResult.modifiedCount} branches for ${r.business_name}`);
    }

    console.log(`OK ${r.business_name} — catalog_id: ${catalogId}`);
  }

  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
