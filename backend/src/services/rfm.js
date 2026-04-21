// src/services/rfm.js
// Pure RFM scoring utility — no I/O. Consumed by
// jobs/rebuildCustomerProfiles.js. Segments follow the canonical
// RFM labeling with first-match-wins precedence so a Champion is
// never re-labeled as a Loyalist on the same row.

'use strict';

const LABELS = [
  'Champion',
  'Loyal',
  'Potential Loyalist',
  'At Risk',
  'Hibernating',
  'Lost',
  'Big Spender',
  'New Customer',
  'Other',
];

// Recency score — days since last order. Smaller days → higher score.
function recencyScore(daysSinceLastOrder) {
  const d = Number(daysSinceLastOrder);
  if (!Number.isFinite(d) || d < 0) return 1;
  if (d <= 7) return 5;
  if (d <= 14) return 4;
  if (d <= 21) return 3;
  if (d <= 30) return 2;
  return 1;
}

// Frequency score — total orders. More orders → higher score.
function frequencyScore(orderCount) {
  const n = Number(orderCount) || 0;
  if (n >= 10) return 5;
  if (n >= 7) return 4;
  if (n >= 4) return 3;
  if (n >= 2) return 2;
  return 1;
}

// Monetary scoring by quintile against the cohort. When the cohort is
// too small (<5) or collapses to a single value, fall back to a uniform
// 3 so we never emit bogus quintile splits.
function monetaryScores(customers) {
  const totals = customers.map((c) => Number(c.total_spend_rs) || 0);
  const n = totals.length;
  if (n === 0) return new Map();
  if (n < 5) {
    const m = new Map();
    customers.forEach((c) => m.set(c.customer_id, 3));
    return m;
  }
  const unique = new Set(totals);
  if (unique.size === 1) {
    const m = new Map();
    customers.forEach((c) => m.set(c.customer_id, 3));
    return m;
  }
  // Sort desc so the heaviest spenders sit at rank 0.
  const sorted = [...customers].sort(
    (a, b) => (Number(b.total_spend_rs) || 0) - (Number(a.total_spend_rs) || 0),
  );
  const m = new Map();
  sorted.forEach((c, i) => {
    // Quintile split — 0..n-1 maps to scores 5→1.
    const pct = i / n;
    let score;
    if (pct < 0.2) score = 5;
    else if (pct < 0.4) score = 4;
    else if (pct < 0.6) score = 3;
    else if (pct < 0.8) score = 2;
    else score = 1;
    m.set(c.customer_id, score);
  });
  return m;
}

// Label precedence — first match wins. Champions/Loyals are checked
// before overlapping broader buckets (Big Spender, New Customer) so
// the strongest signal always takes the row.
function labelFor({ r, f, m, orderCount }) {
  if (r >= 4 && f >= 4 && m >= 4) return 'Champion';
  if (r >= 3 && f >= 4) return 'Loyal';
  if (m >= 4 && f >= 3) return 'Big Spender';
  if (r >= 4 && (orderCount || 0) <= 2) return 'New Customer';
  if (r >= 3 && f >= 2) return 'Potential Loyalist';
  if (r <= 2 && f >= 3) return 'At Risk';
  if (r <= 2 && f <= 2 && m >= 2) return 'Hibernating';
  if (r === 1 && f === 1) return 'Lost';
  return 'Other';
}

// Input: array of { customer_id, order_count, total_spend_rs,
// days_since_last_order }. Output: same rows with r_score, f_score,
// m_score, rfm_label appended. Pure — no db, no Date.now().
function computeRFMScores(customers) {
  const list = Array.isArray(customers) ? customers : [];
  if (list.length === 0) return [];
  const mMap = monetaryScores(list);
  return list.map((c) => {
    const r = recencyScore(c.days_since_last_order);
    const f = frequencyScore(c.order_count);
    const m = mMap.get(c.customer_id) ?? 3;
    const rfm_label = labelFor({ r, f, m, orderCount: c.order_count });
    return { ...c, r_score: r, f_score: f, m_score: m, rfm_label };
  });
}

module.exports = {
  computeRFMScores,
  recencyScore,
  frequencyScore,
  monetaryScores,
  labelFor,
  LABELS,
};
