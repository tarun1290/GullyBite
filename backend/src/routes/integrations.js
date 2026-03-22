// src/routes/integrations.js
// POS / Delivery platform integrations for restaurants
// Supports: PetPooja (Swiggy/Zomato coming soon)

const express = require('express');
const router  = express.Router();
const { col, newId, mapId, mapIds } = require('../config/database');
const { requireAuth } = require('./auth');
const petpooja   = require('../services/integrations/petpooja');
const urbanpiper = require('../services/integrations/urbanpiper');
const dotpe      = require('../services/integrations/dotpe');

router.use(requireAuth);

const SERVICES = {
  petpooja,
  urbanpiper,
  dotpe,
};

// ─── GET /api/restaurant/integrations ─────────────────────────
// List all integrations for this restaurant (credentials masked)
router.get('/', async (req, res) => {
  try {
    const docs = await col('restaurant_integrations')
      .find({ restaurant_id: req.restaurantId })
      .sort({ platform: 1 })
      .toArray();

    res.json(mapIds(docs).map(d => ({
      ...d,
      api_key      : d.api_key      ? '••••••••' : null,
      api_secret   : d.api_secret   ? '••••••••' : null,
      access_token : d.access_token ? '••••••••' : null,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/restaurant/integrations/:platform ──────────────
// Save or update credentials for a platform
router.post('/:platform', async (req, res) => {
  const { platform } = req.params;
  if (!SERVICES[platform]) return res.status(400).json({ error: 'Unknown platform' });

  const { apiKey, apiSecret, accessToken, outletId, branchId } = req.body;
  if (!branchId) return res.status(400).json({ error: 'branchId is required' });

  // Verify branch belongs to this restaurant
  const branch = await col('branches').findOne({ _id: branchId, restaurant_id: req.restaurantId });
  if (!branch) return res.status(403).json({ error: 'Branch not found' });

  try {
    const now = new Date();
    const existing = await col('restaurant_integrations').findOne({
      restaurant_id: req.restaurantId,
      platform,
    });

    if (existing) {
      const $set = { branch_id: branchId, updated_at: now };
      if (apiKey      != null) $set.api_key      = apiKey;
      if (apiSecret   != null) $set.api_secret   = apiSecret;
      if (accessToken != null) $set.access_token = accessToken;
      if (outletId    != null) $set.outlet_id    = outletId;

      await col('restaurant_integrations').updateOne({ _id: existing._id }, { $set });
      res.json({ success: true, integration: mapId({ ...existing, ...$set }) });
    } else {
      const doc = {
        _id           : newId(),
        restaurant_id : req.restaurantId,
        platform,
        branch_id     : branchId,
        api_key       : apiKey       || null,
        api_secret    : apiSecret    || null,
        access_token  : accessToken  || null,
        outlet_id     : outletId     || null,
        is_active     : false,
        sync_status   : 'idle',
        sync_error    : null,
        last_synced_at: null,
        item_count    : 0,
        created_at    : now,
        updated_at    : now,
      };
      await col('restaurant_integrations').insertOne(doc);
      res.json({ success: true, integration: mapId(doc) });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PATCH /api/restaurant/integrations/:platform/toggle ──────
router.patch('/:platform/toggle', async (req, res) => {
  const { platform } = req.params;
  const { isActive } = req.body;

  try {
    const integration = await col('restaurant_integrations').findOneAndUpdate(
      { restaurant_id: req.restaurantId, platform },
      { $set: { is_active: !!isActive, updated_at: new Date() } },
      { returnDocument: 'after' }
    );
    if (!integration) return res.status(404).json({ error: 'Integration not configured yet' });

    if (isActive && integration.branch_id) {
      triggerSync(platform, integration._id, req.restaurantId).catch(() => {});
    }

    res.json({ success: true, isActive: integration.is_active });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/restaurant/integrations/:platform/sync ─────────
// Manual sync trigger
router.post('/:platform/sync', async (req, res) => {
  const { platform } = req.params;
  if (!SERVICES[platform]) return res.status(400).json({ error: 'Unknown platform' });

  try {
    const integration = await col('restaurant_integrations').findOne({
      restaurant_id: req.restaurantId,
      platform,
    });
    if (!integration) return res.status(404).json({ error: 'Integration not configured' });
    if (!integration.is_active) return res.status(400).json({ error: 'Integration is disabled' });

    const result = await triggerSync(platform, integration._id, req.restaurantId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE /api/restaurant/integrations/:platform ────────────
router.delete('/:platform', async (req, res) => {
  try {
    await col('restaurant_integrations').deleteOne({
      restaurant_id: req.restaurantId,
      platform: req.params.platform,
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── INTERNAL: run a sync and update DB status ────────────────
async function triggerSync(platform, integrationId, restaurantId) {
  await col('restaurant_integrations').updateOne(
    { _id: integrationId },
    { $set: { sync_status: 'syncing', sync_error: null, updated_at: new Date() } }
  );

  try {
    const integration = await col('restaurant_integrations').findOne({ _id: integrationId });
    const svc = SERVICES[platform];
    if (!svc) throw new Error('No service handler for: ' + platform);

    const pulled = await svc.fetchMenu(integration);
    const { added, updated } = await upsertMenu(integration.branch_id, pulled);

    await col('restaurant_integrations').updateOne(
      { _id: integrationId },
      { $set: {
        sync_status   : 'success',
        last_synced_at: new Date(),
        item_count    : pulled.items.length,
        sync_error    : null,
        updated_at    : new Date(),
      }}
    );

    // Fire-and-forget catalog push to Meta
    const catalog = require('../services/catalog');
    catalog.syncBranchCatalog(integration.branch_id)
      .catch(err => console.error('[Integration] Catalog sync failed after POS pull:', err.message));

    return { success: true, platform, added, updated, total: pulled.items.length };

  } catch (err) {
    await col('restaurant_integrations').updateOne(
      { _id: integrationId },
      { $set: { sync_status: 'error', sync_error: err.message, updated_at: new Date() } }
    );
    throw err;
  }
}

// ─── UPSERT MENU: categories then items ──────────────────────
async function upsertMenu(branchId, { categories, items }) {
  // Ensure categories exist, build name → _id map
  const catMap = {};
  for (const cat of categories) {
    const existing = await col('menu_categories').findOneAndUpdate(
      { branch_id: branchId, name: cat.name },
      { $set: { sort_order: cat.sort_order || 0, updated_at: new Date() }, $setOnInsert: { _id: newId(), branch_id: branchId, name: cat.name, created_at: new Date() } },
      { upsert: true, returnDocument: 'after' }
    );
    catMap[cat.name] = existing._id;
  }

  let added = 0, updated = 0;

  for (const item of items) {
    const categoryId = catMap[item.category] || null;
    const pricePaise = Math.round(parseFloat(item.price) * 100);
    const retailerId = item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + branchId.slice(-8);

    const result = await col('menu_items').findOneAndUpdate(
      { branch_id: branchId, external_id: item.external_id },
      {
        $set: {
          name        : item.name,
          description : item.description || '',
          price_paise : pricePaise,
          food_type   : item.food_type || 'veg',
          category_id : categoryId,
          image_url   : item.image_url || null,
          is_available: item.is_available !== false,
          updated_at  : new Date(),
        },
        $setOnInsert: {
          _id         : newId(),
          branch_id   : branchId,
          external_id : item.external_id,
          retailer_id : retailerId,
          created_at  : new Date(),
        },
      },
      { upsert: true, returnDocument: 'before' }
    );

    if (!result) added++;   // was null before → inserted
    else updated++;
  }

  return { added, updated };
}

module.exports = router;
