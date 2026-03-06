// src/routes/integrations.js
// POS / Delivery platform integrations for restaurants
// Supports: PetPooja, Swiggy, Zomato
// Each integration stores credentials and syncs menu -> our DB -> Meta Catalog

const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const { requireAuth } = require('./auth');
const petpooja = require('../services/integrations/petpooja');
// const swiggy   = require('../services/integrations/swiggy');   // coming soon
// const zomato   = require('../services/integrations/zomato');   // coming soon

router.use(requireAuth);

const SERVICES = {
  petpooja,
  // swiggy,   // coming soon
  // zomato,   // coming soon
};

// ─── GET /api/restaurant/integrations ─────────────────────
// List all integration states for this restaurant
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT
         id, platform, branch_id, outlet_id, is_active,
         last_synced_at, sync_status, sync_error, item_count,
         created_at, updated_at,
         -- never expose raw credentials
         CASE WHEN api_key IS NOT NULL THEN '••••••••' END AS api_key,
         CASE WHEN api_secret IS NOT NULL THEN '••••••••' END AS api_secret,
         CASE WHEN access_token IS NOT NULL THEN '••••••••' END AS access_token
       FROM restaurant_integrations
       WHERE restaurant_id = $1
       ORDER BY platform`,
      [req.restaurantId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/restaurant/integrations/:platform ──────────
// Save or update credentials for a platform
router.post('/:platform', async (req, res) => {
  const { platform } = req.params;
  if (!SERVICES[platform]) return res.status(400).json({ error: 'Unknown platform' });

  const { apiKey, apiSecret, accessToken, outletId, branchId } = req.body;
  if (!branchId) return res.status(400).json({ error: 'branchId is required — choose which branch to sync into' });

  // Verify the branch belongs to this restaurant
  const { rows: br } = await db.query(
    'SELECT id FROM branches WHERE id = $1 AND restaurant_id = $2',
    [branchId, req.restaurantId]
  );
  if (!br.length) return res.status(403).json({ error: 'Branch not found' });

  try {
    const { rows } = await db.query(
      `INSERT INTO restaurant_integrations
         (restaurant_id, platform, branch_id, api_key, api_secret, access_token, outlet_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (restaurant_id, platform)
       DO UPDATE SET
         branch_id    = EXCLUDED.branch_id,
         api_key      = COALESCE(EXCLUDED.api_key, restaurant_integrations.api_key),
         api_secret   = COALESCE(EXCLUDED.api_secret, restaurant_integrations.api_secret),
         access_token = COALESCE(EXCLUDED.access_token, restaurant_integrations.access_token),
         outlet_id    = COALESCE(EXCLUDED.outlet_id, restaurant_integrations.outlet_id),
         updated_at   = NOW()
       RETURNING id, platform, is_active, sync_status`,
      [req.restaurantId, platform, branchId, apiKey || null, apiSecret || null, accessToken || null, outletId || null]
    );
    res.json({ success: true, integration: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PATCH /api/restaurant/integrations/:platform/toggle ──
// Enable or disable an integration
router.patch('/:platform/toggle', async (req, res) => {
  const { platform } = req.params;
  const { isActive } = req.body;

  try {
    const { rows } = await db.query(
      `UPDATE restaurant_integrations
       SET is_active = $1, updated_at = NOW()
       WHERE restaurant_id = $2 AND platform = $3
       RETURNING id, platform, is_active, branch_id, outlet_id`,
      [isActive, req.restaurantId, platform]
    );
    if (!rows.length) return res.status(404).json({ error: 'Integration not configured yet' });

    // Trigger an initial sync when toggling ON
    if (isActive && rows[0].branch_id) {
      triggerSync(platform, rows[0].id, req.restaurantId).catch(() => {});
    }

    res.json({ success: true, isActive: rows[0].is_active });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/restaurant/integrations/:platform/sync ─────
// Manual sync trigger — pull from POS, upsert to our DB, push to Meta
router.post('/:platform/sync', async (req, res) => {
  const { platform } = req.params;
  if (!SERVICES[platform]) return res.status(400).json({ error: 'Unknown platform' });

  try {
    const { rows } = await db.query(
      `SELECT * FROM restaurant_integrations
       WHERE restaurant_id = $1 AND platform = $2`,
      [req.restaurantId, platform]
    );
    if (!rows.length) return res.status(404).json({ error: 'Integration not configured' });
    if (!rows[0].is_active) return res.status(400).json({ error: 'Integration is disabled' });

    const result = await triggerSync(platform, rows[0].id, req.restaurantId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE /api/restaurant/integrations/:platform ────────
// Remove integration credentials entirely
router.delete('/:platform', async (req, res) => {
  try {
    await db.query(
      'DELETE FROM restaurant_integrations WHERE restaurant_id = $1 AND platform = $2',
      [req.restaurantId, req.params.platform]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── INTERNAL: run a sync and update DB status ────────────
async function triggerSync(platform, integrationId, restaurantId) {
  // Mark as syncing
  await db.query(
    `UPDATE restaurant_integrations
     SET sync_status = 'syncing', sync_error = NULL, updated_at = NOW()
     WHERE id = $1`,
    [integrationId]
  );

  try {
    // Load full integration row (with real credentials)
    const { rows } = await db.query(
      'SELECT * FROM restaurant_integrations WHERE id = $1',
      [integrationId]
    );
    const integration = rows[0];
    const svc = SERVICES[platform];
    if (!svc) throw new Error('No service handler for: ' + platform);

    // Each service returns { items: [...], categories: [...] }
    const pulled = await svc.fetchMenu(integration);

    // Upsert categories and items into our DB
    const { added, updated } = await upsertMenu(integration.branch_id, pulled);

    // Update sync status + item count
    await db.query(
      `UPDATE restaurant_integrations
       SET sync_status   = 'success',
           last_synced_at = NOW(),
           item_count     = $1,
           sync_error     = NULL,
           updated_at     = NOW()
       WHERE id = $2`,
      [pulled.items.length, integrationId]
    );

    // Fire-and-forget catalog push to Meta
    const catalog = require('../services/catalog');
    catalog.syncBranchCatalog(integration.branch_id)
      .catch(err => console.error('[Integration] Catalog sync failed after POS pull:', err.message));

    return { success: true, platform, added, updated, total: pulled.items.length };

  } catch (err) {
    await db.query(
      `UPDATE restaurant_integrations
       SET sync_status = 'error', sync_error = $1, updated_at = NOW()
       WHERE id = $2`,
      [err.message, integrationId]
    );
    throw err;
  }
}

// ─── UPSERT MENU: categories then items ──────────────────
async function upsertMenu(branchId, { categories, items }) {
  // Build category name → id map (create missing ones)
  const catMap = {};
  for (const cat of categories) {
    const { rows } = await db.query(
      `INSERT INTO menu_categories (branch_id, name, sort_order)
       VALUES ($1, $2, $3)
       ON CONFLICT (branch_id, name) DO UPDATE SET sort_order = EXCLUDED.sort_order
       RETURNING id`,
      [branchId, cat.name, cat.sort_order || 0]
    );
    catMap[cat.name] = rows[0].id;
  }

  let added = 0, updated = 0;

  for (const item of items) {
    const categoryId = catMap[item.category] || null;
    const pricePaise = Math.round(parseFloat(item.price) * 100);

    // Use external_id (from POS) as the unique key per branch
    const { rows, rowCount } = await db.query(
      `INSERT INTO menu_items
         (branch_id, external_id, name, description, price_paise, food_type,
          category_id, image_url, is_available, retailer_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               LOWER(REGEXP_REPLACE($3, '[^a-zA-Z0-9]', '-', 'g')) || '-' || $1)
       ON CONFLICT (branch_id, external_id) DO UPDATE SET
         name         = EXCLUDED.name,
         description  = EXCLUDED.description,
         price_paise  = EXCLUDED.price_paise,
         food_type    = EXCLUDED.food_type,
         category_id  = EXCLUDED.category_id,
         image_url    = COALESCE(EXCLUDED.image_url, menu_items.image_url),
         is_available = EXCLUDED.is_available,
         updated_at   = NOW()
       RETURNING (xmax = 0) AS is_new`,
      [branchId, item.external_id, item.name, item.description || '',
       pricePaise, item.food_type || 'veg', categoryId, item.image_url || null,
       item.is_available !== false]
    );

    if (rowCount > 0) {
      rows[0].is_new ? added++ : updated++;
    }
  }

  return { added, updated };
}

module.exports = router;
