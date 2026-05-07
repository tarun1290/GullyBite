#!/usr/bin/env node
'use strict';

// scripts/audit-campaign-templates.js
//
// One-off READ-ONLY diagnostic for the campaign_templates collection.
// Connects directly via the MongoDB driver — no business-code services
// loaded — so it stays safe to run against prod from the EC2 host.
//
// Usage on EC2:
//   node --env-file=/home/ubuntu/GullyBite/.env backend/scripts/audit-campaign-templates.js
//
// Reads:  process.env.MONGODB_URI, process.env.MONGODB_DB
// Writes: nothing.

const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB;

function pad(s, n) {
  const str = String(s ?? '');
  if (str.length >= n) return str.slice(0, n - 1) + '…';
  return str + ' '.repeat(n - str.length);
}

function fmtBool(v) {
  if (v === true) return 'true';
  if (v === false) return 'false';
  return '—';
}

function fmtNum(v) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  return String(v);
}

async function main() {
  if (!MONGODB_URI) {
    console.error('FATAL: MONGODB_URI not set in environment');
    process.exit(1);
  }
  if (!MONGODB_DB) {
    console.error('FATAL: MONGODB_DB not set in environment');
    process.exit(1);
  }

  const client = new MongoClient(MONGODB_URI, { ignoreUndefined: true });
  try {
    await client.connect();
    const db = client.db(MONGODB_DB);
    const col = db.collection('campaign_templates');

    const docs = await col
      .find({}, {
        projection: {
          template_id: 1,
          use_case: 1,
          meta_template_id: 1,
          meta_approval_status: 1,
          is_active: 1,
          per_message_cost_rs: 1,
          display_name: 1,
        },
      })
      .sort({ use_case: 1, template_id: 1 })
      .toArray();

    // ── TABLE ─────────────────────────────────────────────
    const COLS = [
      ['template_id', 30],
      ['use_case', 22],
      ['meta_template_id', 22],
      ['approval', 10],
      ['active', 7],
      ['cost_rs', 8],
      ['display_name', 32],
    ];

    const headerLine = COLS.map(([h, w]) => pad(h, w)).join('  ');
    const sep = COLS.map(([, w]) => '─'.repeat(w)).join('  ');
    console.log('\n' + headerLine);
    console.log(sep);

    for (const d of docs) {
      console.log(
        [
          pad(d.template_id || '—', 30),
          pad(d.use_case || '—', 22),
          pad(d.meta_template_id || '—', 22),
          pad(d.meta_approval_status || '—', 10),
          pad(fmtBool(d.is_active), 7),
          pad(fmtNum(d.per_message_cost_rs), 8),
          pad(d.display_name || '—', 32),
        ].join('  '),
      );
    }
    console.log('');

    // ── SUMMARY ───────────────────────────────────────────
    const total = docs.length;
    const approved = docs.filter((d) => d.meta_approval_status === 'approved').length;
    const withMetaId = docs.filter(
      (d) => d.meta_template_id != null && String(d.meta_template_id).trim() !== '',
    ).length;

    const byUseCase = new Map();
    for (const d of docs) {
      const k = d.use_case || '(missing)';
      byUseCase.set(k, (byUseCase.get(k) || 0) + 1);
    }

    console.log('────────────── SUMMARY ──────────────');
    console.log(`Total rows:                 ${total}`);
    console.log(`meta_approval_status=approved: ${approved}`);
    console.log(`meta_template_id present:   ${withMetaId}`);
    console.log('');
    console.log('By use_case:');
    const sorted = [...byUseCase.entries()].sort(
      (a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])),
    );
    for (const [u, n] of sorted) {
      console.log(`  ${pad(u, 22)} ${n}`);
    }
    console.log('');
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('audit-campaign-templates failed:', err?.message || err);
  process.exit(1);
});
