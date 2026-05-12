#!/usr/bin/env node
// seed-tag-taxonomy.js
// One-time seed: write the canonical tag taxonomy used by the City Captain
// flow into platform_settings under _id 'tag_taxonomy'. Idempotent — if the
// doc already exists this script no-ops.

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), quiet: true });

const { connect, col } = require('../src/config/database');

async function main() {
  await connect();

  const existing = await col('platform_settings').findOne({ _id: 'tag_taxonomy' });
  if (existing) {
    console.log('already seeded');
    setTimeout(() => process.exit(0), 500);
    return;
  }

  await col('platform_settings').insertOne({
    _id: 'tag_taxonomy',
    version: 1,
    cuisine_primary: [
      'North Indian','South Indian','Andhra','Hyderabadi','Chettinad',
      'Kerala','Tamil','Bengali','Gujarati','Maharashtrian','Rajasthani',
      'Goan','Punjabi','Mughlai','Chinese','Indo-Chinese','Thai','Japanese',
      'Korean','Italian','Continental','Mexican','American','Mediterranean',
      'Cafe','Bakery','Desserts','Beverages','Street Food','Healthy',
      'Biryani','Seafood','Rolls & Wraps','Pizza','Burgers'
    ],
    price_bands: [
      { key:'budget', label:'Under ₹200', min_rs:0, max_rs:200 },
      { key:'mid', label:'₹200–500', min_rs:200, max_rs:500 },
      { key:'premium', label:'₹500–1000', min_rs:500, max_rs:1000 },
      { key:'luxury', label:'Above ₹1000', min_rs:1000, max_rs:null }
    ],
    veg_status_options: ['veg','non-veg','both'],
    vibe_tags: [
      'casual','family','date-spot','business',
      'late-night','group-friendly','solo-friendly','quick-bite'
    ],
    meal_contexts: ['breakfast','brunch','lunch','dinner','late-night','snack','all-day'],
    service_modes: ['dine-in','takeaway','delivery'],
    dietary_flags: [
      'jain-friendly','halal-certified','egg-free',
      'gluten-free-options','vegan-options'
    ],
    specialty_tags_approved: [],
    hyderabad_areas: [
      'Banjara Hills','Jubilee Hills','Madhapur','Gachibowli','Hitec City',
      'Kondapur','Begumpet','Ameerpet','Secunderabad','Kukatpally',
      'Somajiguda','Himayatnagar','Abids','Mehdipatnam','LB Nagar',
      'Dilsukhnagar','Uppal','Miyapur','Bachupally','Nallagandla',
      'Manikonda','Nanakramguda','Film Nagar','Khairatabad','Masab Tank'
    ],
    updated_at: new Date()
  });

  console.log('seeded tag_taxonomy');

  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
