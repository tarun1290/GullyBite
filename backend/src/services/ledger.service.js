// src/services/ledger.service.js
// Phase 3: restaurant-scoped financial ledger. Single source of truth for
// how much the platform owes a restaurant at any given moment.
//
// Entries are append-only. A payment produces one credit row for the
// net-of-fees amount. A refund produces one debit row for the refunded
// amount. Payouts (later) produce one debit row against the restaurant's
// balance. Razorpay fees may be logged as `fee` entries for transparency.
//
// Idempotency: the unique (ref_type, ref_id) index at the Mongo layer
// means a duplicate webhook → E11000 → we return the existing row
// instead of double-booking. Callers must pass a stable ref_id
// (typically the payment._id / refund.id / payout._id).

'use strict';

const { col, newId } = require('../config/database');
const log = require('../utils/logger').child({ component: 'ledger' });

const COLLECTION = 'restaurant_ledger';

async function _insert({ restaurantId, type, amountPaise, refType, refId, status, notes }) {
  if (!restaurantId) throw new Error('ledger: restaurant_id required');
  if (!['credit', 'debit'].includes(type)) throw new Error(`ledger: bad type=${type}`);
  if (!['payment', 'refund', 'payout', 'fee'].includes(refType)) throw new Error(`ledger: bad ref_type=${refType}`);
  if (!refId) throw new Error('ledger: ref_id required');
  if (!['pending', 'completed', 'failed'].includes(status)) throw new Error(`ledger: bad status=${status}`);
  const amount = Math.round(Number(amountPaise) || 0);
  if (amount <= 0) throw new Error(`ledger: amount_paise must be > 0 (got ${amount})`);

  const now = new Date();
  const doc = {
    _id: newId(),
    restaurant_id: String(restaurantId),
    type,
    amount_paise: amount,
    ref_type: refType,
    ref_id: String(refId),
    status,
    notes: notes || null,
    created_at: now,
    updated_at: now,
  };

  try {
    await col(COLLECTION).insertOne(doc);
    return doc;
  } catch (err) {
    if (err?.code === 11000) {
      // Duplicate (restaurant_id, ref_type, ref_id) — idempotent replay.
      const existing = await col(COLLECTION).findOne({
        restaurant_id: String(restaurantId), ref_type: refType, ref_id: String(refId),
      });
      log.info({ restaurantId, refType, refId }, 'ledger entry already exists — replay ignored');
      return existing;
    }
    throw err;
  }
}

// Payment credit — arrives only from the verified webhook, so always 'completed'.
async function credit({ restaurantId, amountPaise, refType, refId, notes, status }) {
  return _insert({ restaurantId, type: 'credit', amountPaise, refType, refId, status: status || 'completed', notes });
}

// Debit — may be 'pending' (refund initiated, awaiting webhook) or
// 'completed' (webhook confirmed). Default 'completed' for back-compat
// with payout/fee callers.
async function debit({ restaurantId, amountPaise, refType, refId, notes, status }) {
  return _insert({ restaurantId, type: 'debit', amountPaise, refType, refId, status: status || 'completed', notes });
}

// Phase 3.1: flip an existing 'pending' entry to 'completed'. Used by
// the refund webhook to promote the pending debit written at
// issueRefund-time. Returns the updated row, or null if the lookup
// failed (caller should fall back to creating a new completed entry).
async function markCompleted({ restaurantId, refType, refId }) {
  const res = await col(COLLECTION).findOneAndUpdate(
    { restaurant_id: String(restaurantId), ref_type: refType, ref_id: String(refId) },
    { $set: { status: 'completed', updated_at: new Date() } },
    { returnDocument: 'after' }
  );
  return res?.value || null;
}

// Sum of credits - sum of debits for a restaurant, in paise.
// Only 'completed' entries count toward balance; 'pending' entries are
// informational (e.g., refund initiated but not yet confirmed by Razorpay).
async function balancePaise(restaurantId, { includePending = false } = {}) {
  const match = { restaurant_id: String(restaurantId) };
  if (!includePending) match.status = 'completed';
  const agg = await col(COLLECTION).aggregate([
    { $match: match },
    { $group: { _id: '$type', total: { $sum: '$amount_paise' } } },
  ]).toArray();
  let credits = 0, debits = 0;
  for (const row of agg) {
    if (row._id === 'credit') credits = row.total;
    if (row._id === 'debit')  debits = row.total;
  }
  return credits - debits;
}

module.exports = {
  COLLECTION,
  credit,
  debit,
  markCompleted,
  balancePaise,
};
