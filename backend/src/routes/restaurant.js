// src/routes/restaurant.js
// REST API for the restaurant owner dashboard
// Protected by JWT — all routes require login

const express = require('express');
const router = express.Router();
const multer = require('multer');
const axios  = require('axios');
const { col, newId, mapId, mapIds, getBucket } = require('../config/database');
const { Readable } = require('stream');
const { requireAuth, requireApproved } = require('./auth');
const catalog = require('../services/catalog');
const orderSvc = require('../services/order');
const wa = require('../services/whatsapp');

// ── Image upload via MongoDB GridFS ───────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits : { fileSize: 5 * 1024 * 1024 }, // 5 MB max
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
router.put('/', async (req, res) => {
  try {
    const {
      businessName, registeredBusinessName, ownerName, phone, city,
      restaurantType, logoUrl, gstNumber, fssaiLicense, fssaiExpiry,
      bankName, bankAccountNumber, bankIfsc,
      menuGstMode, deliveryFeeCustomerPct, packagingChargeRs, packagingGstPct,
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

    await col('restaurants').updateOne(
      { _id: req.restaurantId },
      [{ $set: { ...$set, onboarding_step: { $max: ['$onboarding_step', 2] } } }]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// IMAGE UPLOAD
// ═══════════════════════════════════════════════════════════════

// POST /api/restaurant/menu/upload-image
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
    res.status(500).json({ error: `Image upload failed: ${err.message}` });
  }
});

// ═══════════════════════════════════════════════════════════════
// WHATSAPP ACCOUNTS
// ═══════════════════════════════════════════════════════════════

router.get('/whatsapp', async (req, res) => {
  try {
    const docs = await col('whatsapp_accounts').find({ restaurant_id: req.restaurantId }).toArray();
    res.json(mapIds(docs).map(d => {
      const { _id, access_token, meta_access_token, ...rest } = d;
      return rest;
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/restaurant/whatsapp/:id/provision-catalog
// Manually trigger catalog creation + cart icon enablement for a WABA
router.post('/whatsapp/:id/provision-catalog', async (req, res) => {
  try {
    const wa = await col('whatsapp_accounts').findOne({ _id: req.params.id, restaurant_id: req.restaurantId });
    if (!wa) return res.status(404).json({ error: 'WhatsApp account not found' });
    if (!wa.access_token) return res.status(400).json({ error: 'No access token — please reconnect your Meta account' });

    const { _provisionWabaCatalog } = require('./auth');
    await _provisionWabaCatalog(req.restaurantId, wa.waba_id, wa.access_token);

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

router.patch('/branches/:id', async (req, res) => {
  try {
    const { isOpen, acceptsOrders, deliveryRadiusKm, catalogId, deliveryFeeRs } = req.body;
    const $set = {};
    if (isOpen             !== undefined) $set.is_open            = isOpen;
    if (acceptsOrders      !== undefined) $set.accepts_orders     = acceptsOrders;
    if (deliveryRadiusKm   !== undefined) $set.delivery_radius_km = deliveryRadiusKm;
    if (catalogId          !== undefined) $set.catalog_id         = catalogId;
    if (deliveryFeeRs      !== undefined) $set.delivery_fee_rs    = deliveryFeeRs;
    await col('branches').updateOne(
      { _id: req.params.id, restaurant_id: req.restaurantId },
      { $set }
    );
    res.json({ success: true });
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
    const catId = newId();
    const now = new Date();
    const cat = { _id: catId, branch_id: req.params.branchId, name, description: description || null, sort_order: sortOrder || 0, created_at: now };
    await col('menu_categories').insertOne(cat);
    res.status(201).json(mapId(cat));
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

router.post('/branches/:branchId/menu', async (req, res) => {
  try {
    const {
      name, description, priceRs, categoryId, foodType, imageUrl,
      isBestseller, sortOrder,
      itemGroupId, variantType, variantValue,
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/menu/:itemId', async (req, res) => {
  try {
    const { name, description, priceRs, imageUrl, isAvailable, isBestseller,
            itemGroupId, variantType, variantValue } = req.body;

    const onlyAvailability = isAvailable !== undefined &&
      name === undefined && description === undefined && priceRs === undefined &&
      imageUrl === undefined && isBestseller === undefined &&
      itemGroupId === undefined && variantType === undefined && variantValue === undefined;

    if (onlyAvailability) {
      catalog.setItemAvailability(req.params.itemId, isAvailable)
        .catch(err => console.error('[Menu] Availability sync failed:', err.message));
      return res.json({ success: true });
    }

    const $set = { updated_at: new Date() };
    if (name        !== undefined) $set.name          = name;
    if (description !== undefined) $set.description   = description;
    if (priceRs     !== undefined) $set.price_paise   = Math.round(parseFloat(priceRs) * 100);
    if (imageUrl    !== undefined) $set.image_url     = imageUrl;
    if (isBestseller!== undefined) $set.is_bestseller = isBestseller;
    if (itemGroupId !== undefined) $set.item_group_id = itemGroupId || null;
    if (variantType !== undefined) $set.variant_type  = variantType || null;
    if (variantValue!== undefined) $set.variant_value = variantValue || null;
    if (isAvailable !== undefined) $set.is_available  = isAvailable;

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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/menu/:itemId', async (req, res) => {
  try {
    const item = await col('menu_items').findOne({ _id: req.params.itemId });
    await col('menu_items').deleteOne({ _id: req.params.itemId });

    if (item) {
      const branch = await col('branches').findOne({ _id: item.branch_id });
      const wa_acc = branch
        ? await col('whatsapp_accounts').findOne({ restaurant_id: branch.restaurant_id, is_active: true })
        : null;
      const catalog_id   = branch?.catalog_id;
      const retailer_id  = item.retailer_id;
      const access_token = wa_acc?.access_token;
      if (catalog_id && retailer_id && access_token) {
        const GRAPH = `https://graph.facebook.com/${process.env.WA_API_VERSION}`;
        axios.post(`${GRAPH}/${catalog_id}/batch`,
          { requests: [{ method: 'DELETE', retailer_id }] },
          { headers: { Authorization: `Bearer ${access_token}` }, timeout: 10000 }
        ).catch(err => console.error('[Menu] Delete sync failed:', err.response?.data?.error?.message || err.message));
      }
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/restaurant/branches/:branchId/menu/csv
// Bulk upsert menu items from a parsed CSV
router.post('/branches/:branchId/menu/csv', async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'items array is required' });
    }

    const branchId = req.params.branchId;
    const results = { added: 0, skipped: 0, errors: [] };
    const categoryCache = {};

    for (const [i, row] of items.entries()) {
      const rowNum = i + 2;
      const name = (row.name || '').trim();
      const priceRaw = (row.price || row.price_rs || '').toString().replace(/[₹,\s]/g, '');
      const price = parseFloat(priceRaw);

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
        const pricePaise = Math.round(price * 100);
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
        const retailerId = `ZM-${branchId.slice(0, 6)}-${slug}`;
        const now = new Date();

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
              updated_at: now,
            },
            $setOnInsert: { _id: newId(), retailer_id: retailerId, is_available: true, sort_order: 0, created_at: now },
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

    catalog.syncBranchCatalog(branchId)
      .catch(err => console.error('[Menu] Auto-sync after CSV upload failed:', err.message));

    res.json({ success: true, ...results, total: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/restaurant/branches/:branchId/sync-catalog
router.post('/branches/:branchId/sync-catalog', requireApproved, async (req, res) => {
  try {
    const result = await catalog.syncBranchCatalog(req.params.branchId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/restaurant/branches/:branchId/sync-sets
router.post('/branches/:branchId/sync-sets', requireApproved, async (req, res) => {
  try {
    const result = await catalog.syncCategoryProductSets(req.params.branchId);
    res.json(result);
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
        wa_phone:      customer?.wa_phone,
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
      wa_phone:      customer?.wa_phone,
      branch_name:   branch?.name,
      items:         mapIds(items),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Restaurant updates order status (CONFIRMED → PREPARING → PACKED)
router.patch('/orders/:orderId/status', requireApproved, async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ['CONFIRMED', 'PREPARING', 'PACKED'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${allowed.join(', ')}` });
    }

    const order = await orderSvc.updateStatus(req.params.orderId, status);

    if (order) {
      const fullOrder = await orderSvc.getOrderDetails(order.id);
      if (fullOrder?.phone_number_id) {
        await notifyOrderStatus(
          req.restaurantId,
          fullOrder.phone_number_id, fullOrder.access_token, fullOrder.wa_phone,
          status,
          {
            order_number    : fullOrder.order_number,
            customer_name   : fullOrder.customer_name,
            total_rs        : `₹${parseFloat(fullOrder.total_rs).toFixed(0)}`,
            branch_name     : fullOrder.branch_name,
            restaurant_name : fullOrder.business_name,
          }
        ).catch(() => {});
      }
    }

    res.json({ success: true, order });
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

    if (wa_acc?.phone_number_id && customer?.wa_phone) {
      await notifyOrderStatus(
        req.restaurantId,
        wa_acc.phone_number_id, wa_acc.access_token, customer.wa_phone,
        'DISPATCHED',
        {
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
// ANALYTICS
// ═══════════════════════════════════════════════════════════════

router.get('/analytics', async (req, res) => {
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

// ═══════════════════════════════════════════════════════════════
// SETTLEMENTS
// ═══════════════════════════════════════════════════════════════

router.get('/settlements', async (req, res) => {
  try {
    const docs = await col('settlements')
      .find({ restaurant_id: req.restaurantId })
      .sort({ period_start: -1 })
      .limit(12)
      .toArray();
    res.json(mapIds(docs));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// PAYOUT ACCOUNT
// ═══════════════════════════════════════════════════════════════

const paymentSvc = require('../services/payment');

router.post('/payout-account', async (req, res) => {
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

router.post('/coupons', express.json(), async (req, res) => {
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

router.patch('/coupons/:id', express.json(), async (req, res) => {
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

router.delete('/coupons/:id', async (req, res) => {
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

    const GRAPH = `https://graph.facebook.com/${process.env.WA_API_VERSION}`;
    const { data } = await axios.get(`${GRAPH}/${wa_acc.waba_id}/message_templates`, {
      params: { fields: 'name,status,category,language,components', limit: 200 },
      headers: { Authorization: `Bearer ${wa_acc.access_token}` },
      timeout: 10000,
    });
    res.json(data.data || []);
  } catch (e) {
    const apiErr = e.response?.data?.error?.message;
    res.status(500).json({ error: apiErr || e.message });
  }
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
async function notifyOrderStatus(restaurantId, pid, token, waPhone, status, orderData) {
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

  await wa.sendStatusUpdate(pid, token, waPhone, status, {
    orderNumber: orderData.order_number,
    eta:         orderData.eta,
    trackingUrl: orderData.tracking_url,
  });
}

module.exports = router;
