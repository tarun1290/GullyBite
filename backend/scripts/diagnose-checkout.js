#!/usr/bin/env node
'use strict';

// scripts/diagnose-checkout.js
//
// One-off read-only diagnostic for the three preconditions the WhatsApp
// order_details checkout depends on. Each check prints PASS/FAIL with the
// observed value so a single run tells the operator what's wrong without
// any further inspection.
//
//   (1) process.env.RAZORPAY_WA_CONFIG_NAME — must be the literal string
//       "GullyBite", exactly matching the configuration_name registered
//       in Razorpay's WhatsApp Pay setup. Drift here yields a Meta 131008
//       at message-send time.
//   (2) platform_settings._id='checkout_order' — must exist with
//       enabled === true. The _sendOrderCheckout entrypoint in
//       webhooks/whatsapp.js short-circuits to a text fallback when
//       this flag is unset/false.
//   (3) order_details parameters block — must use the array form
//       `payment_settings: [{ type:'payment_gateway', payment_gateway:{...} }]`,
//       NOT the legacy/invalid `payment_configuration: <string>` field
//       that Meta rejects with 131008. Scans the four known builder
//       sites at runtime via fs (cheaper than grep, exact same result).
//
// Run on EC2:
//   cd /home/ubuntu/GullyBite/backend
//   node --env-file=/home/ubuntu/GullyBite/.env scripts/diagnose-checkout.js
//
// Native MongoDB driver only. Read-only — no writes anywhere.

const path = require('path');
const fs = require('fs');
const { connect, col } = require(path.join(__dirname, '..', 'src', 'config', 'database'));

const EXPECTED_CONFIG_NAME = 'GullyBite';

// Files that actually build the order_details interactive payload. If a
// future refactor adds a new builder, append it here so the check stays
// honest.
const CHECKOUT_FILES = [
  path.join(__dirname, '..', 'src', 'services', 'whatsapp.js'),
  path.join(__dirname, '..', 'src', 'whatsapp', 'flowHandler.js'),
];

function header(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 64 - title.length - 4))}`);
}

function reportCheck(name, ok, detail) {
  const tag = ok ? '✓ PASS' : '✗ FAIL';
  console.log(`  ${tag} — ${name}`);
  if (detail) console.log(`    ${detail}`);
}

(async () => {
  let exitCode = 0;
  try {
    console.log(`diagnose-checkout — ${new Date().toISOString()}`);
    let allPass = true;

    // ─── (1) RAZORPAY_WA_CONFIG_NAME ────────────────────────────
    header('(1) RAZORPAY_WA_CONFIG_NAME');
    const configName = process.env.RAZORPAY_WA_CONFIG_NAME;
    console.log(`  observed value: ${JSON.stringify(configName)}`);
    console.log(`  expected      : ${JSON.stringify(EXPECTED_CONFIG_NAME)}`);
    const cfgOk = configName === EXPECTED_CONFIG_NAME;
    reportCheck('RAZORPAY_WA_CONFIG_NAME equals "GullyBite"', cfgOk,
      cfgOk ? null : (configName == null
        ? 'env var is unset — load .env (--env-file=...) or check pm2 ecosystem'
        : `value differs (length ${configName.length}). Whitespace contamination is the most common cause.`));
    if (!cfgOk) allPass = false;

    // ─── (2) platform_settings.checkout_order ────────────────────
    header('(2) platform_settings._id=checkout_order');
    await connect();
    const flagDoc = await col('platform_settings').findOne({ _id: 'checkout_order' });
    if (!flagDoc) {
      console.log('  doc: NOT FOUND');
      reportCheck('platform_settings.checkout_order exists with enabled=true', false,
        'doc missing — _sendOrderCheckout will fall through to the text fallback');
      allPass = false;
    } else {
      console.log('  full doc:');
      console.log(JSON.stringify(flagDoc, null, 2).split('\n').map((l) => '    ' + l).join('\n'));
      const enabledOk = flagDoc.enabled === true;
      reportCheck('platform_settings.checkout_order.enabled === true', enabledOk,
        enabledOk ? null : `enabled = ${JSON.stringify(flagDoc.enabled)} (must be the boolean true)`);
      if (!enabledOk) allPass = false;
    }

    // ─── (3) Code check: payment_settings vs payment_configuration ──
    header('(3) order_details payload field — payment_settings vs payment_configuration');
    let perFile = [];
    for (const file of CHECKOUT_FILES) {
      const rel = path.relative(path.join(__dirname, '..'), file);
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (err) {
        console.log(`  ✗ ${rel}: read failed (${err.code || err.message})`);
        perFile.push({ file: rel, settings: 0, configuration: 0, readable: false });
        allPass = false;
        continue;
      }
      // Match field-key occurrences only, ignore `// payment_configuration was…`
      // style comments by counting EVERY occurrence — comments are also a
      // failure surface (someone copy-pasting a stale snippet would re-introduce
      // the bug). If a comment says "payment_configuration", flag it loudly.
      const settings = (text.match(/\bpayment_settings\b/g) || []).length;
      const configuration = (text.match(/\bpayment_configuration\b/g) || []).length;
      console.log(`  ${rel}`);
      console.log(`    payment_settings      hits: ${settings}`);
      console.log(`    payment_configuration hits: ${configuration}`);
      perFile.push({ file: rel, settings, configuration, readable: true });
    }

    const totalSettings = perFile.reduce((s, r) => s + r.settings, 0);
    const totalConfig   = perFile.reduce((s, r) => s + r.configuration, 0);
    const codeOk = totalSettings > 0 && totalConfig === 0;
    console.log('');
    console.log(`  total payment_settings hits     : ${totalSettings}`);
    console.log(`  total payment_configuration hits: ${totalConfig}`);
    reportCheck(
      'all order_details builders use payment_settings (zero payment_configuration)',
      codeOk,
      codeOk ? null
             : (totalConfig > 0
                ? 'payment_configuration appears in source — Meta will reject with 131008. Find and replace each hit.'
                : 'no payment_settings found — order_details builders may be missing entirely.')
    );
    if (!codeOk) allPass = false;

    // ─── SUMMARY ────────────────────────────────────────────────
    header('SUMMARY');
    console.log(`  Overall: ${allPass ? '✓ ALL PASS' : '✗ AT LEAST ONE CHECK FAILED'}`);
    if (!allPass) {
      console.log('  Exit code remains 0 — this is a report, not a gate.');
    }
  } catch (err) {
    console.error('[diag] ERROR:', err && err.message ? err.message : err);
    exitCode = 1;
  } finally {
    try { await globalThis._mongoClient?.close(); } catch (_) { /* ignore */ }
    process.exit(exitCode);
  }
})();
