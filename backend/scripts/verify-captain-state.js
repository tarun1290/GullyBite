#!/usr/bin/env node
// verify-captain-state.js
// Read-only diagnostic for the captain feature. Runs five checks
// against MongoDB, prints OK / counts / sample names. NEVER writes.
//
// Local:  node backend/scripts/verify-captain-state.js
// EC2:    node --env-file=/home/ubuntu/GullyBite/.env backend/scripts/verify-captain-state.js

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), quiet: true });

const { connect, col } = require('../src/config/database');

function header(label) {
  console.log('\n=== ' + label + ' ===');
}

async function check1_business_type_contamination() {
  header('CHECK 1 — restaurants with legacy business_type=physical');
  const rows = await col('restaurants').find(
    { business_type: 'physical' },
    { projection: { _id: 1, business_name: 1, brand_name: 1 } },
  ).toArray();
  if (rows.length === 0) {
    console.log('OK: no contaminated business_type rows');
    return { ok: true };
  }
  console.warn(`WARN: ${rows.length} restaurant(s) have business_type='physical' (collides with brand-routing semantics)`);
  for (const r of rows) {
    const name = r.business_name || r.brand_name || '(no name)';
    console.warn(`  - ${r._id}  ${name}`);
  }
  return { ok: false, count: rows.length };
}

async function check2_handoff_without_link() {
  header('CHECK 2 — city_listings with fulfillment_mode=handoff but no linked_restaurant_id');
  const rows = await col('city_listings').find(
    {
      fulfillment_mode: 'handoff',
      $or: [{ linked_restaurant_id: null }, { linked_restaurant_id: { $exists: false } }],
      status: { $ne: 'deleted' },
    },
    { projection: { _id: 1, name: 1, slug: 1 } },
  ).toArray();
  console.log(`count: ${rows.length}`);
  for (const r of rows) console.warn(`  - ${r._id}  ${r.name} (${r.slug || '—'})`);
  return { ok: rows.length === 0, count: rows.length };
}

async function check3_unreengaged_intents() {
  header('CHECK 3 — notify_intents not fulfilled where listing is handoff');
  // Two-step: find handoff listing ids, then count intents.
  const handoffIds = await col('city_listings').find(
    { fulfillment_mode: 'handoff', status: { $ne: 'deleted' } },
    { projection: { _id: 1 } },
  ).toArray();
  if (handoffIds.length === 0) {
    console.log('count: 0 (no handoff listings)');
    return { ok: true, count: 0 };
  }
  const idList = handoffIds.map((l) => l._id);
  const count = await col('notify_intents').countDocuments({
    listing_id: { $in: idList },
    fulfilled: { $ne: true },
  });
  console.log(`count: ${count}`);
  if (count > 0) console.warn('These intents should have been re-engaged but weren\'t.');
  return { ok: count === 0, count };
}

async function check4_inbound_logs_ttl() {
  header('CHECK 4 — captain_inbound_logs TTL index');
  try {
    const indexes = await col('captain_inbound_logs').listIndexes().toArray();
    const ttl = indexes.find((ix) => ix.expireAfterSeconds && ix.key && ix.key.ts === 1);
    if (ttl) {
      console.log(`OK: ts TTL present (expireAfterSeconds=${ttl.expireAfterSeconds}, name=${ttl.name})`);
      return { ok: true };
    }
    console.warn('MISSING: no ts TTL index found on captain_inbound_logs');
    return { ok: false };
  } catch (err) {
    // listIndexes throws on missing collection — Mongo native driver
    // surfaces NamespaceNotFound; treat as "no logs yet so no TTL".
    console.warn('MISSING: captain_inbound_logs collection does not exist yet (no logs written)');
    return { ok: false };
  }
}

async function check5_tag_taxonomy() {
  header('CHECK 5 — platform_settings/_id=tag_taxonomy');
  const doc = await col('platform_settings').findOne({ _id: 'tag_taxonomy' });
  if (!doc) {
    console.warn('MISSING: tag_taxonomy doc not seeded');
    return { ok: false };
  }
  const cuisines = Array.isArray(doc.cuisine_primary) ? doc.cuisine_primary.length : 0;
  const version = typeof doc.version === 'number' ? doc.version : null;
  if (version === null || cuisines === 0) {
    console.warn(`PARTIAL: version=${version}, cuisine_primary.length=${cuisines}`);
    return { ok: false };
  }
  console.log(`OK: version=${version}, cuisine_primary.length=${cuisines}`);
  return { ok: true };
}

async function main() {
  await connect();
  const results = [];
  results.push(await check1_business_type_contamination());
  results.push(await check2_handoff_without_link());
  results.push(await check3_unreengaged_intents());
  results.push(await check4_inbound_logs_ttl());
  results.push(await check5_tag_taxonomy());

  header('SUMMARY');
  const passed = results.filter((r) => r.ok).length;
  console.log(`${passed} / ${results.length} checks OK`);
  setTimeout(() => process.exit(passed === results.length ? 0 : 1), 500);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(2); });
