// src/routes/products.js
// New branch-aware product endpoints. Mounted at /api/restaurant/products
// so it sits alongside the existing menu routes WITHOUT replacing them.
//
// Controllers here are thin — all business logic lives in the service
// layer (product.service.js, branch.service.js).

'use strict';

const express = require('express');
const router = express.Router();

const { requireAuth } = require('./auth');
const productSvc = require('../services/product.service');
const branchSvc  = require('../services/branch.service');
const suggestionSvc = require('../services/branchSuggestions');
const { validateBranchPayload, validateAssignBranchPayload } = require('../middleware/validateBranch');

router.use(requireAuth);

// ─── Branches ───────────────────────────────────────────────────
// POST /api/restaurant/products/branches
// Dedicated FSSAI-validated branch creation endpoint. The legacy
// POST /api/restaurant/branches still exists for back-compat and does
// not require FSSAI (older onboarding flow). New clients should prefer
// this endpoint.
router.post('/branches', validateBranchPayload, async (req, res) => {
  try {
    const { branch, razorpay_order } = await branchSvc.createBranch({
      ...req.body,
      restaurant_id: req.restaurantId,
    });
    res.status(201).json({ ...branch, razorpay_order });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ─── Products ───────────────────────────────────────────────────
// POST /api/restaurant/products
// Create a product WITHOUT requiring a branch. Defaults is_unassigned=true.
router.post('/', async (req, res) => {
  try {
    const product = await productSvc.createProduct({
      ...req.body,
      restaurant_id: req.restaurantId,
    });
    res.status(201).json(product);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// GET /api/restaurant/products/unassigned — dashboard-only list.
// NOT exposed to customer APIs; this is explicitly for ops/admin.
router.get('/unassigned', async (req, res) => {
  try {
    const products = await productSvc.listUnassignedProducts(req.restaurantId);
    res.json({ count: products.length, products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/restaurant/products/:id/assign-branch
router.post('/:id/assign-branch', validateAssignBranchPayload, async (req, res) => {
  try {
    const updated = await productSvc.assignProductToBranch({
      product_id: req.params.id,
      branch_id: req.body.branch_id,
      price: req.body.price,
      tax_percentage: req.body.tax_percentage,
      availability: req.body.availability,
    });
    res.json(updated);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// POST /api/restaurant/products/:id/unassign-branch
router.post('/:id/unassign-branch', async (req, res) => {
  try {
    if (!req.body.branch_id) return res.status(400).json({ error: 'branch_id is required' });
    const updated = await productSvc.unassignFromBranch({
      product_id: req.params.id,
      branch_id: req.body.branch_id,
    });
    res.json(updated);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// GET /api/restaurant/products/branch-suggestions
// Smart bulk branch-mapping proposals. NEVER writes to the DB —
// the dashboard renders these as suggestions the operator can accept,
// edit, or reject before calling /assign-branch per row.
//
// Query params:
//   scope=unassigned (default) | all
//   product_ids=id1,id2,...   (overrides scope)
router.get('/branch-suggestions', async (req, res) => {
  try {
    const productIds = req.query.product_ids
      ? String(req.query.product_ids).split(',').map(s => s.trim()).filter(Boolean)
      : undefined;
    const suggestions = await suggestionSvc.suggestForRestaurant(req.restaurantId, {
      scope: req.query.scope === 'all' ? 'all' : 'unassigned',
      product_ids: productIds,
    });
    res.json({ count: suggestions.length, suggestions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/restaurant/products/branch/:branchId — customer-facing view
// (only active branches, only assigned products, merged overrides).
router.get('/branch/:branchId', async (req, res) => {
  try {
    const items = await productSvc.listCustomerMenuForBranch(req.params.branchId);
    res.json({ count: items.length, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
