#!/usr/bin/env node
// scripts/encrypt-meta-tokens.js
//
// One-shot backfill: encrypt the plaintext `meta_access_token` stored on
// every restaurant doc that still holds it in cleartext. As of the
// AES-256-GCM-at-rest change in routes/auth.js, NEW connections write the
// token encrypted (format: `iv:authTag:ciphertext`, all hex, exactly two
// colons). Records written BEFORE that change are still plaintext and
// keep working only because routes/auth.js's decryptToken() has a
// plaintext-passthrough path. This script removes that liability by
// rewriting the legacy rows in the encrypted format.
//
// WHY THE HARD process.exit LIVES HERE (not in auth.js):
//   auth.js intentionally does NOT make META_TOKEN_ENCRYPTION_KEY a boot
//   requirement — doing so would crash the server on the first restart
//   after deploy, before this backfill can run, because legacy plaintext
//   rows would suddenly be "expected" to be decryptable. The genuinely
//   hard requirement (exit 1 on a missing/invalid key) is correct HERE,
//   because this script's entire job is encryption and it must not run
//   without a valid key.
//
// The encrypt logic + the 2-colon-hex "already encrypted?" detection are
// an INTENTIONAL copy of routes/auth.js (auth.js does not export them and
// we deliberately do NOT introduce a shared module). Keep the format in
// lockstep with auth.js if either side changes.
//
// DB bootstrap mirrors backend/scripts/migrate-petpooja-credentials.js
// (the same { connect, col } from src/config/database used by recent
// migrations). Native driver only — no mongosh, no Mongoose.
//
// Usage (run on EC2 AFTER the backend deploy carrying the encryption change):
//
//   # DRY-RUN (default) — only prints how many rows WOULD be migrated:
//   node --env-file=/home/ubuntu/GullyBite/.env backend/scripts/encrypt-meta-tokens.js
//
//   # APPLY — actually encrypt + write back:
//   MIGRATE_ENCRYPT=true node --env-file=/home/ubuntu/GullyBite/.env backend/scripts/encrypt-meta-tokens.js
//
// Idempotent: rows already in `iv:authTag:ciphertext` form are skipped,
// so a second run reports 0 to migrate.

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const crypto = require('crypto');
const { connect, col } = require('../src/config/database');

const META_TOKEN_ENC_ALGO = 'aes-256-gcm';

// ── Hard requirement (correctly lives here) ──────────────────
// Unlike auth.js, this script MUST NOT run without a valid key.
function getEncryptionKeyOrExit() {
  const raw = process.env.META_TOKEN_ENCRYPTION_KEY;
  if (!raw || !/^[0-9a-fA-F]{64}$/.test(raw)) {
    console.error(
      'FATAL: META_TOKEN_ENCRYPTION_KEY is missing or invalid — it must be a ' +
      '32-byte hex string (exactly 64 hex characters).'
    );
    process.exit(1);
  }
  const key = Buffer.from(raw, 'hex');
  if (key.length !== 32) {
    console.error('FATAL: META_TOKEN_ENCRYPTION_KEY did not decode to 32 bytes.');
    process.exit(1);
  }
  return key;
}

// Identical format to routes/auth.js encryptToken(): random 12-byte IV,
// AES-256-GCM, `iv:authTag:ciphertext` — all hex, exactly two colons.
function encryptToken(key, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(META_TOKEN_ENC_ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

// Identical detection to routes/auth.js decryptToken()'s ciphertext gate:
// a string with EXACTLY two colons AND all three segments valid hex is
// considered already encrypted. Everything else is treated as plaintext
// that needs migrating.
function isAlreadyEncrypted(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  if (parts.length !== 3) return false;
  const isHex = (s) => s.length > 0 && /^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0;
  return parts.every(isHex);
}

async function main() {
  const key = getEncryptionKeyOrExit();
  const apply = process.env.MIGRATE_ENCRYPT === 'true';

  await connect();

  // Only rows that actually hold a non-empty token. The encrypted-vs-plaintext
  // decision is done in JS (regex on the value) because the format check is
  // identical to auth.js and not cleanly expressible as a Mongo query.
  const candidates = await col('restaurants')
    .find(
      { meta_access_token: { $exists: true, $nin: [null, ''] } },
      { projection: { _id: 1, meta_access_token: 1 } }
    )
    .toArray();

  const toMigrate = candidates.filter((r) => !isAlreadyEncrypted(r.meta_access_token));

  console.log(`[encrypt-meta-tokens] restaurants with a token: ${candidates.length}`);
  console.log(`[encrypt-meta-tokens] already encrypted:        ${candidates.length - toMigrate.length}`);
  console.log(`[encrypt-meta-tokens] plaintext to migrate:     ${toMigrate.length}`);

  if (!apply) {
    console.log('[encrypt-meta-tokens] DRY-RUN (set MIGRATE_ENCRYPT=true to apply). No writes performed.');
    setTimeout(() => process.exit(0), 500);
    return;
  }

  let migrated = 0;
  for (const r of toMigrate) {
    const enc = encryptToken(key, r.meta_access_token);
    await col('restaurants').updateOne(
      { _id: r._id },
      { $set: { meta_access_token: enc, updated_at: new Date() } }
    );
    migrated += 1;
  }

  console.log(`[encrypt-meta-tokens] migrated: ${migrated} restaurant token(s) encrypted`);
  console.log('[encrypt-meta-tokens] done');
  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => { console.error('[encrypt-meta-tokens] Fatal:', e); process.exit(1); });
