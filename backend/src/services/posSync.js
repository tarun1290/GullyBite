// src/services/posSync.js
// Shared POS sync functions — used by integration routes, webhook handler, and cron job

const { col, newId } = require('../config/database');
const { logActivity } = require('./activityLog');
const memcache = require('../config/memcache');
const log = require('../utils/logger').child({ component: 'POSSync' });

const petpooja   = require('./integrations/petpooja');
const urbanpiper = require('./integrations/urbanpiper');
const dotpe      = require('./integrations/dotpe');

const SERVICES = { petpooja, urbanpiper, dotpe };

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

    log.info({ platform, branchId, syncMode }, 'Starting POS sync');

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
          inserted: result.inserted, updated: result.updated, unchanged: result.unchanged,
          deactivated: result.deactivated, variants_created: result.variants_created,
          total_items: result.total_items, pos_items: result.pos_items,
          tag_summary: result.tag_summary, synced_at: now,
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
    const imgSvc = require('./imageUpload');
    const posItems = await col('menu_items').find({
      branch_id: branchId, pos_platform: platform, image_url: { $ne: null },
    }).toArray();
    imgSvc.rehostPosImages(posItems, branchId, restaurantId).catch(err =>
      log.error({ err }, 'Image re-hosting error')
    );

    // Fire-and-forget catalog chain: catalog push → product sets → collections
    const catalog = require('./catalog');
    const isFirstSync = result.inserted > 0 && result.updated === 0 && result.unchanged === 0;

    catalog.syncBranchCatalog(branchId)
      .then(async () => {
        // Clear MPM cache after catalog sync
        memcache.del(`branch:${branchId}:menu`);
        log.info({ branchId }, 'Cleared MPM cache');
        if (isFirstSync) {
          log.info({ branchId }, 'First sync detected — auto-creating product sets & collections');
          await catalog.autoCreateProductSets(branchId);
          await catalog.autoCreateCollections(branchId);
        }
      })
      .catch(err => log.error({ err }, 'Catalog sync failed after POS pull'));

    return { success: true, platform, ...result, catalog_synced: true };

  } catch (err) {
    await col('restaurant_integrations').updateOne(
      { _id: integrationId },
      { $set: { sync_status: 'error', sync_error: err.message, updated_at: new Date() } }
    );
    log.error({ err, platform }, 'POS sync failed');
    throw err;
  }
}

async function upsertMenu(branchId, platform, { categories, items }, syncMode) {
  const now = new Date();

  const catMap = {};
  for (const cat of categories) {
    const existing = await col('menu_categories').findOneAndUpdate(
      { branch_id: branchId, name: cat.name },
      { $set: { sort_order: cat.sort_order || 0, updated_at: now }, $setOnInsert: { _id: newId(), branch_id: branchId, name: cat.name, created_at: now } },
      { upsert: true, returnDocument: 'after' }
    );
    catMap[cat.name] = existing._id;
  }

  if (syncMode === 'full_replace') {
    await col('menu_items').updateMany(
      { branch_id: branchId, pos_platform: platform },
      { $set: { is_available: false, updated_at: now } }
    );
  }

  const seenRetailerIds = new Set();
  const tagCounts = {};
  let inserted = 0, updated = 0, unchanged = 0, variantsCreated = 0;

  for (const item of items) {
    const categoryId = catMap[item.category] || null;
    seenRetailerIds.add(item.retailer_id);
    if (item.product_tags && item.product_tags[1]) { tagCounts[item.product_tags[1]] = (tagCounts[item.product_tags[1]] || 0) + 1; }
    if (item.item_group_id) variantsCreated++;

    const existing = await col('menu_items').findOne({ branch_id: branchId, retailer_id: item.retailer_id });

    if (existing) {
      const changed = existing.name !== item.name || existing.price_paise !== item.price_paise ||
        existing.is_available !== item.is_available || existing.description !== item.description ||
        (item.image_url && existing.image_url !== item.image_url);

      if (changed) {
        const $set = { name: item.name, price_paise: item.price_paise, is_available: item.is_available, description: item.description, pos_synced_at: now, catalog_sync_status: 'pending', updated_at: now };
        if (item.image_url) $set.image_url = item.image_url;
        if (!existing._manual_tags) $set.product_tags = item.product_tags;
        if (!existing._manual_meta) { $set.item_group_id = item.item_group_id; $set.size = item.size; $set.google_product_category = item.google_product_category; $set.fb_product_category = item.fb_product_category; }
        await col('menu_items').updateOne({ _id: existing._id }, { $set });
        updated++;
      } else {
        await col('menu_items').updateOne({ _id: existing._id }, { $set: { pos_synced_at: now } });
        unchanged++;
      }
    } else {
      const restaurantId = (await col('branches').findOne({ _id: branchId }))?.restaurant_id || null;
      await col('menu_items').insertOne({
        _id: newId(), branch_id: branchId, restaurant_id: restaurantId,
        name: item.name, description: item.description || '', price_paise: item.price_paise,
        is_available: item.is_available, image_url: item.image_url || null,
        food_type: item.food_type || 'veg', category_id: categoryId,
        pos_item_id: item.pos_item_id, pos_platform: item.pos_platform || platform, pos_synced_at: now,
        retailer_id: item.retailer_id, item_group_id: item.item_group_id || null, size: item.size || null,
        product_tags: item.product_tags || [],
        google_product_category: item.google_product_category || 'Food, Beverages & Tobacco > Food Items',
        fb_product_category: item.fb_product_category || 'Food & Beverages > Prepared Food',
        brand: item.brand || null, sale_price_paise: item.sale_price_paise || null,
        condition: item.condition || 'new', quantity_to_sell_on_facebook: item.quantity_to_sell_on_facebook || null,
        catalog_sync_status: 'pending', created_at: now, updated_at: now,
      });
      inserted++;
    }
  }

  let deactivated = 0;
  if (syncMode === 'incremental') {
    const staleItems = await col('menu_items').find({
      branch_id: branchId, pos_platform: platform, is_available: true,
      retailer_id: { $nin: [...seenRetailerIds] },
    }).toArray();
    if (staleItems.length) {
      await col('menu_items').updateMany(
        { _id: { $in: staleItems.map(i => i._id) } },
        { $set: { is_available: false, updated_at: now, catalog_sync_status: 'pending' } }
      );
      deactivated = staleItems.length;
      log.info({ deactivated, platform }, 'Deactivated stale items');
    }
  }

  const tagSummary = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count }));
  log.info({ platform, inserted, updated, unchanged, deactivated, variants: variantsCreated }, 'Upsert complete');

  return {
    inserted, updated, unchanged, deactivated, variants_created: variantsCreated,
    total_items: items.length,
    pos_items: items.length - variantsCreated + new Set(items.filter(i => i.item_group_id).map(i => i.item_group_id)).size,
    tag_summary: tagSummary,
  };
}

module.exports = { triggerSync, upsertMenu, SERVICES };
