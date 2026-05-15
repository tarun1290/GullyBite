#!/usr/bin/env node
'use strict';

// set-demo-login.js
// One-time setup: enable manual login on the single Google-auth restaurant.
//
// Usage (EC2):
//   node --env-file=/home/ubuntu/GullyBite/.env backend/scripts/set-demo-login.js
//
// Idempotent — re-running re-hashes the password and re-stamps the flags,
// which is fine. Logs the targeted _id and name so the operator can
// confirm the right doc was touched before walking away.

const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

const DEMO_EMAIL = 'test@gmail.com';
const DEMO_PASSWORD = 'Test@1234';

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('ERROR: MONGODB_URI not set. Did you pass --env-file=...?');
    process.exit(1);
  }

  const client = await MongoClient.connect(uri);
  try {
    const restaurants = client.db('gullybite').collection('restaurants');

    const target = await restaurants.findOne({ auth_provider: 'google' });
    if (!target) {
      console.error('ERROR: No restaurant found with auth_provider: "google"');
      process.exit(1);
    }

    const hash = await bcrypt.hash(DEMO_PASSWORD, 12);
    const result = await restaurants.updateOne(
      { _id: target._id },
      {
        $set: {
          manual_login_enabled: true,
          manual_login_email: DEMO_EMAIL,
          password_hash: hash,
          updated_at: new Date(),
        },
      },
    );

    console.log('Targeted restaurant:');
    console.log('  _id:  ', target._id);
    console.log('  name: ', target.business_name || target.owner_name || '(unnamed)');
    console.log('  email:', target.email);
    console.log('Update result:');
    console.log('  matched:  ', result.matchedCount);
    console.log('  modified: ', result.modifiedCount);
    console.log('Demo credentials:');
    console.log('  manual_login_email: ', DEMO_EMAIL);
    console.log('  password:           ', DEMO_PASSWORD, '(stored as bcrypt hash)');
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
