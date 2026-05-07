#!/usr/bin/env node
'use strict';

// scripts/register-checkout-endpoint-backfill.js
//
// One-shot backfill: runs the WA Checkout endpoint registration
// handshake (public key upload + checkout_endpoint_url) against every
// currently active whatsapp_accounts row that does not yet have a
// checkout_endpoint_registered_at stamp. Idempotent — re-running on a
// row already registered with Meta hits the 80007 / 2388053 codes and
// is treated as success.
//
// Mirrors routes/auth.js:_registerCheckoutEndpoint exactly. Standalone
// (no business-service requires) so it stays safe to run on the EC2
// host without booting the rest of the app.
//
// Usage on EC2:
//   node --env-file=/home/ubuntu/GullyBite/.env backend/scripts/register-checkout-endpoint-backfill.js
//
// Reads:
//   MONGODB_URI, MONGODB_DB
//   WA_CHECKOUT_PRIVATE_KEY_B64   — RSA private key (PEM, base64-wrapped)
//   WA_CHECKOUT_ENDPOINT_URL      — public URL Meta will POST to
//   META_SYSTEM_USER_TOKEN        — single platform Meta token
//   WA_API_VERSION                — optional, default 'v25.0'
//
// Writes:
//   whatsapp_accounts.checkout_endpoint_registered_at  (per row, on success)

const { MongoClient } = require('mongodb');
const axios = require('axios');
const crypto = require('crypto');

const {
  MONGODB_URI,
  MONGODB_DB,
  WA_CHECKOUT_PRIVATE_KEY_B64,
  WA_CHECKOUT_ENDPOINT_URL,
  META_SYSTEM_USER_TOKEN,
  WA_API_VERSION = 'v25.0',
} = process.env;

const META_GRAPH_URL = `https://graph.facebook.com/${WA_API_VERSION}`;

function checkEnv() {
  const missing = [];
  if (!MONGODB_URI) missing.push('MONGODB_URI');
  if (!MONGODB_DB) missing.push('MONGODB_DB');
  if (!WA_CHECKOUT_PRIVATE_KEY_B64) missing.push('WA_CHECKOUT_PRIVATE_KEY_B64');
  if (!WA_CHECKOUT_ENDPOINT_URL) missing.push('WA_CHECKOUT_ENDPOINT_URL');
  if (!META_SYSTEM_USER_TOKEN) missing.push('META_SYSTEM_USER_TOKEN');
  if (missing.length) {
    console.error('FATAL: missing env vars:', missing.join(', '));
    process.exit(1);
  }
}

function derivePublicKey() {
  const privPem = Buffer.from(WA_CHECKOUT_PRIVATE_KEY_B64, 'base64').toString('utf8');
  const privKeyObj = crypto.createPrivateKey(privPem);
  return crypto.createPublicKey(privKeyObj).export({ type: 'spki', format: 'pem' });
}

// ── Step 1: upload public key ────────────────────────────────
// Meta returns 80007 / sub-2388053 on duplicate uploads — treat as
// success (handshake already done from a prior run or a fresh onboarding
// fired by routes/auth.js:savePhone).
async function uploadPublicKey(phoneNumberId, publicKeyPem) {
  try {
    await axios.post(
      `${META_GRAPH_URL}/${phoneNumberId}/whatsapp_business_encryption`,
      { business_public_key: publicKeyPem },
      {
        headers: { Authorization: `Bearer ${META_SYSTEM_USER_TOKEN}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      },
    );
    return { ok: true, alreadyRegistered: false };
  } catch (err) {
    const apiErr = err.response?.data?.error;
    if (apiErr?.code === 80007 || apiErr?.error_subcode === 2388053) {
      return { ok: true, alreadyRegistered: true };
    }
    return {
      ok: false,
      error: apiErr || err?.message,
      status: err.response?.status,
    };
  }
}

// ── Step 2: set checkout_endpoint_url on the phone number ────
// Meta's verb / param shape for this endpoint has shifted across API
// versions. Failure here is logged and the row is still stamped because
// step 1 already rotated the encryption secret on Meta's side; operator
// can re-run step 2 manually if the URL didn't take.
async function setCheckoutUrl(phoneNumberId) {
  try {
    await axios.post(
      `${META_GRAPH_URL}/${phoneNumberId}`,
      { checkout_endpoint_url: WA_CHECKOUT_ENDPOINT_URL },
      {
        headers: { Authorization: `Bearer ${META_SYSTEM_USER_TOKEN}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      },
    );
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err.response?.data || err?.message,
      status: err.response?.status,
    };
  }
}

async function main() {
  checkEnv();

  let publicKeyPem;
  try {
    publicKeyPem = derivePublicKey();
  } catch (err) {
    console.error('FATAL: failed to derive public key from WA_CHECKOUT_PRIVATE_KEY_B64:', err?.message || err);
    process.exit(1);
  }

  const client = new MongoClient(MONGODB_URI, { ignoreUndefined: true });
  try {
    await client.connect();
    const db = client.db(MONGODB_DB);
    const col = db.collection('whatsapp_accounts');

    // Match rows that are active AND missing the stamp. Treat null and
    // missing the same so a row inserted before the field existed and a
    // row whose stamp was nulled out by an admin both qualify.
    const candidates = await col
      .find(
        {
          is_active: true,
          $or: [
            { checkout_endpoint_registered_at: { $exists: false } },
            { checkout_endpoint_registered_at: null },
          ],
        },
        { projection: { phone_number_id: 1, restaurant_id: 1 } },
      )
      .toArray();

    console.log(`Found ${candidates.length} candidate row(s) to backfill\n`);
    if (!candidates.length) {
      console.log('Nothing to do.');
      return;
    }

    let succeeded = 0;
    const failed = [];

    for (const row of candidates) {
      const phoneNumberId = row.phone_number_id;
      const restaurantId = row.restaurant_id;

      console.log(`Processing ${phoneNumberId || '(no phone_number_id)'} for restaurant ${restaurantId || '(none)'}...`);

      if (!phoneNumberId) {
        console.log('  SKIP: row has no phone_number_id');
        failed.push({ phoneNumberId: '(missing)', restaurantId, reason: 'no_phone_number_id' });
        continue;
      }

      // Step 1
      const step1 = await uploadPublicKey(phoneNumberId, publicKeyPem);
      if (!step1.ok) {
        console.log('  FAIL step 1 (public key upload):', step1.error);
        failed.push({
          phoneNumberId,
          restaurantId,
          reason: 'pub_key_upload_failed',
          detail: step1.error,
          status: step1.status,
        });
        continue;
      }
      console.log(
        `  step 1: ${step1.alreadyRegistered ? 'public key already registered (idempotent)' : 'public key uploaded'}`,
      );

      // Step 2
      const step2 = await setCheckoutUrl(phoneNumberId);
      if (!step2.ok) {
        console.log(
          `  WARN step 2 (set checkout_endpoint_url) failed — stamping anyway, retry manually:`,
          step2.error,
        );
        // Don't fail the row — step 1 succeeded so the encryption secret
        // is in place; operator can re-run step 2 with curl if needed.
      } else {
        console.log('  step 2: checkout_endpoint_url set');
      }

      // Stamp
      await col.updateOne(
        { phone_number_id: phoneNumberId },
        { $set: { checkout_endpoint_registered_at: new Date(), updated_at: new Date() } },
      );
      succeeded++;
      console.log('  ✓ stamped');
    }

    console.log('');
    console.log('────────── Summary ──────────');
    console.log(`Succeeded: ${succeeded}`);
    console.log(`Failed:    ${failed.length}`);
    if (failed.length) {
      console.log('\nFailed phone_number_ids:');
      for (const f of failed) {
        const detail = f.detail ? ` — ${typeof f.detail === 'object' ? JSON.stringify(f.detail) : f.detail}` : '';
        const status = f.status ? ` (HTTP ${f.status})` : '';
        console.log(`  ${f.phoneNumberId} (restaurant ${f.restaurantId || '—'}): ${f.reason}${status}${detail}`);
      }
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('register-checkout-endpoint-backfill failed:', err?.message || err);
  process.exit(1);
});
