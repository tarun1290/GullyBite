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

  // Early visibility: items array must be non-empty for Petpooja
  // /save_order to produce a usable payload. A recycled order without
  // items can't exercise the Petpooja push end-to-end.
  if (itemCount === 0) {
    console.warn('\nWARN: order.items is empty — Petpooja /save_order payload will have zero line items.');
  }

  // ── Marathahalli test-coordinates (Bengaluru, pincode 560103) ──
  // Backfill ONLY when the recycled order is missing the field so we
  // don't overwrite a legitimately-placed order's real address with
  // synthetic coords. dispatchDelivery (services/delivery/index.js:90-98)
  // builds drop.{lat,lng,address,city} from these four fields — without
  // them the provider's quote falls back to mock or quotes with an
  // empty city, defeating the purpose of exercising the prorouting
  // path end-to-end.
  const MARATHAHALLI_LAT  = 12.9208;
  const MARATHAHALLI_LNG  = 77.6852;
  const MARATHAHALLI_CITY = 'Bengaluru';
  const MARATHAHALLI_PIN  = '560103';
  const MARATHAHALLI_ADDR = 'Marathahalli, Bengaluru, Karnataka 560103';

  const backfill = {};
  if (order.delivery_lat == null) backfill.delivery_lat = MARATHAHALLI_LAT;
  if (order.delivery_lng == null) backfill.delivery_lng = MARATHAHALLI_LNG;
  if (!order.delivery_address) backfill.delivery_address = MARATHAHALLI_ADDR;
  if (!order.structured_address || !order.structured_address.city) {
    backfill.structured_address = {
      city: MARATHAHALLI_CITY,
      state: 'Karnataka',
      pincode: MARATHAHALLI_PIN,
      formatted_address: MARATHAHALLI_ADDR,
      ...(order.structured_address || {}),
    };
  }
  if (Object.keys(backfill).length) {
    console.log(`Backfilling missing dispatch fields: ${Object.keys(backfill).join(', ')}`);
  }

  // ── Simulate Razorpay payment success ──
  const now = new Date();
  const paymentId = `test_pay_${Date.now()}`;
  // expires_at fresh (now + 20 min) so the payment-expiry gate at
  // webhooks/razorpay.js:255 doesn't fire if this row is processed
  // late (e.g. worker resume after a restart). The recycled order's
  // original expires_at is almost certainly in the past.
  const expiresAt = new Date(now.getTime() + 20 * 60 * 1000);

  const upd = await col('orders').updateOne(
    { _id: order._id },
    {
      $set: {
        status: 'PAID',
        paid_at: now,
        payment_id: paymentId,
        payment_method: 'razorpay_test_simulated',
        updated_at: now,
        // Override creation time on the recycled order. routes/restaurant.js
        // GET /orders sorts by created_at desc; without this the order
        // keeps its original (potentially old) creation date and buries
        // itself outside the visible page / date window. Stamping it to
        // now makes the test order surface at the top like a genuine
        // first-time PAID order.
        created_at: now,
        // notified_at is what the dashboard's pending-order poll keys on
        // to distinguish never-shown vs already-shown orders. Recycling
        // an existing order without resetting this leaves the new-order
        // modal in a half-shown state.
        notified_at: now,
        // Fresh payment-expiry window so the post-payment gate doesn't
        // refund + flip to EXPIRED_PAYMENT on a recycled row whose
        // original expires_at is months in the past.
        expires_at: expiresAt,
        // DELIBERATELY NOT TOUCHED: customers.last_inbound_at.
        // Customer-facing notifications (orderNotify, sendStatusUpdate)
        // are CSW-gated — they only send when the customer messaged us
        // in the last 24h. Faking last_inbound_at here would make this
        // test LIE about whether notifications can legally send. This
        // script exercises Petpooja-push + prorouting-dispatch +
        // acceptance mechanics ONLY. Customer-message delivery must be
        // validated against a real WhatsApp order. Do NOT add a
        // last_inbound_at $set to this script.
        ...backfill,
      },
      // Recycling a previously-completed order leaves every downstream
      // lifecycle/petpooja/prorouting field stamped from its prior life.
      // The stalest of those — acknowledged_at — makes /accept's CAS
      // (filter: { acknowledged_at: { $exists: false } }) no-op
      // immediately, so the order never cleanly leaves PAID and the
      // new-order modal re-fires endlessly. Clear every downstream
      // field so the recycled order behaves like a genuine first-time
      // PAID order. The list below covers EVERY field touched by the
      // state engine's STATE_TIMESTAMP map, applyOrderAcceptance, the
      // cancellation/fault paths, the petpooja service, the prorouting
      // state handler, the LSP-dispute paths, and dispatchDelivery —
      // so a re-run starts from a clean slate regardless of which path
      // the previous run advanced through.
      $unset: {
        // Acceptance + lifecycle stamps
        acknowledged_at: '', acknowledged_by: '',
        confirmed_at: '', preparing_at: '', packed_at: '',
        dispatched_at: '', delivered_at: '', cancelled_at: '',
        rejected_at: '', timeout_at: '', no_delivery_at: '',
        rto_initiated_at: '', rto_completed_at: '', rto_disposed_at: '',
        expired_at: '', expired_payment_at: '', payment_failed_at: '',
        // Cancellation / fault metadata
        decline_reason: '', cancellation_reason: '', cancellation_reason_code: '',
        cancellation_fault_fee: '', platform_absorbed_fee: '',
        missed_sale_reason: '', payment_failure_reason: '',
        refund_id: '', refund_amount_rs: '',
        // Petpooja stamps (push + POS lifecycle + dashboard-accept stamp)
        petpooja_order_id: '', petpooja_pushed_at: '', petpooja_push_failed: '',
        petpooja_pos_status: '', petpooja_pos_cancel_failed: '',
        petpooja_accepted_at: '', minimum_prep_time: '',
        // Prorouting / 3PL stamps + dispatch audit
        prorouting_order_id: '', prorouting_dispatch_attempts: '',
        prorouting_state: '',
        prorouting_assigned_at: '', prorouting_pickedup_at: '',
        prorouting_delivered_at: '', prorouting_at_pickup_at: '',
        prorouting_at_delivery_at: '', prorouting_cancelled_at: '',
        prorouting_rto_initiated_at: '', prorouting_rto_delivered_at: '',
        prorouting_pickup_proof: '', prorouting_delivery_proof: '',
        prorouting_tracking_url: '',
        prorouting_issue_id: '', prorouting_issue_state: '', prorouting_issue_raised_at: '',
        // LSP dispute / debit-at-risk
        lsp_issue_state: '', lsp_issue_raised_at: '', lsp_escalation_deadline: '',
        debit_at_risk: '',
        // RTO flags
        is_rto: '', delivery_status: '',
        // Rider-pickup first-write-wins stamp (proroutingState.js:357)
        rider_pickup_at: '',
        // SLA spans (written by transitionOrder DELIVERED branch)
        sla_prep_min: '', sla_dispatch_min: '', sla_transit_min: '',
        // Acceptance-timeout BullMQ stamps (engine PAID transition writes
        // these; bypassing the engine here means stale values would
        // otherwise carry forward across runs)
        acceptance_timeout_job_id: '', acceptance_timeout_scheduled_at: '',
        // Delivery provider audit (written by dispatchDelivery)
        delivery_provider: '', delivery_estimates: '',
        // Whole logistics subdoc — proroutingState dual-writes every
        // intermediate timing into logistics.{lspName,riderName,...,
        // reachPickupMinutes,deliveryTotalMinutes,...}. Wiping the
        // subdoc avoids enumerating each dot-key.
        logistics: '',
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
