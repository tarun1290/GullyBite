'use strict';

const crypto = require('crypto');

// SHA-256 of normalized phone. Optional PII_HASH_SALT env for cross-deployment
// hash stability; if unset, hashes are still deterministic within a deployment.
function normalize(phone) {
  if (!phone) return '';
  return String(phone).replace(/\D+/g, '');
}

function hashPhone(phone) {
  const norm = normalize(phone);
  if (!norm) return null;
  const salt = process.env.PII_HASH_SALT || '';
  return crypto.createHash('sha256').update(salt + norm).digest('hex');
}

module.exports = { hashPhone, normalizePhone: normalize };
