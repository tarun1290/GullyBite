#!/usr/bin/env node
'use strict';

// scripts/test-paid-order.js
//
// Inserts a PAID order document directly into MongoDB and enqueues
// the BullMQ acceptance-timeout job — bypassing the WhatsApp customer
// flow and the Razorpay payment gateway. Used to validate the
// post-payment pipeline end-to-end on EC2 without burning a real test
// transaction.
//
// Usage:
//   cd /home/ubuntu/GullyBite/backend
//   node --env-file=/home/ubuntu/GullyBite/.env scripts/test-paid-order.js \
//     --restaurant_id=<RID> --branch_id=<BID> [--customer_phone=919999999999]
//
// What it does:
//   • Verifies branch belongs to restaurant
//   • Pulls 2 active menu_items for the branch (same $or pattern as mpmBuilder)
//   • Inserts ONE order doc with status='PAID', payment_status='paid',
//     fake razorpay_order_id / razorpay_payment_id
//   • Enqueues the 'order-acceptance' BullMQ job via the production
//     addAcceptanceTimeoutJob() helper — guarantees identical queue
//     options (jobId, delay, attempts, removeOnComplete/Fail)
//
// What it does NOT do:
//   • No order_items rows (the order doc carries items[] denormalized)
//   • No WhatsApp messages, no Razorpay charge
//
// --customer_phone behaviour:
//   • Omitted → synthetic customer_id (uuid), fake phone 919999999999.
//     Notification path's findOne({_id: customer_id}) → null → silent
//     no-op. Useful for pipeline smoke-tests with no live customer.
//   • Provided → looks up the real customer by wa_phone (exact-match
//     on normalized digits, with a substring-regex fallback for
//     partial inputs like "9876543210" matching "+919876543210").
//     Uses the real _id so resolveRecipient (services/customerIdentity)
//     resolves to the real WhatsApp number — actual notifications WILL
//     fire on this run. Hard-errors if no match (don't silently fall
//     back to the synthetic id — that masks the most useful failure).

const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

function parseArgs(argv) {
  // null sentinel for customer_phone so we can distinguish "user didn't
  // pass the flag" (use synthetic) from "user explicitly asked for a
  // real lookup" (resolve or fail). Default-to-fake gets applied later.
  const out = { restaurant_id: null, branch_id: null, customer_phone: null };
  for (const raw of argv.slice(2)) {
    const m = raw.match(/^--([a-z_]+)=(.+)$/);
    if (!m) continue;
    if (m[1] in out) out[m[1]] = m[2];
  }
  return out;
}

// Strip non-digits — same shape as services/customer.service.js
// normalizePhone (digit-only, null on empty). Inlined rather than
// imported so the script stays standalone with zero project requires
// before mongo connects.
function normalizeDigits(s) {
  if (!s) return null;
  const d = String(s).replace(/[^\d]/g, '');
  return d || null;
}

function maskPhone(p) {
  const d = normalizeDigits(p) || '';
  return d.length >= 4 ? `••••${d.slice(-4)}` : (p || '');
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.restaurant_id || !args.branch_id) {
    console.error('Usage: --restaurant_id=<id> --branch_id=<id> [--customer_phone=<phone>]');
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI not set — pass via --env-file');
    process.exit(1);
  }
  if (!process.env.REDIS_URL) {
    console.error('REDIS_URL not set — pass via --env-file');
    process.exit(1);
  }

  // ─── Mongo ───────────────────────────────────────────────────
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db('gullybite');
  console.log('[test-paid-order] mongo connected: gullybite');

  // Verify branch + ownership
  const branch = await db.collection('branches').findOne({ _id: args.branch_id });
  if (!branch) {
    console.error(`branch not found: ${args.branch_id}`);
    await client.close();
    process.exit(1);
  }
  if (String(branch.restaurant_id) !== String(args.restaurant_id)) {
    console.error(`branch ${args.branch_id} does not belong to restaurant ${args.restaurant_id}`);
    await client.close();
    process.exit(1);
  }
  console.log(`[test-paid-order] branch resolved: ${branch.name} (${branch._id})`);

  // ─── Customer resolution ─────────────────────────────────────
  // When --customer_phone is provided, look up the real customer so
  // notifications resolve via the actual customerIdentity flow. When
  // omitted, fall through with a synthetic id (no notifications fire).
  let resolvedCustomer = null;
  let effectiveCustomerPhone;
  if (args.customer_phone) {
    const phoneDigits = normalizeDigits(args.customer_phone);
    if (!phoneDigits) {
      console.error(`invalid --customer_phone: ${args.customer_phone}`);
      await client.close();
      process.exit(1);
    }
    // 1. Exact match on the normalised digit form — the canonical
    //    pattern used by services/customerIdentity.js and
    //    routes/dineInFeedback.js.
    resolvedCustomer = await db.collection('customers').findOne({ wa_phone: phoneDigits });
    // 2. Substring-regex fallback for partial inputs (e.g. user passed
    //    last 10 digits while the stored row has a country-code
    //    prefix). Escape regex metacharacters defensively even though
    //    we just stripped to digits — guards against future relaxation
    //    of normalizeDigits.
    if (!resolvedCustomer) {
      const escaped = phoneDigits.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      resolvedCustomer = await db.collection('customers').findOne({
        wa_phone: { $regex: escaped },
      });
    }
    if (!resolvedCustomer) {
      console.error(`customer not found for phone ${args.customer_phone} — pass an existing wa_phone or omit the flag`);
      await client.close();
      process.exit(1);
    }
    effectiveCustomerPhone = resolvedCustomer.wa_phone || phoneDigits;
    console.log(
      `[test-paid-order] customer resolved: ${resolvedCustomer.name || '(no name)'} (${maskPhone(effectiveCustomerPhone)}) — _id=${resolvedCustomer._id}`,
    );
  } else {
    effectiveCustomerPhone = '919999999999';
    console.log('[test-paid-order] customer: synthetic (no --customer_phone passed) — phone 919999999999');
  }

  // Pull 2 active menu items — same $or pattern as services/mpmBuilder.js
  // so a branch using the legacy scalar field OR the new array form both
  // resolve. Limit 2 keeps the order realistic without pulling the full
  // menu.
  const items = await db.collection('menu_items').find({
    $or: [{ branch_id: args.branch_id }, { branch_ids: args.branch_id }],
    is_available: true,
  }).limit(2).toArray();

  if (!items.length) {
    console.error(`no available menu_items found for branch ${args.branch_id}`);
    await client.close();
    process.exit(1);
  }
  console.log(`[test-paid-order] menu items: ${items.length} found`);

  // Build denormalized items[] for the order doc. Field names mirror the
  // shape inserted by services/order.js (subtotal_rs / line_total_rs,
  // size + item_group_id when the source row has a variant).
  const itemDocs = items.map((it) => {
    const pricePaise = Number(it.price_paise) || 0;
    return {
      item_id: it._id,
      retailer_id: it.retailer_id || null,
      name: it.name,
      item_name: it.name,
      quantity: 1,
      price_paise: pricePaise,
      price_rs: pricePaise / 100,
      line_total_rs: pricePaise / 100,
      ...(it.size ? { size: it.size } : {}),
      ...(it.item_group_id ? { item_group_id: it.item_group_id } : {}),
    };
  });

  const subtotalPaise = itemDocs.reduce((s, i) => s + (i.price_paise * i.quantity), 0);
  const deliveryFeePaise = 4000; // ₹40 — per spec
  const totalPaise = subtotalPaise + deliveryFeePaise;

  // Order number: ZM-YYYYMMDD-#### using today's count + 1, matching the
  // generator in services/order.js so dashboards display a consistent
  // identifier.
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayCount = await db.collection('orders').countDocuments({ created_at: { $gte: todayStart } });
  const orderNumber = `ZM-${dateStr}-${String(todayCount + 1).padStart(4, '0')}`;

  const orderId = crypto.randomUUID();
  // Real customer when --customer_phone hit a row; synthetic uuid
  // otherwise. The notification path's customer findOne keys off this,
  // so the synthetic case is harmless (lookup → null → no-op).
  const customerId = resolvedCustomer ? String(resolvedCustomer._id) : crypto.randomUUID();
  const fakeRzpOrderId = `test_order_${Date.now()}`;
  const fakeRzpPaymentId = `test_pay_${Date.now()}`;

  const fallbackLat = branch.latitude || 17.385;
  const fallbackLng = branch.longitude || 78.4867;
  const fallbackCity = branch.city || 'Hyderabad';

  const order = {
    _id: orderId,
    order_number: orderNumber,
    restaurant_id: args.restaurant_id,
    branch_id: args.branch_id,
    customer_id: customerId,
    items: itemDocs,
    // Both rupee and paise totals — restaurant.js queries surface the
    // _rs fields, while the schema (subtotal_rs/total_rs) is what
    // validators check. paise variants help any code that prefers
    // integer math.
    subtotal_rs: subtotalPaise / 100,
    delivery_fee_rs: deliveryFeePaise / 100,
    discount_rs: 0,
    total_rs: totalPaise / 100,
    subtotal_paise: subtotalPaise,
    delivery_fee_paise: deliveryFeePaise,
    total_paise: totalPaise,
    status: 'PAID',
    payment_status: 'paid',
    razorpay_order_id: fakeRzpOrderId,
    razorpay_payment_id: fakeRzpPaymentId,
    delivery_address: 'Test Address Line 1, Test Locality, Hyderabad',
    address_snapshot: {
      recipient_name: resolvedCustomer?.name || 'Test Customer',
      delivery_phone: effectiveCustomerPhone,
      address_line1: 'Test Address Line 1',
      area_locality: 'Test Locality',
      city: fallbackCity,
      lat: fallbackLat,
      lng: fallbackLng,
    },
    delivery_lat: fallbackLat,
    delivery_lng: fallbackLng,
    receiver_name: resolvedCustomer?.name || 'Test Customer',
    receiver_phone: effectiveCustomerPhone,
    source: 'whatsapp',
    paid_at: now,
    created_at: now,
    updated_at: now,
  };

  await db.collection('orders').insertOne(order);
  console.log(`[test-paid-order] order inserted: _id=${orderId} order_number=${orderNumber} total_paise=${totalPaise}`);

  // ─── Queue ───────────────────────────────────────────────────
  // Use the production helper rather than a fresh Queue instance — that
  // way the script automatically inherits any future change to job
  // options (jobId/delay/attempts/removeOnComplete) made in
  // src/jobs/orderAcceptanceQueue.js. The same helper is called by
  // core/orderStateEngine.js when a real PAID transition lands.
  const { addAcceptanceTimeoutJob } = require(path.join(__dirname, '..', 'src', 'jobs', 'orderAcceptanceQueue'));
  const { jobId } = await addAcceptanceTimeoutJob(orderId);
  console.log(`[test-paid-order] acceptance-timeout job enqueued: jobId=${jobId}`);

  // Stamp the job id on the order — mirrors orderStateEngine.js so a
  // subsequent /accept or /decline can cancel the job by id.
  await db.collection('orders').updateOne(
    { _id: orderId },
    { $set: { acceptance_timeout_job_id: jobId, acceptance_timeout_scheduled_at: new Date() } },
  );

  console.log('');
  console.log('────────────────────────────────────────────');
  console.log(`order _id:        ${orderId}`);
  console.log(`order_number:     ${orderNumber}`);
  console.log(`bullmq jobId:     ${jobId}`);
  console.log(`status:           PAID`);
  console.log(`branch:           ${branch.name} (${args.branch_id})`);
  console.log(`customer:         ${resolvedCustomer ? `${resolvedCustomer.name || '(no name)'} ${maskPhone(effectiveCustomerPhone)} (real)` : 'synthetic uuid (no notifications)'}`);
  console.log(`total_paise:      ${totalPaise}`);
  console.log('────────────────────────────────────────────');

  // ─── Clean shutdown ──────────────────────────────────────────
  await client.close();
  const redisConnection = require(path.join(__dirname, '..', 'src', 'queue', 'redis'));
  await redisConnection.quit();
}

main().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error('[test-paid-order] FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
