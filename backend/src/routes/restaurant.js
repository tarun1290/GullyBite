// src/routes/restaurant.js
// REST API for the restaurant owner dashboard
// Protected by JWT — all routes require login

const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { requireAuth } = require('./auth');
const catalog = require('../services/catalog');
const orderSvc = require('../services/order');

// All routes below require authentication
router.use(requireAuth);

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
    const { isOpen, acceptsOrders, deliveryRadiusKm, catalogId } = req.body;
    await db.query(
      `UPDATE branches SET
         is_open            = COALESCE($1, is_open),
         accepts_orders     = COALESCE($2, accepts_orders),
         delivery_radius_km = COALESCE($3, delivery_radius_km),
         catalog_id         = COALESCE($4, catalog_id)
       WHERE id = $5 AND restaurant_id = $6`,
      [isOpen, acceptsOrders, deliveryRadiusKm, catalogId, req.params.id, req.restaurantId]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

---

## The complete flow end to end
```
// Restaurant owner adds branch
 //       │
   //     ▼
//Creates catalog in Meta Commerce Manager
  //      │
    //    ▼
//Pastes catalog_id in dashboard → clicks Save Catalog
  //      │
    //    ▼
//Adds menu items → clicks Sync Menu
  //      │
    //    ▼
//catalog.service.js sends batch API → items appear in WhatsApp Catalog
  //      │
//Customer messages WhatsApp number
  //      │
    //    ▼
//Shares location → Haversine finds nearest branch
  //      │
    //    ▼
//webhook reads that branch's catalog_id from DB
  //      │
    //    ▼
//Sends catalog_message with that branch's catalog_id
  //      │
    //    ▼
//Customer sees ONLY that branch's menu inside WhatsApp 

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
    const { name, description, priceRs, categoryId, foodType, imageUrl, isBestseller, sortOrder } = req.body;
    if (!name || !priceRs) return res.status(400).json({ error: 'name and priceRs required' });

    // Generate unique retailer_id for WhatsApp Catalog
    const retailerId = `ZM-${req.params.branchId.slice(0, 6)}-${Date.now()}`;
    const pricePaise = Math.round(parseFloat(priceRs) * 100);

    const { rows } = await db.query(
      `INSERT INTO menu_items
         (branch_id, category_id, name, description, price_paise, retailer_id,
          image_url, food_type, is_bestseller, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.params.branchId, categoryId, name, description, pricePaise, retailerId,
       imageUrl, foodType || 'veg', isBestseller || false, sortOrder || 0]
    );

    await db.query(
      'UPDATE restaurants SET onboarding_step = GREATEST(onboarding_step, 4) WHERE id = $1',
      [req.restaurantId]
    );

    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/menu/:itemId', async (req, res) => {
  try {
    const { name, description, priceRs, imageUrl, isAvailable, isBestseller } = req.body;
    const updates = [];
    const vals = [];
    if (name !== undefined) { vals.push(name); updates.push(`name=$${vals.length}`); }
    if (description !== undefined) { vals.push(description); updates.push(`description=$${vals.length}`); }
    if (priceRs !== undefined) { vals.push(Math.round(parseFloat(priceRs) * 100)); updates.push(`price_paise=$${vals.length}`); }
    if (imageUrl !== undefined) { vals.push(imageUrl); updates.push(`image_url=$${vals.length}`); }
    if (isAvailable !== undefined) { vals.push(isAvailable); updates.push(`is_available=$${vals.length}`); }
    if (isBestseller !== undefined) { vals.push(isBestseller); updates.push(`is_bestseller=$${vals.length}`); }
    if (!updates.length) return res.json({ success: true });
    vals.push(req.params.itemId);
    await db.query(`UPDATE menu_items SET ${updates.join(',')} WHERE id=$${vals.length}`, vals);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/menu/:itemId', async (req, res) => {
  try {
    await db.query('DELETE FROM menu_items WHERE id=$1', [req.params.itemId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/restaurant/branches/:branchId/sync-catalog
// Pushes all menu items to WhatsApp Catalog
router.post('/branches/:branchId/sync-catalog', async (req, res) => {
  try {
    const result = await catalog.syncBranchCatalog(req.params.branchId);
    res.json(result);
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


//Owner clicks "Add Branch" → fills name, address, GPS
  //      │
    //    ▼
//Branch saved to Supabase instantly
  //      │
    //    ▼ (background, ~2 seconds)
//createBranchCatalog() calls Meta API
  //      │
    //    ├── Fetches business ID
      //  ├── Creates catalog: "Burger Palace - Koramangala"
        //├── Saves catalog_id to branches table
        //└── Links catalog to WhatsApp Business Account
        //│
        //▼
//Owner adds menu items → clicks Sync Menu
  //      │
    //    ▼
//All items pushed to that branch's catalog via Batch API
  //      │
    //    ▼
//Customer messages → shares location → gets
//ONLY that branch's catalog inside WhatsApp

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

      // When PACKED — 3PL dispatch would happen here (commented out)
      // if (status === 'PACKED') {
      //   await threepl.dispatchOrder(order.id)
      // }
    }

    res.json({ success: true, order });
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

// Import for notifications
const wa = require('../services/whatsapp');

module.exports = router;