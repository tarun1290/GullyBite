#!/usr/bin/env node
'use strict';

// scripts/fix-reorder-template-status.js
//
// One-off WRITE fix for the reorder_suggestion journey.
// Sets meta_approval_status='approved' on the single campaign_templates
// doc whose template_id is 'marketing_reorder_suggestion_v1'. The
// templateSync auto-glue missed it because the doc's meta_template_id
// join key is null/unmatched, so it stayed at the seed default 'pending'
// and the marketing dashboard's {is_active, meta_approval_status:'approved'}
// filter never lit up.
//
// Connects directly via the MongoDB driver — no business-code services
// loaded — so it stays safe to run against prod from the EC2 host.
//
// Usage on EC2 (from /home/ubuntu/GullyBite/backend/):
//   node --env-file=/home/ubuntu/GullyBite/.env backend/scripts/fix-reorder-template-status.js
//
// Reads:  process.env.MONGODB_URI, process.env.MONGODB_DB
// Writes: campaign_templates.meta_approval_status (one doc), approved_at, updated_at.
// Delete this script after a successful run.

const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB;

const TEMPLATE_ID = 'marketing_reorder_suggestion_v1';

async function main() {
  if (!MONGODB_URI) {
    console.error('FATAL: MONGODB_URI not set in environment');
    process.exit(1);
  }
  if (!MONGODB_DB) {
    console.error('FATAL: MONGODB_DB not set in environment');
    process.exit(1);
  }

  const client = new MongoClient(MONGODB_URI, { ignoreUndefined: true });
  try {
    await client.connect();
    const db = client.db(MONGODB_DB);
    const col = db.collection('campaign_templates');

    const before = await col.findOne(
      { template_id: TEMPLATE_ID },
      { projection: { template_id: 1, meta_approval_status: 1, meta_template_id: 1 } },
    );

    if (!before) {
      console.error(`No campaign_templates doc found with template_id='${TEMPLATE_ID}'. Nothing updated.`);
      process.exit(1);
    }

    console.log('before:', JSON.stringify({
      template_id: before.template_id,
      meta_approval_status: before.meta_approval_status ?? null,
      meta_template_id: before.meta_template_id ?? null,
    }));

    const now = new Date();
    const res = await col.updateOne(
      { template_id: TEMPLATE_ID },
      { $set: { meta_approval_status: 'approved', approved_at: now, updated_at: now } },
    );

    console.log('matched:', res.matchedCount, 'updated:', res.modifiedCount);

    const after = await col.findOne(
      { template_id: TEMPLATE_ID },
      { projection: { template_id: 1, meta_approval_status: 1 } },
    );
    console.log('after:', JSON.stringify({
      template_id: after.template_id,
      meta_approval_status: after.meta_approval_status ?? null,
    }));
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('fix-reorder-template-status failed:', err?.message || err);
  process.exit(1);
});
