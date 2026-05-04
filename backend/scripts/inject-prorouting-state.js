#!/usr/bin/env node
'use strict';

// scripts/inject-prorouting-state.js
//
// Admin-only test harness: POSTs a synthetic Prorouting status callback
// to our own /webhook/prorouting endpoint to drive the post-dispatch
// state machine through a chosen lifecycle state without depending on
// Prorouting staging (which auto-cancels every test order).
//
// Usage on EC2:
//   cd /home/ubuntu/GullyBite/backend
//   node --env-file=/home/ubuntu/GullyBite/.env scripts/inject-prorouting-state.js \
//     --order_number=ZM-20260504-0013 --state=Picked-up
//
// CLI flags:
//   --order_number=<string>   required (e.g. ZM-20260504-0013)
//   --state=<string>          required: Picked-up | At-delivery | Delivered | Cancelled
//   --base_url=<string>       optional, default https://gullybite.duckdns.org
//
// Required env: PROROUTING_WEBHOOK_SECRET, MONGODB_URI.
// Built-in fetch (Node 20+); no axios/external deps.
//
// Wire shape: mirrors the diagnostic capture from pm2 logs at
// 2026-05-04 09:56:25-09:57:15 (the "Agent-assigned" → "Cancelled"
// pair Prorouting actually sent during preprod testing). Timestamps
// use Prorouting's "YYYY-MM-DD HH:MM:SS" form in IST — NOT ISO 8601,
// despite the user spec's "ISO time" wording. Real Prorouting sends
// IST; mirroring it keeps this payload byte-equivalent to a real one.

const crypto = require('crypto');
const { MongoClient } = require('mongodb');

function parseArgs(argv) {
  const out = { order_number: null, state: null, base_url: 'https://gullybite.duckdns.org' };
  for (const raw of argv.slice(2)) {
    const m = raw.match(/^--([a-z_]+)=(.+)$/);
    if (!m) continue;
    if (m[1] in out) out[m[1]] = m[2];
  }
  return out;
}

const VALID_STATES = ['Picked-up', 'At-delivery', 'Delivered', 'Cancelled'];

// Format a JS Date as Prorouting's wire format: "YYYY-MM-DD HH:MM:SS"
// in IST. We shift the UTC instant by +5h30m, ISO-stringify it (the
// resulting string is labeled UTC by toISOString but the digits are
// IST), then slice off the T separator and milliseconds/Z suffix.
function fmtProroutingTime(d = new Date()) {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().replace('T', ' ').slice(0, 19);
}

// Forward an existing prorouting_* timestamp from the order doc into
// Prorouting's wire format. Empty string when the field is absent —
// matches what Prorouting actually sends for never-reached states.
function fwdTime(order, field) {
  const v = order && order[field];
  if (!v) return '';
  try { return fmtProroutingTime(new Date(v)); } catch { return ''; }
}

function buildPayload(order, state, args) {
  const now = new Date();
  const nowStr = fmtProroutingTime(now);

  // mp2_order_id and network_order_id come from the order doc when
  // they exist (real dispatch already happened); otherwise fall back
  // to deterministic-looking placeholders so the payload still
  // validates downstream. Warn case is logged at the call site.
  const proroutingOrderId = order?.prorouting_order_id
    || `mfnb_${crypto.randomBytes(4).toString('hex')}`;
  const orderNumberTail = String(order?.order_number || args.order_number || '').replace(/^ZM-\d+-/, '');
  const networkOrderId = order?.prorouting_network_order_id
    || `ord${proroutingOrderId}_${crypto.randomBytes(3).toString('hex')}_${orderNumberTail}`;

  // Pre-existing timestamps on the order doc, formatted for the wire.
  // The state-specific block below overrides per the requested state.
  let atpickup_at = fwdTime(order, 'prorouting_at_pickup_at');
  let pickedup_at = fwdTime(order, 'prorouting_pickedup_at');
  let atdelivery_at = fwdTime(order, 'prorouting_at_delivery_at');
  let delivered_at = fwdTime(order, 'prorouting_delivered_at');
  let cancelled_at = fwdTime(order, 'prorouting_cancelled_at');

  if (state === 'Picked-up') {
    // atpickup = rider arrived at restaurant; pickedup = rider left
    // with the order. Real flows have minutes between; we stamp both
    // at once because the state machine cares about the LATEST event.
    atpickup_at = nowStr;
    pickedup_at = nowStr;
  } else if (state === 'At-delivery') {
    // Need a coherent timeline — if pickedup_at is empty (e.g. the
    // assigned callback was the last real one to land), backfill it
    // to "now" so downstream state-machine reads see a non-empty
    // pickedup_at when transitioning to At-delivery.
    if (!pickedup_at) pickedup_at = nowStr;
    atdelivery_at = nowStr;
  } else if (state === 'Delivered') {
    if (!atpickup_at) atpickup_at = nowStr;
    if (!pickedup_at) pickedup_at = nowStr;
    if (!atdelivery_at) atdelivery_at = nowStr;
    delivered_at = nowStr;
  } else if (state === 'Cancelled') {
    cancelled_at = nowStr;
  }

  // last_location is null after Delivered/Cancelled (the rider session
  // ends); populated mid-flight. Coords are a known Hyderabad point so
  // the rider-location card has something plausible to render.
  const lastLocation = (state === 'Picked-up' || state === 'At-delivery')
    ? { lat: 17.385, lng: 78.4867, updated_at: nowStr }
    : null;

  // assigned_at/created_at: forward when known. Fall back to "now" so
  // the payload is internally consistent even when injecting on top of
  // an order whose assigned callback was never received.
  const assignedAtStr = fwdTime(order, 'prorouting_assigned_at') || nowStr;

  return {
    status: 1,
    order: {
      id: proroutingOrderId,
      client_order_id: order?.order_number || args.order_number,
      state,
      lsp: {
        id: 'preprod.logistics-seller.prorouting.in',
        name: 'Prorouting',
        item_id: 'prorouting_immediate',
        network_order_id: networkOrderId,
      },
      price: Number(order?.prorouting_estimate_price) || 0,
      fees: {
        lsp: 0,
        platform: 0,
        total_with_tax: Number(order?.prorouting_estimate_price) || 0,
      },
      distance: 0,
      rider: {
        name: 'Test Rider (injected)',
        phone: '9999100000',
        last_location: lastLocation,
      },
      created_at: assignedAtStr,
      assigned_at: assignedAtStr,
      atpickup_at,
      pickedup_at,
      atdelivery_at,
      delivered_at,
      cancelled_at,
      rto_initiated_at: fwdTime(order, 'prorouting_rto_initiated_at'),
      rto_delivered_at: fwdTime(order, 'prorouting_rto_delivered_at'),
      estimated_pickup_time: '',
      pickup_proof: '',
      delivery_proof: '',
      tracking_url: order?.prorouting_tracking_url
        || `https://track.prorouting.in/r/${networkOrderId}`,
      cancellation: state === 'Cancelled'
        ? {
            reason_id: '005',
            cancelled_by: 'preprod.logistics-buyer.prorouting.in',
            reason_desc: 'Test cancellation injected by inject-prorouting-state.js',
          }
        : { reason_id: '', cancelled_by: '', reason_desc: '' },
      customer: {
        name: order?.receiver_name || 'Customer',
        phone: order?.receiver_phone || '',
        address: order?.delivery_address || '',
      },
      note1: '',
      note2: '',
    },
  };
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.order_number) {
    console.error('--order_number is required (e.g. --order_number=ZM-20260504-0013)');
    process.exit(1);
  }
  if (!args.state) {
    console.error(`--state is required (one of: ${VALID_STATES.join(', ')})`);
    process.exit(1);
  }
  if (!VALID_STATES.includes(args.state)) {
    console.error(`invalid --state '${args.state}' — must be one of: ${VALID_STATES.join(', ')}`);
    process.exit(1);
  }
  if (!process.env.PROROUTING_WEBHOOK_SECRET) {
    console.error('PROROUTING_WEBHOOK_SECRET not set — pass via --env-file');
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI not set — pass via --env-file');
    process.exit(1);
  }
  if (typeof fetch !== 'function') {
    console.error('global fetch unavailable — Node 20+ required');
    process.exit(1);
  }

  // ─── Order lookup ────────────────────────────────────────────
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db('gullybite');
  console.log('[inject-prorouting-state] mongo connected: gullybite');

  const order = await db.collection('orders').findOne({ order_number: args.order_number });
  if (!order) {
    console.error(`order not found by order_number=${args.order_number}`);
    await client.close();
    process.exit(1);
  }
  if (!order.prorouting_order_id) {
    console.warn(
      `[inject-prorouting-state] WARN: order ${args.order_number} has no prorouting_order_id ` +
      '(assigned callback never landed). Using placeholder mp2/network ids — payload state ' +
      'will still drive the state machine, but the order.id field is fake.',
    );
  }
  console.log(`[inject-prorouting-state] order resolved: ${args.order_number} (prorouting_order_id=${order.prorouting_order_id || '(placeholder)'})`);

  await client.close();

  // ─── Build payload ───────────────────────────────────────────
  const payload = buildPayload(order, args.state, args);

  // ─── POST to our own webhook ────────────────────────────────
  const url = `${args.base_url.replace(/\/$/, '')}/webhook/prorouting`;
  console.log(`[inject-prorouting-state] POST ${url}`);
  console.log(`[inject-prorouting-state] state: ${args.state}`);
  console.log(`[inject-prorouting-state] order_number: ${args.order_number}`);

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-gullybite-webhook-secret': process.env.PROROUTING_WEBHOOK_SECRET,
    },
    body: JSON.stringify(payload),
  });
  const respText = await resp.text();
  console.log(`[inject-prorouting-state] HTTP ${resp.status} ${resp.statusText} — body: ${respText}`);

  // Webhook handler always returns 200 once auth passes (Prorouting
  // retries on non-200; we mirror that semantic). A 401 here means the
  // webhook secret didn't match; a 500 means the env var was missing
  // server-side; anything else is unexpected.
  if (resp.status !== 200) {
    console.error('[inject-prorouting-state] non-200 response — check webhook auth and server logs');
    process.exit(1);
  }
}

main().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error('[inject-prorouting-state] FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
