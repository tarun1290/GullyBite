'use strict';

// Staff PIN helper — generates a random 4-digit PIN, stores the bcrypt
// hash on the restaurant doc, and returns the plain PIN ONCE so the
// admin can hand it off. Plain PIN is never persisted.

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { col } = require('../config/database');

const BCRYPT_ROUNDS = 10;

function randomFourDigitPin() {
  // crypto.randomInt is unbiased — Math.random() isn't safe for credentials.
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

async function generateStaffPin(restaurantId) {
  if (!restaurantId) throw new Error('restaurantId required');
  const pin = randomFourDigitPin();
  const hash = await bcrypt.hash(pin, BCRYPT_ROUNDS);
  const now = new Date();
  const result = await col('restaurants').updateOne(
    { _id: restaurantId },
    { $set: { staff_pin: hash, staff_pin_updated_at: now, updated_at: now } }
  );
  if (!result.matchedCount) throw new Error('restaurant not found');
  return { pin, updatedAt: now };
}

async function verifyStaffPin(restaurantId, pin) {
  if (!restaurantId || !pin) return null;
  const r = await col('restaurants').findOne(
    { _id: restaurantId },
    { projection: { staff_pin: 1 } }
  );
  if (!r?.staff_pin) return null;
  const ok = await bcrypt.compare(String(pin), r.staff_pin);
  return ok ? r : null;
}

module.exports = { generateStaffPin, verifyStaffPin };
