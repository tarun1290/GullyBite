// src/routes/restaurant.js
// REST API for the restaurant owner dashboard
// Protected by JWT — all routes require login

const express = require('express');
const router = express.Router();
const multer = require('multer');
const axios  = require('axios');
const { col, newId, mapId, mapIds } = require('../config/database');
const { requireAuth, requireApproved, requirePermission, ROLE_PERMISSIONS } = require('./auth');
const catalog = require('../services/catalog');
const orderSvc = require('../services/order');
const wa = require('../services/whatsapp');
const etaSvc = require('../services/eta');
const notify = require('../services/notify');
const orderNotify = require('../services/orderNotify');
const { logActivity: log } = require('../services/activityLog');
const issueSvc = require('../services/issues');
const financials = require('../services/financials');
const imgSvc = require('../services/imageUpload');
const metaConfig = require('../config/meta');

// ── Image upload via S3 + CloudFront ─────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits : { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter(req, file, cb) {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype);
    cb(ok ? null : new Error('Only JPEG, PNG, WebP or GIF images are allowed'), ok);
  },
});

// All routes below require authentication
// requireApproved is applied only to routes that need WhatsApp (order flow, catalog sync)
router.use(requireAuth);

// ═══════════════════════════════════════════════════════════════
// RESTAURANT PROFILE
// ═══════════════════════════════════════════════════════════════

// GET /api/restaurant — Get my restaurant + stats
router.get('/', async (req, res) => {
  try {
    const r = await col('restaurants').findOne({ _id: req.restaurantId });
    if (!r) return res.status(404).json({ error: 'Not found' });
    const [branch_count, wa_count] = await Promise.all([
      col('branches').countDocuments({ restaurant_id: req.restaurantId }),
      col('whatsapp_accounts').countDocuments({ restaurant_id: req.restaurantId, is_active: true }),
    ]);
    const out = mapId(r);
    delete out.meta_access_token;
    res.json({ ...out, branch_count, wa_count });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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

    const result = await imgSvc.uploadImage(req.file.buffer, {
      restaurantId: req.restaurantId,
      branchId,
      itemId,
    });

    // If item_id provided, update the menu item
    if (itemId) {
      await col('menu_items').updateOne(
        { _id: itemId, branch_id: branchId },
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
    console.error('[Image] Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/restaurant/images/bulk-upload — upload multiple images, auto-match to items
router.post('/images/bulk-upload', upload.array('images', 20), async (req, res) => {
  if (!imgSvc.IMAGE_PIPELINE_ENABLED) return res.status(503).json(IMAGE_503);
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No image files received' });
  const branchId = req.body?.branchId;
  if (!branchId) return res.status(400).json({ error: 'branchId is required' });

  try {
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
    res.status(500).json({ error: err.message });
  }
});

// POST /api/restaurant/images/from-url — import image from external URL
router.post('/images/from-url', async (req, res) => {
  if (!imgSvc.IMAGE_PIPELINE_ENABLED) return res.status(503).json(IMAGE_503);
  const { sourceUrl, itemId, branchId } = req.body;
  if (!sourceUrl) return res.status(400).json({ error: 'sourceUrl is required' });

  try {
    const result = await imgSvc.uploadImageFromUrl(sourceUrl, {
      restaurantId: req.restaurantId,
      branchId,
      itemId,
    });

    if (itemId) {
      await col('menu_items').updateOne(
        { _id: itemId },
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
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/restaurant/images/:itemId — remove image from a menu item
router.delete('/images/:itemId', async (req, res) => {
  if (!imgSvc.IMAGE_PIPELINE_ENABLED) return res.status(503).json(IMAGE_503);
  try {
    const item = await col('menu_items').findOne({ _id: req.params.itemId });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// WHATSAPP ACCOUNTS
// ═══════════════════════════════════════════════════════════════

// POST /api/restaurant/whatsapp/verify-connection
// Verifies Meta connection using system user token — no OAuth needed.
// If WABA data exists in DB, validates it against Meta API.
// If not, tries to discover WABAs using META_BUSINESS_ID.
router.post('/whatsapp/verify-connection', async (req, res) => {
  try {
    const sysToken = metaConfig.systemUserToken;
    if (!sysToken) return res.status(503).json({ error: 'System user token not configured. Please contact support.' });

    const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
    const waAccounts = await col('whatsapp_accounts').find({ restaurant_id: req.restaurantId }).toArray();
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

    // If no WA accounts exist, try to discover via META_BUSINESS_ID
    if (!waAccounts.length && metaConfig.businessId) {
      try {
        const wabaRes = await axios.get(`${metaConfig.graphUrl}/${metaConfig.businessId}/owned_whatsapp_business_accounts`, {
          params: { access_token: sysToken, fields: 'id,name,phone_numbers{id,display_phone_number,verified_name,quality_rating}' },
          timeout: 10000,
        });
        const wabas = wabaRes.data?.data || [];
        for (const waba of wabas) {
          for (const phone of (waba.phone_numbers?.data || [])) {
            await col('whatsapp_accounts').updateOne(
              { phone_number_id: phone.id },
              { $set: {
                restaurant_id: req.restaurantId, waba_id: waba.id,
                phone_display: phone.display_phone_number, display_name: phone.verified_name,
                quality_rating: phone.quality_rating || 'GREEN',
                access_token: sysToken, is_active: true, updated_at: new Date(),
              }, $setOnInsert: { _id: require('../config/database').newId(), created_at: new Date() } },
              { upsert: true }
            );
            results.discovered++;
          }
        }
        // Mark restaurant as connected
        if (results.discovered > 0) {
          await col('restaurants').updateOne({ _id: req.restaurantId }, {
            $set: { whatsapp_connected: true, updated_at: new Date() },
          });
        }
      } catch (e) {
        results.errors.push({ discovery: e.response?.data?.error?.message || e.message });
      }
    }

    // Ensure whatsapp_connected flag is set if we have valid accounts
    if (results.verified.length > 0 && !restaurant?.whatsapp_connected) {
      await col('restaurants').updateOne({ _id: req.restaurantId }, {
        $set: { whatsapp_connected: true, updated_at: new Date() },
      });
    }

    const connected = results.verified.length > 0 || results.discovered > 0;
    res.json({ connected, ...results });
  } catch (err) {
    console.error('[verify-connection]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/whatsapp', async (req, res) => {
  try {
    const docs = await col('whatsapp_accounts').find({ restaurant_id: req.restaurantId }).toArray();
    res.json(mapIds(docs).map(d => {
      const { _id, access_token, meta_access_token, ...rest } = d;
      return rest;
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/restaurant/whatsapp/:id/setup-status
// Returns live setup checklist status from Meta for a phone number
router.get('/whatsapp/:id/setup-status', async (req, res) => {
  try {
    const wa = await col('whatsapp_accounts').findOne({ _id: req.params.id, restaurant_id: req.restaurantId });
    if (!wa) return res.status(404).json({ error: 'WhatsApp account not found' });
    const sysToken = metaConfig.systemUserToken;
    if (!sysToken && !wa.access_token) return res.status(400).json({ error: 'WhatsApp API token is not configured. Please contact support.' });
    const effectiveToken = sysToken || wa.access_token;

    const GRAPH = metaConfig.graphUrl;

    // Fetch phone number details from Meta
    let phoneStatus = null;
    try {
      const r = await axios.get(`${GRAPH}/${wa.phone_number_id}`, {
        params: { fields: 'verified_name,display_phone_number,status,quality_rating,is_official_business_account,account_mode', access_token: effectiveToken },
        timeout: 8000,
      });
      phoneStatus = r.data;
    } catch (e) { phoneStatus = { error: e.response?.data?.error?.message || e.message }; }

    // Check WABA subscription
    let wabaSubscribed = false;
    try {
      const sysToken = metaConfig.systemUserToken;
      if (sysToken) {
        const r = await axios.get(`${GRAPH}/${wa.waba_id}/subscribed_apps`, {
          params: { access_token: sysToken }, timeout: 8000,
        });
        wabaSubscribed = (r.data?.data || []).some(app => app.id === metaConfig.appId);
      }
    } catch (_) {}

    res.json({
      phone_number_id : wa.phone_number_id,
      phone_registered: wa.phone_registered || false,
      cart_enabled    : wa.cart_enabled     || false,
      catalog_id      : wa.catalog_id       || null,
      waba_subscribed : wabaSubscribed,
      meta            : phoneStatus,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
      const updated = await col('whatsapp_accounts').findOne({ _id: req.params.id });
      if (updated.catalog_id) {
        await _enableCommerceSettings(wa.phone_number_id, updated.catalog_id);
        results.cart = 'ok';
      } else {
        results.cart = 'skipped — no catalog yet';
      }
    } catch (e) { results.cart = e.message; }

    const final = await col('whatsapp_accounts').findOne({ _id: req.params.id });
    res.json({
      success        : results.register === 'ok',
      phone_registered: final.phone_registered || false,
      cart_enabled    : final.cart_enabled     || false,
      catalog_id      : final.catalog_id       || null,
      steps           : results,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update WA account (mainly to set catalog_id)
router.put('/whatsapp/:id', async (req, res) => {
  try {
    const { catalogId, isActive } = req.body;
    const $set = {};
    if (catalogId !== undefined) $set.catalog_id = catalogId;
    if (isActive  !== undefined) $set.is_active   = isActive;
    await col('whatsapp_accounts').updateOne(
      { _id: req.params.id, restaurant_id: req.restaurantId },
      { $set }
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// BRANCHES
// ═══════════════════════════════════════════════════════════════

router.get('/branches', async (req, res) => {
  try {
    const docs = await col('branches').find({ restaurant_id: req.restaurantId }).sort({ created_at: 1 }).toArray();
    res.json(mapIds(docs));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/branches', async (req, res) => {
  try {
    const { name, address, city, pincode, latitude, longitude, deliveryRadiusKm, openingTime, closingTime, managerPhone } = req.body;
    if (!latitude || !longitude) return res.status(400).json({ error: 'latitude and longitude are required' });

    const branchId = newId();
    const now = new Date();
    const branch = {
      _id: branchId,
      restaurant_id: req.restaurantId,
      name,
      address,
      city,
      pincode,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      delivery_radius_km: deliveryRadiusKm || 5,
      opening_time: openingTime || '10:00',
      closing_time: closingTime || '22:00',
      manager_phone: managerPhone || null,
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
        if (result.success) console.log(`[Branch] Auto-created catalog for "${newBranch.name}": ${result.catalogId}`);
      })
      .catch(err => console.error(`[Branch] Auto catalog creation failed for "${newBranch.name}":`, err.message));

    res.status(201).json(newBranch);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
      const name    = (row.branch_name || '').trim();
      const address = (row.address     || '').trim();
      const lat     = parseFloat(row.latitude);
      const lng     = parseFloat(row.longitude);

      if (!name)          { skipped.push({ row, reason: 'branch_name is required' }); continue; }
      if (!address)       { skipped.push({ row, reason: 'address is required' });     continue; }
      if (isNaN(lat) || isNaN(lng)) { skipped.push({ row, reason: 'latitude and longitude are required — geocoding should have run on the client' }); continue; }

      try {
        const branchId = newId();
        const now = new Date();
        const branch = {
          _id: branchId,
          restaurant_id: req.restaurantId,
          name,
          address,
          city: (row.city    || '').trim() || null,
          pincode: (row.pincode || '').trim() || null,
          latitude: lat,
          longitude: lng,
          delivery_radius_km: parseFloat(row.delivery_radius_km) || 5,
          opening_time: row.opening_time || '10:00',
          closing_time: row.closing_time || '22:00',
          manager_phone: (row.manager_phone || '').trim() || null,
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
          .then(r => { if (r.success) console.log(`[Branch CSV] Catalog created for "${name}": ${r.catalogId}`); })
          .catch(e => console.error(`[Branch CSV] Catalog creation failed for "${name}":`, e.message));
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/branches/:id', async (req, res) => {
  try {
    const {
      isOpen, acceptsOrders, deliveryRadiusKm, catalogId,
      basePrepTimeMin, avgItemPrepMin, managerPhone,
    } = req.body;
    const $set = {};
    if (isOpen             !== undefined) $set.is_open              = isOpen;
    if (acceptsOrders      !== undefined) $set.accepts_orders       = acceptsOrders;
    if (deliveryRadiusKm   !== undefined) $set.delivery_radius_km   = deliveryRadiusKm;
    if (catalogId          !== undefined) $set.catalog_id           = catalogId;
    if (basePrepTimeMin    !== undefined) $set.base_prep_time_min   = parseInt(basePrepTimeMin) || 15;
    if (avgItemPrepMin     !== undefined) $set.avg_item_prep_min    = parseInt(avgItemPrepMin) || 3;
    if (managerPhone       !== undefined) $set.manager_phone        = managerPhone || null;
    await col('branches').updateOne(
      { _id: req.params.id, restaurant_id: req.restaurantId },
      { $set }
    );
    res.json({ success: true });

    if (isOpen !== undefined) {
      log({ actorType: 'restaurant', actorId: String(req.restaurantId), actorName: req.restaurant?.business_name || 'Restaurant', action: 'branch.toggled', category: 'settings', description: `Branch toggled`, restaurantId: String(req.restaurantId), resourceType: 'branch', resourceId: req.params.id, severity: 'info' });
    } else {
      log({ actorType: 'restaurant', actorId: String(req.restaurantId), actorName: req.restaurant?.business_name || 'Restaurant', action: 'branch.updated', category: 'settings', description: `Branch updated`, restaurantId: String(req.restaurantId), resourceType: 'branch', resourceId: req.params.id, severity: 'info' });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/restaurant/branches/:branchId/surge — current 3PL surge / delivery status
router.get('/branches/:branchId/surge', async (req, res) => {
  try {
    const branch = await col('branches').findOne({ _id: req.params.branchId, restaurant_id: req.restaurantId });
    if (!branch) return res.status(404).json({ error: 'Branch not found' });
    const { getSurgeInfo } = require('../services/dynamicPricing');
    const info = await getSurgeInfo(req.params.branchId);
    res.json(info);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// MENU CATEGORIES
// ═══════════════════════════════════════════════════════════════

router.get('/branches/:branchId/categories', async (req, res) => {
  try {
    const docs = await col('menu_categories').find({ branch_id: req.params.branchId }).sort({ sort_order: 1 }).toArray();
    res.json(mapIds(docs));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/branches/:branchId/categories', async (req, res) => {
  try {
    const { name, description, sortOrder } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Category name is required' });
    const catId = newId();
    const now = new Date();
    const cat = { _id: catId, branch_id: req.params.branchId, name: name.trim(), description: description || null, sort_order: sortOrder || 0, created_at: now };
    await col('menu_categories').insertOne(cat);
    res.status(201).json(mapId(cat));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/branches/:branchId/categories/:catId', async (req, res) => {
  try {
    const { name, sortOrder } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Category name is required' });
    const result = await col('menu_categories').findOneAndUpdate(
      { _id: req.params.catId, branch_id: req.params.branchId },
      { $set: { name: name.trim(), sort_order: sortOrder ?? undefined, updated_at: new Date() } },
      { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Category not found' });
    res.json(mapId(result));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/branches/:branchId/categories/:catId', async (req, res) => {
  try {
    await col('menu_categories').deleteOne({ _id: req.params.catId, branch_id: req.params.branchId });
    // Unlink items from this category (don't delete items, just uncategorize)
    await col('menu_items').updateMany(
      { branch_id: req.params.branchId, category_id: req.params.catId },
      { $set: { category_id: null } }
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// MENU ITEMS
// ═══════════════════════════════════════════════════════════════

router.get('/branches/:branchId/menu', async (req, res) => {
  try {
    const [cats, items] = await Promise.all([
      col('menu_categories').find({ branch_id: req.params.branchId }).sort({ sort_order: 1 }).toArray(),
      col('menu_items').find({ branch_id: req.params.branchId }).sort({ sort_order: 1, name: 1 }).toArray(),
    ]);
    const mappedCats  = mapIds(cats);
    const mappedItems = mapIds(items);
    const result = mappedCats.map(c => ({ ...c, items: mappedItems.filter(i => i.category_id === c.id) }));
    result.push({ id: null, name: 'Uncategorized', items: mappedItems.filter(i => !i.category_id) });
    res.json(result.filter(c => c.items.length > 0));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/branches/:branchId/menu', requirePermission('manage_menu'), async (req, res) => {
  try {
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

    const variantSuffix = variantValue ? `-${variantValue.toLowerCase().replace(/\s+/g, '-')}` : '';
    const retailerId = `ZM-${req.params.branchId.slice(0, 6)}-${Date.now()}${variantSuffix}`;
    const pricePaise = Math.round(parseFloat(priceRs) * 100);
    const now = new Date();
    const itemId = newId();
    const item = {
      _id: itemId,
      branch_id: req.params.branchId,
      category_id: categoryId || null,
      name,
      description: description || null,
      price_paise: pricePaise,
      retailer_id: retailerId,
      image_url: imageUrl || null,
      food_type: foodType || 'veg',
      is_bestseller: isBestseller || false,
      is_available: true,
      sort_order: sortOrder || 0,
      item_group_id: itemGroupId || null,
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

    await col('restaurants').updateOne(
      { _id: req.restaurantId },
      [{ $set: { onboarding_step: { $max: ['$onboarding_step', 4] } } }]
    );

    catalog.syncBranchCatalog(req.params.branchId)
      .catch(err => console.error('[Menu] Auto-sync after add failed:', err.message));

    res.status(201).json(mapId(item));

    log({
      actorType: 'restaurant', actorId: req.user?.id, actorName: req.user?.email || req.user?.phone,
      action: 'menu.item_added', category: 'menu',
      description: `Added menu item "${name}"`,
      restaurantId: req.restaurantId || req.restaurant?._id,
      branchId: req.params.branchId || null,
      resourceType: 'menu_item', resourceId: itemId,
      severity: 'info',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/menu/:itemId', requirePermission('manage_menu'), async (req, res) => {
  try {
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
        .catch(err => console.error('[Menu] Availability sync failed:', err.message));

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

    const updated = await col('menu_items').findOneAndUpdate(
      { _id: req.params.itemId },
      { $set },
      { returnDocument: 'after' }
    );
    if (updated) {
      catalog.syncBranchCatalog(updated.branch_id)
        .catch(err => console.error('[Menu] Auto-sync after edit failed:', err.message));
    }
    res.json({ success: true });

    log({
      actorType: 'restaurant', actorId: req.user?.id, actorName: req.user?.email || req.user?.phone,
      action: 'menu.item_updated', category: 'menu',
      description: `Updated menu item ${req.params.itemId}`,
      restaurantId: req.restaurantId || req.restaurant?._id,
      branchId: updated?.branch_id || null,
      resourceType: 'menu_item', resourceId: req.params.itemId,
      severity: 'info',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/menu/:itemId', requirePermission('manage_menu'), async (req, res) => {
  try {
    const item = await col('menu_items').findOne({ _id: req.params.itemId });
    await col('menu_items').deleteOne({ _id: req.params.itemId });

    if (item) {
      catalog.deleteProduct(item, item.branch_id)
        .catch(err => console.error('[Menu] Delete sync failed:', err.message));
    }
    res.json({ success: true });

    log({
      actorType: 'restaurant', actorId: req.user?.id, actorName: req.user?.email || req.user?.phone,
      action: 'menu.item_deleted', category: 'menu',
      description: `Deleted menu item ${req.params.itemId}${item ? ` ("${item.name}")` : ''}`,
      restaurantId: req.restaurantId || req.restaurant?._id,
      branchId: item?.branch_id || null,
      resourceType: 'menu_item', resourceId: req.params.itemId,
      severity: 'info',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

  // Auto-generate retailer_id for variants
  if (normalized.item_group_id && normalized.size && !normalized.retailer_id) {
    normalized.retailer_id = `${normalized.item_group_id}-${normalized.size.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`;
  }

  return normalized;
}

// POST /api/restaurant/branches/:branchId/menu/csv
// Bulk upsert menu items from a parsed CSV (supports Meta Commerce Manager template)
router.post('/branches/:branchId/menu/csv', async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'items array is required' });
    }

    const branchId = req.params.branchId;
    const results = { added: 0, skipped: 0, errors: [] };
    const categoryCache = {};

    for (const [i, rawRow] of items.entries()) {
      const row = _normalizeCSVRow(rawRow);
      const rowNum = i + 2;
      const name = (row.name || '').trim();
      // Support Meta "199.00 INR" format or plain number
      const priceRaw = row.price_paise ? null : (row.price || row.price_rs || '').toString().replace(/[₹,\s]/g, '');
      const price = row.price_paise ? row.price_paise / 100 : parseFloat(priceRaw);

      if (!name) { results.errors.push(`Row ${rowNum}: missing name`); results.skipped++; continue; }
      if (isNaN(price) || price <= 0) { results.errors.push(`Row ${rowNum} "${name}": invalid price "${row.price}"`); results.skipped++; continue; }

      try {
        const categoryName = (row.category || row.cat || '').trim();
        let categoryId = null;
        if (categoryName) {
          if (!categoryCache[categoryName]) {
            const ex = await col('menu_categories').findOne({ branch_id: branchId, name: categoryName });
            if (ex) {
              categoryCache[categoryName] = String(ex._id);
            } else {
              const catId = newId();
              await col('menu_categories').insertOne({ _id: catId, branch_id: branchId, name: categoryName, sort_order: 0, created_at: new Date() });
              categoryCache[categoryName] = catId;
            }
          }
          categoryId = categoryCache[categoryName];
        }

        const validTypes = ['veg', 'non_veg', 'vegan', 'egg'];
        const rawType = (row.food_type || row.type || 'veg').toLowerCase().trim();
        const foodType = validTypes.includes(rawType) ? rawType : 'veg';
        const isBestseller = ['true', 'yes', '1'].includes((row.is_bestseller || '').toLowerCase());
        const imageUrl = (row.image_url || row.image || '').trim() || null;
        const pricePaise = row.price_paise || Math.round(price * 100);
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
        const retailerId = row.retailer_id || `ZM-${branchId.slice(0, 6)}-${slug}`;
        const now = new Date();

        // Build product_tags from available data
        const csvTags = [];
        if (row['product_tags[0]'] || row.product_tag_0) csvTags.push(row['product_tags[0]'] || row.product_tag_0);
        if (row['product_tags[1]'] || row.product_tag_1) csvTags.push(row['product_tags[1]'] || row.product_tag_1);
        if (row.product_tags && Array.isArray(row.product_tags)) csvTags.push(...row.product_tags);

        await col('menu_items').updateOne(
          { retailer_id: retailerId },
          {
            $set: {
              branch_id: branchId,
              category_id: categoryId,
              name,
              description: (row.description || row.desc || '').trim() || null,
              price_paise: pricePaise,
              image_url: imageUrl,
              food_type: foodType,
              is_bestseller: isBestseller,
              // Meta 29-column fields
              item_group_id: row.item_group_id || null,
              size: row.size || null,
              sale_price_paise: row.sale_price_paise || null,
              sale_price_effective_date: row.sale_price_effective_date || null,
              brand: row.brand || null,
              google_product_category: row.google_product_category || 'Food, Beverages & Tobacco > Food Items',
              fb_product_category: row.fb_product_category || 'Food & Beverages > Prepared Food',
              link: row.link || null,
              quantity_to_sell_on_facebook: row.quantity_to_sell_on_facebook || null,
              product_tags: csvTags.length ? [...new Set(csvTags)] : [],
              gender: row.gender || null,
              color: row.color || null,
              age_group: row.age_group || null,
              material: row.material || null,
              pattern: row.pattern || null,
              shipping: row.shipping || null,
              shipping_weight: row.shipping_weight || null,
              video_url: row.video_url || row['video[0].url'] || null,
              video_tag: row.video_tag || row['video[0].tag[0]'] || null,
              gtin: row.gtin || null,
              style: row.style || row['style[0]'] || null,
              catalog_sync_status: 'pending',
              updated_at: now,
            },
            $setOnInsert: { _id: newId(), retailer_id: retailerId, is_available: true, sort_order: 0, catalog_synced_at: null, created_at: now },
          },
          { upsert: true }
        );
        results.added++;
      } catch (e) {
        results.errors.push(`Row ${rowNum} "${name}": ${e.message}`);
        results.skipped++;
      }
    }

    await col('restaurants').updateOne(
      { _id: req.restaurantId },
      [{ $set: { onboarding_step: { $max: ['$onboarding_step', 4] } } }]
    );

    // Auto-create product sets from tags/categories, then sync catalog
    catalog.autoCreateProductSets(branchId)
      .catch(err => console.error('[Menu] Auto-create sets after CSV upload failed:', err.message));
    catalog.syncBranchCatalog(branchId)
      .catch(err => console.error('[Menu] Auto-sync after CSV upload failed:', err.message));

    res.json({ success: true, ...results, total: items.length });

    log({ actorType: 'restaurant', actorId: String(req.restaurantId), actorName: req.restaurant?.business_name || 'Restaurant', action: 'menu.bulk_upload', category: 'menu', description: `Bulk uploaded menu items`, restaurantId: String(req.restaurantId), severity: 'info' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/restaurant/branches/:branchId/sync-catalog
router.post('/branches/:branchId/sync-catalog', requireApproved, async (req, res) => {
  try {
    const result = await catalog.syncBranchCatalog(req.params.branchId);
    res.json(result);

    log({
      actorType: 'restaurant', actorId: req.user?.id, actorName: req.user?.email || req.user?.phone,
      action: 'catalog.sync_triggered', category: 'catalog',
      description: `Catalog sync triggered for branch ${req.params.branchId}`,
      restaurantId: req.restaurantId || req.restaurant?._id,
      branchId: req.params.branchId,
      resourceType: 'branch', resourceId: req.params.branchId,
      severity: 'info',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/restaurant/branches/:branchId/sync-sets
router.post('/branches/:branchId/sync-sets', requireApproved, async (req, res) => {
  try {
    const result = await catalog.syncCategoryProductSets(req.params.branchId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/restaurant/branches/:branchId/fix-catalog
// Clears stale catalog_id and re-discovers/re-links the correct one from the WABA
router.post('/branches/:branchId/fix-catalog', async (req, res) => {
  try {
    const result = await catalog.rediscoverCatalog(req.params.branchId);
    res.json({ success: true, catalogId: result.catalogId, inherited: result.inherited || false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/restaurant/branches/:branchId/item-groups
router.get('/branches/:branchId/item-groups', async (req, res) => {
  try {
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
      const baseRetailerId = `${srcItem.retailer_id}-${baseLabel.toLowerCase().replace(/\s+/g, '-')}`;
      await col('menu_items').updateOne(
        { _id: srcItem._id },
        { $set: { item_group_id: groupId, variant_type: variantType, variant_value: baseLabel, retailer_id: baseRetailerId, updated_at: new Date() } }
      );
    }

    const baseName    = srcItem.name.replace(/\s*-\s*\S+$/, '').trim() || srcItem.name;
    const variantSlug = variantLabel.toLowerCase().replace(/\s+/g, '-');
    const retailerId  = `${srcItem.retailer_id.replace(/-regular$|-\S+$/, '')}-${variantSlug}`;
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

    catalog.syncBranchCatalog(srcItem.branch_id)
      .catch(err => console.error('[Variant] Auto-sync failed:', err.message));

    res.status(201).json(mapId(newItem));
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
        .catch(err => console.error('[ProductSets] Sync after create failed:', err.message));
    }

    res.status(201).json(mapId(set));

    log({ actorType: 'restaurant', actorId: String(req.restaurantId), actorName: req.restaurant?.business_name || 'Restaurant', action: 'product_set.created', category: 'catalog', description: `Product set created`, restaurantId: String(req.restaurantId), severity: 'info' });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
        .catch(err => console.error('[ProductSets] Sync after update failed:', err.message));
    }

    res.json(mapId(updated));
  } catch (e) { res.status(500).json({ error: e.message }); }
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
        console.warn(`[ProductSets] Meta delete failed (continuing): ${err.message}`);
      }
    }

    await col('product_sets').deleteOne({ _id: req.params.id });
    res.json({ success: true });

    log({ actorType: 'restaurant', actorId: String(req.restaurantId), actorName: req.restaurant?.business_name || 'Restaurant', action: 'product_set.deleted', category: 'catalog', description: `Product set deleted`, restaurantId: String(req.restaurantId), severity: 'info' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/restaurant/product-sets/auto-create — auto-create sets from menu categories/tags
router.post('/product-sets/auto-create', requirePermission('manage_menu'), async (req, res) => {
  try {
    const { branchId } = req.body;
    if (!branchId) return res.status(400).json({ error: 'branchId required' });
    const result = await catalog.autoCreateProductSets(branchId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/restaurant/product-sets/sync — sync all sets for a branch
router.post('/product-sets/sync', requirePermission('manage_menu'), async (req, res) => {
  try {
    const { branchId } = req.body;
    if (!branchId) return res.status(400).json({ error: 'branchId required' });
    const result = await catalog.syncProductSets(branchId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
        .catch(err => console.error('[Collections] Sync after create failed:', err.message));
    }

    res.status(201).json(mapId(doc));

    log({ actorType: 'restaurant', actorId: String(req.restaurantId), actorName: req.restaurant?.business_name || 'Restaurant', action: 'collection.created', category: 'catalog', description: `Collection created`, restaurantId: String(req.restaurantId), severity: 'info' });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
        .catch(err => console.error('[Collections] Sync after update failed:', err.message));
    }

    res.json(mapId(updated));
  } catch (e) { res.status(500).json({ error: e.message }); }
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
        console.warn(`[Collections] Meta delete failed (continuing): ${err.message}`);
      }
    }

    await col('catalog_collections').deleteOne({ _id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/restaurant/collections/auto-create
router.post('/collections/auto-create', requirePermission('manage_menu'), async (req, res) => {
  try {
    const { branchId } = req.body;
    if (!branchId) return res.status(400).json({ error: 'branchId required' });
    const result = await catalog.autoCreateCollections(branchId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/restaurant/collections/sync — sync all collections for a branch
router.post('/collections/sync', requirePermission('manage_menu'), async (req, res) => {
  try {
    const { branchId } = req.body;
    if (!branchId) return res.status(400).json({ error: 'branchId required' });
    const result = await catalog.syncCollections(branchId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// VARIANT HELPERS
// ═══════════════════════════════════════════════════════════════

// GET /api/restaurant/menu/variants/:itemGroupId — get all variants in a group
router.get('/menu/variants/:itemGroupId', async (req, res) => {
  try {
    const items = await col('menu_items').find({ item_group_id: req.params.itemGroupId }).sort({ sort_order: 1, price_paise: 1 }).toArray();
    res.json(mapIds(items));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/restaurant/menu/variant — add a variant to an existing product group
router.post('/menu/variant', requirePermission('manage_menu'), async (req, res) => {
  try {
    const { itemGroupId, branchId, name, size, priceRs, imageUrl } = req.body;
    if (!itemGroupId || !branchId || !size || !priceRs) {
      return res.status(400).json({ error: 'itemGroupId, branchId, size, priceRs required' });
    }

    // Auto-generate retailer_id from group + size
    const retailerId = `${itemGroupId}-${size.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`;

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

    // Trigger catalog sync
    catalog.syncBranchCatalog(branchId)
      .catch(err => console.error('[Variant] Auto-sync after add failed:', err.message));

    res.status(201).json(mapId(newItem));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/restaurant/branches/:branchId/create-catalog
router.post('/branches/:branchId/create-catalog', requireApproved, async (req, res) => {
  try {
    const result = await catalog.createBranchCatalog(req.params.branchId);

    if (result.alreadyExists) {
      return res.json({ success: true, message: 'Catalog already exists', catalogId: result.catalogId });
    }

    if (result.success) {
      catalog.syncBranchCatalog(req.params.branchId)
        .catch(err => console.error('[Branch] Auto-sync after catalog create failed:', err.message));
    }

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// CATALOG API — Meta Product Catalog management
// ═══════════════════════════════════════════════════════════════

// GET /api/restaurant/catalog/status — sync status for all branches
router.get('/catalog/status', async (req, res) => {
  try {
    const status = await catalog.getSyncStatus(req.restaurantId);
    res.json(status);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/restaurant/catalog/sync — full sync all branches
router.post('/catalog/sync', async (req, res) => {
  try {
    const results = await catalog.syncAllBranches(req.restaurantId);
    res.json({ success: true, results });

    log({
      actorType: 'restaurant', actorId: req.user?.id, actorName: req.user?.email || req.user?.phone,
      action: 'catalog.sync_triggered', category: 'catalog',
      description: 'Full catalog sync triggered for all branches',
      restaurantId: req.restaurantId || req.restaurant?._id,
      branchId: null,
      resourceType: 'restaurant', resourceId: req.restaurantId,
      severity: 'info',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/restaurant/catalog/products?branchId=... — list products in Meta catalog
router.get('/catalog/products', async (req, res) => {
  try {
    const { branchId } = req.query;
    if (!branchId) return res.status(400).json({ error: 'branchId required' });
    const result = await catalog.getCatalogProducts(branchId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/restaurant/catalog/product — add single item to catalog
router.post('/catalog/product', requirePermission('manage_menu'), async (req, res) => {
  try {
    const { menuItemId } = req.body;
    if (!menuItemId) return res.status(400).json({ error: 'menuItemId required' });
    const result = await catalog.addProduct(menuItemId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/restaurant/catalog/product/:id — update single item in catalog
router.put('/catalog/product/:id', requirePermission('manage_menu'), async (req, res) => {
  try {
    const result = await catalog.updateProduct(req.params.id);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/restaurant/catalog/product/:id — remove item from catalog
router.delete('/catalog/product/:id', requirePermission('manage_menu'), async (req, res) => {
  try {
    const item = await col('menu_items').findOne({ _id: req.params.id });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const result = await catalog.deleteProduct(item, item.branch_id);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/restaurant/catalogs — List available catalogs from Meta
router.get('/catalogs', async (req, res) => {
  try {
    const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
    const wa_acc = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurantId, is_active: true });

    if (!restaurant?.meta_user_id && !wa_acc?.waba_id) {
      return res.status(400).json({ error: 'Meta Business not connected. Complete WhatsApp setup first.' });
    }

    const catToken = metaConfig.catalogToken;
    if (!catToken) return res.status(500).json({ error: 'No Meta token configured. Please contact support.' });

    let catalogs = [];

    // Try WABA catalogs first
    if (wa_acc?.waba_id) {
      catalogs = await catalog.fetchWabaCatalogs(wa_acc.waba_id);
    }

    // If none found via WABA, try business catalogs
    if (!catalogs.length && restaurant?.meta_business_id) {
      catalogs = await catalog.fetchBusinessCatalogs(restaurant.meta_business_id);
    }

    // If still none, try business ID from env or Meta API
    if (!catalogs.length) {
      try {
        let bizId = metaConfig.businessId;
        if (!bizId) {
          const meRes = await require('axios').get(`${metaConfig.graphUrl}/me/businesses`, {
            params: { access_token: catToken, fields: 'id,name' }, timeout: 10000,
          });
          const businesses = meRes.data?.data || [];
          if (businesses.length) bizId = businesses[0].id;
        }
        if (bizId) {
          if (!restaurant.meta_business_id) {
            await col('restaurants').updateOne({ _id: req.restaurantId }, { $set: { meta_business_id: bizId } });
          }
          catalogs = await catalog.fetchBusinessCatalogs(bizId);
        }
      } catch (e) {
        console.warn('[Catalogs] Business lookup failed:', e.response?.data?.error?.message || e.message);
      }
    }

    // Update stored list
    if (catalogs.length) {
      await col('restaurants').updateOne(
        { _id: req.restaurantId },
        { $set: { meta_available_catalogs: catalogs, catalog_fetched_at: new Date() } }
      );
    }

    // Determine active catalog
    const activeCatalogId = restaurant?.meta_catalog_id || wa_acc?.catalog_id || null;

    res.json({ active_catalog_id: activeCatalogId, catalogs });
  } catch (e) {
    console.error('[Catalogs] Failed:', e.message);
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

    console.log(`[Catalog] Restaurant ${req.restaurantId} switched to catalog ${catalog_id}`);
    res.json({ success: true, catalog_id });
  } catch (e) {
    console.error('[Catalog] Switch failed:', e.message);
    res.status(500).json({ error: 'Failed to update catalog' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ORDERS — Restaurant views and manages orders
// ═══════════════════════════════════════════════════════════════

router.get('/orders', async (req, res) => {
  try {
    const { status, branchId, limit = 50, offset = 0 } = req.query;

    // Get all branch IDs for this restaurant
    const branchFilter = { restaurant_id: req.restaurantId };
    if (branchId) branchFilter._id = branchId;
    const branches = await col('branches').find(branchFilter).project({ _id: 1 }).toArray();
    const branchIds = branches.map(b => String(b._id));

    const filter = { branch_id: { $in: branchIds } };
    if (status) filter.status = status;

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
        wa_phone:      customer?.wa_phone || customer?.bsuid || '',
        branch_name:   branch?.name,
        items:         mapIds(items),
      };
    }));

    res.json(enriched);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
      wa_phone:      customer?.wa_phone || customer?.bsuid || '',
      branch_name:   branch?.name,
      items:         mapIds(items),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

    // Recalculate ETA on status change
    let etaResult = null;
    try { etaResult = await etaSvc.updateETAOnStatusChange(req.params.orderId, status); }
    catch (e) { console.warn('[ETA] update error:', e.message); }

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

    // Fire-and-forget manager notification
    if (order) {
      const fullOrderForNotify = await orderSvc.getOrderDetails(order.id);
      if (fullOrderForNotify) {
        notify.notifyOrderStatusChange(fullOrderForNotify, req.body._oldStatus || '', status)
          .catch(err => console.error('[Notify]', err.message));
      }
    }

    res.json({ success: true, order, eta: etaResult });

    log({
      actorType: 'restaurant', actorId: req.user?.id, actorName: req.user?.email || req.user?.phone,
      action: 'order.status_changed', category: 'order',
      description: `Order ${req.params.orderId} status changed from ${req.body._oldStatus || 'unknown'} to ${status}`,
      restaurantId: req.restaurantId || req.restaurant?._id,
      branchId: order?.branch_id || null,
      resourceType: 'order', resourceId: req.params.orderId,
      severity: 'info',
      metadata: { oldStatus: req.body._oldStatus || null, newStatus: status },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// 3PL DELIVERY MANAGEMENT
// ═══════════════════════════════════════════════════════════════

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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
        { $match: { ...baseMatch, created_at: { $gte: since }, status: { $ne: 'CANCELLED' } } },
        { $group: { _id: null, total: { $sum: 1 }, revenue: { $sum: { $toDouble: '$total_rs' } } } },
      ]).toArray(),
      col('orders').aggregate([
        { $match: { ...baseMatch, created_at: { $gte: prevSince, $lt: since }, status: { $ne: 'CANCELLED' } } },
        { $group: { _id: null, total: { $sum: 1 }, revenue: { $sum: { $toDouble: '$total_rs' } } } },
      ]).toArray(),
      col('orders').aggregate([
        { $match: { ...baseMatch, created_at: { $gte: since } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]).toArray(),
      col('orders').aggregate([
        { $match: { ...baseMatch, created_at: { $gte: since }, status: { $ne: 'CANCELLED' } } },
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
      { $match: { branch_id: { $in: branchIds }, created_at: { $gte: since }, status: { $ne: 'CANCELLED' } } },
      { $group: { _id: dateExpr, revenue_rs: { $sum: { $toDouble: '$total_rs' } }, order_count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: '$_id', revenue_rs: { $round: ['$revenue_rs', 2] }, order_count: 1 } },
    ]).toArray();

    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/restaurant/analytics/top-items
router.get('/analytics/top-items', requirePermission('view_analytics'), async (req, res) => {
  try {
    const { branchIds, since } = await _analyticsContext(req);
    const limit = Math.min(20, parseInt(req.query.limit) || 10);

    // Get order IDs in range
    const orderIds = await col('orders').distinct('_id', {
      branch_id: { $in: branchIds }, created_at: { $gte: since }, status: { $ne: 'CANCELLED' },
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/restaurant/analytics/peak-hours
router.get('/analytics/peak-hours', requirePermission('view_analytics'), async (req, res) => {
  try {
    const { branchIds, since } = await _analyticsContext(req);

    const [hourly, daily] = await Promise.all([
      col('orders').aggregate([
        { $match: { branch_id: { $in: branchIds }, created_at: { $gte: since }, status: { $ne: 'CANCELLED' } } },
        { $group: { _id: { $hour: '$created_at' }, order_count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
        { $project: { _id: 0, hour: '$_id', order_count: 1 } },
      ]).toArray(),
      col('orders').aggregate([
        { $match: { branch_id: { $in: branchIds }, created_at: { $gte: since }, status: { $ne: 'CANCELLED' } } },
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/restaurant/analytics/customers
router.get('/analytics/customers', requirePermission('view_analytics'), async (req, res) => {
  try {
    const { branchIds, since } = await _analyticsContext(req);
    const baseMatch = { branch_id: { $in: branchIds }, created_at: { $gte: since }, status: { $ne: 'CANCELLED' } };

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
        wa_phone: custMap[c._id]?.wa_phone || custMap[c._id]?.bsuid || '',
        order_count: c.order_count,
        total_spent_rs: +c.total_spent.toFixed(2),
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
        { $match: { branch_id: { $in: branchIds }, created_at: { $gte: since }, status: { $ne: 'CANCELLED' } } },
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── COUPONS ──────────────────────────────────────────────────

router.get('/coupons', async (req, res) => {
  try {
    const docs = await col('coupons').find({ restaurant_id: req.restaurantId }).sort({ created_at: -1 }).toArray();
    res.json(mapIds(docs));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/coupons', requirePermission('manage_coupons'), express.json(), async (req, res) => {
  try {
    const { code, description, discountType, discountValue, minOrderRs, maxDiscountRs, usageLimit, validFrom, validUntil } = req.body;
    if (!code || !discountType || !discountValue)
      return res.status(400).json({ error: 'code, discountType and discountValue are required' });
    if (!['percent', 'flat'].includes(discountType))
      return res.status(400).json({ error: 'discountType must be percent or flat' });
    if (discountType === 'percent' && parseFloat(discountValue) > 100)
      return res.status(400).json({ error: 'Percent discount cannot exceed 100' });

    const couponCode = code.trim().toUpperCase();
    // Check uniqueness
    const existing = await col('coupons').findOne({ restaurant_id: req.restaurantId, code: couponCode });
    if (existing) return res.status(409).json({ error: 'Coupon code already exists' });

    const now = new Date();
    const coupon = {
      _id: newId(),
      restaurant_id: req.restaurantId,
      code: couponCode,
      description: description || null,
      discount_type: discountType,
      discount_value: parseFloat(discountValue),
      min_order_rs: minOrderRs || 0,
      max_discount_rs: maxDiscountRs || null,
      usage_limit: usageLimit || null,
      usage_count: 0,
      valid_from: validFrom ? new Date(validFrom) : null,
      valid_until: validUntil ? new Date(validUntil) : null,
      is_active: true,
      created_at: now,
      updated_at: now,
    };
    await col('coupons').insertOne(coupon);
    res.json(mapId(coupon));
  } catch (e) {
    res.status(500).json({ error: e.message });
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/coupons/:id', requirePermission('manage_coupons'), async (req, res) => {
  try {
    const result = await col('coupons').deleteOne({ _id: req.params.id, restaurant_id: req.restaurantId });
    if (!result.deletedCount) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    const apiErr = e.response?.data?.error?.message;
    res.status(500).json({ error: apiErr || e.message });
  }
});

// GET /api/restaurant/whatsapp/template-defaults — global admin-level defaults
router.get('/whatsapp/template-defaults', async (req, res) => {
  try {
    const defaults = await col('template_mappings').find({ is_active: true }).toArray();
    res.json(mapIds(defaults));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/restaurant/whatsapp/template-mappings
router.get('/whatsapp/template-mappings', async (req, res) => {
  try {
    const docs = await col('whatsapp_template_mappings').find({ restaurant_id: req.restaurantId }).toArray();
    res.json(mapIds(docs));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/restaurant/whatsapp/template-mappings
router.put('/whatsapp/template-mappings', requireApproved, express.json(), async (req, res) => {
  try {
    const mappings = req.body;
    if (!Array.isArray(mappings)) return res.status(400).json({ error: 'Array of mappings required' });

    for (const m of mappings) {
      const { eventName, templateName, templateLanguage, variableMap } = m;
      if (!eventName || !templateName) continue;
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
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/restaurant/whatsapp/template-mappings/:eventName
router.delete('/whatsapp/template-mappings/:eventName', requireApproved, async (req, res) => {
  try {
    await col('whatsapp_template_mappings').deleteOne({
      restaurant_id: req.restaurantId,
      event_name: req.params.eventName.toUpperCase(),
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
      console.error(`[WA] orderNotify failed for ${status}, trying legacy:`, e.message);
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
      console.error(`[WA] Template send failed for ${status} (${template_name}), falling back to text:`, e.message);
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

    const catToken = metaConfig.catalogToken || wa_acc?.access_token;
    if (!catToken) return res.status(400).json({ error: 'No Meta token configured. Please contact support.' });

    // Generate or reuse feed token
    let feedToken = restaurant.catalog_feed_token;
    if (!feedToken) {
      feedToken = crypto.randomBytes(24).toString('hex');
      await col('restaurants').updateOne({ _id: req.restaurantId }, { $set: { catalog_feed_token: feedToken } });
    }

    const baseUrl = process.env.BASE_URL || 'https://gully-bite.vercel.app';
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
        console.warn('[Feed] Existing feed update failed, creating new:', e.response?.data?.error?.message || e.message);
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
    console.error('[Feed] Register failed:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
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
        params: { access_token: metaConfig.catalogToken || wa_acc?.access_token, limit: 1, fields: 'end_time,num_detected_items,num_invalid_items,url' },
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// CUSTOMERS — Order history per customer
// ═══════════════════════════════════════════════════════════════

// GET /api/restaurant/customers — list customers who ordered from this restaurant
router.get('/customers', async (req, res) => {
  try {
    const { search, limit = 50, offset = 0 } = req.query;

    const branches   = await col('branches').find({ restaurant_id: req.restaurantId }, { projection: { _id: 1 } }).toArray();
    const branchIds  = branches.map(b => String(b._id));

    // Get unique customer IDs from orders
    const orderFilter = { branch_id: { $in: branchIds } };
    const customerIds = await col('orders').distinct('customer_id', orderFilter);

    const customerFilter = { _id: { $in: customerIds } };
    if (search) {
      customerFilter.$or = [
        { name    : { $regex: search, $options: 'i' } },
        { wa_phone: { $regex: search, $options: 'i' } },
        { bsuid   : { $regex: search, $options: 'i' } },
      ];
    }

    const customers = await col('customers')
      .find(customerFilter)
      .sort({ last_order_at: -1, created_at: -1 })
      .skip(parseInt(offset))
      .limit(parseInt(limit))
      .toArray();

    res.json(customers.map(c => ({
      id          : String(c._id),
      name        : c.name,
      wa_phone    : c.wa_phone || c.bsuid || '',
      total_orders: c.total_orders || 0,
      total_spent : c.total_spent_rs || 0,
      last_order_at: c.last_order_at,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
        items       : items.map(i => ({ name: i.name, qty: i.quantity || i.qty || 1, price: i.unit_price_rs })),
      };
    }));

    res.json(enriched);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
      food_rating:    r.food_rating,
      delivery_rating:r.delivery_rating,
      comment:        r.comment,
      created_at:     r.created_at,
    }));

    res.json({ ratings: enriched, total, page, pages: Math.ceil(total / limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
      return res.json({ avg_food: 0, avg_delivery: 0, total: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
    }

    const sumFood     = allRatings.reduce((s, r) => s + (r.food_rating || 0), 0);
    const sumDelivery = allRatings.reduce((s, r) => s + (r.delivery_rating || 0), 0);
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of allRatings) {
      const star = Math.max(1, Math.min(5, r.food_rating || 3));
      distribution[star] = (distribution[star] || 0) + 1;
    }

    res.json({
      avg_food:     +(sumFood / total).toFixed(1),
      avg_delivery: +(sumDelivery / total).toFixed(1),
      total,
      distribution,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// LOYALTY
// ═══════════════════════════════════════════════════════════════

// GET /api/restaurant/loyalty/stats
router.get('/loyalty/stats', requireApproved, async (req, res) => {
  try {
    const allLoyalty = await col('loyalty_points').find({ restaurant_id: req.restaurantId }).toArray();
    const total = allLoyalty.length;
    const totalBalance = allLoyalty.reduce((s, l) => s + (l.points_balance || 0), 0);
    const totalLifetime = allLoyalty.reduce((s, l) => s + (l.lifetime_points || 0), 0);

    const tierCounts = { bronze: 0, silver: 0, gold: 0, platinum: 0 };
    for (const l of allLoyalty) { tierCounts[l.tier] = (tierCounts[l.tier] || 0) + 1; }

    // Points redeemed (sum of negative transactions)
    const redeemTx = await col('loyalty_transactions')
      .find({ restaurant_id: req.restaurantId, type: 'redeem' })
      .toArray();
    const totalRedeemed = redeemTx.reduce((s, t) => s + Math.abs(t.points || 0), 0);

    res.json({
      total_members: total,
      total_points_issued: totalLifetime,
      total_points_redeemed: totalRedeemed,
      total_points_balance: totalBalance,
      tiers: tierCounts,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/restaurant/loyalty/customers
router.get('/loyalty/customers', requireApproved, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const skip  = (page - 1) * limit;

    const [docs, total] = await Promise.all([
      col('loyalty_points')
        .find({ restaurant_id: req.restaurantId })
        .sort({ lifetime_points: -1 })
        .skip(skip).limit(limit).toArray(),
      col('loyalty_points').countDocuments({ restaurant_id: req.restaurantId }),
    ]);

    const customerIds = docs.map(d => d.customer_id).filter(Boolean);
    const customers = customerIds.length
      ? await col('customers').find({ _id: { $in: customerIds } }).toArray()
      : [];
    const custMap = Object.fromEntries(customers.map(c => [String(c._id), c]));

    const enriched = docs.map(d => {
      const c = custMap[d.customer_id] || {};
      return {
        id: String(d._id),
        customer_name: c.name || 'Unknown',
        wa_phone: c.wa_phone || c.bsuid || '',
        points_balance: d.points_balance,
        lifetime_points: d.lifetime_points,
        tier: d.tier,
        total_orders: c.total_orders || 0,
        total_spent_rs: c.total_spent_rs || 0,
        last_order_at: c.last_order_at,
      };
    });

    res.json({ customers: enriched, total, page, pages: Math.ceil(total / limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
      role,
      branch_ids: branchIds || [],
      permissions,
      is_active: true,
      last_login_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    res.json({ id, name, phone, role, permissions });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

    await col('restaurant_users').updateOne({ _id: req.params.id }, { $set });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/restaurant/users/:id (soft-delete)
router.delete('/users/:id', requirePermission('manage_users'), async (req, res) => {
  try {
    const user = await col('restaurant_users').findOne({ _id: req.params.id, restaurant_id: req.restaurantId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'owner') return res.status(403).json({ error: 'Cannot delete owner account' });
    if (req.userId && req.params.id === req.userId) return res.status(400).json({ error: 'Cannot delete yourself' });

    await col('restaurant_users').updateOne({ _id: req.params.id }, { $set: { is_active: false, updated_at: new Date() } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    await col('restaurant_users').updateOne({ _id: req.params.id }, { $set: { pin_hash: pinHash, updated_at: new Date() } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// CAMPAIGNS (MPM Marketing)
// ═══════════════════════════════════════════════════════════════

const campaignSvc = require('../services/campaigns');

router.get('/campaigns', async (req, res) => {
  try {
    const docs = await campaignSvc.getCampaigns(req.restaurantId);
    res.json(mapIds(docs));
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
        console.warn(`[WhatsApp2026] Messaging status fetch:`, err.response?.data?.error?.message || err.message);
      }
    }

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── [WhatsApp2026] MESSAGE STATS ────────────────────────────
// GET /messaging/stats?from=2026-03-01&to=2026-03-31
router.get('/messaging/stats', requireAuth, requireApproved, async (req, res) => {
  try {
    const msgTracking = require('../services/messageTracking');
    const stats = await msgTracking.getMessageStats(req.restaurant._id, {
      from: req.query.from,
      to: req.query.to,
    });
    res.json(stats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /messaging/costs?from=...&to=...
router.get('/messaging/costs', requireAuth, requireApproved, async (req, res) => {
  try {
    const msgTracking = require('../services/messageTracking');
    const [breakdown, trend] = await Promise.all([
      msgTracking.getCostBreakdown(req.restaurant._id, { from: req.query.from, to: req.query.to }),
      msgTracking.getDailyCostTrend(req.restaurant._id, parseInt(req.query.days) || 30),
    ]);
    res.json({ breakdown, trend });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── [WhatsApp2026] ACCOUNT QUALITY & HEALTH ────────────────
// GET /messaging/health
router.get('/messaging/health', requireAuth, requireApproved, async (req, res) => {
  try {
    const msgTracking = require('../services/messageTracking');
    const [latest, history] = await Promise.all([
      msgTracking.getLatestHealth(req.restaurant._id),
      msgTracking.getHealthHistory(req.restaurant._id, 10),
    ]);
    res.json({ latest, history });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /messaging/health/check — trigger a fresh quality check
router.post('/messaging/health/check', requireAuth, requireApproved, async (req, res) => {
  try {
    const msgTracking = require('../services/messageTracking');
    const waAcc = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurant._id, is_active: true });
    if (!waAcc) return res.status(404).json({ error: 'No active WhatsApp account' });

    const token = metaConfig.systemUserToken || waAcc.access_token;
    const result = await msgTracking.checkAccountQuality(waAcc.phone_number_id, token, req.restaurant._id);
    if (!result) return res.status(502).json({ error: 'Failed to fetch quality from Meta' });

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// MESSAGES INBOX
// ═══════════════════════════════════════════════════════════════

const customerIdentity = require('../services/customerIdentity');
const { logActivity } = require('../services/activityLog');

// GET /api/restaurant/messages — inbox threads (grouped by customer)
router.get('/messages', requireAuth, requireApproved, async (req, res) => {
  try {
    const restId = req.restaurant._id;
    const { status, customer_id, search, page = 1, limit = 30 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    if (customer_id) {
      // Thread view — all messages with this customer
      const match = { restaurant_id: restId, customer_id };
      const msgs = await col('customer_messages').find(match)
        .sort({ created_at: 1 }).toArray();
      // Mark unread as read
      const unreadIds = msgs.filter(m => m.status === 'unread' && m.direction === 'inbound').map(m => m._id);
      if (unreadIds.length) {
        await col('customer_messages').updateMany(
          { _id: { $in: unreadIds } },
          { $set: { status: 'read', read_at: new Date(), read_by: req.user?.email || req.user?.phone || null, updated_at: new Date() } }
        );
      }
      return res.json({ messages: msgs.map(m => ({ ...m, id: String(m._id) })) });
    }

    // Threads overview — aggregate latest message per customer
    const match = { restaurant_id: restId };
    if (status && status !== 'all') match.status = status;
    if (search) match.$or = [
      { text: { $regex: search, $options: 'i' } },
      { customer_name: { $regex: search, $options: 'i' } },
      { customer_phone: { $regex: search, $options: 'i' } },
    ];

    const threads = await col('customer_messages').aggregate([
      { $match: { restaurant_id: restId, ...(status && status !== 'all' ? {} : {}) } },
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
      customer_phone: t.customer_phone,
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/restaurant/messages/thread/:customer_id — full thread
router.get('/messages/thread/:customer_id', requireAuth, requireApproved, async (req, res) => {
  try {
    const restId = req.restaurant._id;
    const msgs = await col('customer_messages')
      .find({ restaurant_id: restId, customer_id: req.params.customer_id })
      .sort({ created_at: 1 }).toArray();

    // Mark unread inbound as read
    const unreadIds = msgs.filter(m => m.status === 'unread' && m.direction === 'inbound').map(m => m._id);
    if (unreadIds.length) {
      await col('customer_messages').updateMany(
        { _id: { $in: unreadIds } },
        { $set: { status: 'read', read_at: new Date(), read_by: req.user?.email || req.user?.phone || null, updated_at: new Date() } }
      );
    }

    res.json({ messages: msgs.map(m => ({ ...m, id: String(m._id) })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/restaurant/messages/unread-count
router.get('/messages/unread-count', requireAuth, requireApproved, async (req, res) => {
  try {
    const count = await col('customer_messages').countDocuments({
      restaurant_id: req.restaurant._id,
      direction: 'inbound',
      status: 'unread',
    });
    res.json({ count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/restaurant/messages/:id/status — update status
router.put('/messages/:id/status', requireAuth, requireApproved, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['read', 'replied', 'resolved'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const $set = { status, updated_at: new Date() };
    if (status === 'read') { $set.read_at = new Date(); $set.read_by = req.user?.email || req.user?.phone || null; }
    if (status === 'resolved') { $set.resolved_at = new Date(); $set.resolved_by = req.user?.email || req.user?.phone || null; }
    await col('customer_messages').updateOne(
      { _id: req.params.id, restaurant_id: req.restaurant._id },
      { $set }
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/restaurant/messages/thread/:customer_id/resolve — resolve entire thread
router.put('/messages/thread/:customer_id/resolve', requireAuth, requireApproved, async (req, res) => {
  try {
    const now = new Date();
    await col('customer_messages').updateMany(
      { restaurant_id: req.restaurant._id, customer_id: req.params.customer_id, status: { $ne: 'resolved' } },
      { $set: { status: 'resolved', resolved_at: now, resolved_by: req.user?.email || req.user?.phone || null, updated_at: now } }
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/restaurant/messages/reply — send reply to customer
router.post('/messages/reply', requireAuth, requireApproved, async (req, res) => {
  try {
    const { customer_id, text, reply_to_message_id } = req.body;
    if (!customer_id || !text?.trim()) return res.status(400).json({ error: 'customer_id and text required' });

    const restId = req.restaurant._id;

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
      replied_by: req.user?.email || req.user?.phone || null,
      resolved_at: null,
      resolved_by: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    await col('customer_messages').insertOne(msgDoc);

    // Mark thread as replied
    await col('customer_messages').updateMany(
      { restaurant_id: restId, customer_id, direction: 'inbound', status: { $in: ['unread', 'read'] } },
      { $set: { status: 'replied', replied_at: new Date(), replied_by: req.user?.email || req.user?.phone || null, updated_at: new Date() } }
    );

    logActivity({
      actorType: 'restaurant', actorId: req.user?.id, actorName: req.user?.email || req.user?.phone,
      action: 'message.replied', category: 'messages',
      description: `Replied to customer ${customer.name || customer.wa_phone}: "${text.substring(0, 60)}"`,
      restaurantId: restId, resourceType: 'customer_message', resourceId: String(msgDoc._id),
      severity: 'info',
    });

    res.json({ ...msgDoc, id: String(msgDoc._id), wa_message_id: wamId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/restaurant/messages/media/:media_id — resolve Meta media URL
router.get('/messages/media/:media_id', requireAuth, requireApproved, async (req, res) => {
  try {
    const waAcc = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurant._id, is_active: true });
    if (!waAcc) return res.status(400).json({ error: 'No WhatsApp account' });
    const token = metaConfig.systemUserToken || waAcc.access_token;
    const { data } = await axios.get(
      `https://graph.facebook.com/${process.env.WA_API_VERSION}/${req.params.media_id}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
    );
    res.json({ url: data.url, mime_type: data.mime_type });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ISSUES ──────────────────────────────────────────────────────────

// GET /api/restaurant/issues — list issues for this restaurant
router.get('/issues', requireAuth, requireApproved, async (req, res) => {
  try {
    const { status, category, priority, search, page = 1, limit = 30 } = req.query;
    const result = await issueSvc.listIssues(
      { restaurantId: req.restaurant._id, status, category, priority, search },
      { page: parseInt(page), limit: parseInt(limit) }
    );
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/restaurant/issues/stats — issue stats for this restaurant
router.get('/issues/stats', requireAuth, requireApproved, async (req, res) => {
  try {
    const stats = await issueSvc.getIssueStats({ restaurantId: req.restaurant._id });
    res.json(stats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/restaurant/issues/:id — single issue detail
router.get('/issues/:id', requireAuth, requireApproved, async (req, res) => {
  try {
    const issue = await issueSvc.getIssue(req.params.id);
    if (!issue || issue.restaurant_id !== req.restaurant._id) return res.status(404).json({ error: 'Issue not found' });
    res.json(issue);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
      restaurantId: req.restaurant._id,
      branchId: order?.branch_id || null,
      category,
      subcategory,
      description,
      media: media || [],
      source: 'dashboard',
    });

    // Send WhatsApp notification to customer
    try {
      const waAccount = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurant._id });
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

    res.status(201).json(issue);

    log({ actorType: 'restaurant', actorId: String(req.restaurant._id), actorName: req.restaurant.business_name, action: 'issue.created', category: 'issue', description: `Issue created by ${req.restaurant.business_name}`, restaurantId: String(req.restaurant._id), severity: 'info' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/restaurant/issues/:id/status — update issue status
router.put('/issues/:id/status', requireAuth, requireApproved, async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status required' });
    const issue = await issueSvc.getIssue(req.params.id);
    if (!issue || issue.restaurant_id !== req.restaurant._id) return res.status(404).json({ error: 'Issue not found' });

    const updated = await issueSvc.updateStatus(req.params.id, status, {
      actorType: 'restaurant', actorName: req.restaurant.business_name || 'Restaurant',
      actorId: req.restaurant._id,
    });

    // Notify customer for key transitions
    try {
      if (['assigned', 'in_progress', 'resolved'].includes(status)) {
        const waAccount = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurant._id });
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

    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/restaurant/issues/:id/message — add message to issue thread
router.post('/issues/:id/message', requireAuth, requireApproved, async (req, res) => {
  try {
    const { text, internal } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });
    const issue = await issueSvc.getIssue(req.params.id);
    if (!issue || issue.restaurant_id !== req.restaurant._id) return res.status(404).json({ error: 'Issue not found' });

    const msg = await issueSvc.addMessage(req.params.id, {
      senderType: 'restaurant',
      senderName: req.restaurant.business_name || 'Restaurant',
      text, internal: !!internal, sentVia: 'dashboard',
    });

    // Send to customer via WhatsApp (unless internal)
    if (!internal) {
      try {
        const waAccount = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurant._id });
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/restaurant/issues/:id/escalate — escalate to admin
router.post('/issues/:id/escalate', requireAuth, requireApproved, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'reason required' });
    const issue = await issueSvc.getIssue(req.params.id);
    if (!issue || issue.restaurant_id !== req.restaurant._id) return res.status(404).json({ error: 'Issue not found' });

    // Determine escalation target
    let routeTo = 'admin';
    if (['wrong_charge', 'refund_request', 'payment_failed', 'coupon_issue'].includes(issue.category)) routeTo = 'admin_financial';
    if (['delivery_late', 'delivery_not_received', 'delivery_damaged', 'rider_behavior', 'wrong_address'].includes(issue.category)) routeTo = 'admin_delivery';

    const updated = await issueSvc.escalateToAdmin(req.params.id, {
      escalatedBy: req.restaurant._id,
      reason,
      routeTo,
    });

    // Notify customer
    try {
      const waAccount = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurant._id });
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

    res.json(updated);

    log({ actorType: 'restaurant', actorId: String(req.restaurant._id), actorName: req.restaurant.business_name, action: 'issue.escalated', category: 'issue', description: `Issue escalated to admin by ${req.restaurant.business_name}`, restaurantId: String(req.restaurant._id), severity: 'warning' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/restaurant/issues/:id/resolve — resolve issue
router.post('/issues/:id/resolve', requireAuth, requireApproved, async (req, res) => {
  try {
    const { resolution_type, resolution_notes } = req.body;
    const issue = await issueSvc.getIssue(req.params.id);
    if (!issue || issue.restaurant_id !== req.restaurant._id) return res.status(404).json({ error: 'Issue not found' });

    const updated = await issueSvc.resolveIssue(req.params.id, {
      resolutionType: resolution_type || 'no_action',
      resolutionNotes: resolution_notes || null,
      actorType: 'restaurant', actorName: req.restaurant.business_name || 'Restaurant',
      actorId: req.restaurant._id,
    });

    // Notify customer
    try {
      const waAccount = await col('whatsapp_accounts').findOne({ restaurant_id: req.restaurant._id });
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

    res.json(updated);

    log({ actorType: 'restaurant', actorId: String(req.restaurant._id), actorName: req.restaurant.business_name, action: 'issue.resolved', category: 'issue', description: `Issue resolved by ${req.restaurant.business_name}`, restaurantId: String(req.restaurant._id), severity: 'info' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/restaurant/issues/:id/reopen — reopen resolved issue
router.post('/issues/:id/reopen', requireAuth, requireApproved, async (req, res) => {
  try {
    const issue = await issueSvc.getIssue(req.params.id);
    if (!issue || issue.restaurant_id !== req.restaurant._id) return res.status(404).json({ error: 'Issue not found' });

    const updated = await issueSvc.reopenIssue(req.params.id, {
      actorType: 'restaurant', actorName: req.restaurant.business_name || 'Restaurant',
      actorId: req.restaurant._id, reason: req.body.reason,
    });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── FINANCIAL ENDPOINTS ────────────────────────────────────────

// GET /api/restaurant/financials/summary
router.get('/financials/summary', requireAuth, requireApproved, async (req, res) => {
  try {
    const { period, from, to } = req.query;
    const summary = await financials.getFinancialSummary(req.restaurantId, period || '30d', from, to);
    res.json(summary);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/restaurant/financials/settlements/:id
router.get('/financials/settlements/:id', requireAuth, requireApproved, async (req, res) => {
  try {
    const settlement = await col('settlements').findOne({ _id: req.params.id, restaurant_id: req.restaurantId });
    if (!settlement) return res.status(404).json({ error: 'Settlement not found' });
    // Fetch orders for this settlement
    const orders = await col('orders').find({ settlement_id: req.params.id }).sort({ created_at: 1 }).toArray();
    res.json({ settlement, orders });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/restaurant/financials/payments
router.get('/financials/payments', requireAuth, requireApproved, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const skip = (page - 1) * limit;
    const { from, to, status } = req.query;
    const branches = await col('branches').find({ restaurant_id: req.restaurantId }).project({ _id: 1 }).toArray();
    const branchIds = branches.map(b => String(b._id));
    // Get order IDs for this restaurant
    const orderMatch = { branch_id: { $in: branchIds } };
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/restaurant/financials/tax-summary
router.get('/financials/tax-summary', requireAuth, requireApproved, async (req, res) => {
  try {
    const summary = await financials.getTaxSummary(req.restaurantId, req.query.fy);
    res.json(summary);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
