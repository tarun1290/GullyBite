// src/routes/restaurant.js
// REST API for the restaurant owner dashboard
// Protected by JWT — all routes require login

const express = require('express');
const router = express.Router();
const multer = require('multer');
const axios  = require('axios');
const { col, newId, mapId, mapIds } = require('../config/database');
const { maskPhone } = require('../utils/maskPhone');
const { requireAuth, requireApproved, requirePermission, ROLE_PERMISSIONS } = require('./auth');
const { rateLimitFn } = require('../middleware/rateLimit');
const catalog = require('../services/catalog');
const { queueSync } = require('../services/catalogSyncQueue');
const orderSvc = require('../services/order');
const wa = require('../services/whatsapp');
const etaSvc = require('../services/eta');
const notify = require('../services/notify');
const orderNotify = require('../services/orderNotify');
const { logActivity: log } = require('../services/activityLog');
const issueSvc = require('../services/issues');
const financials = require('../services/financials');
const imgSvc = require('../services/imageUpload');
const ws = require('../services/websocket');
const memcache = require('../config/memcache');
const metaConfig = require('../config/meta');
const { getCached, invalidateCache } = require('../config/cache');
const { CONFIRMED_ORDER_STATES } = require('../core/orderStateEngine');
const customerSvc = require('../services/customer.service');
const logger = require('../utils/logger').child({ component: 'restaurant' });

// ── CSV input guards (shared across CSV import handlers) ─────
// Cap any free-text field that ends up in MongoDB at 255 chars. This
// stops a runaway document from a malformed CSV row and keeps index
// keys within Mongo's 1024-byte limit.
const MAX_CSV_STRING = 255;
function sanitizeCsvString(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, MAX_CSV_STRING);
}
// Validate a CSV phone field: digit-strip, then require 8–15 digits
// (E.164-ish bounds; covers Indian + international). Returns the
// normalised digit string or null if the input can't be salvaged.
function sanitizeCsvPhone(v) {
  if (v == null) return null;
  const digits = customerSvc.normalizePhone(v); // strips non-digits, returns null if empty
  if (!digits) return null;
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

// ── Slug helper ──────────────────────────────────────────────
const slugify = require('../utils/slugify');

// Get or generate branch_slug for a branch
async function getBranchSlug(branchId) {
  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch) return 'branch';
  if (branch.branch_slug) return branch.branch_slug;
  const slug = slugify(branch.name, 20) || branchId.slice(0, 8);
  await col('branches').updateOne({ _id: branchId }, { $set: { branch_slug: slug } });
  return slug;
}

// Generate branch-encoded retailer_id
function makeRetailerId(branchSlug, name, size) {
  const itemSlug = slugify(name, 40);
  if (size) {
    const sizeSlug = slugify(size, 15);
    return `${branchSlug}-${itemSlug}-${sizeSlug}`;
  }
  return `${branchSlug}-${itemSlug}`;
}

// Generate item_group_id for variants (all sizes of same item share this)
function makeItemGroupId(branchSlug, name) {
  return `${branchSlug}-${slugify(name, 40)}`;
}

// ── Image upload via S3 + CloudFront ─────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits : { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter(req, file, cb) {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype);
    cb(ok ? null : new Error('Only JPEG, PNG, WebP or GIF images are allowed'), ok);
  },
});

// ─── PUBLIC ROUTES ───────────────────────────────────────────
// Defined BEFORE router.use(requireAuth) so they remain unauthenticated.
// Used by the Next.js /store/[slug] ISR page; mirrors the JSON shape the
// EC2 inline /store/:slug HTML route reads, plus a computed display_name.
router.get('/public/store/:slug', express.json(), async (req, res) => {
  try {
    const slug = String(req.params.slug || '').trim();
    if (!slug) return res.status(404).json({ error: 'Store not found' });
    const restaurant = await col('restaurants').findOne(
      { store_slug: slug, approval_status: 'approved' },
      { projection: {
        business_name: 1, brand_name: 1, city: 1, restaurant_type: 1,
        logo_url: 1, store_url: 1, store_slug: 1, phone: 1,
      } },
    );
    if (!restaurant) return res.status(404).json({ error: 'Store not found' });
    const display_name = restaurant.brand_name || restaurant.business_name;
    res.json({
      business_name:   restaurant.business_name || null,
      brand_name:      restaurant.brand_name || null,
      city:            restaurant.city || null,
      restaurant_type: restaurant.restaurant_type || null,
      logo_url:        restaurant.logo_url || null,
      store_url:       restaurant.store_url || null,
      store_slug:      restaurant.store_slug || null,
      phone:           restaurant.phone || null,
      display_name,
    });
  } catch (err) {
    req.log?.error?.({ err }, 'public store lookup failed');
    res.status(500).json({ error: 'Failed to load store' });
  }
});

// All routes below require authentication. Most use the standard
// restaurant JWT (requireAuth). Two endpoints — /orders/:id/accept and
// /orders/:id/decline — additionally accept a per-user staff JWT via
// requireStaffOrRestaurantAuth. The combined middleware mirrors the
// req.userPermissions / req.restaurantId / req.userBranchIds shape so
// downstream requireApproved + requirePermission + audit log helpers
// work uniformly across token types.
const { requireStaffOrRestaurantAuth } = require('../middleware/staffAuth');
const _staffOrOwner = requireStaffOrRestaurantAuth(requireAuth);
router.use((req, res, next) => {
  // Accept BOTH token types on shared accept/decline endpoints — owner
  // managing from the dashboard, staff acting on a tablet.
  if (/^\/orders\/[^/]+\/(accept|decline)$/.test(req.path)) {
    return _staffOrOwner(req, res, next);
  }
  return requireAuth(req, res, next);
});

// ─── TENANT-OWNERSHIP HELPERS ────────────────────────────────
// These helpers are the SINGLE source of truth for "does this resource
// belong to the caller's restaurant?". Always 404 (never 403) on mismatch
// so attackers cannot probe whether an ID exists in another tenant.
//
// Pattern: at the top of any route that takes an ID from req.params or
// req.body, call the appropriate assertX helper. The helper returns the
// resource document on success or null on failure. Never trust an ID from
// the request body without one of these.
//
// See backend/tests/tenantIsolation.test.js for the regression suite that
// exercises every protected route.

/** Returns the branch doc IF it belongs to the restaurant, else null. */
async function _assertBranchOwnedBy(branchId, restaurantId) {
  if (!branchId || !restaurantId) return null;
  return col('branches').findOne({ _id: branchId, restaurant_id: restaurantId });
}

/** Returns the menu_item doc IF its branch belongs to the restaurant, else null.
 *  menu_items have BOTH restaurant_id AND branch_id fields, so we can filter
 *  in a single query — no join needed. */
async function _assertMenuItemOwnedBy(itemId, restaurantId) {
  if (!itemId || !restaurantId) return null;
  // Prefer the direct restaurant_id filter (faster, indexed). Fall back to
  // branch join for legacy menu_items rows that pre-date the restaurant_id
  // backfill — those exist if older onboarding flows didn't write the field.
  const direct = await col('menu_items').findOne({ _id: itemId, restaurant_id: restaurantId });
  if (direct) return direct;
  const item = await col('menu_items').findOne({ _id: itemId });
  if (!item || !item.branch_id) return null;
  const branch = await col('branches').findOne(
    { _id: item.branch_id, restaurant_id: restaurantId },
    { projection: { _id: 1 } }
  );
  return branch ? item : null;
}

/** Returns the menu_category doc IF its branch belongs to the restaurant, else null.
 *  menu_categories only have branch_id, so we always join through branches. */
async function _assertMenuCategoryOwnedBy(catId, restaurantId) {
  if (!catId || !restaurantId) return null;
  const cat = await col('menu_categories').findOne({ _id: catId });
  if (!cat || !cat.branch_id) return null;
  const branch = await _assertBranchOwnedBy(cat.branch_id, restaurantId);
  return branch ? cat : null;
}

/** Returns the whatsapp_account doc IF it belongs to the restaurant AND is a
 *  restaurant row (not a platform admin/directory row), else null.
 *  Critical: never return another tenant's WhatsApp account because the doc
 *  contains the access_token field. Also never return a platform admin row
 *  even if a future code path accidentally writes one with restaurant_id set. */
async function _assertWhatsappAccountOwnedBy(waAccountId, restaurantId) {
  if (!waAccountId || !restaurantId) return null;
  return col('whatsapp_accounts').findOne({
    _id: waAccountId,
    restaurant_id: restaurantId,
    $or: [{ account_type: 'restaurant' }, { account_type: { $exists: false } }],
  });
}

/** Returns the catalog_collection doc IF it belongs to the restaurant, else null. */
async function _assertCollectionOwnedBy(collectionId, restaurantId) {
  if (!collectionId || !restaurantId) return null;
  return col('catalog_collections').findOne({ _id: collectionId, restaurant_id: restaurantId });
}

/** Returns the restaurant_user doc IF it belongs to the restaurant, else null. */
async function _assertRestaurantUserOwnedBy(userId, restaurantId) {
  if (!userId || !restaurantId) return null;
  return col('restaurant_users').findOne({ _id: userId, restaurant_id: restaurantId });
}

// ── DIAGNOSTIC — catalog visibility troubleshooter ──────────
router.get('/catalog-diagnosis', async (req, res) => {
  const diagnosis = { timestamp: new Date().toISOString(), checks: {} };
  try {
    const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
    diagnosis.checks.restaurant = {
      exists: !!restaurant, meta_catalog_id: restaurant?.meta_catalog_id || null,
      meta_catalog_name: restaurant?.meta_catalog_name || null, meta_business_id: restaurant?.meta_business_id || null,
      meta_user_id: restaurant?.meta_user_id || null, approval_status: restaurant?.approval_status || null,
      whatsapp_connected: restaurant?.whatsapp_connected || null,
      meta_available_catalogs: restaurant?.meta_available_catalogs?.length || 0,
      catalog_fetched_at: restaurant?.catalog_fetched_at || null,
    };

    const wa_acc = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId, is_active: true });
    diagnosis.checks.whatsapp_account = {
      exists: !!wa_acc, waba_id: wa_acc?.waba_id || null, phone_number_id: wa_acc?.phone_number_id || null,
      catalog_id: wa_acc?.catalog_id || null, cart_enabled: wa_acc?.cart_enabled || false,
      phone_display: wa_acc?.phone_display || null,
    };

    const activeCatalogId = restaurant?.meta_catalog_id || wa_acc?.catalog_id || null;
    diagnosis.checks.derived = {
      activeCatalogId, has_waba_id: !!wa_acc?.waba_id, has_meta_user_id: !!restaurant?.meta_user_id,
      would_live_fetch: !!wa_acc?.waba_id || !!restaurant?.meta_user_id,
      env_META_BUSINESS_ID: !!process.env.META_BUSINESS_ID,
      env_META_SYSTEM_USER_TOKEN: !!process.env.META_SYSTEM_USER_TOKEN,
    };

    try {
      const tokenInfo = await metaConfig.verifyToken();
      diagnosis.checks.token = { valid: tokenInfo.valid, type: tokenInfo.type, scopes: tokenInfo.scopes, missingScopes: tokenInfo.missingScopes, unverified: tokenInfo.unverified || false };
    } catch (e) { diagnosis.checks.token = { valid: false, error: e.message }; }

    if (wa_acc?.waba_id) {
      try { const wc = await catalog.fetchWabaCatalogs(wa_acc.waba_id); diagnosis.checks.waba_catalogs = { count: wc.length, catalogs: wc.map(c => ({ id: c.id, name: c.name, product_count: c.product_count })) }; }
      catch (e) { diagnosis.checks.waba_catalogs = { error: e.message }; }
    } else { diagnosis.checks.waba_catalogs = { skipped: 'no waba_id' }; }

    const bizId = restaurant?.meta_business_id || process.env.META_BUSINESS_ID;
    if (bizId) {
      try { const bc = await catalog.fetchBusinessCatalogs(bizId); diagnosis.checks.business_catalogs = { business_id: bizId, count: bc.length, catalogs: bc.map(c => ({ id: c.id, name: c.name, product_count: c.product_count })) }; }
      catch (e) { diagnosis.checks.business_catalogs = { error: e.message }; }
    } else { diagnosis.checks.business_catalogs = { skipped: 'no business_id' }; }

    const branches = await col('branches').find({ restaurant_id: req.restaurantId }).toArray();
    diagnosis.checks.branches = branches.map(b => ({ id: b._id, name: b.name, catalog_id: b.catalog_id || null }));

    const issues = [];
    if (!restaurant?.meta_catalog_id && !wa_acc?.catalog_id) issues.push('NO_ACTIVE_CATALOG_ID');
    if (!wa_acc?.waba_id) issues.push('NO_WABA_ID');
    if (!process.env.META_SYSTEM_USER_TOKEN) issues.push('NO_TOKEN');
    if (!process.env.META_BUSINESS_ID && !restaurant?.meta_business_id) issues.push('NO_BUSINESS_ID');
    if (diagnosis.checks.waba_catalogs?.count === 0 && !diagnosis.checks.waba_catalogs?.skipped) issues.push('WABA_EMPTY');
    if (diagnosis.checks.token?.valid === false) issues.push('TOKEN_INVALID');
    if (diagnosis.checks.token?.missingScopes?.length) issues.push('MISSING_SCOPES: ' + diagnosis.checks.token.missingScopes.join(', '));
    diagnosis.issues = issues;
    diagnosis.issue_count = issues.length;

    res.json(diagnosis);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error", diagnosis }); }
});

// POST — auto-fix: link an existing catalog found on WABA/Business
router.post('/catalog-diagnosis/fix', async (req, res) => {
  try {
    const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
    const wa_acc = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId, is_active: true });
    if (restaurant?.meta_catalog_id) return res.json({ message: 'Catalog ID already set', catalog_id: restaurant.meta_catalog_id });

    // Try WABA catalogs first
    let found = null;
    if (wa_acc?.waba_id) {
      const wc = await catalog.fetchWabaCatalogs(wa_acc.waba_id);
      if (wc.length) found = wc[0];
    }
    // Fallback to business catalogs
    if (!found) {
      const bizId = restaurant?.meta_business_id || process.env.META_BUSINESS_ID;
      if (bizId) { const bc = await catalog.fetchBusinessCatalogs(bizId); if (bc.length) found = bc[0]; }
    }
    if (!found) return res.status(404).json({ error: 'No catalogs found on WABA or Business — create one from the dashboard' });

    await col('restaurants').updateOne({ _id: req.restaurantId }, { $set: { meta_catalog_id: found.id, meta_catalog_name: found.name, updated_at: new Date() } });
    if (wa_acc) await col('whatsapp_accounts').updateOne({ _id: wa_acc._id }, { $set: { catalog_id: found.id, catalog_linked: true, catalog_linked_at: new Date(), updated_at: new Date() } });
    await col('branches').updateMany({ restaurant_id: req.restaurantId }, { $set: { catalog_id: found.id, updated_at: new Date() } });

    req.log.info({ catalogId: found.id, catalogName: found.name, restaurantId: req.restaurantId }, 'Linked catalog to restaurant');
    res.json({ success: true, catalog_id: found.id, catalog_name: found.name });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ═══════════════════════════════════════════════════════════════
// RESTAURANT PROFILE
// ═══════════════════════════════════════════════════════════════

// GET /api/restaurant — Get my restaurant + stats
//
// waba_accounts shape MUST stay identical to the projection in
// backend/src/routes/auth.js /auth/me handler (~L1287). The Settings →
// WhatsApp card and other useRestaurant() consumers expect the same field
// set from both endpoints — change both together.
router.get('/', async (req, res) => {
  try {
    const data = await getCached(`restaurant:${req.restaurantId}:profile`, async () => {
      const r = await col('restaurants').findOne({ _id: req.restaurantId });
      if (!r) return null;
      const [branch_count, wa_count, waAccounts] = await Promise.all([
        col('branches').countDocuments({ restaurant_id: req.restaurantId }),
        col('whatsapp_accounts').countDocuments({ restaurant_id: req.restaurantId, is_active: true }),
        col('whatsapp_accounts')
          .find(
            { restaurant_id: req.restaurantId, is_active: true },
            { projection: {
                waba_id: 1, phone_number_id: 1, phone_display: 1, display_name: 1,
                quality_rating: 1, is_active: 1, phone_registered: 1,
                business_username: 1, username_status: 1, username_suggestions: 1,
                catalog_id: 1, created_at: 1,
            }},
          )
          .sort({ created_at: 1 })
          .toArray(),
      ]);
      const waba_accounts = waAccounts.map(w => ({
        waba_id: w.waba_id,
        phone_number_id: w.phone_number_id,
        phone_display: w.phone_display,
        display_name: w.display_name,
        quality_rating: w.quality_rating,
        is_active: w.is_active,
        phone_registered: w.phone_registered,
        business_username: w.business_username,
        username_status: w.username_status,
        username_suggestions: w.username_suggestions,
        catalog_id: w.catalog_id,
        // Back-compat aliases — match /auth/me. Remove when the design-token
        // rollout touches WhatsappSection.jsx (kept in sync with /auth/me).
        name: w.display_name,
        phone: w.phone_display,
      }));
      const out = mapId(r);
      delete out.meta_access_token;
      return { ...out, branch_count, wa_count, waba_accounts };
    }, 600);
    if (!data) return res.status(404).json({ error: 'Not found' });
    res.json(data);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// PUT /api/restaurant — Update profile
router.put('/', requirePermission('manage_settings'), async (req, res) => {
  try {
    const {
      businessName, registeredBusinessName, ownerName, phone, city,
      restaurantType, logoUrl, gstNumber, fssaiLicense, fssaiExpiry,
      bankName, bankAccountNumber, bankIfsc,
      menuGstMode, deliveryFeeCustomerPct, packagingChargeRs, packagingGstPct,
      notificationPhones, notificationSettings,
    } = req.body;

    const $set = {};
    if (businessName            != null) $set.business_name             = businessName;
    if (registeredBusinessName  != null) $set.registered_business_name  = registeredBusinessName;
    if (ownerName               != null) $set.owner_name                = ownerName;
    if (phone                   != null) $set.phone                     = phone;
    if (city                    != null) $set.city                      = city;
    if (restaurantType          != null) $set.restaurant_type           = restaurantType;
    if (logoUrl                 != null) $set.logo_url                  = logoUrl;
    if (gstNumber               != null) $set.gst_number                = gstNumber;
    if (fssaiLicense            != null) $set.fssai_license             = fssaiLicense;
    if (fssaiExpiry             != null) $set.fssai_expiry              = fssaiExpiry;
    if (bankName                != null) $set.bank_name                 = bankName;
    if (bankAccountNumber       != null) $set.bank_account_number       = bankAccountNumber;
    if (bankIfsc                != null) $set.bank_ifsc                 = bankIfsc;
    if (menuGstMode             != null) $set.menu_gst_mode             = menuGstMode;
    if (deliveryFeeCustomerPct  != null) $set.delivery_fee_customer_pct = parseInt(deliveryFeeCustomerPct, 10);
    if (packagingChargeRs       != null) $set.packaging_charge_rs       = parseFloat(packagingChargeRs);
    if (packagingGstPct         != null) $set.packaging_gst_pct         = parseFloat(packagingGstPct);
    if (notificationPhones     != null) $set.notification_phones       = Array.isArray(notificationPhones) ? notificationPhones.filter(Boolean) : [];
    if (notificationSettings   != null) $set.notification_settings     = notificationSettings;

    await col('restaurants').updateOne(
      { _id: req.restaurantId },
      [{ $set: { ...$set, onboarding_step: { $max: ['$onboarding_step', 2] } } }]
    );
    res.json({ success: true });

    log({ actorType: 'restaurant', actorId: String(req.restaurantId), actorName: req.restaurant?.business_name || req.body.businessName || 'Restaurant', action: 'settings.updated', category: 'settings', description: `Settings updated by ${req.restaurant?.business_name || 'restaurant'}`, restaurantId: String(req.restaurantId), severity: 'info' });
    invalidateCache(`restaurant:${req.restaurantId}:profile`);
    require('../config/memcache').del(`restaurant:${req.restaurantId}`);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/update-slug — Update store URL slug
router.post('/update-slug', requirePermission('manage_settings'), async (req, res) => {
  try {
    let slug = (req.body.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (!slug) return res.status(400).json({ error: 'Slug cannot be empty' });
    if (slug.length < 3) return res.status(400).json({ error: 'Slug must be at least 3 characters' });
    if (slug.length > 50) slug = slug.substring(0, 50);

    // Check uniqueness (excluding current restaurant)
    const existing = await col('restaurants').findOne({ store_slug: slug, _id: { $ne: req.restaurantId } });
    if (existing) return res.status(409).json({ error: `Slug "${slug}" is already taken. Try another.` });

    const storeUrl = `${process.env.BASE_URL}/store/${slug}`;
    await col('restaurants').updateOne(
      { _id: req.restaurantId },
      { $set: { store_slug: slug, store_url: storeUrl, updated_at: new Date() } }
    );
    req.log.info({ restaurantId: req.restaurantId, slug }, 'Store slug updated');
    res.json({ success: true, store_slug: slug, store_url: storeUrl });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

/* ═══ FUTURE FEATURE: GridFS Image Upload (Legacy) ═══
   Original image upload route using MongoDB GridFS.
   Replaced by S3 + CloudFront CDN pipeline (see imageUpload.js).
   Keep as reference for GridFS upload patterns.
   Requires: const { getBucket } = require('../config/database'); const { Readable } = require('stream');

   router.post('/menu/upload-image', upload.single('image'), async (req, res) => {
     if (!req.file) return res.status(400).json({ error: 'No image file received' });
     const ext      = req.file.mimetype.split('/')[1].replace('jpeg', 'jpg');
     const filename = `${req.restaurantId}-${Date.now()}.${ext}`;
     try {
       const bucket = getBucket();
       const uploadStream = bucket.openUploadStream(filename, {
         contentType: req.file.mimetype,
         metadata: { restaurantId: req.restaurantId },
       });
       await new Promise((resolve, reject) => {
         const readable = Readable.from(req.file.buffer);
         readable.pipe(uploadStream);
         uploadStream.on('finish', resolve);
         uploadStream.on('error', reject);
       });
       const fileId = String(uploadStream.id);
       const publicUrl = `${process.env.BASE_URL}/images/${fileId}`;
       res.json({ url: publicUrl });
     } catch (err) {
       console.error('[ImageUpload] GridFS error:', err.message);
       res.status(500).json({ error: 'Image upload failed: ' + err.message });
     }
   });
   ═══ END FUTURE FEATURE ═══ */

// ═══════════════════════════════════════════════════════════════
// IMAGE UPLOAD — S3 + CloudFront CDN (feature-flagged)
// ═══════════════════════════════════════════════════════════════
const IMAGE_503 = { error: 'Image upload is temporarily disabled. AWS infrastructure setup pending.', feature: 'image_pipeline', status: 'disabled' };

// POST /api/restaurant/menu/upload-image — single image upload
router.post('/menu/upload-image', upload.single('image'), async (req, res) => {
  if (!imgSvc.IMAGE_PIPELINE_ENABLED) return res.status(503).json(IMAGE_503);
  if (!req.file) return res.status(400).json({ error: 'No image file received' });

  try {
    const branchId = req.body?.branchId || req.query?.branchId || null;
    const itemId = req.body?.itemId || req.query?.itemId || null;

    // [TENANT] Verify branch + item ownership BEFORE we touch S3 or the DB.
    // Without this an attacker could upload an image with a victim's
    // branchId/itemId and overwrite the victim's menu item's image_url.
    if (branchId) {
      const branch = await _assertBranchOwnedBy(branchId, req.restaurantId);
      if (!branch) return res.status(404).json({ error: 'Branch not found' });
    }
    let item = null;
    if (itemId) {
      item = await _assertMenuItemOwnedBy(itemId, req.restaurantId);
      if (!item) return res.status(404).json({ error: 'Menu item not found' });
      // Defence: if both were supplied, the item must belong to the supplied branch.
      if (branchId && item.branch_id !== branchId) {
        return res.status(404).json({ error: 'Menu item not found' });
      }
    }

    const result = await imgSvc.uploadImage(req.file.buffer, {
      restaurantId: req.restaurantId,
      branchId,
      itemId,
    });

    if (item) {
      await col('menu_items').updateOne(
        { _id: item._id },
        { $set: {
          image_url: result.url,
          thumbnail_url: result.thumbnail_url,
          image_s3_key: result.s3_key,
          thumbnail_s3_key: result.thumbnail_s3_key,
          image_source: 'uploaded',
          catalog_sync_status: 'pending',
          updated_at: new Date(),
        }}
      );
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, 'Image upload failed');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// POST /api/restaurant/images/bulk-upload — upload multiple images, auto-match to items
router.post('/images/bulk-upload', upload.array('images', 20), async (req, res) => {
  if (!imgSvc.IMAGE_PIPELINE_ENABLED) return res.status(503).json(IMAGE_503);
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No image files received' });
  const branchId = req.body?.branchId;
  if (!branchId) return res.status(400).json({ error: 'branchId is required' });

  try {
    // [TENANT] Verify branch ownership BEFORE listing menu items. Without this
    // an attacker could pass any branchId, list its items, and overwrite all
    // images on another restaurant's branch.
    const branch = await _assertBranchOwnedBy(branchId, req.restaurantId);
    if (!branch) return res.status(404).json({ error: 'Branch not found' });

    const items = await col('menu_items').find({ branch_id: branchId }).toArray();
    const results = [];
    let matched = 0, unmatched = 0;

    for (const file of req.files) {
      try {
        const result = await imgSvc.uploadImage(file.buffer, {
          restaurantId: req.restaurantId,
          branchId,
        });

        // Try to auto-match filename to a menu item
        const baseName = file.originalname.replace(/\.[^.]+$/, ''); // strip extension
        const slug = baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const matchItem = items.find(i =>
          i.retailer_id === baseName ||
          i.retailer_id === slug ||
          (i.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') === slug
        );

        if (matchItem) {
          await col('menu_items').updateOne(
            { _id: matchItem._id },
            { $set: {
              image_url: result.url,
              thumbnail_url: result.thumbnail_url,
              image_s3_key: result.s3_key,
              thumbnail_s3_key: result.thumbnail_s3_key,
              image_source: 'uploaded',
              catalog_sync_status: 'pending',
              updated_at: new Date(),
            }}
          );
          results.push({ filename: file.originalname, matched: true, item_name: matchItem.name, ...result });
          matched++;
        } else {
          results.push({ filename: file.originalname, matched: false, ...result });
          unmatched++;
        }
      } catch (err) {
        results.push({ filename: file.originalname, error: err.message });
      }
    }

    res.json({ uploaded: results.length, matched, unmatched, results });
  } catch (err) {
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// POST /api/restaurant/images/from-url — import image from external URL
router.post('/images/from-url', async (req, res) => {
  if (!imgSvc.IMAGE_PIPELINE_ENABLED) return res.status(503).json(IMAGE_503);
  const { sourceUrl, itemId, branchId } = req.body;
  if (!sourceUrl) return res.status(400).json({ error: 'sourceUrl is required' });

  try {
    // [TENANT] Verify branch + item ownership BEFORE fetching the URL or
    // touching S3, otherwise an attacker could overwrite another restaurant's
    // menu item image_url with a remote URL of their choice.
    if (branchId) {
      const branch = await _assertBranchOwnedBy(branchId, req.restaurantId);
      if (!branch) return res.status(404).json({ error: 'Branch not found' });
    }
    let item = null;
    if (itemId) {
      item = await _assertMenuItemOwnedBy(itemId, req.restaurantId);
      if (!item) return res.status(404).json({ error: 'Menu item not found' });
      if (branchId && item.branch_id !== branchId) {
        return res.status(404).json({ error: 'Menu item not found' });
      }
    }

    const result = await imgSvc.uploadImageFromUrl(sourceUrl, {
      restaurantId: req.restaurantId,
      branchId,
      itemId,
    });

    if (item) {
      await col('menu_items').updateOne(
        { _id: item._id },
        { $set: {
          image_url: result.url,
          thumbnail_url: result.thumbnail_url,
          image_s3_key: result.s3_key,
          thumbnail_s3_key: result.thumbnail_s3_key,
          image_source: 'uploaded',
          catalog_sync_status: 'pending',
          updated_at: new Date(),
        }}
      );
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// DELETE /api/restaurant/images/:itemId — remove image from a menu item
router.delete('/images/:itemId', async (req, res) => {
  if (!imgSvc.IMAGE_PIPELINE_ENABLED) return res.status(503).json(IMAGE_503);
  try {
    // [TENANT] Without this check any restaurant could delete any other
    // restaurant's S3 images by guessing item IDs.
    const item = await _assertMenuItemOwnedBy(req.params.itemId, req.restaurantId);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    // Delete from S3 (async, non-blocking)
    imgSvc.deleteImages([item.image_s3_key, item.thumbnail_s3_key]).catch(() => {});

    await col('menu_items').updateOne(
      { _id: item._id },
      { $set: {
        image_url: null,
        thumbnail_url: null,
        image_s3_key: null,
        thumbnail_s3_key: null,
        image_source: null,
        catalog_sync_status: 'pending',
        updated_at: new Date(),
      }}
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// POST /api/restaurant/images/logo — upload restaurant logo
router.post('/images/logo', upload.single('image'), async (req, res) => {
  if (!imgSvc.IMAGE_PIPELINE_ENABLED) return res.status(503).json(IMAGE_503);
  if (!req.file) return res.status(400).json({ error: 'No image file received' });

  try {
    // Delete old logo if exists
    const rest = await col('restaurants').findOne({ _id: req.restaurantId });
    if (rest?.logo_s3_key) imgSvc.deleteImage(rest.logo_s3_key).catch(() => {});

    const result = await imgSvc.uploadLogo(req.file.buffer, req.restaurantId);

    await col('restaurants').updateOne(
      { _id: req.restaurantId },
      { $set: { logo_url: result.url, logo_s3_key: result.s3_key, updated_at: new Date() } }
    );

    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// POST /api/restaurant/images/branch-photo — upload branch/storefront photo
router.post('/images/branch-photo', upload.single('image'), async (req, res) => {
  if (!imgSvc.IMAGE_PIPELINE_ENABLED) return res.status(503).json(IMAGE_503);
  if (!req.file) return res.status(400).json({ error: 'No image file received' });
  const branchId = req.body?.branchId;
  if (!branchId) return res.status(400).json({ error: 'branchId is required' });

  try {
    const branch = await col('branches').findOne({ _id: branchId, restaurant_id: req.restaurantId });
    if (!branch) return res.status(404).json({ error: 'Branch not found' });

    if (branch.photo_s3_key) imgSvc.deleteImage(branch.photo_s3_key).catch(() => {});

    const result = await imgSvc.uploadBranchPhoto(req.file.buffer, req.restaurantId, branchId);

    await col('branches').updateOne(
      { _id: branchId },
      { $set: { photo_url: result.url, photo_s3_key: result.s3_key, updated_at: new Date() } }
    );

    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// GET /api/restaurant/images/stats — image coverage stats for this restaurant
router.get('/images/stats', async (req, res) => {
  try {
    const branches = await col('branches').find({ restaurant_id: req.restaurantId }).project({ _id: 1 }).toArray();
    const branchIds = branches.map(b => String(b._id));

    const [total, withImage] = await Promise.all([
      col('menu_items').countDocuments({ branch_id: { $in: branchIds }, is_available: true }),
      col('menu_items').countDocuments({ branch_id: { $in: branchIds }, is_available: true, image_url: { $ne: null, $ne: '' } }),
    ]);

    res.json({ total, with_image: withImage, without_image: total - withImage, coverage_pct: total ? Math.round(withImage / total * 100) : 0 });
  } catch (err) {
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ═══════════════════════════════════════════════════════════════
// WHATSAPP ACCOUNTS
// ═══════════════════════════════════════════════════════════════

// POST /api/restaurant/whatsapp/verify-connection
// Verifies Meta connection using system user token — no OAuth needed.
// If WABA data exists in DB, validates it against Meta API.
// If not, tries to discover WABAs using META_BUSINESS_ID.
// [WABA-BIND-FIX] verify-connection NEVER discovers WABAs from the platform
// Meta Business account. The previous implementation called
// /<META_BUSINESS_ID>/owned_whatsapp_business_accounts and bound EVERY platform
// WABA to whichever restaurant clicked "Verify". That was a critical
// cross-tenant + platform-leak bug. This route is now read-only health-check:
// it pings each existing whatsapp_accounts row for THIS restaurant against
// Meta's Graph API and reports the result. It does NOT auto-create or
// auto-bind any WABAs. To connect a new WABA, the user must run the OAuth
// flow at /auth/meta/start.
router.post('/whatsapp/verify-connection', async (req, res) => {
  try {
    const sysToken = metaConfig.systemUserToken;
    if (!sysToken) return res.status(503).json({ error: 'System user token not configured. Please contact support.' });

    const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
    // Filter to restaurant-owned rows. account_type defaults to undefined for
    // legacy rows, which we treat as restaurant rows. Platform admin rows live
    // in admin_numbers and are never returned here.
    const waAccounts = await col('whatsapp_accounts').find({
      restaurant_id: req.restaurantId,
      $or: [{ account_type: 'restaurant' }, { account_type: { $exists: false } }],
    }).toArray();
    const results = { verified: [], errors: [], discovered: 0 };

    // Check existing accounts against Meta API
    for (const wa of waAccounts) {
      if (!wa.phone_number_id) continue;
      try {
        const r = await axios.get(`${metaConfig.graphUrl}/${wa.phone_number_id}`, {
          params: { fields: 'verified_name,display_phone_number,quality_rating', access_token: sysToken },
          timeout: 8000,
        });
        results.verified.push({ phone_number_id: wa.phone_number_id, name: r.data.verified_name, phone: r.data.display_phone_number });
      } catch (e) {
        results.errors.push({ phone_number_id: wa.phone_number_id, error: e.response?.data?.error?.message || e.message });
      }
    }

    // [WABA-BIND-FIX] If no WA accounts exist for this restaurant, do NOT
    // auto-discover from the platform's Meta Business account. That was the
    // bug. Tell the user to run the connect flow instead.
    if (!waAccounts.length) {
      return res.json({
        connected: false,
        verified: [],
        errors: [],
        discovered: 0,
        message: 'No WhatsApp account linked yet. Click "Connect WhatsApp Business" to link one via Meta.',
      });
    }

    // Ensure whatsapp_connected flag is set if we have valid accounts
    if (results.verified.length > 0 && !restaurant?.whatsapp_connected) {
      await col('restaurants').updateOne({ _id: req.restaurantId }, {
        $set: { whatsapp_connected: true, updated_at: new Date() },
      });
    }

    const connected = results.verified.length > 0;
    res.json({ connected, ...results });
  } catch (err) {
    req.log.error({ err }, 'WhatsApp verify-connection failed');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// POST /api/restaurant/whatsapp/disconnect
// Disconnects this restaurant's WhatsApp Business connection.
//
// Behavior:
//   1. Verify the restaurant owns the linked WABA row before touching anything.
//   2. Mark the whatsapp_accounts row inactive (is_active = false). Tokens are
//      preserved so the user can later "Verify Existing Connection" without
//      re-running the full OAuth flow if they reconnect the same number.
//   3. Clear the restaurant's linked_* fields and whatsapp_connected flag.
//   4. Invalidate the cachedLookup memcache so webhook routing stops within
//      one event loop tick (without waiting for the 5-min TTL).
//
// After this returns successfully:
//   • GET /whatsapp returns an empty array (filtered by is_active is_required
//     in cachedLookup; the GET /whatsapp route also drops inactive rows below).
//   • Webhook handler (`processChange` in webhooks/whatsapp.js) calls
//     getWaAccount(phone_number_id) which now returns null → message dropped.
//   • Settings page renders the "Connect WhatsApp Business" CTA.
//
// To reconnect: the user runs the existing /auth/meta/start flow which will
// re-bind under the (now-empty) linkage fields.
router.post('/whatsapp/disconnect', requirePermission('manage_users'), async (req, res) => {
  try {
    const restaurant = await col('restaurants').findOne(
      { _id: req.restaurantId },
      { projection: { linked_phone_number_id: 1, linked_waba_id: 1, whatsapp_connected: 1 } }
    );
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    // Find the WABA row(s) we're disconnecting. We use the EXPLICIT linkage
    // first (restaurants.linked_phone_number_id), but as a safety net we
    // also deactivate any other rows for this restaurant — there should
    // never be more than one active row per restaurant after the WABA-bind
    // fix, but legacy data may still have orphans.
    const filter = {
      restaurant_id: req.restaurantId,
      $or: [{ account_type: 'restaurant' }, { account_type: { $exists: false } }],
      is_active: true,
    };
    const activeRows = await col('whatsapp_accounts').find(filter).toArray();

    // Deactivate the WhatsApp account row(s). Tokens are preserved so an
    // operator clicking Verify after reconnect can recover without a full
    // re-OAuth. The is_active flip is what stops webhook routing.
    if (activeRows.length) {
      await col('whatsapp_accounts').updateMany(
        filter,
        { $set: { is_active: false, disconnected_at: new Date(), updated_at: new Date() } }
      );
    }

    // Invalidate the cachedLookup memcache so webhooks stop processing for
    // this number within milliseconds (vs 5-min TTL). Each row's
    // phone_number_id keys an entry under wa_account:<phone_number_id>.
    for (const row of activeRows) {
      if (row.phone_number_id) memcache.del(`wa_account:${row.phone_number_id}`);
    }

    // Clear the restaurant-level linkage source of truth.
    await col('restaurants').updateOne(
      { _id: req.restaurantId },
      {
        $set: {
          whatsapp_connected: false,
          updated_at: new Date(),
          disconnected_at: new Date(),
        },
        // Unset the explicit linkage fields so the read paths know there is
        // nothing connected. We do NOT touch meta_user_id / meta_access_token
        // because the user might want to reconnect to the SAME WABA without
        // re-running the OAuth dialog — keeping these means the existing
        // /auth/me-cached info stays available.
        $unset: {
          linked_waba_id: '',
          linked_phone_number_id: '',
          linked_at: '',
          // meta_phone_number_id / meta_waba_id are legacy duplicates of
          // linked_*; clear them too so no read path picks up stale data.
          meta_phone_number_id: '',
          meta_waba_id: '',
        },
      }
    );

    // Bust the GET /api/restaurant 10-min profile cache so the Settings
    // page reflects the disconnect immediately (without this, the card
    // keeps showing the WABA for up to 10 min after disconnect).
    await invalidateCache(`restaurant:${req.restaurantId}:profile`);

    logActivity({
      actorType: 'restaurant',
      actorId: String(req.userId || req.restaurantId),
      actorName: req.userRole || null,
      action: 'whatsapp.disconnected',
      category: 'auth',
      description: `WhatsApp Business connection disconnected (${activeRows.length} row(s) deactivated)`,
      restaurantId: req.restaurantId,
      resourceType: 'whatsapp_account',
      resourceId: restaurant.linked_phone_number_id || null,
      severity: 'info',
      metadata: {
        deactivated_phone_number_ids: activeRows.map(r => r.phone_number_id).filter(Boolean),
        previously_linked_phone_number_id: restaurant.linked_phone_number_id || null,
        previously_linked_waba_id: restaurant.linked_waba_id || null,
      },
    });

    req.log.info({
      restaurantId: req.restaurantId,
      deactivated: activeRows.length,
    }, 'WhatsApp disconnected');

    res.json({
      success: true,
      deactivated: activeRows.length,
      whatsapp_connected: false,
    });
  } catch (e) {
    req.log.error({ err: e }, 'WhatsApp disconnect failed');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// [WABA-BIND-FIX] Settings page reads its WhatsApp section from this route.
// Three guarantees:
//   1. Tenant filter — restaurant_id MUST match the caller (already in place)
//   2. Account-type filter — exclude platform admin/directory rows. We do this
//      by checking the admin_numbers collection: if a row's phone_number_id is
//      registered there, we drop it (defence in depth on top of the
//      _isPlatformAdminPhoneNumber check inside _saveWabaAccounts)
//   3. Linked-first ordering — the row matching restaurants.linked_phone_number_id
//      is returned FIRST, so the Settings UI's "first row" rendering shows the
//      explicitly linked WABA, not "whichever row sorted alphabetically first"
//   4. Inactive rows are dropped — disconnected accounts (is_active=false)
//      should never appear in the Settings UI
router.get('/whatsapp', async (req, res) => {
  try {
    const docs = await col('whatsapp_accounts').find({
      restaurant_id: req.restaurantId,
      // [DISCONNECT] Only return active rows. Disconnected rows are kept in
      // the DB with is_active=false so we can recover their tokens on
      // reconnect, but they must NEVER show up in the Settings UI.
      is_active: true,
      $or: [{ account_type: 'restaurant' }, { account_type: { $exists: false } }],
    }).toArray();

    // Defence in depth: drop any row whose phone_number_id is in admin_numbers
    let safeDocs = docs;
    if (docs.length) {
      const phoneIds = docs.map(d => d.phone_number_id).filter(Boolean);
      const adminRows = phoneIds.length
        ? await col('admin_numbers').find(
            { phone_number_id: { $in: phoneIds } },
            { projection: { phone_number_id: 1 } }
          ).toArray()
        : [];
      const adminSet = new Set(adminRows.map(a => a.phone_number_id));
      safeDocs = docs.filter(d => !adminSet.has(d.phone_number_id));
      if (safeDocs.length !== docs.length) {
        req.log.warn({
          restaurantId: req.restaurantId,
          dropped: docs.length - safeDocs.length,
        }, 'Dropped platform admin rows from /whatsapp response (defence in depth)');
      }
    }

    // Linked-first ordering — read the explicit link from the restaurant doc
    const restaurant = await col('restaurants').findOne(
      { _id: req.restaurantId },
      { projection: { linked_phone_number_id: 1 } }
    );
    const linkedId = restaurant?.linked_phone_number_id || null;
    if (linkedId) {
      safeDocs.sort((a, b) => {
        if (a.phone_number_id === linkedId) return -1;
        if (b.phone_number_id === linkedId) return 1;
        return 0;
      });
    }

    res.json(mapIds(safeDocs).map(d => {
      const { _id, access_token, meta_access_token, ...rest } = d;
      // Mark the linked row so the frontend can render a "Primary" badge.
      if (linkedId && d.phone_number_id === linkedId) rest.is_linked = true;
      return rest;
    }));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/whatsapp/:id/setup-status
// Returns setup checklist status — reads from cached MongoDB data.
// Refreshes from Meta API only if cache is older than 10 minutes or if ?refresh=true.
router.get('/whatsapp/:id/setup-status', async (req, res) => {
  try {
    const wa = await col('whatsapp_accounts').findOne({ _id: req.params.id, restaurant_id: req.restaurantId });
    if (!wa) return res.status(404).json({ error: 'WhatsApp account not found' });

    const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
    const forceRefresh = req.query.refresh === 'true';
    const cacheAge = wa.meta_status_cached_at ? Date.now() - new Date(wa.meta_status_cached_at).getTime() : Infinity;
    const cacheValid = cacheAge < CACHE_TTL_MS && wa.meta_status_cached && !forceRefresh;

    if (cacheValid) {
      // Return cached data immediately (no Meta API calls)
      return res.json({
        phone_number_id : wa.phone_number_id,
        phone_registered: wa.phone_registered || false,
        cart_enabled    : wa.cart_enabled     || false,
        catalog_id      : wa.catalog_id       || null,
        waba_subscribed : wa.waba_subscribed  || false,
        meta            : wa.meta_status_cached,
        cached          : true,
        cache_age_ms    : cacheAge,
      });
    }

    // Cache expired or forced refresh — fetch live from Meta
    const sysToken = metaConfig.systemUserToken;
    if (!sysToken && !wa.access_token) return res.status(400).json({ error: 'WhatsApp API token is not configured. Please contact support.' });
    const effectiveToken = sysToken || wa.access_token;
    const GRAPH = metaConfig.graphUrl;

    let phoneStatus = null;
    try {
      const r = await axios.get(`${GRAPH}/${wa.phone_number_id}`, {
        params: { fields: 'verified_name,display_phone_number,status,quality_rating,is_official_business_account,account_mode', access_token: effectiveToken },
        timeout: 8000,
      });
      phoneStatus = r.data;
    } catch (e) { phoneStatus = { error: e.response?.data?.error?.message || e.message }; }

    let wabaSubscribed = false;
    try {
      if (sysToken && wa.waba_id) {
        const r = await axios.get(`${GRAPH}/${wa.waba_id}/subscribed_apps`, {
          params: { access_token: sysToken }, timeout: 8000,
        });
        wabaSubscribed = (r.data?.data || []).some(app => app.id === metaConfig.appId);
      }
    } catch (_) {}

    // Cache the result in MongoDB
    // [TENANT] Defence in depth: pin restaurant_id even though the route was
    // gated at the top via the wa.findOne check.
    await col('whatsapp_accounts').updateOne(
      { _id: req.params.id, restaurant_id: req.restaurantId },
      { $set: {
        meta_status_cached: phoneStatus,
        meta_status_cached_at: new Date(),
        waba_subscribed: wabaSubscribed,
        // Also update display fields from Meta response if available
        ...(phoneStatus?.display_phone_number ? { phone_display: phoneStatus.display_phone_number } : {}),
        ...(phoneStatus?.verified_name ? { display_name: phoneStatus.verified_name } : {}),
        ...(phoneStatus?.quality_rating ? { quality_rating: phoneStatus.quality_rating } : {}),
      }}
    ).catch(() => {}); // non-blocking cache write

    res.json({
      phone_number_id : wa.phone_number_id,
      phone_registered: wa.phone_registered || false,
      cart_enabled    : wa.cart_enabled     || false,
      catalog_id      : wa.catalog_id       || null,
      waba_subscribed : wabaSubscribed,
      meta            : phoneStatus,
      cached          : false,
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/whatsapp/:id/complete-setup
// Runs all setup steps: register phone, subscribe WABA, provision catalog, enable cart
router.post('/whatsapp/:id/complete-setup', async (req, res) => {
  try {
    const wa = await col('whatsapp_accounts').findOne({ _id: req.params.id, restaurant_id: req.restaurantId });
    if (!wa) return res.status(404).json({ error: 'WhatsApp account not found' });
    const { _registerPhoneNumber, _provisionWabaCatalog, _enableCommerceSettings } = require('./auth');
    const results = { register: null, catalog: null, cart: null };

    try {
      await _registerPhoneNumber(wa.phone_number_id);
      results.register = 'ok';
    } catch (e) { results.register = e.message; }

    try {
      await _provisionWabaCatalog(req.restaurantId, wa.waba_id);
      results.catalog = 'ok';
    } catch (e) { results.catalog = e.message; }

    try {
      // [TENANT] Defence in depth: re-fetch with restaurant_id pinned, even
      // though the top-of-handler check already gated us.
      const updated = await col('whatsapp_accounts').findOne({ _id: req.params.id, restaurant_id: req.restaurantId });
      if (updated && updated.catalog_id) {
        await _enableCommerceSettings(wa.phone_number_id, updated.catalog_id);
        results.cart = 'ok';
      } else {
        results.cart = 'skipped — no catalog yet';
      }
    } catch (e) { results.cart = e.message; }

    // [TENANT] Same — pin restaurant_id on the final read.
    const final = await col('whatsapp_accounts').findOne({ _id: req.params.id, restaurant_id: req.restaurantId });
    if (!final) return res.status(404).json({ error: 'WhatsApp account not found' });
    res.json({
      success        : results.register === 'ok',
      phone_registered: final.phone_registered || false,
      cart_enabled    : final.cart_enabled     || false,
      catalog_id      : final.catalog_id       || null,
      steps           : results,
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/whatsapp/:id/provision-catalog
// Manually trigger catalog creation + cart icon enablement for a WABA
router.post('/whatsapp/:id/provision-catalog', async (req, res) => {
  try {
    const wa = await col('whatsapp_accounts').findOne({ _id: req.params.id, restaurant_id: req.restaurantId });
    if (!wa) return res.status(404).json({ error: 'WhatsApp account not found' });
    const { _provisionWabaCatalog } = require('./auth');
    await _provisionWabaCatalog(req.restaurantId, wa.waba_id);

    const updated = await col('whatsapp_accounts').findOne({ _id: req.params.id });
    res.json({ success: true, catalog_id: updated.catalog_id, cart_enabled: updated.cart_enabled });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// Update WA account (mainly to set catalog_id)
router.put('/whatsapp/:id', async (req, res) => {
  try {
    const { catalogId, isActive } = req.body;
    const $set = {};
    if (catalogId !== undefined) { $set.catalog_id = catalogId; $set.catalog_linked = !!catalogId; if (catalogId) $set.catalog_linked_at = new Date(); }
    if (isActive  !== undefined) $set.is_active   = isActive;
    await col('whatsapp_accounts').updateOne(
      { _id: req.params.id, restaurant_id: req.restaurantId },
      { $set }
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ═══════════════════════════════════════════════════════════════
// PLACES (Google Places API New — for branch address autocomplete)
// ═══════════════════════════════════════════════════════════════

router.get('/places/autocomplete', async (req, res) => {
  try {
    const input = (req.query.input || '').trim();
    if (input.length < 2) return res.json({ suggestions: [] });

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY not configured' });

    const { data } = await axios.post(
      'https://places.googleapis.com/v1/places:autocomplete',
      {
        input,
        regionCode: 'in',
        languageCode: 'en',
        includedPrimaryTypes: ['establishment', 'street_address', 'sublocality', 'locality', 'point_of_interest'],
      },
      {
        headers: { 'X-Goog-Api-Key': apiKey, 'Content-Type': 'application/json' },
        timeout: 8000,
      }
    );

    const suggestions = (data.suggestions || [])
      .filter(s => s.placePrediction)
      .map(s => {
        const p = s.placePrediction;
        return {
          place_id: p.placeId,
          mainText: p.structuredFormat?.mainText?.text || p.text?.text || '',
          secondaryText: p.structuredFormat?.secondaryText?.text || '',
          fullText: p.text?.text || '',
        };
      });

    res.json({ suggestions });
  } catch (e) {
    req.log.error({ err: e, metaResponse: e.response?.data }, 'Places autocomplete failed');
    res.status(500).json({ error: 'Place search failed' });
  }
});

router.get('/places/details', async (req, res) => {
  try {
    const placeId = (req.query.placeId || '').trim();
    if (!placeId) return res.status(400).json({ error: 'placeId is required' });

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY not configured' });

    const { data } = await axios.get(
      `https://places.googleapis.com/v1/places/${placeId}`,
      {
        headers: {
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'id,displayName,formattedAddress,location,addressComponents,shortFormattedAddress',
        },
        timeout: 8000,
      }
    );

    const getComponent = (type) => {
      const c = (data.addressComponents || []).find(c => c.types?.includes(type));
      return c?.longText || '';
    };

    res.json({
      place_id: data.id,
      name: data.displayName?.text || '',
      full_address: data.formattedAddress || '',
      short_address: data.shortFormattedAddress || '',
      lat: data.location?.latitude || null,
      lng: data.location?.longitude || null,
      area: getComponent('sublocality_level_1') || getComponent('sublocality'),
      city: getComponent('locality'),
      state: getComponent('administrative_area_level_1'),
      pincode: getComponent('postal_code'),
      country: getComponent('country'),
    });
  } catch (e) {
    req.log.error({ err: e, metaResponse: e.response?.data }, 'Place details fetch failed');
    res.status(500).json({ error: 'Place details fetch failed' });
  }
});

// GET /api/restaurant/places/reverse-geocode?lat=&lng=
// Fallback for the "Pin on map" UX when Places autocomplete returns no
// suggestions. Takes a lat/lng pair from a dropped map marker and resolves
// it to a full Indian address via Google's Geocoding API. Response shape
// matches /places/details so the frontend pickSuggestion / pin-drop paths
// can share field-population logic.
router.get('/places/reverse-geocode', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'lat and lng must be valid numbers' });
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY not configured' });

    const { data } = await axios.get(
      'https://maps.googleapis.com/maps/api/geocode/json',
      { params: { latlng: `${lat},${lng}`, key: apiKey }, timeout: 8000 },
    );

    if (data.status !== 'OK' || !data.results?.length) {
      req.log.warn({ status: data.status, lat, lng }, 'Reverse geocode returned no results');
      return res.status(500).json({ error: 'Reverse geocode failed' });
    }

    const first = data.results[0];
    const getComponent = (type) => {
      const c = (first.address_components || []).find(cc => cc.types?.includes(type));
      return c?.long_name || '';
    };

    res.json({
      full_address: first.formatted_address || '',
      lat,
      lng,
      city:    getComponent('locality'),
      state:   getComponent('administrative_area_level_1'),
      pincode: getComponent('postal_code'),
      area:    getComponent('sublocality_level_1') || getComponent('sublocality'),
      place_id: first.place_id || '',
    });
  } catch (e) {
    req.log.error({ err: e, metaResponse: e.response?.data }, 'Reverse geocode failed');
    res.status(500).json({ error: 'Reverse geocode failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// BRANCHES
// ═══════════════════════════════════════════════════════════════

router.get('/branches', async (req, res) => {
  try {
    // Static branch fields are cached for 10min — they change rarely.
    const docs = await getCached(`restaurant:${req.restaurantId}:branches`, async () => {
      const raw = await col('branches').find({ restaurant_id: req.restaurantId }).sort({ created_at: 1 }).toArray();
      return mapIds(raw);
    }, 600);

    // item_count is volatile (mutates on every CSV upload, item create,
    // item delete) so it's computed fresh per request rather than baked
    // into the cached payload. Single aggregation, no N+1: $setUnion
    // merges the legacy scalar `branch_id` and the newer `branch_ids`
    // array into one set per item, then unwinds + groups. An item with
    // both fields populated only counts once per branch even if both
    // happen to point at the same id.
    const branchIds = docs.map((b) => b.id);
    const itemCountByBranch = {};
    if (branchIds.length) {
      const counts = await col('menu_items').aggregate([
        {
          $match: {
            restaurant_id: req.restaurantId,
            $or: [
              { branch_ids: { $in: branchIds } },
              { branch_id: { $in: branchIds } },
            ],
          },
        },
        {
          $project: {
            _branches: {
              $setUnion: [
                { $ifNull: ['$branch_ids', []] },
                {
                  $cond: [
                    { $and: [{ $ne: ['$branch_id', null] }, { $ne: ['$branch_id', undefined] }] },
                    ['$branch_id'],
                    [],
                  ],
                },
              ],
            },
          },
        },
        { $unwind: '$_branches' },
        { $match: { _branches: { $in: branchIds } } },
        { $group: { _id: '$_branches', count: { $sum: 1 } } },
      ]).toArray();
      for (const c of counts) itemCountByBranch[String(c._id)] = c.count;
    }

    const enriched = docs.map((b) => ({ ...b, item_count: itemCountByBranch[b.id] || 0 }));
    res.json(enriched);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.post('/branches', async (req, res) => {
  try {
    const {
      name, address, city, pincode, latitude, longitude, area, state, place_id,
      deliveryRadiusKm, openingTime, closingTime, managerPhone,
      fssai_number, gst_number,
    } = req.body;
    if (!latitude || !longitude) return res.status(400).json({ error: 'latitude and longitude are required' });

    // Serviceability gate: block branch creation in pincodes that are
    // either disabled or not on the platform-wide list. This is the first
    // point in the onboarding flow where a pincode is actually collected
    // (the auth.js signup/onboarding payloads carry no pincode), so it
    // doubles as the merchant-side serviceability gate. `isPincodeServiceable`
    // fails open on lookup errors, so it won't block on transient DB hiccups.
    if (pincode) {
      const { isPincodeServiceable } = require('../utils/pincodeValidator');
      const ok = await isPincodeServiceable(pincode);
      if (!ok) {
        return res.status(400).json({
          error: 'SERVICE_UNAVAILABLE',
          message: "We don't currently deliver to your area. Please check back soon.",
        });
      }
    }

    const branchId = newId();
    const now = new Date();
    const branchSlug = slugify(name, 20) || branchId.slice(0, 8);
    const branch = {
      _id: branchId,
      restaurant_id: req.restaurantId,
      name,
      branch_slug: branchSlug,
      address,
      city,
      pincode: pincode || null,
      area: area || null,
      state: state || null,
      place_id: place_id || null,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      opening_time: openingTime || '10:00',
      closing_time: closingTime || '22:00',
      manager_phone: managerPhone || null,
      fssai_number: fssai_number || null,
      gst_number:   gst_number   || null,
      is_active: true,
      is_open: true,
      accepts_orders: true,
      catalog_id: null,
      delivery_fee_rs: null,
      created_at: now,
      updated_at: now,
    };
    await col('branches').insertOne(branch);

    await col('restaurants').updateOne(
      { _id: req.restaurantId },
      [{ $set: { onboarding_step: { $max: ['$onboarding_step', 3] } } }]
    );

    const newBranch = mapId(branch);

    // AUTO-CREATE WHATSAPP CATALOG FOR THIS BRANCH (background)
    catalog.createBranchCatalog(newBranch.id)
      .then(result => {
        if (result.success) logger.info({ branchName: newBranch.name, catalogId: result.catalogId }, 'Auto-created catalog for branch');
      })
      .catch(err => logger.error({ err, branchName: newBranch.name }, 'Auto catalog creation failed for branch'));

    invalidateCache(`restaurant:${req.restaurantId}:branches`, `restaurant:${req.restaurantId}:profile`);
    res.status(201).json(newBranch);

    // Fire-and-forget after the response — admin console gets a live
    // signal whenever a merchant adds a new outlet. Restaurants don't
    // need this on their own dashboard (the local /branches refetch
    // already handles their view).
    try {
      const { emitToAdmin } = require('../utils/socketEmit');
      emitToAdmin('restaurant:branch_created', {
        restaurantId: String(req.restaurantId),
        branchName: newBranch.name || null,
      });
    } catch (_) { /* socket failure must not poison the create */ }
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/branches/csv
// Bulk-create branches from CSV rows (geocoding done on frontend before this call)
router.post('/branches/csv', async (req, res) => {
  try {
    const { branches: rows } = req.body;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No rows provided' });
    if (rows.length > 50) return res.status(400).json({ error: 'Max 50 outlets per upload' });

    const created = [], skipped = [], errors = [];

    for (const row of rows) {
      const name    = sanitizeCsvString(row.branch_name);
      const address = sanitizeCsvString(row.address);
      const lat     = parseFloat(row.latitude);
      const lng     = parseFloat(row.longitude);

      if (!name)          { skipped.push({ row, reason: 'branch_name is required' }); continue; }
      if (!address)       { skipped.push({ row, reason: 'address is required' });     continue; }
      if (isNaN(lat) || isNaN(lng)) { skipped.push({ row, reason: 'latitude and longitude are required — geocoding should have run on the client' }); continue; }

      // manager_phone is optional, but if present it MUST be a valid 8–15
      // digit number — anything else (typos, descriptions, garbage) is
      // dropped so we never insert an unsendable phone into MongoDB.
      let managerPhone = null;
      if (row.manager_phone) {
        managerPhone = sanitizeCsvPhone(row.manager_phone);
        if (!managerPhone) {
          skipped.push({ row, reason: `invalid manager_phone "${row.manager_phone}" — must be 8–15 digits` });
          continue;
        }
      }

      try {
        const branchId = newId();
        const now = new Date();
        const branch = {
          _id: branchId,
          restaurant_id: req.restaurantId,
          name,
          branch_slug: slugify(name, 20) || branchId.slice(0, 8),
          address,
          city: sanitizeCsvString(row.city),
          pincode: sanitizeCsvString(row.pincode),
          latitude: lat,
          longitude: lng,
          opening_time: row.opening_time || '10:00',
          closing_time: row.closing_time || '22:00',
          manager_phone: managerPhone,
          is_active: true,
          is_open: true,
          accepts_orders: true,
          catalog_id: null,
          delivery_fee_rs: null,
          created_at: now,
          updated_at: now,
        };
        await col('branches').insertOne(branch);
        const newBranch = mapId(branch);
        created.push({ id: newBranch.id, name: newBranch.name, latitude: lat, longitude: lng });

        // Auto-create WhatsApp catalog (background)
        catalog.createBranchCatalog(newBranch.id)
          .then(r => { if (r.success) logger.info({ branchName: name, catalogId: r.catalogId }, 'CSV branch catalog created'); })
          .catch(e => logger.error({ err: e, branchName: name }, 'CSV branch catalog creation failed'));
      } catch (rowErr) {
        errors.push({ row, reason: rowErr.message });
      }
    }

    if (created.length) {
      await col('restaurants').updateOne(
        { _id: req.restaurantId },
        [{ $set: { onboarding_step: { $max: ['$onboarding_step', 3] } } }]
      );
    }

    res.json({ created: created.length, skipped: skipped.length, errors: errors.length, details: { created, skipped, errors } });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.patch('/branches/:id', async (req, res) => {
  try {
    const {
      name, isOpen, acceptsOrders, isActive, deliveryRadiusKm, catalogId,
      basePrepTimeMin, avgItemPrepMin, managerPhone,
      address, city, pincode, latitude, longitude, area, state, place_id,
      openingTime, closingTime, fssai_number, gst_number,
    } = req.body;
    const $set = {};
    let nameChanged = false;
    if (name               !== undefined) {
      const trimmed = String(name).trim();
      if (trimmed) {
        $set.name          = trimmed;
        // Regenerate branch_slug from the new name so custom_label_0 (derived
        // from branch.branch_slug) picks up the rename on the next catalog
        // sync. Uses the same slugify() as makeRetailerId for consistency.
        $set.branch_slug   = slugify(trimmed, 20) || req.params.id.slice(0, 8);
        nameChanged = true;
      }
    }
    if (isOpen             !== undefined) $set.is_open              = isOpen;
    if (acceptsOrders      !== undefined) $set.accepts_orders       = acceptsOrders;
    if (isActive           !== undefined) $set.is_active            = isActive;
    // delivery_radius_km removed — enforcement is now platform-wide via
    // platform_settings._id='delivery_radius'. Per-branch overrides are
    // intentionally ignored even if the dashboard form still sends one.
    if (catalogId          !== undefined) $set.catalog_id           = catalogId;
    if (basePrepTimeMin    !== undefined) $set.base_prep_time_min   = parseInt(basePrepTimeMin) || 15;
    if (avgItemPrepMin     !== undefined) $set.avg_item_prep_min    = parseInt(avgItemPrepMin) || 3;
    if (managerPhone       !== undefined) $set.manager_phone        = managerPhone || null;
    if (address            !== undefined) $set.address              = address;
    if (city               !== undefined) $set.city                 = city;
    if (pincode            !== undefined) $set.pincode              = pincode || null;
    if (latitude           !== undefined) $set.latitude             = parseFloat(latitude);
    if (longitude          !== undefined) $set.longitude            = parseFloat(longitude);
    if (area               !== undefined) $set.area                 = area || null;
    if (state              !== undefined) $set.state                = state || null;
    if (place_id           !== undefined) $set.place_id             = place_id || null;
    if (openingTime        !== undefined) $set.opening_time         = openingTime;
    if (closingTime        !== undefined) $set.closing_time         = closingTime;
    if (fssai_number       !== undefined) $set.fssai_number         = fssai_number || null;
    if (gst_number         !== undefined) $set.gst_number           = gst_number || null;
    if (Object.keys($set).length > 0) $set.updated_at = new Date();
    await col('branches').updateOne(
      { _id: req.params.id, restaurant_id: req.restaurantId },
      { $set }
    );
    // Invalidate cached branch data — both the in-process per-branch cache
    // (used by webhook routing) and the Mongo _cache list/profile entries
    // that the dashboard reads via getBranches() / getRestaurantProfile().
    require('../config/memcache').del(`branch:${req.params.id}`);
    invalidateCache(`restaurant:${req.restaurantId}:branches`, `restaurant:${req.restaurantId}:profile`);

    // If the branch was renamed, its branch_slug changed — the existing Meta
    // product set filter (custom_label_0 = {old slug}) is now stale. Fire
    // product-set sync in the background so the filter re-aligns with the
    // new slug on the next item sync.
    if (nameChanged) {
      catalog.syncProductSets(req.params.id).catch(err =>
        logger.error({ err, branchId: req.params.id }, 'syncProductSets after rename failed')
      );
    }

    res.json({ success: true });

    if (isOpen !== undefined) {
      log({ actorType: 'restaurant', actorId: String(req.restaurantId), actorName: req.restaurant?.business_name || 'Restaurant', action: 'branch.toggled', category: 'settings', description: `Branch toggled`, restaurantId: String(req.restaurantId), resourceType: 'branch', resourceId: req.params.id, severity: 'info' });
      // Live-feed the platform admin console when a branch flips
      // open/closed. Fire-and-forget after res.json so a socket hiccup
      // can't slow down the dashboard's PATCH round-trip. Branch name
      // is read post-update so a rename in the same call is reflected.
      (async () => {
        try {
          const { emitToAdmin } = require('../utils/socketEmit');
          const branch = await col('branches').findOne(
            { _id: req.params.id, restaurant_id: req.restaurantId },
            { projection: { _id: 1, name: 1 } },
          );
          emitToAdmin('restaurant:branch_status', {
            restaurantId: String(req.restaurantId),
            branchId: String(req.params.id),
            branchName: branch?.name || null,
            is_open: !!isOpen,
          });
        } catch (_) { /* never block branch update on socket fan-out */ }
      })();
    } else {
      log({ actorType: 'restaurant', actorId: String(req.restaurantId), actorName: req.restaurant?.business_name || 'Restaurant', action: 'branch.updated', category: 'settings', description: `Branch updated`, restaurantId: String(req.restaurantId), resourceType: 'branch', resourceId: req.params.id, severity: 'info' });
    }
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/branches/:id/soft-delete
// Soft-removes a branch from the restaurant's active set. The row stays in
// Mongo so menu items / orders / catalog references remain intact and the
// row can be restored without re-OAuth or re-syncing. Sets is_active=false
// AND deleted_at so the frontend can distinguish "admin toggled off" (just
// is_active) from "deleted" (deleted_at present).
router.post('/branches/:id/soft-delete', async (req, res) => {
  try {
    const branch = await col('branches').findOne({ _id: req.params.id, restaurant_id: req.restaurantId });
    if (!branch) return res.status(404).json({ error: 'Branch not found' });
    if (branch.deleted_at) return res.json({ success: true, branch }); // idempotent — already deleted

    const now = new Date();
    await col('branches').updateOne(
      { _id: req.params.id, restaurant_id: req.restaurantId },
      { $set: { is_active: false, deleted_at: now, updated_at: now } }
    );
    require('../config/memcache').del(`branch:${req.params.id}`);
    invalidateCache(`restaurant:${req.restaurantId}:branches`, `restaurant:${req.restaurantId}:profile`);

    log({
      actorType: 'restaurant', actorId: String(req.restaurantId),
      actorName: req.restaurant?.business_name || 'Restaurant',
      action: 'branch.soft_deleted', category: 'settings',
      description: `Branch "${branch.name}" soft-deleted`,
      restaurantId: String(req.restaurantId),
      resourceType: 'branch', resourceId: req.params.id,
      severity: 'info',
    });
    res.json({ success: true, branch: { ...branch, is_active: false, deleted_at: now, updated_at: now } });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/branches/:id/restore
// Reverses soft-delete. is_active=true and deleted_at is unset. Used from
// the "Restore branch" button on greyed-out cards.
router.post('/branches/:id/restore', async (req, res) => {
  try {
    const branch = await col('branches').findOne({ _id: req.params.id, restaurant_id: req.restaurantId });
    if (!branch) return res.status(404).json({ error: 'Branch not found' });
    if (!branch.deleted_at && branch.is_active !== false) return res.json({ success: true, branch }); // idempotent — already active

    const now = new Date();
    await col('branches').updateOne(
      { _id: req.params.id, restaurant_id: req.restaurantId },
      { $set: { is_active: true, updated_at: now }, $unset: { deleted_at: '' } }
    );
    require('../config/memcache').del(`branch:${req.params.id}`);
    invalidateCache(`restaurant:${req.restaurantId}:branches`, `restaurant:${req.restaurantId}:profile`);

    log({
      actorType: 'restaurant', actorId: String(req.restaurantId),
      actorName: req.restaurant?.business_name || 'Restaurant',
      action: 'branch.restored', category: 'settings',
      description: `Branch "${branch.name}" restored`,
      restaurantId: String(req.restaurantId),
      resourceType: 'branch', resourceId: req.params.id,
      severity: 'info',
    });
    const { deleted_at: _ignore, ...rest } = branch;
    res.json({ success: true, branch: { ...rest, is_active: true, updated_at: now } });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// DELETE /api/restaurant/branches/:id/permanent
// Hard-deletes a branch and all its menu items from MongoDB. Fire-and-forget
// purges the same retailer_ids from the Meta catalog. Guards: the branch
// must already be soft-deleted (deleted_at set) — paused/inactive branches
// without deleted_at cannot be permanently removed via this route. The
// soft-delete → permanent-delete two-step is the safety net.
router.delete('/branches/:id/permanent', async (req, res) => {
  try {
    const branchId = req.params.id;
    const branch = await col('branches').findOne({ _id: branchId, restaurant_id: req.restaurantId });
    if (!branch) return res.status(404).json({ error: 'Branch not found' });

    if (!branch.deleted_at) {
      return res.status(400).json({ error: 'Branch must be deleted before permanent removal. Use the delete action first.' });
    }

    // Snapshot retailer_ids BEFORE the Mongo delete so the Meta purge has
    // something to work with. Cheap projection — just the field we need.
    const items = await col('menu_items')
      .find({ branch_id: branchId }, { projection: { retailer_id: 1 } })
      .toArray();
    const retailerIds = items.map((i) => i.retailer_id).filter(Boolean);

    // Resolve catalogId + token NOW, while the branch row still exists.
    // The previous version called catalog.bulkDeleteProducts inside the
    // fire-and-forget IIFE, which re-reads the branch from Mongo to find
    // its catalog — and silently no-ops when that read races behind the
    // deleteOne below. Capture everything the IIFE needs into closure
    // before we touch Mongo or queue the IIFE.
    const restaurant = await col('restaurants').findOne(
      { _id: req.restaurantId },
      { projection: { meta_catalog_id: 1 } }
    );
    const catalogId = restaurant?.meta_catalog_id;
    const token = process.env.META_SYSTEM_USER_TOKEN;

    await col('menu_items').deleteMany({ branch_id: branchId });

    if (retailerIds.length > 0 && catalogId && token) {
      // Fire-and-forget Meta purge. Direct items_batch DELETE — no second
      // Mongo lookup, so the closure is immune to the branch row going
      // away in the deleteOne below.
      console.log(`[Branch:PermanentDelete] Deleting ${retailerIds.length} items from Meta catalog for branch ${branchId}`);
      (async () => {
        try {
          const apiVersion = process.env.META_API_VERSION || 'v21.0';
          const body = {
            allow_upsert: false,
            requests: retailerIds.map((id) => ({
              method: 'DELETE',
              retailer_id: id,
            })),
          };
          const r = await fetch(
            `https://graph.facebook.com/${apiVersion}/${catalogId}/items_batch`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(body),
            }
          );
          const result = await r.json();
          if (result.handles) {
            console.log(`[Branch:PermanentDelete] Removed ${retailerIds.length} items from Meta catalog`);
          } else {
            console.error('[Branch:PermanentDelete] Meta delete error:', JSON.stringify(result.error || result));
          }
        } catch (e) {
          console.error('[Branch:PermanentDelete] Meta delete error:', e.message);
        }
      })();
    }

    await col('branches').deleteOne({ _id: branchId, restaurant_id: req.restaurantId });

    require('../config/memcache').del(`branch:${branchId}`);
    invalidateCache(`restaurant:${req.restaurantId}:branches`, `restaurant:${req.restaurantId}:profile`);

    log({
      actorType: 'restaurant', actorId: String(req.restaurantId),
      actorName: req.restaurant?.business_name || 'Restaurant',
      action: 'branch.permanently_deleted', category: 'settings',
      description: `Branch "${branch.name}" permanently deleted (${items.length} menu items removed)`,
      restaurantId: String(req.restaurantId),
      resourceType: 'branch', resourceId: branchId,
      severity: 'warning',
    });

    console.log(`[Branch:PermanentDelete] Branch ${branch.name} (${branchId}) permanently deleted. Items removed: ${items.length}`);
    res.json({ success: true, deleted_items: items.length });
  } catch (e) {
    req.log.error({ err: e }, 'Permanent branch delete failed');
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ─── BRANCH STAFF-LINK (UUID for staff app PIN login URL) ──────
// staff_access_token is a per-branch UUID. Staff open the link
// /staff/<token> on a tablet, which scopes the login to that branch
// (the new /api/staff/auth resolves restaurantId + branchId from the
// token). Token regeneration replaces the value but does NOT
// invalidate existing JWTs — they carry branchId in the payload, not
// the token. Old links simply stop working for new logins.

// GET /api/restaurant/branches/:branchId/staff-link
// Returns the existing staff_access_token + the construction of the
// shareable login URL. { staff_access_token: null, ... } when none has
// been generated yet (admin must POST /generate first).
router.get('/branches/:branchId/staff-link', async (req, res) => {
  try {
    const branch = await col('branches').findOne(
      { _id: req.params.branchId, restaurant_id: req.restaurantId },
      { projection: { staff_access_token: 1, staff_access_token_generated_at: 1 } },
    );
    if (!branch) return res.status(404).json({ error: 'Branch not found' });
    const token = branch.staff_access_token || null;
    const base = process.env.FRONTEND_URL || '';
    const loginUrl = token && base ? `${base.replace(/\/$/, '')}/staff/${token}` : null;
    res.json({
      staff_access_token: token,
      staff_login_url: loginUrl,
      generated_at: branch.staff_access_token_generated_at || null,
    });
  } catch (e) {
    req.log?.error?.({ err: e, branchId: req.params.branchId }, 'staff-link get failed');
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// POST /api/restaurant/branches/:branchId/staff-link/generate
// Generates (or replaces) the per-branch staff_access_token. Existing
// staff JWTs continue to work — they carry branchId in the payload, not
// the token, so revocation has to happen through the per-user
// soft-delete or reset-pin paths in /restaurant/staff-users. Replacing
// the token only blocks NEW logins via the old URL.
router.post('/branches/:branchId/staff-link/generate', async (req, res) => {
  try {
    const branch = await col('branches').findOne(
      { _id: req.params.branchId, restaurant_id: req.restaurantId },
      { projection: { _id: 1 } },
    );
    if (!branch) return res.status(404).json({ error: 'Branch not found' });

    const crypto = require('crypto');
    const newToken = crypto.randomUUID();
    const now = new Date();
    await col('branches').updateOne(
      { _id: req.params.branchId },
      { $set: {
          staff_access_token: newToken,
          staff_access_token_generated_at: now,
          updated_at: now,
      } },
    );

    log({
      actorType: 'restaurant', actorId: String(req.userId || req.restaurantId), actorName: req.userRole || null,
      action: 'branch.staff_link_generated', category: 'settings',
      description: `Staff access token (re)generated for branch ${req.params.branchId}`,
      restaurantId: req.restaurantId,
      branchId: req.params.branchId,
      resourceType: 'branch', resourceId: req.params.branchId,
      severity: 'info',
    });

    const base = process.env.FRONTEND_URL || '';
    const loginUrl = base ? `${base.replace(/\/$/, '')}/staff/${newToken}` : null;
    res.json({
      staff_access_token: newToken,
      staff_login_url: loginUrl,
      generated_at: now,
    });
  } catch (e) {
    req.log?.error?.({ err: e, branchId: req.params.branchId }, 'staff-link generate failed');
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// GET /api/restaurant/branches/:branchId/hours — operating hours for a branch
router.get('/branches/:branchId/hours', async (req, res) => {
  try {
    const branch = await col('branches').findOne({ _id: req.params.branchId, restaurant_id: req.restaurantId });
    if (!branch) return res.status(404).json({ error: 'Branch not found' });

    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    let hours = branch.operating_hours;

    // Build from simple opening_time/closing_time if no per-day hours
    if (!hours) {
      const open = (branch.opening_time || '10:00').slice(0, 5);
      const close = (branch.closing_time || '22:00').slice(0, 5);
      hours = {};
      for (const d of days) hours[d] = { open, close, is_closed: false };
    }

    // Ensure all 7 days exist with defaults
    for (const d of days) {
      if (!hours[d]) hours[d] = { open: '10:00', close: '22:00', is_closed: false };
    }

    res.json({ hours });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// PUT /api/restaurant/branches/:branchId/hours — update operating hours
router.put('/branches/:branchId/hours', async (req, res) => {
  try {
    const { hours } = req.body;
    if (!hours || typeof hours !== 'object') return res.status(400).json({ error: 'hours object required' });

    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const timeRe = /^\d{2}:\d{2}$/;
    const cleaned = {};

    for (const d of days) {
      const dh = hours[d];
      if (!dh) return res.status(400).json({ error: `Missing day: ${d}` });
      const isClosed = !!dh.is_closed;
      const open = String(dh.open || '10:00').slice(0, 5);
      const close = String(dh.close || '22:00').slice(0, 5);
      if (!timeRe.test(open) || !timeRe.test(close)) return res.status(400).json({ error: `Invalid time format for ${d}` });
      const [oh, om] = open.split(':').map(Number);
      const [ch, cm] = close.split(':').map(Number);
      if (oh > 23 || om > 59 || ch > 23 || cm > 59) return res.status(400).json({ error: `Time out of range for ${d}` });
      cleaned[d] = { open, close, is_closed: isClosed };
    }

    // Derive simple opening_time/closing_time from the first open day (for backward compatibility)
    let openingTime = '10:00', closingTime = '22:00';
    const firstOpen = days.find(d => !cleaned[d].is_closed);
    if (firstOpen) {
      openingTime = cleaned[firstOpen].open;
      closingTime = cleaned[firstOpen].close;
    }

    const branch = await col('branches').findOne({ _id: req.params.branchId, restaurant_id: req.restaurantId });
    if (!branch) return res.status(404).json({ error: 'Branch not found' });

    await col('branches').updateOne(
      { _id: req.params.branchId, restaurant_id: req.restaurantId },
      { $set: { operating_hours: cleaned, opening_time: openingTime, closing_time: closingTime, updated_at: new Date() } }
    );

    // Invalidate cached branch data
    require('../config/memcache').del(`branch:${req.params.branchId}`);

    log({ actorType: 'restaurant', actorId: String(req.restaurantId), actorName: req.restaurant?.business_name || 'Restaurant', action: 'branch.hours_updated', category: 'settings', description: 'Operating hours updated', restaurantId: String(req.restaurantId), resourceType: 'branch', resourceId: req.params.branchId, severity: 'info' });

    res.json({ success: true, hours: cleaned });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/branches/:branchId/surge — current 3PL surge / delivery status
router.get('/branches/:branchId/surge', async (req, res) => {
  try {
    const branch = await col('branches').findOne({ _id: req.params.branchId, restaurant_id: req.restaurantId });
    if (!branch) return res.status(404).json({ error: 'Branch not found' });
    const { getSurgeInfo } = require('../services/dynamicPricing');
    const info = await getSurgeInfo(req.params.branchId);
    res.json(info);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ═══════════════════════════════════════════════════════════════
// MENU CATEGORIES
// ═══════════════════════════════════════════════════════════════

router.get('/branches/:branchId/categories', async (req, res) => {
  try {
    // [TENANT] Verify the branch belongs to this restaurant before listing.
    const branch = await _assertBranchOwnedBy(req.params.branchId, req.restaurantId);
    if (!branch) return res.status(404).json({ error: 'Branch not found' });
    const docs = await col('menu_categories').find({ branch_id: req.params.branchId }).sort({ sort_order: 1 }).toArray();
    res.json(mapIds(docs));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.post('/branches/:branchId/categories', async (req, res) => {
  try {
    // [TENANT] Verify branch ownership before inserting a category that would
    // appear in another restaurant's menu.
    const branch = await _assertBranchOwnedBy(req.params.branchId, req.restaurantId);
    if (!branch) return res.status(404).json({ error: 'Branch not found' });
    const { name, description, sortOrder } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Category name is required' });
    const catId = newId();
    const now = new Date();
    const cat = { _id: catId, branch_id: req.params.branchId, name: name.trim(), description: description || null, sort_order: sortOrder || 0, created_at: now };
    await col('menu_categories').insertOne(cat);
    res.status(201).json(mapId(cat));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.put('/branches/:branchId/categories/:catId', async (req, res) => {
  try {
    // [TENANT] Verify branch ownership; the catId+branchId combo would
    // otherwise let an attacker rename another restaurant's category.
    const branch = await _assertBranchOwnedBy(req.params.branchId, req.restaurantId);
    if (!branch) return res.status(404).json({ error: 'Branch not found' });
    const { name, sortOrder } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Category name is required' });
    const result = await col('menu_categories').findOneAndUpdate(
      { _id: req.params.catId, branch_id: req.params.branchId },
      { $set: { name: name.trim(), sort_order: sortOrder ?? undefined, updated_at: new Date() } },
      { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Category not found' });
    res.json(mapId(result));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.delete('/branches/:branchId/categories/:catId', async (req, res) => {
  try {
    // [TENANT] Verify branch ownership before deletion + bulk uncategorize.
    const branch = await _assertBranchOwnedBy(req.params.branchId, req.restaurantId);
    if (!branch) return res.status(404).json({ error: 'Branch not found' });
    await col('menu_categories').deleteOne({ _id: req.params.catId, branch_id: req.params.branchId });
    // Unlink items from this category (don't delete items, just uncategorize)
    await col('menu_items').updateMany(
      { branch_id: req.params.branchId, category_id: req.params.catId },
      { $set: { category_id: null } }
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ═══════════════════════════════════════════════════════════════
// MENU ITEMS
// ═══════════════════════════════════════════════════════════════

// GET /api/restaurant/menu/all — ALL items across ALL branches (grouped by category)
router.get('/menu/all', async (req, res) => {
  try {
    // Brand context — same rules as /orders, /messages. Applied to the
    // menu_items (catalog) filter so multi-brand tenants see only
    // items scoped to the active brand.
    const { resolveBrandContext, setBrandHeaders } = require('../utils/brandContext');
    const brandCtx = await resolveBrandContext(req.restaurantId, req.query.brand_id);
    if (brandCtx.missing) {
      return res.status(400).json({ error: 'brand_id is required for multi-brand businesses', business_type: brandCtx.business_type });
    }
    setBrandHeaders(res, brandCtx);

    const branchDocs = await col('branches').find({ restaurant_id: req.restaurantId }).toArray();
    const branchIds = branchDocs.map(b => String(b._id));

    // Fetch items from all branches AND unassigned items (branch_id is null or missing)
    const itemFilter = branchIds.length
      ? { $or: [{ branch_id: { $in: branchIds } }, { restaurant_id: req.restaurantId, branch_id: null }, { restaurant_id: req.restaurantId, branch_id: { $exists: false } }] }
      : { restaurant_id: req.restaurantId };
    if (brandCtx.effective_brand_id) itemFilter.brand_id = brandCtx.effective_brand_id;

    const [cats, items] = await Promise.all([
      branchIds.length ? col('menu_categories').find({ branch_id: { $in: branchIds } }).sort({ sort_order: 1 }).toArray() : [],
      col('menu_items').find(itemFilter).sort({ sort_order: 1, name: 1 }).toArray(),
    ]);

    // Build a branch name lookup
    const branchMap = {};
    for (const b of branchDocs) branchMap[String(b._id)] = b.name || 'Unnamed';

    const mappedCats = mapIds(cats);
    const mappedItems = mapIds(items).map(i => ({
      ...i,
      branch_name: i.branch_id ? (branchMap[i.branch_id] || 'Unknown') : null,
      _unassigned: !i.branch_id,
    }));

    // Deduplicate categories by name (same category name across branches → merge)
    const catByName = {};
    for (const c of mappedCats) {
      const key = (c.name || 'Uncategorized').toLowerCase();
      if (!catByName[key]) catByName[key] = { id: c.id, name: c.name, catIds: [c.id] };
      else catByName[key].catIds.push(c.id);
    }

    const result = Object.values(catByName).map(c => ({
      ...c,
      items: mappedItems.filter(i => c.catIds.includes(i.category_id)),
    }));
    result.push({ id: null, name: 'Uncategorized', items: mappedItems.filter(i => !i.category_id) });

    // Count unassigned for frontend
    const unassignedCount = mappedItems.filter(i => i._unassigned).length;
    const response = result.filter(c => c.items.length > 0);
    res.json({ groups: response, unassigned_count: unassignedCount, total_count: mappedItems.length });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/menu/unassigned — items not assigned to any branch
router.get('/menu/unassigned', async (req, res) => {
  try {
    const items = await col('menu_items').find({
      restaurant_id: req.restaurantId,
      $or: [{ branch_id: null }, { branch_id: { $exists: false } }],
    }).sort({ name: 1 }).toArray();
    res.json(mapIds(items));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.get('/branches/:branchId/menu', async (req, res) => {
  try {
    // The frontend menu picker passes two sentinel branchIds — '__all__'
    // (every item the restaurant owns) and '__unassigned__' (items
    // whose branch_id is null/missing). They aren't real branches, so
    // they bypass _assertBranchOwnedBy; tenant isolation is preserved
    // by scoping the resulting filter to req.restaurantId.
    const branchIdParam = req.params.branchId;
    const isAllSentinel = branchIdParam === '__all__';
    const isUnassignedSentinel = branchIdParam === '__unassigned__';

    if (!isAllSentinel && !isUnassignedSentinel) {
      // [TENANT] Verify branch ownership before listing — without this check
      // any restaurant could read another restaurant's full menu (with prices,
      // descriptions, internal availability state) by guessing branchId.
      const branch = await _assertBranchOwnedBy(branchIdParam, req.restaurantId);
      if (!branch) return res.status(404).json({ error: 'Branch not found' });
    }

    let menuFilter;
    if (isAllSentinel) {
      menuFilter = { restaurant_id: req.restaurantId };
    } else if (isUnassignedSentinel) {
      menuFilter = {
        restaurant_id: req.restaurantId,
        $or: [{ branch_id: null }, { branch_id: { $exists: false } }],
      };
    } else {
      menuFilter = { branch_id: branchIdParam };
    }

    const [cats, items] = await Promise.all([
      col('menu_categories').find({ branch_id: branchIdParam }).sort({ sort_order: 1 }).toArray(),
      col('menu_items').find(menuFilter).sort({ sort_order: 1, name: 1 }).toArray(),
    ]);
    const mappedCats  = mapIds(cats);
    const mappedItems = mapIds(items);
    const result = mappedCats.map(c => ({ ...c, items: mappedItems.filter(i => i.category_id === c.id) }));
    result.push({ id: null, name: 'Uncategorized', items: mappedItems.filter(i => !i.category_id) });
    res.json(result.filter(c => c.items.length > 0));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.post('/branches/:branchId/menu', requirePermission('manage_menu'), async (req, res) => {
  try {
    // [TENANT] Verify branch ownership BEFORE inserting — otherwise an attacker
    // could create menu items inside another restaurant's branch (the inserted
    // doc would carry the attacker's restaurant_id but the victim's branch_id,
    // and the victim's menu listing — which filters by branch_id — would show
    // the phantom item).
    const branch = await _assertBranchOwnedBy(req.params.branchId, req.restaurantId);
    if (!branch) return res.status(404).json({ error: 'Branch not found' });

    const {
      name, description, priceRs, categoryId, foodType, imageUrl,
      isBestseller, sortOrder,
      itemGroupId, variantType, variantValue,
      // New Meta 29-column fields
      size, salePriceRs, salePriceEffectiveDate,
      brand, googleProductCategory, fbProductCategory,
      link, quantityToSellOnFacebook, productTags,
      gender, color, ageGroup, material, pattern,
      shipping, shippingWeight, videoUrl, videoTag,
      gtin, style,
    } = req.body;
    if (!name || !priceRs) return res.status(400).json({ error: 'name and priceRs required' });

    const branchSlug = await getBranchSlug(req.params.branchId);
    const sizeVal = size || variantValue || null;
    const retailerId = makeRetailerId(branchSlug, name, sizeVal);
    const autoGroupId = sizeVal ? makeItemGroupId(branchSlug, name) : null;
    const pricePaise = Math.round(parseFloat(priceRs) * 100);
    const now = new Date();
    const itemId = newId();
    const item = {
      _id: itemId,
      restaurant_id: req.restaurantId,
      branch_id: req.params.branchId,
      category_id: categoryId || null,
      name,
      description: description || name, // Meta requires non-empty description
      price_paise: pricePaise,
      retailer_id: retailerId,
      image_url: imageUrl || null,
      food_type: foodType || 'veg',
      is_bestseller: isBestseller || false,
      is_available: true,
      sort_order: sortOrder || 0,
      item_group_id: itemGroupId || autoGroupId || null,
      variant_type: variantType || null,
      variant_value: variantValue || null,
      // Meta 29-column fields
      size: size || variantValue || null,
      sale_price_paise: salePriceRs ? Math.round(parseFloat(salePriceRs) * 100) : null,
      sale_price_effective_date: salePriceEffectiveDate || null,
      brand: brand || null,
      google_product_category: googleProductCategory || 'Food, Beverages & Tobacco > Food Items',
      fb_product_category: fbProductCategory || 'Food & Beverages > Prepared Food',
      link: link || null,
      quantity_to_sell_on_facebook: quantityToSellOnFacebook || null,
      product_tags: Array.isArray(productTags) ? productTags : (productTags ? [productTags] : []),
      gender: gender || null,
      color: color || null,
      age_group: ageGroup || null,
      material: material || null,
      pattern: pattern || null,
      shipping: shipping || null,
      shipping_weight: shippingWeight || null,
      video_url: videoUrl || null,
      video_tag: videoTag || null,
      gtin: gtin || null,
      style: style || null,
      catalog_sync_status: 'pending',
      catalog_synced_at: null,
      created_at: now,
      updated_at: now,
    };
    await col('menu_items').insertOne(item);
    memcache.del(`branch:${req.body.branchId}:menu`);

    await col('restaurants').updateOne(
      { _id: req.restaurantId },
      [{ $set: { onboarding_step: { $max: ['$onboarding_step', 4] } } }]
    );

    queueSync(req.restaurantId, 'branch', [req.params.branchId]);

    res.status(201).json(mapId(item));

    log({
      actorType: 'restaurant', actorId: String(req.userId || req.restaurantId), actorName: req.userRole || null,
      action: 'menu.item_added', category: 'menu',
      description: `Added menu item "${name}"`,
      restaurantId: req.restaurantId || req.restaurant?._id,
      branchId: req.params.branchId || null,
      resourceType: 'menu_item', resourceId: itemId,
      severity: 'info',
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.put('/menu/:itemId', requirePermission('manage_menu'), async (req, res) => {
  try {
    // [TENANT] Verify item ownership BEFORE accepting any update. Without
    // this check any restaurant could rename / re-price / change availability
    // on any other restaurant's menu items by guessing item IDs.
    const ownedItem = await _assertMenuItemOwnedBy(req.params.itemId, req.restaurantId);
    if (!ownedItem) return res.status(404).json({ error: 'Menu item not found' });

    const { name, description, priceRs, imageUrl, isAvailable, isBestseller,
            itemGroupId, variantType, variantValue,
            // New Meta 29-column fields
            size, salePriceRs, salePriceEffectiveDate,
            brand, googleProductCategory, fbProductCategory,
            link, quantityToSellOnFacebook, productTags,
            gender, color, ageGroup, material, pattern,
            shipping, shippingWeight, videoUrl, videoTag,
            gtin, style,
    } = req.body;

    const onlyAvailability = isAvailable !== undefined &&
      name === undefined && description === undefined && priceRs === undefined &&
      imageUrl === undefined && isBestseller === undefined &&
      itemGroupId === undefined && variantType === undefined && variantValue === undefined &&
      size === undefined && salePriceRs === undefined && productTags === undefined;

    if (onlyAvailability) {
      catalog.setItemAvailability(req.params.itemId, isAvailable)
        .catch(err => logger.error({ err, itemId: req.params.itemId }, 'Menu availability sync failed'));

      log({ actorType: 'restaurant', actorId: String(req.restaurantId), actorName: req.restaurant?.business_name || 'Restaurant', action: 'menu.availability_toggled', category: 'menu', description: `Toggled menu item availability`, restaurantId: String(req.restaurantId), resourceType: 'menu_item', resourceId: req.params.itemId, severity: 'info' });
      return res.json({ success: true });
    }

    const $set = { updated_at: new Date(), catalog_sync_status: 'pending' };
    if (name        !== undefined) $set.name          = name;
    if (description !== undefined) $set.description   = description;
    if (priceRs     !== undefined) $set.price_paise   = Math.round(parseFloat(priceRs) * 100);
    if (imageUrl    !== undefined) $set.image_url     = imageUrl;
    if (isBestseller!== undefined) $set.is_bestseller = isBestseller;
    if (itemGroupId !== undefined) $set.item_group_id = itemGroupId || null;
    if (variantType !== undefined) $set.variant_type  = variantType || null;
    if (variantValue!== undefined) $set.variant_value = variantValue || null;
    if (isAvailable !== undefined) $set.is_available  = isAvailable;
    // Meta 29-column fields — partial update
    if (size                    !== undefined) $set.size = size || null;
    if (salePriceRs             !== undefined) $set.sale_price_paise = salePriceRs ? Math.round(parseFloat(salePriceRs) * 100) : null;
    if (salePriceEffectiveDate  !== undefined) $set.sale_price_effective_date = salePriceEffectiveDate || null;
    if (brand                   !== undefined) $set.brand = brand || null;
    if (googleProductCategory   !== undefined) $set.google_product_category = googleProductCategory || null;
    if (fbProductCategory       !== undefined) $set.fb_product_category = fbProductCategory || null;
    if (link                    !== undefined) $set.link = link || null;
    if (quantityToSellOnFacebook!== undefined) $set.quantity_to_sell_on_facebook = quantityToSellOnFacebook || null;
    if (productTags             !== undefined) $set.product_tags = Array.isArray(productTags) ? productTags : (productTags ? [productTags] : []);
    if (gender                  !== undefined) $set.gender = gender || null;
    if (color                   !== undefined) $set.color = color || null;
    if (ageGroup                !== undefined) $set.age_group = ageGroup || null;
    if (material                !== undefined) $set.material = material || null;
    if (pattern                 !== undefined) $set.pattern = pattern || null;
    if (shipping                !== undefined) $set.shipping = shipping || null;
    if (shippingWeight          !== undefined) $set.shipping_weight = shippingWeight || null;
    if (videoUrl                !== undefined) $set.video_url = videoUrl || null;
    if (videoTag                !== undefined) $set.video_tag = videoTag || null;
    if (gtin                    !== undefined) $set.gtin = gtin || null;
    if (style                   !== undefined) $set.style = style || null;

    if (Object.keys($set).length === 1) return res.json({ success: true }); // only updated_at

    // [TENANT] Defence in depth: pin branch_id from the verified item so the
    // update can NEVER touch a doc outside this restaurant, even if the
    // top-of-handler check is removed by a future refactor.
    const updated = await col('menu_items').findOneAndUpdate(
      { _id: req.params.itemId, branch_id: ownedItem.branch_id },
      { $set },
      { returnDocument: 'after' }
    );
    if (updated) {
      queueSync(req.restaurantId, 'branch', [updated.branch_id]);

      // Mark compressed catalog as stale if commerce-identity fields changed
      const commerceFields = ['name', 'price_paise', 'size', 'variant_type', 'variant_value', 'food_type', 'image_url', 'product_tags'];
      const hasCommerceChange = commerceFields.some(f => $set[f] !== undefined);
      if (hasCommerceChange) {
        col('catalog_compressed_skus').updateMany(
          { restaurantId: req.restaurantId, active: true },
          { $set: { syncState: 'stale', updated_at: new Date() } }
        ).catch(() => {}); // fire-and-forget
      }
    }
    res.json({ success: true });

    log({
      actorType: 'restaurant', actorId: String(req.userId || req.restaurantId), actorName: req.userRole || null,
      action: 'menu.item_updated', category: 'menu',
      description: `Updated menu item ${req.params.itemId}`,
      restaurantId: req.restaurantId || req.restaurant?._id,
      branchId: updated?.branch_id || null,
      resourceType: 'menu_item', resourceId: req.params.itemId,
      severity: 'info',
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.delete('/menu/:itemId', requirePermission('manage_menu'), async (req, res) => {
  try {
    // [TENANT] Verify the item belongs to this restaurant. 404 (not 403) so
    // attackers cannot probe whether an ID exists in another tenant.
    const item = await _assertMenuItemOwnedBy(req.params.itemId, req.restaurantId);
    if (!item) return res.status(404).json({ error: 'Menu item not found' });

    await col('menu_items').deleteOne({ _id: item._id });
    if (item.branch_id) memcache.del(`branch:${item.branch_id}:menu`);

    catalog.deleteProduct(item, item.branch_id)
      .catch(err => logger.error({ err, itemId: req.params.itemId }, 'Menu delete sync failed'));
    res.json({ success: true });

    log({
      actorType: 'restaurant', actorId: String(req.userId || req.restaurantId), actorName: req.userRole || null,
      action: 'menu.item_deleted', category: 'menu',
      description: `Deleted menu item ${req.params.itemId}${item ? ` ("${item.name}")` : ''}`,
      restaurantId: req.restaurantId || req.restaurant?._id,
      branchId: item?.branch_id || null,
      resourceType: 'menu_item', resourceId: req.params.itemId,
      severity: 'info',
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.post('/menu/bulk-delete', requirePermission('manage_menu'), async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });

    // Fetch full docs BEFORE deleteMany — we need retailer_id + branch_id to
    // fire explicit DELETEs to Meta. Project the fields actually used so
    // large menus don't drag the whole document set into memory.
    const items = await col('menu_items')
      .find(
        { _id: { $in: ids } },
        { projection: { _id: 1, retailer_id: 1, branch_id: 1, branch_ids: 1 } }
      )
      .toArray();
    if (!items.length) return res.json({ deleted: 0 });

    await col('menu_items').deleteMany({ _id: { $in: ids } });

    const branchIds = [...new Set(items.map(i => i.branch_id).filter(Boolean))];
    branchIds.forEach(bid => memcache.del(`branch:${bid}:menu`));

    // Fire-and-forget explicit DELETE batches to Meta, one call per branch.
    // Replaces the prior queueSync() re-sync approach — that left the window
    // where Meta still served the deleted items until the next full sync.
    for (const bid of branchIds) {
      const bItems = items.filter(i => i.branch_id === bid);
      if (!bItems.length) continue;
      catalog.bulkDeleteProducts(bItems, bid)
        .catch(err => logger.error({ err, branchId: bid, count: bItems.length }, 'bulkDeleteProducts failed'));
    }

    res.json({ deleted: items.length });

    log({
      actorType: 'restaurant', actorId: String(req.userId || req.restaurantId), actorName: req.userRole || null,
      action: 'menu.bulk_deleted', category: 'menu',
      description: `Bulk deleted ${items.length} menu items`,
      restaurantId: req.restaurantId, severity: 'info',
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/menu/normalize-preview — preview column mapping for a file
router.post('/menu/normalize-preview', async (req, res) => {
  try {
    const { headers, sampleRows } = req.body;
    if (!headers || !sampleRows) return res.status(400).json({ error: 'headers and sampleRows required' });
    const { normalizeMenuData } = require('../services/menuNormalizer');
    const result = normalizeMenuData(headers, sampleRows);
    res.json({ mappedColumns: result.mappedColumns, unmappedColumns: result.unmappedColumns, warnings: result.warnings, previewRows: result.normalizedRows.slice(0, 10) });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// PATCH /api/restaurant/menu/bulk-availability — toggle availability for multiple items
router.patch('/menu/bulk-availability', requirePermission('manage_menu'), async (req, res) => {
  try {
    const { available, branch_id, item_ids } = req.body;
    if (available === undefined) return res.status(400).json({ error: 'available (true/false) required' });

    const filter = { restaurant_id: req.restaurantId };
    if (branch_id) filter.branch_id = branch_id;
    if (Array.isArray(item_ids) && item_ids.length) filter._id = { $in: item_ids };

    const result = await col('menu_items').updateMany(filter, {
      $set: { is_available: !!available, updated_at: new Date(), catalog_sync_status: 'pending' },
    });

    // Fetch updated items for Meta sync payload
    const items = await col('menu_items').find(filter, { projection: { retailer_id: 1, is_available: 1, branch_id: 1 } }).toArray();
    const syncItems = items.filter(i => i.retailer_id).map(i => ({ retailer_id: i.retailer_id, is_available: i.is_available }));

    // Clear MPM cache for affected branches
    if (branch_id) {
      memcache.del(`branch:${branch_id}:menu`);
    } else {
      const affectedBranches = [...new Set(items.map(i => i.branch_id).filter(Boolean))];
      affectedBranches.forEach(bid => memcache.del(`branch:${bid}:menu`));
    }

    res.json({ success: true, updated_count: result.modifiedCount, is_available: !!available, meta_sync: 'queued' });

    // Fire-and-forget: sync to Meta
    if (syncItems.length) {
      catalog.syncBulkAvailability(req.restaurantId, syncItems)
        .catch(err => logger.error({ err, restaurantId: req.restaurantId }, 'Bulk availability sync failed'));
    }

    log({
      actorType: 'restaurant', actorId: String(req.userId || req.restaurantId), actorName: req.userRole || null,
      action: 'menu.bulk_availability', category: 'menu',
      description: `Bulk ${available ? 'enabled' : 'disabled'} ${result.modifiedCount} items`,
      restaurantId: req.restaurantId, severity: 'info',
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// PATCH /api/restaurant/menu/:id/availability — dedicated lightweight availability toggle
// NOTE: Must be AFTER /menu/bulk-availability to avoid Express matching 'bulk-availability' as :id
router.patch('/menu/:id/availability', requirePermission('manage_menu'), async (req, res) => {
  try {
    const { available } = req.body;
    if (typeof available !== 'boolean') return res.status(400).json({ error: 'available (true/false) required' });

    const item = await col('menu_items').findOne({ _id: req.params.id, restaurant_id: req.restaurantId });
    if (!item) return res.status(404).json({ error: 'Menu item not found' });

    await col('menu_items').updateOne(
      { _id: req.params.id },
      { $set: { is_available: available, updated_at: new Date() } }
    );

    // Clear MPM cache so next customer gets fresh menu
    if (item.branch_id) memcache.del(`branch:${item.branch_id}:menu`);

    res.json({ success: true, item_id: req.params.id, is_available: available, meta_sync: 'queued' });

    // Fire-and-forget: sync to Meta AFTER response is sent
    catalog.syncItemAvailability(req.restaurantId, { ...item, is_available: available })
      .catch(err => logger.error({ err, itemId: req.params.id }, 'Catalog availability sync failed'));

    log({ actorType: 'restaurant', actorId: String(req.restaurantId), actorName: req.restaurant?.business_name || 'Restaurant', action: 'menu.availability_toggled', category: 'menu', description: `Toggled ${item.name} ${available ? 'available' : 'unavailable'}`, restaurantId: String(req.restaurantId), resourceType: 'menu_item', resourceId: req.params.id, severity: 'info' });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// PATCH /api/restaurant/menu/:id/availability-all-branches — toggle same dish across ALL branches
router.patch('/menu/:id/availability-all-branches', requirePermission('manage_menu'), async (req, res) => {
  try {
    const { available } = req.body;
    if (typeof available !== 'boolean') return res.status(400).json({ error: 'available (true/false) required' });

    const item = await col('menu_items').findOne({ _id: req.params.id, restaurant_id: req.restaurantId });
    if (!item) return res.status(404).json({ error: 'Menu item not found' });

    // Match same dish at all branches by name (case-insensitive) or original_retailer_id
    const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matchConditions = [{ name: { $regex: new RegExp('^' + escapeRegex(item.name) + '$', 'i') } }];
    if (item.original_retailer_id) matchConditions.push({ original_retailer_id: item.original_retailer_id });
    const matchQuery = { restaurant_id: req.restaurantId, $or: matchConditions };

    const result = await col('menu_items').updateMany(matchQuery, {
      $set: { is_available: available, updated_at: new Date(), catalog_sync_status: 'pending' },
    });

    // Cache invalidation for all affected branches
    const affectedItems = await col('menu_items').find(matchQuery, { projection: { branch_id: 1, retailer_id: 1, is_available: 1 } }).toArray();
    const affectedBranchIds = [...new Set(affectedItems.map(i => i.branch_id).filter(Boolean))];
    affectedBranchIds.forEach(bid => memcache.del(`branch:${bid}:menu`));

    res.json({ success: true, updated_count: result.modifiedCount, affected_branches: affectedBranchIds.length, is_available: available, meta_sync: 'queued' });

    // Fire-and-forget: sync to Meta
    const syncItems = affectedItems.filter(i => i.retailer_id).map(i => ({ retailer_id: i.retailer_id, is_available: i.is_available }));
    if (syncItems.length) {
      catalog.syncBulkAvailability(req.restaurantId, syncItems)
        .catch(err => logger.error({ err, restaurantId: req.restaurantId }, 'Cross-branch availability sync failed'));
    }

    log({ actorType: 'restaurant', actorId: String(req.restaurantId), actorName: req.restaurant?.business_name || 'Restaurant', action: 'menu.availability_all_branches', category: 'menu', description: `Toggled "${item.name}" ${available ? 'available' : 'unavailable'} at ${affectedBranchIds.length} branches (${result.modifiedCount} items)`, restaurantId: String(req.restaurantId), resourceType: 'menu_item', resourceId: req.params.id, severity: 'info' });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/catalog/sync-status/:handle — check items_batch processing status
router.get('/catalog/sync-status/:handle', async (req, res) => {
  try {
    const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
    const catalogId = restaurant?.meta_catalog_id;
    if (!catalogId) return res.status(404).json({ error: 'No catalog found' });
    const result = await catalog.checkSyncStatus(catalogId, req.params.handle);
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ── META COMMERCE MANAGER CSV COLUMN ALIASES ─────────────────
const META_COLUMN_ALIASES = {
  'id': 'retailer_id', 'title': 'name', 'description': 'description',
  'price': 'price', 'sale_price': 'sale_price', 'image_link': 'image_url',
  'availability': 'availability', 'brand': 'brand', 'link': 'link',
  'item_group_id': 'item_group_id', 'size': 'size',
  'google_product_category': 'google_product_category',
  'fb_product_category': 'fb_product_category',
  'quantity_to_sell_on_facebook': 'quantity_to_sell_on_facebook',
  'product_tags[0]': '_tag0', 'product_tags[1]': '_tag1',
  'sale_price_effective_date': 'sale_price_effective_date',
  'gender': 'gender', 'color': 'color', 'age_group': 'age_group',
  'material': 'material', 'pattern': 'pattern',
  'shipping': 'shipping', 'shipping_weight': 'shipping_weight',
  'video[0].url': 'video_url', 'video[0].tag[0]': 'video_tag',
  'gtin': 'gtin', 'style[0]': 'style', 'condition': '_condition',
  'custom_label_0': 'custom_label_0', 'custom_label_1': 'custom_label_1',
  'custom_label_2': 'custom_label_2', 'custom_label_3': 'custom_label_3',
  'custom_label_4': 'custom_label_4',
};

// Parse "199.00 INR" or "299" or 149 → paise integer
function _parsePriceToPaise(priceStr) {
  if (!priceStr) return null;
  if (typeof priceStr === 'number') return Math.round(priceStr * 100);
  const cleaned = String(priceStr).replace(/[^0-9.]/g, '');
  const num = parseFloat(cleaned);
  if (isNaN(num)) return null;
  return Math.round(num * 100);
}

// Parse "in stock" → true, "out of stock" → false
function _parseAvailability(val) {
  if (val === undefined || val === null) return true; // default available
  if (typeof val === 'boolean') return val;
  const str = String(val).toLowerCase().trim();
  return str === 'in stock' || str === 'true' || str === '1' || str === 'yes';
}

// Normalize CSV row keys using Meta column aliases
function _normalizeCSVRow(row) {
  const normalized = {};
  for (const [key, val] of Object.entries(row)) {
    const mapped = META_COLUMN_ALIASES[key] || key;
    normalized[mapped] = val;
  }
  // Merge tags
  const tags = [];
  if (normalized._tag0) tags.push(normalized._tag0);
  if (normalized._tag1) tags.push(normalized._tag1);
  if (Array.isArray(normalized.product_tags)) tags.push(...normalized.product_tags);
  normalized.product_tags = [...new Set(tags)];
  delete normalized._tag0;
  delete normalized._tag1;
  delete normalized._condition;

  // Parse Meta price format → paise
  if (normalized.price && typeof normalized.price === 'string' && normalized.price.includes('INR')) {
    normalized.price_paise = _parsePriceToPaise(normalized.price);
    normalized.price = null; // clear so main parser doesn't re-process
  }
  if (normalized.sale_price) {
    normalized.sale_price_paise = _parsePriceToPaise(normalized.sale_price);
    delete normalized.sale_price;
  }

  // Parse availability
  if (normalized.availability !== undefined) {
    normalized.is_available = _parseAvailability(normalized.availability);
    delete normalized.availability;
  }

  // Auto-generate retailer_id for variants using canonical slugify
  if (normalized.item_group_id && normalized.size && !normalized.retailer_id) {
    normalized.retailer_id = `${normalized.item_group_id}-${slugify(normalized.size, 15)}`;
  }

  return normalized;
}

// POST /api/restaurant/branches/:branchId/menu/csv
// Bulk upsert menu items from a parsed CSV (supports Meta Commerce Manager template)
router.post('/branches/:branchId/menu/csv', async (req, res) => {
  try {
    // [TENANT] Verify branch ownership BEFORE doing any work — the
    // route previously only checked when a branch column was present
    // in the file, leaving callers without that column able to POST
    // items into another restaurant's branch by guessing branchId.
    // Hoisting the check here also gates the menu_uploads archive
    // insertion below so unauthorized POSTs leave no trace.
    const pickedBranch = await col('branches').findOne({
      _id: req.params.branchId,
      restaurant_id: req.restaurantId,
    });
    if (!pickedBranch) return res.status(404).json({ error: 'Branch not found' });

    const { items, filename } = req.body;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'items array is required' });
    }

    // Archive raw upload
    col('menu_uploads').insertOne({
      _id: newId(), restaurant_id: req.restaurantId, uploaded_by: req.userId || null,
      filename: filename || 'upload.csv', row_count: items.length, branch_id: req.params.branchId,
      raw_headers: items[0] ? Object.keys(items[0]) : [], upload_status: 'processing', created_at: new Date(),
    }).catch(() => {});

    const branchId = req.params.branchId;
    const results = { added: 0, skipped: 0, errors: [] };

    // ── Branch-column row filter ────────────────────────────────
    // The frontend now strictly pins every upload to the dropdown's
    // branchId, but a user can still upload a multi-branch file (e.g.
    // a Meta export with one row per branch). When that file carries
    // a branch/outlet column, we keep only rows whose branch value
    // matches the picked branch's name or slug — empty values default
    // to the picked branch. Non-matching rows are reported back via
    // skipped_non_matching_branch so the UI can surface the count.
    const BRANCH_COLUMN_ALIASES_LOCAL = ['branch', 'outlet', 'location', 'branch_name', 'outlet_name', 'store', 'store_name'];
    const firstRow = items[0] || {};
    const branchCol = Object.keys(firstRow).find(k =>
      BRANCH_COLUMN_ALIASES_LOCAL.includes(k.toLowerCase().trim())
    );

    let filteredItems = items;
    let skippedNonMatchingCount = 0;

    if (branchCol) {
      // pickedBranch is already loaded at the top of the handler for
      // the tenant check, so we reuse it here for name/slug matching
      // instead of re-querying.
      const targetName = (pickedBranch.name || '').toLowerCase().trim();
      const targetSlug = (pickedBranch.branch_slug || '').toLowerCase().trim();

      filteredItems = items.filter(row => {
        const rowBranch = String(row[branchCol] || '').toLowerCase().trim();
        if (!rowBranch) return true; // empty value → applies to picked branch
        const matches = rowBranch === targetName || rowBranch === targetSlug;
        if (!matches) skippedNonMatchingCount += 1;
        return matches;
      });

      if (filteredItems.length === 0) {
        return res.status(400).json({
          error: `No rows in file match selected branch "${pickedBranch.name}". File contains other branch names — pick the correct target branch or remove the branch column.`,
        });
      }
    }

    // ── Pre-fetch branch slug ONCE (not per row) ──
    const csvBranchSlug = await getBranchSlug(branchId);
    const now = new Date();

    // ── Batch category lookup + creation ──
    const catNames = [...new Set(filteredItems.map(r => { const n = _normalizeCSVRow(r); return sanitizeCsvString(n.category || n.cat); }).filter(Boolean))];
    const categoryCache = {};
    if (catNames.length) {
      const existingCats = await col('menu_categories').find({ branch_id: branchId, name: { $in: catNames } }).toArray();
      for (const c of existingCats) categoryCache[c.name] = String(c._id);
      const newCatNames = catNames.filter(n => !categoryCache[n]);
      if (newCatNames.length) {
        const newCatDocs = newCatNames.map(n => ({ _id: newId(), branch_id: branchId, name: n, sort_order: 0, created_at: now }));
        await col('menu_categories').insertMany(newCatDocs).catch(() => {});
        for (const d of newCatDocs) categoryCache[d.name] = String(d._id);
      }
    }

    // ── Build bulkWrite operations + track variant names ──
    const bulkOps = [];
    const nameTracker = {}; // lowercase name → [{ retailerId, hasGroupId }]

    for (const [i, rawRow] of filteredItems.entries()) {
      const row = _normalizeCSVRow(rawRow);
      const rowNum = i + 2;
      const name = sanitizeCsvString(row.name);
      const priceRaw = row.price_paise ? null : (row.price || row.price_rs || '').toString().replace(/[₹,\s]/g, '');
      const price = row.price_paise ? row.price_paise / 100 : parseFloat(priceRaw);

      if (!name) { results.errors.push(`Row ${rowNum}: missing name`); results.skipped++; continue; }
      if (isNaN(price) || price <= 0) { results.errors.push(`Row ${rowNum} "${name}": invalid price "${row.price}"`); results.skipped++; continue; }

      const categoryName = sanitizeCsvString(row.category || row.cat) || '';
      const categoryId = categoryName ? (categoryCache[categoryName] || null) : null;
      const validTypes = ['veg', 'non_veg', 'vegan', 'egg'];
      let rawType = (row.food_type || row.type || '').toLowerCase().trim().replace(/[\s\-]+/g, '_');
      if (!rawType) rawType = 'veg';
      const foodType = validTypes.includes(rawType) ? rawType : 'veg';
      const isBestseller = ['true', 'yes', '1'].includes((row.is_bestseller || '').toLowerCase());
      const imageUrl = (row.image_url || row.image || '').trim() || null;
      const pricePaise = row.price_paise || Math.round(price * 100);
      const sizeVal = row.size || null;
      const originalRetailerId = row.retailer_id || null;
      const retailerId = makeRetailerId(csvBranchSlug, name, sizeVal);
      const autoGroupId = sizeVal ? makeItemGroupId(csvBranchSlug, name) : null;

      const csvTags = [];
      if (row['product_tags[0]'] || row.product_tag_0) csvTags.push(row['product_tags[0]'] || row.product_tag_0);
      if (row['product_tags[1]'] || row.product_tag_1) csvTags.push(row['product_tags[1]'] || row.product_tag_1);
      if (row.product_tags && Array.isArray(row.product_tags)) csvTags.push(...row.product_tags);
      if (csvTags.length < 2) {
        if (!csvTags[0]) { const typeLabel = { veg: 'Veg', non_veg: 'Non-Veg', egg: 'Egg', vegan: 'Vegan' }; csvTags[0] = typeLabel[foodType] || 'Veg'; }
        if (!csvTags[1] && categoryName) csvTags[1] = categoryName;
      }

      bulkOps.push({
        updateOne: {
          filter: { retailer_id: retailerId },
          update: {
            $set: {
              restaurant_id: req.restaurantId, branch_id: branchId, category_id: categoryId,
              name, description: (row.description || row.desc || '').trim() || name,
              price_paise: pricePaise, image_url: imageUrl, food_type: foodType, is_bestseller: isBestseller,
              item_group_id: row.item_group_id || autoGroupId || null, size: sizeVal,
              sale_price_paise: row.sale_price_paise || null, sale_price_effective_date: row.sale_price_effective_date || null,
              brand: row.brand || null,
              google_product_category: row.google_product_category || 'Food, Beverages & Tobacco > Food Items',
              fb_product_category: row.fb_product_category || 'Food & Beverages > Prepared Food',
              link: row.link || null, quantity_to_sell_on_facebook: row.quantity_to_sell_on_facebook || null,
              product_tags: csvTags.length ? [...new Set(csvTags)] : [],
              gender: row.gender || null, color: row.color || null, age_group: row.age_group || null,
              material: row.material || null, pattern: row.pattern || null,
              shipping: row.shipping || null, shipping_weight: row.shipping_weight || null,
              video_url: row.video_url || row['video[0].url'] || null,
              video_tag: row.video_tag || row['video[0].tag[0]'] || null,
              gtin: row.gtin || null, style: row.style || row['style[0]'] || null,
              catalog_sync_status: 'pending', updated_at: now,
            },
            $setOnInsert: { _id: newId(), retailer_id: retailerId, original_retailer_id: originalRetailerId, is_available: true, sort_order: 0, catalog_synced_at: null, created_at: now },
          },
          upsert: true,
        },
      });

      // Track names for variant auto-detection (no extra DB read)
      const nameKey = name.toLowerCase().trim();
      if (!nameTracker[nameKey]) nameTracker[nameKey] = [];
      nameTracker[nameKey].push({ retailerId, hasGroupId: !!(row.item_group_id || autoGroupId) });
    }

    // ── Execute bulkWrite in chunks of 500 ──
    const CHUNK = 500;
    for (let c = 0; c < bulkOps.length; c += CHUNK) {
      try {
        const chunk = bulkOps.slice(c, c + CHUNK);
        const bwResult = await col('menu_items').bulkWrite(chunk, { ordered: false });
        results.added += (bwResult.upsertedCount || 0) + (bwResult.modifiedCount || 0);
      } catch (bwErr) {
        if (bwErr.result) results.added += (bwErr.result.nUpserted || 0) + (bwErr.result.nModified || 0);
        const writeErrors = bwErr.writeErrors || [];
        for (const we of writeErrors) {
          results.errors.push(`Bulk write error at index ${we.index}: ${we.errmsg || we.message}`);
          results.skipped++;
        }
      }
    }

    // ── Auto-detect variants from tracked names (no extra DB read) ──
    try {
      const variantOps = [];
      for (const [, trackedItems] of Object.entries(nameTracker)) {
        if (trackedItems.length <= 1) continue;
        const needsGroupId = trackedItems.filter(it => !it.hasGroupId);
        if (!needsGroupId.length) continue;
        const sampleRetailerId = trackedItems[0].retailerId;
        const itemSlug = sampleRetailerId.replace(new RegExp('^' + csvBranchSlug + '-'), '').replace(/-[^-]+$/, '');
        const groupId = `${csvBranchSlug}-${itemSlug}`;
        const rids = needsGroupId.map(it => it.retailerId);
        variantOps.push({ updateMany: { filter: { retailer_id: { $in: rids } }, update: { $set: { item_group_id: groupId, catalog_sync_status: 'pending' } } } });
      }
      if (variantOps.length) await col('menu_items').bulkWrite(variantOps, { ordered: false });
    } catch (e) { logger.warn({ err: e, branchId }, 'CSV auto-group variants failed'); }

    await col('restaurants').updateOne(
      { _id: req.restaurantId },
      [{ $set: { onboarding_step: { $max: ['$onboarding_step', 4] } } }]
    );

    // Auto-create product sets, then queue debounced catalog sync.
    // Sentinel branchIds ('__all__' / '__unassigned__') flow through
    // here when a user uploads against the menu picker's virtual
    // buckets — autoCreateProductSets() does a real branch lookup
    // and would throw "Branch not found" (catalog.js:1475), so we
    // skip it for sentinels. queueSync also takes only real branch
    // IDs so it's gated identically.
    if (branchId && branchId !== '__all__' && branchId !== '__unassigned__') {
      catalog.autoCreateProductSets(branchId)
        .catch(err => logger.error({ err, branchId }, 'Auto-create product sets after CSV upload failed'));
      queueSync(req.restaurantId, 'branch', [branchId]);
    }

    // total = original row count (so the UI can show "X rows in file,
    // Y added, Z skipped (branch mismatch)"). skipped_non_matching_branch
    // is included only when the branch-column filter dropped rows.
    const responsePayload = { success: true, ...results, total: items.length };
    if (skippedNonMatchingCount > 0) {
      responsePayload.skipped_non_matching_branch = skippedNonMatchingCount;
    }
    res.json(responsePayload);

    log({ actorType: 'restaurant', actorId: String(req.restaurantId), actorName: req.restaurant?.business_name || 'Restaurant', action: 'menu.bulk_upload', category: 'menu', description: `Bulk uploaded menu items`, restaurantId: String(req.restaurantId), severity: 'info' });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/menu/csv — Multi-branch bulk upload
// Detects a branch/outlet column and routes items to matching branches automatically.
// If no branch column found, requires branchId in body or falls back to first branch.
const BRANCH_COLUMN_ALIASES = ['branch', 'outlet', 'location', 'branch_name', 'outlet_name', 'store', 'store_name'];

router.post('/menu/csv', async (req, res) => {
  try {
    const { items, branchId: defaultBranchId, filename } = req.body;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'items array is required' });
    }

    // Archive raw upload
    col('menu_uploads').insertOne({
      _id: newId(), restaurant_id: req.restaurantId, uploaded_by: req.userId || null,
      filename: filename || 'upload.csv', row_count: items.length, multi_branch: true,
      raw_headers: items[0] ? Object.keys(items[0]) : [], upload_status: 'processing', created_at: new Date(),
    }).catch(() => {});

    // Detect branch column — match against the standard aliases only.
    // custom_label_2/3 used to be a fallback here, but those are
    // arbitrary Meta catalog labels with no fixed semantics; treating
    // them as branch info silently mis-routed Meta-export uploads.
    // Branch routing now relies on three explicit signals: a header
    // alias match, section-header rows (preprocessed below), or
    // defaultBranchId from the frontend.
    const firstRow = items[0];
    let branchCol = Object.keys(firstRow).find(k =>
      BRANCH_COLUMN_ALIASES.includes(k.toLowerCase().trim())
    );

    // Section-header detection: a row with only 1–2 non-empty cells whose
    // first non-empty value is a non-numeric short string is treated as
    // a branch label that applies to every subsequent row until the next
    // header. The header row itself is dropped from the upload. We tag
    // qualifying rows with a virtual __section_branch__ column and, if
    // no real branchCol was found, point branchCol at this virtual key
    // so the existing grouping logic below "just works".
    let sectionHeadersFound = false;
    let currentSectionBranch = null;
    const processedItems = [];
    for (const row of items) {
      const values = Object.values(row);
      const nonEmpty = values.filter(v => v !== '' && v != null && String(v).trim() !== '');
      if (nonEmpty.length > 0 && nonEmpty.length <= 2) {
        const headerVal = String(nonEmpty[0]).trim();
        const isNumeric = !isNaN(parseFloat(headerVal));
        const looksLikeHeader = !isNumeric && headerVal.length >= 2 && headerVal.length <= 60;
        if (looksLikeHeader) {
          currentSectionBranch = headerVal.replace(/^(branch|outlet|location|store)[\s:\-]+/i, '').trim();
          sectionHeadersFound = true;
          continue; // do not include header row as an item
        }
      }
      if (currentSectionBranch && (!branchCol || !row[branchCol])) {
        row.__section_branch__ = currentSectionBranch;
      }
      processedItems.push(row);
    }

    if (sectionHeadersFound && !branchCol) {
      branchCol = '__section_branch__';
    }

    // Refuse the upload when we have NO branch signal at all — without
    // a default, a header column, or section headers, every row would
    // silently land in allBranches[0] and the user would have to chase
    // down where their items went.
    if (!defaultBranchId && !branchCol && !sectionHeadersFound) {
      return res.status(400).json({
        error: 'No branch information found. Add a branch/outlet column to the file, use section header rows, or select a specific target branch.',
      });
    }

    // Load all branches for this restaurant
    let allBranches = await col('branches').find({ restaurant_id: req.restaurantId }).toArray();

    // Soft-assignment policy: items whose XLSX branch name doesn't match a
    // DB branch are routed to the UNASSIGNED bucket (branch_id: null) so the
    // upload always succeeds. Previously this returned HTTP 400 — that
    // forced users to either rename branches or recreate them, neither of
    // which is the right default. The dashboard's Unassigned filter is the
    // recovery path.
    if (!allBranches.length) return res.status(400).json({ error: 'No branches found. Create a branch first.' });

    // Build branch name→id map (case-insensitive, trimmed, also by slug)
    const branchMap = {};
    for (const b of allBranches) {
      branchMap[(b.name || '').toLowerCase().trim()] = String(b._id);
      if (b.branch_slug) branchMap[b.branch_slug.toLowerCase()] = String(b._id);
    }

    // Group items by branch. Items whose branch name from the upload
    // doesn't match any DB branch land in the UNASSIGNED_BUCKET sentinel,
    // which is translated to branch_id: null at write time below.
    const UNASSIGNED_BUCKET = '__UNASSIGNED__';
    const branchGroups = {}; // branchId (or sentinel) → items[]
    const unknownBranchNames = new Set();
    let unassignedItemCount = 0;

    for (const row of processedItems) {
      let targetBranchId = defaultBranchId;

      if (branchCol && row[branchCol]) {
        const branchName = String(row[branchCol]).toLowerCase().trim();
        const matched = branchMap[branchName];
        if (matched) {
          targetBranchId = matched;
        } else {
          // Fuzzy match: check if branch name contains or is contained by any branch
          const fuzzy = Object.entries(branchMap).find(([name]) =>
            name.includes(branchName) || branchName.includes(name)
          );
          if (fuzzy) {
            targetBranchId = fuzzy[1];
          } else {
            unknownBranchNames.add(String(row[branchCol]).trim());
            targetBranchId = UNASSIGNED_BUCKET;
            unassignedItemCount += 1;
          }
        }
      } else if (!targetBranchId) {
        targetBranchId = String(allBranches[0]._id);
      }

      if (!branchGroups[targetBranchId]) branchGroups[targetBranchId] = [];
      branchGroups[targetBranchId].push(row);
    }

    // ── Pre-cache branch slugs (one DB read per branch instead of per item) ──
    const branchSlugCache = {};
    for (const b of allBranches) {
      const bid = String(b._id);
      if (b.branch_slug) { branchSlugCache[bid] = b.branch_slug; }
      else {
        const slug = slugify(b.name, 20) || bid.slice(0, 8);
        branchSlugCache[bid] = slug;
        col('branches').updateOne({ _id: b._id }, { $set: { branch_slug: slug } }).catch(() => {});
      }
    }

    // Process each branch group with batched operations
    const perBranch = [];
    let totalAdded = 0, totalSkipped = 0;
    const allErrors = [];

    for (const [bid, branchItems] of Object.entries(branchGroups)) {
      const isUnassigned = bid === UNASSIGNED_BUCKET;
      // Sentinel translates to a real null when written to MongoDB.
      const actualBranchId = isUnassigned ? null : bid;
      const branchDoc = isUnassigned ? null : allBranches.find(b => String(b._id) === bid);
      const branchResult = {
        branchId: actualBranchId,
        branchName: isUnassigned ? '(Unassigned)' : (branchDoc?.name || bid),
        added: 0,
        skipped: 0,
        errors: [],
      };
      // Categories are branch-scoped; for unassigned items we leave
      // category_id null and let the user re-categorize from the dashboard
      // after they create/rename the missing branch.
      const mbBranchSlug = isUnassigned ? 'unassigned' : (branchSlugCache[bid] || 'branch');

      // ── Pre-batch category lookups for this branch ──
      const catNames = [...new Set(branchItems.map(r => { const n = _normalizeCSVRow(r); return sanitizeCsvString(n.category || n.cat); }).filter(Boolean))];
      const catCache = {};
      if (!isUnassigned && catNames.length) {
        const existingCats = await col('menu_categories').find({ branch_id: bid, name: { $in: catNames } }).toArray();
        for (const c of existingCats) catCache[c.name] = String(c._id);
        const newCatNames = catNames.filter(n => !catCache[n]);
        if (newCatNames.length) {
          const newCatDocs = newCatNames.map(n => ({ _id: newId(), branch_id: bid, name: n, sort_order: 0, created_at: new Date() }));
          await col('menu_categories').insertMany(newCatDocs).catch(() => {});
          for (const d of newCatDocs) catCache[d.name] = String(d._id);
        }
      }

      // ── Build bulkWrite operations + track variant names + track retailer_ids ──
      const bulkOps = [];
      const nameTracker = {}; // lowercase name → [{ retailerId, hasGroupId }]
      const touchedRetailerIds = new Set(); // for stale detection
      const now = new Date();

      for (const [i, rawRow] of branchItems.entries()) {
        const row = _normalizeCSVRow(rawRow);
        const rowNum = i + 2;
        const name = sanitizeCsvString(row.name);
        const priceRaw = row.price_paise ? null : (row.price || row.price_rs || '').toString().replace(/[₹,\s]/g, '');
        const price = row.price_paise ? row.price_paise / 100 : parseFloat(priceRaw);

        if (!name) { branchResult.errors.push(`Row ${rowNum}: missing name`); branchResult.skipped++; continue; }
        if (isNaN(price) || price <= 0) { branchResult.errors.push(`Row ${rowNum} "${name}": invalid price "${row.price}"`); branchResult.skipped++; continue; }

        const categoryName = sanitizeCsvString(row.category || row.cat) || '';
        const categoryId = categoryName ? (catCache[categoryName] || null) : null;
        const validTypes = ['veg', 'non_veg', 'vegan', 'egg'];
        let rawType = (row.food_type || row.type || '').toLowerCase().trim().replace(/[\s\-]+/g, '_');
        if (!rawType) rawType = 'veg';
        const foodType = validTypes.includes(rawType) ? rawType : 'veg';
        const isBestseller = ['true', 'yes', '1'].includes((row.is_bestseller || '').toLowerCase());
        const imageUrl = (row.image_url || row.image || '').trim() || null;
        const pricePaise = row.price_paise || Math.round(price * 100);
        const mbSizeVal = row.size || null;
        const mbOriginalRetailerId = row.retailer_id || null;
        const retailerId = makeRetailerId(mbBranchSlug, name, mbSizeVal);
        const mbAutoGroupId = mbSizeVal ? makeItemGroupId(mbBranchSlug, name) : null;

        const csvTags = [];
        if (row['product_tags[0]'] || row.product_tag_0) csvTags.push(row['product_tags[0]'] || row.product_tag_0);
        if (row['product_tags[1]'] || row.product_tag_1) csvTags.push(row['product_tags[1]'] || row.product_tag_1);
        if (row.product_tags && Array.isArray(row.product_tags)) csvTags.push(...row.product_tags);
        if (csvTags.length < 2) {
          if (!csvTags[0]) { const typeLabel = { veg: 'Veg', non_veg: 'Non-Veg', egg: 'Egg', vegan: 'Vegan' }; csvTags[0] = typeLabel[foodType] || 'Veg'; }
          if (!csvTags[1] && categoryName) csvTags[1] = categoryName;
        }

        bulkOps.push({
          updateOne: {
            filter: { retailer_id: retailerId },
            update: {
              $set: {
                restaurant_id: req.restaurantId,
                branch_id: actualBranchId,
                branch_name: isUnassigned ? null : (branchDoc?.name || null),
                category_id: categoryId,
                name, description: (row.description || row.desc || '').trim() || name,
                price_paise: pricePaise, image_url: imageUrl, food_type: foodType, is_bestseller: isBestseller,
                item_group_id: row.item_group_id || mbAutoGroupId || null, size: mbSizeVal,
                sale_price_paise: row.sale_price_paise || null, sale_price_effective_date: row.sale_price_effective_date || null,
                brand: row.brand || null,
                google_product_category: row.google_product_category || 'Food, Beverages & Tobacco > Food Items',
                fb_product_category: row.fb_product_category || 'Food & Beverages > Prepared Food',
                link: row.link || null, quantity_to_sell_on_facebook: row.quantity_to_sell_on_facebook || null,
                product_tags: csvTags.length ? [...new Set(csvTags)] : [],
                gender: row.gender || null, color: row.color || null, age_group: row.age_group || null,
                material: row.material || null, pattern: row.pattern || null,
                shipping: row.shipping || null, shipping_weight: row.shipping_weight || null,
                video_url: row.video_url || row['video[0].url'] || null,
                video_tag: row.video_tag || row['video[0].tag[0]'] || null,
                gtin: row.gtin || null, style: row.style || row['style[0]'] || null,
                catalog_sync_status: 'pending', updated_at: now,
              },
              $setOnInsert: { _id: newId(), retailer_id: retailerId, original_retailer_id: mbOriginalRetailerId, is_available: true, sort_order: 0, catalog_synced_at: null, created_at: now },
            },
            upsert: true,
          },
        });

        touchedRetailerIds.add(retailerId);

        // Track names for variant auto-detection
        const nameKey = name.toLowerCase().trim();
        if (!nameTracker[nameKey]) nameTracker[nameKey] = [];
        nameTracker[nameKey].push({ retailerId, hasGroupId: !!(row.item_group_id || mbAutoGroupId) });
      }

      // ── Execute bulkWrite in chunks of 500 ──
      const CHUNK = 500;
      for (let c = 0; c < bulkOps.length; c += CHUNK) {
        try {
          const chunk = bulkOps.slice(c, c + CHUNK);
          const result = await col('menu_items').bulkWrite(chunk, { ordered: false });
          branchResult.added += (result.upsertedCount || 0) + (result.modifiedCount || 0);
        } catch (bwErr) {
          // bulkWrite with ordered:false may partially succeed
          if (bwErr.result) {
            branchResult.added += (bwErr.result.nUpserted || 0) + (bwErr.result.nModified || 0);
          }
          const writeErrors = bwErr.writeErrors || [];
          for (const we of writeErrors) {
            branchResult.errors.push(`Bulk write error at index ${we.index}: ${we.errmsg || we.message}`);
            branchResult.skipped++;
          }
        }
      }

      // ── Auto-detect variants from tracked names (no extra DB read) ──
      try {
        const variantOps = [];
        for (const [, items] of Object.entries(nameTracker)) {
          if (items.length <= 1) continue;
          const needsGroupId = items.filter(it => !it.hasGroupId);
          if (!needsGroupId.length) continue;
          // All items with this name are variants — assign groupId
          const sampleRetailerId = items[0].retailerId;
          const itemSlug = sampleRetailerId.replace(new RegExp('^' + mbBranchSlug + '-'), '').replace(/-[^-]+$/, '');
          const groupId = `${mbBranchSlug}-${itemSlug}`;
          const rids = needsGroupId.map(it => it.retailerId);
          variantOps.push({ updateMany: { filter: { retailer_id: { $in: rids } }, update: { $set: { item_group_id: groupId, catalog_sync_status: 'pending' } } } });
        }
        if (variantOps.length) await col('menu_items').bulkWrite(variantOps, { ordered: false });
      } catch (e) { logger.warn({ err: e, branchId: bid }, 'CSV auto-group variants failed'); }

      totalAdded += branchResult.added;
      totalSkipped += branchResult.skipped;
      allErrors.push(...branchResult.errors);
      branchResult._touchedIds = touchedRetailerIds; // carry forward for stale detection
      perBranch.push(branchResult);

      // Skip product-set creation for the unassigned bucket — there's no
      // real branch to attach a product set to. The lowercase '__all__' /
      // '__unassigned__' checks are defensive: bid can only be a real
      // branch id or UNASSIGNED_BUCKET ('__UNASSIGNED__') here, but we
      // mirror the same guard at every autoCreateProductSets call site
      // so a future caller passing the menu-picker sentinels can't
      // trigger "Branch not found" (catalog.js:1475).
      if (!isUnassigned && bid !== '__all__' && bid !== '__unassigned__') {
        catalog.autoCreateProductSets(bid).catch(err => logger.error({ err, branchId: bid }, 'Auto-create product sets failed'));
      }
    }

    // ── Stale item detection: mark items not in upload as unavailable ──
    const staleResult = { total: 0, per_branch: [], warnings: [] };
    for (const br of perBranch) {
      const touched = br._touchedIds;
      if (!touched || !touched.size) continue;
      // Don't run stale detection on the Unassigned bucket — items there
      // come from many uploads, so a single upload can't authoritatively
      // declare prior unassigned items obsolete.
      if (br.branchId === null) { delete br._touchedIds; continue; }

      // Safety check: skip if upload looks like a partial/test file
      const existingActiveCount = await col('menu_items').countDocuments({ branch_id: br.branchId, is_available: true });
      if (existingActiveCount > 10 && touched.size < existingActiveCount * 0.2) {
        staleResult.warnings.push(`Branch "${br.branchName}" has ${existingActiveCount} active items but upload only contained ${touched.size} \u2014 skipped stale detection to prevent accidental deactivation.`);
        continue;
      }

      // Find stale items: active in DB but NOT in upload
      const staleItems = await col('menu_items').find({
        branch_id: br.branchId, is_available: true,
        retailer_id: { $nin: [...touched] },
      }, { projection: { _id: 1, name: 1, retailer_id: 1 } }).toArray();

      if (staleItems.length) {
        await col('menu_items').updateMany(
          { _id: { $in: staleItems.map(s => s._id) } },
          { $set: { is_available: false, stale_reason: 'not_in_upload', stale_marked_at: new Date(), catalog_sync_status: 'pending', updated_at: new Date() } }
        );
        const itemList = staleItems.slice(0, 20).map(s => ({ name: s.name, retailer_id: s.retailer_id }));
        staleResult.per_branch.push({ branchId: br.branchId, branchName: br.branchName, count: staleItems.length, items: itemList, more: staleItems.length > 20 ? staleItems.length - 20 : 0 });
        staleResult.total += staleItems.length;
        logger.info({ staleCount: staleItems.length, branchName: br.branchName, branchId: br.branchId }, 'Marked stale items as unavailable');
      }

      delete br._touchedIds; // clean up internal field before response
    }

    // Queue debounced sync for all affected branches. The Unassigned
    // sentinel isn't a real branch — drop it before queueing.
    const syncBranchIds = Object.keys(branchGroups).filter((id) => id !== UNASSIGNED_BUCKET);
    if (syncBranchIds.length) queueSync(req.restaurantId, 'branch', syncBranchIds);

    await col('restaurants').updateOne(
      { _id: req.restaurantId },
      [{ $set: { onboarding_step: { $max: ['$onboarding_step', 4] } } }]
    );

    res.json({
      success: true,
      multi_branch: !!branchCol,
      branch_column_detected: branchCol || null,
      per_branch: perBranch,
      added: totalAdded,
      inserted: totalAdded,
      skipped: totalSkipped,
      errors: allErrors,
      total: items.length,
      stale_items: staleResult,
      unassigned_count: unassignedItemCount,
      ...(unknownBranchNames.size > 0
        ? { unassigned_reason: `Branch names not found in dashboard: ${[...unknownBranchNames].join(', ')}` }
        : {}),
    });

    log({ actorType: 'restaurant', actorId: String(req.restaurantId), actorName: req.restaurant?.business_name || 'Restaurant', action: 'menu.bulk_upload_multi', category: 'menu', description: `Multi-branch bulk upload: ${perBranch.length} branches, ${totalAdded} items`, restaurantId: String(req.restaurantId), severity: 'info' });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/branches/:branchId/sync-catalog
router.post('/branches/:branchId/sync-catalog', requireApproved, async (req, res) => {
  try {
    const result = await catalog.syncBranchCatalog(req.params.branchId);
    res.json(result);

    log({
      actorType: 'restaurant', actorId: String(req.userId || req.restaurantId), actorName: req.userRole || null,
      action: 'catalog.sync_triggered', category: 'catalog',
      description: `Catalog sync triggered for branch ${req.params.branchId}`,
      restaurantId: req.restaurantId || req.restaurant?._id,
      branchId: req.params.branchId,
      resourceType: 'branch', resourceId: req.params.branchId,
      severity: 'info',
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/branches/:branchId/sync-sets
router.post('/branches/:branchId/sync-sets', requireApproved, async (req, res) => {
  try {
    const result = await catalog.syncCategoryProductSets(req.params.branchId);
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/branches/:branchId/fix-catalog
// Clears stale catalog_id and re-discovers/re-links the correct one from the WABA
router.post('/branches/:branchId/fix-catalog', async (req, res) => {
  try {
    const result = await catalog.rediscoverCatalog(req.params.branchId);
    res.json({ success: true, catalogId: result.catalogId, inherited: result.inherited || false });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/branches/:branchId/item-groups
router.get('/branches/:branchId/item-groups', async (req, res) => {
  try {
    // [TENANT] Verify branch ownership before reading variant data.
    const branch = await _assertBranchOwnedBy(req.params.branchId, req.restaurantId);
    if (!branch) return res.status(404).json({ error: 'Branch not found' });

    const items = await col('menu_items').find({
      branch_id: req.params.branchId,
      item_group_id: { $ne: null },
    }).toArray();

    // Group by item_group_id in JS
    const groups = {};
    for (const item of items) {
      const gid = item.item_group_id;
      if (!groups[gid]) groups[gid] = { item_group_id: gid, base_name: item.name, variants: [] };
      groups[gid].variants.push({
        id:            String(item._id),
        name:          item.name,
        variant_type:  item.variant_type,
        variant_value: item.variant_value,
        price_paise:   item.price_paise,
        image_url:     item.image_url,
        is_available:  item.is_available,
        retailer_id:   item.retailer_id,
      });
    }
    // Sort variants by price
    const result = Object.values(groups).map(g => ({
      ...g,
      variants: g.variants.sort((a, b) => a.price_paise - b.price_paise),
    }));
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/menu/:itemId/variants
router.post('/menu/:itemId/variants', async (req, res) => {
  const { v4: uuidv4 } = require('uuid');
  try {
    const { variantLabel, variantType = 'size', priceRs, imageUrl, baseLabel = 'Regular' } = req.body;
    if (!variantLabel || !priceRs) {
      return res.status(400).json({ error: 'variantLabel and priceRs are required' });
    }

    // Fetch source item — must belong to this restaurant
    const srcItem = await col('menu_items').findOne({ _id: req.params.itemId });
    if (!srcItem) return res.status(404).json({ error: 'Item not found' });
    const branch = await col('branches').findOne({ _id: srcItem.branch_id });
    if (!branch || branch.restaurant_id !== req.restaurantId) {
      return res.status(404).json({ error: 'Item not found' });
    }

    let groupId = srcItem.item_group_id;
    if (!groupId) {
      groupId = uuidv4();
      const baseRetailerId = `${srcItem.retailer_id}-${slugify(baseLabel, 15)}`;
      await col('menu_items').updateOne(
        { _id: srcItem._id },
        { $set: { item_group_id: groupId, variant_type: variantType, variant_value: baseLabel, retailer_id: baseRetailerId, updated_at: new Date() } }
      );
    }

    const baseName    = srcItem.name.replace(/\s*-\s*\S+$/, '').trim() || srcItem.name;
    const variantSlug = slugify(variantLabel, 15);
    const baseId      = srcItem.item_group_id || srcItem.retailer_id.replace(/-[^-]+$/, '');
    const retailerId  = `${baseId}-${variantSlug}`;
    const pricePaise  = Math.round(parseFloat(priceRs) * 100);
    const now = new Date();

    const newItem = await col('menu_items').findOneAndUpdate(
      { retailer_id: retailerId },
      {
        $set: {
          price_paise:   pricePaise,
          image_url:     imageUrl || srcItem.image_url,
          variant_value: variantLabel,
          updated_at:    now,
        },
        $setOnInsert: {
          _id:          newId(),
          restaurant_id: req.restaurantId,
          branch_id:    srcItem.branch_id,
          category_id:  srcItem.category_id,
          name:         baseName,
          description:  srcItem.description,
          retailer_id:  retailerId,
          food_type:    srcItem.food_type,
          is_bestseller:srcItem.is_bestseller,
          is_available: true,
          sort_order:   0,
          item_group_id:groupId,
          variant_type: variantType,
          created_at:   now,
        },
      },
      { upsert: true, returnDocument: 'after' }
    );

    queueSync(req.restaurantId, 'branch', [srcItem.branch_id]);

    res.status(201).json(mapId(newItem));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ═══════════════════════════════════════════════════════════════
// PRODUCT SETS — browsable catalog sections on WhatsApp
// ═══════════════════════════════════════════════════════════════

// GET /api/restaurant/product-sets?branch_id=X
router.get('/product-sets', async (req, res) => {
  try {
    const { branch_id } = req.query;
    if (!branch_id) return res.status(400).json({ error: 'branch_id required' });
    const sets = await col('product_sets').find({ branch_id }).sort({ sort_order: 1, name: 1 }).toArray();
    res.json(mapIds(sets));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/product-sets
router.post('/product-sets', requirePermission('manage_menu'), async (req, res) => {
  try {
    const { branchId, name, type, filterValue, manualRetailerIds, sortOrder } = req.body;
    if (!branchId || !name || !type) return res.status(400).json({ error: 'branchId, name, type required' });
    if (!['category', 'tag', 'manual'].includes(type)) return res.status(400).json({ error: 'type must be category, tag, or manual' });

    const branch = await col('branches').findOne({ _id: branchId });
    if (!branch || branch.restaurant_id !== req.restaurantId) return res.status(404).json({ error: 'Branch not found' });

    const now = new Date();
    const set = {
      _id: newId(),
      branch_id: branchId,
      restaurant_id: req.restaurantId,
      catalog_id: branch.catalog_id || null,
      meta_product_set_id: null,
      name,
      type,
      filter_value: filterValue || null,
      manual_retailer_ids: Array.isArray(manualRetailerIds) ? manualRetailerIds : [],
      is_active: true,
      sort_order: sortOrder || 0,
      created_at: now,
      updated_at: now,
    };
    await col('product_sets').insertOne(set);

    // Push to Meta immediately if catalog exists
    if (branch.catalog_id) {
      catalog.syncProductSets(branchId)
        .catch(err => logger.error({ err, branchId }, 'Product sets sync after create failed'));
    }

    res.status(201).json(mapId(set));

    log({ actorType: 'restaurant', actorId: String(req.restaurantId), actorName: req.restaurant?.business_name || 'Restaurant', action: 'product_set.created', category: 'catalog', description: `Product set created`, restaurantId: String(req.restaurantId), severity: 'info' });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// PUT /api/restaurant/product-sets/:id
router.put('/product-sets/:id', requirePermission('manage_menu'), async (req, res) => {
  try {
    const { name, type, filterValue, manualRetailerIds, sortOrder, isActive } = req.body;
    const $set = { updated_at: new Date() };
    if (name            !== undefined) $set.name = name;
    if (type            !== undefined) $set.type = type;
    if (filterValue     !== undefined) $set.filter_value = filterValue || null;
    if (manualRetailerIds!== undefined) $set.manual_retailer_ids = Array.isArray(manualRetailerIds) ? manualRetailerIds : [];
    if (sortOrder       !== undefined) $set.sort_order = sortOrder;
    if (isActive        !== undefined) $set.is_active = isActive;

    const updated = await col('product_sets').findOneAndUpdate(
      { _id: req.params.id, restaurant_id: req.restaurantId },
      { $set },
      { returnDocument: 'after' }
    );
    if (!updated) return res.status(404).json({ error: 'Product set not found' });

    // Re-sync to Meta
    if (updated.branch_id) {
      catalog.syncProductSets(updated.branch_id)
        .catch(err => logger.error({ err, branchId: updated.branch_id }, 'Product sets sync after update failed'));
    }

    res.json(mapId(updated));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// DELETE /api/restaurant/product-sets/:id
router.delete('/product-sets/:id', requirePermission('manage_menu'), async (req, res) => {
  try {
    const set = await col('product_sets').findOne({ _id: req.params.id, restaurant_id: req.restaurantId });
    if (!set) return res.status(404).json({ error: 'Product set not found' });

    // Delete from Meta first
    if (set.meta_product_set_id) {
      try {
        await catalog.deleteProductSet(set.meta_product_set_id);
      } catch (err) {
        logger.warn({ err, productSetId: set.meta_product_set_id }, 'Meta product set delete failed, continuing');
      }
    }

    await col('product_sets').deleteOne({ _id: req.params.id });
    res.json({ success: true });

    log({ actorType: 'restaurant', actorId: String(req.restaurantId), actorName: req.restaurant?.business_name || 'Restaurant', action: 'product_set.deleted', category: 'catalog', description: `Product set deleted`, restaurantId: String(req.restaurantId), severity: 'info' });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/product-sets/auto-create — auto-create sets from menu categories/tags
router.post('/product-sets/auto-create', requirePermission('manage_menu'), async (req, res) => {
  try {
    const { branchId } = req.body;
    if (!branchId) return res.status(400).json({ error: 'branchId required' });
    // Reject menu-picker sentinels — autoCreateProductSets needs a real
    // branch document and would throw "Branch not found" deep inside
    // catalog.js otherwise. 400 surfaces the misuse to the caller.
    if (branchId === '__all__' || branchId === '__unassigned__') {
      return res.status(400).json({ error: 'branchId must be a real branch — sentinel values are not allowed for product set auto-create' });
    }
    const result = await catalog.autoCreateProductSets(branchId);
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/product-sets/sync — sync all sets for a branch
router.post('/product-sets/sync', requirePermission('manage_menu'), async (req, res) => {
  try {
    const { branchId } = req.body;
    if (!branchId) return res.status(400).json({ error: 'branchId required' });
    const result = await catalog.syncProductSets(branchId);
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ═══════════════════════════════════════════════════════════════
// CATALOG COLLECTIONS
// ═══════════════════════════════════════════════════════════════

// GET /api/restaurant/collections?branch_id=X
router.get('/collections', async (req, res) => {
  try {
    const { branch_id } = req.query;
    if (!branch_id) return res.status(400).json({ error: 'branch_id required' });
    const collections = await col('catalog_collections').find({ branch_id }).sort({ sort_order: 1 }).toArray();

    // Enrich with product set names
    const allSetIds = [...new Set(collections.flatMap(c => c.product_set_ids || []))];
    const sets = allSetIds.length
      ? await col('product_sets').find({ _id: { $in: allSetIds } }).toArray()
      : [];
    const setMap = Object.fromEntries(sets.map(s => [String(s._id), { id: String(s._id), name: s.name, meta_product_set_id: s.meta_product_set_id }]));

    const enriched = collections.map(c => ({
      ...mapId(c),
      product_sets: (c.product_set_ids || []).map(id => setMap[id] || { id, name: '(unknown)' }),
      synced: !!c.meta_collection_id,
    }));

    res.json(enriched);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/collections
router.post('/collections', requirePermission('manage_menu'), async (req, res) => {
  try {
    const { branchId, name, description, productSetIds, coverImageUrl, sortOrder } = req.body;
    if (!branchId || !name) return res.status(400).json({ error: 'branchId and name required' });

    const branch = await col('branches').findOne({ _id: branchId });
    if (!branch || branch.restaurant_id !== req.restaurantId) return res.status(404).json({ error: 'Branch not found' });

    // Validate product set IDs belong to this branch
    const validSets = Array.isArray(productSetIds)
      ? await col('product_sets').find({ _id: { $in: productSetIds }, branch_id: branchId }).toArray()
      : [];

    const now = new Date();
    const doc = {
      _id: newId(),
      branch_id: branchId,
      restaurant_id: req.restaurantId,
      catalog_id: branch.catalog_id || null,
      meta_collection_id: null,
      name,
      description: description || null,
      product_set_ids: validSets.map(s => String(s._id)),
      cover_image_url: coverImageUrl || null,
      is_active: true,
      sort_order: sortOrder ?? 0,
      created_at: now,
      updated_at: now,
    };
    await col('catalog_collections').insertOne(doc);

    // Sync to Meta
    if (branch.catalog_id) {
      catalog.syncCollections(branchId)
        .catch(err => logger.error({ err, branchId }, 'Collections sync after create failed'));
    }

    res.status(201).json(mapId(doc));

    log({ actorType: 'restaurant', actorId: String(req.restaurantId), actorName: req.restaurant?.business_name || 'Restaurant', action: 'collection.created', category: 'catalog', description: `Collection created`, restaurantId: String(req.restaurantId), severity: 'info' });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// PUT /api/restaurant/collections/:id
router.put('/collections/:id', requirePermission('manage_menu'), async (req, res) => {
  try {
    const { name, description, productSetIds, coverImageUrl, sortOrder, isActive } = req.body;
    const $set = { updated_at: new Date() };
    if (name           !== undefined) $set.name = name;
    if (description    !== undefined) $set.description = description || null;
    if (coverImageUrl  !== undefined) $set.cover_image_url = coverImageUrl || null;
    if (sortOrder      !== undefined) $set.sort_order = sortOrder;
    if (isActive       !== undefined) $set.is_active = isActive;
    if (Array.isArray(productSetIds)) $set.product_set_ids = productSetIds;

    const updated = await col('catalog_collections').findOneAndUpdate(
      { _id: req.params.id, restaurant_id: req.restaurantId },
      { $set },
      { returnDocument: 'after' }
    );
    if (!updated) return res.status(404).json({ error: 'Collection not found' });

    // Re-sync to Meta
    if (updated.branch_id) {
      catalog.syncCollections(updated.branch_id)
        .catch(err => logger.error({ err, branchId: updated.branch_id }, 'Collections sync after update failed'));
    }

    res.json(mapId(updated));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// DELETE /api/restaurant/collections/:id
router.delete('/collections/:id', requirePermission('manage_menu'), async (req, res) => {
  try {
    const coll = await col('catalog_collections').findOne({ _id: req.params.id, restaurant_id: req.restaurantId });
    if (!coll) return res.status(404).json({ error: 'Collection not found' });

    // Delete from Meta first
    if (coll.meta_collection_id) {
      try {
        await catalog.deleteCollection(coll.meta_collection_id);
      } catch (err) {
        logger.warn({ err, collectionId: coll.meta_collection_id }, 'Meta collection delete failed, continuing');
      }
    }

    // [TENANT] Defence in depth: re-pin restaurant_id on the destructive op.
    await col('catalog_collections').deleteOne({ _id: req.params.id, restaurant_id: req.restaurantId });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/collections/auto-create
router.post('/collections/auto-create', requirePermission('manage_menu'), async (req, res) => {
  try {
    const { branchId } = req.body;
    if (!branchId) return res.status(400).json({ error: 'branchId required' });
    // [TENANT] catalog.autoCreateCollections writes catalog_collections rows
    // and pushes to Meta — verify the branch belongs to this restaurant first.
    const branch = await _assertBranchOwnedBy(branchId, req.restaurantId);
    if (!branch) return res.status(404).json({ error: 'Branch not found' });
    const result = await catalog.autoCreateCollections(branchId);
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// PUT /api/restaurant/collections/reorder — bulk update sort_order
router.put('/collections/reorder', requirePermission('manage_menu'), async (req, res) => {
  try {
    const { items } = req.body; // [{ id, sort_order }]
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items array required' });
    const ops = items.map(item =>
      col('catalog_collections').updateOne(
        { _id: item.id, restaurant_id: req.restaurantId },
        { $set: { sort_order: item.sort_order, updated_at: new Date() } }
      )
    );
    await Promise.all(ops);
    res.json({ success: true, updated: items.length });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/collections/sync — sync all collections for a branch
router.post('/collections/sync', requirePermission('manage_menu'), async (req, res) => {
  try {
    const { branchId } = req.body;
    if (!branchId) return res.status(400).json({ error: 'branchId required' });
    const result = await catalog.syncCollections(branchId);
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/collections/branch-status — Collection status for all branches
router.get('/collections/branch-status', async (req, res) => {
  try {
    const branches = await col('branches').find({ restaurant_id: req.restaurantId })
      .project({ name: 1, meta_collection_id: 1, collection_updated_at: 1, catalog_id: 1, meta_product_set_id: 1 })
      .sort({ created_at: 1 }).toArray();

    const status = await Promise.all(branches.map(async b => {
      const itemCount = await col('menu_items').countDocuments({ branch_id: b._id, is_available: true });
      const setCount = await col('product_sets').countDocuments({ branch_id: b._id, is_active: true, meta_product_set_id: { $ne: null } });
      return {
        id: b._id,
        name: b.name,
        meta_collection_id: b.meta_collection_id || null,
        collection_updated_at: b.collection_updated_at || null,
        product_count: itemCount,
        product_set_count: setCount,
        has_catalog: !!b.catalog_id,
      };
    }));

    res.json(status);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/collections/sync-branch-collections — sync branch-level Collections for all branches
router.post('/collections/sync-branch-collections', requirePermission('manage_menu'), async (req, res) => {
  try {
    const result = await catalog.syncAllBranchCollections(req.restaurantId);
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ═══════════════════════════════════════════════════════════════
// VARIANT HELPERS
// ═══════════════════════════════════════════════════════════════

// GET /api/restaurant/menu/variants/:itemGroupId — get all variants in a group
router.get('/menu/variants/:itemGroupId', async (req, res) => {
  try {
    // [TENANT] Pin restaurant_id directly in the filter — item_group_id is a
    // string label and could collide across tenants. Without this, an attacker
    // could read another restaurant's variant lineup if they shared a label.
    const items = await col('menu_items').find({
      item_group_id: req.params.itemGroupId,
      restaurant_id: req.restaurantId,
    }).sort({ sort_order: 1, price_paise: 1 }).toArray();
    res.json(mapIds(items));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/menu/variant — add a variant to an existing product group
router.post('/menu/variant', requirePermission('manage_menu'), async (req, res) => {
  try {
    const { itemGroupId, branchId, name, size, priceRs, imageUrl } = req.body;
    if (!itemGroupId || !branchId || !size || !priceRs) {
      return res.status(400).json({ error: 'itemGroupId, branchId, size, priceRs required' });
    }

    // Auto-generate retailer_id from group + size using canonical slugify
    const retailerId = `${itemGroupId}-${slugify(size, 15)}`;

    // Copy shared fields from an existing variant in the same group
    const existing = await col('menu_items').findOne({ item_group_id: itemGroupId, branch_id: branchId });

    const pricePaise = Math.round(parseFloat(priceRs) * 100);
    const now = new Date();
    const itemName = name || existing?.name || 'Product';

    const newItem = await col('menu_items').findOneAndUpdate(
      { retailer_id: retailerId },
      {
        $set: {
          price_paise: pricePaise,
          size,
          variant_value: size,
          image_url: imageUrl || existing?.image_url || null,
          catalog_sync_status: 'pending',
          updated_at: now,
        },
        $setOnInsert: {
          _id: newId(),
          branch_id: branchId,
          category_id: existing?.category_id || null,
          name: itemName,
          description: existing?.description || null,
          retailer_id: retailerId,
          food_type: existing?.food_type || 'veg',
          is_bestseller: existing?.is_bestseller || false,
          is_available: true,
          sort_order: 0,
          item_group_id: itemGroupId,
          variant_type: existing?.variant_type || 'size',
          // Copy Meta fields from existing variant
          product_tags: existing?.product_tags || [],
          google_product_category: existing?.google_product_category || 'Food, Beverages & Tobacco > Food Items',
          fb_product_category: existing?.fb_product_category || 'Food & Beverages > Prepared Food',
          brand: existing?.brand || null,
          sale_price_paise: null,
          sale_price_effective_date: null,
          link: null,
          quantity_to_sell_on_facebook: null,
          gender: null, color: null, age_group: null,
          material: null, pattern: null,
          shipping: null, shipping_weight: null,
          video_url: null, video_tag: null,
          gtin: null, style: null,
          catalog_synced_at: null,
          created_at: now,
        },
      },
      { upsert: true, returnDocument: 'after' }
    );

    queueSync(req.restaurantId, 'branch', [branchId]);

    res.status(201).json(mapId(newItem));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/branches/:branchId/create-catalog
router.post('/branches/:branchId/create-catalog', requireApproved, async (req, res) => {
  try {
    const result = await catalog.createBranchCatalog(req.params.branchId);

    if (result.alreadyExists) {
      return res.json({ success: true, message: 'Catalog already exists', catalogId: result.catalogId });
    }

    if (result.success) {
      queueSync(req.restaurantId, 'branch', [req.params.branchId]);
    }

    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ═══════════════════════════════════════════════════════════════
// CATALOG API — Meta Product Catalog management
// ═══════════════════════════════════════════════════════════════

// POST /api/restaurant/catalog/ensure — create or return the main catalog
router.post('/catalog/ensure', async (req, res) => {
  try {
    const result = await catalog.ensureMainCatalog(req.restaurantId);
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/catalog/full-state — SINGLE SOURCE OF TRUTH for the
// Catalog Management UI. Returns a stable normalized object the frontend can
// use directly without coordinating multiple parallel calls.
//
// Response shape (always returns 200 with this exact shape, even on partial errors):
// {
//   metaConnected:           boolean,
//   whatsappNumberConnected: boolean,
//   whatsappNumber:          string | null,
//   catalogExists:           boolean,
//   catalogId:               string | null,
//   catalogName:             string | null,
//   catalogLinkedToWhatsapp: boolean,
//   catalogVisible:          boolean,
//   syncAvailable:           boolean,
//   issueCount:              number,
//   lastSyncStatus:          'never' | 'success' | 'failed',
//   approvalStatus:          string,
//   availableCatalogs:       [{ id, name, product_count, connected }],
//   warnings:                [string],
//   errors:                  [string]
// }
router.get('/catalog/full-state', async (req, res) => {
  // Always return 200 with a stable shape — never let one failure break the page
  const state = {
    metaConnected: false,
    whatsappNumberConnected: false,
    whatsappNumber: null,
    catalogExists: false,
    catalogId: null,
    catalogName: null,
    catalogLinkedToWhatsapp: false,
    catalogVisible: false,
    syncAvailable: false,
    issueCount: 0,
    lastSyncStatus: 'never',
    approvalStatus: 'pending',
    availableCatalogs: [],
    warnings: [],
    errors: [],
  };

  try {
    // 1. Restaurant + WABA (always read from DB — no Meta API calls in this endpoint)
    const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
    if (!restaurant) {
      state.errors.push('Restaurant not found');
      return res.json(state);
    }

    state.approvalStatus = restaurant.approval_status || 'pending';

    // Meta connection signals
    state.metaConnected = !!(restaurant.meta_user_id || restaurant.meta_business_id);

    // 2. WABA connection — read the EXPLICITLY linked phone first, then fall
    // back to "first restaurant-typed row" only if no linkage was recorded
    // (legacy onboardings before the WABA-BIND-FIX). Platform admin rows
    // (account_type !== 'restaurant') are excluded.
    const restaurantWabaFilter = {
      restaurant_id: req.restaurantId,
      is_active: true,
      $or: [{ account_type: 'restaurant' }, { account_type: { $exists: false } }],
    };
    let waba = null;
    if (restaurant.linked_phone_number_id) {
      waba = await col('whatsapp_accounts').findOne({
        ...restaurantWabaFilter,
        phone_number_id: restaurant.linked_phone_number_id,
      });
    }
    if (!waba) {
      waba = await col('whatsapp_accounts').findOne(restaurantWabaFilter);
    }
    if (waba) {
      state.whatsappNumberConnected = !!waba.phone_number_id;
      state.whatsappNumber = waba.phone_display || waba.wa_phone_number || null;
      // If we have a WABA, Meta is definitely connected
      if (state.whatsappNumberConnected) state.metaConnected = true;
    }

    // 3. Catalog state — derived from BOTH restaurant AND waba (whichever has it)
    const catalogId = restaurant.meta_catalog_id || waba?.catalog_id || null;
    state.catalogId = catalogId;
    state.catalogExists = !!catalogId;
    state.catalogName = restaurant.meta_catalog_name || (catalogId ? 'Menu Catalog' : null);

    // 4. Catalog linked to WhatsApp (commerce settings + waba.catalog_linked)
    state.catalogLinkedToWhatsapp = !!(waba?.catalog_linked && waba?.catalog_id);
    state.catalogVisible = !!(waba?.catalog_visible);

    // 5. Sync available — only if catalog exists AND linked
    state.syncAvailable = state.catalogExists && state.catalogLinkedToWhatsapp;

    // 6. Available catalogs (from DB cache only — never call Meta in this endpoint)
    const cachedCatalogs = restaurant.meta_available_catalogs || [];
    state.availableCatalogs = cachedCatalogs.map(c => ({
      id: c.id,
      name: c.name || 'Unnamed Catalog',
      product_count: c.product_count != null ? c.product_count : null,
      connected: c.id === catalogId,
    }));

    // If we have a catalog ID but it's not in the cache, add it
    if (catalogId && !state.availableCatalogs.some(c => c.id === catalogId)) {
      state.availableCatalogs.unshift({
        id: catalogId,
        name: state.catalogName,
        product_count: null,
        connected: true,
      });
    }

    // 7. Last sync status (from activity_logs)
    try {
      const lastSync = await col('activity_logs').findOne(
        { restaurant_id: req.restaurantId, action: { $regex: /^catalog\.(sync|sync_completed|sync_failed)/ } },
        { sort: { created_at: -1 } }
      );
      if (lastSync) {
        if (lastSync.action.includes('failed')) state.lastSyncStatus = 'failed';
        else if (lastSync.severity === 'error') state.lastSyncStatus = 'failed';
        else state.lastSyncStatus = 'success';
      }
    } catch (_) { /* non-blocking */ }

    // 8. Issue count (catalog diagnostic issues from last 7 days)
    try {
      const since = new Date(Date.now() - 7 * 86400000);
      state.issueCount = await col('activity_logs').countDocuments({
        restaurant_id: req.restaurantId,
        category: 'catalog',
        severity: { $in: ['warning', 'error', 'critical'] },
        created_at: { $gte: since },
      });
    } catch (_) { /* non-blocking */ }

    // 9. Warnings
    if (state.approvalStatus !== 'approved') {
      state.warnings.push(`Approval ${state.approvalStatus} — some catalog actions are restricted until approval`);
    }
    if (state.catalogExists && state.whatsappNumberConnected && !state.catalogLinkedToWhatsapp) {
      state.warnings.push('Catalog exists but is not linked to WhatsApp');
    }
    if (state.catalogLinkedToWhatsapp && !state.catalogVisible) {
      state.warnings.push('Catalog linked but not visible to customers');
    }
    if (state.availableCatalogs.length > 1) {
      state.warnings.push(`You have ${state.availableCatalogs.length} catalogs — WhatsApp works best with one`);
    }

    res.json(state);
  } catch (e) {
    req.log.error({ err: e }, 'catalog/full-state failed');
    state.errors.push(e.message || 'Failed to load catalog state');
    res.json(state);
  }
});

// GET /api/restaurant/catalog/status — sync status + link/cart/visibility from DB
router.get('/catalog/status', async (req, res) => {
  try {
    const status = await catalog.getSyncStatus(req.restaurantId);
    const wa = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId, is_active: true });
    status.catalog_linked = wa?.catalog_linked || false;
    status.cart_enabled = wa?.cart_enabled || false;
    status.catalog_visible = wa?.catalog_visible || false;
    status.phone_number_id = wa?.phone_number_id || null;

    // Augment with compression stats (non-blocking)
    try {
      const compression = require('../services/catalogCompression');
      status.compression = await compression.getCompressionSummary(req.restaurantId);
    } catch { status.compression = null; }

    res.json(status);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/catalog/details — fetch catalog details from Meta API
router.get('/catalog/details', async (req, res) => {
  try {
    const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
    const catalogId = restaurant?.meta_catalog_id;
    if (!catalogId) return res.status(404).json({ error: 'No catalog connected.' });

    const token = metaConfig.systemUserToken;
    if (!token) return res.status(500).json({ error: 'Meta token not configured.' });

    const response = await axios.get(
      `${metaConfig.graphUrl}/${catalogId}`,
      { params: { fields: 'name,vertical,product_count,da_display_settings,business' }, headers: { Authorization: `Bearer ${token}` } }
    );
    res.json({ ...response.data, catalog_id: catalogId, catalog_name: restaurant.meta_catalog_name, created_at: restaurant.catalog_created_at });
  } catch (e) {
    if (e.response?.status === 404 || e.response?.data?.error?.code === 100) {
      // Catalog no longer exists on Meta — clean up DB
      await col('restaurants').updateOne({ _id: req.restaurantId }, { $set: { meta_catalog_id: null, meta_catalog_name: null } });
      return res.status(404).json({ error: 'Catalog no longer exists on Meta. It may have been deleted externally.', cleaned: true });
    }
    req.log.error({ err: e, metaResponse: e.response?.data }, 'Catalog details fetch failed');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// PUT /api/restaurant/catalog/settings — update catalog name/settings on Meta
router.put('/catalog/settings', async (req, res) => {
  try {
    const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
    const catalogId = restaurant?.meta_catalog_id;
    if (!catalogId) return res.status(404).json({ error: 'No catalog connected.' });

    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Catalog name is required.' });

    const token = metaConfig.systemUserToken;
    if (!token) return res.status(500).json({ error: 'Meta token not configured.' });

    // Ensure admin access before updating
    await metaConfig.ensureCatalogAdminAccess(catalogId);

    await axios.post(
      `${metaConfig.graphUrl}/${catalogId}`,
      { name: name.trim() },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    await col('restaurants').updateOne(
      { _id: req.restaurantId },
      { $set: { meta_catalog_name: name.trim(), updated_at: new Date() } }
    );

    req.log.info({ catalogId, catalogName: name.trim() }, 'Catalog name updated');
    res.json({ success: true, catalog_name: name.trim() });
  } catch (e) {
    req.log.error({ err: e, metaResponse: e.response?.data }, 'Catalog settings update failed');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// POST /api/restaurant/catalog/sync — full sync all branches to main catalog
router.get('/catalog/compliance', async (req, res) => {
  try {
    const branchDocs = await col('branches').find({ restaurant_id: req.restaurantId }).toArray();
    const branchIds = branchDocs.map(b => String(b._id));
    if (!branchIds.length) return res.json({ total: 0, compliant: 0, issues: [] });

    const items = await col('menu_items').find({ branch_id: { $in: branchIds } }).toArray();
    const issues = [];
    let compliant = 0;

    for (const item of items) {
      const v = catalog.validateItemForMeta(item);
      if (v.valid) { compliant++; continue; }
      issues.push({ id: String(item._id), name: item.name, retailer_id: item.retailer_id, errors: v.errors });
    }

    res.json({ total: items.length, compliant, non_compliant: issues.length, issues });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.get('/catalog/sync-status', async (req, res) => {
  try {
    const r = await col('restaurants').findOne({ _id: req.restaurantId }, { projection: { last_catalog_sync: 1, last_catalog_pull_at: 1, last_auto_sync_at: 1 } });
    res.json({
      lastSyncToMeta: r?.last_catalog_sync || null,
      lastSyncFromMeta: r?.last_catalog_pull_at || null,
      lastAutoSync: r?.last_auto_sync_at || null,
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.post('/catalog/clear-and-resync', async (req, res) => {
  try {
    const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
    const catalogId = restaurant?.meta_catalog_id;
    if (!catalogId) return res.status(400).json({ error: 'No catalog connected' });

    // [LOCK] Catalog clear-and-resync is a destructive multi-step operation:
    // fetch all products → batch-delete from Meta → re-sync all local items.
    // Two concurrent runs would corrupt the catalog state (one deleting while
    // the other uploads). The lock guarantees only ONE clear-and-resync runs
    // per restaurant at a time. TTL is 5 minutes — generous enough for large
    // catalogs but short enough that a crashed process doesn't lock the user
    // out for long. Second caller fails fast with HTTP 409 + clear message.
    const { withLock, keys: lockKeys, LockBusyError } = require('../utils/withLock');
    try {
      const result = await withLock(
        lockKeys.catalogResync(req.restaurantId),
        async () => {
          const token = metaConfig.getCatalogToken();
          const GRAPH = metaConfig.graphUrl;

          // Step 1: Fetch all existing products from Meta
          let allProducts = [];
          let url = `${GRAPH}/${catalogId}/products?fields=retailer_id&limit=500&access_token=${token}`;
          while (url) {
            const { data } = await axios.get(url, { timeout: 15000 });
            allProducts.push(...(data.data || []));
            url = data.paging?.next || null;
          }

          // Step 2: Delete all in batches of 4999 via items_batch
          let deleted = 0;
          for (let i = 0; i < allProducts.length; i += 4999) {
            const batch = allProducts.slice(i, i + 4999).map(p => ({ method: 'DELETE', retailer_id: p.retailer_id }));
            try {
              await axios.post(`${GRAPH}/${catalogId}/items_batch`, {
                access_token: token,
                item_type: 'PRODUCT_ITEM',
                requests: JSON.stringify(batch),
              }, { timeout: 30000 });
              deleted += batch.length;
            } catch (e) { req.log.error({ err: e }, 'Catalog batch delete failed'); }
          }

          // Step 3: Re-sync all local items
          const syncResult = await catalog.syncRestaurantCatalog(req.restaurantId);

          log({ actorType: 'restaurant', actorId: String(req.userId || req.restaurantId), action: 'catalog.clear_and_resync', category: 'catalog', description: `Cleared ${deleted} items from Meta, re-synced ${syncResult.totalSynced}`, restaurantId: req.restaurantId, severity: 'info' });

          return { success: true, deleted_from_meta: deleted, ...syncResult };
        },
        { ttlMs: 5 * 60 * 1000, type: 'catalog-resync' }
      );
      res.json(result);
    } catch (lockErr) {
      if (lockErr instanceof LockBusyError) {
        // Another catalog resync is already in progress for this restaurant.
        // 409 Conflict is the right HTTP status for "resource is busy".
        return res.status(409).json({
          error: 'Another catalog re-sync is already in progress for this restaurant. Please wait a few minutes and try again.',
          code: 'CATALOG_RESYNC_BUSY',
        });
      }
      throw lockErr;
    }
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.post('/catalog/sync', async (req, res) => {
  try {
    const results = await catalog.syncRestaurantCatalog(req.restaurantId);
    const httpStatus = (results.totalFailed > 0) ? 207 : 200;
    if (results.totalFailed > 0) {
      req.log.warn({ totalFailed: results.totalFailed, failedBranches: results.branches?.filter(b => !b.success || b.failed > 0).length || 0 }, 'Catalog sync partial failure');
    }
    res.status(httpStatus).json({ success: results.totalFailed === 0, totalFailed: results.totalFailed || 0, errors: results.branches?.filter(b => b.error).map(b => b.error) || [], ...results });

    log({
      actorType: 'restaurant', actorId: String(req.userId || req.restaurantId), actorName: req.userRole || null,
      action: 'catalog.sync_triggered', category: 'catalog',
      description: `Catalog sync: ${results.totalSynced || 0} synced, ${results.totalFailed || 0} failed`,
      restaurantId: req.restaurantId || req.restaurant?._id,
      branchId: null,
      resourceType: 'restaurant', resourceId: req.restaurantId,
      severity: results.totalFailed > 0 ? 'warning' : 'info',
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── CATALOG LINK / UNLINK / CART / VISIBILITY TOGGLES ───────

// POST /api/restaurant/catalog/link — link catalog + enable cart + visibility
router.post('/catalog/link', async (req, res) => {
  try {
    const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
    const wa = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId, is_active: true });
    if (!restaurant?.meta_catalog_id) return res.status(400).json({ error: 'No catalog exists yet. Add menu items first.' });
    if (!wa?.phone_number_id) return res.status(400).json({ error: 'No WhatsApp number connected.' });

    const token = metaConfig.getCatalogToken();
    await axios.post(
      `${metaConfig.graphUrl}/${wa.phone_number_id}/whatsapp_commerce_settings`,
      { catalog_id: restaurant.meta_catalog_id, is_catalog_visible: true, is_cart_enabled: true },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );

    await col('whatsapp_accounts').updateOne(
      { _id: wa._id },
      { $set: { catalog_linked: true, catalog_linked_at: new Date(), cart_enabled: true, catalog_visible: true, catalog_id: restaurant.meta_catalog_id } }
    );
    req.log.info({ catalogId: restaurant.meta_catalog_id, phoneNumberId: wa.phone_number_id }, 'Catalog linked to phone');
    res.json({ success: true, catalog_linked: true, cart_enabled: true, catalog_visible: true });
  } catch (e) {
    req.log.error({ err: e }, 'Catalog link failed');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// POST /api/restaurant/catalog/unlink — hide catalog from WhatsApp (does NOT delete)
router.post('/catalog/unlink', async (req, res) => {
  try {
    const wa = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId, is_active: true });
    if (!wa?.phone_number_id) return res.status(400).json({ error: 'No WhatsApp number connected.' });

    const token = metaConfig.getCatalogToken();
    await axios.post(
      `${metaConfig.graphUrl}/${wa.phone_number_id}/whatsapp_commerce_settings`,
      { is_catalog_visible: false, is_cart_enabled: false },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );

    await col('whatsapp_accounts').updateOne(
      { _id: wa._id },
      { $set: { catalog_linked: false, cart_enabled: false, catalog_visible: false } }
    );
    req.log.info({ phoneNumberId: wa.phone_number_id }, 'Catalog unlinked from phone');
    res.json({ success: true, catalog_linked: false });
  } catch (e) {
    req.log.error({ err: e }, 'Catalog unlink failed');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// POST /api/restaurant/catalog/cart-toggle — enable/disable cart
router.post('/catalog/cart-toggle', async (req, res) => {
  try {
    const { enabled } = req.body;
    const wa = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId, is_active: true });
    if (!wa?.phone_number_id) return res.status(400).json({ error: 'No WhatsApp number connected.' });
    const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
    if (!wa?.catalog_linked && !wa?.catalog_id && !restaurant?.meta_catalog_id) return res.status(400).json({ error: 'No catalog connected. Link a catalog first.' });

    const token = metaConfig.getCatalogToken();
    await axios.post(
      `${metaConfig.graphUrl}/${wa.phone_number_id}/whatsapp_commerce_settings`,
      { is_cart_enabled: !!enabled },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );

    await col('whatsapp_accounts').updateOne({ _id: wa._id }, { $set: { cart_enabled: !!enabled } });
    res.json({ success: true, cart_enabled: !!enabled });
  } catch (e) {
    req.log.error({ err: e }, 'Catalog cart toggle failed');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// GET /api/restaurant/catalog/visibility-status — fetch current visibility from Meta
router.get('/catalog/visibility-status', async (req, res) => {
  try {
    const wa = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId, is_active: true });
    const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
    const hasCatalog = !!(restaurant?.meta_catalog_id || wa?.catalog_id);

    if (!wa?.phone_number_id) {
      return res.json({ is_catalog_visible: false, is_cart_enabled: false, has_catalog: false, error: 'No WhatsApp number connected' });
    }
    if (!hasCatalog) {
      return res.json({ is_catalog_visible: false, is_cart_enabled: false, has_catalog: false, error: 'No catalog connected' });
    }

    // Fetch live status from Meta
    try {
      const token = metaConfig.getCatalogToken();
      const { data } = await axios.get(`${metaConfig.graphUrl}/${wa.phone_number_id}/whatsapp_commerce_settings`, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 10000,
      });
      const settings = data?.data?.[0] || {};
      const metaVisible = !!settings.is_catalog_visible;
      const metaCart = !!settings.is_cart_enabled;
      const metaCatalogId = settings.id || null;
      const metaLinked = !!metaCatalogId;

      // Auto-heal: sync MongoDB to match Meta's reality
      const healed = [];
      const dbLinked = !!wa.catalog_linked;
      const dbVisible = !!wa.catalog_visible;
      const dbCart = !!wa.cart_enabled;
      const dbCatalogId = wa.catalog_id || null;

      const healUpdate = {};
      if (metaLinked !== dbLinked) { healUpdate.catalog_linked = metaLinked; healed.push(`catalog_linked: ${dbLinked}→${metaLinked}`); }
      if (metaVisible !== dbVisible) { healUpdate.catalog_visible = metaVisible; healed.push(`catalog_visible: ${dbVisible}→${metaVisible}`); }
      if (metaCart !== dbCart) { healUpdate.cart_enabled = metaCart; healed.push(`cart_enabled: ${dbCart}→${metaCart}`); }
      if (metaCatalogId && metaCatalogId !== dbCatalogId) { healUpdate.catalog_id = metaCatalogId; healed.push(`catalog_id: ${dbCatalogId}→${metaCatalogId}`); }

      if (Object.keys(healUpdate).length) {
        healUpdate.updated_at = new Date();
        await col('whatsapp_accounts').updateOne({ _id: wa._id }, { $set: healUpdate });
        for (const h of healed) logger.info({ heal: h }, 'Catalog auto-heal applied');
        // Also heal restaurant meta_catalog_id if needed
        if (metaCatalogId && metaCatalogId !== restaurant?.meta_catalog_id) {
          await col('restaurants').updateOne({ _id: req.restaurantId }, { $set: { meta_catalog_id: metaCatalogId, updated_at: new Date() } });
          logger.info({ oldCatalogId: restaurant?.meta_catalog_id, newCatalogId: metaCatalogId }, 'Auto-heal restaurant meta_catalog_id');
        }
      }

      res.json({ is_catalog_visible: metaVisible, is_cart_enabled: metaCart, has_catalog: true, catalog_id: metaCatalogId, auto_healed: healed.length > 0, healed });
    } catch (metaErr) {
      // Fall back to DB state
      res.json({ is_catalog_visible: !!wa.catalog_visible, is_cart_enabled: !!wa.cart_enabled, has_catalog: true, from_db: true });
    }
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/catalog/visibility-toggle — show/hide catalog on profile
router.post('/catalog/visibility-toggle', async (req, res) => {
  try {
    const { visible } = req.body;
    const wa = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId, is_active: true });
    if (!wa?.phone_number_id) return res.status(400).json({ error: 'No WhatsApp number connected.' });
    const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
    if (!wa?.catalog_linked && !wa?.catalog_id && !restaurant?.meta_catalog_id) return res.status(400).json({ error: 'No catalog connected. Link a catalog first.' });

    const token = metaConfig.getCatalogToken();
    await axios.post(
      `${metaConfig.graphUrl}/${wa.phone_number_id}/whatsapp_commerce_settings`,
      { is_catalog_visible: !!visible },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );

    await col('whatsapp_accounts').updateOne({ _id: wa._id }, { $set: { catalog_visible: !!visible } });
    res.json({ success: true, catalog_visible: !!visible });
  } catch (e) {
    req.log.error({ err: e }, 'Catalog visibility toggle failed');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// POST /api/restaurant/catalog/reverse-sync — pull items FROM Meta catalog INTO our database
router.post('/catalog/reverse-sync', async (req, res) => {
  try {
    const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
    const catalogId = restaurant?.meta_catalog_id;
    if (!catalogId) return res.status(400).json({ error: 'No catalog connected. Link a catalog first.' });

    const token = metaConfig.getCatalogToken();
    const GRAPH = metaConfig.graphUrl;

    // Fetch ALL products from Meta with pagination
    let allProducts = [];
    let url = `${GRAPH}/${catalogId}/products?fields=id,name,description,price,availability,image_url,retailer_id,sale_price,item_group_id,size,brand,product_tags&limit=500&access_token=${token}`;

    while (url) {
      const resp = await axios.get(url, { timeout: 30000 });
      allProducts.push(...(resp.data?.data || []));
      url = resp.data?.paging?.next || null;
    }

    req.log.info({ productCount: allProducts.length, catalogId }, 'Reverse sync fetched products from Meta');

    // Determine target branch
    const branches = await col('branches').find({ restaurant_id: req.restaurantId }).toArray();
    if (!branches.length) return res.status(400).json({ error: 'Create a branch first before importing.' });
    const defaultBranch = branches[0];
    const branchSlugMap = {};
    for (const b of branches) {
      const slug = b.branch_slug || slugify(b.name, 20) || String(b._id).slice(0, 8);
      branchSlugMap[slug] = b;
    }

    function parseMetaPrice(priceStr) {
      if (!priceStr) return 0;
      const cleaned = String(priceStr).replace(/[^0-9.]/g, '');
      return Math.round(parseFloat(cleaned) * 100) || 0;
    }

    const stats = { total_in_meta: allProducts.length, new_items_added: 0, existing_items_updated: 0, errors: [] };
    const now = new Date();

    for (const product of allProducts) {
      try {
        const retailerId = product.retailer_id || product.id;

        // Determine branch from retailer_id prefix
        let targetBranch = defaultBranch;
        if (branches.length > 1) {
          const slug = (retailerId || '').split('-')[0];
          if (branchSlugMap[slug]) targetBranch = branchSlugMap[slug];
        }

        const tags = Array.isArray(product.product_tags) ? product.product_tags : [];

        const doc = {
          restaurant_id: req.restaurantId,
          branch_id: String(targetBranch._id),
          retailer_id: retailerId,
          name: product.name || '',
          description: product.description || '',
          price_paise: parseMetaPrice(product.price),
          sale_price_paise: product.sale_price ? parseMetaPrice(product.sale_price) : null,
          is_available: product.availability === 'in stock',
          image_url: product.image_url || '',
          item_group_id: product.item_group_id || null,
          size: product.size || null,
          brand: product.brand || restaurant.business_name,
          product_tags: tags,
          food_type: (tags[0] || '').toLowerCase().includes('non') ? 'non_veg' : 'veg',
          catalog_sync_status: 'synced',
          catalog_synced_at: now,
          reverse_synced: true,
          reverse_synced_at: now,
          updated_at: now,
        };

        const result = await col('menu_items').updateOne(
          { retailer_id: retailerId, restaurant_id: req.restaurantId },
          { $set: doc, $setOnInsert: { _id: newId(), is_bestseller: false, sort_order: 0, created_at: now } },
          { upsert: true }
        );

        if (result.upsertedCount) stats.new_items_added++;
        else stats.existing_items_updated++;
      } catch (err) {
        stats.errors.push(`${product.name || product.id}: ${err.message}`);
      }
    }

    await col('restaurants').updateOne({ _id: req.restaurantId }, { $set: { last_catalog_pull_at: new Date() } });
    req.log.info({ stats }, 'Reverse sync complete');
    res.json({ success: true, ...stats });

    log({ actorType: 'restaurant', actorId: String(req.userId || req.restaurantId), actorName: req.userRole || null, action: 'catalog.reverse_sync', category: 'catalog', description: `Reverse sync from Meta: ${stats.new_items_added} new, ${stats.existing_items_updated} updated`, restaurantId: req.restaurantId, severity: 'info' });
  } catch (e) {
    req.log.error({ err: e, metaResponse: e.response?.data }, 'Catalog reverse sync failed');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// GET /api/restaurant/catalog/products?branchId=... — list products in Meta catalog
router.get('/catalog/products', async (req, res) => {
  try {
    const { branchId } = req.query;
    if (!branchId) return res.status(400).json({ error: 'branchId required' });
    const result = await catalog.getCatalogProducts(branchId);
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/catalog/product — add single item to catalog
router.post('/catalog/product', requirePermission('manage_menu'), async (req, res) => {
  try {
    const { menuItemId } = req.body;
    if (!menuItemId) return res.status(400).json({ error: 'menuItemId required' });
    const result = await catalog.addProduct(menuItemId);
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// PUT /api/restaurant/catalog/product/:id — update single item in catalog
router.put('/catalog/product/:id', requirePermission('manage_menu'), async (req, res) => {
  try {
    const result = await catalog.updateProduct(req.params.id);
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// DELETE /api/restaurant/catalog/product/:id — remove item from catalog
router.delete('/catalog/product/:id', requirePermission('manage_menu'), async (req, res) => {
  try {
    // [TENANT] catalog.deleteProduct propagates to Meta's catalog API — must
    // verify ownership BEFORE calling it, otherwise an attacker could delete
    // any restaurant's items from Meta's catalog by guessing item IDs.
    const item = await _assertMenuItemOwnedBy(req.params.id, req.restaurantId);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const result = await catalog.deleteProduct(item, item.branch_id);
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/catalog/toggle-auto-sync — enable/disable auto sync
router.post('/catalog/toggle-auto-sync', async (req, res) => {
  try {
    const { enabled } = req.body;
    await col('restaurants').updateOne(
      { _id: req.restaurantId },
      { $set: { catalog_sync_enabled: !!enabled, updated_at: new Date() } }
    );
    res.json({ success: true, catalogSyncEnabled: !!enabled });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/catalog/create-new — Create a new catalog via Meta API
// Guard: only ONE catalog per restaurant
router.post('/catalog/create-new', requireApproved, async (req, res) => {
  try {
    const { name, force } = req.body;
    const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });

    // Prevent duplicate — if catalog already exists, return it
    if (restaurant?.meta_catalog_id && !force) {
      return res.json({
        success: true,
        already_exists: true,
        catalog_id: restaurant.meta_catalog_id,
        catalog_name: restaurant.meta_catalog_name,
        message: 'You already have a catalog. Items will be added to your existing catalog.',
      });
    }

    const catName = name || `${restaurant?.business_name || 'Restaurant'} - Menu`;
    const bizId = restaurant?.meta_business_id || metaConfig.businessId;
    if (!bizId) return res.status(400).json({ error: 'No Meta Business ID configured. Complete WhatsApp setup first.' });

    const token = metaConfig.systemUserToken;
    if (!token) return res.status(500).json({ error: 'Meta token not configured. Contact support.' });

    const response = await axios.post(
      `https://graph.facebook.com/${metaConfig.apiVersion}/${bizId}/owned_product_catalogs`,
      { name: catName, vertical: 'commerce' },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const catalogId = response.data.id;
    req.log.info({ catalogId, restaurantId: req.restaurantId }, 'Created new catalog');

    // Fire-and-forget: assign the System User to the new catalog so subsequent
    // catalog-level operations (rename, delete, item batch ops) don't 403.
    // The helper is idempotent (per-process cache) and does its own
    // system_user → business_user fallback. Errors are non-fatal — the
    // catalog was still created, and the missing permission only bites on
    // later operations that the user can retry from the UI.
    metaConfig.ensureCatalogAdminAccess(catalogId).catch(err =>
      req.log.warn({ err, catalogId }, 'Catalog admin access assignment failed (non-fatal)')
    );

    // Store as active catalog
    await col('restaurants').updateOne(
      { _id: req.restaurantId },
      { $set: { meta_catalog_id: catalogId, meta_catalog_name: catName, catalog_created_at: new Date(), updated_at: new Date() } }
    );
    await col('whatsapp_accounts').updateMany(
      { restaurant_id: req.restaurantId },
      { $set: { catalog_id: catalogId, catalog_linked: true, catalog_linked_at: new Date(), updated_at: new Date() } }
    );
    await col('branches').updateMany(
      { restaurant_id: req.restaurantId },
      { $set: { catalog_id: catalogId, updated_at: new Date() } }
    );

    // Auto-sync all existing menu items to the new catalog
    queueSync(req.restaurantId, 'full', null);

    res.json({ success: true, catalog_id: catalogId, catalog_name: catName });
  } catch (e) {
    req.log.error({ err: e, metaResponse: e.response?.data }, 'Catalog create failed');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// DELETE /api/restaurant/catalog/:catalogId — Delete a catalog via Meta API
router.delete('/catalog/:catalogId', requireApproved, async (req, res) => {
  const catalogId = req.params.catalogId;
  if (!catalogId || catalogId === 'undefined' || catalogId === 'null') {
    return res.status(400).json({ error: 'Invalid catalog ID' });
  }
  const token = metaConfig.systemUserToken;
  if (!token) return res.status(500).json({ error: 'Meta token not configured.' });

  const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
  const wa = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId, is_active: true });
  const bizId = restaurant?.meta_business_id || metaConfig.businessId;

  logger.info({ catalogId, wabaId: wa?.waba_id, bizId }, 'Catalog delete requested');

  // Helper: attempt the actual delete with auto-retry on permission error
  async function attemptDelete(retried = false) {
    try {
      // Step 0: Delete all feeds first
      try {
        const feeds = await catalog.listFeeds(catalogId);
        for (const feed of feeds) {
          try { await catalog.deleteFeed(feed.id); logger.info({ feedId: feed.id }, 'Pre-delete: removed feed'); } catch (feedErr) { logger.warn({ err: feedErr, feedId: feed.id }, 'Pre-delete: could not remove feed'); }
        }
        if (feeds.length) await new Promise(r => setTimeout(r, 1000));
      } catch (feedListErr) { logger.warn({ err: feedListErr }, 'Pre-delete: could not list feeds'); }

      // Step 1: Unlink from WABA first (if linked)
      if (wa?.waba_id) {
        try {
          await axios.delete(
            `${metaConfig.graphUrl}/${wa.waba_id}/product_catalogs`,
            { data: { catalog_id: catalogId }, headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
          );
          logger.info({ wabaId: wa.waba_id }, 'Catalog unlinked from WABA');
        } catch (unlinkErr) {
          const code = unlinkErr.response?.data?.error?.code;
          if (code === 3970 || code === 100) {
            // Permission error on unlink — try assigning admin first
            if (!retried) {
              logger.info({ catalogId }, 'Unlink permission denied, assigning admin access');
              await metaConfig.ensureCatalogAdminAccess(catalogId);
              return attemptDelete(true);
            }
          }
          // Non-permission error or already retried — ignore (may not be linked)
          logger.warn({ err: unlinkErr }, 'Catalog unlink failed, continuing');
        }
      }

      // Step 2: Delete the catalog
      await axios.delete(
        `${metaConfig.graphUrl}/${catalogId}`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
      );
      return true;
    } catch (delErr) {
      const code = delErr.response?.data?.error?.code;
      const subcode = delErr.response?.data?.error?.error_subcode;
      // Permission error — auto-retry after assigning admin
      if (!retried && (code === 3970 || code === 100 || subcode === 1690087 || subcode === 2388100)) {
        logger.info({ catalogId }, 'Delete permission denied, assigning admin access and retrying');
        const granted = await metaConfig.ensureCatalogAdminAccess(catalogId);
        if (granted) return attemptDelete(true);
      }
      throw delErr;
    }
  }

  try {
    await attemptDelete();
    logger.info({ catalogId }, 'Catalog deleted');

    // Clear from DB if it was the active catalog
    if (restaurant?.meta_catalog_id === catalogId) {
      await col('restaurants').updateOne(
        { _id: req.restaurantId },
        { $set: { meta_catalog_id: null, meta_catalog_name: null, meta_available_catalogs: [], catalog_fetched_at: null, meta_feed_id: null, catalog_feed_url: null, catalog_feed_token: null, updated_at: new Date() } }
      );
      await col('whatsapp_accounts').updateMany(
        { restaurant_id: req.restaurantId },
        { $set: { catalog_id: null, catalog_linked: false, cart_enabled: false, catalog_visible: false, updated_at: new Date() } }
      );
      await col('branches').updateMany(
        { restaurant_id: req.restaurantId },
        { $set: { catalog_id: null, updated_at: new Date() } }
      );
    }

    res.json({ success: true });
  } catch (e) {
    const metaErr = e.response?.data?.error;
    logger.error({ err: e, metaErr }, 'Catalog delete failed');
    const userMsg = (metaErr?.code === 3970 || metaErr?.error_subcode === 1690087)
      ? 'Could not get admin access to this catalog. Please go to Meta Business Suite → Commerce Manager → Catalog Settings and make sure your Business account has admin access, then try again.'
      : (metaErr?.message || e.message);
    res.status(500).json({ error: userMsg });
  }
});

// POST /api/restaurant/catalog/connect-waba — Connect catalog to WABA
router.post('/catalog/connect-waba', async (req, res) => {
  try {
    const { catalog_id } = req.body;
    if (!catalog_id) return res.status(400).json({ error: 'catalog_id is required' });

    const wa = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId, is_active: true });
    if (!wa?.waba_id) return res.status(400).json({ error: 'No WABA connected. Complete WhatsApp setup first.' });

    const token = metaConfig.systemUserToken;
    if (!token) return res.status(500).json({ error: 'Meta token not configured.' });

    await axios.post(
      `https://graph.facebook.com/${metaConfig.apiVersion}/${wa.waba_id}/product_catalogs`,
      { catalog_id },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    req.log.info({ catalogId: catalog_id, wabaId: wa.waba_id }, 'Catalog connected to WABA');

    // Update DB
    await col('whatsapp_accounts').updateOne(
      { _id: wa._id },
      { $set: { catalog_id, catalog_linked: true, updated_at: new Date() } }
    );
    await col('restaurants').updateOne(
      { _id: req.restaurantId },
      { $set: { meta_catalog_id: catalog_id, updated_at: new Date() } }
    );
    await col('branches').updateMany(
      { restaurant_id: req.restaurantId },
      { $set: { catalog_id, updated_at: new Date() } }
    );

    // Auto-enable commerce settings (visibility + cart) after connecting.
    // Tracks success/failure so the response surfaces partial-success to
    // the dashboard — previously this block silently swallowed errors and
    // the route returned `{success:true}` even when Meta rejected the
    // commerce settings update, causing the dashboard to show a misleading
    // "connected" toast while Commerce Manager remained unlinked.
    let metaSyncOk = false;
    let metaSyncError = null;
    if (!wa.phone_number_id) {
      metaSyncError = 'WhatsApp phone number not registered yet — catalog saved in DB but Meta commerce settings not updated. Re-run after the phone number is approved.';
      console.error('[catalog-connect-waba] phone_number_id missing on WABA — Meta sync skipped', {
        restaurantId: req.restaurantId, wabaId: wa.waba_id, catalogId: catalog_id,
      });
      logger.warn({ restaurantId: req.restaurantId, wabaId: wa.waba_id }, 'phone_number_id missing — Meta commerce_settings sync skipped');
    } else {
      try {
        await axios.post(
          `${metaConfig.graphUrl}/${wa.phone_number_id}/whatsapp_commerce_settings`,
          { catalog_id, is_catalog_visible: true, is_cart_enabled: true },
          { headers: { Authorization: `Bearer ${metaConfig.getCatalogToken()}` }, timeout: 15000 }
        );
        await col('whatsapp_accounts').updateOne({ _id: wa._id }, { $set: { catalog_visible: true, cart_enabled: true } });
        logger.info('Auto-enabled commerce settings after connect');
        metaSyncOk = true;
      } catch (csErr) {
        const apiErr = csErr.response?.data?.error;
        metaSyncError = apiErr?.message || csErr.message || 'Meta commerce_settings update failed';
        // console.error so the failure surfaces in pm2 logs even when the
        // structured logger pipeline is filtering warns.
        console.error('[catalog-connect-waba] whatsapp_commerce_settings failed', {
          restaurantId: req.restaurantId,
          phoneNumberId: wa.phone_number_id,
          catalogId: catalog_id,
          error: metaSyncError,
          metaResponse: apiErr || csErr.response?.data || null,
        });
        logger.warn({ err: csErr, metaResponse: apiErr }, 'Auto-enable commerce settings failed after connect');
      }
    }

    // Auto-sync all menu items to the connected catalog
    queueSync(req.restaurantId, 'full', null);

    // Partial-success response: catalog_saved is the DB write; meta_sync
    // is the commerce_settings update. Dashboard should show a warning
    // toast (not a success toast) when meta_sync is false.
    res.json({
      success: true,
      catalog_saved: true,
      meta_sync: metaSyncOk,
      ...(metaSyncError ? { meta_error: metaSyncError } : {}),
    });
  } catch (e) {
    req.log.error({ err: e, metaResponse: e.response?.data }, 'Catalog connect WABA failed');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// POST /api/restaurant/catalog/disconnect-waba — Disconnect catalog from WABA
router.post('/catalog/disconnect-waba', async (req, res) => {
  const wa = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId, is_active: true });
  if (!wa?.waba_id) return res.status(400).json({ error: 'No WABA connected.' });
  const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
  const catalogId = wa?.catalog_id || restaurant?.meta_catalog_id;
  if (!catalogId) return res.status(400).json({ error: 'No catalog connected.' });

  const token = metaConfig.systemUserToken;
  if (!token) return res.status(500).json({ error: 'Meta token not configured.' });

  logger.info({ catalogId, wabaId: wa.waba_id }, 'Catalog disconnect requested');

  async function attemptDisconnect(retried = false) {
    try {
      await axios.delete(
        `${metaConfig.graphUrl}/${wa.waba_id}/product_catalogs`,
        { data: { catalog_id: catalogId }, headers: { Authorization: `Bearer ${token}` } }
      );
      return true;
    } catch (e) {
      const code = e.response?.data?.error?.code;
      const subcode = e.response?.data?.error?.error_subcode;
      if (!retried && (code === 3970 || code === 100 || subcode === 1690087 || subcode === 2388100)) {
        logger.info({ catalogId }, 'Disconnect permission denied, assigning admin access and retrying');
        const granted = await metaConfig.ensureCatalogAdminAccess(catalogId);
        if (granted) return attemptDisconnect(true);
      }
      throw e;
    }
  }

  try {
    await attemptDisconnect();
    logger.info({ catalogId, wabaId: wa.waba_id }, 'Catalog disconnected from WABA');

    await col('whatsapp_accounts').updateOne(
      { _id: wa._id },
      { $set: { catalog_id: null, catalog_linked: false, cart_enabled: false, catalog_visible: false, updated_at: new Date() } }
    );
    await col('restaurants').updateOne(
      { _id: req.restaurantId },
      { $set: { meta_catalog_id: null, meta_catalog_name: null, updated_at: new Date() } }
    );
    await col('branches').updateMany(
      { restaurant_id: req.restaurantId },
      { $set: { catalog_id: null, updated_at: new Date() } }
    );

    res.json({ success: true });
  } catch (e) {
    const metaErr = e.response?.data?.error;
    logger.error({ err: e, metaErr }, 'Catalog disconnect WABA failed');
    const userMsg = (metaErr?.code === 3970 || metaErr?.error_subcode === 1690087)
      ? 'Could not get admin access to this catalog. Please go to Meta Business Suite → Commerce Manager → Catalog Settings and ensure your Business account has admin access, then try again.'
      : (metaErr?.message || e.message);
    res.status(500).json({ error: userMsg });
  }
});

// POST /api/restaurant/catalog/switch — atomic catalog switch (disconnect old + connect new)
router.post('/catalog/switch', requireApproved, async (req, res) => {
  const { catalog_id } = req.body;
  if (!catalog_id) return res.status(400).json({ error: 'catalog_id is required' });
  try {
    const result = await catalog.switchCatalog(req.restaurantId, catalog_id);
    queueSync(req.restaurantId, 'full', null); // Auto-sync to new catalog
    res.json(result);
  } catch (e) {
    req.log.error({ err: e }, 'Catalog switch failed');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ═══════════════════════════════════════════════════════════════
// MULTI-BRANCH MENU MANAGEMENT
// ═══════════════════════════════════════════════════════════════

// POST /api/restaurant/menu/bulk-assign-branch — assign multiple items to a branch
router.post('/menu/bulk-assign-branch', requirePermission('manage_menu'), async (req, res) => {
  try {
    const { item_ids, branch_id } = req.body;
    if (!item_ids?.length) return res.status(400).json({ error: 'item_ids array is required' });
    if (!branch_id) return res.status(400).json({ error: 'branch_id is required' });

    // Verify the branch belongs to this restaurant
    const branch = await col('branches').findOne({ _id: branch_id, restaurant_id: req.restaurantId });
    if (!branch) return res.status(404).json({ error: 'Branch not found' });

    const result = await col('menu_items').updateMany(
      { _id: { $in: item_ids }, restaurant_id: req.restaurantId },
      { $set: { branch_id, updated_at: new Date(), catalog_sync_status: 'pending' } }
    );

    req.log.info({ assignedCount: result.modifiedCount, branchName: branch.name, branchId: branch_id }, 'Bulk assigned items to branch');

    queueSync(req.restaurantId, 'branch', [branch_id]);

    res.json({ success: true, assigned: result.modifiedCount, branch_name: branch.name });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// PUT /api/restaurant/menu/:itemId/branch — move single item to a different branch
router.put('/menu/:itemId/branch', requirePermission('manage_menu'), async (req, res) => {
  try {
    const { branch_id } = req.body;
    if (!branch_id) return res.status(400).json({ error: 'branch_id is required' });

    const branch = await col('branches').findOne({ _id: branch_id, restaurant_id: req.restaurantId });
    if (!branch) return res.status(404).json({ error: 'Branch not found' });

    const item = await col('menu_items').findOne({ _id: req.params.itemId });
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const oldBranchId = item.branch_id;
    await col('menu_items').updateOne(
      { _id: req.params.itemId },
      { $set: { branch_id, updated_at: new Date(), catalog_sync_status: 'pending' } }
    );

    req.log.info({ itemName: item.name, oldBranchId, newBranchName: branch.name, newBranchId: branch_id }, 'Moved item to different branch');

    // No Meta catalog change needed — one catalog for all branches
    // Just re-sync to update product_tags/retailer_id if branch-encoded
    queueSync(req.restaurantId, 'branch', [branch_id, oldBranchId].filter(Boolean));

    res.json({ success: true, item_name: item.name, branch_name: branch.name });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/catalog/merge — merge multiple catalogs into one
router.post('/catalog/merge', requireApproved, async (req, res) => {
  try {
    const { primary_catalog_id } = req.body;
    const token = metaConfig.systemUserToken;
    if (!token) return res.status(500).json({ error: 'Meta token not configured.' });

    const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
    const wa = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId, is_active: true });

    // Fetch all catalogs from WABA and business
    let allCatalogs = [];
    if (wa?.waba_id) {
      allCatalogs = await catalog.fetchWabaCatalogs(wa.waba_id);
    }
    if (!allCatalogs.length) {
      const bizId = restaurant?.meta_business_id || metaConfig.businessId;
      if (bizId) allCatalogs = await catalog.fetchBusinessCatalogs(bizId);
    }

    if (allCatalogs.length <= 1) {
      return res.json({ success: true, message: 'Only one catalog found — no merge needed.', merged: 0 });
    }

    // Determine primary catalog
    const primaryId = primary_catalog_id || restaurant?.meta_catalog_id || allCatalogs[0]?.id;
    const secondaryCatalogs = allCatalogs.filter(c => c.id !== primaryId);

    let totalCopied = 0, totalDuplicates = 0;
    const results = [];

    for (const secondary of secondaryCatalogs) {
      try {
        // Fetch items from secondary catalog — getCatalogProducts returns { products: [...] }
        const secResult = await catalog.getCatalogProducts(secondary.id);
        const items = secResult?.products || [];
        if (!items.length) {
          results.push({ catalog_id: secondary.id, name: secondary.name, items: 0, copied: 0 });
          continue;
        }

        // Check for duplicates (same name + same price) in primary
        const priResult = await catalog.getCatalogProducts(primaryId);
        const primaryItems = priResult?.products || [];
        const primaryKeys = new Set(primaryItems.map(i => `${(i.name||'').toLowerCase()}_${i.price}`));

        let copied = 0, dupes = 0;
        for (const item of items) {
          const key = `${(item.name||'').toLowerCase()}_${item.price}`;
          if (primaryKeys.has(key)) { dupes++; continue; }

          // Try to build full data from MongoDB menu_item + mapMenuItemToMetaProduct
          let itemData;
          const rid = item.retailer_id || `merged-${item.id}`;
          const menuItem = await col('menu_items').findOne({ retailer_id: rid });
          if (menuItem) {
            const branch = await col('branches').findOne({ _id: menuItem.branch_id });
            itemData = catalog.mapMenuItemToMetaProduct(menuItem, restaurant, branch);
          } else {
            // Fallback for orphan items only on Meta
            itemData = {
              title: item.name || item.title || 'Menu Item',
              description: item.description || item.name || 'Menu item',
              price: item.price || '0.00 INR',
              availability: item.availability || 'in stock',
              condition: 'new',
              image_link: item.image_url || '',
              brand: item.brand || '',
              link: `https://gullybite.com/menu/${rid}`,
              google_product_category: 'Food, Beverages & Tobacco > Food Items',
              origin_country: 'IN',
              wa_compliance_category: 'COUNTRY_ORIGIN_EXEMPT',
              manufacturer_info: restaurant.business_name || 'Restaurant',
            };
          }

          try {
            await axios.post(
              `${metaConfig.graphUrl}/${primaryId}/items_batch`,
              {
                item_type: 'PRODUCT_ITEM',
                allow_upsert: true,
                requests: JSON.stringify([{ method: 'UPDATE', retailer_id: rid, data: itemData }]),
              },
              { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 }
            );
            copied++;
          } catch (copyErr) {
            logger.warn({ err: copyErr, itemName: item.name }, 'Catalog merge failed to copy item');
          }
        }

        totalCopied += copied;
        totalDuplicates += dupes;
        results.push({ catalog_id: secondary.id, name: secondary.name, items: items.length, copied, duplicates: dupes });

        // Delete feeds on secondary catalog before disconnecting
        try {
          const secFeeds = await catalog.listFeeds(secondary.id);
          for (const feed of secFeeds) {
            try { await catalog.deleteFeed(feed.id); } catch (feedErr) { logger.warn({ err: feedErr, feedId: feed.id }, 'Catalog merge feed delete failed'); }
          }
        } catch (_) { /* non-fatal */ }

        // Disconnect secondary from WABA
        if (wa?.waba_id) {
          try {
            await axios.delete(`${metaConfig.graphUrl}/${wa.waba_id}/product_catalogs`, {
              data: { catalog_id: secondary.id }, headers: { Authorization: `Bearer ${token}` },
            });
          } catch (_) { /* may not be linked */ }
        }
      } catch (e) {
        results.push({ catalog_id: secondary.id, name: secondary.name, error: e.message });
      }
    }

    // Update DB to point to primary catalog
    await col('restaurants').updateOne(
      { _id: req.restaurantId },
      { $set: { meta_catalog_id: primaryId, updated_at: new Date() } }
    );
    await col('whatsapp_accounts').updateMany(
      { restaurant_id: req.restaurantId },
      { $set: { catalog_id: primaryId, catalog_linked: true, updated_at: new Date() } }
    );
    await col('branches').updateMany(
      { restaurant_id: req.restaurantId },
      { $set: { catalog_id: primaryId, updated_at: new Date() } }
    );

    req.log.info({ primaryId, mergedCount: secondaryCatalogs.length, totalCopied, totalDuplicates }, 'Catalog merge complete');
    res.json({ success: true, primary_catalog_id: primaryId, merged: secondaryCatalogs.length, total_copied: totalCopied, duplicates_skipped: totalDuplicates, details: results });
  } catch (e) {
    req.log.error({ err: e }, 'Catalog merge failed');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// GET /api/restaurant/catalog/detect-duplicates — find duplicate catalogs or items
router.get('/catalog/detect-duplicates', async (req, res) => {
  try {
    const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
    const wa = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId, is_active: true });

    let allCatalogs = [];
    if (wa?.waba_id) allCatalogs = await catalog.fetchWabaCatalogs(wa.waba_id);
    if (!allCatalogs.length) {
      const bizId = restaurant?.meta_business_id || metaConfig.businessId;
      if (bizId) allCatalogs = await catalog.fetchBusinessCatalogs(bizId);
    }

    // Detect duplicate items within the main catalog (same name + price in DB)
    const branchDocs = await col('branches').find({ restaurant_id: req.restaurantId }).toArray();
    const branchIds = branchDocs.map(b => String(b._id));
    const items = branchIds.length
      ? await col('menu_items').find({ branch_id: { $in: branchIds } }).toArray()
      : [];

    const dupeMap = {};
    for (const item of items) {
      const key = `${(item.name||'').toLowerCase().trim()}_${item.price_paise}`;
      if (!dupeMap[key]) dupeMap[key] = [];
      dupeMap[key].push({ id: String(item._id), name: item.name, branch_id: item.branch_id, price_paise: item.price_paise });
    }
    const duplicateItems = Object.values(dupeMap).filter(arr => arr.length > 1);

    res.json({
      catalogs: allCatalogs,
      multiple_catalogs: allCatalogs.length > 1,
      active_catalog_id: restaurant?.meta_catalog_id,
      duplicate_items: duplicateItems,
      duplicate_item_groups: duplicateItems.length,
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/catalogs — Returns this restaurant's connected catalog from MongoDB.
// Only fetches live from Meta when ?refresh=true or no cached data exists.
router.get('/catalogs', async (req, res) => {
  try {
    const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
    const wa_acc = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId, is_active: true });

    const activeCatalogId = restaurant?.meta_catalog_id || wa_acc?.catalog_id || null;
    const forceRefresh = req.query.refresh === 'true';

    // Return cached catalog list if available and not forcing refresh
    const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
    const cacheAge = restaurant?.catalog_fetched_at ? Date.now() - new Date(restaurant.catalog_fetched_at).getTime() : Infinity;

    if (!forceRefresh && cacheAge < CACHE_TTL_MS && restaurant?.meta_available_catalogs?.length) {
      return res.json({ active_catalog_id: activeCatalogId, catalogs: restaurant.meta_available_catalogs, cached: true });
    }

    // If we have a main catalog ID but no cached list, return just that
    if (!forceRefresh && activeCatalogId && !restaurant?.meta_available_catalogs?.length) {
      const single = [{ id: activeCatalogId, name: restaurant?.meta_catalog_name || 'Menu Catalog' }];
      return res.json({ active_catalog_id: activeCatalogId, catalogs: single, cached: true });
    }

    // Live fetch from Meta (only on refresh or first load with no cache)
    if (!wa_acc?.waba_id && !restaurant?.meta_user_id) {
      return res.status(400).json({ error: 'Meta Business not connected. Complete WhatsApp setup first.' });
    }

    const catToken = metaConfig.systemUserToken;
    if (!catToken) return res.status(500).json({ error: 'No Meta token configured. Please contact support.' });

    // Fetch ALL catalogs from business AND connected catalogs from WABA in parallel
    let allCatalogs = [];
    let connectedIds = new Set();
    const bizId = restaurant?.meta_business_id || metaConfig.businessId;

    const [wabaResult, bizResult] = await Promise.allSettled([
      wa_acc?.waba_id ? catalog.fetchWabaCatalogs(wa_acc.waba_id) : [],
      bizId ? catalog.fetchBusinessCatalogs(bizId) : [],
    ]);

    const wabaCatalogs = wabaResult.status === 'fulfilled' ? wabaResult.value : [];
    allCatalogs = bizResult.status === 'fulfilled' ? bizResult.value : [];

    for (const c of wabaCatalogs) connectedIds.add(c.id);
    if (!allCatalogs.length && wabaCatalogs.length) allCatalogs = wabaCatalogs;

    // 4. Mark each catalog's connection status
    const catalogs = allCatalogs.map(c => ({
      ...c,
      connected: connectedIds.has(c.id),
    }));

    // Cache the result
    if (catalogs.length) {
      await col('restaurants').updateOne(
        { _id: req.restaurantId },
        { $set: { meta_available_catalogs: catalogs, catalog_fetched_at: new Date() } }
      );
    }

    // Check commerce settings on phone number
    let commerceEnabled = false;
    if (wa_acc?.phone_number_id && activeCatalogId) {
      try {
        const csResp = await axios.get(`${metaConfig.graphUrl}/${wa_acc.phone_number_id}/whatsapp_commerce_settings`, {
          headers: { Authorization: `Bearer ${metaConfig.systemUserToken}` },
        });
        commerceEnabled = !!csResp.data?.data?.[0]?.is_catalog_visible;
      } catch (_) { /* commerce settings may not exist yet */ }
    }

    res.json({ active_catalog_id: activeCatalogId, catalogs, cached: false, commerce_enabled: commerceEnabled });
  } catch (e) {
    req.log.error({ err: e }, 'Failed to fetch catalogs from Meta');
    res.status(500).json({ error: 'Failed to fetch catalogs from Meta' });
  }
});

// PUT /api/restaurant/catalog — Change active catalog
router.put('/catalog', async (req, res) => {
  try {
    const { catalog_id, catalog_name } = req.body;
    if (!catalog_id) return res.status(400).json({ error: 'catalog_id is required' });

    // Update restaurant
    await col('restaurants').updateOne(
      { _id: req.restaurantId },
      { $set: { meta_catalog_id: catalog_id, meta_catalog_name: catalog_name || '', updated_at: new Date() } }
    );

    // Update all whatsapp accounts
    await col('whatsapp_accounts').updateMany(
      { restaurant_id: req.restaurantId },
      { $set: { catalog_id: catalog_id, updated_at: new Date() } }
    );

    // Update all branches
    await col('branches').updateMany(
      { restaurant_id: req.restaurantId },
      { $set: { catalog_id: catalog_id, updated_at: new Date() } }
    );

    req.log.info({ restaurantId: req.restaurantId, catalogId: catalog_id }, 'Switched to catalog');
    res.json({ success: true, catalog_id });
  } catch (e) {
    req.log.error({ err: e }, 'Catalog switch failed');
    res.status(500).json({ error: 'Failed to update catalog' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ORDERS — Restaurant views and manages orders
// ═══════════════════════════════════════════════════════════════

router.get('/orders', async (req, res) => {
  try {
    const { status, branchId, brand_id, limit = 50, offset = 0 } = req.query;

    // Brand context: single tenants pass through, multi tenants must
    // supply brand_id (auto-filled from default_brand_id when possible).
    const { resolveBrandContext, setBrandHeaders } = require('../utils/brandContext');
    const brandCtx = await resolveBrandContext(req.restaurantId, brand_id);
    if (brandCtx.missing) {
      return res.status(400).json({ error: 'brand_id is required for multi-brand businesses', business_type: brandCtx.business_type });
    }
    setBrandHeaders(res, brandCtx);

    // Get all branch IDs for this restaurant
    const branchFilter = { restaurant_id: req.restaurantId };
    if (branchId) branchFilter._id = branchId;
    const branches = await col('branches').find(branchFilter).project({ _id: 1 }).toArray();
    const branchIds = branches.map(b => String(b._id));

    const filter = { branch_id: { $in: branchIds } };
    if (status) filter.status = status;
    // Brand filter — from query param or default_brand_id on multi tenants.
    if (brandCtx.effective_brand_id) filter.brand_id = brandCtx.effective_brand_id;

    const orders = await col('orders')
      .find(filter)
      .sort({ created_at: -1 })
      .skip(parseInt(offset))
      .limit(parseInt(limit))
      .toArray();

    // Enrich with customer + branch names + order items
    const enriched = await Promise.all(orders.map(async o => {
      const [customer, branch, items] = await Promise.all([
        col('customers').findOne({ _id: o.customer_id }),
        col('branches').findOne({ _id: o.branch_id }),
        col('order_items').find({ order_id: String(o._id) }).toArray(),
      ]);
      return {
        ...mapId(o),
        customer_name: customer?.name,
        wa_phone:      maskPhone(customer?.wa_phone),
        branch_name:   branch?.name,
        items:         mapIds(items),
      };
    }));

    res.json(enriched);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/orders/:orderId — single order with items + charge breakdown
router.get('/orders/:orderId', async (req, res) => {
  try {
    const o = await col('orders').findOne({ _id: req.params.orderId });
    if (!o) return res.status(404).json({ error: 'Order not found' });

    const branch = await col('branches').findOne({ _id: o.branch_id });
    if (!branch || branch.restaurant_id !== req.restaurantId) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const [customer, items] = await Promise.all([
      col('customers').findOne({ _id: o.customer_id }),
      col('order_items').find({ order_id: req.params.orderId }).sort({ _id: 1 }).toArray(),
    ]);

    res.json({
      ...mapId(o),
      customer_name: customer?.name,
      wa_phone:      maskPhone(customer?.wa_phone),
      branch_name:   branch?.name,
      items:         mapIds(items),
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// Restaurant updates order status (CONFIRMED → PREPARING → PACKED)
router.patch('/orders/:orderId/status', requireApproved, requirePermission('manage_orders'), async (req, res) => {
  try {
    const { status } = req.body;
    // Role-based status restrictions
    let allowed = ['CONFIRMED', 'PREPARING', 'PACKED'];
    if (req.userRole === 'kitchen')  allowed = ['PREPARING', 'PACKED'];
    if (req.userRole === 'delivery') allowed = ['DISPATCHED', 'DELIVERED'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `Your role allows: ${allowed.join(', ')}` });
    }

    const order = await orderSvc.updateStatus(req.params.orderId, status);

    ws.broadcastOrder(req.restaurantId, 'order_status_changed', { orderId: req.params.orderId, newStatus: status, updatedAt: new Date().toISOString() });

    // Recalculate ETA on status change
    let etaResult = null;
    try { etaResult = await etaSvc.updateETAOnStatusChange(req.params.orderId, status); }
    catch (e) { req.log.warn({ err: e, orderId: req.params.orderId }, 'ETA update failed'); }

    if (order) {
      const fullOrder = await orderSvc.getOrderDetails(order.id);
      if (fullOrder?.phone_number_id) {
        await notifyOrderStatus(
          req.restaurantId,
          fullOrder.phone_number_id, fullOrder.access_token, fullOrder.wa_phone,
          status,
          {
            _orderId        : order.id,
            order_number    : fullOrder.order_number,
            customer_name   : fullOrder.customer_name,
            total_rs        : `₹${parseFloat(fullOrder.total_rs).toFixed(0)}`,
            branch_name     : fullOrder.branch_name,
            restaurant_name : fullOrder.business_name,
            eta             : etaResult?.etaText || '',
          }
        ).catch(() => {});
      }
    }

    // Manager notification now handled by notificationListener.onOrderUpdated,
    // which subscribes to order.updated emitted by orderStateEngine.transitionOrder.

    res.json({ success: true, order, eta: etaResult });

    log({
      actorType: 'restaurant', actorId: String(req.userId || req.restaurantId), actorName: req.userRole || null,
      action: 'order.status_changed', category: 'order',
      description: `Order ${req.params.orderId} status changed from ${req.body._oldStatus || 'unknown'} to ${status}`,
      restaurantId: req.restaurantId || req.restaurant?._id,
      branchId: order?.branch_id || null,
      resourceType: 'order', resourceId: req.params.orderId,
      severity: 'info',
      metadata: { oldStatus: req.body._oldStatus || null, newStatus: status },
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── PERSISTENT ORDER NOTIFICATIONS (Zomato/Swiggy-style) ─────
// Backend chokepoint stamps notified_at + broadcasts new_paid_order
// when payment lands. The dashboard either receives that broadcast
// over WebSocket or polls this endpoint when the WS is down. Either
// way, the modal stays open (looping sound) until the restaurant
// clicks Accept (PAID → CONFIRMED) or Decline (refund + PAID →
// CANCELLED). Acknowledgement is recorded on the order so the same
// modal never resurfaces.
//
// Path is /pending-order-notifications (NOT under /orders/:orderId)
// to avoid Express shadowing by the /orders/:orderId GET above.
router.get('/pending-order-notifications', async (req, res) => {
  try {
    const windowMin = Math.min(parseInt(req.query.window_min) || 60, 240);
    const since = new Date(Date.now() - windowMin * 60 * 1000);

    const orders = await col('orders').find({
      restaurant_id: req.restaurantId,
      status: 'PAID',
      acknowledged_at: { $exists: false },
      notified_at: { $gte: since },
    }).sort({ notified_at: 1 }).limit(20).toArray();

    if (!orders.length) return res.json([]);

    const enriched = await Promise.all(orders.map(async o => {
      const [customer, items] = await Promise.all([
        col('customers').findOne({ _id: o.customer_id }),
        col('order_items').find({ order_id: String(o._id) }).toArray(),
      ]);
      return {
        orderId: String(o._id),
        orderNumber: o.order_number,
        customerName: customer?.name || o.customer_name || '',
        customerPhone: maskPhone(customer?.wa_phone || o.customer_phone),
        totalRs: o.total_rs,
        itemCount: items.reduce((s, i) => s + (i.quantity || 0), 0),
        items: items.slice(0, 6).map(i => ({ name: i.name || i.item_name, quantity: i.quantity })),
        orderType: o.order_type || 'delivery',
        notifiedAt: o.notified_at,
      };
    }));

    res.json(enriched);
  } catch (e) {
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// POST /api/restaurant/orders/:orderId/accept
// PAID → CONFIRMED. Stamps acknowledgement so the modal closes and
// doesn't reappear on the next poll. The state-engine update is the
// authoritative transition; ack fields are denormalized for the UI.
router.post('/orders/:orderId/accept', requireApproved, requirePermission('manage_orders'), async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const order = await col('orders').findOne({ _id: orderId });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.restaurant_id !== req.restaurantId) {
      return res.status(404).json({ error: 'Order not found' });
    }
    // Already acknowledged — idempotent success so a duplicate click
    // (or two managers racing) doesn't surface an error.
    if (order.acknowledged_at) {
      return res.json({ success: true, alreadyAcknowledged: true, status: order.status });
    }
    if (order.status !== 'PAID') {
      return res.status(409).json({ error: `Cannot accept order in status ${order.status}` });
    }
    // Per-user branch guard — applies to staff JWTs scoped to specific
    // branches AND to restaurant JWTs for branch-scoped managers.
    // Empty branchIds = no restriction (owner default). Centralized via
    // req.actor (set by requireStaffOrRestaurantAuth above).
    if (req.actor?.branchIds?.length) {
      if (!req.actor.branchIds.map(String).includes(String(order.branch_id))) {
        return res.status(403).json({ error: 'Forbidden — order not in your branch' });
      }
    }

    const now = new Date();
    await col('orders').updateOne(
      { _id: orderId, acknowledged_at: { $exists: false } },
      { $set: { acknowledged_at: now, acknowledged_by: req.userId || null } }
    );

    await orderSvc.updateStatus(orderId, 'CONFIRMED', {
      actor: req.userId || 'restaurant',
      actorType: req.actor?.type === 'staff' ? 'staff' : 'restaurant',
    });

    // Cancel the BullMQ acceptance-timeout job — restaurant acted in
    // time. Best-effort: removeAcceptanceTimeoutJob is a no-op when the
    // job is missing, so retries / stale ids never throw.
    if (order.acceptance_timeout_job_id) {
      try {
        const { removeAcceptanceTimeoutJob } = require('../jobs/orderAcceptanceQueue');
        await removeAcceptanceTimeoutJob(order.acceptance_timeout_job_id);
      } catch (_) {}
    }

    // Trigger Prorouting dispatch — moved here from the post-payment
    // fan-out so dispatch only fires AFTER the restaurant accepts.
    // Fire-and-forget: a Prorouting outage shouldn't block the
    // accept-modal close. The post-payment ORDER_DISPATCH job that used
    // to handle this is gated by a status guard (`!== 'CONFIRMED'`)
    // for stale jobs in flight during deploy.
    setImmediate(() => {
      const { enqueue, JOB_TYPES } = require('../queue/postPaymentJobs');
      enqueue(JOB_TYPES.ORDER_DISPATCH, { orderId: String(orderId), restaurantId: String(req.restaurantId) })
        .catch((err) => req.log?.warn?.({ err: err?.message, orderId }, 'enqueue ORDER_DISPATCH failed (non-fatal)'));
    });

    ws.broadcastOrder(req.restaurantId, 'order_acknowledged', {
      orderId, action: 'accept', newStatus: 'CONFIRMED',
    });
    ws.broadcastOrder(req.restaurantId, 'order_status_changed', {
      orderId, newStatus: 'CONFIRMED', updatedAt: now.toISOString(),
    });

    // Customer confirmation — fire-and-forget so a WhatsApp hiccup
    // doesn't fail the accept call.
    try {
      const fullOrder = await orderSvc.getOrderDetails(orderId);
      if (fullOrder?.phone_number_id) {
        notifyOrderStatus(
          req.restaurantId,
          fullOrder.phone_number_id, fullOrder.access_token, fullOrder.wa_phone,
          'CONFIRMED',
          {
            _orderId: orderId,
            order_number: fullOrder.order_number,
            customer_name: fullOrder.customer_name,
            total_rs: `₹${parseFloat(fullOrder.total_rs).toFixed(0)}`,
            branch_name: fullOrder.branch_name,
            restaurant_name: fullOrder.business_name,
          }
        ).catch(() => {});
      }
    } catch (_) {}

    res.json({ success: true, status: 'CONFIRMED' });

    log({
      actorType: 'restaurant', actorId: String(req.userId || req.restaurantId), actorName: req.userRole || null,
      action: 'order.accepted', category: 'order',
      description: `Order ${orderId} accepted (PAID → CONFIRMED)`,
      restaurantId: req.restaurantId,
      branchId: order.branch_id,
      resourceType: 'order', resourceId: orderId,
      severity: 'info',
    });
  } catch (e) {
    req.log?.error?.({ err: e, orderId: req.params.orderId }, 'order accept failed');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// POST /api/restaurant/orders/:orderId/decline
// Restaurant rejects a PAID order. Issues a Razorpay refund first;
// only if that succeeds do we transition PAID → CANCELLED. The order
// stays in PAID (with acknowledged_at set) on refund failure so ops
// can retry — never trap the customer in limbo.
// Body: { reason: string }
router.post('/orders/:orderId/decline', express.json(), requireApproved, requirePermission('manage_orders'), async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const reason = (req.body?.reason || '').toString().trim().slice(0, 500) || 'Restaurant declined';

    const order = await col('orders').findOne({ _id: orderId });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.restaurant_id !== req.restaurantId) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.acknowledged_at) {
      return res.json({ success: true, alreadyAcknowledged: true, status: order.status });
    }
    if (order.status !== 'PAID') {
      return res.status(409).json({ error: `Cannot decline order in status ${order.status}` });
    }
    // Branch guard — same rule as /accept above (req.actor branch scope
    // applies for both staff JWTs and branch-scoped manager JWTs).
    if (req.actor?.branchIds?.length) {
      if (!req.actor.branchIds.map(String).includes(String(order.branch_id))) {
        return res.status(403).json({ error: 'Forbidden — order not in your branch' });
      }
    }

    // Stamp acknowledgement BEFORE the cancellation handler — it does
    // its own refund + state transition, and we want the modal to close
    // even if the customer-WA leg of the handler fails.
    const now = new Date();
    await col('orders').updateOne(
      { _id: orderId, acknowledged_at: { $exists: false } },
      { $set: {
          acknowledged_at: now,
          acknowledged_by: req.userId || null,
          decline_reason: reason,
      } }
    );

    // Centralized fault flow: refund → REJECTED_BY_RESTAURANT transition
    // → cancellation_fault_fee on order doc → settlement accumulator
    // increment → customer order_cancelled + refund_processed templates.
    // Refund failure throws so we abort with a 502 (customer must not
    // see CANCELLED before the refund is in flight).
    let result;
    try {
      const cancellation = require('../services/orderCancellationService');
      result = await cancellation.handleRestaurantFault(orderId, 'rejected_by_restaurant');
    } catch (err) {
      req.log?.error?.({ err, orderId }, 'decline fault handler failed');
      return res.status(502).json({ error: 'Refund failed — order not cancelled. Please retry or contact support.' });
    }

    ws.broadcastOrder(req.restaurantId, 'order_acknowledged', {
      orderId, action: 'decline', newStatus: result?.status || 'REJECTED_BY_RESTAURANT',
    });
    ws.broadcastOrder(req.restaurantId, 'order_status_changed', {
      orderId, newStatus: result?.status || 'REJECTED_BY_RESTAURANT', updatedAt: now.toISOString(),
    });

    // Prorouting 3PL cancel — fire-and-forget. Only when a rider was
    // already dispatched (prorouting_order_id set). cancelDeliveryOrder
    // swallows all errors internally so no try/catch is strictly needed,
    // but we wrap in setImmediate to detach from the response path.
    if (order.prorouting_order_id) {
      setImmediate(() => {
        const prorouting = require('../services/prorouting');
        prorouting.cancelDeliveryOrder(
          order.prorouting_order_id,
          '005',
          `Restaurant declined: ${reason}`.slice(0, 200)
        ).catch((e) => req.log?.warn?.({ err: e?.message, orderId }, 'prorouting cancel dispatch failed'));
      });
    }

    res.json({ success: true, status: result?.status || 'REJECTED_BY_RESTAURANT', refundId: result?.refundId || null });

    log({
      actorType: 'restaurant', actorId: String(req.userId || req.restaurantId), actorName: req.userRole || null,
      action: 'order.declined', category: 'order',
      description: `Order ${orderId} declined (PAID → ${result?.status || 'REJECTED_BY_RESTAURANT'}, refund ${result?.refundId || 'n/a'}, fault_fee ₹${result?.razorpayFeeRs || 0})`,
      restaurantId: req.restaurantId,
      branchId: order.branch_id,
      resourceType: 'order', resourceId: orderId,
      severity: 'warn',
      metadata: { reason, refund_id: result?.refundId || null, razorpay_fee_rs: result?.razorpayFeeRs || 0 },
    });
  } catch (e) {
    req.log?.error?.({ err: e, orderId: req.params.orderId }, 'order decline failed');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// PUT /api/restaurant/orders/:orderId/delivery
router.put('/orders/:orderId/delivery', async (req, res) => {
  try {
    const {
      provider, providerOrderId, trackingUrl,
      driverName, driverPhone,
      estimatedMins, costRs,
      status = 'assigned',
    } = req.body;

    const o = await col('orders').findOne({ _id: req.params.orderId });
    if (!o) return res.status(404).json({ error: 'Order not found' });
    const branch = await col('branches').findOne({ _id: o.branch_id });
    if (!branch || branch.restaurant_id !== req.restaurantId) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const [restaurant, wa_acc, customer] = await Promise.all([
      col('restaurants').findOne({ _id: req.restaurantId }),
      col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId, is_active: true }),
      col('customers').findOne({ _id: o.customer_id }),
    ]);

    // Update delivery record
    const $set = { status, updated_at: new Date() };
    if (provider        != null) $set.provider          = provider;
    if (providerOrderId != null) $set.provider_order_id = providerOrderId;
    if (trackingUrl     != null) $set.tracking_url      = trackingUrl;
    if (driverName      != null) $set.driver_name       = driverName;
    if (driverPhone     != null) $set.driver_phone      = driverPhone;
    if (estimatedMins   != null) $set.estimated_mins    = estimatedMins;
    if (costRs          != null) $set.cost_rs           = costRs;

    await col('deliveries').updateOne({ order_id: req.params.orderId }, { $set });

    if (status === 'picked_up' || status === 'dispatched') {
      await orderSvc.updateStatus(req.params.orderId, 'DISPATCHED');
    }

    const customerRecipient = customer?.wa_phone || customer?.bsuid;
    if (wa_acc?.phone_number_id && customerRecipient) {
      await notifyOrderStatus(
        req.restaurantId,
        wa_acc.phone_number_id, wa_acc.access_token, customerRecipient,
        'DISPATCHED',
        {
          _orderId        : req.params.orderId,
          order_number    : o.order_number,
          customer_name   : customer?.name,
          total_rs        : `₹${parseFloat(o.total_rs || 0).toFixed(0)}`,
          branch_name     : branch.name,
          restaurant_name : restaurant?.business_name,
          eta             : estimatedMins ? `~${estimatedMins} mins` : '',
          tracking_url    : trackingUrl || '',
        }
      ).catch(() => {});
    }

    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ═══════════════════════════════════════════════════════════════
// 3PL DELIVERY MANAGEMENT
// ═══════════════════════════════════════════════════════════════

// GET /api/restaurant/orders/:orderId/track — live rider coords + tracking URL
// Proxies Prorouting /track. Caches prorouting_tracking_url on the order
// the first time we see it so the deep-link survives a restart of the
// LSP's tracking tile. Returns 502 if Prorouting itself fails.
router.get('/orders/:orderId/track', async (req, res) => {
  try {
    const o = await col('orders').findOne({ _id: req.params.orderId });
    if (!o) return res.status(404).json({ error: 'Order not found' });
    const branch = await col('branches').findOne({ _id: o.branch_id });
    if (!branch || branch.restaurant_id !== req.restaurantId) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (!o.prorouting_order_id) {
      return res.status(400).json({ error: 'Delivery not yet dispatched' });
    }

    const prorouting = require('../services/prorouting');
    let tracking;
    try {
      tracking = await prorouting.getTrackingInfo(o.prorouting_order_id);
    } catch (e) {
      return res.status(502).json({ error: 'Unable to reach delivery partner' });
    }

    if (tracking?.tracking_url && !o.prorouting_tracking_url) {
      await col('orders').updateOne(
        { _id: o._id },
        { $set: { prorouting_tracking_url: tracking.tracking_url, updated_at: new Date() } }
      );
    }

    res.json({
      rider_lat: tracking?.rider_lat ?? null,
      rider_lng: tracking?.rider_lng ?? null,
      tracking_url: tracking?.tracking_url || o.prorouting_tracking_url || null,
      prorouting_status: o.prorouting_status || null,
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/orders/:orderId/sync-status — poll Prorouting /status
// Fallback for missed webhooks. Runs the returned state through the same
// shared handler as routes/webhookProrouting.js so customer messages,
// order-status transitions, and dispute auto-raises are identical.
router.post('/orders/:orderId/sync-status', async (req, res) => {
  try {
    const o = await col('orders').findOne({ _id: req.params.orderId });
    if (!o) return res.status(404).json({ error: 'Order not found' });
    const branch = await col('branches').findOne({ _id: o.branch_id });
    if (!branch || branch.restaurant_id !== req.restaurantId) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (!o.prorouting_order_id) {
      return res.status(400).json({ error: 'Delivery not yet dispatched' });
    }

    const prorouting = require('../services/prorouting');
    let statusRes;
    try {
      statusRes = await prorouting.getOrderStatus(o.prorouting_order_id);
    } catch (e) {
      return res.status(502).json({ error: 'Unable to reach delivery partner' });
    }

    const { applyProroutingState } = require('../services/proroutingState');
    const result = await applyProroutingState(o, statusRes?.state, { agent: statusRes?.agent });

    res.json({
      previous_status: result.previousStatus,
      current_status: result.currentStatus,
      updated: result.updated,
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/orders/:orderId/delivery — get delivery status
router.get('/orders/:orderId/delivery', async (req, res) => {
  try {
    const o = await col('orders').findOne({ _id: req.params.orderId });
    if (!o) return res.status(404).json({ error: 'Order not found' });
    const branch = await col('branches').findOne({ _id: o.branch_id });
    if (!branch || branch.restaurant_id !== req.restaurantId) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const deliveryService = require('../services/delivery');
    const delivery = await deliveryService.getDeliveryStatus(req.params.orderId);
    if (!delivery) return res.json({ delivery: null });
    res.json({ delivery: mapId(delivery) });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/orders/:orderId/dispatch — manual dispatch / re-dispatch
router.post('/orders/:orderId/dispatch', async (req, res) => {
  try {
    const o = await col('orders').findOne({ _id: req.params.orderId });
    if (!o) return res.status(404).json({ error: 'Order not found' });
    const branch = await col('branches').findOne({ _id: o.branch_id });
    if (!branch || branch.restaurant_id !== req.restaurantId) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const deliveryService = require('../services/delivery');
    const task = await deliveryService.dispatchDelivery(req.params.orderId);
    res.json({ success: true, task });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/orders/:orderId/report-fake-delivery
// Raises an FLM08 dispute against the 3PL when the rider marked the
// order as delivered but the customer didn't receive it. Gated on
// (a) order belongs to this restaurant, (b) order.status === 'DELIVERED',
// (c) no existing prorouting_issue_id (idempotent — same order can't
// raise twice). The raiseDeliveryIssue service handles the upstream
// duplicate-issue path and returns a soft `{ success:false, message }`
// rather than throwing.
router.post('/orders/:orderId/report-fake-delivery', async (req, res) => {
  try {
    const o = await col('orders').findOne({ _id: req.params.orderId });
    if (!o) return res.status(404).json({ error: 'Order not found' });
    const branch = await col('branches').findOne({ _id: o.branch_id });
    if (!branch || branch.restaurant_id !== req.restaurantId) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (o.status !== 'DELIVERED') {
      return res.status(400).json({ error: 'Order must be delivered before reporting' });
    }
    if (o.prorouting_issue_id) {
      return res.status(409).json({ error: 'Issue already reported', issue_id: o.prorouting_issue_id });
    }

    const prorouting = require('../services/prorouting');
    const result = await prorouting.raiseDeliveryIssue(req.params.orderId);
    if (!result.success) {
      if (result.message === 'already_exists') {
        return res.status(409).json({ error: 'Issue already reported on 3PL side' });
      }
      if (result.message === 'delivery_not_dispatched') {
        return res.status(400).json({ error: 'Delivery was never dispatched via 3PL' });
      }
      return res.status(502).json({ error: 'Upstream service unavailable' });
    }

    log({
      actorType: 'restaurant', actorId: req.restaurantId, actorName: 'restaurant',
      action: 'prorouting.fake_delivery_reported', category: 'delivery',
      description: `Reported fake delivery for order #${o.order_number}`,
      resourceType: 'order', resourceId: String(o._id), severity: 'warning',
      metadata: { issue_id: result.issue_id },
    });

    res.json({ success: true, issue_id: result.issue_id });
  } catch (e) { res.status(500).json({ success: false, message: 'Internal server error' }); }
});

// POST /api/restaurant/orders/:orderId/cancel-delivery — cancel active delivery
router.post('/orders/:orderId/cancel-delivery', async (req, res) => {
  try {
    const o = await col('orders').findOne({ _id: req.params.orderId });
    if (!o) return res.status(404).json({ error: 'Order not found' });
    const branch = await col('branches').findOne({ _id: o.branch_id });
    if (!branch || branch.restaurant_id !== req.restaurantId) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const deliveryService = require('../services/delivery');
    const result = await deliveryService.cancelDelivery(req.params.orderId);
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/delivery/stats — delivery analytics
router.get('/delivery/stats', async (req, res) => {
  try {
    const branches = await col('branches').find({ restaurant_id: req.restaurantId }).project({ _id: 1 }).toArray();
    const branchIds = branches.map(b => String(b._id));

    const orderIds = await col('orders').find({ branch_id: { $in: branchIds } }).project({ _id: 1 }).toArray();
    const ids = orderIds.map(o => o._id);

    const deliveries = await col('deliveries').find({ order_id: { $in: ids } }).toArray();

    const delivered = deliveries.filter(d => d.status === 'delivered');
    const failed = deliveries.filter(d => d.status === 'failed' || d.status === 'cancelled');
    const active = deliveries.filter(d => ['pending', 'assigned', 'picked_up'].includes(d.status));

    // Average delivery time (for completed deliveries)
    let avgDeliveryMin = 0;
    const withTimes = delivered.filter(d => d.delivered_at && d.created_at);
    if (withTimes.length) {
      const totalMin = withTimes.reduce((s, d) => s + (new Date(d.delivered_at) - new Date(d.created_at)) / 60000, 0);
      avgDeliveryMin = Math.round(totalMin / withTimes.length);
    }

    // Average 3PL cost
    const withCost = delivered.filter(d => d.cost_rs > 0);
    const avgCostRs = withCost.length
      ? Math.round(withCost.reduce((s, d) => s + parseFloat(d.cost_rs || 0), 0) / withCost.length * 100) / 100
      : 0;

    const successRate = deliveries.length
      ? Math.round(delivered.length / deliveries.length * 100)
      : 0;

    res.json({
      total: deliveries.length,
      delivered: delivered.length,
      failed: failed.length,
      active: active.length,
      avg_delivery_min: avgDeliveryMin,
      avg_cost_rs: avgCostRs,
      success_rate_pct: successRate,
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ═══════════════════════════════════════════════════════════════
// ANALYTICS
// ═══════════════════════════════════════════════════════════════

router.get('/analytics', requirePermission('view_analytics'), async (req, res) => {
  try {
    const days = parseInt(req.query.days || 7);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const branches = await col('branches').find({ restaurant_id: req.restaurantId }).project({ _id: 1 }).toArray();
    const branchIds = branches.map(b => String(b._id));

    const orders = await col('orders').find({
      branch_id: { $in: branchIds },
      created_at: { $gte: since },
    }).toArray();

    const total_orders = orders.length;
    const delivered    = orders.filter(o => o.status === 'DELIVERED');
    const cancelled    = orders.filter(o => o.status === 'CANCELLED').length;
    const total_revenue = delivered.reduce((s, o) => s + (parseFloat(o.total_rs) || 0), 0);
    const avg_order_value = delivered.length ? total_revenue / delivered.length : 0;

    // Daily breakdown
    const dailyMap = {};
    for (const o of orders) {
      const date = new Date(o.created_at).toISOString().slice(0, 10);
      if (!dailyMap[date]) dailyMap[date] = { date, orders: 0, revenue: 0 };
      dailyMap[date].orders++;
      if (o.status === 'DELIVERED') dailyMap[date].revenue += parseFloat(o.total_rs) || 0;
    }
    const daily = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      summary: { total_orders, delivered: delivered.length, cancelled, total_revenue, avg_order_value },
      daily,
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// Helper: get branch IDs and date range
async function _analyticsContext(req) {
  const branches = await col('branches').find({ restaurant_id: req.restaurantId }).project({ _id: 1, name: 1 }).toArray();
  const branchIds = branches.map(b => String(b._id));
  const branchMap = Object.fromEntries(branches.map(b => [String(b._id), b.name]));
  const periodDays = { '7d': 7, '30d': 30, '90d': 90, 'all': 3650 }[req.query.period] || 30;
  const since = new Date(Date.now() - periodDays * 86400000);
  const prevSince = new Date(since.getTime() - periodDays * 86400000);
  return { branchIds, branchMap, since, prevSince, periodDays };
}

// GET /api/restaurant/analytics/overview
router.get('/analytics/overview', requirePermission('view_analytics'), async (req, res) => {
  try {
    const { branchIds, since, prevSince, periodDays } = await _analyticsContext(req);
    const baseMatch = { branch_id: { $in: branchIds } };

    const [current, previous, statusCounts, uniqueCust] = await Promise.all([
      col('orders').aggregate([
        { $match: { ...baseMatch, created_at: { $gte: since }, status: { $in: CONFIRMED_ORDER_STATES } } },
        { $group: { _id: null, total: { $sum: 1 }, revenue: { $sum: { $toDouble: '$total_rs' } } } },
      ]).toArray(),
      col('orders').aggregate([
        { $match: { ...baseMatch, created_at: { $gte: prevSince, $lt: since }, status: { $in: CONFIRMED_ORDER_STATES } } },
        { $group: { _id: null, total: { $sum: 1 }, revenue: { $sum: { $toDouble: '$total_rs' } } } },
      ]).toArray(),
      col('orders').aggregate([
        { $match: { ...baseMatch, created_at: { $gte: since } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]).toArray(),
      col('orders').aggregate([
        { $match: { ...baseMatch, created_at: { $gte: since }, status: { $in: CONFIRMED_ORDER_STATES } } },
        { $group: { _id: '$customer_id' } },
        { $count: 'total' },
      ]).toArray(),
    ]);

    const cur = current[0] || { total: 0, revenue: 0 };
    const prev = previous[0] || { total: 0, revenue: 0 };
    const pctChange = (c, p) => p > 0 ? +((c - p) / p * 100).toFixed(1) : (c > 0 ? 100 : 0);
    const statusMap = Object.fromEntries(statusCounts.map(s => [s._id, s.count]));

    res.json({
      total_orders: cur.total,
      total_revenue_rs: +cur.revenue.toFixed(2),
      avg_order_value_rs: cur.total ? +(cur.revenue / cur.total).toFixed(2) : 0,
      total_customers: uniqueCust[0]?.total || 0,
      changes: {
        orders_pct: pctChange(cur.total, prev.total),
        revenue_pct: pctChange(cur.revenue, prev.revenue),
      },
      orders_by_status: statusMap,
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/analytics/revenue
router.get('/analytics/revenue', requirePermission('view_analytics'), async (req, res) => {
  try {
    const { branchIds, since } = await _analyticsContext(req);
    const gran = req.query.granularity || 'day';

    let dateExpr;
    if (gran === 'week') dateExpr = { $dateToString: { format: '%G-W%V', date: '$created_at' } };
    else if (gran === 'month') dateExpr = { $dateToString: { format: '%Y-%m', date: '$created_at' } };
    else dateExpr = { $dateToString: { format: '%Y-%m-%d', date: '$created_at' } };

    const data = await col('orders').aggregate([
      { $match: { branch_id: { $in: branchIds }, created_at: { $gte: since }, status: { $in: CONFIRMED_ORDER_STATES } } },
      { $group: { _id: dateExpr, revenue_rs: { $sum: { $toDouble: '$total_rs' } }, order_count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: '$_id', revenue_rs: { $round: ['$revenue_rs', 2] }, order_count: 1 } },
    ]).toArray();

    res.json(data);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/analytics/top-items
router.get('/analytics/top-items', requirePermission('view_analytics'), async (req, res) => {
  try {
    const { branchIds, since } = await _analyticsContext(req);
    const limit = Math.min(20, parseInt(req.query.limit) || 10);

    // Get order IDs in range
    const orderIds = await col('orders').distinct('_id', {
      branch_id: { $in: branchIds }, created_at: { $gte: since }, status: { $in: CONFIRMED_ORDER_STATES },
    });

    const data = await col('order_items').aggregate([
      { $match: { order_id: { $in: orderIds.map(String) } } },
      { $group: {
        _id: '$item_name',
        total_quantity: { $sum: { $ifNull: ['$quantity', { $ifNull: ['$qty', 1] }] } },
        total_revenue_rs: { $sum: { $toDouble: { $ifNull: ['$line_total_rs', 0] } } },
        order_count: { $sum: 1 },
      }},
      { $sort: { total_quantity: -1 } },
      { $limit: limit },
      { $project: { _id: 0, item_name: '$_id', total_quantity: 1, total_revenue_rs: { $round: ['$total_revenue_rs', 2] }, order_count: 1 } },
    ]).toArray();

    res.json(data);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/analytics/peak-hours
router.get('/analytics/peak-hours', requirePermission('view_analytics'), async (req, res) => {
  try {
    const { branchIds, since } = await _analyticsContext(req);

    const [hourly, daily] = await Promise.all([
      col('orders').aggregate([
        { $match: { branch_id: { $in: branchIds }, created_at: { $gte: since }, status: { $in: CONFIRMED_ORDER_STATES } } },
        { $group: { _id: { $hour: '$created_at' }, order_count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
        { $project: { _id: 0, hour: '$_id', order_count: 1 } },
      ]).toArray(),
      col('orders').aggregate([
        { $match: { branch_id: { $in: branchIds }, created_at: { $gte: since }, status: { $in: CONFIRMED_ORDER_STATES } } },
        { $group: { _id: { $dayOfWeek: '$created_at' }, order_count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]).toArray(),
    ]);

    // Fill missing hours (0-23)
    const hourMap = Object.fromEntries(hourly.map(h => [h.hour, h.order_count]));
    const hours = Array.from({ length: 24 }, (_, i) => ({ hour: i, order_count: hourMap[i] || 0 }));

    // Map day numbers to names (MongoDB: 1=Sun..7=Sat)
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const days = daily.map(d => ({ day: dayNames[(d._id - 1) % 7], order_count: d.order_count }));

    res.json({ hours, days });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/analytics/customers
router.get('/analytics/customers', requirePermission('view_analytics'), async (req, res) => {
  try {
    const { branchIds, since } = await _analyticsContext(req);
    const baseMatch = { branch_id: { $in: branchIds }, created_at: { $gte: since }, status: { $in: CONFIRMED_ORDER_STATES } };

    const [custOrders, topCust] = await Promise.all([
      col('orders').aggregate([
        { $match: baseMatch },
        { $group: { _id: '$customer_id', order_count: { $sum: 1 }, total_spent: { $sum: { $toDouble: '$total_rs' } } } },
      ]).toArray(),
      col('orders').aggregate([
        { $match: baseMatch },
        { $group: { _id: '$customer_id', order_count: { $sum: 1 }, total_spent: { $sum: { $toDouble: '$total_rs' } } } },
        { $sort: { total_spent: -1 } },
        { $limit: 10 },
      ]).toArray(),
    ]);

    const total = custOrders.length;
    const returning = custOrders.filter(c => c.order_count >= 2).length;
    const newCust = total - returning;
    const avgOrders = total > 0 ? +(custOrders.reduce((s, c) => s + c.order_count, 0) / total).toFixed(1) : 0;

    // Enrich top customers with names
    const topIds = topCust.map(c => c._id).filter(Boolean);
    const customers = topIds.length ? await col('customers').find({ _id: { $in: topIds } }, { projection: { name: 1, wa_phone: 1, bsuid: 1 } }).toArray() : [];
    const custMap = Object.fromEntries(customers.map(c => [String(c._id), c]));

    res.json({
      new_customers: newCust,
      returning_customers: returning,
      repeat_rate_pct: total > 0 ? +(returning / total * 100).toFixed(1) : 0,
      avg_orders_per_customer: avgOrders,
      top_customers: topCust.map(c => ({
        name: custMap[c._id]?.name || 'Unknown',
        wa_phone: maskPhone(custMap[c._id]?.wa_phone),
        order_count: c.order_count,
        total_spent_rs: +c.total_spent.toFixed(2),
      })),
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/analytics/delivery
router.get('/analytics/delivery', requirePermission('view_analytics'), async (req, res) => {
  try {
    const { branchIds, branchMap, since } = await _analyticsContext(req);

    const [deliveryTimes, branchStats] = await Promise.all([
      col('orders').aggregate([
        { $match: { branch_id: { $in: branchIds }, created_at: { $gte: since }, status: 'DELIVERED', confirmed_at: { $exists: true }, delivered_at: { $exists: true } } },
        { $addFields: {
          delivery_min: { $divide: [{ $subtract: ['$delivered_at', '$confirmed_at'] }, 60000] },
          prep_min: { $cond: [{ $and: ['$preparing_at', '$confirmed_at'] }, { $divide: [{ $subtract: ['$preparing_at', '$confirmed_at'] }, 60000] }, null] },
        }},
        { $group: { _id: null, avg_delivery: { $avg: '$delivery_min' }, avg_prep: { $avg: '$prep_min' }, count: { $sum: 1 } } },
      ]).toArray(),
      col('orders').aggregate([
        { $match: { branch_id: { $in: branchIds }, created_at: { $gte: since }, status: { $in: CONFIRMED_ORDER_STATES } } },
        { $group: {
          _id: '$branch_id',
          order_count: { $sum: 1 },
          revenue_rs: { $sum: { $toDouble: '$total_rs' } },
        }},
        { $sort: { order_count: -1 } },
      ]).toArray(),
    ]);

    const dt = deliveryTimes[0] || {};

    res.json({
      avg_delivery_time_min: dt.avg_delivery ? +dt.avg_delivery.toFixed(1) : null,
      avg_prep_time_min: dt.avg_prep ? +dt.avg_prep.toFixed(1) : null,
      delivered_count: dt.count || 0,
      orders_by_branch: branchStats.map(b => ({
        branch_name: branchMap[b._id] || b._id,
        order_count: b.order_count,
        revenue_rs: +b.revenue_rs.toFixed(2),
      })),
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── LOGISTICS STATS (per-restaurant, mirrors admin logistics analytics) ───
// Reads orders.logistics.* subdocument populated by the Prorouting 3PL
// integration. restaurantId is taken from the JWT (req.restaurantId) — never
// from a query param. branchId is optional; if absent, all branches of the
// restaurant are included (respecting the staff user's branch scope).
const _LGS_IST_TZ = 'Asia/Kolkata';
const _LGS_IST_OFFSET = '+05:30';

function _lgsParseISTBoundary(dateStr, end) {
  if (!dateStr) return null;
  if (String(dateStr).length > 10) return new Date(dateStr);
  const time = end ? 'T23:59:59.999' : 'T00:00:00.000';
  return new Date(dateStr + time + _LGS_IST_OFFSET);
}

function _lgsTodayISTBoundary(end) {
  const dateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: _LGS_IST_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return _lgsParseISTBoundary(dateStr, end);
}

const _lgsR1 = (v) => v == null ? null : Math.round(v * 10) / 10;
const _lgsR2 = (v) => v == null ? null : Math.round(v * 100) / 100;

// GET /api/restaurant/logistics/stats
router.get('/logistics/stats', requirePermission('view_analytics'), async (req, res) => {
  try {
    const from = _lgsParseISTBoundary(req.query.from, false) || _lgsTodayISTBoundary(false);
    const to   = _lgsParseISTBoundary(req.query.to,   true)  || _lgsTodayISTBoundary(true);

    // Resolve branch scope: owner (no userBranchIds) → all branches of the
    // restaurant; scoped staff → only their assigned branches. If branchId
    // is provided it must fall within that allowed set, else 403.
    const allBranches = await col('branches')
      .find({ restaurant_id: req.restaurantId })
      .project({ _id: 1 }).toArray();
    const restaurantBranchIds = allBranches.map(b => String(b._id));

    const userScope = Array.isArray(req.userBranchIds) && req.userBranchIds.length
      ? req.userBranchIds.map(String)
      : restaurantBranchIds;

    let scopedBranchIds = restaurantBranchIds.filter(id => userScope.includes(id));

    const { branchId } = req.query;
    if (branchId) {
      if (!scopedBranchIds.includes(String(branchId))) {
        return res.status(403).json({ error: 'Branch not in scope' });
      }
      scopedBranchIds = [String(branchId)];
    }

    const baseMatch = {
      restaurant_id: req.restaurantId,
      branch_id: { $in: scopedBranchIds },
      created_at: { $gte: from, $lte: to },
    };

    const hasField = (path) => ({
      $sum: { $cond: [{ $ne: [{ $ifNull: [`$${path}`, null] }, null] }, 1, 0] },
    });
    const sumField = (path) => ({ $sum: { $ifNull: [`$${path}`, 0] } });

    const [agg] = await col('orders').aggregate([
      { $match: baseMatch },
      { $facet: {
          statuses: [
            { $group: { _id: '$status', count: { $sum: 1 } } },
          ],
          delivered: [
            { $match: { status: 'DELIVERED' } },
            { $group: {
                _id: null,
                avgDistanceKm:           { $avg: '$logistics.distanceKm' },
                avgLspFee:               { $avg: '$logistics.lspFee' },
                avgTotalFee:             { $avg: '$logistics.totalFee' },
                sumTotalFeeWithGst:      sumField('logistics.totalFeeWithGst'),
                cntTotalFeeWithGst:      hasField('logistics.totalFeeWithGst'),
                sumCod:                  sumField('logistics.codCollected'),
                cntCod:                  hasField('logistics.codCollected'),
                avgAgentAssignMinutes:   { $avg: '$logistics.agentAssignMinutes' },
                avgReachPickupMinutes:   { $avg: '$logistics.reachPickupMinutes' },
                avgReachDeliveryMinutes: { $avg: '$logistics.reachDeliveryMinutes' },
                avgDeliveryTotalMinutes: { $avg: '$logistics.deliveryTotalMinutes' },
                avgPickupWaitMinutes:    { $avg: '$logistics.pickupWaitMinutes' },
            }},
          ],
          pendingIssues: [
            { $match: {
                'logistics.hasIssue': true,
                $or: [
                  { 'logistics.issueResolved': { $ne: true } },
                  { 'logistics.issueResolved': { $exists: false } },
                ],
            }},
            { $count: 'count' },
          ],
          liabilityAccepted: [
            { $match: { 'logistics.liabilityAccepted': true } },
            { $count: 'count' },
          ],
      }},
    ]).toArray();

    const statusMap = {};
    for (const s of (agg.statuses || [])) statusMap[s._id] = s.count;
    const deliveredOrders = statusMap['DELIVERED'] || 0;

    let cancelledByClient = 0, cancelledBySystem = 0;
    const cancelledTotal = statusMap['CANCELLED'] || 0;
    if (cancelledTotal > 0) {
      const cancelledOrders = await col('orders').find(
        { ...baseMatch, status: 'CANCELLED' },
        { projection: { _id: 1 } },
      ).toArray();
      const ids = cancelledOrders.map(o => o._id);
      if (ids.length) {
        const actorAgg = await col('order_state_log').aggregate([
          { $match: { order_id: { $in: ids }, to_state: 'CANCELLED' } },
          { $sort: { timestamp: -1 } },
          { $group: { _id: '$order_id', actor_type: { $first: '$actor_type' } } },
          { $group: { _id: '$actor_type', count: { $sum: 1 } } },
        ]).toArray();
        for (const r of actorAgg) {
          if (r._id === 'customer') cancelledByClient += r.count;
          else cancelledBySystem += r.count;
        }
        const loggedTotal = actorAgg.reduce((s, r) => s + r.count, 0);
        if (loggedTotal < ids.length) cancelledBySystem += (ids.length - loggedTotal);
      }
    }

    const d = (agg.delivered && agg.delivered[0]) || {};

    const summary = {
      deliveredOrders,
      cancelledByClient,
      cancelledBySystem,
      avgDistanceKm:           _lgsR1(d.avgDistanceKm           ?? null),
      avgLspFee:               _lgsR2(d.avgLspFee               ?? null),
      avgTotalFee:             _lgsR2(d.avgTotalFee             ?? null),
      totalFeeWithGst:         d.cntTotalFeeWithGst > 0 ? _lgsR2(d.sumTotalFeeWithGst) : null,
      codCollected:            d.cntCod             > 0 ? _lgsR2(d.sumCod)             : null,
      avgAgentAssignMinutes:   _lgsR1(d.avgAgentAssignMinutes   ?? null),
      avgReachPickupMinutes:   _lgsR1(d.avgReachPickupMinutes   ?? null),
      avgReachDeliveryMinutes: _lgsR1(d.avgReachDeliveryMinutes ?? null),
      avgDeliveryTotalMinutes: _lgsR1(d.avgDeliveryTotalMinutes ?? null),
      avgPickupWaitMinutes:    _lgsR1(d.avgPickupWaitMinutes    ?? null),
      pendingIssues:           (agg.pendingIssues[0]?.count)     || 0,
      liabilityAccepted:       (agg.liabilityAccepted[0]?.count) || 0,
    };

    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      filters: { branchId: branchId || null },
      summary,
    });
  } catch (e) {
    logger.error({ err: e }, 'logistics stats failed');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ─── DROP-OFF ANALYTICS & RECOVERY ─────────────────────────
const dropoff = require('../services/dropoff');

// GET /api/restaurant/analytics/dropoffs — funnel + abandoned session list
router.get('/analytics/dropoffs', requirePermission('view_analytics'), async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from) : undefined;
    const to = req.query.to ? new Date(req.query.to) : undefined;
    const result = await dropoff.getDropoffs(req.restaurantId, {
      from, to, stage: req.query.stage, limit: parseInt(req.query.limit) || 50, includeDetails: true,
    });
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/analytics/dropoffs/:conversationId — single abandoned session detail
router.get('/analytics/dropoffs/:conversationId', requirePermission('view_analytics'), async (req, res) => {
  try {
    const detail = await dropoff.getDropoffDetails(req.params.conversationId);
    if (!detail) return res.status(404).json({ error: 'Conversation not found' });
    res.json(detail);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/dropoffs/:conversationId/recover — send recovery message
router.post('/dropoffs/:conversationId/recover', requirePermission('manage_orders'), async (req, res) => {
  try {
    const conv = await col('conversations').findOne({ _id: req.params.conversationId });
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    // Verify belongs to this restaurant
    const waAcc = await col('whatsapp_accounts').findOne({ _id: conv.wa_account_id, restaurant_id: req.restaurantId });
    if (!waAcc) return res.status(403).json({ error: 'Conversation does not belong to this restaurant' });

    // Must be an abandoned state (not completed)
    const completedStates = ['AWAITING_FEEDBACK', 'SELECTING_ISSUE_CATEGORY', 'SELECTING_ISSUE_ORDER', 'AWAITING_ISSUE_DESCRIPTION'];
    if (completedStates.includes(conv.state)) return res.status(400).json({ error: 'Conversation is not abandoned — customer completed an order' });

    const customer = await col('customers').findOne({ _id: conv.customer_id });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const session = conv.session_data || {};
    const wa = require('../services/whatsapp');
    const { resolveRecipient } = require('../services/customerIdentity');
    const to = resolveRecipient(customer);
    const pid = waAcc.phone_number_id;
    const token = waAcc.access_token;

    // Determine message type based on stage
    const isCart = ['ORDER_REVIEW', 'AWAITING_COUPON', 'AWAITING_POINTS_REDEEM'].includes(conv.state);
    const isPayment = ['AWAITING_PHONE_FOR_PAYMENT', 'AWAITING_PAYMENT'].includes(conv.state);
    let messageType = 'general_recovery';
    let messageText = '';

    const name = customer.name || 'there';

    if (isCart && session.cart?.length) {
      messageType = 'cart_recovery';
      const items = session.cart.map(i => `${i.name} x${i.qty}`).join(', ');
      messageText = `Hey ${name}! You left some items in your cart: ${items}.\n\nReady to complete your order? Just reply *ORDER* to pick up where you left off!`;
    } else if (isPayment) {
      messageType = 'payment_recovery';
      messageText = `Hey ${name}! Your payment didn't go through. Would you like to try again?\n\nReply *PAY* to get a fresh payment link, or *MENU* to start over.`;
    } else {
      messageText = `Hey ${name}! We noticed you were browsing our menu. Ready to order?\n\nJust reply *MENU* to see our full selection!`;
    }

    // Check WhatsApp 24-hour window
    const hoursSinceLastMsg = (Date.now() - new Date(conv.last_msg_at)) / 3600000;

    // Send response immediately, fire-and-forget the actual message
    res.json({ success: true, message_type: messageType, hours_since_activity: Math.round(hoursSinceLastMsg * 10) / 10 });

    // Fire-and-forget: send the message
    (async () => {
      try {
        if (hoursSinceLastMsg < 24) {
          await wa.sendText(pid, token, to, messageText);
        } else {
          // Outside 24h window — try template, fall back to text (may fail)
          try {
            await wa.sendTemplate(pid, token, to, {
              name: 'cart_reminder', language: 'en',
              components: [{ type: 'body', parameters: [{ type: 'text', text: name }] }],
            });
          } catch {
            // Template may not exist — try regular text (Meta may block it)
            await wa.sendText(pid, token, to, messageText).catch(() => {});
          }
        }
        // Log the recovery attempt
        await col('recovery_attempts').insertOne({
          _id: newId(), conversation_id: req.params.conversationId,
          customer_id: conv.customer_id, restaurant_id: req.restaurantId,
          message_type: messageType, sent_at: new Date(), status: 'sent',
        });
      } catch (err) {
        logger.error({ err, conversationId: req.params.conversationId }, 'Recovery message send failed');
        await col('recovery_attempts').insertOne({
          _id: newId(), conversation_id: req.params.conversationId,
          customer_id: conv.customer_id, restaurant_id: req.restaurantId,
          message_type: messageType, sent_at: new Date(), status: 'failed', error: err.message,
        }).catch(() => {});
      }
    })();
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/analytics/recovery-stats — recovery message effectiveness
router.get('/analytics/recovery-stats', requirePermission('view_analytics'), async (req, res) => {
  try {
    const stats = await dropoff.getRecoveryStats(req.restaurantId, req.query.from, req.query.to);
    res.json(stats);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/analytics/cart-recovery — abandoned cart recovery analytics
router.get('/analytics/cart-recovery', requirePermission('view_analytics'), async (req, res) => {
  try {
    const cartRecovery = require('../services/cart-recovery');
    const periodDays = req.query.period === '30d' ? 30 : 7;
    const stats = await cartRecovery.getRecoveryAnalytics(req.restaurantId, periodDays);
    res.json(stats);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/dropoffs/recoverable — high-intent abandoned carts for recovery
router.get('/dropoffs/recoverable', requirePermission('manage_orders'), async (req, res) => {
  try {
    const list = await dropoff.getRecoverableDropoffs(req.restaurantId);
    res.json(list);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// Flow management moved to admin routes — see admin.js

// ═══════════════════════════════════════════════════════════════
// CONVERSATION ANALYTICS
// ═══════════════════════════════════════════════════════════════

// GET /api/restaurant/analytics/conversations — WABA conversation stats from Meta + active conversations from DB
router.get('/analytics/conversations', requirePermission('view_analytics'), async (req, res) => {
  try {
    const wa_acc = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId, is_active: true });
    if (!wa_acc?.waba_id) return res.json({ error: 'No WABA connected', conversations: null, active: [] });

    const now = new Date();
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const twentyFourHoursAgo = new Date(now - 24 * 60 * 60 * 1000);

    // Fetch Meta conversation analytics + active convos from DB in parallel
    const [metaResult, activeConvos, totalConvos] = await Promise.allSettled([
      getCached(`restaurant:${req.restaurantId}:conversation-analytics`, async () => {
        const token = metaConfig.getMessagingToken();
        const startTs = Math.floor(thirtyDaysAgo.getTime() / 1000);
        const endTs = Math.floor(now.getTime() / 1000);
        try {
          const { data } = await axios.get(`${metaConfig.graphUrl}/${wa_acc.waba_id}`, {
            params: {
              fields: `conversation_analytics.start(${startTs}).end(${endTs}).granularity(DAILY).phone_numbers([]).conversation_categories([])`,
              access_token: token,
            },
            timeout: 10000,
          });
          return data?.conversation_analytics || null;
        } catch (e) {
          logger.error({ err: e }, 'Meta conversation analytics fetch failed');
          return null;
        }
      }, 120),
      col('conversations').find({
        restaurant_id: req.restaurantId,
        last_message_at: { $gte: twentyFourHoursAgo },
      }).sort({ last_message_at: -1 }).limit(50).toArray(),
      col('conversations').countDocuments({
        restaurant_id: req.restaurantId,
        last_message_at: { $gte: thirtyDaysAgo },
      }),
    ]);

    const metaData = metaResult.status === 'fulfilled' ? metaResult.value : null;
    const activeList = activeConvos.status === 'fulfilled' ? activeConvos.value : [];
    const totalCount = totalConvos.status === 'fulfilled' ? totalConvos.value : 0;

    // Parse Meta analytics into category breakdown
    let categories = { service: 0, utility: 0, marketing: 0, authentication: 0 };
    let dailyData = [];
    let totalMetaConvos = 0;

    if (metaData?.data) {
      for (const dp of metaData.data) {
        if (dp.data_points) {
          for (const pt of dp.data_points) {
            const date = new Date(pt.start * 1000).toISOString().split('T')[0];
            const conv = pt.conversation || 0;
            totalMetaConvos += conv;
            dailyData.push({ date, count: conv, category: dp.conversation_category });
            if (categories[dp.conversation_category] !== undefined) {
              categories[dp.conversation_category] += conv;
            }
          }
        }
      }
    }

    // Aggregate daily totals
    const dailyMap = {};
    for (const d of dailyData) {
      if (!dailyMap[d.date]) dailyMap[d.date] = { date: d.date, total: 0, service: 0, utility: 0, marketing: 0, authentication: 0 };
      dailyMap[d.date].total += d.count;
      if (dailyMap[d.date][d.category] !== undefined) dailyMap[d.date][d.category] += d.count;
    }

    // Mask phone numbers for active conversations
    const maskedActive = activeList.map(c => ({
      phone: maskPhone(c.customer_phone),
      last_message_at: c.last_message_at,
      direction: c.last_message_direction,
      category: c.category || 'service',
    }));

    res.json({
      meta_analytics: metaData ? {
        total_conversations: totalMetaConvos,
        categories,
        daily: Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date)),
        free_tier_remaining: Math.max(0, 1000 - categories.service),
      } : null,
      active_conversations: {
        count: activeList.length,
        list: maskedActive,
      },
      total_conversations_30d: totalCount,
    });
  } catch (e) {
    req.log.error({ err: e }, 'Analytics conversations failed');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ═══════════════════════════════════════════════════════════════
// SETTLEMENTS
// ═══════════════════════════════════════════════════════════════

router.get('/settlements', requirePermission('view_payments'), async (req, res) => {
  try {
    const docs = await col('settlements')
      .find({ restaurant_id: req.restaurantId })
      .sort({ period_start: -1 })
      .limit(12)
      .toArray();
    res.json(mapIds(docs));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ═══════════════════════════════════════════════════════════════
// PHASE 5 — LEDGER DASHBOARD + ON-DEMAND SETTLEMENT HISTORY
// ═══════════════════════════════════════════════════════════════

// GET /api/restaurant/ledger/summary
router.get('/ledger/summary', requirePermission('view_payments'), async (req, res) => {
  try {
    const svc = require('../services/ledgerDashboard.service');
    const data = await svc.getSummary(req.restaurantId);
    res.json(data);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/ledger/transactions?from&to&type&ref_type&page&limit
router.get('/ledger/transactions', requirePermission('view_payments'), async (req, res) => {
  try {
    const svc = require('../services/ledgerDashboard.service');
    const data = await svc.getTransactions(req.restaurantId, {
      from:    req.query.from,
      to:      req.query.to,
      type:    req.query.type,
      refType: req.query.ref_type,
      page:    req.query.page,
      limit:   req.query.limit,
    });
    res.json(data);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/ledger/settlements — Phase 5 on-demand history.
// (Legacy weekly rows remain at GET /settlements above.)
router.get('/ledger/settlements', requirePermission('view_payments'), async (req, res) => {
  try {
    const svc = require('../services/ledgerDashboard.service');
    const data = await svc.getSettlements(req.restaurantId, {
      page:  req.query.page,
      limit: req.query.limit,
    });
    res.json(data);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.get('/settlements/:id/download', requirePermission('view_payments'), async (req, res) => {
  try {
    const settlement = await col('settlements').findOne({ _id: req.params.id });
    if (!settlement) return res.status(404).json({ error: 'Settlement not found' });
    if (settlement.restaurant_id !== req.restaurantId) {
      return res.status(403).json({ error: 'Not your settlement' });
    }
    const { generateSettlementExcel } = require('../services/settlement-export');
    const { buffer, filename } = await generateSettlementExcel(req.params.id);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(buffer));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/settlements/:id/meta-breakdown
// Phase 5.2 — per-settlement list of WhatsApp marketing messages that
// were deducted from this payout.
//
// Security posture:
//   • restaurant_id is taken ONLY from req.restaurantId (JWT-derived in
//     auth.js). Never honored from query / body / headers.
//   • Phone numbers are ALWAYS masked. We call enrichRowsMasked, the
//     restaurant-specific shaping helper that has no permission flag
//     and runs every phone through maskPhone unconditionally.
//   • :id is validated as a non-empty simple string to avoid malformed
//     lookups (Mongo _ids in this codebase are UUID strings).
//   • Unknown or cross-tenant ids → 404 (never 403; not-found is less
//     information-leaky than access-denied).
router.get('/settlements/:id/meta-breakdown', requirePermission('view_payments'), async (req, res) => {
  try {
    if (!req.restaurantId) return res.status(401).json({ error: 'Unauthorized' });
    const id = String(req.params.id || '').trim();
    if (!id || id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(id)) {
      return res.status(400).json({ error: 'Invalid settlement id' });
    }

    const settlement = await col('settlements').findOne(
      { _id: id, restaurant_id: req.restaurantId },
      { projection: { _id: 1, meta_message_ids: 1, meta_cost_total_paise: 1, meta_message_count: 1 } },
    );
    if (!settlement) return res.status(404).json({ error: 'Settlement not found' });

    const ids = Array.isArray(settlement.meta_message_ids) ? settlement.meta_message_ids : [];
    let rows = [];
    if (ids.length) {
      rows = await col('marketing_messages')
        .find({ _id: { $in: ids } })
        // Explicit projection — never pulls phone_hash / raw_meta_payload
        // into memory so there's no way they can leak into the response.
        .project({
          _id: 1, restaurant_id: 1, waba_id: 1, customer_id: 1, customer_name: 1,
          message_id: 1, message_type: 1, category: 1, cost: 1, currency: 1,
          status: 1, sent_at: 1, delivered_at: 1,
        })
        .sort({ sent_at: -1 })
        .toArray();
    }
    const { enrichRowsMasked } = require('./marketingMessages');
    const items = await enrichRowsMasked(rows);

    res.json({
      settlement_id: settlement._id,
      meta_cost_total_paise: settlement.meta_cost_total_paise || 0,
      meta_message_count:    settlement.meta_message_count || 0,
      items,
    });
  } catch (e) {
    req.log?.error({ err: e, settlementId: req.params.id }, 'restaurant.meta_breakdown failed');
    res.status(500).json({ error: 'Failed to load settlement breakdown' });
  }
});

// ═══════════════════════════════════════════════════════════════
// PAYOUT ACCOUNT
// ═══════════════════════════════════════════════════════════════

const paymentSvc = require('../services/payment');

router.post('/payout-account', requirePermission('manage_settings'), async (req, res) => {
  try {
    const result = await paymentSvc.registerPayoutAccount(req.restaurantId);
    if (result.alreadyRegistered) {
      return res.json({ success: true, message: 'Already registered', fundAccountId: result.fundAccountId });
    }
    res.json({ success: true, fundAccountId: result.fundAccountId });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── WALLET ──────────────────────────────────────────────────

router.get('/wallet', async (req, res) => {
  try {
    const walletSvc = require('../services/wallet');
    let wallet = await walletSvc.getWallet(req.restaurantId);
    if (!wallet) wallet = await walletSvc.ensureWallet(req.restaurantId);
    const [monthlySpend, breakdown, restaurant] = await Promise.all([
      walletSvc.getMonthlySpend(req.restaurantId),
      walletSvc.getBreakdownTotals(req.restaurantId),
      col('restaurants').findOne(
        { _id: req.restaurantId },
        { projection: { campaigns_enabled: 1 } },
      ),
    ]);
    res.json({
      ...wallet,
      monthly_spend_rs: monthlySpend,
      campaigns_enabled: !!restaurant?.campaigns_enabled,
      ...breakdown,
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.get('/wallet/transactions', async (req, res) => {
  try {
    const walletSvc = require('../services/wallet');
    const { limit, offset, type } = req.query;
    const transactions = await walletSvc.getTransactions(req.restaurantId, {
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0,
      type: type || null,
    });
    res.json(transactions);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// Payment rate limit: 3 attempts per 120s per restaurant.
// Protects against rapid-retry loops on a failing card / webhook flakiness
// racking up Razorpay orders. Keyed on restaurantId — a multi-operator
// account shares the bucket, which is the desired behaviour (prevents one
// staff member from burning through limits on everyone else's behalf).
router.post('/wallet/topup',
  requirePermission('manage_settings'),
  rateLimitFn(req => `payment:${req.restaurantId}`, 3, 120, { message: 'Too many payment attempts, please try again shortly.' }),
  async (req, res) => {
  try {
    const { amount_rs } = req.body;
    if (!amount_rs || amount_rs < 100 || amount_rs > 10000) {
      return res.status(400).json({ error: 'Amount must be between ₹100 and ₹10,000' });
    }

    const walletSvc = require('../services/wallet');
    await walletSvc.ensureWallet(req.restaurantId);

    const paymentSvc = require('../services/payment');
    const rzp = paymentSvc._getRzp ? paymentSvc._getRzp() : require('razorpay')({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
    const rzpOrder = await rzp.orders.create({
      amount: Math.round(amount_rs * 100),
      currency: 'INR',
      receipt: `wallet_topup_${req.restaurantId}_${Date.now()}`,
      notes: { type: 'wallet_topup', restaurant_id: req.restaurantId, amount_rs },
    });

    await col('payments').insertOne({
      _id: newId(),
      order_id: null,
      rp_order_id: rzpOrder.id,
      amount_rs,
      status: 'created',
      payment_type: 'wallet_topup',
      restaurant_id: req.restaurantId,
      created_at: new Date(),
    });

    res.json({ razorpay_order_id: rzpOrder.id, amount_rs, key_id: process.env.RAZORPAY_KEY_ID });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// Webhook callback for wallet top-up handled in razorpay.js via receipt prefix check

// ─── COUPONS ──────────────────────────────────────────────────

router.get('/coupons', async (req, res) => {
  try {
    const docs = await col('coupons').find({ restaurant_id: req.restaurantId }).sort({ created_at: -1 }).toArray();
    res.json(mapIds(docs));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.post('/coupons', requirePermission('manage_coupons'), express.json(), async (req, res) => {
  try {
    const { code, description, discountType, discountValue, minOrderRs, maxDiscountRs,
            usageLimit, perUserLimit, validFrom, validUntil,
            firstOrderOnly, branchIds, campaignId } = req.body;
    if (!code || !discountType || discountValue == null)
      return res.status(400).json({ error: 'code, discountType and discountValue are required' });
    if (!['percent', 'flat', 'free_delivery'].includes(discountType))
      return res.status(400).json({ error: 'discountType must be percent, flat, or free_delivery' });
    if (discountType === 'percent' && parseFloat(discountValue) > 100)
      return res.status(400).json({ error: 'Percent discount cannot exceed 100' });

    const couponCode = code.trim().toUpperCase();
    const existing = await col('coupons').findOne({ restaurant_id: req.restaurantId, code: couponCode });
    if (existing) return res.status(409).json({ error: 'Coupon code already exists' });

    const now = new Date();
    const coupon = {
      _id: newId(),
      restaurant_id: req.restaurantId,
      code: couponCode,
      description: description || null,
      discount_type: discountType,
      discount_value: parseFloat(discountValue) || 0,
      min_order_rs: minOrderRs || 0,
      max_discount_rs: maxDiscountRs || null,
      usage_limit: usageLimit || null,
      per_user_limit: perUserLimit || null,
      usage_count: 0,
      valid_from: validFrom ? new Date(validFrom) : null,
      valid_until: validUntil ? new Date(validUntil) : null,
      first_order_only: !!firstOrderOnly,
      branch_ids: branchIds?.length ? branchIds : null,
      campaign_id: campaignId || null,
      is_active: true,
      created_at: now,
      updated_at: now,
    };
    await col('coupons').insertOne(coupon);
    res.json(mapId(coupon));
  } catch (e) {
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

router.patch('/coupons/:id', requirePermission('manage_coupons'), express.json(), async (req, res) => {
  try {
    const { isActive, description, validUntil, usageLimit, maxDiscountRs } = req.body;
    const $set = { updated_at: new Date() };
    if (isActive      !== undefined) $set.is_active      = isActive;
    if (description   !== undefined) $set.description    = description;
    if (validUntil    !== undefined) $set.valid_until    = validUntil ? new Date(validUntil) : null;
    if (usageLimit    !== undefined) $set.usage_limit    = usageLimit;
    if (maxDiscountRs !== undefined) $set.max_discount_rs= maxDiscountRs;

    const updated = await col('coupons').findOneAndUpdate(
      { _id: req.params.id, restaurant_id: req.restaurantId },
      { $set },
      { returnDocument: 'after' }
    );
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(mapId(updated));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.delete('/coupons/:id', requirePermission('manage_coupons'), async (req, res) => {
  try {
    const result = await col('coupons').deleteOne({ _id: req.params.id, restaurant_id: req.restaurantId });
    if (!result.deletedCount) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── OFFERS: RESOLVE BEST + LIST ELIGIBLE ────────────────────
// POST /api/restaurant/offers/resolve
// Called by checkout to auto-apply the best offer.
// Body: { subtotalRs, deliveryFeeRs, branchId, customerId }
router.post('/offers/resolve', express.json(), async (req, res) => {
  try {
    const couponSvc = require('../services/coupon');
    const { subtotalRs, deliveryFeeRs, branchId, customerId } = req.body;
    if (!subtotalRs) return res.status(400).json({ error: 'subtotalRs is required' });

    const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
    const restaurantConfig = {
      delivery_fee_customer_pct: restaurant?.delivery_fee_customer_pct ?? 100,
      menu_gst_mode: restaurant?.menu_gst_mode ?? 'included',
      menu_gst_pct: restaurant?.menu_gst_pct ?? 5,
      packaging_charge_rs: restaurant?.packaging_charge_rs ?? 0,
      packaging_gst_pct: restaurant?.packaging_gst_pct ?? 18,
    };

    const isFirstOrder = customerId
      ? await couponSvc.isCustomerFirstOrder(customerId, req.restaurantId)
      : true;

    const result = await couponSvc.resolveBestOffer(
      req.restaurantId,
      parseFloat(subtotalRs),
      parseFloat(deliveryFeeRs) || 0,
      restaurantConfig,
      { customerId, branchId, isFirstOrder }
    );

    res.json({
      bestOffer: result.bestCoupon ? {
        code: result.bestCoupon.coupon.code,
        couponId: result.bestCoupon.coupon.id,
        discountRs: result.bestCoupon.discountRs,
        freeDelivery: result.bestCoupon.freeDelivery,
        label: result.bestCoupon.label,
        finalTotal: result.bestCoupon.finalTotal,
      } : null,
      allOffers: result.allEligible.map(e => ({
        code: e.coupon.code,
        couponId: e.coupon.id,
        description: e.coupon.description,
        discountRs: e.discountRs,
        freeDelivery: e.freeDelivery,
        label: e.label,
        finalTotal: e.finalTotal,
        minOrderRs: e.coupon.min_order_rs || 0,
      })),
      isFirstOrder,
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/offers/apply
// Validate and apply a specific coupon code to the current cart.
// Body: { code, subtotalRs, branchId, customerId }
router.post('/offers/apply', express.json(), async (req, res) => {
  try {
    const couponSvc = require('../services/coupon');
    const { code, subtotalRs, branchId, customerId } = req.body;
    if (!code || !subtotalRs) return res.status(400).json({ error: 'code and subtotalRs required' });

    const isFirstOrder = customerId
      ? await couponSvc.isCustomerFirstOrder(customerId, req.restaurantId)
      : true;

    const result = await couponSvc.validateCoupon(
      code, req.restaurantId, parseFloat(subtotalRs),
      { customerId, branchId, isFirstOrder }
    );

    if (!result.valid) return res.status(400).json({ valid: false, message: result.message, reason: result.reason });
    res.json({
      valid: true,
      code: result.coupon.code,
      couponId: result.coupon.id,
      discountRs: result.discountRs,
      freeDelivery: result.freeDelivery || false,
      message: result.message,
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── REFERRALS RECEIVED ───────────────────────────────────────
router.get('/referrals', async (req, res) => {
  try {
    const now = new Date();
    // Auto-expire stale referrals
    await col('referrals').updateMany(
      { restaurant_id: req.restaurantId, status: 'active', expires_at: { $lt: now } },
      { $set: { status: 'expired', updated_at: now } }
    );

    const list = await col('referrals')
      .find({ restaurant_id: req.restaurantId })
      .sort({ created_at: -1 })
      .toArray();

    const mappedList = mapIds(list);
    const total    = list.length;
    const converted= list.filter(r => r.status === 'converted').length;
    const total_orders          = list.reduce((s, r) => s + (r.orders_count || 0), 0);
    const total_order_value_rs  = list.reduce((s, r) => s + (parseFloat(r.total_order_value_rs) || 0), 0);
    const total_referral_fee_rs = list.reduce((s, r) => s + (parseFloat(r.referral_fee_rs) || 0), 0);

    res.json({
      referrals: mappedList,
      summary: { total, converted, total_orders, total_order_value_rs, total_referral_fee_rs },
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── GBREF LINKS — RESTAURANT-FACING ─────────────────────────
// GET /api/restaurant/referrals/links — the restaurant's own active GBREF
// links so the dashboard can render share buttons. Mirrors the admin
// /referrals/links projection but scoped to req.restaurantId.
// requireApproved is intentionally NOT applied: unapproved restaurants
// still see an empty list and the "request a link" CTA, matching the
// /referrals listing UX.
router.get('/referrals/links', async (req, res) => {
  try {
    const links = await col('referral_links')
      .find({ restaurant_id: req.restaurantId, status: 'active' })
      .sort({ created_at: -1 })
      .toArray();
    res.json({ links: mapIds(links) });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/referrals/links/request — restaurant asks admin to
// generate a GBREF link. Does NOT mint a link directly — the admin owns
// the namespace + WA-number gating. Inserts a row into
// referral_link_requests; the admin dashboard surfaces these for action.
// One pending row per restaurant is enough — duplicate POSTs collapse via
// updateOne $setOnInsert so a restaurant clicking "request" twice doesn't
// flood ops.
router.post('/referrals/links/request', async (req, res) => {
  try {
    const campaign_name = (req.body?.campaign_name || '').toString().trim().slice(0, 80) || null;
    const now = new Date();
    const result = await col('referral_link_requests').findOneAndUpdate(
      { restaurant_id: req.restaurantId, status: 'pending' },
      {
        $setOnInsert: {
          _id: newId(),
          restaurant_id: req.restaurantId,
          campaign_name,
          status: 'pending',
          created_at: now,
        },
        $set: { updated_at: now },
      },
      { upsert: true, returnDocument: 'after' }
    );
    const isNew = !!result?.lastErrorObject?.upserted;
    res.json({
      success: true,
      already_pending: !isNew,
      message: isNew
        ? 'Request submitted. Admin will generate your link shortly.'
        : 'You already have a pending request — admin will reach out shortly.',
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── SYNC LOGS ───────────────────────────────────────────────
router.get('/sync-logs', async (req, res) => {
  try {
    const logs = await col('activity_logs').find({
      restaurant_id: req.restaurantId,
      action: { $regex: /^(catalog\.|menu\.|branch\.)/ },
    }).sort({ created_at: -1 }).limit(50).toArray();
    res.json(logs.map(l => ({
      id: l._id,
      action: l.action,
      description: l.description,
      severity: l.severity,
      created_at: l.created_at,
      metadata: l.metadata || null,
    })));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── WHATSAPP TEMPLATES ───────────────────────────────────────

// GET /api/restaurant/whatsapp/templates
router.get('/whatsapp/templates', requireApproved, async (req, res) => {
  try {
    const wa_acc = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId, is_active: true });
    if (!wa_acc) return res.status(404).json({ error: 'No active WhatsApp account found. Connect your account first.' });

    const GRAPH = metaConfig.graphUrl;
    const sysToken = metaConfig.systemUserToken || wa_acc.access_token;
    const { data } = await axios.get(`${GRAPH}/${wa_acc.waba_id}/message_templates`, {
      params: { fields: 'name,status,category,language,components', limit: 200 },
      headers: { Authorization: `Bearer ${sysToken}` },
      timeout: 10000,
    });
    res.json(data.data || []);
  } catch (e) {
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// GET /api/restaurant/whatsapp/template-defaults — global admin-level defaults
router.get('/whatsapp/template-defaults', async (req, res) => {
  try {
    const defaults = await col('template_mappings').find({ is_active: true }).toArray();
    res.json(mapIds(defaults));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/whatsapp/template-mappings
router.get('/whatsapp/template-mappings', async (req, res) => {
  try {
    const docs = await col('whatsapp_template_mappings').find({ restaurant_id: req.restaurantId }).toArray();
    res.json(mapIds(docs));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// PUT /api/restaurant/whatsapp/template-mappings
//
// Safety net: refuses to bind a MARKETING template to a UTILITY event (or
// vice versa). Meta enforces the same rule on send (charges marketing,
// silently downgrades, or rejects) — catching it here prevents the
// merchant from finding out at runtime via failed customer messages.
// Skipped mappings are returned in `skipped` so the caller can surface
// them; valid mappings still save.
router.put('/whatsapp/template-mappings', requireApproved, express.json(), async (req, res) => {
  try {
    const mappings = req.body;
    if (!Array.isArray(mappings)) return res.status(400).json({ error: 'Array of mappings required' });

    // Event → required category map. Sourced from
    // config/predefined-templates.js: every UTILITY-categorised template
    // there has a `suggested_event` here as UTILITY; every MARKETING one
    // here. Events outside both sets get no category check (caller-defined
    // / future events are allowed through).
    const UTILITY_EVENTS = new Set([
      'ORDER_CONFIRMED', 'ORDER_PREPARING', 'ORDER_PACKED',
      'ORDER_DISPATCHED', 'ORDER_DELIVERED', 'ORDER_CANCELLED',
      'PAYMENT_RECEIVED', 'PAYMENT_REMINDER', 'DELIVERY_OTP',
      'FEEDBACK_REQUEST', 'REFUND_PROCESSED',
    ]);
    const MARKETING_EVENTS = new Set([
      'CART_RECOVERY', 'WELCOME', 'REORDER_SUGGESTION',
    ]);

    const skipped = [];

    for (const m of mappings) {
      const { eventName, templateName, templateLanguage, variableMap } = m;
      if (!eventName || !templateName) continue;

      // Look up the template's category + status from the local cache
      // (populated by services/template.syncTemplates + the daily cron).
      // Missing row → safe-fail: allow the mapping through (template may
      // have just been created and not yet synced).
      const templateRow = await col('templates').findOne(
        { name: templateName },
        { projection: { category: 1, status: 1 } }
      );

      if (templateRow) {
        const eventUpper = eventName.toUpperCase();
        const isUtilityEvent = UTILITY_EVENTS.has(eventUpper);
        const isMarketingEvent = MARKETING_EVENTS.has(eventUpper);
        const templateCategory = templateRow.category?.toUpperCase();

        if (isUtilityEvent && templateCategory === 'MARKETING') {
          logger.warn({
            eventName, templateName, templateCategory,
            restaurantId: req.restaurantId,
          }, 'template-mapping: MARKETING template mapped to UTILITY event — skipped');
          skipped.push({ eventName, templateName, reason: 'category_mismatch_marketing_to_utility' });
          continue;
        }
        if (isMarketingEvent && templateCategory === 'UTILITY') {
          logger.warn({
            eventName, templateName, templateCategory,
            restaurantId: req.restaurantId,
          }, 'template-mapping: UTILITY template mapped to MARKETING event — skipped');
          skipped.push({ eventName, templateName, reason: 'category_mismatch_utility_to_marketing' });
          continue;
        }

        // Non-APPROVED templates are allowed (restaurant may be
        // pre-configuring before approval lands), but logged so ops can
        // spot a paused-template misconfiguration in the audit trail.
        if (templateRow.status && templateRow.status !== 'APPROVED') {
          logger.warn({
            eventName, templateName, status: templateRow.status,
            restaurantId: req.restaurantId,
          }, 'template-mapping: template is not APPROVED — mapping saved but sends may fail');
        }
      }

      const now = new Date();
      await col('whatsapp_template_mappings').updateOne(
        { restaurant_id: req.restaurantId, event_name: eventName },
        {
          $set: {
            template_name:     templateName,
            template_language: templateLanguage || 'en',
            variable_map:      variableMap || {},
            updated_at:        now,
          },
          $setOnInsert: { _id: newId(), restaurant_id: req.restaurantId, event_name: eventName, created_at: now },
        },
        { upsert: true }
      );
    }
    res.json({ ok: true, skipped });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// DELETE /api/restaurant/whatsapp/template-mappings/:eventName
router.delete('/whatsapp/template-mappings/:eventName', requireApproved, async (req, res) => {
  try {
    await col('whatsapp_template_mappings').deleteOne({
      restaurant_id: req.restaurantId,
      event_name: req.params.eventName.toUpperCase(),
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── SHARED: SEND STATUS NOTIFICATION (template → text fallback) ──────────
async function notifyOrderStatus(restaurantId, pid, _token, waPhone, status, orderData) {
  const token = metaConfig.systemUserToken || _token;

  // Try new centralized template system first (orderNotify.js → template_mappings)
  if (orderData._orderId) {
    try {
      const sent = await orderNotify.sendOrderTemplateMessage(orderData._orderId, status);
      if (sent) return; // Template sent successfully
    } catch (e) {
      logger.error({ err: e, status, orderId: orderData._orderId }, 'orderNotify failed, trying legacy');
    }
  }

  // Legacy: per-restaurant template mapping (whatsapp_template_mappings collection)
  const mapping = await col('whatsapp_template_mappings').findOne({
    restaurant_id: restaurantId,
    event_name: status,
  });

  if (mapping) {
    const { template_name, template_language, variable_map: varMap } = mapping;
    try {
      const slots = Object.keys(varMap || {}).sort((a, b) => parseInt(a) - parseInt(b));
      const components = slots.length
        ? [{ type: 'body', parameters: slots.map(s => ({ type: 'text', text: String(orderData[varMap[s]] ?? '') })) }]
        : [];
      await wa.sendTemplate(pid, token, waPhone, { name: template_name, language: template_language || 'en', components });
      return;
    } catch (e) {
      logger.error({ err: e, status, templateName: template_name }, 'WA template send failed, falling back to text');
    }
  }

  // Final fallback: plain text status update
  await wa.sendStatusUpdate(pid, token, waPhone, status, {
    orderNumber: orderData.order_number,
    eta:         orderData.eta,
    trackingUrl: orderData.tracking_url,
  });
}

// POST /api/restaurant/catalog/register-feed
// Registers a live feed URL with Meta's Catalog API (schedule: daily at 2AM)
router.post('/catalog/register-feed', async (req, res) => {
  try {
    const crypto = require('crypto');
    const GRAPH = metaConfig.graphUrl;

    const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
    const wa_acc = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId, is_active: true });

    const catToken = metaConfig.systemUserToken || wa_acc?.access_token;
    if (!catToken) return res.status(400).json({ error: 'No Meta token configured. Please contact support.' });

    // Generate or reuse feed token
    let feedToken = restaurant.catalog_feed_token;
    if (!feedToken) {
      feedToken = crypto.randomBytes(24).toString('hex');
      await col('restaurants').updateOne({ _id: req.restaurantId }, { $set: { catalog_feed_token: feedToken } });
    }

    const baseUrl = process.env.BASE_URL;
    if (!baseUrl) throw new Error('BASE_URL is not set; cannot build feed URL');
    const feedUrl = `${baseUrl}/feed/${feedToken}`;

    // Find a branch with a catalog
    const branch = await col('branches').findOne({ restaurant_id: req.restaurantId, catalog_id: { $exists: true, $ne: null } });
    if (!branch?.catalog_id) return res.status(400).json({ error: 'No catalog found. Add menu items first so a catalog is created, then register the feed.' });

    const feedName = `${restaurant.business_name || 'GullyBite'} Live Menu Feed`;

    // Check if feed already registered
    if (restaurant.meta_feed_id) {
      // Update the existing feed's URL/schedule
      try {
        await axios.post(
          `${GRAPH}/${restaurant.meta_feed_id}`,
          { schedule: { interval: 'DAILY', url: feedUrl, hour: 2 } },
          { headers: { Authorization: `Bearer ${catToken}` }, timeout: 15000 }
        );
        await col('restaurants').updateOne({ _id: req.restaurantId }, { $set: { catalog_feed_url: feedUrl, catalog_feed_updated_at: new Date() } });
        return res.json({ success: true, feedId: restaurant.meta_feed_id, feedUrl, updated: true });
      } catch (e) {
        // Feed no longer exists on Meta — fall through to create new
        req.log.warn({ err: e }, 'Existing feed update failed, creating new');
        await col('restaurants').updateOne({ _id: req.restaurantId }, { $unset: { meta_feed_id: '' } });
      }
    }

    // Register new feed with Meta
    const feedRes = await axios.post(
      `${GRAPH}/${branch.catalog_id}/product_feeds`,
      {
        name: feedName,
        schedule: { interval: 'DAILY', url: feedUrl, hour: 2 },
      },
      { headers: { Authorization: `Bearer ${catToken}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    const feedId = feedRes.data.id;
    await col('restaurants').updateOne(
      { _id: req.restaurantId },
      { $set: { meta_feed_id: feedId, catalog_feed_token: feedToken, catalog_feed_url: feedUrl, catalog_feed_registered_at: new Date() } }
    );

    res.json({ success: true, feedId, feedUrl });
  } catch (e) {
    req.log.error({ err: e, metaResponse: e.response?.data }, 'Feed register failed');
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// GET /api/restaurant/catalog/feed-status
router.get('/catalog/feed-status', async (req, res) => {
  try {
    const GRAPH = metaConfig.graphUrl;
    const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
    const wa_acc = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId, is_active: true });

    if (!restaurant.meta_feed_id) return res.json({ registered: false, feedUrl: restaurant.catalog_feed_url || null });

    // Fetch latest upload status from Meta
    let lastUpload = null;
    try {
      const r = await axios.get(`${GRAPH}/${restaurant.meta_feed_id}/uploads`, {
        params: { access_token: metaConfig.systemUserToken || wa_acc?.access_token, limit: 1, fields: 'end_time,num_detected_items,num_invalid_items,url' },
        timeout: 10000,
      });
      lastUpload = r.data?.data?.[0] || null;
    } catch (e) { /* non-fatal */ }

    res.json({
      registered: true,
      feedId: restaurant.meta_feed_id,
      feedUrl: restaurant.catalog_feed_url,
      registeredAt: restaurant.catalog_feed_registered_at,
      lastUpload,
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// DELETE /api/restaurant/catalog/feed/:feedId — delete a scheduled feed from Meta
router.delete('/catalog/feed/:feedId', requireApproved, async (req, res) => {
  try {
    await catalog.deleteFeed(req.params.feedId);
    await col('restaurants').updateOne({ _id: req.restaurantId }, { $unset: { meta_feed_id: '' } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/catalog/feeds — list all feeds on the restaurant's catalog
router.get('/catalog/feeds', async (req, res) => {
  try {
    const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
    const catalogId = restaurant?.meta_catalog_id;
    if (!catalogId) {
      const branch = await col('branches').findOne({ restaurant_id: req.restaurantId, catalog_id: { $exists: true, $ne: null } });
      if (!branch?.catalog_id) return res.json({ feeds: [] });
      return res.json({ feeds: await catalog.listFeeds(branch.catalog_id) });
    }
    res.json({ feeds: await catalog.listFeeds(catalogId) });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/catalog/diagnostics — item-level errors from Meta
router.get('/catalog/diagnostics', async (req, res) => {
  try {
    const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
    const catalogId = restaurant?.meta_catalog_id;
    if (!catalogId) return res.status(404).json({ error: 'No catalog connected' });

    const diagnostics = await catalog.getCatalogDiagnostics(catalogId);

    // Optional: fetch problematic items for detail
    let problematic_items = [];
    try {
      const token = metaConfig.getCatalogToken();
      const resp = await axios.get(`${metaConfig.graphUrl}/${catalogId}/products`, {
        params: { access_token: token, fields: 'id,retailer_id,name,review_status,errors', filter: JSON.stringify({ review_status: { neq: 'approved' } }), limit: 20 },
        timeout: 15000,
      });
      problematic_items = resp.data?.data || [];
    } catch (_) { /* non-fatal enrichment */ }

    res.json({ diagnostics, problematic_items });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ═══════════════════════════════════════════════════════════════
// CUSTOMERS — Order history per customer
// ═══════════════════════════════════════════════════════════════

// GET /api/restaurant/customers — canonical restaurant-scoped customer list.
// Defined further below; routed through customerView.service with masking.
// (The previous unmasked handler lived here and took precedence; it has
//  been removed to close the phone-leak bug.)

// GET /api/restaurant/customers/:customerId/orders — order history for one customer
router.get('/customers/:customerId/orders', async (req, res) => {
  try {
    const branches  = await col('branches').find({ restaurant_id: req.restaurantId }, { projection: { _id: 1, name: 1 } }).toArray();
    const branchIds = branches.map(b => String(b._id));
    const branchMap = Object.fromEntries(branches.map(b => [String(b._id), b.name]));

    const orders = await col('orders')
      .find({ customer_id: req.params.customerId, branch_id: { $in: branchIds } })
      .sort({ created_at: -1 })
      .limit(20)
      .toArray();

    const enriched = await Promise.all(orders.map(async o => {
      const items = await col('order_items').find({ order_id: String(o._id) }).toArray();
      return {
        id          : String(o._id),
        order_number: o.order_number,
        status      : o.status,
        total_rs    : o.total_rs,
        branch_name : branchMap[o.branch_id] || '',
        created_at  : o.created_at,
        items       : items.map(i => ({ name: i.item_name || i.name || 'Item', qty: i.quantity || i.qty || 1, price: i.unit_price_rs })),
      };
    }));

    res.json(enriched);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── GET /api/restaurant/ratings ──────────────────────────────
router.get('/ratings', requireApproved, async (req, res) => {
  try {
    const branches = await col('branches').find({ restaurant_id: req.restaurantId }, { projection: { _id: 1, name: 1 } }).toArray();
    const branchIds = branches.map(b => String(b._id));
    const branchMap = Object.fromEntries(branches.map(b => [String(b._id), b.name]));

    const query = { branch_id: { $in: branchIds } };
    if (req.query.branch_id && branchIds.includes(req.query.branch_id)) {
      query.branch_id = req.query.branch_id;
    }

    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const skip  = (page - 1) * limit;

    const [ratings, total] = await Promise.all([
      col('order_ratings').find(query).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
      col('order_ratings').countDocuments(query),
    ]);

    // Enrich with customer name and order number
    const customerIds = [...new Set(ratings.map(r => r.customer_id).filter(Boolean))];
    const orderIds    = [...new Set(ratings.map(r => r.order_id).filter(Boolean))];

    const [customers, orders] = await Promise.all([
      customerIds.length ? col('customers').find({ _id: { $in: customerIds } }, { projection: { name: 1, wa_phone: 1, bsuid: 1 } }).toArray() : [],
      orderIds.length    ? col('orders').find({ _id: { $in: orderIds } }, { projection: { order_number: 1 } }).toArray() : [],
    ]);

    const custMap  = Object.fromEntries(customers.map(c => [String(c._id), c]));
    const orderMap = Object.fromEntries(orders.map(o => [String(o._id), o.order_number]));

    const enriched = ratings.map(r => ({
      id:             String(r._id),
      order_number:   orderMap[r.order_id] || r.order_id,
      customer_name:  custMap[r.customer_id]?.name || 'Unknown',
      branch_name:    branchMap[r.branch_id] || '',
      taste_rating:   r.taste_rating || r.food_rating || 0,
      packing_rating: r.packing_rating || 0,
      delivery_rating:r.delivery_rating || 0,
      value_rating:   r.value_rating || 0,
      food_rating:    r.food_rating || 0,
      overall_rating: r.overall_rating || r.food_rating || 0,
      comment:        r.comment,
      feedback_tags:  r.feedback_tags || [],
      source:         r.source || 'unknown',
      created_at:     r.created_at,
    }));

    res.json({ ratings: enriched, total, page, pages: Math.ceil(total / limit) });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── GET /api/restaurant/ratings/summary ─────────────────────
router.get('/ratings/summary', requireApproved, async (req, res) => {
  try {
    const branches = await col('branches').find({ restaurant_id: req.restaurantId }, { projection: { _id: 1 } }).toArray();
    const branchIds = branches.map(b => String(b._id));

    const query = { branch_id: { $in: branchIds } };
    if (req.query.branch_id && branchIds.includes(req.query.branch_id)) {
      query.branch_id = req.query.branch_id;
    }

    const allRatings = await col('order_ratings').find(query).toArray();
    const total = allRatings.length;

    if (!total) {
      return res.json({ avg_taste: 0, avg_packing: 0, avg_delivery: 0, avg_value: 0, avg_overall: 0, avg_food: 0, total: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, recent_comments: [] });
    }

    const avg = (field) => +(allRatings.reduce((s, r) => s + (r[field] || 0), 0) / total).toFixed(1);
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of allRatings) {
      const star = Math.max(1, Math.min(5, Math.round(r.overall_rating || r.food_rating || 3)));
      distribution[star] = (distribution[star] || 0) + 1;
    }

    // Recent comments (non-null, last 5)
    const recent_comments = allRatings
      .filter(r => r.comment)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 5)
      .map(r => ({ comment: r.comment, overall_rating: r.overall_rating || r.food_rating || 0, created_at: r.created_at }));

    res.json({
      avg_taste:    avg('taste_rating'),
      avg_packing:  avg('packing_rating'),
      avg_delivery: avg('delivery_rating'),
      avg_value:    avg('value_rating'),
      avg_overall:  avg('overall_rating'),
      avg_food:     avg('food_rating'), // backward compat
      total,
      distribution,
      recent_comments,
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// Loyalty routes previously lived here as /loyalty/stats + /loyalty/customers.
// They moved to routes/loyalty.js under /api/restaurant/loyalty-program/*
// as part of the unified loyalty engine (see services/loyaltyEngine.js).

// ═══════════════════════════════════════════════════════════════
// TEAM / USER MANAGEMENT
// ═══════════════════════════════════════════════════════════════

// GET /api/restaurant/users
router.get('/users', requirePermission('manage_users'), async (req, res) => {
  try {
    const users = await col('restaurant_users')
      .find({ restaurant_id: req.restaurantId })
      .sort({ role: 1, name: 1 })
      .toArray();
    res.json(users.map(u => ({
      id: String(u._id),
      name: u.name,
      phone: u.phone,
      email: u.email,
      role: u.role,
      branch_ids: u.branch_ids || [],
      permissions: u.permissions,
      is_active: u.is_active,
      last_login_at: u.last_login_at,
      created_at: u.created_at,
    })));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/users
router.post('/users', requirePermission('manage_users'), express.json(), async (req, res) => {
  try {
    const { name, phone, pin, role, branchIds } = req.body;
    if (!name || !phone || !pin || !role)
      return res.status(400).json({ error: 'Name, phone, PIN and role are required' });
    if (!['manager', 'kitchen', 'delivery'].includes(role))
      return res.status(400).json({ error: 'Role must be manager, kitchen or delivery' });
    if (pin.length < 4 || pin.length > 6)
      return res.status(400).json({ error: 'PIN must be 4-6 digits' });

    const existing = await col('restaurant_users').findOne({ restaurant_id: req.restaurantId, phone });
    if (existing) return res.status(409).json({ error: 'A user with this phone already exists' });

    const pinHash = await bcrypt.hash(pin, 10);
    const permissions = { ...(ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.delivery) };

    const id = newId();
    await col('restaurant_users').insertOne({
      _id: id,
      restaurant_id: req.restaurantId,
      name: name.trim(),
      phone: phone.trim(),
      email: req.body.email || null,
      pin_hash: pinHash,
      pin_attempts: 0,
      pin_locked_until: null,
      token_version: 0,
      role,
      branch_ids: branchIds || [],
      permissions,
      is_active: true,
      last_login_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    try {
      require('../events').emit('user.created', {
        userId: id,
        userType: 'staff',
        restaurantId: req.restaurantId,
        name: name.trim(),
        phone: phone.trim(),
        role,
      });
    } catch (_) { /* never block user creation on bus load */ }

    res.json({ id, name, phone, role, permissions });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// PUT /api/restaurant/users/:id
router.put('/users/:id', requirePermission('manage_users'), express.json(), async (req, res) => {
  try {
    const { name, role, branchIds, permissions, isActive } = req.body;
    const user = await col('restaurant_users').findOne({ _id: req.params.id, restaurant_id: req.restaurantId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'owner') return res.status(403).json({ error: 'Cannot edit owner account' });

    const $set = { updated_at: new Date() };
    if (name !== undefined)        $set.name        = name.trim();
    if (role !== undefined && ['manager', 'kitchen', 'delivery'].includes(role)) $set.role = role;
    if (branchIds !== undefined)   $set.branch_ids  = branchIds;
    if (permissions !== undefined)  $set.permissions = permissions;
    if (isActive !== undefined)    $set.is_active   = isActive;

    // If role changed and no custom permissions, apply defaults
    if (role && !permissions) {
      $set.permissions = { ...(ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.delivery) };
    }

    // [TENANT] Defence in depth: re-pin the restaurant_id on the update too,
    // even though the early findOne above already gated this. If a future
    // refactor removes that early check, this filter still prevents
    // cross-tenant role escalation.
    await col('restaurant_users').updateOne(
      { _id: req.params.id, restaurant_id: req.restaurantId },
      { $set }
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// DELETE /api/restaurant/users/:id (soft-delete)
router.delete('/users/:id', requirePermission('manage_users'), async (req, res) => {
  try {
    const user = await col('restaurant_users').findOne({ _id: req.params.id, restaurant_id: req.restaurantId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'owner') return res.status(403).json({ error: 'Cannot delete owner account' });
    if (req.userId && req.params.id === req.userId) return res.status(400).json({ error: 'Cannot delete yourself' });

    await col('restaurant_users').updateOne(
      { _id: req.params.id },
      { $set: { is_active: false, updated_at: new Date() }, $inc: { token_version: 1 } }
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// PUT /api/restaurant/users/:id/reset-pin
router.put('/users/:id/reset-pin', requirePermission('manage_users'), express.json(), async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin || pin.length < 4 || pin.length > 6)
      return res.status(400).json({ error: 'PIN must be 4-6 digits' });

    const user = await col('restaurant_users').findOne({ _id: req.params.id, restaurant_id: req.restaurantId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const pinHash = await bcrypt.hash(pin, 10);
    await col('restaurant_users').updateOne(
      { _id: req.params.id },
      { $set: { pin_hash: pinHash, pin_attempts: 0, pin_locked_until: null, updated_at: new Date() }, $inc: { token_version: 1 } }
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/me — current user info
router.get('/me', async (req, res) => {
  try {
    if (req.userId) {
      const user = await col('restaurant_users').findOne({ _id: req.userId });
      if (user) return res.json({ id: String(user._id), name: user.name, role: user.role, permissions: user.permissions, branchIds: user.branch_ids });
    }
    // Fallback for owner without restaurant_users entry
    const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
    res.json({ id: null, name: restaurant?.owner_name || 'Owner', role: 'owner', permissions: ROLE_PERMISSIONS.owner, branchIds: [] });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ═══════════════════════════════════════════════════════════════
// CAMPAIGNS (MPM Marketing)
// ═══════════════════════════════════════════════════════════════

const campaignSvc = require('../services/campaigns');

router.get('/campaigns', async (req, res) => {
  try {
    const docs = await campaignSvc.getCampaigns(req.restaurantId);
    res.json(mapIds(docs));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/customers?sort=orders|last_order|spent&limit&skip
// Restaurant-scoped identity view. Phone always masked (dashboard ops
// role, not an admin PII-access context).
router.get('/customers', requirePermission('view_analytics'), async (req, res) => {
  try {
    const svc = require('../services/customerView.service');
    const data = await svc.listCustomers({
      restaurantId: req.restaurantId,
      sort:  req.query.sort,
      limit: req.query.limit,
      skip:  req.query.skip,
    });
    res.json(data);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/campaigns/analytics?from&to
// Real-time ROI table keyed by campaign. Cost comes from marketing_messages;
// revenue comes from orders.attributed_campaign_id. Scoped to this tenant.
router.get('/campaigns/analytics', requirePermission('view_analytics'), async (req, res) => {
  try {
    const roi = require('../services/campaignROI.service');
    const rows = await roi.getAnalytics({
      restaurantId: req.restaurantId,
      from: req.query.from,
      to:   req.query.to,
    });
    res.json({ items: rows, total: rows.length });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// Daily-usage gauge for the campaigns tab (CRIT-2B-10).
router.get('/campaigns/daily-usage', requirePermission('manage_settings'), async (req, res) => {
  try {
    const usage = await campaignSvc.getDailyUsage(req.restaurantId);
    res.json(usage);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// Tag discovery for campaign targeting UI (CRIT-2B-08). Returns the tags
// actually present on customer_metrics docs for this restaurant's customers,
// so the dashboard only surfaces tags that have live recipients.
router.get('/customers/tags', requirePermission('manage_settings'), async (req, res) => {
  try {
    const tags = await campaignSvc.getAvailableTags(req.restaurantId);
    res.json({ tags });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

router.post('/campaigns', requirePermission('manage_settings'), async (req, res) => {
  try {
    const campaign = await campaignSvc.createCampaign(req.restaurantId, req.body);
    res.json(mapId(campaign));

    log({ actorType: 'restaurant', actorId: String(req.restaurantId), actorName: req.restaurant?.business_name || 'Restaurant', action: 'campaign.created', category: 'marketing', description: `Campaign created`, restaurantId: String(req.restaurantId), severity: 'info' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/campaigns/:id/send', requirePermission('manage_settings'), async (req, res) => {
  try {
    const result = await campaignSvc.sendCampaign(req.params.id);
    res.json(result);

    log({ actorType: 'restaurant', actorId: String(req.restaurantId), actorName: req.restaurant?.business_name || 'Restaurant', action: 'campaign.sent', category: 'marketing', description: `Campaign sent`, restaurantId: String(req.restaurantId), severity: 'info' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/campaigns/:id', requirePermission('manage_settings'), async (req, res) => {
  try {
    await campaignSvc.deleteCampaign(req.params.id, req.restaurantId);
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// [WhatsApp2026] Campaign pause / resume
router.post('/campaigns/:id/pause', requirePermission('manage_settings'), async (req, res) => {
  try {
    const result = await campaignSvc.pauseCampaign(req.params.id, req.restaurantId);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/campaigns/:id/resume', requirePermission('manage_settings'), async (req, res) => {
  try {
    const result = await campaignSvc.resumeCampaign(req.params.id, req.restaurantId);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── BUSINESS USERNAME (read-only for restaurant) ─────────────
const usernameSvc = require('../services/username');

// GET /api/restaurant/username — get username status
router.get('/username', async (req, res) => {
  try {
    const status = await usernameSvc.getUsernameStatus(req.restaurantId);
    res.json(status || { username_status: 'not_claimed' });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── MESSAGING LIMIT & VERIFICATION ───────────────────────────
// GET /api/restaurant/messaging-status — current tier, quality, verification
router.get('/messaging-status', async (req, res) => {
  try {
    const waAcc = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId, is_active: true });
    const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });

    const result = {
      messaging_limit_tier: waAcc?.messaging_limit_tier || null,
      quality_rating: waAcc?.quality_rating || null,
      business_verification_status: restaurant?.business_verification_status || 'not_started',
    };

    // Try to fetch fresh data from Meta
    const sysToken = metaConfig.systemUserToken;
    if (waAcc?.phone_number_id && sysToken) {
      try {
        const GRAPH = metaConfig.graphUrl;
        const { data } = await require('axios').get(`${GRAPH}/${waAcc.phone_number_id}`, {
          params: { fields: 'messaging_limit_tier,quality_rating', access_token: sysToken },
          timeout: 8000,
        });
        result.messaging_limit_tier = data.messaging_limit_tier || result.messaging_limit_tier;
        result.quality_rating = data.quality_rating || result.quality_rating;
        // Update stored values
        await col('whatsapp_accounts').updateOne({ _id: waAcc._id }, {
          $set: { messaging_limit_tier: data.messaging_limit_tier, quality_rating: data.quality_rating },
        });
      } catch (err) {
        logger.warn({ err }, 'WhatsApp messaging status fetch failed');
      }
    }

    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── [WhatsApp2026] MESSAGE STATS ────────────────────────────
// GET /messaging/stats?from=2026-03-01&to=2026-03-31
router.get('/messaging/stats', requireAuth, requireApproved, async (req, res) => {
  try {
    const msgTracking = require('../services/messageTracking');
    const stats = await msgTracking.getMessageStats(req.restaurantId, {
      from: req.query.from,
      to: req.query.to,
    });
    res.json(stats);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /messaging/costs?from=...&to=...
router.get('/messaging/costs', requireAuth, requireApproved, async (req, res) => {
  try {
    const msgTracking = require('../services/messageTracking');
    const [breakdown, trend] = await Promise.all([
      msgTracking.getCostBreakdown(req.restaurantId, { from: req.query.from, to: req.query.to }),
      msgTracking.getDailyCostTrend(req.restaurantId, parseInt(req.query.days) || 30),
    ]);
    res.json({ breakdown, trend });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── [WhatsApp2026] ACCOUNT QUALITY & HEALTH ────────────────
// GET /messaging/health
router.get('/messaging/health', requireAuth, requireApproved, async (req, res) => {
  try {
    const msgTracking = require('../services/messageTracking');
    const [latest, history] = await Promise.all([
      msgTracking.getLatestHealth(req.restaurantId),
      msgTracking.getHealthHistory(req.restaurantId, 10),
    ]);
    res.json({ latest, history });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /messaging/health/check — trigger a fresh quality check
router.post('/messaging/health/check', requireAuth, requireApproved, async (req, res) => {
  try {
    const msgTracking = require('../services/messageTracking');
    const waAcc = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId, is_active: true });
    if (!waAcc) return res.status(404).json({ error: 'No active WhatsApp account' });

    const token = metaConfig.systemUserToken || waAcc.access_token;
    const result = await msgTracking.checkAccountQuality(waAcc.phone_number_id, token, req.restaurantId);
    if (!result) return res.status(502).json({ error: 'Failed to fetch quality from Meta' });

    res.json(result);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ═══════════════════════════════════════════════════════════════
// MESSAGES INBOX
// ═══════════════════════════════════════════════════════════════

const customerIdentity = require('../services/customerIdentity');
const { logActivity } = require('../services/activityLog');

// GET /api/restaurant/messages — inbox threads (grouped by customer)
router.get('/messages', requireAuth, requireApproved, async (req, res) => {
  try {
    const restId = req.restaurantId;
    const { status, customer_id, search, brand_id, page = 1, limit = 30 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Brand context — same rules as /orders.
    const { resolveBrandContext, setBrandHeaders } = require('../utils/brandContext');
    const brandCtx = await resolveBrandContext(restId, brand_id);
    if (brandCtx.missing) {
      return res.status(400).json({ error: 'brand_id is required for multi-brand businesses', business_type: brandCtx.business_type });
    }
    setBrandHeaders(res, brandCtx);
    const effectiveBrandId = brandCtx.effective_brand_id;

    if (customer_id) {
      // Thread view — all messages with this customer
      const match = { restaurant_id: restId, customer_id };
      if (effectiveBrandId) match.brand_id = effectiveBrandId;
      const msgs = await col('customer_messages').find(match)
        .sort({ created_at: 1 }).toArray();
      // Mark unread as read
      const unreadIds = msgs.filter(m => m.status === 'unread' && m.direction === 'inbound').map(m => m._id);
      if (unreadIds.length) {
        await col('customer_messages').updateMany(
          { _id: { $in: unreadIds } },
          { $set: { status: 'read', read_at: new Date(), read_by: req.userId || null, updated_at: new Date() } }
        );
      }
      return res.json({ messages: msgs.map(m => ({ ...m, id: String(m._id) })) });
    }

    // Threads overview — aggregate latest message per customer
    const match = { restaurant_id: restId };
    if (status && status !== 'all') match.status = status;
    // Brand filter — from query param or default_brand_id on multi tenants.
    if (effectiveBrandId) match.brand_id = effectiveBrandId;
    if (search) match.$or = [
      { text: { $regex: search, $options: 'i' } },
      { customer_name: { $regex: search, $options: 'i' } },
      { customer_phone: { $regex: search, $options: 'i' } },
    ];

    const threads = await col('customer_messages').aggregate([
      { $match: { restaurant_id: restId, ...(effectiveBrandId ? { brand_id: effectiveBrandId } : {}), ...(status && status !== 'all' ? {} : {}) } },
      { $sort: { created_at: -1 } },
      {
        $group: {
          _id: '$customer_id',
          customer_name: { $first: '$customer_name' },
          customer_phone: { $first: '$customer_phone' },
          customer_bsuid: { $first: '$customer_bsuid' },
          last_message: { $first: '$text' },
          last_message_type: { $first: '$message_type' },
          last_direction: { $first: '$direction' },
          last_status: { $first: '$status' },
          last_time: { $first: '$created_at' },
          related_order_id: { $first: '$related_order_id' },
          related_order_number: { $first: '$related_order_number' },
          unread_count: {
            $sum: { $cond: [{ $and: [{ $eq: ['$status', 'unread'] }, { $eq: ['$direction', 'inbound'] }] }, 1, 0] },
          },
          total_messages: { $sum: 1 },
        },
      },
      { $sort: { unread_count: -1, last_time: -1 } },
      { $skip: skip },
      { $limit: parseInt(limit) },
    ]).toArray();

    // Filter by search if specified (on aggregated fields)
    let filtered = threads;
    if (search) {
      const re = new RegExp(search, 'i');
      filtered = threads.filter(t =>
        re.test(t.customer_name || '') || re.test(t.customer_phone || '') || re.test(t.last_message || '')
      );
    }
    if (status && status !== 'all') {
      if (status === 'unread') filtered = filtered.filter(t => t.unread_count > 0);
      else if (status === 'active_orders') filtered = filtered.filter(t => t.related_order_id);
    }

    res.json({ threads: filtered.map(t => ({
      customer_id: t._id,
      customer_name: t.customer_name,
      customer_phone: maskPhone(t.customer_phone),
      customer_bsuid: t.customer_bsuid,
      last_message_text: t.last_message,
      last_message_type: t.last_message_type,
      last_direction: t.last_direction,
      status: t.last_status,
      last_message_at: t.last_time,
      related_order_id: t.related_order_id,
      has_active_order: !!t.related_order_id,
      related_order_number: t.related_order_number,
      unread_count: t.unread_count,
      total_messages: t.total_messages,
    })) });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/messages/thread/:customer_id — full thread
router.get('/messages/thread/:customer_id', requireAuth, requireApproved, async (req, res) => {
  try {
    const restId = req.restaurantId;
    const msgs = await col('customer_messages')
      .find({ restaurant_id: restId, customer_id: req.params.customer_id })
      .sort({ created_at: 1 }).toArray();

    // Mark unread inbound as read
    const unreadIds = msgs.filter(m => m.status === 'unread' && m.direction === 'inbound').map(m => m._id);
    if (unreadIds.length) {
      await col('customer_messages').updateMany(
        { _id: { $in: unreadIds } },
        { $set: { status: 'read', read_at: new Date(), read_by: req.userId || null, updated_at: new Date() } }
      );
    }

    res.json({ messages: msgs.map(m => ({ ...m, id: String(m._id) })) });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/messages/unread-count
router.get('/messages/unread-count', requireAuth, requireApproved, async (req, res) => {
  try {
    const count = await col('customer_messages').countDocuments({
      restaurant_id: req.restaurantId,
      direction: 'inbound',
      status: 'unread',
    });
    res.json({ count });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// PUT /api/restaurant/messages/:id/status — update status
router.put('/messages/:id/status', requireAuth, requireApproved, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['read', 'replied', 'resolved'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const $set = { status, updated_at: new Date() };
    if (status === 'read') { $set.read_at = new Date(); $set.read_by = req.userId || null; }
    if (status === 'resolved') { $set.resolved_at = new Date(); $set.resolved_by = req.userId || null; }
    await col('customer_messages').updateOne(
      { _id: req.params.id, restaurant_id: req.restaurantId },
      { $set }
    );
    if (status === 'read') {
      const unread = await col('customer_messages').countDocuments({ restaurant_id: req.restaurantId, status: 'unread' });
      ws.broadcastToRestaurant(req.restaurantId, 'unread_count', { count: unread });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// PUT /api/restaurant/messages/thread/:customer_id/resolve — resolve entire thread
router.put('/messages/thread/:customer_id/resolve', requireAuth, requireApproved, async (req, res) => {
  try {
    const now = new Date();
    await col('customer_messages').updateMany(
      { restaurant_id: req.restaurantId, customer_id: req.params.customer_id, status: { $ne: 'resolved' } },
      { $set: { status: 'resolved', resolved_at: now, resolved_by: req.userId || null, updated_at: now } }
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/messages/reply — send reply to customer
router.post('/messages/reply', requireAuth, requireApproved, async (req, res) => {
  try {
    const { customer_id, text, reply_to_message_id } = req.body;
    if (!customer_id || !text?.trim()) return res.status(400).json({ error: 'customer_id and text required' });

    const restId = req.restaurantId;

    // Check 24h window
    const lastInbound = await col('customer_messages').findOne(
      { restaurant_id: restId, customer_id, direction: 'inbound' },
      { sort: { created_at: -1 } }
    );
    if (!lastInbound) return res.status(404).json({ error: 'No messages from this customer' });

    const hoursSince = (Date.now() - new Date(lastInbound.created_at).getTime()) / (1000 * 60 * 60);
    if (hoursSince > 24) {
      return res.status(400).json({
        error: 'The 24-hour reply window has expired. Use a template message to reach this customer.',
        window_expired: true,
        hours_since: Math.round(hoursSince),
      });
    }

    // Rate limit: max 10 replies per customer per hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentReplies = await col('customer_messages').countDocuments({
      restaurant_id: restId, customer_id, direction: 'outbound', created_at: { $gte: oneHourAgo },
    });
    if (recentReplies >= 10) {
      return res.status(429).json({ error: 'Reply limit reached. Maximum 10 replies per customer per hour.' });
    }

    // Load WA account
    const waAcc = await col('whatsapp_accounts').findOne({ restaurant_id: restId, is_active: true });
    if (!waAcc) return res.status(400).json({ error: 'No active WhatsApp account' });

    // Resolve customer recipient
    const customer = await col('customers').findOne({ _id: customer_id });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    const to = customerIdentity.resolveRecipient(customer);

    const token = metaConfig.systemUserToken || waAcc.access_token;

    // Build message body with optional contextual reply
    const body = { type: 'text', text: { body: text.trim(), preview_url: false } };
    if (reply_to_message_id) {
      body.context = { message_id: reply_to_message_id };
    }

    const result = await wa.sendMsg(waAcc.phone_number_id, token, to, body);
    const wamId = result?.messages?.[0]?.id || null;

    // Save outbound message
    const msgDoc = {
      _id: newId(),
      restaurant_id: restId,
      branch_id: null,
      customer_id,
      customer_name: customer.name || null,
      customer_phone: customer.wa_phone || null,
      customer_bsuid: customer.bsuid || null,
      direction: 'outbound',
      message_type: 'text',
      text: text.trim(),
      media_id: null,
      media_url: null,
      media_mime_type: null,
      caption: null,
      wa_message_id: wamId,
      conversation_state: null,
      related_order_id: lastInbound.related_order_id || null,
      related_order_number: lastInbound.related_order_number || null,
      status: 'replied',
      read_at: null,
      read_by: null,
      replied_at: new Date(),
      replied_by: req.userId || null,
      resolved_at: null,
      resolved_by: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    await col('customer_messages').insertOne(msgDoc);

    // Mark thread as replied
    await col('customer_messages').updateMany(
      { restaurant_id: restId, customer_id, direction: 'inbound', status: { $in: ['unread', 'read'] } },
      { $set: { status: 'replied', replied_at: new Date(), replied_by: req.userId || null, updated_at: new Date() } }
    );

    logActivity({
      actorType: 'restaurant', actorId: String(req.userId || req.restaurantId), actorName: req.userRole || null,
      action: 'message.replied', category: 'messages',
      description: `Replied to customer ${customer.name || customer.wa_phone}: "${text.substring(0, 60)}"`,
      restaurantId: restId, resourceType: 'customer_message', resourceId: String(msgDoc._id),
      severity: 'info',
    });

    res.json({
      ...msgDoc,
      id: String(msgDoc._id),
      wa_message_id: wamId,
      customer_phone: maskPhone(msgDoc.customer_phone),
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/messages/media/:media_id — resolve Meta media URL
router.get('/messages/media/:media_id', requireAuth, requireApproved, async (req, res) => {
  try {
    const waAcc = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId, is_active: true });
    if (!waAcc) return res.status(400).json({ error: 'No WhatsApp account' });
    const token = metaConfig.systemUserToken || waAcc.access_token;
    const { data } = await axios.get(
      `https://graph.facebook.com/${process.env.WA_API_VERSION}/${req.params.media_id}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
    );
    res.json({ url: data.url, mime_type: data.mime_type });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── ISSUES ──────────────────────────────────────────────────────────

// The shared issueSvc persists raw `customer_phone` for admin/operator
// use, but every restaurant-facing response must collapse it to the
// masked form. `maskIssue` applies that at the API boundary.
const maskIssue = (i) => (i ? { ...i, customer_phone: maskPhone(i.customer_phone) } : i);

// GET /api/restaurant/issues — list issues for this restaurant
router.get('/issues', requireAuth, requireApproved, async (req, res) => {
  try {
    const { status, category, priority, search, page = 1, limit = 30 } = req.query;
    const result = await issueSvc.listIssues(
      { restaurantId: req.restaurantId, status, category, priority, search },
      { page: parseInt(page), limit: parseInt(limit) }
    );
    res.json({ ...result, issues: (result.issues || []).map(maskIssue) });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/issues/stats — issue stats for this restaurant
router.get('/issues/stats', requireAuth, requireApproved, async (req, res) => {
  try {
    const stats = await issueSvc.getIssueStats({ restaurantId: req.restaurantId });
    res.json(stats);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/issues/:id — single issue detail
router.get('/issues/:id', requireAuth, requireApproved, async (req, res) => {
  try {
    const issue = await issueSvc.getIssue(req.params.id);
    if (!issue || issue.restaurant_id !== req.restaurantId) return res.status(404).json({ error: 'Issue not found' });
    res.json(maskIssue(issue));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/issues — create issue from dashboard
router.post('/issues', requireAuth, requireApproved, async (req, res) => {
  try {
    const { customer_id, order_id, category, subcategory, description, media } = req.body;
    if (!customer_id || !category || !description) return res.status(400).json({ error: 'customer_id, category, description required' });

    // Look up customer and order
    const customer = await col('customers').findOne({ _id: customer_id });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    let order = null;
    if (order_id) {
      order = await col('orders').findOne({ _id: order_id });
    }

    const issue = await issueSvc.createIssue({
      customerId: customer._id,
      customerName: customer.name || customer.wa_name,
      customerPhone: customer.wa_phone,
      orderId: order?._id || null,
      orderNumber: order?.order_number || null,
      restaurantId: req.restaurantId,
      branchId: order?.branch_id || null,
      category,
      subcategory,
      description,
      media: media || [],
      source: 'dashboard',
    });

    // Send WhatsApp notification to customer
    try {
      const waAccount = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId });
      if (waAccount) {
        const wa = require('../services/whatsapp');
        const custId = require('../services/customerIdentity');
        const to = custId.resolveRecipient(customer);
        const sysToken = metaConfig.systemUserToken;
        await wa.sendText(waAccount.phone_number_id, sysToken, to,
          `Your issue #${issue.issue_number} has been logged. Our team will look into it shortly.`
        );
      }
    } catch (_) {}

    res.status(201).json(maskIssue(issue));

    log({ actorType: 'restaurant', actorId: String(req.restaurantId), actorName: (req.restaurant?.business_name || 'Restaurant'), action: 'issue.created', category: 'issue', description: `Issue created by ${(req.restaurant?.business_name || 'Restaurant')}`, restaurantId: String(req.restaurantId), severity: 'info' });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// PUT /api/restaurant/issues/:id/status — update issue status
router.put('/issues/:id/status', requireAuth, requireApproved, async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status required' });
    const issue = await issueSvc.getIssue(req.params.id);
    if (!issue || issue.restaurant_id !== req.restaurantId) return res.status(404).json({ error: 'Issue not found' });

    const updated = await issueSvc.updateStatus(req.params.id, status, {
      actorType: 'restaurant', actorName: (req.restaurant?.business_name || 'Restaurant') || 'Restaurant',
      actorId: req.restaurantId,
    });

    // Notify customer for key transitions
    try {
      if (['assigned', 'in_progress', 'resolved'].includes(status)) {
        const waAccount = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId });
        if (waAccount) {
          const wa = require('../services/whatsapp');
          const custId = require('../services/customerIdentity');
          const customer = await col('customers').findOne({ _id: issue.customer_id });
          if (customer) {
            const to = custId.resolveRecipient(customer);
            const sysToken = metaConfig.systemUserToken;
            const msgs = {
              assigned: `We're looking into your issue #${issue.issue_number}. We'll update you soon.`,
              in_progress: `We're actively working on your issue #${issue.issue_number}.`,
              resolved: `Your issue #${issue.issue_number} has been resolved. ${issue.resolution_notes || ''}\n\nIf you're still unsatisfied, reply REOPEN.`,
            };
            if (msgs[status]) await wa.sendText(waAccount.phone_number_id, sysToken, to, msgs[status]);
          }
        }
      }
    } catch (_) {}

    res.json(maskIssue(updated));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/issues/:id/message — add message to issue thread
router.post('/issues/:id/message', requireAuth, requireApproved, async (req, res) => {
  try {
    const { text, internal } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });
    const issue = await issueSvc.getIssue(req.params.id);
    if (!issue || issue.restaurant_id !== req.restaurantId) return res.status(404).json({ error: 'Issue not found' });

    const msg = await issueSvc.addMessage(req.params.id, {
      senderType: 'restaurant',
      senderName: (req.restaurant?.business_name || 'Restaurant') || 'Restaurant',
      text, internal: !!internal, sentVia: 'dashboard',
    });

    // Send to customer via WhatsApp (unless internal)
    if (!internal) {
      try {
        const waAccount = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId });
        if (waAccount) {
          const wa = require('../services/whatsapp');
          const custId = require('../services/customerIdentity');
          const customer = await col('customers').findOne({ _id: issue.customer_id });
          if (customer) {
            const to = custId.resolveRecipient(customer);
            const sysToken = metaConfig.systemUserToken;
            await wa.sendText(waAccount.phone_number_id, sysToken, to,
              `Re: Issue #${issue.issue_number}\n\n${text}`
            );
          }
        }
      } catch (_) {}
    }

    res.json(msg);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/issues/:id/escalate — escalate to admin
router.post('/issues/:id/escalate', requireAuth, requireApproved, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'reason required' });
    const issue = await issueSvc.getIssue(req.params.id);
    if (!issue || issue.restaurant_id !== req.restaurantId) return res.status(404).json({ error: 'Issue not found' });

    // Determine escalation target
    let routeTo = 'admin';
    if (['wrong_charge', 'refund_request', 'payment_failed', 'coupon_issue'].includes(issue.category)) routeTo = 'admin_financial';
    if (['delivery_late', 'delivery_not_received', 'delivery_damaged', 'rider_behavior', 'wrong_address'].includes(issue.category)) routeTo = 'admin_delivery';

    const updated = await issueSvc.escalateToAdmin(req.params.id, {
      escalatedBy: req.restaurantId,
      reason,
      routeTo,
    });

    // Notify customer
    try {
      const waAccount = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId });
      if (waAccount) {
        const wa = require('../services/whatsapp');
        const custId = require('../services/customerIdentity');
        const customer = await col('customers').findOne({ _id: issue.customer_id });
        if (customer) {
          const to = custId.resolveRecipient(customer);
          const sysToken = metaConfig.systemUserToken;
          await wa.sendText(waAccount.phone_number_id, sysToken, to,
            `Your issue #${issue.issue_number} has been escalated to our support team for faster resolution.`
          );
        }
      }
    } catch (_) {}

    res.json(maskIssue(updated));

    log({ actorType: 'restaurant', actorId: String(req.restaurantId), actorName: (req.restaurant?.business_name || 'Restaurant'), action: 'issue.escalated', category: 'issue', description: `Issue escalated to admin by ${(req.restaurant?.business_name || 'Restaurant')}`, restaurantId: String(req.restaurantId), severity: 'warning' });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/issues/:id/resolve — resolve issue
router.post('/issues/:id/resolve', requireAuth, requireApproved, async (req, res) => {
  try {
    const { resolution_type, resolution_notes } = req.body;
    const issue = await issueSvc.getIssue(req.params.id);
    if (!issue || issue.restaurant_id !== req.restaurantId) return res.status(404).json({ error: 'Issue not found' });

    const updated = await issueSvc.resolveIssue(req.params.id, {
      resolutionType: resolution_type || 'no_action',
      resolutionNotes: resolution_notes || null,
      actorType: 'restaurant', actorName: (req.restaurant?.business_name || 'Restaurant') || 'Restaurant',
      actorId: req.restaurantId,
    });

    // Notify customer
    try {
      const waAccount = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId });
      if (waAccount) {
        const wa = require('../services/whatsapp');
        const custId = require('../services/customerIdentity');
        const customer = await col('customers').findOne({ _id: issue.customer_id });
        if (customer) {
          const to = custId.resolveRecipient(customer);
          const sysToken = metaConfig.systemUserToken;
          await wa.sendText(waAccount.phone_number_id, sysToken, to,
            `Your issue #${issue.issue_number} has been resolved. ${resolution_notes || ''}\n\nIf you're still unsatisfied, reply REOPEN.`
          );
        }
      }
    } catch (_) {}

    res.json(maskIssue(updated));

    log({ actorType: 'restaurant', actorId: String(req.restaurantId), actorName: (req.restaurant?.business_name || 'Restaurant'), action: 'issue.resolved', category: 'issue', description: `Issue resolved by ${(req.restaurant?.business_name || 'Restaurant')}`, restaurantId: String(req.restaurantId), severity: 'info' });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// POST /api/restaurant/issues/:id/reopen — reopen resolved issue
router.post('/issues/:id/reopen', requireAuth, requireApproved, async (req, res) => {
  try {
    const issue = await issueSvc.getIssue(req.params.id);
    if (!issue || issue.restaurant_id !== req.restaurantId) return res.status(404).json({ error: 'Issue not found' });

    const updated = await issueSvc.reopenIssue(req.params.id, {
      actorType: 'restaurant', actorName: (req.restaurant?.business_name || 'Restaurant') || 'Restaurant',
      actorId: req.restaurantId, reason: req.body.reason,
    });
    res.json(maskIssue(updated));
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ─── STAFF USERS (per-user RBAC) ───────────────────────────────
// Owner/manager-side CRUD over staff accounts in restaurant_users
// (role: 'staff'). All endpoints filter by req.restaurantId so a
// restaurant can never read or modify another restaurant's staff.
// Gated by manage_staff (NOT manage_users — that perm is for the
// customer-side user management).
//
// PINs are 4-digit and bcrypt-hashed at 10 rounds. The plain PIN is
// only ever returned ONCE (on create + reset) so the owner can hand it
// off. Subsequent reads NEVER include pin_hash or the plain PIN.

const _STAFF_BCRYPT = require('bcryptjs');

const _STAFF_VALID_PERM_KEYS = new Set([
  'view_orders', 'manage_orders',
  'view_menu', 'manage_menu',
  'view_analytics', 'manage_settings',
  'manage_coupons', 'manage_users',
  'view_payments', 'manage_staff',
]);

function _normalizeStaffPermissions(input) {
  // Filter to known keys; coerce to boolean. Defaults to all-false.
  const out = {};
  for (const k of _STAFF_VALID_PERM_KEYS) out[k] = false;
  if (input && typeof input === 'object') {
    for (const [k, v] of Object.entries(input)) {
      if (_STAFF_VALID_PERM_KEYS.has(k)) out[k] = !!v;
    }
  }
  return out;
}

function _normalizeBranchIds(input, restaurantId) {
  // Empty/missing array means "all branches". Otherwise must be an
  // array of strings — we don't ownership-check the branches here
  // (cheap), but the order/menu guards re-check at request time so a
  // forged branch_id in the array is harmless.
  if (!Array.isArray(input)) return [];
  return input.map((b) => String(b)).filter(Boolean);
}

function _staffUserPublic(u) {
  if (!u) return null;
  return {
    id: String(u._id),
    name: u.name || '',
    phone: u.phone || '',
    role: u.role || 'staff',
    branch_ids: Array.isArray(u.branch_ids) ? u.branch_ids : [],
    permissions: u.permissions || {},
    is_active: !!u.is_active,
    last_login_at: u.last_login_at || null,
    created_at: u.created_at || null,
    updated_at: u.updated_at || null,
  };
}

// POST /api/restaurant/staff-users
// Body: { name, phone, pin (4-digit), branch_ids?, permissions? }
// Returns: { staffUser: <public shape>, pin } — pin is the plain PIN
// returned ONCE so the owner can hand it off.
router.post('/staff-users', requireAuth, requirePermission('manage_staff'), express.json(),
  async (req, res) => {
    try {
      const { name, phone, pin, branch_ids, permissions } = req.body || {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name is required' });
      }
      if (!phone || !/^[0-9]{10,15}$/.test(String(phone))) {
        return res.status(400).json({ error: 'phone is required (10-15 digits)' });
      }
      if (!pin || !/^\d{4}$/.test(String(pin))) {
        return res.status(400).json({ error: 'pin must be exactly 4 digits' });
      }
      // Phone uniqueness within the restaurant (across active rows).
      // Soft-deleted (is_active=false) rows don't conflict so the same
      // phone can be re-used after a staff member leaves and rejoins.
      const dupe = await col('restaurant_users').findOne({
        restaurant_id: req.restaurantId,
        phone: String(phone),
        is_active: true,
      });
      if (dupe) return res.status(409).json({ error: 'A staff user with this phone already exists' });

      const pinHash = await _STAFF_BCRYPT.hash(String(pin), 10);
      const now = new Date();
      const doc = {
        _id: newId(),
        restaurant_id: req.restaurantId,
        name: name.trim(),
        phone: String(phone),
        email: null,
        pin_hash: pinHash,
        pin_attempts: 0,
        pin_locked_until: null,
        token_version: 0,
        role: 'staff',
        branch_ids: _normalizeBranchIds(branch_ids, req.restaurantId),
        permissions: _normalizeStaffPermissions(permissions),
        is_active: true,
        last_login_at: null,
        created_at: now,
        updated_at: now,
      };
      await col('restaurant_users').insertOne(doc);

      log({
        actorType: 'restaurant', actorId: String(req.userId || req.restaurantId), actorName: req.userRole || null,
        action: 'staff_user.created', category: 'settings',
        description: `Staff user "${doc.name}" (${doc.phone}) created`,
        restaurantId: req.restaurantId,
        resourceType: 'staff_user', resourceId: doc._id,
        severity: 'info',
      });

      return res.status(201).json({
        success: true,
        staffUser: _staffUserPublic(doc),
        // Plain PIN returned ONCE so the admin can give it to the staff
        // member. Never persisted.
        pin: String(pin),
      });
    } catch (e) {
      req.log?.error?.({ err: e }, 'staff_user create failed');
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

// GET /api/restaurant/staff-users — list active staff for this restaurant.
// Includes inactive too if ?include_inactive=true. Never returns pin_hash.
router.get('/staff-users', requireAuth, requirePermission('manage_staff'), async (req, res) => {
  try {
    const filter = {
      restaurant_id: req.restaurantId,
      role: 'staff',
    };
    if (req.query.include_inactive !== 'true') filter.is_active = true;
    const rows = await col('restaurant_users')
      .find(filter, { projection: { pin_hash: 0 } })
      .sort({ created_at: -1 })
      .toArray();
    res.json({ success: true, staffUsers: rows.map(_staffUserPublic) });
  } catch (e) {
    req.log?.error?.({ err: e }, 'staff_user list failed');
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// PUT /api/restaurant/staff-users/:userId — update name, branch_ids,
// permissions, is_active. PIN is updated via the dedicated /reset-pin
// route below (separate concern, separate audit trail).
router.put('/staff-users/:userId', requireAuth, requirePermission('manage_staff'), express.json(),
  async (req, res) => {
    try {
      const userId = req.params.userId;
      const target = await col('restaurant_users').findOne({
        _id: userId,
        restaurant_id: req.restaurantId,
        role: 'staff',
      });
      if (!target) return res.status(404).json({ error: 'Staff user not found' });

      const $set = { updated_at: new Date() };
      if (typeof req.body?.name === 'string' && req.body.name.trim()) {
        $set.name = req.body.name.trim();
      }
      if (Array.isArray(req.body?.branch_ids)) {
        $set.branch_ids = _normalizeBranchIds(req.body.branch_ids, req.restaurantId);
      }
      if (req.body?.permissions && typeof req.body.permissions === 'object') {
        $set.permissions = _normalizeStaffPermissions(req.body.permissions);
      }
      let bumpTokenVersion = false;
      if (typeof req.body?.is_active === 'boolean') {
        if (req.body.is_active === false && target.is_active) bumpTokenVersion = true;
        $set.is_active = req.body.is_active;
      }

      const update = { $set };
      // Bumping token_version invalidates every in-flight token for
      // this staff user — used when the admin deactivates them so
      // tablets log out immediately.
      if (bumpTokenVersion) update.$inc = { token_version: 1 };

      await col('restaurant_users').updateOne({ _id: userId }, update);
      const fresh = await col('restaurant_users').findOne(
        { _id: userId },
        { projection: { pin_hash: 0 } },
      );

      log({
        actorType: 'restaurant', actorId: String(req.userId || req.restaurantId), actorName: req.userRole || null,
        action: 'staff_user.updated', category: 'settings',
        description: `Staff user "${target.name}" updated${bumpTokenVersion ? ' (deactivated — sessions revoked)' : ''}`,
        restaurantId: req.restaurantId,
        resourceType: 'staff_user', resourceId: userId,
        severity: 'info',
        metadata: { fields: Object.keys($set).filter(k => k !== 'updated_at') },
      });

      res.json({ success: true, staffUser: _staffUserPublic(fresh) });
    } catch (e) {
      req.log?.error?.({ err: e, userId: req.params.userId }, 'staff_user update failed');
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

// PUT /api/restaurant/staff-users/:userId/reset-pin
// Body: { pin } — 4-digit. Re-hashes; bumps token_version so any
// in-flight session for this user (e.g., a forgotten tablet) is
// immediately invalidated and forced to re-PIN.
router.put('/staff-users/:userId/reset-pin', requireAuth, requirePermission('manage_staff'), express.json(),
  async (req, res) => {
    try {
      const userId = req.params.userId;
      const { pin } = req.body || {};
      if (!pin || !/^\d{4}$/.test(String(pin))) {
        return res.status(400).json({ error: 'pin must be exactly 4 digits' });
      }
      const target = await col('restaurant_users').findOne({
        _id: userId,
        restaurant_id: req.restaurantId,
        role: 'staff',
      });
      if (!target) return res.status(404).json({ error: 'Staff user not found' });

      const pinHash = await _STAFF_BCRYPT.hash(String(pin), 10);
      await col('restaurant_users').updateOne(
        { _id: userId },
        {
          $set: { pin_hash: pinHash, updated_at: new Date() },
          $inc: { token_version: 1 },
        },
      );

      log({
        actorType: 'restaurant', actorId: String(req.userId || req.restaurantId), actorName: req.userRole || null,
        action: 'staff_user.pin_reset', category: 'settings',
        description: `Staff user "${target.name}" PIN reset (sessions revoked)`,
        restaurantId: req.restaurantId,
        resourceType: 'staff_user', resourceId: userId,
        severity: 'warning',
      });

      res.json({ success: true, pin: String(pin) });
    } catch (e) {
      req.log?.error?.({ err: e, userId: req.params.userId }, 'staff_user reset-pin failed');
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

// DELETE /api/restaurant/staff-users/:userId — soft delete.
// is_active: false + token_version bump so any in-flight tablet is
// logged out immediately. Row is preserved so audit logs that reference
// it still resolve.
router.delete('/staff-users/:userId', requireAuth, requirePermission('manage_staff'),
  async (req, res) => {
    try {
      const userId = req.params.userId;
      const target = await col('restaurant_users').findOne({
        _id: userId,
        restaurant_id: req.restaurantId,
        role: 'staff',
      });
      if (!target) return res.status(404).json({ error: 'Staff user not found' });
      if (!target.is_active) {
        return res.json({ success: true, alreadyInactive: true });
      }
      await col('restaurant_users').updateOne(
        { _id: userId },
        {
          $set: { is_active: false, updated_at: new Date() },
          $inc: { token_version: 1 },
        },
      );

      log({
        actorType: 'restaurant', actorId: String(req.userId || req.restaurantId), actorName: req.userRole || null,
        action: 'staff_user.deleted', category: 'settings',
        description: `Staff user "${target.name}" deactivated (sessions revoked)`,
        restaurantId: req.restaurantId,
        resourceType: 'staff_user', resourceId: userId,
        severity: 'warning',
      });

      res.json({ success: true });
    } catch (e) {
      req.log?.error?.({ err: e, userId: req.params.userId }, 'staff_user delete failed');
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

// ─── FINANCIAL ENDPOINTS ────────────────────────────────────────

// GET /api/restaurant/penalties
// Per-restaurant cancellation_fault_fee history. Each REJECTED_BY_RESTAURANT
// or RESTAURANT_TIMEOUT order writes a `cancellation_fault_fee` subdocument
// onto the order (see services/orderCancellationService.js). We project it
// out for the dashboard's Penalties page.
//
// Query: ?from=ISO&to=ISO (both optional). When provided, filters by
// cancellation_fault_fee.created_at — the moment the fee was booked, not
// the moment the order was placed (so the dashboard date filter matches
// the period the fee actually hit the restaurant's account).
router.get('/penalties', requireAuth, async (req, res) => {
  try {
    const { from, to } = req.query;
    const match = {
      restaurant_id: req.restaurantId,
      cancellation_fault_fee: { $exists: true },
    };
    if (from || to) {
      match['cancellation_fault_fee.created_at'] = {};
      if (from) {
        const f = new Date(from);
        if (!Number.isNaN(f.getTime())) match['cancellation_fault_fee.created_at'].$gte = f;
      }
      if (to) {
        const t = new Date(to);
        if (!Number.isNaN(t.getTime())) match['cancellation_fault_fee.created_at'].$lte = t;
      }
      if (!Object.keys(match['cancellation_fault_fee.created_at']).length) {
        delete match['cancellation_fault_fee.created_at'];
      }
    }

    const orders = await col('orders')
      .find(match, { projection: { _id: 1, order_number: 1, cancellation_fault_fee: 1 } })
      .sort({ 'cancellation_fault_fee.created_at': -1 })
      .limit(500)
      .toArray();

    let totalFaultFees = 0;
    const faultFees = orders.map((o) => {
      const fee = o.cancellation_fault_fee || {};
      const amount = Number(fee.amount) || 0;
      totalFaultFees += amount;
      return {
        orderId: String(o._id),
        orderNumber: o.order_number || String(o._id),
        amount,
        reason: fee.reason || null,
        orderTotal: Number(fee.order_total) || 0,
        createdAt: fee.created_at || null,
      };
    });

    res.json({
      totalFaultFees: Math.round(totalFaultFees * 100) / 100,
      faultFees,
    });
  } catch (e) {
    req.log?.error?.({ err: e }, 'penalties query failed');
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// GET /api/restaurant/financials/summary
router.get('/financials/summary', requireAuth, requireApproved, async (req, res) => {
  try {
    const { period, from, to } = req.query;
    const summary = await financials.getFinancialSummary(req.restaurantId, period || '30d', from, to);
    res.json(summary);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/financials/daily
router.get('/financials/daily', requireAuth, requireApproved, async (req, res) => {
  try {
    const { from, to, period } = req.query;
    const { start, end } = financials.parsePeriod(period || '30d', from, to);
    const branches = await col('branches').find({ restaurant_id: req.restaurantId }).project({ _id: 1 }).toArray();
    const branchIds = branches.map(b => String(b._id));
    const days = await financials.getDailyBreakdown(branchIds, start, end);
    res.json({ days });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/financials/settlements
router.get('/financials/settlements', requireAuth, requireApproved, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const match = { restaurant_id: req.restaurantId };
    const [settlements, total] = await Promise.all([
      col('settlements').find(match).sort({ period_end: -1 }).skip(skip).limit(limit).toArray(),
      col('settlements').countDocuments(match),
    ]);
    res.json({ settlements, total, page, pages: Math.ceil(total / limit) });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/financials/settlements/:id
router.get('/financials/settlements/:id', requireAuth, requireApproved, async (req, res) => {
  try {
    const settlement = await col('settlements').findOne({ _id: req.params.id, restaurant_id: req.restaurantId });
    if (!settlement) return res.status(404).json({ error: 'Settlement not found' });
    // Fetch orders for this settlement. Exclude delivery_address snapshot,
    // customer contact fields, and raw payment objects — the settlement view
    // needs totals per order, not customer PII.
    //
    // branch_id query param narrows the order list to a single branch
    // for the per-branch breakdown drawer. Same tenant-safety pattern as
    // /financials/payments above: re-validate the supplied id is in the
    // restaurant's branch set; a forged id silently falls through to the
    // unfiltered settlement scope rather than 4xx-ing.
    const orderFilter = { settlement_id: req.params.id };
    const { branch_id } = req.query;
    if (branch_id) {
      const branches = await col('branches').find({ restaurant_id: req.restaurantId }).project({ _id: 1 }).toArray();
      const branchIds = branches.map(b => String(b._id));
      if (branchIds.includes(String(branch_id))) {
        orderFilter.branch_id = String(branch_id);
      }
    }
    const orders = await col('orders').find(
      orderFilter,
      {
        projection: {
          _id: 1, order_number: 1, status: 1, total_rs: 1, subtotal_rs: 1,
          tax_rs: 1, delivery_fee_rs: 1, discount_rs: 1, commission_rs: 1,
          branch_id: 1, restaurant_id: 1, created_at: 1, delivered_at: 1,
          payment_status: 1, payment_method: 1,
        },
      }
    ).sort({ created_at: 1 }).toArray();
    res.json({ settlement, orders });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/financials/payments
router.get('/financials/payments', requireAuth, requireApproved, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const skip = (page - 1) * limit;
    const { from, to, status, branch_id } = req.query;
    const branches = await col('branches').find({ restaurant_id: req.restaurantId }).project({ _id: 1 }).toArray();
    const branchIds = branches.map(b => String(b._id));
    // Get order IDs for this restaurant. branch_id query param narrows
    // the branch filter to a single tenant-owned branch; we still verify
    // it's in the restaurant's branch set to keep the cross-tenant guard
    // intact (a forged branch_id from another restaurant just falls
    // through to the existing $in scope and matches nothing).
    const orderMatch = { branch_id: { $in: branchIds } };
    if (branch_id && branchIds.includes(String(branch_id))) {
      orderMatch.branch_id = String(branch_id);
    }
    if (from || to) {
      orderMatch.created_at = {};
      if (from) orderMatch.created_at.$gte = new Date(from);
      if (to) orderMatch.created_at.$lte = new Date(to);
    }
    const orderIds = await col('orders').find(orderMatch).project({ _id: 1 }).toArray().then(os => os.map(o => String(o._id)));
    const payMatch = { order_id: { $in: orderIds } };
    if (status) payMatch.status = status;
    const [payments, total] = await Promise.all([
      col('payments').find(payMatch).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
      col('payments').countDocuments(payMatch),
    ]);
    res.json({ payments, total, page, pages: Math.ceil(total / limit) });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/financials/tax-summary
router.get('/financials/tax-summary', requireAuth, requireApproved, async (req, res) => {
  try {
    const summary = await financials.getTaxSummary(req.restaurantId, req.query.fy);
    res.json(summary);
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ═══════════════════════════════════════════════════════════════
// PER-ORDER SETTLEMENTS V2 — Restaurant endpoints (scoped)
// ═══════════════════════════════════════════════════════════════

// GET /api/restaurant/order-settlements — list current restaurant's settlements
router.get('/order-settlements', async (req, res) => {
  try {
    // CRITICAL: always scope by req.restaurantId from JWT, never query params
    const filter = { restaurant_id: req.restaurantId };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.from || req.query.to) {
      filter.created_at = {};
      if (req.query.from) filter.created_at.$gte = new Date(req.query.from);
      if (req.query.to) filter.created_at.$lte = new Date(req.query.to);
    }

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const skip = parseInt(req.query.skip) || 0;

    const [settlements, total, summary] = await Promise.all([
      col('order_settlements').find(filter).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
      col('order_settlements').countDocuments(filter),
      col('order_settlements').aggregate([
        { $match: filter },
        { $group: {
          _id: '$status',
          count: { $sum: 1 },
          total_net: { $sum: '$net_amount' },
        }},
      ]).toArray(),
    ]);

    const summaryByStatus = {};
    for (const s of summary) summaryByStatus[s._id] = { count: s.count, total: s.total_net };

    res.json({
      total,
      summary: summaryByStatus,
      settlements: settlements.map(s => ({
        id: String(s._id),
        order_id: s.order_id,
        order_number: s.order_number,
        gross_amount: s.gross_amount,
        platform_fee: s.platform_fee,
        gateway_fee: s.gateway_fee,
        net_amount: s.net_amount,
        status: s.status,
        created_at: s.created_at,
        updated_at: s.updated_at,
        // Don't expose payout_id or razorpay_payout_id to restaurants
      })),
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// GET /api/restaurant/order-settlements/:id — single settlement detail (own only)
router.get('/order-settlements/:id', async (req, res) => {
  try {
    const settlement = await col('order_settlements').findOne({
      _id: req.params.id,
      restaurant_id: req.restaurantId,   // Enforce ownership at query level
    });
    if (!settlement) return res.status(404).json({ error: 'Settlement not found' });

    // Optionally include payout status (without exposing internal IDs)
    let payoutStatus = null;
    if (settlement.payout_id) {
      const payout = await col('payouts').findOne(
        { _id: settlement.payout_id, restaurant_id: req.restaurantId },
        { projection: { status: 1, utr: 1, failure_reason: 1 } }
      );
      if (payout) payoutStatus = { status: payout.status, utr: payout.utr || null, failure_reason: payout.failure_reason || null };
    }

    res.json({
      id: String(settlement._id),
      order_id: settlement.order_id,
      order_number: settlement.order_number,
      gross_amount: settlement.gross_amount,
      platform_fee: settlement.platform_fee,
      platform_fee_gst: settlement.platform_fee_gst,
      gateway_fee: settlement.gateway_fee,
      rest_delivery_rs: settlement.rest_delivery_rs,
      rest_delivery_gst: settlement.rest_delivery_gst,
      referral_fee: settlement.referral_fee,
      referral_fee_gst: settlement.referral_fee_gst,
      net_amount: settlement.net_amount,
      status: settlement.status,
      payout: payoutStatus,
      created_at: settlement.created_at,
      updated_at: settlement.updated_at,
    });
  } catch (e) { res.status(500).json({ success: false, message: "Internal server error" }); }
});

// ═══════════════════════════════════════════════════════════════
// MARKETING SEND-FROM NUMBER
// Lets a restaurant choose which of their WABA-registered numbers
// is used as the sender for marketing campaigns. Backed by the
// `marketingPhoneNumberId` field on restaurants.
// ═══════════════════════════════════════════════════════════════

// Fetch the list of phone numbers attached to a WABA. Used by both
// the GET /waba-numbers handler and the PUT /marketing-number
// validator, so errors bubble up the same way in both paths.
async function _fetchWabaPhoneNumbers(wabaId) {
  const res = await axios.get(`${metaConfig.graphUrl}/${wabaId}/phone_numbers`, {
    params: {
      fields: 'id,display_phone_number,verified_name,quality_rating',
      access_token: metaConfig.getMessagingToken(),
    },
    timeout: 15000,
  });
  return res.data?.data || [];
}

router.get('/:restaurantId/waba-numbers', async (req, res) => {
  try {
    if (req.restaurantId !== req.params.restaurantId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const wa = await col('whatsapp_accounts').findOne({
      restaurant_id: req.params.restaurantId,
      is_active: true,
    });
    if (!wa?.waba_id) return res.status(404).json({ error: 'No active WABA for restaurant' });

    const numbers = await _fetchWabaPhoneNumbers(wa.waba_id);
    res.json({ numbers });
  } catch (e) {
    const metaErr = e.response?.data?.error?.message;
    logger.error({ err: e, metaErr }, 'waba-numbers fetch failed');
    res.status(500).json({ success: false, message: metaErr || 'Internal server error' });
  }
});

router.put('/:restaurantId/marketing-number', async (req, res) => {
  try {
    if (req.restaurantId !== req.params.restaurantId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { phoneNumberId, displayName } = req.body || {};

    if (phoneNumberId === null || phoneNumberId === '' || typeof phoneNumberId === 'undefined') {
      await col('restaurants').updateOne(
        { _id: req.params.restaurantId },
        { $set: { marketingPhoneNumberId: null, marketingPhoneDisplayName: null, updated_at: new Date() } }
      );
      invalidateCache(`restaurant:${req.params.restaurantId}:profile`);
      memcache.del(`restaurant:${req.params.restaurantId}`);
      return res.json({ success: true, marketingPhoneNumberId: null, marketingPhoneDisplayName: null });
    }

    const wa = await col('whatsapp_accounts').findOne({
      restaurant_id: req.params.restaurantId,
      is_active: true,
    });
    if (!wa?.waba_id) return res.status(404).json({ error: 'No active WABA for restaurant' });

    const numbers = await _fetchWabaPhoneNumbers(wa.waba_id);
    const match = numbers.find(n => String(n.id) === String(phoneNumberId));
    if (!match) {
      return res.status(400).json({ error: 'phoneNumberId does not belong to this WABA' });
    }

    const resolvedDisplayName = displayName || match.verified_name || match.display_phone_number || null;
    await col('restaurants').updateOne(
      { _id: req.params.restaurantId },
      {
        $set: {
          marketingPhoneNumberId: String(phoneNumberId),
          marketingPhoneDisplayName: resolvedDisplayName,
          updated_at: new Date(),
        },
      }
    );
    invalidateCache(`restaurant:${req.params.restaurantId}:profile`);
    memcache.del(`restaurant:${req.params.restaurantId}`);

    res.json({
      success: true,
      marketingPhoneNumberId: String(phoneNumberId),
      marketingPhoneDisplayName: resolvedDisplayName,
    });
  } catch (e) {
    const metaErr = e.response?.data?.error?.message;
    logger.error({ err: e, metaErr }, 'marketing-number set failed');
    res.status(500).json({ success: false, message: metaErr || 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN ↔ RESTAURANT DIRECT MESSAGES (restaurant side)
// ═══════════════════════════════════════════════════════════════
// Mounted at /admin-messages (NOT /messages) because the existing
// /messages and /messages/reply endpoints already serve the customer
// inbox. Same `admin_restaurant_messages` collection backing as the
// admin-side routes.

// POST /api/restaurant/admin-messages/reply — restaurant replies to admin
router.post('/admin-messages/reply', async (req, res) => {
  try {
    const { message } = req.body || {};
    const text = typeof message === 'string' ? message.trim() : '';
    if (!text) return res.status(400).json({ error: 'message is required' });
    if (text.length > 4000) return res.status(400).json({ error: 'message too long (max 4000 chars)' });

    const doc = {
      _id: newId(),
      from: 'restaurant',
      restaurantId: String(req.restaurantId),
      message: text,
      read: false,
      created_at: new Date(),
    };
    await col('admin_restaurant_messages').insertOne(doc);

    // Resolve the restaurant name for the admin toast — kept off the
    // critical path with a non-blocking projection lookup. If the
    // restaurant doc is missing for any reason, fall back to id so
    // the admin still gets a usable signal.
    let restaurantName = null;
    try {
      const r = await col('restaurants').findOne(
        { _id: req.restaurantId },
        { projection: { _id: 0, business_name: 1, brand_name: 1 } },
      );
      restaurantName = r?.business_name || r?.brand_name || null;
    } catch (_) { /* keep null */ }

    // Fire to the admin:platform room so all admin sockets see the
    // reply. The drawer on the admin side filters by restaurantId
    // to surface in the right thread.
    const { emitToAdmin } = require('../utils/socketEmit');
    emitToAdmin('message:new', {
      from: String(req.restaurantId),
      restaurantId: String(req.restaurantId),
      restaurantName,
      message: text,
      timestamp: doc.created_at.toISOString(),
    });

    res.status(201).json(mapId(doc));
  } catch (e) {
    req.log?.error?.({ err: e }, 'restaurant reply admin message failed');
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// GET /api/restaurant/admin-messages — fetch own thread (last 50).
// Marks all admin→restaurant messages as read so the merchant's
// unread badge clears.
router.get('/admin-messages', async (req, res) => {
  try {
    const rows = await col('admin_restaurant_messages')
      .find({ restaurantId: String(req.restaurantId) })
      .sort({ created_at: -1 })
      .limit(50)
      .toArray();

    await col('admin_restaurant_messages').updateMany(
      { restaurantId: String(req.restaurantId), from: 'admin', read: false },
      { $set: { read: true } },
    ).catch(() => {});

    res.json({ messages: mapIds(rows) });
  } catch (e) {
    req.log?.error?.({ err: e }, 'restaurant fetch admin thread failed');
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
