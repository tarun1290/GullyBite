#!/usr/bin/env node
// scripts/test-paid-order.js
//
// CLI test harness: simulates a Razorpay payment success on a customer's
// LATEST EXISTING order and enqueues the full post-payment job chain
// (customer notification + POS sync + Petpooja push) through the durable
// queue/postPaymentJobs queue — the SAME enqueue call razorpay.js makes
// (see src/webhooks/razorpay.js:657).
//
// It then polls the order doc for the Petpooja stamp so you can watch a
// running worker pick the jobs up. This script ENQUEUES + OBSERVES only;
// it does not run the worker loop (postPaymentJobs.start() lives in the
// app process). If nothing is running start()'d, the jobs sit pending.
//
// WRITES: flips the chosen order to status:'PAID' and enqueues real
// queue jobs (incl. a live Petpooja push). Run deliberately, against a
// disposable test order.
//
// Local:  node backend/scripts/test-paid-order.js --restaurant_id <id> --branch_id <id> --customer_phone <phone>
// EC2:    node --env-file=/home/ubuntu/GullyBite/.env backend/scripts/test-paid-order.js --restaurant_id <id> --branch_id <id> --customer_phone <phone>

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), quiet: true });

const { connect, col } = require('../src/config/database');

// ─── ARG PARSING (process.argv, no minimist) ────────────────
// Supports both `--key value` and `--key=value`.
function parseArgs(argv) {
  const out = {};
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (!tok.startsWith('--')) continue;
    const eq = tok.indexOf('=');
    if (eq !== -1) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
    } else {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[tok.slice(2)] = next;
        i++;
      } else {
        out[tok.slice(2)] = true;
      }
    }
  }
  return out;
}

function usage(msg) {
  if (msg) console.error('\nERROR: ' + msg);
  console.error(`
Usage:
  node backend/scripts/test-paid-order.js \\
    --restaurant_id <restaurantId> \\
    --branch_id <branchId> \\
    --customer_phone <phone>

  --restaurant_id   restaurants._id of the tenant
  --branch_id       branches._id the order belongs to
  --customer_phone  customer phone (any format; matched on trailing digits)

Finds the customer's latest order for that branch+restaurant, marks it
PAID, and enqueues the post-payment job chain (mirrors razorpay.js).
`);
  process.exit(1);
}

// ─── MAIN ───────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  const restaurantId = args.restaurant_id;
  const branchId = args.branch_id;
  const customerPhone = args.customer_phone;

  if (!restaurantId || restaurantId === true) usage('--restaurant_id is required');
  if (!branchId || branchId === true) usage('--branch_id is required');
  if (!customerPhone || customerPhone === true) usage('--customer_phone is required');

  await connect();

  // ── Find customer by phone (regex on trailing digits) ──
  const digits = String(customerPhone).replace(/\D/g, '');
  if (!digits) usage('--customer_phone has no usable digits');
  const phoneRegex = new RegExp(digits + '$');
  const customer = await col('customers').findOne({ wa_phone: { $regex: phoneRegex } });
  if (!customer) {
    console.error(`No customer found with wa_phone matching trailing digits "${digits}"`);
    process.exit(1);
  }
  console.log(`Customer: ${customer._id} (${customer.name || '—'}, wa_phone=${customer.wa_phone})`);

  // ── Latest order for this customer + branch + restaurant ──
  const order = await col('orders')
    .find({
      customer_id: String(customer._id),
      branch_id: branchId,
      restaurant_id: restaurantId,
    })
    .sort({ created_at: -1 })
    .limit(1)
    .next();

  if (!order) {
    console.error(`No order found for customer=${customer._id}, branch=${branchId}, restaurant=${restaurantId}`);
    process.exit(1);
  }

  const itemCount = Array.isArray(order.items) ? order.items.length : 0;
  console.log('\n── ORDER SUMMARY ──');
  console.log(`  _id:        ${order._id}`);
  console.log(`  order_no:   ${order.order_number ?? '—'}`);
  console.log(`  status:     ${order.status}`);
  console.log(`  total_rs:   ${order.total_rs ?? '—'}`);
  console.log(`  items:      ${itemCount}`);
  console.log(`  created_at: ${order.created_at ? new Date(order.created_at).toISOString() : '—'}`);

  // ── Simulate Razorpay payment success ──
  const now = new Date();
  const paymentId = `test_pay_${Date.now()}`;
  const upd = await col('orders').updateOne(
    { _id: order._id },
    {
      $set: {
        status: 'PAID',
        paid_at: now,
        payment_id: paymentId,
        payment_method: 'razorpay_test_simulated',
        updated_at: now,
        // notified_at is what the dashboard's pending-order poll keys on
        // to distinguish never-shown vs already-shown orders. Recycling
        // an existing order without resetting this leaves the new-order
        // modal in a half-shown state.
        notified_at: now,
      },
      // Recycling a previously-completed order leaves every downstream
      // lifecycle/petpooja/prorouting field stamped from its prior life.
      // The stalest of those — acknowledged_at — makes /accept's CAS
      // (filter: { acknowledged_at: { $exists: false } }) no-op
      // immediately, so the order never cleanly leaves PAID and the
      // new-order modal re-fires endlessly. Clear every downstream
      // field so the recycled order behaves like a genuine first-time
      // PAID order.
      $unset: {
        acknowledged_at: '', acknowledged_by: '',
        confirmed_at: '', preparing_at: '', packed_at: '',
        dispatched_at: '', delivered_at: '', cancelled_at: '',
        decline_reason: '', cancellation_reason: '', cancellation_fault_fee: '',
        refund_id: '', refund_amount_rs: '',
        petpooja_order_id: '', petpooja_pushed_at: '', petpooja_push_failed: '', petpooja_pos_status: '',
        prorouting_order_id: '', prorouting_dispatch_attempts: '',
      },
    },
  );
  console.log(`\nMarked PAID (matched=${upd.matchedCount}, modified=${upd.modifiedCount}, payment_id=${paymentId})`);

  // ── Enqueue post-payment job chain ──
  // Mirrors src/webhooks/razorpay.js:657 — enqueueForOrder takes a
  // single options object { orderId, restaurantId, posEnabled,
  // petpoojaEnabled }, NOT (orderId, opts). petpoojaEnabled forced true
  // so the Petpooja push job is always queued for this test.
  const { POS_INTEGRATIONS_ENABLED } = require('../src/config/features');
  const { enqueueForOrder } = require('../src/queue/postPaymentJobs');
  await enqueueForOrder({
    orderId: order._id,
    restaurantId: order.restaurant_id,
    posEnabled: !!POS_INTEGRATIONS_ENABLED,
    petpoojaEnabled: true,
  });
  console.log('Jobs enqueued. Worker loop will process them in background.');

  // ── Poll for the Petpooja stamp (every 2s, up to 30s) ──
  const POLL_MS = 2000;
  const TIMEOUT_MS = 30000;
  const deadline = Date.now() + TIMEOUT_MS;
  let latest = order;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    latest = await col('orders').findOne(
      { _id: order._id },
      { projection: { petpooja_order_id: 1, petpooja_pushed_at: 1, petpooja_push_failed: 1, status: 1 } },
    );
    const secs = Math.round((TIMEOUT_MS - (deadline - Date.now())) / 1000);
    console.log(
      `  [+${secs}s] status=${latest?.status} ` +
      `petpooja_order_id=${latest?.petpooja_order_id ?? '—'} ` +
      `push_failed=${latest?.petpooja_push_failed ?? '—'}`,
    );
    if (latest?.petpooja_order_id || latest?.petpooja_push_failed) break;
  }

  console.log('\n── FINAL PETPOOJA STATE ──');
  console.log(`  petpooja_order_id:    ${latest?.petpooja_order_id ?? '—'}`);
  console.log(`  petpooja_pushed_at:   ${latest?.petpooja_pushed_at ? new Date(latest.petpooja_pushed_at).toISOString() : '—'}`);
  console.log(`  petpooja_push_failed: ${latest?.petpooja_push_failed ?? '—'}`);

  if (!latest?.petpooja_order_id && !latest?.petpooja_push_failed) {
    console.log('\nNot stamped within 30s. Is a worker (postPaymentJobs.start()) running in the app process?');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('Fatal:', err && err.message ? err.message : err); process.exit(2); });
