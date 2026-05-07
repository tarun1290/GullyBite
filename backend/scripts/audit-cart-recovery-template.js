#!/usr/bin/env node
'use strict';

// scripts/audit-cart-recovery-template.js
//
// One-off READ-ONLY diagnostic for the marketing_cart_recovery_v1 row in
// campaign_templates. Prints the full document so we can verify:
//   • body_template — what the customer-facing message actually looks like
//   • variables[]   — which override keys (order_amount vs subtotal_rs etc.)
//                      the cart-recovery handler must supply
//   • cta_button_text / footer_text / header_text
//   • any url / link / button-payload field — confirms the CTA points to
//     WhatsApp (deep-link/reply-flow), NOT a payment URL.
//
// Connects directly via the MongoDB driver — no business-code services
// loaded — safe to run against prod from the EC2 host.
//
// Usage on EC2:
//   node --env-file=/home/ubuntu/GullyBite/.env backend/scripts/audit-cart-recovery-template.js
//
// Reads:  process.env.MONGODB_URI, process.env.MONGODB_DB
// Writes: nothing.

const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB;
const TEMPLATE_ID = 'marketing_cart_recovery_v1';

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
    const doc = await db.collection('campaign_templates').findOne({ template_id: TEMPLATE_ID });

    if (!doc) {
      console.log(`No campaign_templates row found with template_id='${TEMPLATE_ID}'.`);
      return;
    }

    console.log('\n══════════ FULL DOCUMENT ══════════');
    console.log(JSON.stringify(doc, null, 2));

    console.log('\n══════════ KEY FIELDS ══════════');
    console.log('template_id        :', doc.template_id);
    console.log('display_name       :', doc.display_name);
    console.log('use_case           :', doc.use_case);
    console.log('category           :', doc.category);
    console.log('language           :', doc.language);
    console.log('meta_template_id   :', doc.meta_template_id ?? '(none)');
    console.log('meta_approval_status:', doc.meta_approval_status);
    console.log('is_active          :', doc.is_active);
    console.log('per_message_cost_rs:', doc.per_message_cost_rs);

    console.log('\n──── HEADER ────');
    console.log('header_type :', doc.header_type ?? '(none)');
    console.log('header_text :', doc.header_text ?? '(none)');

    console.log('\n──── BODY ────');
    console.log('body_template:');
    console.log(doc.body_template || '(none)');

    console.log('\n──── FOOTER ────');
    console.log('footer_text :', doc.footer_text ?? '(none)');

    console.log('\n──── CTA ────');
    console.log('cta_button_text :', doc.cta_button_text ?? '(none)');

    console.log('\n──── VARIABLES ────');
    if (Array.isArray(doc.variables) && doc.variables.length) {
      for (const v of doc.variables) {
        console.log(`  • name=${v.name}  source=${v.source}  required=${!!v.required}  label="${v.label || ''}"  example="${v.example || ''}"`);
      }
    } else {
      console.log('  (no variables declared)');
    }

    // Surface any additional url / link / button payload fields that
    // might exist on the doc — gives us a full picture of the CTA target.
    console.log('\n──── URL / LINK / BUTTON FIELDS (any) ────');
    const urlish = Object.entries(doc).filter(([k]) =>
      /url|link|button|cta|target|deeplink/i.test(k) && k !== 'cta_button_text',
    );
    if (urlish.length) {
      for (const [k, v] of urlish) {
        console.log(`  ${k} :`, typeof v === 'object' ? JSON.stringify(v) : v);
      }
    } else {
      console.log('  (no extra url/link/button fields on the doc)');
    }

    console.log('');
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('audit-cart-recovery-template failed:', err?.message || err);
  process.exit(1);
});
