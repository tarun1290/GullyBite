// src/schemas/collections.js
// MongoDB Schema Contracts — defines the expected shape of every collection.
// This is the SINGLE SOURCE OF TRUTH for data structure.
// Validation is opt-in via validateDocument(). Existing data is NOT changed.

'use strict';

// ─── FIELD TYPES ────────────────────────────────────────────
// string, number, boolean, date, array, object, uuid (string UUID)
// required: true = must be present and non-null on insert

// ═══════════════════════════════════════════════════════════════
// CORE BUSINESS COLLECTIONS
// ═══════════════════════════════════════════════════════════════

const restaurants = {
  collection: 'restaurants',
  description: 'Restaurant accounts — one per business',
  fields: {
    _id:                   { type: 'uuid', required: true },
    business_name:         { type: 'string', required: true },
    brand_name:            { type: 'string' },
    registered_business_name: { type: 'string' },
    owner_name:            { type: 'string' },
    phone:                 { type: 'string' },
    email:                 { type: 'string' },
    city:                  { type: 'string' },
    restaurant_type:       { type: 'string', enum: ['veg', 'non_veg', 'both'] },
    status:                { type: 'string', enum: ['active', 'pending', 'suspended', 'rejected'] },
    approval_status:       { type: 'string', enum: ['pending', 'approved', 'rejected'] },
    onboarding_step:       { type: 'number' },
    // Meta catalog
    meta_catalog_id:       { type: 'string' },
    meta_catalog_name:     { type: 'string' },
    flow_id:               { type: 'string' },
    // Finance
    commission_pct:        { type: 'number' },
    gst_number:            { type: 'string' },
    fssai_license:         { type: 'string' },
    // Multi-brand layer. `business_type` classifies the tenant; legacy
    // rows without this field behave as 'single' (see restaurants.find
    // query helpers and indexes for the null-tolerant fallback).
    business_type:         { type: 'string', enum: ['single', 'multi'], default: 'single' },
    default_brand_id:      { type: 'uuid' },   // optional → brands._id
    // Timestamps
    created_at:            { type: 'date', required: true },
    updated_at:            { type: 'date' },
  },
  indexes: [
    { key: { status: 1 } },
    { key: { email: 1 }, options: { unique: true, sparse: true } },
    { key: { business_type: 1 } },
  ],
  relationships: {
    branches: 'branches.restaurant_id → restaurants._id',
    whatsapp_accounts: 'whatsapp_accounts.restaurant_id → restaurants._id',
    orders: 'orders.restaurant_id → restaurants._id (via branches)',
  },
};

const branches = {
  collection: 'branches',
  description: 'Restaurant branches/outlets — multiple per restaurant',
  fields: {
    _id:                   { type: 'uuid', required: true },
    restaurant_id:         { type: 'uuid', required: true },
    name:                  { type: 'string', required: true },
    branch_slug:           { type: 'string' },
    address:               { type: 'string' },
    city:                  { type: 'string' },
    state:                 { type: 'string' },
    latitude:              { type: 'number' },
    longitude:             { type: 'number' },
    delivery_radius_km:    { type: 'number' },
    is_open:               { type: 'boolean' },
    accepts_orders:        { type: 'boolean' },
    // Branch-first additions. `is_active` is the new canonical
    // operational flag; legacy `is_open`/`accepts_orders` retained.
    is_active:             { type: 'boolean' },
    fssai_number:          { type: 'string' },  // 14-digit, required for food sync
    gst_number:            { type: 'string' },  // 15-char GSTIN, optional
    catalog_id:            { type: 'string' },
    created_at:            { type: 'date', required: true },
    updated_at:            { type: 'date' },
  },
  indexes: [
    { key: { restaurant_id: 1 } },
    { key: { city: 1 } },
    { key: { is_active: 1 } },
  ],
};

// ─── NEW: branch_products (branch-level overrides) ─────────────
// One row per (product_id, branch_id). Created at assign-branch time;
// merged into the customer-facing menu at read time.
const branch_products = {
  collection: 'branch_products',
  description: 'Per-branch overrides for shared products',
  fields: {
    _id:                   { type: 'uuid', required: true },
    product_id:            { type: 'uuid', required: true },
    branch_id:             { type: 'uuid', required: true },
    price_paise:           { type: 'number' },
    tax_percentage:        { type: 'number' },
    availability:          { type: 'boolean' },
    created_at:            { type: 'date', required: true },
    updated_at:            { type: 'date' },
  },
  indexes: [
    { key: { product_id: 1, branch_id: 1 }, options: { unique: true } },
    { key: { branch_id: 1 } },
  ],
};

const menu_items = {
  collection: 'menu_items',
  description: 'Menu items — one per product per branch',
  fields: {
    _id:                   { type: 'uuid', required: true },
    restaurant_id:         { type: 'uuid', required: true },
    branch_id:             { type: 'uuid', required: true },
    retailer_id:           { type: 'string', required: true },
    name:                  { type: 'string', required: true },
    description:           { type: 'string' },
    price_paise:           { type: 'number', required: true },
    tax_percentage:        { type: 'number' },
    // Branch-first additions. branch_ids co-exists with the legacy
    // branch_id scalar; is_unassigned is derived from branch_ids being
    // empty. See services/product.service.js for the invariants.
    branch_ids:            { type: 'array' },
    is_unassigned:         { type: 'boolean' },
    // Optional brand layer (catalog scoping). When unset, item belongs
    // to the restaurant's default brand (legacy single-brand behavior).
    brand_id:              { type: 'uuid' },
    food_type:             { type: 'string', enum: ['veg', 'non_veg', 'vegan', 'egg'] },
    category_id:           { type: 'uuid' },
    image_url:             { type: 'string' },
    is_available:          { type: 'boolean', required: true },
    is_bestseller:         { type: 'boolean' },
    item_group_id:         { type: 'string' },
    size:                  { type: 'string' },
    product_tags:          { type: 'array' },
    catalog_sync_status:   { type: 'string', enum: ['pending', 'synced', 'error'] },
    // XLSX ingestion trace (additive — see services/menuMapping.js).
    source_upload_id:      { type: 'uuid' },
    meta_status:           { type: 'string', enum: ['ready', 'incomplete'] },
    normalized:            { type: 'boolean' },
    category_name:         { type: 'string' },
    currency:              { type: 'string' },
    // Trust layer
    trust_metrics:         { type: 'object' },
    meta_description_generated: { type: 'string' },
    created_at:            { type: 'date', required: true },
    updated_at:            { type: 'date' },
  },
  indexes: [
    { key: { restaurant_id: 1, branch_id: 1 } },
    { key: { branch_id: 1, is_available: 1 } },
    { key: { item_group_id: 1, branch_id: 1 } },
    // Phase 1 fix: retailer_id is globally unique on Meta's side BUT
    // scoping MUST be per-tenant in our DB so two restaurants can reuse
    // the same human-friendly SKU. Composite (restaurant_id, retailer_id)
    // unique replaces the legacy global-unique constraint.
    { key: { restaurant_id: 1, retailer_id: 1 }, options: { unique: true } },
  ],
};

const orders = {
  collection: 'orders',
  description: 'Customer orders',
  fields: {
    _id:                   { type: 'uuid', required: true },
    order_number:          { type: 'string', required: true },
    customer_id:           { type: 'uuid', required: true },
    branch_id:             { type: 'uuid', required: true },
    // Phase 1: restaurant_id is now the tenant root on every order.
    // Legacy rows without it continue to work at read time, but all
    // new writes MUST include it (services/orderCreate.service.js
    // enforces this). validateDocument() will reject inserts missing it.
    restaurant_id:         { type: 'uuid', required: true },
    // Phase 6: phone_hash denormalized onto the order so the identity
    // layer (customer_metrics) can aggregate without joining customers.
    // Sparse — legacy orders without it fall back to customer_id joins.
    phone_hash:            { type: 'string' },
    subtotal_rs:           { type: 'number', required: true },
    delivery_fee_rs:       { type: 'number' },
    discount_rs:           { type: 'number' },
    total_rs:              { type: 'number', required: true },
    status:                { type: 'string', required: true, enum: ['PENDING_PAYMENT', 'PAID', 'CONFIRMED', 'PREPARING', 'PACKED', 'DISPATCHED', 'DELIVERED', 'CANCELLED'] },
    // Phase 1: denormalized payment state on the order row so status
    // transitions don't require a payments lookup.
    payment_status:        { type: 'string', enum: ['unpaid', 'pending', 'paid', 'failed', 'refunded'] },
    referral_id:           { type: 'uuid' },
    referral_fee_rs:       { type: 'number' },
    settlement_id:         { type: 'uuid' },
    // Phase 1: address_snapshot freezes the delivery address at order
    // time — audit integrity; customer editing their saved address
    // must never rewrite historical orders. `delivery_address` (legacy
    // flat string) retained for backwards compatibility.
    delivery_address:      { type: 'string' },
    address_snapshot:      { type: 'object' },
    // Phase 1: frozen copy of order line items. `order_items` rows
    // remain the authoritative per-line store; this array is a
    // denormalized copy used by WhatsApp receipts and reorder flow
    // so a single findOne replays the full order.
    items:                 { type: 'array' },
    // Phase 1: menu_version pins the catalog snapshot used at order
    // time. Lets reorder detect price/availability drift.
    menu_version:          { type: 'string' },
    // Optional brand layer. Sparse — legacy orders without brand_id
    // continue to resolve via restaurant_id-based single-brand path.
    brand_id:              { type: 'uuid' },
    created_at:            { type: 'date', required: true },
    updated_at:            { type: 'date' },
  },
  indexes: [
    { key: { restaurant_id: 1, status: 1, created_at: -1 } },
    { key: { customer_id: 1, created_at: -1 } },
    { key: { branch_id: 1, created_at: -1 } },
    { key: { brand_id: 1, created_at: -1 } },
  ],
};

const order_items = {
  collection: 'order_items',
  description: 'Line items within an order',
  fields: {
    _id:                   { type: 'uuid', required: true },
    order_id:              { type: 'uuid', required: true },
    // Phase 1: denormalized tenant root so per-tenant analytics can
    // $match on restaurant_id without joining orders.
    restaurant_id:         { type: 'uuid' },
    menu_item_id:          { type: 'uuid' },
    item_name:             { type: 'string', required: true },
    unit_price_rs:         { type: 'number', required: true },
    quantity:              { type: 'number', required: true },
    line_total_rs:         { type: 'number', required: true },
  },
  indexes: [
    { key: { order_id: 1 } },
    { key: { restaurant_id: 1 } },
  ],
};

// Phase 1: customers is GLOBAL — one row per human phone number across
// the whole platform. Per-tenant state (order totals, preferences) lives
// in `customer_profiles` keyed by (restaurant_id, customer_id). This is
// the identity layer; it intentionally stores no tenant-scoped data.
const customers = {
  collection: 'customers',
  description: 'Global customer identity (keyed by WhatsApp phone)',
  fields: {
    _id:                   { type: 'uuid', required: true },
    wa_phone:              { type: 'string', required: true },
    // Phase 6: phone_hash is the canonical identity key used by the
    // identity layer (customer_metrics) and campaign attribution.
    // Written alongside wa_phone so hash-based lookups work without
    // rehashing on read. Sparse-unique so legacy rows without a hash
    // remain valid.
    phone_hash:            { type: 'string' },
    name:                  { type: 'string' },
    bsuid:                 { type: 'string' },
    first_seen_at:         { type: 'date' },
    last_seen_at:          { type: 'date' },
    created_at:            { type: 'date', required: true },
    updated_at:            { type: 'date' },
  },
  indexes: [
    { key: { wa_phone: 1 }, options: { unique: true, sparse: true } },
    { key: { phone_hash: 1 }, options: { unique: true, sparse: true } },
  ],
};

// Phase 6: identity-layer metrics, keyed by phone_hash.
// Global lifetime totals in the top-level fields; per-tenant rollups
// in restaurant_stats[]. Intentionally separate from customer_profiles
// (which is joined by customer_id) because this collection is the
// authoritative view of a HUMAN across tenants — and because order
// creation writes here non-blocking without touching the transaction.
const customer_metrics = {
  collection: 'customer_metrics',
  description: 'Global + per-tenant order/spend metrics keyed by phone_hash',
  fields: {
    _id:                   { type: 'uuid', required: true },
    phone_hash:            { type: 'string', required: true },
    customer_id:           { type: 'uuid' },
    total_orders:          { type: 'number' },
    total_spent_rs:        { type: 'number' },
    last_order_at:         { type: 'date' },
    restaurant_stats:      { type: 'array' },
    // Phase 6.1: classification. `customer_type` is the primary bucket
    // (mutually exclusive: new/repeat/loyal/dormant). `tags` is an
    // additive set — a loyal customer can also carry 'high_value'.
    customer_type:         { type: 'string', enum: ['new', 'repeat', 'loyal', 'dormant'] },
    tags:                  { type: 'array' },
    created_at:            { type: 'date' },
    updated_at:            { type: 'date' },
  },
  indexes: [
    { key: { phone_hash: 1 }, options: { unique: true } },
    { key: { 'restaurant_stats.restaurant_id': 1 } },
    { key: { customer_type: 1 } },
  ],
};

const customer_tags = {
  collection: 'customer_tags',
  description: 'Derived tags per customer (new/repeat/loyal/high_value)',
  fields: {
    _id:                   { type: 'uuid', required: true },
    phone_hash:            { type: 'string', required: true },
    restaurant_id:         { type: 'uuid' },
    type:                  { type: 'string', enum: ['new', 'repeat', 'loyal', 'high_value'] },
    created_at:            { type: 'date' },
    updated_at:            { type: 'date' },
  },
  indexes: [
    { key: { phone_hash: 1, restaurant_id: 1 } },
  ],
};

// Phase 1: per-tenant customer state. One row per (restaurant_id,
// customer_id). This is where lifetime value, last-order-at, and tenant
// preferences live. Lets two tenants independently track their view of
// the same human without stepping on each other.
const customer_profiles = {
  collection: 'customer_profiles',
  description: 'Per-tenant customer state (LTV, prefs, last order)',
  fields: {
    _id:                   { type: 'uuid', required: true },
    restaurant_id:         { type: 'uuid', required: true },
    customer_id:           { type: 'uuid', required: true },
    total_orders:          { type: 'number' },
    total_spent_rs:        { type: 'number' },
    last_order_at:         { type: 'date' },
    preferences:           { type: 'object' },
    created_at:            { type: 'date', required: true },
    updated_at:            { type: 'date' },
  },
  indexes: [
    { key: { restaurant_id: 1, customer_id: 1 }, options: { unique: true } },
    { key: { restaurant_id: 1, last_order_at: -1 } },
  ],
};

// Phase 1: addresses are GLOBAL — a customer's "Home" is the same Home
// regardless of which restaurant they're ordering from. Keyed by
// customer_id; no restaurant_id on the address itself. Orders freeze a
// snapshot via orders.address_snapshot, so editing an address here
// never rewrites historical orders.
const customer_addresses = {
  collection: 'customer_addresses',
  description: 'Global saved addresses (per-customer, cross-tenant)',
  fields: {
    _id:                   { type: 'uuid', required: true },
    customer_id:           { type: 'uuid', required: true },
    label:                 { type: 'string' },     // 'Home', 'Work', free text
    address_line:          { type: 'string', required: true },
    landmark:              { type: 'string' },
    pincode:               { type: 'string' },
    city:                  { type: 'string' },
    state:                 { type: 'string' },
    latitude:              { type: 'number' },
    longitude:             { type: 'number' },
    is_default:            { type: 'boolean' },
    created_at:            { type: 'date', required: true },
    updated_at:            { type: 'date' },
  },
  indexes: [
    { key: { customer_id: 1, is_default: -1, updated_at: -1 } },
  ],
};

// Phase 1: durable cart sessions in Mongo (consistent with
// message_jobs — no Redis dep). Keyed by (restaurant_id, customer_id):
// a customer has ONE active cart per tenant. TTL index on expires_at
// auto-reaps abandoned carts. cart_sessions is intentionally distinct
// from the legacy abandoned_carts recovery collection.
const cart_sessions = {
  collection: 'cart_sessions',
  description: 'Active customer carts (per-tenant, TTL-cleaned)',
  fields: {
    _id:                   { type: 'uuid', required: true },
    restaurant_id:         { type: 'uuid', required: true },
    branch_id:             { type: 'uuid' },
    customer_id:           { type: 'uuid', required: true },
    items:                 { type: 'array' },       // [{ menu_item_id, name, qty, unit_price_rs }]
    address_id:            { type: 'uuid' },        // chosen address (customer_addresses._id)
    subtotal_rs:           { type: 'number' },
    // Phase 2: 'locked' is set when the customer taps Confirm on the
    // order review. In that state cart mutators (add/update/remove/
    // setAddress) refuse writes — the cart must not drift while we're
    // waiting on payment.
    status:                { type: 'string', enum: ['active', 'locked', 'checked_out', 'abandoned'] },
    created_at:            { type: 'date', required: true },
    updated_at:            { type: 'date' },
    expires_at:            { type: 'date' },        // TTL cleanup
  },
  indexes: [
    { key: { restaurant_id: 1, customer_id: 1 }, options: { unique: true } },
    { key: { expires_at: 1 }, options: { expireAfterSeconds: 0 } },
  ],
};

// Phase 1: atomic per-tenant daily counter for human-readable order
// numbers. One row per (restaurant_id, yyyymmdd). Uses findOneAndUpdate
// with $inc for race-safe sequencing without a distributed lock.
const order_counters = {
  collection: 'order_counters',
  description: 'Atomic per-tenant daily sequence for order numbering',
  fields: {
    _id:                   { type: 'string', required: true }, // `${restaurant_id}:${yyyymmdd}`
    restaurant_id:         { type: 'uuid', required: true },
    date:                  { type: 'string', required: true }, // YYYYMMDD
    seq:                   { type: 'number', required: true },
    updated_at:            { type: 'date' },
  },
};

const conversations = {
  collection: 'conversations',
  description: 'WhatsApp conversation state machine',
  fields: {
    _id:                   { type: 'uuid', required: true },
    customer_id:           { type: 'uuid', required: true },
    // Phase 1: denormalized tenant root. Required on new writes so
    // cross-tenant state cannot leak via a shared customer row.
    restaurant_id:         { type: 'uuid' },
    wa_account_id:         { type: 'uuid', required: true },
    state:                 { type: 'string', required: true },
    session_data:          { type: 'object' },
    is_active:             { type: 'boolean' },
    last_msg_at:           { type: 'date' },
    created_at:            { type: 'date', required: true },
  },
  indexes: [
    { key: { restaurant_id: 1, customer_id: 1 } },
  ],
};

const payments = {
  collection: 'payments',
  description: 'Payment records (Razorpay orders + links)',
  fields: {
    _id:                   { type: 'uuid', required: true },
    order_id:              { type: 'uuid', required: true },
    // Phase 1: denormalized tenant root so tenant-scoped payment
    // queries don't require a join through orders.
    restaurant_id:         { type: 'uuid' },
    rp_order_id:           { type: 'string' },
    rp_link_id:            { type: 'string' },
    rp_payment_id:         { type: 'string' },
    amount_rs:             { type: 'number', required: true },
    status:                { type: 'string', required: true, enum: ['sent', 'paid', 'failed', 'refunded', 'pending'] },
    payment_type:          { type: 'string' },
    // Phase 3: Razorpay fee breakdown captured from payment.entity.
    // `method` = 'upi' | 'card' | 'netbanking' | 'wallet' | 'emi' | ...
    // All amounts in paise to avoid float drift against Razorpay's paise.
    fee_paise:             { type: 'number' },
    tax_paise:             { type: 'number' },
    net_paise:             { type: 'number' },
    method:                { type: 'string' },
    created_at:            { type: 'date', required: true },
  },
};

// Phase 3: restaurant ledger — double-entry style credit/debit log.
// Every payment settled to the platform produces one credit row (for the
// net-of-fees amount). Every refund produces one debit row. Payouts and
// Razorpay fees can also be recorded here for full reconciliation.
// Amounts are in paise. Never mutate a row once written; if an adjustment
// is needed, write a compensating entry.
const restaurant_ledger = {
  collection: 'restaurant_ledger',
  description: 'Restaurant ledger — credit/debit entries for payments, refunds, payouts, fees',
  fields: {
    _id:                   { type: 'uuid', required: true },
    restaurant_id:         { type: 'uuid', required: true },
    type:                  { type: 'string', required: true, enum: ['credit', 'debit'] },
    amount_paise:          { type: 'number', required: true },
    ref_type:              { type: 'string', required: true, enum: ['payment', 'refund', 'payout', 'fee'] },
    // ref_id conventions (Phase 3.1):
    //   payment → rp_payment_id (e.g. 'pay_XXX')
    //   refund  → rp_refund_id  (e.g. 'rfnd_XXX')
    //   payout  → rp_payout_id
    //   fee     → rp_payment_id (fee associated with a specific payment)
    ref_id:                { type: 'string', required: true },
    // Phase 3.1: two-phase refund accounting. `issueRefund` writes a
    // 'pending' debit at the moment we call Razorpay; the webhook
    // flips it to 'completed'. Payment credits are written directly
    // as 'completed' (we only credit once the webhook fires).
    status:                { type: 'string', required: true, enum: ['pending', 'completed', 'failed'] },
    notes:                 { type: 'string' },
    created_at:            { type: 'date', required: true },
    updated_at:            { type: 'date' },
  },
  indexes: [
    { key: { restaurant_id: 1, created_at: -1 } },
    // Phase 3.1: unique on (restaurant_id, ref_type, ref_id). Scoping the
    // uniqueness by restaurant means a Razorpay id that gets re-issued
    // against a different tenant (shouldn't happen, but belt-and-braces)
    // can't block the second tenant's ledger entry.
    { key: { restaurant_id: 1, ref_type: 1, ref_id: 1 }, options: { unique: true } },
  ],
};

const settlements = {
  collection: 'settlements',
  description: 'Settlement records per restaurant. Legacy rows carry period_start/end + _rs fields (weekly cycle). Phase 5 rows carry total_amount_paise/payout_amount_paise + status (on-demand balance payouts). The two shapes coexist — readers should null-check before casting.',
  fields: {
    _id:                   { type: 'uuid', required: true },
    restaurant_id:         { type: 'uuid', required: true },
    // Discriminates weekly-cycle rows from Phase 5 balance-based rows.
    settlement_type:       { type: 'string', enum: ['legacy', 'new'] },
    // ── Legacy weekly-cycle fields (still populated by jobs/settlement.js)
    period_start:          { type: 'date' },
    period_end:            { type: 'date' },
    food_revenue_rs:       { type: 'number' },
    platform_fee_rs:       { type: 'number' },
    platform_fee_gst_rs:   { type: 'number' },
    referral_fee_rs:       { type: 'number' },
    referral_fee_gst_rs:   { type: 'number' },
    gross_revenue_rs:      { type: 'number' },
    net_payout_rs:         { type: 'number' },
    is_first_billing_month:{ type: 'boolean' },
    payout_status:         { type: 'string', enum: ['pending', 'processing', 'completed', 'failed'] },
    // ── Phase 5: on-demand ledger-balance payouts (paise)
    gross_amount_paise:    { type: 'number' },
    refund_amount_paise:   { type: 'number' },
    payout_amount_paise:   { type: 'number' },
    fee_amount_paise:      { type: 'number' },
    net_amount_paise:      { type: 'number' },
    total_amount_paise:    { type: 'number' },
    status:                { type: 'string', enum: ['pending', 'processing', 'completed', 'failed'] },
    payout_id:             { type: 'string' },
    payout_provider:       { type: 'string', enum: ['razorpay', 'fallback_provider'] },
    // Phase 5.1: manual payouts. 'auto' runs the provider loop; 'manual'
    // skips the payout API — ops records the transfer externally and
    // confirms via POST /admin/settlements/confirm with an external_reference.
    payout_mode:           { type: 'string', enum: ['auto', 'manual'] },
    external_reference:    { type: 'string' },
    attempt_count:         { type: 'number' },
    last_attempt_at:       { type: 'date' },
    processed_at:          { type: 'date' },
    failure_reason:        { type: 'string' },
    // Phase 5.2: Meta (WhatsApp) marketing cost deducted from this payout.
    // Set at settlement-row creation; message_ids frozen so retries are idempotent.
    // marketing_messages rows get settled=true + settlement_id only after the
    // payout succeeds (confirmPayout).
    meta_cost_total_paise: { type: 'number' },
    meta_message_count:    { type: 'number' },
    meta_message_ids:      { type: 'array' },
    created_at:            { type: 'date', required: true },
  },
  indexes: [
    { key: { restaurant_id: 1, period_start: -1 } },
    // Phase 5
    { key: { restaurant_id: 1, created_at: -1 } },
    { key: { status: 1 } },
  ],
};

const whatsapp_accounts = {
  collection: 'whatsapp_accounts',
  description: 'Restaurant WhatsApp Business accounts',
  fields: {
    _id:                   { type: 'uuid', required: true },
    restaurant_id:         { type: 'uuid', required: true },
    waba_id:               { type: 'string' },
    phone_number_id:       { type: 'string' },
    wa_phone_number:       { type: 'string' },
    catalog_id:            { type: 'string' },
    catalog_linked:        { type: 'boolean' },
    is_active:             { type: 'boolean', required: true },
    created_at:            { type: 'date', required: true },
  },
};

const referrals = {
  collection: 'referrals',
  description: 'Referral attribution records',
  fields: {
    _id:                   { type: 'uuid', required: true },
    restaurant_id:         { type: 'uuid', required: true },
    customer_wa_phone:     { type: 'string', required: true },
    source:                { type: 'string', enum: ['gbref', 'directory', 'admin'] },
    status:                { type: 'string', required: true, enum: ['active', 'converted', 'expired', 'superseded', 'reversed'] },
    referral_code:         { type: 'string' },
    attribution_window_hours: { type: 'number' },
    commission_percent:    { type: 'number' },
    commission_status:     { type: 'string', enum: ['pending', 'confirmed', 'reversed', 'settled', null] },
    expires_at:            { type: 'date' },
    created_at:            { type: 'date', required: true },
  },
  indexes: [
    { key: { customer_wa_phone: 1, restaurant_id: 1, status: 1, expires_at: 1 } },
    { key: { referral_code: 1 } },
  ],
};

// ─── NEW: messages (brand-aware WhatsApp message log) ──────────
// Generic message log keyed by brand. Coexists with `customer_messages`
// (the legacy per-restaurant log) — new brand-scoped writers target
// this collection; legacy readers continue to use customer_messages.
const messages = {
  collection: 'messages',
  description: 'WhatsApp message log (brand-scoped)',
  fields: {
    _id:                   { type: 'uuid', required: true },
    brand_id:              { type: 'uuid' },                 // optional → fallback path
    business_id:           { type: 'uuid' },                 // → restaurants._id
    // Phase 1: denormalized tenant root, mirrors business_id for
    // queries that key on restaurant_id directly.
    restaurant_id:         { type: 'uuid' },
    customer_id:           { type: 'uuid' },
    wa_message_id:         { type: 'string' },
    direction:             { type: 'string', enum: ['inbound', 'outbound'] },
    type:                  { type: 'string' },               // text/image/template/...
    payload:               { type: 'object' },
    status:                { type: 'string' },               // sent/delivered/read/failed
    created_at:            { type: 'date', required: true },
  },
  indexes: [
    { key: { brand_id: 1, created_at: -1 } },
    { key: { business_id: 1, created_at: -1 } },
    { key: { wa_message_id: 1 }, options: { unique: true, sparse: true } },
  ],
};

// ─── NEW: catalog (brand-scoped catalog registry) ──────────────
// Lightweight registry of catalogs tied to brands. The product rows
// continue to live in `menu_items`; this collection exists so each
// brand can own its own Meta catalog metadata independently of the
// restaurant-level `meta_catalog_id` on `restaurants`.
const catalog = {
  collection: 'catalog',
  description: 'Brand-scoped catalog registry (Meta catalog metadata)',
  fields: {
    _id:                   { type: 'uuid', required: true },
    brand_id:              { type: 'uuid' },                 // optional → fallback path
    business_id:           { type: 'uuid' },                 // → restaurants._id
    catalog_id:            { type: 'string' },               // Meta catalog id
    catalog_name:          { type: 'string' },
    status:                { type: 'string', enum: ['active', 'inactive'] },
    created_at:            { type: 'date', required: true },
    updated_at:            { type: 'date' },
  },
  indexes: [
    { key: { brand_id: 1 } },
    { key: { business_id: 1 } },
    { key: { catalog_id: 1 }, options: { unique: true, sparse: true } },
  ],
};

// ─── NEW: brands (multi-brand layer over a business/restaurant) ─
// One business (restaurants._id) can own multiple brands. Each brand
// has its own WhatsApp Business Account + catalog. brand_id is OPTIONAL
// on orders/customer_messages/menu_items — when absent, callers fall
// back to the existing single-brand resolution (restaurant_id-based).
// Do not query by brand_id without a null-tolerant fallback until
// every writer has been migrated.
const brands = {
  collection: 'brands',
  description: 'Brand layer — multiple brands per business/restaurant',
  fields: {
    _id:                   { type: 'uuid', required: true },
    business_id:           { type: 'uuid', required: true },   // → restaurants._id
    name:                  { type: 'string', required: true },
    waba_id:               { type: 'string' },
    phone_number_id:       { type: 'string' },
    display_phone_number:  { type: 'string' },
    catalog_id:            { type: 'string' },
    status:                { type: 'string', enum: ['active', 'inactive'] },
    created_at:            { type: 'date', required: true },
  },
  indexes: [
    { key: { business_id: 1 } },
    { key: { phone_number_id: 1 }, options: { unique: true, sparse: true } },
    { key: { status: 1 } },
  ],
};

// ─── NEW: sync_logs (per-product sync audit) ───────────────────
// One row per (product, branch, sync attempt). Powers the admin
// "Sync Logs" page and ops debugging. Reason vocabulary mirrors
// services/catalog.service.SKIP_REASONS.
const sync_logs = {
  collection: 'sync_logs',
  description: 'Per-product Meta catalog sync audit log',
  fields: {
    _id:           { type: 'uuid', required: true },
    restaurant_id: { type: 'uuid', required: true },
    product_id:    { type: 'uuid', required: true },
    branch_id:     { type: 'uuid', required: true },
    status:        { type: 'string', required: true, enum: ['synced', 'skipped'] },
    reason:        { type: 'string' },
    suggestion:    { type: 'string' },   // auto-fix hint (skipped rows only)
    timestamp:     { type: 'date', required: true },
  },
  indexes: [
    { key: { restaurant_id: 1, timestamp: -1 } },
    { key: { branch_id: 1, timestamp: -1 } },
    { key: { status: 1, timestamp: -1 } },
    { key: { product_id: 1, timestamp: -1 } },
  ],
};

// ─── NEW: sync_summary (per-sync rollup) ───────────────────────
// One row per syncBranchCatalog invocation. Coarse rollup of what
// sync_logs records per-product. Used to surface success rate over
// time without requiring expensive aggregations on sync_logs.
const sync_summary = {
  collection: 'sync_summary',
  description: 'Per-sync aggregate metrics (total/synced/skipped)',
  fields: {
    _id:           { type: 'uuid', required: true },
    restaurant_id: { type: 'uuid', required: true },
    branch_id:     { type: 'uuid' },
    total:         { type: 'number', required: true },
    synced:        { type: 'number', required: true },
    skipped:       { type: 'number', required: true },
    success_rate:  { type: 'number' },   // synced / total, 0..1
    failure_rate:  { type: 'number' },   // skipped / total, 0..1
    mode:          { type: 'string' },   // 'strict' | 'log_only' | 'disabled'
    timestamp:     { type: 'date', required: true },
  },
  indexes: [
    { key: { restaurant_id: 1, timestamp: -1 } },
    { key: { branch_id: 1, timestamp: -1 } },
    { key: { timestamp: -1 } },
  ],
};

// ─── NEW: alerts (platform-level notifications) ────────────────
// One row per triggered alert. The Meta-sync failure detector writes
// type='META_SYNC_FAILURE' when `skipped/total > 0.3` on a sync.
// `status` is "active" on creation; ops can flip to "resolved".
const alerts = {
  collection: 'alerts',
  description: 'Platform alerts (Meta sync failures, etc.)',
  fields: {
    _id:           { type: 'uuid', required: true },
    restaurant_id: { type: 'uuid', required: true },
    type:          { type: 'string', required: true },          // e.g., 'META_SYNC_FAILURE'
    message:       { type: 'string', required: true },
    failure_rate:  { type: 'number' },
    context:       { type: 'object' },                           // branch_id, totals, mode
    status:        { type: 'string', required: true, enum: ['active', 'resolved'] },
    timestamp:     { type: 'date', required: true },
    resolved_at:   { type: 'date' },
  },
  indexes: [
    { key: { restaurant_id: 1, timestamp: -1 } },
    { key: { type: 1, status: 1, timestamp: -1 } },
    { key: { status: 1, timestamp: -1 } },
  ],
};

// Phase 4: persistent catalog sync schedule. Replaces the in-memory
// debouncer in services/catalogSyncQueue.js. One pending row per
// restaurant; `schedule_time` is the earliest moment it should fire.
// Once dispatched the row is kept for audit (status='dispatched').
const catalog_sync_schedule = {
  collection: 'catalog_sync_schedule',
  description: 'Debounced catalog sync schedule (per-restaurant)',
  fields: {
    _id:           { type: 'uuid', required: true },
    restaurant_id: { type: 'uuid', required: true },
    branch_id:     { type: 'uuid' },
    sync_type:     { type: 'string', required: true, enum: ['full', 'branch'] },
    branch_ids:    { type: 'array' },
    schedule_time: { type: 'date', required: true },
    status:        { type: 'string', required: true, enum: ['pending', 'dispatching', 'dispatched', 'failed'] },
    last_error:    { type: 'object' },
    dispatched_at: { type: 'date' },
    created_at:    { type: 'date', required: true },
    updated_at:    { type: 'date' },
  },
  indexes: [
    { key: { status: 1, schedule_time: 1 } },
    { key: { restaurant_id: 1, status: 1 } },
  ],
};

// ─── NEW: menu_uploads (raw XLSX ingestion) ────────────────────
// Stores raw rows of an uploaded menu spreadsheet. Mapping into
// menu_items is a separate, future step — this collection is the
// audit trail / replay source.
const menu_uploads = {
  collection: 'menu_uploads',
  description: 'Raw menu file uploads (XLSX) — pre-mapping audit trail',
  fields: {
    _id:           { type: 'uuid', required: true },
    restaurant_id: { type: 'uuid', required: true },
    file_type:     { type: 'string', required: true, enum: ['xlsx'] },
    // Phase 4: file_url points to S3 ('s3://...') or local disk
    // ('file://...'). raw_data is no longer written for new uploads;
    // preview_sample holds the first ~20 rows for mapping UX, and the
    // full file is re-parsed from storage at import time.
    file_url:      { type: 'string', required: true },
    file_storage:  { type: 'string', enum: ['s3', 'local'] },
    file_key:      { type: 'string' },
    file_bucket:   { type: 'string' },
    file_size:     { type: 'number' },
    original_name: { type: 'string' },
    sheet_name:    { type: 'string' },
    row_count:     { type: 'number' },
    preview_sample:{ type: 'array' },     // first N rows for UI preview
    raw_data:      { type: 'array' },     // DEPRECATED; legacy rows only
    status:        { type: 'string', required: true, enum: ['uploaded', 'mapped', 'imported', 'failed'] },
    created_at:    { type: 'date', required: true },
  },
  indexes: [
    { key: { restaurant_id: 1, created_at: -1 } },
    { key: { status: 1, created_at: -1 } },
  ],
};

// ─── COUPONS ─────────────────────────────────────────────────
// Restaurant-scoped promo codes. Amounts stored in PAISE for the
// checkout-endpoint path (min_order_paise / max_discount_paise) so Meta
// Checkout responses don't need rupee→paise conversion at the edge.
// Rupee columns (min_order_rs / max_discount_rs) remain for the legacy
// conversational coupon flow — services/coupon.js reads either shape.
const coupons = {
  collection: 'coupons',
  description: 'Restaurant promo codes. Evaluated by services/coupon.js for the conversational flow and by the WhatsApp Checkout endpoint (apply_coupon sub_action).',
  fields: {
    _id:                 { type: 'uuid', required: true },
    restaurant_id:       { type: 'uuid' }, // null = platform-wide
    code:                { type: 'string', required: true }, // uppercase, ≤20 chars
    coupon_id:           { type: 'string' },                 // internal slug shown to customer
    description:         { type: 'string' },
    discount_type:       { type: 'string', enum: ['flat', 'percent', 'free_delivery'] },
    discount_value:      { type: 'number' },                 // rupees (flat) or % (percent)
    min_order_paise:     { type: 'number' },                 // Phase: checkout-endpoint
    max_discount_paise:  { type: 'number' },                 // Phase: checkout-endpoint (percent cap)
    min_order_rs:        { type: 'number' },                 // Legacy conversational
    max_discount_rs:     { type: 'number' },                 // Legacy conversational
    valid_from:          { type: 'date' },
    valid_until:         { type: 'date' },
    is_active:           { type: 'boolean', required: true },
    usage_limit:         { type: 'number' },
    usage_count:         { type: 'number' },
    per_user_limit:      { type: 'number' },
    first_order_only:    { type: 'boolean' },
    branch_ids:          { type: 'array' },
    campaign_id:         { type: 'uuid' },
    created_at:          { type: 'date', required: true },
    updated_at:          { type: 'date' },
  },
  indexes: [
    { key: { restaurant_id: 1, code: 1 }, unique: true, partialFilterExpression: { restaurant_id: { $exists: true } } },
    { key: { restaurant_id: 1, is_active: 1 } },
  ],
};

// ─── CHECKOUT_REFS ──────────────────────────────────────────
// Short reference_id → restaurant_id mapping for the WhatsApp Checkout
// endpoint. UUIDs don't fit in the 35-char reference_id limit, so the
// button template send stores a short random id here and the endpoint
// decodes it on apply_coupon / get_coupons. TTL index auto-cleans.
const checkout_refs = {
  collection: 'checkout_refs',
  description: 'Short-lived mapping of WhatsApp Checkout reference_id → restaurant_id/order metadata. TTL index expires old rows.',
  fields: {
    _id:            { type: 'string', required: true }, // the reference_id itself
    restaurant_id:  { type: 'uuid', required: true },
    customer_phone: { type: 'string' },
    template_name:  { type: 'string' },
    created_at:     { type: 'date', required: true },
    expires_at:     { type: 'date', required: true },
  },
  indexes: [
    { key: { restaurant_id: 1, created_at: -1 } },
    { key: { expires_at: 1 }, expireAfterSeconds: 0 },
  ],
};

// ═══════════════════════════════════════════════════════════════
// EXPORT ALL SCHEMAS
// ═══════════════════════════════════════════════════════════════

const ALL_SCHEMAS = {
  restaurants, branches, branch_products, menu_items, orders, order_items,
  customers, customer_metrics, customer_tags, customer_profiles, customer_addresses, cart_sessions, order_counters,
  conversations, payments, restaurant_ledger, settlements,
  whatsapp_accounts, referrals, menu_uploads, sync_logs, sync_summary, alerts,
  brands, messages, catalog, catalog_sync_schedule, coupons, checkout_refs,
};

module.exports = { ALL_SCHEMAS, ...ALL_SCHEMAS };
