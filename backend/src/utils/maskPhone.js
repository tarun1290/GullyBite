'use strict';

// Canonical phone masking utility.
// For +91 10-digit Indian mobiles the output is formatted as:
//   +91 <first3>XX XXX<last2>       (e.g. +919876789012 → "+91 987XX XXX12")
// For any input that cannot be normalized to a 10-digit Indian number
// (null, empty, wrong length, non-numeric), the output is the literal
// string "Hidden". This is a hard fail-safe — no partial digits ever leak.

const FAILSAFE = 'Hidden';

// Strip to digits, drop a leading "91" country code when appropriate,
// and return a bare 10-digit string — or null if the result isn't a
// 10-digit number.
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
  const n = normalizePhone(phone);
  if (!n) return FAILSAFE;
  return `+91 ${n.slice(0, 3)}XX XXX${n.slice(-2)}`;
}

// For call sites that need to decide between full and masked based on
// a permission bit. The permission bit MUST come from middleware (not
// from request input) — see marketingMessages.js / settlement routes.
function formatPhone(phone, { canSeeFull = false } = {}) {
  if (!phone) return null;
  return canSeeFull ? String(phone) : maskPhone(phone);
}

module.exports = { maskPhone, formatPhone, normalizePhone };
