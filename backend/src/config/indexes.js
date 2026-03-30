// src/config/indexes.js
// Ensures all required MongoDB indexes exist. Run on server startup.

'use strict';

const { col } = require('./database');

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
  { collection: 'customers', index: { wa_phone: 1 }, options: { unique: true, sparse: true } },
  { collection: 'referrals', index: { customer_phone: 1, restaurant_id: 1, status: 1, expires_at: 1 } },
  { collection: 'deliveries', index: { order_id: 1 }, options: { unique: true, sparse: true } },
  { collection: 'deliveries', index: { provider_order_id: 1 } },
  // Analytics indexes
  { collection: 'orders', index: { branch_id: 1, created_at: -1 } },
  { collection: 'orders', index: { status: 1, created_at: -1 } },
  { collection: 'orders', index: { created_at: -1, status: 1 } },
  { collection: 'order_items', index: { order_id: 1, name: 1 } },
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
        console.warn(`[DB] Index on ${spec.collection} failed:`, err.message);
      }
    }
  }
  console.log(`[DB] Ensured ${created}/${INDEXES.length} indexes`);
}

module.exports = { ensureIndexes };
