// src/config/indexes.js
// Ensures all required MongoDB indexes exist. Run on server startup.

'use strict';

const { col } = require('./database');
const log = require('../utils/logger').child({ component: 'indexes' });

const INDEXES = [
  { collection: 'orders', index: { restaurant_id: 1, status: 1, created_at: -1 } },
  { collection: 'orders', index: { restaurant_id: 1, created_at: -1 } },
  { collection: 'orders', index: { customer_id: 1, created_at: -1 } },
  { collection: 'customer_messages', index: { restaurant_id: 1, status: 1, created_at: -1 } },
  { collection: 'customer_messages', index: { customer_id: 1, restaurant_id: 1, created_at: -1 } },
  { collection: 'customer_messages', index: { wa_message_id: 1 }, options: { unique: true, sparse: true } },
  { collection: 'activity_logs', index: { restaurant_id: 1, created_at: -1 } },
  { collection: 'activity_logs', index: { severity: 1, created_at: -1 } },
  { collection: 'webhook_logs', index: { source: 1, created_at: -1 } },
  { collection: 'settlements', index: { restaurant_id: 1, period_start: -1 } },
  // Phase 5: on-demand settlements (paise shape) — sorted by creation,
  // plus a status-only index for cron scans / stuck-payout lookups.
  { collection: 'settlements', index: { restaurant_id: 1, created_at: -1 } },
  { collection: 'settlements', index: { status: 1, created_at: -1 } },
  { collection: 'settlements', index: { payout_id: 1 }, options: { sparse: true } },
  { collection: 'branches', index: { restaurant_id: 1 } },
  { collection: 'menu_items', index: { restaurant_id: 1, branch_id: 1 } },
  { collection: 'menu_items', index: { branch_id: 1, is_available: 1 } },
  { collection: 'menu_items', index: { item_group_id: 1, branch_id: 1 } },
  { collection: 'menu_items', index: { restaurant_id: 1, is_available: 1, 'trust_metrics.trust_tag': 1 } },
  { collection: 'menu_items', index: { restaurant_id: 1, 'trust_metrics.average_rating': -1 } },
  { collection: 'order_ratings', index: { order_id: 1 } },
  { collection: 'order_state_log', index: { order_id: 1, timestamp: -1 } },
  { collection: 'order_state_log', index: { timestamp: -1 } },
  // Catalog compression indexes
  { collection: 'catalog_master_products', index: { restaurantId: 1 } },
  { collection: 'catalog_master_products', index: { restaurantId: 1, masterSignature: 1 }, options: { unique: true } },
  { collection: 'catalog_compressed_skus', index: { restaurantId: 1, active: 1 } },
  { collection: 'catalog_compressed_skus', index: { restaurantId: 1, skuSignature: 1 }, options: { unique: true } },
  { collection: 'catalog_compressed_skus', index: { masterProductId: 1 } },
  { collection: 'catalog_compressed_sku_variants', index: { compressedSkuId: 1 } },
  { collection: 'catalog_compressed_sku_variants', index: { restaurantId: 1 } },
  { collection: 'branch_catalog_mapping', index: { restaurantId: 1, branchId: 1 } },
  { collection: 'branch_catalog_mapping', index: { rawMenuItemId: 1 } },
  { collection: 'branch_catalog_mapping', index: { compressedSkuId: 1 } },
  { collection: 'catalog_compression_runs', index: { restaurantId: 1, startedAt: -1 } },
  { collection: 'customers', index: { wa_phone: 1 }, options: { unique: true, sparse: true } },
  // Phase 6: identity layer — phone_hash is the canonical key.
  { collection: 'customers', index: { phone_hash: 1 }, options: { unique: true, sparse: true } },
  { collection: 'customer_metrics', index: { phone_hash: 1 }, options: { unique: true } },
  { collection: 'customer_metrics', index: { 'restaurant_stats.restaurant_id': 1 } },
  { collection: 'customer_metrics', index: { customer_type: 1 } },
  { collection: 'customer_tags', index: { phone_hash: 1, restaurant_id: 1 } },
  { collection: 'orders', index: { phone_hash: 1, created_at: -1 }, options: { sparse: true } },
  { collection: 'referrals', index: { customer_phone: 1, restaurant_id: 1, status: 1, expires_at: 1 } },
  { collection: 'deliveries', index: { order_id: 1 }, options: { unique: true, sparse: true } },
  { collection: 'deliveries', index: { provider_order_id: 1 } },
  // Admin user (RBAC) indexes
  { collection: 'admin_users', index: { email: 1 }, options: { unique: true } },
  { collection: 'admin_users', index: { role: 1, is_active: 1 } },
  { collection: 'admin_audit_log', index: { admin_id: 1, timestamp: -1 } },
  { collection: 'admin_audit_log', index: { action: 1, timestamp: -1 } },
  // Admin WABA indexes
  { collection: 'admin_numbers', index: { phone_number_id: 1 }, options: { unique: true } },
  { collection: 'admin_numbers', index: { purpose: 1, is_active: 1 } },
  { collection: 'admin_messages', index: { timestamp: -1 } },
  { collection: 'admin_messages', index: { customer_phone: 1, timestamp: -1 } },
  // Referral link indexes
  { collection: 'referral_links', index: { code: 1 }, options: { unique: true } },
  { collection: 'referral_links', index: { restaurant_id: 1, status: 1 } },
  { collection: 'referrals', index: { referral_code: 1 } },
  // Abandoned cart recovery indexes
  { collection: 'abandoned_carts', index: { restaurant_id: 1, recovery_status: 1, created_at: -1 } },
  { collection: 'abandoned_carts', index: { customer_phone: 1, restaurant_id: 1, created_at: -1 } },
  { collection: 'abandoned_carts', index: { recovery_status: 1, created_at: 1 } },
  { collection: 'abandoned_carts', index: { restaurant_id: 1, created_at: -1 } },
  { collection: 'abandoned_carts', index: { expires_at: 1 }, options: { expireAfterSeconds: 0 } },
  // Analytics indexes
  { collection: 'orders', index: { branch_id: 1, created_at: -1 } },
  { collection: 'orders', index: { status: 1, created_at: -1 } },
  { collection: 'orders', index: { created_at: -1, status: 1 } },
  { collection: 'order_items', index: { order_id: 1, name: 1 } },
  // Coupon + redemption indexes
  { collection: 'coupons', index: { restaurant_id: 1, is_active: 1, code: 1 } },
  { collection: 'coupons', index: { campaign_id: 1 }, options: { sparse: true } },
  { collection: 'coupon_redemptions', index: { coupon_id: 1, customer_id: 1 } },
  { collection: 'coupon_redemptions', index: { order_id: 1 } },
  // Campaign message tracking
  { collection: 'campaign_messages', index: { campaign_id: 1, status: 1 } },
  { collection: 'campaign_messages', index: { message_id: 1 }, options: { unique: true, sparse: true } },
  // ROI attribution — quick "latest campaign send to this phone" lookup.
  { collection: 'campaign_messages', index: { campaign_id: 1 } },
  { collection: 'campaign_messages', index: { phone_hash: 1, sent_at: -1 }, options: { sparse: true } },
  // marketing_messages → campaigns linkage (populated once Meta webhook lands).
  { collection: 'marketing_messages', index: { campaign_id: 1 }, options: { sparse: true } },
  { collection: 'marketing_messages', index: { phone_hash: 1, sent_at: -1 }, options: { sparse: true } },
  // Order attribution — list orders generated by a campaign.
  { collection: 'orders', index: { attributed_campaign_id: 1, created_at: -1 }, options: { sparse: true } },
  // Marketing message ledger (chargeable WhatsApp marketing sends)
  { collection: 'marketing_messages', index: { restaurant_id: 1 } },
  { collection: 'marketing_messages', index: { sent_at: -1 } },
  { collection: 'marketing_messages', index: { message_id: 1 }, options: { unique: true, sparse: true } },
  // Settlement scan — unsettled rows per restaurant, ordered by sent_at.
  // Descending on sent_at so "latest N messages" and settlement-window
  // scans both use the same composite. Matches the security review's
  // required index shape.
  { collection: 'marketing_messages', index: { restaurant_id: 1, settled: 1, sent_at: -1 } },
  { collection: 'marketing_messages', index: { settlement_id: 1 }, options: { sparse: true } },
  // Idempotency (legacy) — processed_events powers utils/idempotency.js once().
  // Used by webhook handlers for fire-and-forget event dedup. 24h TTL auto-cleanup.
  // Pattern: insertOne (key uniqueness on _id) → succeed = first time, E11000 = duplicate.
  // Returns nothing — handler runs again on the same event are silently skipped.
  { collection: 'processed_events', index: { processed_at: 1 }, options: { expireAfterSeconds: 86400 } },
  { collection: 'processed_events', index: { source: 1, processed_at: -1 } },

  // Idempotency (response-caching) — idempotency_keys powers utils/withIdempotency.js
  // Used when the second call needs to receive the SAME response as the first
  // (vs. processed_events.once() which just skips duplicates). Primary use:
  // order creation, where a double-click must return the SAME order_id, not a
  // new one. 48h TTL — long enough to cover most retry windows but short enough
  // that the collection stays bounded.
  //
  // Schema:
  //   { _id: <key>, type, reference_id, status, response, attempts,
  //     created_at, updated_at, expires_at }
  //   status ∈ { 'processing', 'success', 'failed' }
  { collection: 'idempotency_keys', index: { expires_at: 1 }, options: { expireAfterSeconds: 0 } },
  { collection: 'idempotency_keys', index: { type: 1, status: 1, created_at: -1 } },
  { collection: 'idempotency_keys', index: { reference_id: 1 }, options: { sparse: true } },

  // Trust score — one row per user; lookups are always by user_id.
  { collection: 'user_trust', index: { user_id: 1 }, options: { unique: true } },
  { collection: 'user_trust', index: { trust_score: 1, updated_at: -1 } },

  // Settlement state log — timeline view per settlement.
  { collection: 'settlement_state_log', index: { settlement_id: 1, timestamp: -1 } },
  { collection: 'settlement_state_log', index: { timestamp: -1 } },

  // Recovery jobs scan by (status, created_at) and (state, processing_at).
  // The orders(customer_id, created_at) index already covers the first;
  // settlements needs a dedicated one for PROCESSING > threshold lookups.
  { collection: 'settlements', index: { state: 1, processing_at: 1 } },

  // Branch-first additions.
  { collection: 'branches', index: { city: 1 } },
  { collection: 'branches', index: { is_active: 1 } },
  // Products: dashboard "unassigned" query is (restaurant_id, is_unassigned);
  // customer menu reads use (branch_ids) membership.
  { collection: 'menu_items', index: { restaurant_id: 1, is_unassigned: 1 } },
  { collection: 'menu_items', index: { branch_ids: 1 } },
  // Per-branch overrides — unique on (product, branch); listing per branch.
  { collection: 'branch_products', index: { product_id: 1, branch_id: 1 }, options: { unique: true } },
  { collection: 'branch_products', index: { branch_id: 1 } },
  { collection: 'catalog_sync_skips', index: { branch_id: 1, at: -1 } },

  // Distributed locks (mutual exclusion) — `locks` powers utils/withLock.js.
  // Used when an operation needs "first-wins, others fail-fast" semantics
  // rather than the result-caching idempotency pattern. Examples:
  //   • Catalog clear-and-resync (destructive multi-step, must never overlap)
  //   • Future bulk imports / backfill scripts that should run as singletons
  //
  // Schema: { _id: <lock_key>, owner: <unique_holder_token>, acquired_at,
  //           expires_at, type }
  //
  // The expires_at TTL index ensures stale locks (e.g., from a crashed
  // process) are auto-released. The lock TTL is short (5–15 sec by default)
  // so deadlock cleanup is fast even if a holder crashes.
  { collection: 'locks', index: { expires_at: 1 }, options: { expireAfterSeconds: 0 } },
  { collection: 'locks', index: { type: 1, acquired_at: -1 } },

  // ─── PER-ORDER SETTLEMENT SYSTEM (v2) ─────────────────────
  // Order settlements — one row per order, unique constraint prevents duplicates
  { collection: 'order_settlements', index: { order_id: 1 }, options: { unique: true } },
  { collection: 'order_settlements', index: { restaurant_id: 1, status: 1, created_at: -1 } },
  { collection: 'order_settlements', index: { status: 1, created_at: -1 } },
  { collection: 'order_settlements', index: { payout_id: 1 }, options: { sparse: true } },

  // Payouts — one row per payout attempt
  { collection: 'payouts', index: { settlement_id: 1 } },
  { collection: 'payouts', index: { restaurant_id: 1, status: 1, created_at: -1 } },
  { collection: 'payouts', index: { razorpay_payout_id: 1 }, options: { unique: true, sparse: true } },
  { collection: 'payouts', index: { idempotency_key: 1 }, options: { unique: true, sparse: true } },

  // Webhook events — Razorpay event deduplication
  { collection: 'razorpay_webhook_events', index: { event_id: 1 }, options: { unique: true, sparse: true } },
  { collection: 'razorpay_webhook_events', index: { type: 1, created_at: -1 } },
  { collection: 'razorpay_webhook_events', index: { processed: 1, created_at: 1 } },

  // ─── META OAUTH (redirect-only flow) ───────────────────────
  // CSRF state, persisted across Lambda instances. TTL auto-cleans expired states.
  { collection: 'meta_oauth_states', index: { expires_at: 1 }, options: { expireAfterSeconds: 0 } },
  { collection: 'meta_oauth_states', index: { restaurant_id: 1, created_at: -1 } },
  // Callback results (success/error) handed off to the dashboard via meta_connect_id.
  // TTL = 10 min so a stale connect_id can never resurface.
  { collection: 'meta_connect_results', index: { expires_at: 1 }, options: { expireAfterSeconds: 0 } },
  { collection: 'meta_connect_results', index: { restaurant_id: 1 } },

  // ─── WABA-BIND-FIX: structural cross-tenant collision protection ────
  // A phone_number_id is GLOBALLY unique on Meta's side. We mirror that
  // here as a sparse-unique index so two restaurant rows can never claim
  // the same phone_number_id, even if a future code path forgets the
  // composite filter. Sparse so legacy rows without phone_number_id don't
  // collide with each other.
  { collection: 'whatsapp_accounts', index: { phone_number_id: 1 }, options: { unique: true, sparse: true } },
  // Tenant + linked-record lookup
  { collection: 'whatsapp_accounts', index: { restaurant_id: 1, is_active: 1 } },
  { collection: 'whatsapp_accounts', index: { restaurant_id: 1, account_type: 1 } },
  // Restaurant linkage source of truth — fast lookup of "which WABA is the
  // primary for this restaurant?"
  { collection: 'restaurants', index: { linked_phone_number_id: 1 }, options: { sparse: true } },

  // Menu file ingestion — list-by-tenant + ops-status filter.
  { collection: 'menu_uploads', index: { restaurant_id: 1, created_at: -1 } },
  { collection: 'menu_uploads', index: { status: 1, created_at: -1 } },

  // Per-product sync audit log — admin "Sync Logs" page filters by
  // restaurant + status + time range; product/branch lookups for ops.
  { collection: 'sync_logs', index: { restaurant_id: 1, timestamp: -1 } },
  { collection: 'sync_logs', index: { branch_id: 1, timestamp: -1 } },
  { collection: 'sync_logs', index: { status: 1, timestamp: -1 } },
  { collection: 'sync_logs', index: { product_id: 1, timestamp: -1 } },

  // sync_summary — coarse per-sync rollups (total/synced/skipped + success_rate).
  { collection: 'sync_summary', index: { restaurant_id: 1, timestamp: -1 } },
  { collection: 'sync_summary', index: { branch_id: 1, timestamp: -1 } },
  { collection: 'sync_summary', index: { timestamp: -1 } },

  // alerts — platform notifications (Meta sync failures, etc.)
  { collection: 'alerts', index: { restaurant_id: 1, timestamp: -1 } },
  { collection: 'alerts', index: { type: 1, status: 1, timestamp: -1 } },
  { collection: 'alerts', index: { status: 1, timestamp: -1 } },

  // ─── BRAND LAYER (optional, additive) ──────────────────────
  // brands: one business → many brands. phone_number_id is GLOBALLY
  // unique on Meta's side; mirrored as sparse-unique here so two
  // brands cannot claim the same WABA number. Sparse so legacy/empty
  // brand rows without phone_number_id don't collide with each other.
  { collection: 'brands', index: { business_id: 1 } },
  { collection: 'brands', index: { phone_number_id: 1 }, options: { unique: true, sparse: true } },
  { collection: 'brands', index: { status: 1 } },
  // brand_id lookups on existing collections — sparse so rows without
  // brand_id (the legacy single-brand path) don't bloat the index.
  { collection: 'orders', index: { brand_id: 1, created_at: -1 }, options: { sparse: true } },
  { collection: 'menu_items', index: { brand_id: 1 }, options: { sparse: true } },
  { collection: 'customer_messages', index: { brand_id: 1, created_at: -1 }, options: { sparse: true } },

  // Brand-scoped messages collection (coexists with customer_messages).
  { collection: 'messages', index: { brand_id: 1, created_at: -1 }, options: { sparse: true } },
  { collection: 'messages', index: { business_id: 1, created_at: -1 }, options: { sparse: true } },
  { collection: 'messages', index: { wa_message_id: 1 }, options: { unique: true, sparse: true } },

  // Brand-scoped catalog registry.
  { collection: 'catalog', index: { brand_id: 1 }, options: { sparse: true } },
  { collection: 'catalog', index: { business_id: 1 }, options: { sparse: true } },
  { collection: 'catalog', index: { catalog_id: 1 }, options: { unique: true, sparse: true } },

  // restaurants.business_type — 'single' (default/legacy) | 'multi'.
  // Legacy rows without the field read as 'single' in application
  // logic; this index only accelerates multi-brand filtering.
  { collection: 'restaurants', index: { business_type: 1 } },

  // ─── PHASE 1 — CUSTOMER ARCHITECTURE SPLIT ─────────────────
  // Per-tenant customer state. Unique (restaurant_id, customer_id)
  // guarantees one profile row per tenant per customer.
  { collection: 'customer_profiles', index: { restaurant_id: 1, customer_id: 1 }, options: { unique: true } },
  { collection: 'customer_profiles', index: { restaurant_id: 1, last_order_at: -1 } },

  // Global addresses keyed by customer. Default-first ordering for the
  // WhatsApp "choose address" list.
  { collection: 'customer_addresses', index: { customer_id: 1, is_default: -1, updated_at: -1 } },

  // Durable cart sessions — one active cart per (tenant, customer).
  // TTL reaps abandoned carts via expires_at.
  { collection: 'cart_sessions', index: { restaurant_id: 1, customer_id: 1 }, options: { unique: true } },
  { collection: 'cart_sessions', index: { expires_at: 1 }, options: { expireAfterSeconds: 0 } },

  // ─── PHASE 1 — MULTI-TENANCY: PER-TENANT RETAILER_ID ───────
  // Replaces the legacy global-unique on menu_items.retailer_id, which
  // would block two tenants from reusing the same SKU string. The
  // legacy index is dropped by scripts/migrate-phase1.js; leaving it
  // undropped is harmless until two tenants collide (which is itself
  // the bug we're fixing). Composite unique enforces per-tenant.
  { collection: 'menu_items', index: { restaurant_id: 1, retailer_id: 1 }, options: { unique: true } },

  // ─── PHASE 1 — DENORMALIZED restaurant_id ──────────────────
  // order_items, payments, conversations, messages now carry
  // restaurant_id so tenant-scoped queries don't join through orders.
  // Sparse because legacy rows predate the field.
  { collection: 'order_items', index: { restaurant_id: 1 }, options: { sparse: true } },
  { collection: 'payments', index: { restaurant_id: 1, created_at: -1 }, options: { sparse: true } },
  { collection: 'payments', index: { restaurant_id: 1, status: 1 }, options: { sparse: true } },
  { collection: 'conversations', index: { restaurant_id: 1, customer_id: 1 }, options: { sparse: true } },
  { collection: 'messages', index: { restaurant_id: 1, created_at: -1 }, options: { sparse: true } },

  // ─── PHASE 3 — RESTAURANT LEDGER ───────────────────────────
  // Credit/debit log per restaurant. Unique(ref_type, ref_id) guarantees
  // that duplicate payment/refund webhooks can never double-book the
  // ledger — duplicate inserts E11000 and the caller swallows the error.
  { collection: 'restaurant_ledger', index: { restaurant_id: 1, created_at: -1 } },
  // Phase 3.1: unique scoped by restaurant_id. Supersedes the earlier
  // (ref_type, ref_id) unique. The legacy index is dropped by
  // scripts/migrate-phase3.js; leaving it undropped is harmless for a
  // single-tenant deployment but blocks multi-tenant refund fan-out.
  { collection: 'restaurant_ledger', index: { restaurant_id: 1, ref_type: 1, ref_id: 1 }, options: { unique: true } },
  { collection: 'restaurant_ledger', index: { ref_type: 1, status: 1, created_at: -1 } },

  // ─── PHASE 4 — CATALOG SYNC SCHEDULE ───────────────────────
  { collection: 'catalog_sync_schedule', index: { status: 1, schedule_time: 1 } },
  { collection: 'catalog_sync_schedule', index: { restaurant_id: 1, status: 1 } },
  // Dispatched rows are kept for audit but auto-expire after 7 days to
  // keep the collection bounded — re-computable from message_jobs.
  { collection: 'catalog_sync_schedule', index: { dispatched_at: 1 }, options: { expireAfterSeconds: 7 * 24 * 60 * 60, sparse: true } },

  // ─── PHASE 4 — TTL INDEXES ─────────────────────────────────
  // Retention policy, enforced by Mongo's TTL monitor. Dates on each
  // row (received_at / created_at / timestamp) decide the expiry; the
  // TTL index is expireAfterSeconds relative to that field.
  // webhook_logs: 90 days (ops debugging window).
  { collection: 'webhook_logs', index: { received_at: 1 }, options: { expireAfterSeconds: 90 * 24 * 60 * 60 } },
  // messages: 180 days (WhatsApp compliance — we keep inbound/outbound
  // audit half-a-year; anything older is exported elsewhere).
  { collection: 'messages', index: { created_at: 1 }, options: { expireAfterSeconds: 180 * 24 * 60 * 60 } },
  // sync_logs: 90 days.
  { collection: 'sync_logs', index: { timestamp: 1 }, options: { expireAfterSeconds: 90 * 24 * 60 * 60 } },
  // message_jobs: expire 24h after completion. Uses `finished_at`
  // (set by worker on success or permanent failure), sparse so
  // in-flight jobs (no finished_at) never expire.
  { collection: 'message_jobs', index: { finished_at: 1 }, options: { expireAfterSeconds: 24 * 60 * 60, sparse: true } },

  // Platform-wide pincode serviceability map (Prorouting seed).
  // Unique on pincode so $setOnInsert upserts are idempotent.
  { collection: 'serviceable_pincodes', index: { pincode: 1 }, options: { unique: true } },
  { collection: 'serviceable_pincodes', index: { enabled: 1 } },
  { collection: 'serviceable_pincodes', index: { city: 1 } },
  { collection: 'serviceable_pincodes', index: { state: 1 } },
];

async function ensureIndexes() {
  let created = 0;
  for (const spec of INDEXES) {
    try {
      await col(spec.collection).createIndex(spec.index, spec.options || { background: true });
      created++;
    } catch (err) {
      // Index may already exist with different options — not fatal
      if (!err.message.includes('already exists')) {
        log.warn({ err, collection: spec.collection }, 'Index creation failed');
      }
    }
  }
  log.info({ created, total: INDEXES.length }, `Ensured ${created}/${INDEXES.length} indexes`);
}

module.exports = { ensureIndexes };
