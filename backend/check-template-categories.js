// check-template-categories.js
// Run from backend/: `node check-template-categories.js`
//
// Diagnostic-only — no writes. Investigates why Meta billed marketing-tier
// rates during testing. Reports template categories, recent campaign sends,
// auto-journey runs, and any pricing/conversation-type fields preserved on
// webhook_logs.
//
// NOTE: this script was rewritten from the spec's version, which had two
// bugs:
//   1. Called `connectDB()`, but the real export is `connect()`
//      (see config/database.js export shape)
//   2. Used a relative `'../.env'` path — fails when run from anywhere
//      other than backend/cwd. Now uses path.join(__dirname, '../.env')
//      to match the loader pattern in ec2-server.js.

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });

const { col, connect } = require('./src/config/database');

const DAYS_60_MS = 60 * 24 * 60 * 60 * 1000;

async function check() {
  await connect();

  // ─── Step 1 — Razorpay checkout config ──────────────────────────
  // RAZORPAY_WA_CONFIG_NAME is the Meta WhatsApp Pay PAYMENT
  // CONFIGURATION name (Business Manager → WhatsApp → Payment Settings).
  // It is NOT a Meta message template — the checkout flow uses
  // interactive `type: 'order_details'` (see services/whatsapp.js:220).
  // The lookup below will almost certainly return null, which CONFIRMS
  // checkout is not a template send. Reporting the row anyway in case
  // someone created a template with the same name by accident.
  const configName = process.env.RAZORPAY_WA_CONFIG_NAME || 'GullyBite';
  console.log('\n=== STEP 1: Razorpay checkout config ===');
  console.log('RAZORPAY_WA_CONFIG_NAME =', configName);
  const tmpl = await col('templates').findOne({ name: configName });
  console.log('Template row with that name (expected: null):',
    tmpl ? JSON.stringify({ name: tmpl.name, category: tmpl.category, status: tmpl.status }, null, 2) : 'null');

  // All MARKETING vs UTILITY templates in local cache
  const marketing = await col('templates').find({ category: 'MARKETING' }).toArray();
  console.log('\nMARKETING templates in cache:',
    marketing.map(t => ({ name: t.name, status: t.status, waba_id: t.waba_id })));

  const utility = await col('templates').find({ category: 'UTILITY' }).toArray();
  console.log('\nUTILITY templates in cache:',
    utility.map(t => ({ name: t.name, status: t.status, waba_id: t.waba_id })));

  // ─── Step 2 — Recent campaign sends ─────────────────────────────
  console.log('\n=== STEP 2: Campaigns + journeys in last 60 days ===');
  const campaigns = await col('campaigns').find({
    status: { $in: ['sent', 'completed', 'partial'] },
    updated_at: { $gte: new Date(Date.now() - DAYS_60_MS) },
  }).toArray();
  console.log('Campaigns sent (last 60d):', campaigns.length === 0 ? 'NONE' : campaigns.map(c => ({
    name: c.name, type: c.type, status: c.status,
    sent_count: c.sent_count, template_name: c.template_name,
    sent_at: c.sent_at || c.updated_at,
  })));

  // Auto-journey runs (cart recovery, welcome, reorder reminders) — these
  // can trigger marketing-template sends even outside scheduled campaigns.
  const journeys = await col('auto_journey_runs')
    .find({ created_at: { $gte: new Date(Date.now() - DAYS_60_MS) } })
    .limit(20).toArray();
  console.log('Auto-journey runs (last 60d, capped 20):',
    journeys.length === 0 ? 'NONE' : journeys.map(j => ({
      type: j.journey_type || j.type,
      status: j.status,
      template_name: j.template_name,
      created_at: j.created_at,
    })));

  // Cart-recovery sends — explicitly promotional per services/cart-recovery.js
  const cartRecovery = await col('abandoned_carts').find({
    recovery_sent_at: { $gte: new Date(Date.now() - DAYS_60_MS) },
  }).limit(20).toArray();
  console.log('Cart-recovery sends (last 60d, capped 20):',
    cartRecovery.length === 0 ? 'NONE' : cartRecovery.map(c => ({
      customer_phone: c.customer_phone?.slice(-4),
      recovery_sent_at: c.recovery_sent_at,
      template: c.recovery_template_name,
    })));

  // marketing_messages collection — anything Meta charges for marketing
  // tier should land here. Compare its count to expected.
  const marketingMsgCount = await col('marketing_messages').countDocuments({
    created_at: { $gte: new Date(Date.now() - DAYS_60_MS) },
  });
  console.log('marketing_messages rows (last 60d):', marketingMsgCount);
  if (marketingMsgCount > 0) {
    const sample = await col('marketing_messages').find({
      created_at: { $gte: new Date(Date.now() - DAYS_60_MS) },
    }).limit(10).toArray();
    console.log('Sample marketing_messages (last 10):', sample.map(m => ({
      template_name: m.template_name,
      to_phone: m.to_phone?.slice(-4),
      cost: m.cost,
      status: m.status,
      created_at: m.created_at,
    })));
  }

  // ─── Step 3 — Webhook logs with conversation type ───────────────
  console.log('\n=== STEP 3: conversation/pricing in webhook logs ===');
  // Two locations Meta puts pricing info:
  //   payload.entry[].changes[].value.statuses[].pricing
  //   payload.entry[].changes[].value.statuses[].conversation
  const recentLogs = await col('webhook_logs').find({
    source: 'whatsapp',
    received_at: { $gte: new Date(Date.now() - DAYS_60_MS) },
  }).limit(500).toArray();

  const billingRows = [];
  for (const log of recentLogs) {
    const entries = log.payload?.entry || [];
    for (const e of entries) {
      for (const ch of e.changes || []) {
        for (const s of ch.value?.statuses || []) {
          if (s.pricing || s.conversation) {
            billingRows.push({
              received_at: log.received_at,
              status: s.status,
              pricing: s.pricing,
              conversation: s.conversation,
            });
          }
        }
      }
    }
  }
  console.log('Status messages with pricing/conversation field:', billingRows.length);
  if (billingRows.length) {
    // Tally by category
    const byCategory = {};
    for (const r of billingRows) {
      const cat = r.pricing?.category || r.conversation?.origin?.type || 'unknown';
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    }
    console.log('Tally by billing category:', byCategory);
    console.log('Sample (first 5):', billingRows.slice(0, 5));
  }

  process.exit(0);
}

check().catch(err => {
  console.error('check failed:', err);
  process.exit(1);
});
