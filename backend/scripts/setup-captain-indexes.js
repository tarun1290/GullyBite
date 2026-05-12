#!/usr/bin/env node
// setup-captain-indexes.js
// One-time setup: create the indexes required for the City Captain flow
// across cities, city_listings, menu_snapshots, city_captain_sessions,
// notify_intents, user_signals, tag_candidates, and admin_audit_logs (TTL).
//
// Idempotent: re-running is safe — Mongo treats an identical createIndex
// call as a no-op. Each index is wrapped in its own try/catch so one
// failure (e.g. a pre-existing conflicting index) doesn't block the rest.

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), quiet: true });

const { connect, col } = require('../src/config/database');

const INDEXES = [
  // cities
  { coll: 'cities', spec: { slug: 1 }, opts: { unique: true }, label: 'cities: slug unique' },
  { coll: 'cities', spec: { phone_number_id: 1 }, opts: { unique: true }, label: 'cities: phone_number_id unique' },

  // city_listings
  { coll: 'city_listings', spec: { city_id: 1, status: 1 }, opts: {}, label: 'city_listings: city_id+status' },
  { coll: 'city_listings', spec: { city_id: 1, fulfillment_mode: 1 }, opts: {}, label: 'city_listings: city_id+fulfillment_mode' },
  { coll: 'city_listings', spec: { city_id: 1, slug: 1 }, opts: { unique: true }, label: 'city_listings: city_id+slug unique' },
  { coll: 'city_listings', spec: { linked_restaurant_id: 1 }, opts: { sparse: true }, label: 'city_listings: linked_restaurant_id sparse' },

  // menu_snapshots
  { coll: 'menu_snapshots', spec: { listing_id: 1, is_live: 1 }, opts: {}, label: 'menu_snapshots: listing_id+is_live' },
  { coll: 'menu_snapshots', spec: { listing_id: 1, created_at: -1 }, opts: {}, label: 'menu_snapshots: listing_id+created_at desc' },

  // city_captain_sessions
  { coll: 'city_captain_sessions', spec: { customer_id: 1, city_id: 1 }, opts: { unique: true }, label: 'city_captain_sessions: customer_id+city_id unique' },
  { coll: 'city_captain_sessions', spec: { city_id: 1, updated_at: -1 }, opts: {}, label: 'city_captain_sessions: city_id+updated_at desc' },

  // notify_intents
  { coll: 'notify_intents', spec: { listing_id: 1, customer_id: 1 }, opts: { unique: true }, label: 'notify_intents: listing_id+customer_id unique' },
  { coll: 'notify_intents', spec: { listing_id: 1, created_at: -1 }, opts: {}, label: 'notify_intents: listing_id+created_at desc' },
  { coll: 'notify_intents', spec: { customer_id: 1, created_at: -1 }, opts: {}, label: 'notify_intents: customer_id+created_at desc' },

  // user_signals
  { coll: 'user_signals', spec: { customer_id: 1, ts: -1 }, opts: {}, label: 'user_signals: customer_id+ts desc' },
  { coll: 'user_signals', spec: { listing_id: 1, ts: -1 }, opts: {}, label: 'user_signals: listing_id+ts desc' },
  { coll: 'user_signals', spec: { city_id: 1, action: 1, ts: -1 }, opts: {}, label: 'user_signals: city_id+action+ts desc' },

  // tag_candidates
  { coll: 'tag_candidates', spec: { status: 1, created_at: -1 }, opts: {}, label: 'tag_candidates: status+created_at desc' },
  { coll: 'tag_candidates', spec: { tag_field: 1, candidate_value: 1 }, opts: {}, label: 'tag_candidates: tag_field+candidate_value' },

  // admin_audit_logs — TTL: 180 days
  { coll: 'admin_audit_logs', spec: { ts: 1 }, opts: { expireAfterSeconds: 180 * 24 * 60 * 60 }, label: 'admin_audit_logs: ts TTL 180d' },

  // captain_inbound_logs — TTL: 30 days
  { coll: 'captain_inbound_logs', spec: { ts: 1 }, opts: { expireAfterSeconds: 2592000 }, label: 'captain_inbound_logs: ts TTL 30d' },
];

async function main() {
  await connect();

  let ok = 0;
  let failed = 0;

  for (const idx of INDEXES) {
    try {
      const name = await col(idx.coll).createIndex(idx.spec, idx.opts);
      console.log(`${idx.label} created (name=${name})`);
      ok++;
    } catch (err) {
      console.error(`${idx.label} FAILED: ${err && err.message ? err.message : String(err)}`);
      failed++;
    }
  }

  console.log(`\nDone — ${ok} ok, ${failed} failed, ${INDEXES.length} total.`);

  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
