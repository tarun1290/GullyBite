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
  // Idempotency — processed_events with 24h TTL auto-cleanup
  { collection: 'processed_events', index: { processed_at: 1 }, options: { expireAfterSeconds: 86400 } },
  { collection: 'processed_events', index: { source: 1, processed_at: -1 } },
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
