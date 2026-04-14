// src/services/customer.service.js
// Phase 1: global customer identity. ONE row per human phone number
// across the whole platform — no tenant scope on this collection.
//
// Per-tenant state (order totals, preferences, last-order timestamps)
// lives in customer_profiles, keyed by (restaurant_id, customer_id).
// Keep the split intentional: writing tenant-scoped fields onto the
// customers row here would re-introduce the cross-tenant leak this
// architecture exists to prevent.
//
// This service is intentionally narrow: identity lookup/creation and
// display-name updates only. No LTV, no preferences, no addresses.

'use strict';

const { col, newId } = require('../config/database');

const COLLECTION = 'customers';

// E.164-ish normalization — strip spaces/dashes/parens/leading '+'.
// We store the raw digit stream as wa_phone; Meta delivers it this way
// on inbound webhook events, and this codebase already compares on the
// digit form elsewhere.
function normalizePhone(input) {
  if (!input) return null;
  const s = String(input).replace(/[^\d]/g, '');
  return s || null;
}

// Atomic upsert — first caller wins insert, concurrent callers read the
// existing row. Avoids the classic find-then-insert race under bursty
// WhatsApp webhooks for the same phone number.
async function findOrCreateByPhone(phone, { name } = {}) {
  const wa_phone = normalizePhone(phone);
  if (!wa_phone) throw new Error('findOrCreateByPhone: phone is required');

  const now = new Date();
  const res = await col(COLLECTION).findOneAndUpdate(
    { wa_phone },
    {
      $setOnInsert: {
        _id: newId(),
        wa_phone,
        name: name || null,
        created_at: now,
      },
      $set: { updated_at: now },
    },
    { upsert: true, returnDocument: 'after' }
  );
  return res?.value || col(COLLECTION).findOne({ wa_phone });
}

function findById(id) {
  if (!id) return Promise.resolve(null);
  return col(COLLECTION).findOne({ _id: String(id) });
}

function findByPhone(phone) {
  const wa_phone = normalizePhone(phone);
  if (!wa_phone) return Promise.resolve(null);
  return col(COLLECTION).findOne({ wa_phone });
}

async function updateName(customerId, name) {
  if (!customerId || !name) return null;
  await col(COLLECTION).updateOne(
    { _id: String(customerId) },
    { $set: { name: String(name).trim(), updated_at: new Date() } }
  );
  return findById(customerId);
}

module.exports = {
  COLLECTION,
  normalizePhone,
  findOrCreateByPhone,
  findById,
  findByPhone,
  updateName,
};
