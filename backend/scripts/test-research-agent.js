#!/usr/bin/env node
// test-research-agent.js
// Smoke-test for menuResearchAgent.runResearchJob. Inserts a temp
// city_listings doc, runs the agent against it, prints whatever
// menu_snapshot got written (if any), then cleans up.
//
// Local: node backend/scripts/test-research-agent.js
// EC2:   node --env-file=/home/ubuntu/GullyBite/.env backend/scripts/test-research-agent.js

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), quiet: true });

const { connect, col, newId } = require('../src/config/database');
const redisClient = require('../src/queue/redis');
const { runResearchJob } = require('../src/services/menuResearchAgent');

async function main() {
  const db = await connect();

  if (!process.env.GOOGLE_SEARCH_API_KEY || !process.env.GOOGLE_SEARCH_CX_ID) {
    console.warn('GOOGLE_SEARCH_API_KEY or GOOGLE_SEARCH_CX_ID missing — agent will early-return.');
    console.warn('Proceeding anyway to exercise the guard path.');
  }

  // Find or pick a city to attach the test listing to. Prefer a real
  // Hyderabad city; fall back to inserting a throwaway one.
  let city = await col('cities').findOne({});
  let createdCity = false;
  if (!city) {
    city = {
      _id: newId(),
      name: 'Hyderabad',
      slug: `test-hyd-${Date.now()}`,
      phone_number_id: `test-pn-${Date.now()}`,
      waba_id: null,
      display_name: 'Hyderabad',
      areas: [],
      status: 'setup',
      editorial_config: { hero_banner_url: null, featured_listings: [], curated_lists: [] },
      created_at: new Date(),
      updated_at: new Date(),
    };
    await col('cities').insertOne(city);
    createdCity = true;
    console.log(`Inserted temp city ${city._id} (${city.slug}).`);
  } else {
    console.log(`Using existing city ${city._id} (${city.name}).`);
  }

  const listingId = newId();
  const listing = {
    _id: listingId,
    city_id: city._id,
    name: 'Paradise Biryani',
    slug: `paradise-biryani-test-${Date.now()}`,
    area: 'Secunderabad',
    status: 'draft',
    fulfillment_mode: 'dine-in',
    research_status: 'pending',
    created_at: new Date(),
    updated_at: new Date(),
  };
  await col('city_listings').insertOne(listing);
  console.log(`Inserted temp listing ${listingId}.`);

  try {
    console.log('Running runResearchJob…');
    await runResearchJob(db, redisClient, listingId);

    const after = await col('city_listings').findOne({ _id: listingId });
    console.log('\nListing after run:');
    console.log(JSON.stringify(after, null, 2));

    const snapshot = await col('menu_snapshots')
      .find({ listing_id: listingId })
      .sort({ created_at: -1 })
      .limit(1)
      .toArray();
    if (snapshot.length === 0) {
      console.log('\nNo menu_snapshot was written. (Most likely cause: env guard or early-return.)');
    } else {
      const s = snapshot[0];
      console.log('\nLatest menu_snapshot:');
      console.log(JSON.stringify({
        _id: s._id,
        listing_id: s.listing_id,
        city_id: s.city_id,
        source: s.source,
        status: s.status,
        is_live: s.is_live,
        sources_cited: s.sources_cited,
        raw_extracted_texts_count: Array.isArray(s.raw_extracted_texts) ? s.raw_extracted_texts.length : 0,
        raw_extracted_texts_preview: Array.isArray(s.raw_extracted_texts)
          ? s.raw_extracted_texts.map((r) => ({ url: r.url, text_len: r.text?.length || 0, head: (r.text || '').slice(0, 120) }))
          : null,
        tags: s.tags,
        confidence_scores: s.confidence_scores,
        created_at: s.created_at,
        schema_version: s.schema_version,
      }, null, 2));
    }
  } finally {
    await col('city_listings').deleteOne({ _id: listingId });
    await col('menu_snapshots').deleteMany({ listing_id: listingId });
    if (createdCity) await col('cities').deleteOne({ _id: city._id });
    console.log('\nCleanup complete.');
  }

  try { await redisClient.quit(); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 300);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
