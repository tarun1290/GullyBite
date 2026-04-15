'use strict';

// Canonical phone masking utility.
// Applied at the DB → API boundary for every endpoint that returns
// customer phone numbers. No route is allowed to emit a raw phone
// unless it explicitly short-circuits through `canSeeFullPhones`.
//
// Mask format: first 2 + "*****" + last 3 of the normalized 10-digit
// national number (e.g. "98*****210"). Anything that cannot be
// normalized to exactly 10 digits collapses to "**********" — this is
// a fail-safe so malformed input never leaks partial digits.

const FAILSAFE_MASK = '**********';

// Normalize to a bare 10-digit Indian mobile number.
//   • strip every non-digit (handles "+", spaces, parens, dashes)
//   • drop a leading "91" country code when the remainder is 10 digits
//   • return null if the result isn't exactly 10 digits
function normalizePhone(phone) {
  if (phone == null) return null;
  let digits = String(phone).replace(/\D+/g, '');
  if (!digits) return null;
  if (digits.length > 10 && digits.startsWith('91')) {
    digits = digits.slice(2);
  }
  if (digits.length !== 10) return null;
  return digits;
}

function maskPhone(phone) {
  if (phone == null) return null;
  const normalized = normalizePhone(phone);
  if (!normalized) return FAILSAFE_MASK;
  return normalized.slice(0, 2) + '*****' + normalized.slice(-3);
}

// For call sites that need to decide between full and masked based on
// a permission bit. The permission bit MUST come from middleware (not
// from request input) — see marketingMessages.js / settlement routes.
function formatPhone(phone, { canSeeFull = false } = {}) {
  if (!phone) return null;
  return canSeeFull ? String(phone) : maskPhone(phone);
}

module.exports = { maskPhone, formatPhone, normalizePhone };
