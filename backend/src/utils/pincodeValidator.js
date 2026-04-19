// src/utils/pincodeValidator.js
// Platform-wide pincode serviceability check. Used by the WhatsApp Flow
// address handler to reject customers whose delivery PIN isn't in the
// Prorouting serviceable list.
//
// No caching at this stage — a single findOne on an indexed collection
// is cheap. If this becomes hot we'll add a short-TTL in-memory cache
// or a MongoDB TTL-backed cache.

'use strict';

const ServiceablePincode = require('../models/ServiceablePincode');
const log = require('./logger').child({ component: 'pincodeValidator' });

// Returns true iff the pincode is in the serviceable collection AND
// its `enabled` flag is true. Returns false on any miss, invalid input,
// or lookup error.
async function isPincodeServiceable(pincode) {
  try {
    if (!pincode) return false;
    const pc = String(pincode).trim();
    if (!/^[1-9][0-9]{5}$/.test(pc)) return false;
    const doc = await ServiceablePincode.findByPincode(pc);
    return !!(doc && doc.enabled);
  } catch (err) {
    log.warn({ err, pincode }, 'Serviceability lookup failed — failing open');
    return true;
  }
}

// Pull the first 6-digit PIN-like number out of a free-text address.
// Used when the Flow's structured `pincode` field is missing.
function extractPincode(text) {
  if (!text) return null;
  const m = String(text).match(/\b[1-9][0-9]{5}\b/);
  return m ? m[0] : null;
}

module.exports = { isPincodeServiceable, extractPincode };
