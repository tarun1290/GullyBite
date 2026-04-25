#!/usr/bin/env node
// scripts/backfill-flow-assignments.js
//
// Run with: node scripts/backfill-flow-assignments.js
// Safe to re-run — only updates restaurants currently missing flow_id.
//
// Reads platform_settings._id='whatsapp_flow'.flow_id and copies it onto
// every restaurant whose flow_id is null or unset. Restaurants that
// already have a flow_id (admin-overridden or already-backfilled) are
// left untouched. Idempotent: subsequent runs report 0 modified.

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const { MongoClient } = require('mongodb');

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error('FATAL: MONGODB_URI is not set');
    process.exit(1);
  }

  const client = await MongoClient.connect(process.env.MONGODB_URI);
  const db = client.db(process.env.MONGODB_DB || 'gullybite');

  try {
    const setting = await db.collection('platform_settings').findOne({ _id: 'whatsapp_flow' });
    if (!setting || !setting.flow_id) {
      console.log('No platform flow configured, nothing to backfill');
      return;
    }

    const filter = { $or: [{ flow_id: null }, { flow_id: { $exists: false } }] };
    const missingCount = await db.collection('restaurants').countDocuments(filter);
    console.log(`Found ${missingCount} restaurant(s) missing flow_id; platform flow_id = ${setting.flow_id}`);

    if (missingCount === 0) {
      console.log('Nothing to update.');
      return;
    }

    const result = await db.collection('restaurants').updateMany(
      filter,
      { $set: { flow_id: setting.flow_id, updated_at: new Date() } }
    );
    console.log(`modifiedCount: ${result.modifiedCount}`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
})();
