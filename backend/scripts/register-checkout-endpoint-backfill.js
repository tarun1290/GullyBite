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

// ── Single POST: public key + checkout endpoint URL ──────────
// Meta accepts both fields in one request to
// /whatsapp_business_encryption. The earlier two-call shape (separate
// POST to /<phone_number_id> for the URL) targeted a non-existent
// endpoint, so the URL never actually took. Meta returns 80007 /
// sub-2388053 when the same key is re-uploaded — treated as success
// because the URL half of the body is still applied on the duplicate
// response.
async function registerCheckoutEndpoint(phoneNumberId, publicKeyPem) {
  try {
    await axios.post(
      `${META_GRAPH_URL}/${phoneNumberId}/whatsapp_business_encryption`,
      {
        business_public_key: publicKeyPem,
        checkout_endpoint_url: WA_CHECKOUT_ENDPOINT_URL,
      },
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

      // Single-call register: public key + checkout endpoint URL
      const result = await registerCheckoutEndpoint(phoneNumberId, publicKeyPem);
      if (!result.ok) {
        console.log('  FAIL register (public key + checkout URL):', result.error);
        failed.push({
          phoneNumberId,
          restaurantId,
          reason: 'register_failed',
          detail: result.error,
          status: result.status,
        });
        continue;
      }
      console.log(
        `  register: ${result.alreadyRegistered ? 'key already registered (URL re-applied)' : 'key + checkout URL registered'}`,
      );

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
