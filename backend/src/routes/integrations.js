// src/routes/integrations.js
// POS / Delivery platform integrations for restaurants
// Supports: PetPooja, UrbanPiper, DotPe
// Menu sync: POS → menu_items (full Meta-ready schema) → Meta catalog

const express = require('express');
const router  = express.Router();
const { col, newId } = require('../config/database');
const { requireAuth } = require('./auth');
const { logActivity } = require('../services/activityLog');
const { POS_INTEGRATIONS_ENABLED } = require('../config/features');
const { triggerSync, upsertMenu, SERVICES } = require('../services/posSync');
const log = require('../utils/logger').child({ component: 'integrations' });

router.use(requireAuth);

const POS_503 = { error: 'POS integrations are currently disabled. Set ENABLE_POS_INTEGRATIONS=true to activate.', feature: 'pos_integrations', status: 'disabled' };

// Restaurant-facing integration view. Credentials are intentionally
// NOT included — only operational status the dashboard needs.
function toIntegrationView(doc, branchName) {
  return {
    platform        : doc.platform,
    branch_id       : doc.branch_id || null,
    branch_name     : branchName || null,
    outlet_id       : doc.outlet_id || null,
    is_active       : !!doc.is_active,
    sync_status     : doc.sync_status || 'idle',
    last_synced_at  : doc.last_synced_at || null,
    last_sync_result: doc.last_sync_result || null,
    item_count      : doc.item_count || 0,
    created_at      : doc.created_at || null,
  };
}

// ─── GET /api/restaurant/integrations ─────────────────────────
// List all integrations for the authed restaurant's branches.
router.get('/', async (req, res, next) => {
  try {
    const docs = await col('restaurant_integrations')
      .find({ restaurant_id: req.restaurantId })
      .sort({ platform: 1 })
      .toArray();

    const branchIds = [...new Set(docs.map(d => d.branch_id).filter(Boolean))];
    const branches = branchIds.length
      ? await col('branches')
          .find({ _id: { $in: branchIds }, restaurant_id: req.restaurantId })
          .toArray()
      : [];
    const branchName = Object.fromEntries(branches.map(b => [String(b._id), b.name]));

    res.json(docs.map(d => toIntegrationView(d, branchName[String(d.branch_id)])));
  } catch (e) { return next(e); }
});

// ═══════════════════════════════════════════════════════════
// PER-BRANCH ROUTES — restaurant-facing, branch-scoped.
// Keyed by (restaurant_id, platform, branch_id) so a restaurant can
// run the same POS independently across multiple branches. Defined
// AFTER /:platform/variants so that literal route is not shadowed by
// the /:platform/:branchId param route.
// ═══════════════════════════════════════════════════════════

// Resolve + authorize the branch against the authed restaurant.
// Sends the error response and returns null when the caller must stop.
async function _authBranch(req, res, branchId) {
  if (!branchId) { res.status(400).json({ error: 'branchId is required' }); return null; }
  const branch = await col('branches').findOne({ _id: branchId, restaurant_id: req.restaurantId });
  if (!branch) { res.status(403).json({ error: 'Branch not found for this restaurant' }); return null; }
  return branch;
}

// Fire-and-forget refresh of Petpooja's per-restaurant Custom
// Configuration (packaging charges) onto the integration row's
// pos_config. STRICTLY NON-FATAL: every failure path is swallowed so
// it can never block or break connect/sync. fetchRestaurantConfig is
// itself non-throwing (returns null on any error); we still guard with
// .catch(()=>{}) and a try/catch for total isolation. Re-fetched on
// both connect and sync because the config can change over time.
function _refreshPetpoojaConfig(restaurantId, platform, branchId, outletId) {
  try {
    if (!outletId) return;
    // Lazy require — same defensive style this file uses for
    // imageUpload/catalog so a load issue can't break route wiring.
    const petpooja = require('../services/integrations/petpooja');
    Promise.resolve()
      .then(() => petpooja.fetchRestaurantConfig(outletId))
      .then((result) => {
        if (!result) return; // null = fetch failed / disabled — keep existing behavior
        // Reuse the SAME collection + filter every other handler in
        // this file uses to locate the integration row.
        return col('restaurant_integrations').updateOne(
          { restaurant_id: restaurantId, platform, branch_id: branchId },
          { $set: { pos_config: result, updated_at: new Date() } },
        );
      })
      .catch(() => {});
  } catch (_e) { /* never throw — non-fatal */ }
}

// ─── GET /:platform/:branchId — integration for one branch ────
router.get('/:platform/:branchId', async (req, res, next) => {
  const { platform, branchId } = req.params;
  try {
    const branch = await _authBranch(req, res, branchId);
    if (!branch) return;

    const doc = await col('restaurant_integrations').findOne({
      restaurant_id: req.restaurantId, platform, branch_id: branchId,
    });
    if (!doc) return res.status(404).json({ error: 'Integration not configured for this branch' });

    res.json(toIntegrationView(doc, branch.name));
  } catch (e) { return next(e); }
});

// ─── POST /:platform/:branchId — upsert credentials ───────────
router.post('/:platform/:branchId', async (req, res, next) => {
  if (!POS_INTEGRATIONS_ENABLED) return res.status(503).json(POS_503);
  const { platform, branchId } = req.params;
  if (!SERVICES[platform]) return res.status(400).json({ error: 'Unknown platform' });

  try {
    const branch = await _authBranch(req, res, branchId);
    if (!branch) return;

    // Partner credentials (app_key/app_secret/access_token) now come from
    // the environment — only outlet_id is per-branch and accepted here.
    const { outlet_id } = req.body || {};
    const now = new Date();
    const existing = await col('restaurant_integrations').findOne({
      restaurant_id: req.restaurantId, platform, branch_id: branchId,
    });

    if (existing) {
      const $set = { updated_at: now };
      if (outlet_id    != null) $set.outlet_id    = outlet_id;
      await col('restaurant_integrations').updateOne({ _id: existing._id }, { $set });
      // Fire-and-forget: refresh Petpooja per-restaurant Custom
      // Configuration (packaging charges) onto pos_config. NON-FATAL —
      // a failed fetch must never block/break the connect response.
      if (platform === 'petpooja') {
        _refreshPetpoojaConfig(req.restaurantId, platform, branchId, outlet_id != null ? outlet_id : existing.outlet_id);
      }
      return res.json({ success: true, integration: toIntegrationView({ ...existing, ...$set }, branch.name) });
    }

    const doc = {
      _id           : newId(),
      restaurant_id : req.restaurantId,
      platform,
      branch_id     : branchId,
      outlet_id     : outlet_id    || null,
      // Restaurant explicitly entered credentials → activate on insert.
      // The update path above intentionally omits is_active so a
      // re-save preserves the existing value (no toggle-off).
      is_active     : true,
      sync_status   : 'idle',
      sync_error    : null,
      last_synced_at: null,
      item_count    : 0,
      last_sync_result : null,
      created_at    : now,
      updated_at    : now,
    };
    await col('restaurant_integrations').insertOne(doc);
    // Fire-and-forget: pull Petpooja per-restaurant Custom Configuration
    // (packaging charges) onto pos_config. NON-FATAL — must never block
    // or break the connect response if the fetch fails.
    if (platform === 'petpooja') {
      _refreshPetpoojaConfig(req.restaurantId, platform, branchId, doc.outlet_id);
    }
    res.json({ success: true, integration: toIntegrationView(doc, branch.name) });
  } catch (e) { return next(e); }
});

// ─── DELETE /:platform/:branchId — disconnect/disable ─────────
// Soft disable (is_active:false) so the credential row survives for
// re-activation and audit — mirrors the admin route's philosophy.
router.delete('/:platform/:branchId', async (req, res, next) => {
  if (!POS_INTEGRATIONS_ENABLED) return res.status(503).json(POS_503);
  const { platform, branchId } = req.params;
  try {
    const branch = await _authBranch(req, res, branchId);
    if (!branch) return;

    const r = await col('restaurant_integrations').updateOne(
      { restaurant_id: req.restaurantId, platform, branch_id: branchId },
      { $set: { is_active: false, sync_status: 'idle', updated_at: new Date() } },
    );
    if (!r.matchedCount) return res.status(404).json({ error: 'Integration not configured for this branch' });
    res.json({ success: true });
  } catch (e) { return next(e); }
});

// ─── POST /:platform/:branchId/sync — manual menu sync ────────
router.post('/:platform/:branchId/sync', async (req, res, next) => {
  if (!POS_INTEGRATIONS_ENABLED) return res.status(503).json(POS_503);
  const { platform, branchId } = req.params;
  const syncMode = req.body?.syncMode || 'incremental';
  if (!SERVICES[platform]) return res.status(400).json({ error: 'Unknown platform' });

  try {
    const branch = await _authBranch(req, res, branchId);
    if (!branch) return;

    const integration = await col('restaurant_integrations').findOne({
      restaurant_id: req.restaurantId, platform, branch_id: branchId,
    });
    if (!integration) return res.status(404).json({ error: 'Integration not configured for this branch' });
    if (!integration.is_active) return res.status(400).json({ error: 'Integration is disabled' });

    // Fire-and-forget: re-pull Petpooja Custom Configuration on every
    // manual sync — packaging charges can change over time. NON-FATAL,
    // must never block or fail the sync response.
    if (platform === 'petpooja') {
      _refreshPetpoojaConfig(req.restaurantId, platform, branchId, integration.outlet_id);
      // Petpooja's fetch-menu API is NOT available in production — only
      // Push Menu (their dashboard "Menu Trigger" webhook) syncs the
      // menu. Sync Now therefore only refreshes pos_config (the
      // fire-and-forget above) and points the operator at Menu Trigger;
      // it must NOT call triggerSync → fetchMenu (unsupported by
      // Petpooja). urbanpiper/dotpe are unaffected — they fall through.
      return res.json({
        success: true,
        message: 'Use Menu Trigger in your Petpooja dashboard to sync menu changes to GullyBite.',
      });
    }

    const result = await triggerSync(platform, integration._id, req.restaurantId, syncMode);
    res.json(result);
  } catch (e) { return next(e); }
});

// ─── PATCH /:platform/:branchId/toggle — flip is_active ───────
// Branch-scoped equivalent of the legacy PATCH /:platform/toggle.
// Accepts an explicit { isActive } in the body; when omitted, flips
// the current value. Activating fires a fire-and-forget incremental
// sync so the menu pulls in immediately (matches legacy behavior).
router.patch('/:platform/:branchId/toggle', async (req, res, next) => {
  if (!POS_INTEGRATIONS_ENABLED) return res.status(503).json(POS_503);
  const { platform, branchId } = req.params;

  try {
    const branch = await _authBranch(req, res, branchId);
    if (!branch) return;

    const existing = await col('restaurant_integrations').findOne({
      restaurant_id: req.restaurantId, platform, branch_id: branchId,
    });
    if (!existing) return res.status(404).json({ error: 'Integration not configured for this branch' });

    const nextActive = typeof req.body?.isActive === 'boolean'
      ? req.body.isActive
      : !existing.is_active;

    const integration = await col('restaurant_integrations').findOneAndUpdate(
      { _id: existing._id },
      { $set: { is_active: nextActive, updated_at: new Date() } },
      { returnDocument: 'after' },
    );

    if (nextActive) {
      triggerSync(platform, integration._id, req.restaurantId, 'incremental').catch(() => {});
    }

    res.json({ success: true, isActive: integration.is_active });
  } catch (e) { return next(e); }
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

    log.info({ syncMode, platform, branchId }, 'starting POS sync');

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
      log.error({ err }, 'image re-hosting error')
    );

    // Fire-and-forget catalog chain: catalog push → product sets → collections
    const catalog = require('../services/catalog');
    const isFirstSync = result.inserted > 0 && result.updated === 0 && result.unchanged === 0;

    catalog.syncBranchCatalog(branchId)
      .then(async () => {
        if (isFirstSync) {
          log.info({ branchId }, 'first sync detected — auto-creating product sets & collections');
          await catalog.autoCreateProductSets(branchId);
          await catalog.autoCreateCollections(branchId);
        }
      })
      .catch(err => log.error({ err }, 'catalog sync failed after POS pull'));

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
      log.info({ deactivated, platform }, 'deactivated stale POS items');
    }
  }

  // Build tag summary for UI display
  const tagSummary = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count }));

  log.info({ platform, inserted, updated, unchanged, deactivated, variants: variantsCreated }, 'POS sync complete');

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
