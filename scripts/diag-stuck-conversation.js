#!/usr/bin/env node
'use strict';

// scripts/diag-stuck-conversation.js
//
// Read-only diagnostic for the "customer says HI but bot doesn't respond"
// failure mode. Reuses the cached MongoDB connection from
// backend/src/config/database.js so it doesn't open a fresh pool when run
// alongside the live server.
//
// Run on EC2:
//   node --env-file=/home/ubuntu/GullyBite/.env scripts/diag-stuck-conversation.js
//   node --env-file=/home/ubuntu/GullyBite/.env scripts/diag-stuck-conversation.js --phone +919XXXXXXXXX
//
// No writes. No deletes. Safe to run against prod.

const path = require('path');
const { connect, col } = require(path.join(__dirname, '..', 'backend', 'src', 'config', 'database'));

// ─── arg parsing ─────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { phone: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--phone' && argv[i + 1]) {
      out.phone = String(argv[i + 1]).trim();
      i += 1;
    } else if (a && a.startsWith('--phone=')) {
      out.phone = a.slice('--phone='.length).trim();
    }
  }
  return out;
}

// ─── formatting helpers ──────────────────────────────────────────
function maskPhone(p) {
  if (!p) return '(none)';
  const s = String(p).replace(/\s+/g, '');
  if (s.length <= 5) return s;
  return `${s.slice(0, 3)}…${s.slice(-2)}`;
}

function relativeTime(d) {
  if (!d) return '(none)';
  const t = new Date(d).getTime();
  if (Number.isNaN(t)) return '(invalid)';
  const diffSec = Math.floor((Date.now() - t) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} h ago`;
  return `${Math.floor(diffSec / 86400)} d ago`;
}

function fmtRow(label, value) {
  return `  ${label.padEnd(18)} ${value}`;
}

function header(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length - 4))}`);
}

// ─── core queries ────────────────────────────────────────────────

// Resolve a phone string to one or more customer documents. Tries an
// exact wa_phone match first, then falls back to last-10-digit suffix
// (covers +91 vs 91 vs bare 10-digit storage variations).
async function findCustomersByPhone(phone) {
  const customers = col('customers');
  const direct = await customers.find({ wa_phone: phone }).toArray();
  if (direct.length) return direct;
  const digits = phone.replace(/\D/g, '');
  if (digits.length >= 10) {
    const suffix = digits.slice(-10);
    return await customers.find({ wa_phone: { $regex: `${suffix}$` } }).limit(20).toArray();
  }
  return [];
}

async function listRecentConversations(limit = 10) {
  const convs = await col('conversations')
    .find({})
    .sort({ updated_at: -1, _id: -1 })
    .limit(limit)
    .toArray();
  if (!convs.length) {
    console.log('  (no conversations found)');
    return;
  }
  // Bulk-fetch the customers we need so we can mask phones in the listing.
  const customerIds = [...new Set(convs.map((c) => c.customer_id).filter(Boolean))];
  const customers = customerIds.length
    ? await col('customers').find({ _id: { $in: customerIds } }, { projection: { _id: 1, wa_phone: 1, name: 1 } }).toArray()
    : [];
  const custById = new Map(customers.map((c) => [String(c._id), c]));
  for (const c of convs) {
    const cust = custById.get(String(c.customer_id));
    console.log(fmtRow('conv_id',         String(c._id || c.id || '?')));
    console.log(fmtRow('restaurant_id',   String(c.restaurant_id || '(none)')));
    console.log(fmtRow('customer_id',     String(c.customer_id || '(none)')));
    console.log(fmtRow('wa_phone',        maskPhone(cust?.wa_phone)));
    console.log(fmtRow('state',           String(c.state || '(none)')));
    console.log(fmtRow('updated_at',      `${c.updated_at ? new Date(c.updated_at).toISOString() : '(none)'} (${relativeTime(c.updated_at)})`));
    if (Array.isArray(c.messages) && c.messages.length) {
      const tail = c.messages.slice(-5);
      console.log(`  last_messages      (${tail.length})`);
      for (const m of tail) {
        const ts = m.timestamp || m.received_at || m.created_at;
        const text = (m.text || m.body || m.content || '').toString().slice(0, 80);
        const role = m.role || m.direction || m.from || '?';
        console.log(`    [${role}] ${text || '(non-text)'} — ${ts ? relativeTime(ts) : '(no ts)'}`);
      }
    }
    console.log('');
  }
}

async function detailConversation(phone) {
  const customers = await findCustomersByPhone(phone);
  if (!customers.length) {
    console.log(`  No customer document matches phone ${maskPhone(phone)}.`);
    return;
  }
  for (const cust of customers) {
    header(`CUSTOMER ${maskPhone(cust.wa_phone)}`);
    console.log(fmtRow('customer_id',     String(cust._id)));
    console.log(fmtRow('name',            cust.name || cust.wa_name || '(none)'));
    console.log(fmtRow('addresses',       Array.isArray(cust.addresses) ? cust.addresses.length : 0));
    console.log(fmtRow('created_at',      cust.created_at ? new Date(cust.created_at).toISOString() : '(none)'));

    // ── conversations ───────────────────────────────────────────
    const convs = await col('conversations')
      .find({ customer_id: cust._id })
      .sort({ updated_at: -1, _id: -1 })
      .limit(10)
      .toArray();
    header(`CONVERSATIONS (${convs.length})`);
    for (const c of convs) {
      console.log(fmtRow('conv_id',          String(c._id || c.id)));
      console.log(fmtRow('restaurant_id',    String(c.restaurant_id || '(none)')));
      console.log(fmtRow('state',            String(c.state || '(none)')));
      console.log(fmtRow('updated_at',       `${c.updated_at ? new Date(c.updated_at).toISOString() : '(none)'} (${relativeTime(c.updated_at)})`));
      console.log(fmtRow('flow_token',       c.session_data?.flow_token || c.flow_token || '(none)'));
      const pendingOrder = c.session_data?.pendingOrder || c.session_data?.pending_order || c.pending_order || null;
      console.log(fmtRow('pending_order',    pendingOrder ? JSON.stringify(pendingOrder).slice(0, 120) : '(none)'));
      // Full doc (key timestamps) — truncated print so we don't dump 5KB carts
      const sessionPreview = c.session_data ? JSON.stringify(c.session_data).slice(0, 240) : '(none)';
      console.log(fmtRow('session_data',     sessionPreview));
      console.log(fmtRow('created_at',       c.created_at ? new Date(c.created_at).toISOString() : '(none)'));
      if (Array.isArray(c.messages) && c.messages.length) {
        const tail = c.messages.slice(-5);
        console.log(`  last_messages       (${tail.length})`);
        for (const m of tail) {
          const ts = m.timestamp || m.received_at || m.created_at;
          const text = (m.text || m.body || m.content || '').toString().slice(0, 80);
          const role = m.role || m.direction || m.from || '?';
          console.log(`    [${role}] ${text || '(non-text)'} — ${ts ? relativeTime(ts) : '(no ts)'}`);
        }
      }
      console.log('');
    }

    // ── recent webhook_logs for this restaurant (best effort) ───
    if (convs[0]?.restaurant_id) {
      header('RECENT webhook_logs (this restaurant)');
      const logs = await col('webhook_logs')
        .find({ source: 'whatsapp' })
        .sort({ received_at: -1, _id: -1 })
        .limit(3)
        .toArray()
        .catch(() => []);
      if (!logs.length) {
        console.log('  (no recent webhook_logs)');
      } else {
        for (const wl of logs) {
          console.log(fmtRow('event_type',       wl.event_type || '(none)'));
          console.log(fmtRow('received_at',      wl.received_at ? new Date(wl.received_at).toISOString() : '(none)'));
          console.log(fmtRow('processed',        wl.processed === true ? 'true' : (wl.processed === false ? 'false' : '(none)')));
          console.log(fmtRow('error_message',    wl.error_message || '(none)'));
          console.log('');
        }
      }
    }

    // ── blocked_phones check ────────────────────────────────────
    header('BLOCKED PHONES check');
    const block = await col('blocked_phones').findOne({ phone: cust.wa_phone }).catch(() => null);
    if (block) {
      console.log(fmtRow('blocked',          'YES'));
      console.log(fmtRow('reason',           block.reason || '(none)'));
      console.log(fmtRow('blocked_at',       block.blocked_at ? new Date(block.blocked_at).toISOString() : '(none)'));
      console.log(fmtRow('expires_at',       block.expires_at ? new Date(block.expires_at).toISOString() : '(none)'));
    } else {
      console.log('  not blocked in blocked_phones');
    }

    // ── activity_logs (errors / warnings) ───────────────────────
    header('RECENT activity_logs (this customer)');
    const acts = await col('activity_logs')
      .find({ actorId: cust.wa_phone || String(cust._id) })
      .sort({ created_at: -1, _id: -1 })
      .limit(3)
      .toArray()
      .catch(() => []);
    if (!acts.length) {
      console.log('  (no recent activity_logs)');
    } else {
      for (const a of acts) {
        console.log(fmtRow('action',           a.action || '(none)'));
        console.log(fmtRow('severity',         a.severity || '(none)'));
        console.log(fmtRow('description',      (a.description || '').slice(0, 120)));
        console.log(fmtRow('created_at',       a.created_at ? new Date(a.created_at).toISOString() : '(none)'));
        console.log('');
      }
    }
  }
}

// ─── main ────────────────────────────────────────────────────────
(async () => {
  const args = parseArgs(process.argv.slice(2));
  let exitCode = 0;
  try {
    await connect();
    if (args.phone) {
      header(`DIAG — phone ${maskPhone(args.phone)}`);
      await detailConversation(args.phone);
    } else {
      header('DIAG — 10 most recently updated conversations');
      await listRecentConversations(10);
    }
  } catch (err) {
    console.error('[diag] ERROR:', err && err.message ? err.message : err);
    exitCode = 1;
  } finally {
    // The cached client is shared with anything else in this process; if
    // we're the only consumer (running standalone), close it so node
    // exits cleanly. Use globalThis to read the same handle the helper
    // stashes so we don't accidentally leak an open pool.
    try { await globalThis._mongoClient?.close(); } catch (_) { /* ignore */ }
    process.exit(exitCode);
  }
})();
