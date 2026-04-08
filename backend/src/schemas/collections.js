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
    // Timestamps
    created_at:            { type: 'date', required: true },
    updated_at:            { type: 'date' },
  },
  indexes: [
    { key: { status: 1 } },
    { key: { email: 1 }, options: { unique: true, sparse: true } },
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
    latitude:              { type: 'number' },
    longitude:             { type: 'number' },
    delivery_radius_km:    { type: 'number' },
    is_open:               { type: 'boolean' },
    accepts_orders:        { type: 'boolean' },
    catalog_id:            { type: 'string' },
    created_at:            { type: 'date', required: true },
    updated_at:            { type: 'date' },
  },
  indexes: [
    { key: { restaurant_id: 1 } },
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
    food_type:             { type: 'string', enum: ['veg', 'non_veg', 'vegan', 'egg'] },
    category_id:           { type: 'uuid' },
    image_url:             { type: 'string' },
    is_available:          { type: 'boolean', required: true },
    is_bestseller:         { type: 'boolean' },
    item_group_id:         { type: 'string' },
    size:                  { type: 'string' },
    product_tags:          { type: 'array' },
    catalog_sync_status:   { type: 'string', enum: ['pending', 'synced', 'error'] },
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
    { key: { retailer_id: 1 }, options: { unique: true } },
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
    restaurant_id:         { type: 'uuid' },
    subtotal_rs:           { type: 'number', required: true },
    delivery_fee_rs:       { type: 'number' },
    discount_rs:           { type: 'number' },
    total_rs:              { type: 'number', required: true },
    status:                { type: 'string', required: true, enum: ['PENDING_PAYMENT', 'PAID', 'CONFIRMED', 'PREPARING', 'PACKED', 'DISPATCHED', 'DELIVERED', 'CANCELLED'] },
    referral_id:           { type: 'uuid' },
    referral_fee_rs:       { type: 'number' },
    settlement_id:         { type: 'uuid' },
    delivery_address:      { type: 'string' },
    created_at:            { type: 'date', required: true },
  },
  indexes: [
    { key: { restaurant_id: 1, status: 1, created_at: -1 } },
    { key: { customer_id: 1, created_at: -1 } },
    { key: { branch_id: 1, created_at: -1 } },
  ],
};

const order_items = {
  collection: 'order_items',
  description: 'Line items within an order',
  fields: {
    _id:                   { type: 'uuid', required: true },
    order_id:              { type: 'uuid', required: true },
    menu_item_id:          { type: 'uuid' },
    item_name:             { type: 'string', required: true },
    unit_price_rs:         { type: 'number', required: true },
    quantity:              { type: 'number', required: true },
    line_total_rs:         { type: 'number', required: true },
  },
  indexes: [
    { key: { order_id: 1 } },
  ],
};

const customers = {
  collection: 'customers',
  description: 'WhatsApp customers',
  fields: {
    _id:                   { type: 'uuid', required: true },
    wa_phone:              { type: 'string' },
    bsuid:                 { type: 'string' },
    name:                  { type: 'string' },
    total_orders:          { type: 'number' },
    total_spent_rs:        { type: 'number' },
    created_at:            { type: 'date', required: true },
  },
  indexes: [
    { key: { wa_phone: 1 }, options: { unique: true, sparse: true } },
  ],
};

const conversations = {
  collection: 'conversations',
  description: 'WhatsApp conversation state machine',
  fields: {
    _id:                   { type: 'uuid', required: true },
    customer_id:           { type: 'uuid', required: true },
    wa_account_id:         { type: 'uuid', required: true },
    state:                 { type: 'string', required: true },
    session_data:          { type: 'object' },
    is_active:             { type: 'boolean' },
    last_msg_at:           { type: 'date' },
    created_at:            { type: 'date', required: true },
  },
};

const payments = {
  collection: 'payments',
  description: 'Payment records (Razorpay orders + links)',
  fields: {
    _id:                   { type: 'uuid', required: true },
    order_id:              { type: 'uuid', required: true },
    rp_order_id:           { type: 'string' },
    rp_link_id:            { type: 'string' },
    rp_payment_id:         { type: 'string' },
    amount_rs:             { type: 'number', required: true },
    status:                { type: 'string', required: true, enum: ['sent', 'paid', 'failed', 'refunded', 'pending'] },
    payment_type:          { type: 'string' },
    created_at:            { type: 'date', required: true },
  },
};

const settlements = {
  collection: 'settlements',
  description: 'Weekly settlement records per restaurant',
  fields: {
    _id:                   { type: 'uuid', required: true },
    restaurant_id:         { type: 'uuid', required: true },
    period_start:          { type: 'date', required: true },
    period_end:            { type: 'date', required: true },
    food_revenue_rs:       { type: 'number' },
    platform_fee_rs:       { type: 'number' },
    platform_fee_gst_rs:   { type: 'number' },
    referral_fee_rs:       { type: 'number' },
    referral_fee_gst_rs:   { type: 'number' },
    gross_revenue_rs:      { type: 'number' },
    net_payout_rs:         { type: 'number' },
    is_first_billing_month:{ type: 'boolean' },
    payout_status:         { type: 'string', enum: ['pending', 'processing', 'completed', 'failed'] },
    created_at:            { type: 'date', required: true },
  },
  indexes: [
    { key: { restaurant_id: 1, period_start: -1 } },
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

// ═══════════════════════════════════════════════════════════════
// EXPORT ALL SCHEMAS
// ═══════════════════════════════════════════════════════════════

const ALL_SCHEMAS = {
  restaurants, branches, menu_items, orders, order_items,
  customers, conversations, payments, settlements,
  whatsapp_accounts, referrals,
};

module.exports = { ALL_SCHEMAS, ...ALL_SCHEMAS };
