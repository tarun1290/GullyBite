#!/usr/bin/env node
// seed-city-listings-places.js
// One-shot seeder: for a given city slug, page through Google Places
// Text Search (`restaurants in <area> <city>`) for each entry in
// city.areas[] and insert a minimal draft city_listings doc per place.
//
// Idempotent: existing listings (matched by city_id + case-insensitive
// name) are skipped, so re-running just fills in newly-discovered places.
//
// Usage:
//   node --env-file=/home/ubuntu/GullyBite/.env backend/scripts/seed-city-listings-places.js hyderabad
//   node backend/scripts/seed-city-listings-places.js hyderabad   (local)

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), quiet: true });

const { connect, col, newId } = require('../src/config/database');

const MAX_PAGES_PER_AREA = 3;
const PAGE_TOKEN_DELAY_MS = 2000; // Google requires ~2s before next_page_token activates

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPlacesPage({ apiKey, query, pageToken }) {
  let url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}`;
  if (pageToken) url += `&pagetoken=${encodeURIComponent(pageToken)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  return json;
}

async function seedArea({ apiKey, city, area }) {
  const query = `restaurants in ${area} ${city.name}`;
  let pageToken = null;
  let insertedForThisArea = 0;
  let skippedForThisArea = 0;

  for (let page = 0; page < MAX_PAGES_PER_AREA; page++) {
    if (pageToken) {
      // Google needs ~2s before the next_page_token becomes valid.
      await sleep(PAGE_TOKEN_DELAY_MS);
    }

    let json;
    try {
      json = await fetchPlacesPage({ apiKey, query, pageToken });
    } catch (err) {
      console.error(`  Fetch failed for area "${area}" page ${page + 1}: ${err.message}`);
      return { insertedForThisArea, skippedForThisArea };
    }

    const status = json.status;
    if (status === 'ZERO_RESULTS') {
      // Valid empty result — no error, just stop paging.
      break;
    }
    if (status !== 'OK') {
      const errMsg = json.error_message || '(no error_message)';
      console.error(`  Places API status="${status}" for area "${area}" page ${page + 1}: ${errMsg}`);
      return { insertedForThisArea, skippedForThisArea };
    }

    const results = Array.isArray(json.results) ? json.results : [];
    for (const place of results) {
      if (!place || !place.name) continue;
      const dup = await col('city_listings').findOne({
        city_id: city._id,
        name: { $regex: '^' + escapeRegex(place.name) + '$', $options: 'i' },
      });
      if (dup) {
        skippedForThisArea++;
        continue;
      }

      await col('city_listings').insertOne({
        _id: newId(),
        city_id: city._id,
        name: place.name,
        area,
        status: 'draft',
        research_status: 'pending',
        business_type: 'physical',
        fulfillment_mode: 'notify_only',
        website_url: place.website || null,
        phone_number: place.formatted_phone_number || null,
        lat: place.geometry?.location?.lat ?? null,
        lng: place.geometry?.location?.lng ?? null,
        address: place.formatted_address || null,
        place_id: place.place_id || null, // useful for future enrichment
        created_at: new Date(),
        updated_at: new Date(),
      });
      insertedForThisArea++;
    }

    pageToken = json.next_page_token || null;
    if (!pageToken) break;
  }

  return { insertedForThisArea, skippedForThisArea };
}

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error('Usage: node seed-city-listings-places.js <city-slug>');
    process.exit(1);
  }

  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.warn('GOOGLE_MAPS_API_KEY not set — skipping seeder.');
    process.exit(0);
  }

  await connect();

  const city = await col('cities').findOne({ slug });
  if (!city) {
    console.error(`City "${slug}" not found in cities collection.`);
    process.exit(1);
  }
  if (!Array.isArray(city.areas) || city.areas.length === 0) {
    console.error(`City "${slug}" has no areas. Set city.areas before seeding.`);
    process.exit(1);
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  let grandInserted = 0;
  let grandSkipped = 0;

  for (const area of city.areas) {
    const { insertedForThisArea, skippedForThisArea } = await seedArea({ apiKey, city, area });
    console.log(`Area: ${area} — ${insertedForThisArea} inserted, ${skippedForThisArea} skipped (duplicate)`);
    grandInserted += insertedForThisArea;
    grandSkipped += skippedForThisArea;
  }

  console.log(`\nTotal: ${grandInserted} inserted across ${city.areas.length} areas. ${grandSkipped} skipped as duplicates.`);
  console.log('Run POST /api/admin/cities/' + slug + '/research-all to begin research.');

  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
