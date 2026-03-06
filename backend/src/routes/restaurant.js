// src/routes/restaurant.js
// REST API for the restaurant owner dashboard
// Protected by JWT — all routes require login

const express = require('express');
const router = express.Router();
const multer = require('multer');
const axios  = require('axios');
const db = require('../config/database');
const { requireAuth, requireApproved } = require('./auth');
const catalog = require('../services/catalog');
const orderSvc = require('../services/order');
const wa = require('../services/whatsapp');

// ── Image upload via Supabase Storage ─────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits : { fileSize: 5 * 1024 * 1024 }, // 5 MB max
  fileFilter(req, file, cb) {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype);
    cb(ok ? null : new Error('Only JPEG, PNG, WebP or GIF images are allowed'), ok);
  },
});

// All routes below require authentication + admin approval
router.use(requireAuth, requireApproved);

// ═══════════════════════════════════════════════════════════════
// RESTAURANT PROFILE
// ═══════════════════════════════════════════════════════════════

// GET /api/restaurant — Get my restaurant + stats
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT r.*,
        (SELECT COUNT(*) FROM branches WHERE restaurant_id = r.id) AS branch_count,
        (SELECT COUNT(*) FROM whatsapp_accounts WHERE restaurant_id = r.id AND is_active) AS wa_count
       FROM restaurants r WHERE r.id = $1`,
      [req.restaurantId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const r = rows[0];
    delete r.meta_access_token; // Never send tokens to frontend!
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/restaurant — Update profile
router.put('/', async (req, res) => {
  try {
    const { businessName, ownerName, phone, logoUrl, bankName, bankAccountNumber, bankIfsc } = req.body;
    await db.query(
      `UPDATE restaurants SET
         business_name = COALESCE($1, business_name),
         owner_name = COALESCE($2, owner_name),
         phone = COALESCE($3, phone),
         logo_url = COALESCE($4, logo_url),
         bank_name = COALESCE($5, bank_name),
         bank_account_number = COALESCE($6, bank_account_number),
         bank_ifsc = COALESCE($7, bank_ifsc),
         onboarding_step = GREATEST(onboarding_step, 2)
       WHERE id = $8`,
      [businessName, ownerName, phone, logoUrl, bankName, bankAccountNumber, bankIfsc, req.restaurantId]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// IMAGE UPLOAD
// ═══════════════════════════════════════════════════════════════

// POST /api/restaurant/menu/upload-image
// Accepts: multipart/form-data with field "image"
// Returns: { url: "https://..." }  — public URL ready to use in catalog
router.post('/menu/upload-image', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file received' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'Image storage not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing)' });
  }

  const ext      = req.file.mimetype.split('/')[1].replace('jpeg', 'jpg');
  const filename = `${req.restaurantId}/${Date.now()}.${ext}`;

  try {
    await axios.post(
      `${SUPABASE_URL}/storage/v1/object/menu-images/${filename}`,
      req.file.buffer,
      {
        headers: {
          Authorization : `Bearer ${SERVICE_KEY}`,
          apikey        : SERVICE_KEY,
          'Content-Type': req.file.mimetype,
          'x-upsert'    : 'true',
        },
        timeout: 20000,
      }
    );

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/menu-images/${filename}`;
    res.json({ url: publicUrl });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    console.error('[ImageUpload] Supabase Storage error:', msg);
    res.status(500).json({ error: `Image upload failed: ${msg}` });
  }
});

// ═══════════════════════════════════════════════════════════════
// WHATSAPP ACCOUNTS
// ═══════════════════════════════════════════════════════════════

router.get('/whatsapp', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, waba_id, phone_number_id, phone_display, display_name,
              quality_rating, messaging_limit, catalog_id, catalog_synced_at, is_active
       FROM whatsapp_accounts WHERE restaurant_id = $1`,
      [req.restaurantId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update WA account (mainly to set catalog_id)
router.put('/whatsapp/:id', async (req, res) => {
  try {
    const { catalogId, isActive } = req.body;
    await db.query(
      `UPDATE whatsapp_accounts SET
         catalog_id = COALESCE($1, catalog_id),
         is_active = COALESCE($2, is_active)
       WHERE id = $3 AND restaurant_id = $4`,
      [catalogId, isActive, req.params.id, req.restaurantId]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// BRANCHES
// ═══════════════════════════════════════════════════════════════

router.get('/branches', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM branches WHERE restaurant_id = $1 ORDER BY created_at',
      [req.restaurantId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/branches', async (req, res) => {
  try {
    const { name, address, city, pincode, latitude, longitude, deliveryRadiusKm, openingTime, closingTime, managerPhone } = req.body;
    if (!latitude || !longitude) return res.status(400).json({ error: 'latitude and longitude are required' });

    const { rows } = await db.query(
      `INSERT INTO branches
         (restaurant_id, name, address, city, pincode, latitude, longitude,
          delivery_radius_km, opening_time, closing_time, manager_phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.restaurantId, name, address, city, pincode, latitude, longitude,
       deliveryRadiusKm || 5, openingTime || '10:00', closingTime || '22:00', managerPhone]
    );

    await db.query(
      'UPDATE restaurants SET onboarding_step = GREATEST(onboarding_step, 3) WHERE id = $1',
      [req.restaurantId]
    );

    const newBranch = rows[0];

    // ── AUTO-CREATE WHATSAPP CATALOG FOR THIS BRANCH ──────────
    // Runs in background — don't await so the branch saves instantly
    // Restaurant owner sees branch immediately, catalog creates in ~2 seconds
    catalog.createBranchCatalog(newBranch.id)
      .then(result => {
        if (result.success) {
          console.log(`[Branch] Auto-created catalog for "${newBranch.name}": ${result.catalogId}`);
        }
      })
      .catch(err => {
        // Non-fatal — branch still saved, catalog can be retried
        console.error(`[Branch] Auto catalog creation failed for "${newBranch.name}":`, err.message);
      });

    res.status(201).json(newBranch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/branches/:id', async (req, res) => {
  try {
    const { isOpen, acceptsOrders, deliveryRadiusKm, catalogId, deliveryFeeRs } = req.body;
    await db.query(
      `UPDATE branches SET
         is_open            = COALESCE($1, is_open),
         accepts_orders     = COALESCE($2, accepts_orders),
         delivery_radius_km = COALESCE($3, delivery_radius_km),
         catalog_id         = COALESCE($4, catalog_id),
         delivery_fee_rs    = COALESCE($5, delivery_fee_rs)
       WHERE id = $6 AND restaurant_id = $7`,
      [isOpen, acceptsOrders, deliveryRadiusKm, catalogId, deliveryFeeRs,
       req.params.id, req.restaurantId]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// MENU CATEGORIES
// ═══════════════════════════════════════════════════════════════

router.get('/branches/:branchId/categories', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM menu_categories WHERE branch_id = $1 ORDER BY sort_order',
      [req.params.branchId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/branches/:branchId/categories', async (req, res) => {
  try {
    const { name, description, sortOrder } = req.body;
    const { rows } = await db.query(
      'INSERT INTO menu_categories (branch_id, name, description, sort_order) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.params.branchId, name, description, sortOrder || 0]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// MENU ITEMS
// ═══════════════════════════════════════════════════════════════

router.get('/branches/:branchId/menu', async (req, res) => {
  try {
    const { rows: cats } = await db.query(
      'SELECT * FROM menu_categories WHERE branch_id=$1 ORDER BY sort_order',
      [req.params.branchId]
    );
    const { rows: items } = await db.query(
      'SELECT * FROM menu_items WHERE branch_id=$1 ORDER BY sort_order, name',
      [req.params.branchId]
    );
    // Group items by category
    const result = cats.map((c) => ({ ...c, items: items.filter((i) => i.category_id === c.id) }));
    result.push({ id: null, name: 'Uncategorized', items: items.filter((i) => !i.category_id) });
    res.json(result.filter((c) => c.items.length > 0));
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

    // Generate unique retailer_id for WhatsApp Catalog
    // Include variant value in the ID so variants are distinguishable
    const variantSuffix = variantValue ? `-${variantValue.toLowerCase().replace(/\s+/g, '-')}` : '';
    const retailerId = `ZM-${req.params.branchId.slice(0, 6)}-${Date.now()}${variantSuffix}`;
    const pricePaise = Math.round(parseFloat(priceRs) * 100);

    const { rows } = await db.query(
      `INSERT INTO menu_items
         (branch_id, category_id, name, description, price_paise, retailer_id,
          image_url, food_type, is_bestseller, sort_order,
          item_group_id, variant_type, variant_value)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [req.params.branchId, categoryId, name, description, pricePaise, retailerId,
       imageUrl, foodType || 'veg', isBestseller || false, sortOrder || 0,
       itemGroupId || null, variantType || null, variantValue || null]
    );

    await db.query(
      'UPDATE restaurants SET onboarding_step = GREATEST(onboarding_step, 4) WHERE id = $1',
      [req.restaurantId]
    );

    // Auto-sync new item to Meta catalog in background
    catalog.syncBranchCatalog(req.params.branchId)
      .catch(err => console.error('[Menu] Auto-sync after add failed:', err.message));

    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/menu/:itemId', async (req, res) => {
  try {
    const { name, description, priceRs, imageUrl, isAvailable, isBestseller,
            itemGroupId, variantType, variantValue } = req.body;

    // Availability-only toggle: use optimised single-item push (faster than full sync)
    const onlyAvailability = isAvailable !== undefined &&
      name === undefined && description === undefined && priceRs === undefined &&
      imageUrl === undefined && isBestseller === undefined &&
      itemGroupId === undefined && variantType === undefined && variantValue === undefined;

    if (onlyAvailability) {
      catalog.setItemAvailability(req.params.itemId, isAvailable)
        .catch(err => console.error('[Menu] Availability sync failed:', err.message));
      return res.json({ success: true });
    }

    // Full edit: update DB, then sync catalog in background
    const updates = [];
    const vals = [];
    if (name !== undefined)        { vals.push(name); updates.push(`name=$${vals.length}`); }
    if (description !== undefined) { vals.push(description); updates.push(`description=$${vals.length}`); }
    if (priceRs !== undefined)     { vals.push(Math.round(parseFloat(priceRs) * 100)); updates.push(`price_paise=$${vals.length}`); }
    if (imageUrl !== undefined)    { vals.push(imageUrl); updates.push(`image_url=$${vals.length}`); }
    if (isBestseller !== undefined){ vals.push(isBestseller); updates.push(`is_bestseller=$${vals.length}`); }
    if (itemGroupId !== undefined) { vals.push(itemGroupId || null); updates.push(`item_group_id=$${vals.length}`); }
    if (variantType !== undefined) { vals.push(variantType || null); updates.push(`variant_type=$${vals.length}`); }
    if (variantValue !== undefined){ vals.push(variantValue || null); updates.push(`variant_value=$${vals.length}`); }
    if (!updates.length) return res.json({ success: true });
    vals.push(req.params.itemId);
    const { rows: updated } = await db.query(
      `UPDATE menu_items SET ${updates.join(',')} WHERE id=$${vals.length} RETURNING branch_id`, vals
    );
    if (updated.length) {
      catalog.syncBranchCatalog(updated[0].branch_id)
        .catch(err => console.error('[Menu] Auto-sync after edit failed:', err.message));
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/menu/:itemId', async (req, res) => {
  try {
    // Fetch item before deleting so we can push DELETE to Meta catalog
    const { rows: items } = await db.query(
      `SELECT mi.retailer_id, mi.branch_id, b.catalog_id, wa.access_token
       FROM menu_items mi
       JOIN branches b ON mi.branch_id = b.id
       JOIN restaurants r ON b.restaurant_id = r.id
       LEFT JOIN whatsapp_accounts wa ON wa.restaurant_id = r.id AND wa.is_active = TRUE
       WHERE mi.id = $1`,
      [req.params.itemId]
    );
    await db.query('DELETE FROM menu_items WHERE id=$1', [req.params.itemId]);

    // Push single DELETE to Meta catalog in background
    if (items.length) {
      const { retailer_id, catalog_id, access_token } = items[0];
      if (catalog_id && retailer_id && access_token) {
        const axios = require('axios');
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
// Bulk upsert menu items from a parsed CSV (array of row objects sent as JSON)
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
            const { rows: ex } = await db.query(
              'SELECT id FROM menu_categories WHERE branch_id=$1 AND name=$2', [branchId, categoryName]
            );
            if (ex.length) {
              categoryCache[categoryName] = ex[0].id;
            } else {
              const { rows: cr } = await db.query(
                'INSERT INTO menu_categories (branch_id, name) VALUES ($1,$2) RETURNING id', [branchId, categoryName]
              );
              categoryCache[categoryName] = cr[0].id;
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
        // Deterministic retailer_id — re-uploading same item updates instead of duplicating
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
        const retailerId = `ZM-${branchId.slice(0, 6)}-${slug}`;

        await db.query(
          `INSERT INTO menu_items
             (branch_id, category_id, name, description, price_paise, retailer_id, image_url, food_type, is_bestseller)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (retailer_id) DO UPDATE SET
             name=EXCLUDED.name, category_id=EXCLUDED.category_id,
             description=EXCLUDED.description, price_paise=EXCLUDED.price_paise,
             image_url=EXCLUDED.image_url, food_type=EXCLUDED.food_type,
             is_bestseller=EXCLUDED.is_bestseller, updated_at=NOW()`,
          [branchId, categoryId, name, (row.description || row.desc || '').trim(),
           pricePaise, retailerId, imageUrl, foodType, isBestseller]
        );
        results.added++;
      } catch (e) {
        results.errors.push(`Row ${rowNum} "${name}": ${e.message}`);
        results.skipped++;
      }
    }

    await db.query(
      'UPDATE restaurants SET onboarding_step=GREATEST(onboarding_step,4) WHERE id=$1',
      [req.restaurantId]
    );

    // Auto-sync all uploaded items to Meta catalog in background
    catalog.syncBranchCatalog(branchId)
      .catch(err => console.error('[Menu] Auto-sync after CSV upload failed:', err.message));

    res.json({ success: true, ...results, total: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/restaurant/branches/:branchId/sync-catalog
// Pushes all menu items to WhatsApp Catalog (also auto-syncs product sets after)
router.post('/branches/:branchId/sync-catalog', async (req, res) => {
  try {
    const result = await catalog.syncBranchCatalog(req.params.branchId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/restaurant/branches/:branchId/sync-sets
// Creates/updates Meta Product Sets per category (sections customers see in WhatsApp)
// Auto-called after every full sync; also available manually
router.post('/branches/:branchId/sync-sets', async (req, res) => {
  try {
    const result = await catalog.syncCategoryProductSets(req.params.branchId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/restaurant/branches/:branchId/item-groups
// Returns all variant groups for a branch (for the variant management UI)
router.get('/branches/:branchId/item-groups', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        item_group_id,
        MIN(name) AS base_name,
        json_agg(json_build_object(
          'id',            id,
          'name',          name,
          'variant_type',  variant_type,
          'variant_value', variant_value,
          'price_paise',   price_paise,
          'image_url',     image_url,
          'is_available',  is_available,
          'retailer_id',   retailer_id
        ) ORDER BY price_paise) AS variants
      FROM menu_items
      WHERE branch_id = $1 AND item_group_id IS NOT NULL
      GROUP BY item_group_id
    `, [req.params.branchId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/restaurant/menu/:itemId/variants
// Adds a size/portion variant to an existing item.
// On first call: generates item_group_id and tags the source item as 'Regular'.
router.post('/menu/:itemId/variants', async (req, res) => {
  const { v4: uuidv4 } = require('uuid');
  try {
    const { variantLabel, variantType = 'size', priceRs, imageUrl, baseLabel = 'Regular' } = req.body;
    if (!variantLabel || !priceRs) {
      return res.status(400).json({ error: 'variantLabel and priceRs are required' });
    }

    // Fetch source item — must belong to this restaurant
    const { rows } = await db.query(`
      SELECT mi.*, b.restaurant_id
      FROM menu_items mi JOIN branches b ON mi.branch_id = b.id
      WHERE mi.id = $1 AND b.restaurant_id = $2
    `, [req.params.itemId, req.restaurantId]);

    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    const src = rows[0];

    // If the source item has no group yet, initialise it as baseLabel (default: 'Regular')
    let groupId = src.item_group_id;
    if (!groupId) {
      groupId = uuidv4();
      const baseRetailerId = `${src.retailer_id}-${baseLabel.toLowerCase().replace(/\s+/g, '-')}`;
      await db.query(`
        UPDATE menu_items
        SET item_group_id = $1, variant_type = $2, variant_value = $3,
            retailer_id = $4, updated_at = NOW()
        WHERE id = $5
      `, [groupId, variantType, baseLabel, baseRetailerId, src.id]);
    }

    // Create the new variant item.
    // Store ONLY the base name (without variant suffix) — catalog.js will build
    // the display name as "Butter Chicken - Large" at sync time, preventing duplication.
    const baseName    = src.name.replace(/\s*-\s*\S+$/, '').trim() || src.name;
    const variantSlug = variantLabel.toLowerCase().replace(/\s+/g, '-');
    const retailerId  = `${src.retailer_id.replace(/-regular$|-\S+$/, '')}-${variantSlug}`;
    const pricePaise  = Math.round(parseFloat(priceRs) * 100);

    const { rows: newItem } = await db.query(`
      INSERT INTO menu_items
        (branch_id, category_id, name, description, price_paise, retailer_id,
         image_url, food_type, is_bestseller, item_group_id, variant_type, variant_value)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (retailer_id) DO UPDATE SET
        price_paise   = EXCLUDED.price_paise,
        image_url     = COALESCE(EXCLUDED.image_url, menu_items.image_url),
        variant_value = EXCLUDED.variant_value,
        updated_at    = NOW()
      RETURNING *
    `, [
      src.branch_id, src.category_id, baseName, src.description,
      pricePaise, retailerId, imageUrl || src.image_url,
      src.food_type, src.is_bestseller, groupId, variantType, variantLabel,
    ]);

    // Push updated group to Meta catalog in background
    catalog.syncBranchCatalog(src.branch_id)
      .catch(err => console.error('[Variant] Auto-sync failed:', err.message));

    res.status(201).json(newItem[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/restaurant/branches/:branchId/create-catalog
// Manually trigger catalog creation (retry if auto-create failed)
router.post('/branches/:branchId/create-catalog', async (req, res) => {
  try {
    const result = await catalog.createBranchCatalog(req.params.branchId);

    if (result.alreadyExists) {
      return res.json({
        success  : true,
        message  : 'Catalog already exists',
        catalogId: result.catalogId,
      });
    }

    // Auto-sync menu after catalog is created
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
    let where = 'b.restaurant_id = $1';
    const vals = [req.restaurantId];

    if (status) { vals.push(status); where += ` AND o.status = $${vals.length}`; }
    if (branchId) { vals.push(branchId); where += ` AND o.branch_id = $${vals.length}`; }

    vals.push(parseInt(limit), parseInt(offset));

    const { rows } = await db.query(
      `SELECT o.*, c.name AS customer_name, c.wa_phone, b.name AS branch_name,
              (SELECT json_agg(oi) FROM order_items oi WHERE oi.order_id = o.id) AS items
       FROM orders o
       JOIN branches b ON o.branch_id = b.id
       JOIN customers c ON o.customer_id = c.id
       WHERE ${where}
       ORDER BY o.created_at DESC
       LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
      vals
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Restaurant updates order status (CONFIRMED → PREPARING → PACKED)
router.patch('/orders/:orderId/status', async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ['CONFIRMED', 'PREPARING', 'PACKED'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${allowed.join(', ')}` });
    }

    const order = await orderSvc.updateStatus(req.params.orderId, status);

    // Send WhatsApp notification to customer
    if (order) {
      const fullOrder = await orderSvc.getOrderDetails(order.id);
      if (fullOrder?.phone_number_id) {
        await wa.sendStatusUpdate(
          fullOrder.phone_number_id, fullOrder.access_token, fullOrder.wa_phone,
          status, { orderNumber: fullOrder.order_number }
        ).catch(() => {});
      }

      }

    res.json({ success: true, order });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/restaurant/orders/:orderId/delivery
// Called by the 3PL provider (or restaurant manually) after dispatch.
// Stores tracking details and notifies the customer on WhatsApp.
//
// Body (all optional — send only what the 3PL provides):
//   { provider, providerOrderId, trackingUrl, driverName, driverPhone,
//     estimatedMins, costRs, status }
router.put('/orders/:orderId/delivery', async (req, res) => {
  try {
    const {
      provider, providerOrderId, trackingUrl,
      driverName, driverPhone,
      estimatedMins, costRs,
      status = 'assigned',
    } = req.body;

    // Verify this order belongs to this restaurant
    const { rows: orderRows } = await db.query(
      `SELECT o.*, b.restaurant_id,
              wa.phone_number_id, wa.access_token,
              c.wa_phone, c.name AS customer_name
       FROM orders o
       JOIN branches b  ON o.branch_id    = b.id
       JOIN customers c ON o.customer_id  = c.id
       LEFT JOIN whatsapp_accounts wa
         ON wa.restaurant_id = b.restaurant_id AND wa.is_active = TRUE
       WHERE o.id = $1 AND b.restaurant_id = $2`,
      [req.params.orderId, req.restaurantId]
    );
    if (!orderRows.length) return res.status(404).json({ error: 'Order not found' });
    const order = orderRows[0];

    // Update delivery record
    await db.query(
      `UPDATE deliveries SET
         provider          = COALESCE($1, provider),
         provider_order_id = COALESCE($2, provider_order_id),
         tracking_url      = COALESCE($3, tracking_url),
         driver_name       = COALESCE($4, driver_name),
         driver_phone      = COALESCE($5, driver_phone),
         estimated_mins    = COALESCE($6, estimated_mins),
         cost_rs           = COALESCE($7, cost_rs),
         status            = $8
       WHERE order_id = $9`,
      [provider, providerOrderId, trackingUrl, driverName, driverPhone,
       estimatedMins, costRs, status, req.params.orderId]
    );

    // Mark order as DISPATCHED if status says so
    if (status === 'picked_up' || status === 'dispatched') {
      await orderSvc.updateStatus(req.params.orderId, 'DISPATCHED');
    }

    // Notify customer on WhatsApp with tracking link
    if (order.phone_number_id && order.wa_phone) {
      let msg = `🚴 *Your order is on the way!*\n\nOrder: #${order.order_number}`;
      if (driverName)    msg += `\nDriver: ${driverName}`;
      if (driverPhone)   msg += ` · ${driverPhone}`;
      if (estimatedMins) msg += `\nETA: ~${estimatedMins} mins`;
      if (trackingUrl)   msg += `\n\n🔗 *Live tracking:* ${trackingUrl}`;
      await wa.sendText(order.phone_number_id, order.access_token, order.wa_phone, msg)
        .catch(() => {});
    }

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// ANALYTICS
// ═══════════════════════════════════════════════════════════════

router.get('/analytics', async (req, res) => {
  try {
    const { days = 7 } = req.query;

    const { rows: summary } = await db.query(
      `SELECT
         COUNT(*) AS total_orders,
         COUNT(*) FILTER (WHERE o.status = 'DELIVERED') AS delivered,
         COUNT(*) FILTER (WHERE o.status = 'CANCELLED') AS cancelled,
         COALESCE(SUM(o.total_rs) FILTER (WHERE o.status = 'DELIVERED'), 0) AS total_revenue,
         COALESCE(AVG(o.total_rs) FILTER (WHERE o.status = 'DELIVERED'), 0) AS avg_order_value
       FROM orders o
       JOIN branches b ON o.branch_id = b.id
       WHERE b.restaurant_id = $1
         AND o.created_at >= NOW() - INTERVAL '${parseInt(days)} days'`,
      [req.restaurantId]
    );

    const { rows: daily } = await db.query(
      `SELECT
         DATE(o.created_at) AS date,
         COUNT(*) AS orders,
         COALESCE(SUM(o.total_rs) FILTER (WHERE o.status='DELIVERED'), 0) AS revenue
       FROM orders o
       JOIN branches b ON o.branch_id = b.id
       WHERE b.restaurant_id = $1
         AND o.created_at >= NOW() - INTERVAL '${parseInt(days)} days'
       GROUP BY DATE(o.created_at)
       ORDER BY date`,
      [req.restaurantId]
    );

    res.json({ summary: summary[0], daily });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// SETTLEMENTS
// ═══════════════════════════════════════════════════════════════

router.get('/settlements', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM settlements WHERE restaurant_id=$1 ORDER BY period_start DESC LIMIT 12',
      [req.restaurantId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// PAYOUT ACCOUNT
// ═══════════════════════════════════════════════════════════════

// POST /api/restaurant/payout-account
// Registers the restaurant's bank account with Razorpay X so weekly
// settlements can be transferred automatically.
// Call this once after the restaurant fills in their bank details.
// Requires: bank_account_number + bank_ifsc to be set on the restaurant.
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

module.exports = router;