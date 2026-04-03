// src/routes/integrations.js
// POS / Delivery platform integrations for restaurants
// Supports: PetPooja, UrbanPiper, DotPe
// Menu sync: POS → menu_items (full Meta-ready schema) → Meta catalog

const express = require('express');
const router  = express.Router();
const { col, newId, mapId, mapIds } = require('../config/database');
const { requireAuth } = require('./auth');
const { logActivity } = require('../services/activityLog');
const { POS_INTEGRATIONS_ENABLED } = require('../config/features');
const { triggerSync, upsertMenu, SERVICES } = require('../services/posSync');

router.use(requireAuth);

const POS_503 = { error: 'POS integrations are currently disabled. Set ENABLE_POS_INTEGRATIONS=true to activate.', feature: 'pos_integrations', status: 'disabled' };

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
  if (!POS_INTEGRATIONS_ENABLED) return res.status(503).json(POS_503);
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
        last_sync_result : null,
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
  if (!POS_INTEGRATIONS_ENABLED) return res.status(503).json(POS_503);
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
      triggerSync(platform, integration._id, req.restaurantId, 'incremental').catch(() => {});
    }

    res.json({ success: true, isActive: integration.is_active });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/restaurant/integrations/:platform/sync ─────────
// Manual sync trigger — supports sync_mode: "incremental" (default) or "full_replace"
router.post('/:platform/sync', async (req, res) => {
  if (!POS_INTEGRATIONS_ENABLED) return res.status(503).json(POS_503);
  const { platform } = req.params;
  const syncMode = req.body?.syncMode || 'incremental';
  if (!SERVICES[platform]) return res.status(400).json({ error: 'Unknown platform' });

  try {
    const integration = await col('restaurant_integrations').findOne({
      restaurant_id: req.restaurantId,
      platform,
    });
    if (!integration) return res.status(404).json({ error: 'Integration not configured' });
    if (!integration.is_active) return res.status(400).json({ error: 'Integration is disabled' });

    const result = await triggerSync(platform, integration._id, req.restaurantId, syncMode);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/restaurant/integrations/:platform/variants ──────
// Preview variant mapping after last sync
router.get('/:platform/variants', async (req, res) => {
  const { platform } = req.params;
  try {
    const integration = await col('restaurant_integrations').findOne({
      restaurant_id: req.restaurantId,
      platform,
    });
    if (!integration) return res.status(404).json({ error: 'Integration not configured' });

    const items = await col('menu_items').find({
      branch_id: integration.branch_id,
      pos_platform: platform,
      item_group_id: { $ne: null },
    }).sort({ item_group_id: 1, price_paise: 1 }).toArray();

    // Group by item_group_id
    const groups = {};
    for (const item of items) {
      const gid = item.item_group_id;
      if (!groups[gid]) groups[gid] = { item_group_id: gid, name: item.name, pos_item_id: item.pos_item_id, variants: [] };
      groups[gid].variants.push({
        size: item.size,
        price_paise: item.price_paise,
        retailer_id: item.retailer_id,
        is_available: item.is_available,
      });
    }

    res.json({ variant_groups: Object.values(groups) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE /api/restaurant/integrations/:platform ────────────
router.delete('/:platform', async (req, res) => {
  if (!POS_INTEGRATIONS_ENABLED) return res.status(503).json(POS_503);
  try {
    await col('restaurant_integrations').deleteOne({
      restaurant_id: req.restaurantId,
      platform: req.params.platform,
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// triggerSync and upsertMenu are now in ../services/posSync.js
// Kept as comment for reference — the actual functions are imported at the top.
/* ── MOVED TO posSync.js ──
async function triggerSync(platform, integrationId, restaurantId, syncMode = 'incremental') {
  await col('restaurant_integrations').updateOne(
    { _id: integrationId },
    { $set: { sync_status: 'syncing', sync_error: null, updated_at: new Date() } }
  );

  try {
    const integration = await col('restaurant_integrations').findOne({ _id: integrationId });
    const svc = SERVICES[platform];
    if (!svc) throw new Error('No service handler for: ' + platform);
    const branchId = integration.branch_id;

    console.log(`[POS-Sync] Starting ${syncMode} sync for ${platform} → branch ${branchId}`);

    const pulled = await svc.fetchMenu(integration);
    const result = await upsertMenu(branchId, platform, pulled, syncMode);

    const now = new Date();
    await col('restaurant_integrations').updateOne(
      { _id: integrationId },
      { $set: {
        sync_status   : 'success',
        last_synced_at: now,
        item_count    : result.total_items,
        last_sync_result: {
          inserted: result.inserted,
          updated: result.updated,
          unchanged: result.unchanged,
          deactivated: result.deactivated,
          variants_created: result.variants_created,
          total_items: result.total_items,
          pos_items: result.pos_items,
          tag_summary: result.tag_summary,
          synced_at: now,
        },
        sync_error    : null,
        updated_at    : now,
      }}
    );

    logActivity({
      actorType: 'system', action: 'integration.menu_synced', category: 'settings',
      description: `${platform} menu sync: ${result.inserted} added, ${result.updated} updated, ${result.variants_created} variants`,
      restaurantId, metadata: { platform, ...result },
    });

    // Fire-and-forget: re-host POS images to S3 CDN
    const imgSvc = require('../services/imageUpload');
    const posItems = await col('menu_items').find({
      branch_id: branchId, pos_platform: platform, image_url: { $ne: null },
    }).toArray();
    imgSvc.rehostPosImages(posItems, branchId, restaurantId).catch(err =>
      console.error('[POS-Sync] Image re-hosting error:', err.message)
    );

    // Fire-and-forget catalog chain: catalog push → product sets → collections
    const catalog = require('../services/catalog');
    const isFirstSync = result.inserted > 0 && result.updated === 0 && result.unchanged === 0;

    catalog.syncBranchCatalog(branchId)
      .then(async () => {
        if (isFirstSync) {
          console.log(`[POS-Sync] First sync detected — auto-creating product sets & collections`);
          await catalog.autoCreateProductSets(branchId);
          await catalog.autoCreateCollections(branchId);
        }
      })
      .catch(err => console.error('[POS-Sync] Catalog sync failed after POS pull:', err.message));

    return { success: true, platform, ...result, catalog_synced: true };

  } catch (err) {
    await col('restaurant_integrations').updateOne(
      { _id: integrationId },
      { $set: { sync_status: 'error', sync_error: err.message, updated_at: new Date() } }
    );
    console.error(`[POS-Sync] ${platform} sync failed:`, err.message);
    throw err;
  }
}

// ─── UPSERT MENU: categories then items (incremental or full replace) ──
async function upsertMenu(branchId, platform, { categories, items }, syncMode) {
  const now = new Date();

  // ── Upsert categories, build name → _id map ─────────────
  const catMap = {};
  for (const cat of categories) {
    const existing = await col('menu_categories').findOneAndUpdate(
      { branch_id: branchId, name: cat.name },
      { $set: { sort_order: cat.sort_order || 0, updated_at: now }, $setOnInsert: { _id: newId(), branch_id: branchId, name: cat.name, created_at: now } },
      { upsert: true, returnDocument: 'after' }
    );
    catMap[cat.name] = existing._id;
  }

  // ── Full replace mode: deactivate all POS items before reimport ──
  if (syncMode === 'full_replace') {
    await col('menu_items').updateMany(
      { branch_id: branchId, pos_platform: platform },
      { $set: { is_available: false, updated_at: now } }
    );
  }

  // ── Track which retailer_ids we see in this sync ─────────
  const seenRetailerIds = new Set();
  const tagCounts = {};

  let inserted = 0, updated = 0, unchanged = 0, variantsCreated = 0;

  for (const item of items) {
    const categoryId = catMap[item.category] || null;
    seenRetailerIds.add(item.retailer_id);

    // Count tags for summary
    if (item.product_tags && item.product_tags[1]) {
      const tag = item.product_tags[1];
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }

    if (item.item_group_id) variantsCreated++;

    // Look up existing by retailer_id + branch (deterministic key)
    const existing = await col('menu_items').findOne({
      branch_id: branchId,
      retailer_id: item.retailer_id,
    });

    if (existing) {
      // Check if anything actually changed (only update POS-controlled fields)
      const changed =
        existing.name !== item.name ||
        existing.price_paise !== item.price_paise ||
        existing.is_available !== item.is_available ||
        existing.description !== item.description ||
        (item.image_url && existing.image_url !== item.image_url);

      if (changed) {
        const $set = {
          name         : item.name,
          price_paise  : item.price_paise,
          is_available : item.is_available,
          description  : item.description,
          pos_synced_at: now,
          catalog_sync_status: 'pending',
          updated_at   : now,
        };
        // Only overwrite image if POS provides one
        if (item.image_url) $set.image_url = item.image_url;
        // Only set product_tags / Meta fields if not manually overridden
        if (!existing._manual_tags) $set.product_tags = item.product_tags;
        if (!existing._manual_meta) {
          $set.item_group_id = item.item_group_id;
          $set.size = item.size;
          $set.google_product_category = item.google_product_category;
          $set.fb_product_category = item.fb_product_category;
        }

        await col('menu_items').updateOne({ _id: existing._id }, { $set });
        updated++;
      } else {
        // Touch pos_synced_at even if nothing changed
        await col('menu_items').updateOne(
          { _id: existing._id },
          { $set: { pos_synced_at: now } }
        );
        unchanged++;
      }
    } else {
      // New item — insert with full Meta-ready schema
      const restaurantId = (await col('branches').findOne({ _id: branchId }))?.restaurant_id || null;
      const doc = {
        _id          : newId(),
        branch_id    : branchId,
        restaurant_id: restaurantId,
        // Core fields
        name         : item.name,
        description  : item.description || '',
        price_paise  : item.price_paise,
        is_available : item.is_available,
        image_url    : item.image_url || null,
        food_type    : item.food_type || 'veg',
        category_id  : categoryId,
        // POS tracking
        pos_item_id  : item.pos_item_id,
        pos_platform : item.pos_platform || platform,
        pos_synced_at: now,
        // Meta catalog fields
        retailer_id  : item.retailer_id,
        item_group_id: item.item_group_id || null,
        size         : item.size || null,
        product_tags : item.product_tags || [],
        google_product_category: item.google_product_category || 'Food, Beverages & Tobacco > Food Items',
        fb_product_category    : item.fb_product_category || 'Food & Beverages > Prepared Food',
        brand        : item.brand || null,
        sale_price_paise: item.sale_price_paise || null,
        condition    : item.condition || 'new',
        quantity_to_sell_on_facebook: item.quantity_to_sell_on_facebook || null,
        // Sync status
        catalog_sync_status: 'pending',
        // Timestamps
        created_at   : now,
        updated_at   : now,
      };
      await col('menu_items').insertOne(doc);
      inserted++;
    }
  }

  // ── Detect deleted items: POS items from this platform not in the current pull ──
  let deactivated = 0;
  if (syncMode === 'incremental') {
    const staleItems = await col('menu_items').find({
      branch_id: branchId,
      pos_platform: platform,
      is_available: true,
      retailer_id: { $nin: [...seenRetailerIds] },
    }).toArray();

    if (staleItems.length > 0) {
      const staleIds = staleItems.map(i => i._id);
      await col('menu_items').updateMany(
        { _id: { $in: staleIds } },
        { $set: { is_available: false, updated_at: now, catalog_sync_status: 'pending' } }
      );
      deactivated = staleItems.length;
      console.log(`[POS-Sync] Deactivated ${deactivated} stale items from ${platform}`);
    }
  }

  // Build tag summary for UI display
  const tagSummary = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count }));

  console.log(`[POS-Sync] ${platform}: inserted=${inserted}, updated=${updated}, unchanged=${unchanged}, deactivated=${deactivated}, variants=${variantsCreated}`);

  return {
    inserted,
    updated,
    unchanged,
    deactivated,
    variants_created: variantsCreated,
    total_items: items.length,
    pos_items: items.length - variantsCreated + new Set(items.filter(i => i.item_group_id).map(i => i.item_group_id)).size,
    tag_summary: tagSummary,
  };
}
── END MOVED TO posSync.js ── */

module.exports = router;
