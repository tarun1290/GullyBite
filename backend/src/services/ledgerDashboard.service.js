// src/services/ledgerDashboard.service.js
// Phase 5 — Read-only queries backing the restaurant ledger dashboard.
// All amounts are returned in paise; the frontend divides by 100.
//
// Separation from ledger.service.js is deliberate: that file mutates,
// this one only reads/aggregates for UI.

'use strict';

const { col } = require('../config/database');
const settlementSvc = require('./settlement.service');

const LEDGER = 'restaurant_ledger';
const SETTLEMENTS = 'settlements';

// ─── SUMMARY ────────────────────────────────────────────────
// Returns:
//   total_collected_paise   — Σ credits (ref_type='payment', completed)
//   total_refunded_paise    — Σ debits  (ref_type='refund',  completed)
//   total_payout_paise      — Σ debits  (ref_type='payout',  completed)
//   current_balance_paise   — collected − refunded − payouts (completed-only)
//   pending_settlement_paise— in-flight settlements reserved
async function getSummary(restaurantId) {
  const rid = String(restaurantId);

  const calc = await settlementSvc.calculateSettlement(rid);

  // In-flight (not yet ledger-debited) settlement reservation. Restricted
  // to Phase 5 rows so legacy weekly settlements don't double-count here.
  const inflightAgg = await col(SETTLEMENTS).aggregate([
    { $match: {
        restaurant_id: rid,
        status: { $in: ['pending', 'processing'] },
        payout_amount_paise: { $gt: 0 },
        $or: [{ settlement_type: 'new' }, { settlement_type: { $exists: false }, total_amount_paise: { $exists: true } }],
    } },
    { $group: { _id: null, total: { $sum: '$payout_amount_paise' } } },
  ]).toArray();
  const pendingSettlement = inflightAgg[0]?.total || 0;

  // Last successful payout date — drives the dashboard "Last paid X days ago" chip.
  const lastPayout = await col(SETTLEMENTS).findOne(
    {
      restaurant_id: rid,
      status: 'completed',
      $or: [{ settlement_type: 'new' }, { settlement_type: { $exists: false }, total_amount_paise: { $exists: true } }],
    },
    { sort: { processed_at: -1 }, projection: { processed_at: 1, created_at: 1 } },
  );

  return {
    total_collected_paise:   calc.gross,
    total_refunded_paise:    calc.refunds,
    total_payout_paise:      calc.payouts,
    current_balance_paise:   calc.net_balance,
    pending_settlement_paise: pendingSettlement,
    payable_amount_paise:    calc.payable_amount,
    last_payout_date:        lastPayout?.processed_at || lastPayout?.created_at || null,
  };
}

// ─── TRANSACTIONS ───────────────────────────────────────────
// Paginated ledger entries. Filters:
//   from / to   — ISO date strings (inclusive / exclusive)
//   type        — 'credit' | 'debit'
//   ref_type    — 'payment' | 'refund' | 'payout' | 'fee'
//   page (1-based), limit (default 50, max 200)
async function getTransactions(restaurantId, {
  from, to, type, refType, page = 1, limit = 50,
} = {}) {
  const rid = String(restaurantId);
  const pg  = Math.max(1, parseInt(page, 10) || 1);
  const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

  const q = { restaurant_id: rid };
  if (from || to) {
    q.created_at = {};
    if (from) q.created_at.$gte = new Date(from);
    if (to)   q.created_at.$lt  = new Date(to);
  }
  if (type && ['credit', 'debit'].includes(type)) q.type = type;
  if (refType && ['payment', 'refund', 'payout', 'fee'].includes(refType)) q.ref_type = refType;

  const [items, total] = await Promise.all([
    col(LEDGER).find(q).sort({ created_at: -1 })
      .skip((pg - 1) * lim).limit(lim).toArray(),
    col(LEDGER).countDocuments(q),
  ]);

  return {
    items,
    pagination: { page: pg, limit: lim, total, pages: Math.ceil(total / lim) },
  };
}

// ─── SETTLEMENT HISTORY ─────────────────────────────────────
// Returns only Phase 5 paise-shaped rows (total_amount_paise present)
// so the dashboard shows the on-demand payout history cleanly,
// without mixing the weekly legacy rows.
async function getSettlements(restaurantId, { page = 1, limit = 25 } = {}) {
  const rid = String(restaurantId);
  const pg  = Math.max(1, parseInt(page, 10) || 1);
  const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));

  // Filter to Phase 5 rows only. Prefer settlement_type='new'; fall
  // back to presence of payout_amount_paise for rows written before
  // the type field was added.
  const q = {
    restaurant_id: rid,
    $or: [
      { settlement_type: 'new' },
      { payout_amount_paise: { $exists: true, $gt: 0 } },
    ],
  };

  const [items, total] = await Promise.all([
    col(SETTLEMENTS).find(q).sort({ created_at: -1 })
      .skip((pg - 1) * lim).limit(lim).toArray(),
    col(SETTLEMENTS).countDocuments(q),
  ]);

  return {
    items: items.map(s => ({
      id: s._id,
      gross_amount_paise:  s.gross_amount_paise ?? null,
      refund_amount_paise: s.refund_amount_paise ?? null,
      payout_amount_paise: s.payout_amount_paise,
      fee_amount_paise:    s.fee_amount_paise ?? 0,
      net_amount_paise:    s.net_amount_paise ?? s.payout_amount_paise,
      total_amount_paise:  s.total_amount_paise ?? s.payout_amount_paise,
      status: s.status,
      payout_id: s.payout_id,
      payout_provider: s.payout_provider || null,
      attempt_count: s.attempt_count || 0,
      last_attempt_at: s.last_attempt_at || null,
      failure_reason: s.failure_reason,
      trigger: s.trigger || null,
      created_at: s.created_at,
      processed_at: s.processed_at,
    })),
    pagination: { page: pg, limit: lim, total, pages: Math.ceil(total / lim) },
  };
}

module.exports = { getSummary, getTransactions, getSettlements };
