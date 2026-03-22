// src/services/checkout-crypto.js
// RSA-2048 + AES-128-GCM encryption/decryption for WhatsApp Checkout payloads
// WhatsApp sends encrypted order data — we decrypt with our private key
//
// Flow:
//   1. WhatsApp encrypts a random AES-128 key with our RSA-2048 public key
//   2. WhatsApp encrypts the order JSON with that AES key using AES-128-GCM
//   3. We decrypt the AES key with our RSA private key
//   4. We decrypt the order JSON with the AES key

'use strict';

const crypto = require('crypto');

// Load RSA private key from env (PEM format, base64-encoded to fit in one env var)
function getPrivateKey() {
  const b64 = process.env.WA_CHECKOUT_PRIVATE_KEY_B64;
  if (!b64) throw new Error('WA_CHECKOUT_PRIVATE_KEY_B64 not configured');
  return Buffer.from(b64, 'base64').toString('utf8');
}

// ─── DECRYPT CHECKOUT PAYLOAD ───────────────────────────────────
// encrypted_aes_key: base64-encoded RSA-encrypted AES key
// encrypted_payload: base64-encoded AES-GCM encrypted JSON
// iv: base64-encoded 12-byte IV for AES-GCM
// tag: base64-encoded 16-byte auth tag for AES-GCM
function decryptCheckoutPayload({ encrypted_aes_key, encrypted_payload, iv, tag }) {
  // Step 1: Decrypt AES key with RSA private key
  const privateKey = getPrivateKey();
  const encAesKey = Buffer.from(encrypted_aes_key, 'base64');
  const aesKey = crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    encAesKey
  );

  // Step 2: Decrypt payload with AES-128-GCM
  const ivBuf = Buffer.from(iv, 'base64');
  const tagBuf = Buffer.from(tag, 'base64');
  const encPayload = Buffer.from(encrypted_payload, 'base64');

  const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, ivBuf);
  decipher.setAuthTag(tagBuf);
  const decrypted = Buffer.concat([decipher.update(encPayload), decipher.final()]);

  return JSON.parse(decrypted.toString('utf8'));
}

// ─── ENCRYPT RESPONSE (for sending encrypted responses back) ────
// Uses the same AES key that WhatsApp sent (if needed for response signing)
function encryptResponse(data, aesKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    encrypted_payload: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

// ─── GENERATE KEY PAIR (utility — run once to get keys) ─────────
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  return {
    publicKey,
    privateKey,
    publicKeyB64: Buffer.from(publicKey).toString('base64'),
    privateKeyB64: Buffer.from(privateKey).toString('base64'),
  };
}

// ─── VERIFY WEBHOOK SIGNATURE ───────────────────────────────────
// WhatsApp signs checkout webhooks with HMAC-SHA256
function verifyCheckoutSignature(rawBody, signature) {
  const secret = process.env.WA_CHECKOUT_WEBHOOK_SECRET;
  if (!secret) return false; // Skip if not configured
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature || ''), Buffer.from(expected));
}

module.exports = {
  decryptCheckoutPayload,
  encryptResponse,
  generateKeyPair,
  verifyCheckoutSignature,
};
