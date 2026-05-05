'use strict';

// Admin CRUD + restaurant read endpoints for the campaign template
// library. Two sub-routers so admin mounts at /api/admin/campaign-templates
// (gated by requireAdminAuth) and the restaurant router mounts at
// /api/restaurant/campaign-templates (gated by requireAuth).

const express = require('express');
const { col, newId } = require('../config/database');
const { requireAuth } = require('./auth');
const { requireAdminAuth } = require('../middleware/adminAuth');

const adminRouter = express.Router();
const restaurantRouter = express.Router();

const USE_CASES = new Set([
  'welcome', 'winback_short', 'winback_long', 'birthday',
  'loyalty_expiry', 'milestone', 'manual_blast',
  'festival', 'new_dish', 'general',
  // Added for the Phase-2 marketing template seed (cart-recovery + reorder
  // engines already exist in services/cart-recovery.js + reorderIntelligence;
  // their templates need a use_case slot in the validator).
  'cart_recovery', 'reorder_suggestion',
]);
const CATEGORIES = new Set(['marketing', 'utility']);
const HEADER_TYPES = new Set(['text', 'image', 'none']);
const APPROVAL_STATUSES = new Set(['pending', 'approved', 'rejected', 'paused']);
const VARIABLE_SOURCES = new Set(['auto', 'restaurant_input', 'customer_data', 'system']);

// Default per-message cost by category. Admin can override on create.
const DEFAULT_COST = { marketing: 0.65, utility: 0.40 };

// Fields restaurants see — intentionally excludes rejection reason,
// created_by, applicable_restaurant_types, internal approval state.
function projectForRestaurant(doc) {
  if (!doc) return null;
  return {
    template_id: doc.template_id,
    display_name: doc.display_name,
    category: doc.category,
    use_case: doc.use_case,
    language: doc.language,
    header_type: doc.header_type,
    header_text: doc.header_text || null,
    body_template: doc.body_template,
    variables: Array.isArray(doc.variables) ? doc.variables : [],
    footer_text: doc.footer_text || null,
    cta_button_text: doc.cta_button_text || null,
    preview_text: doc.preview_text || null,
    per_message_cost_rs: Number(doc.per_message_cost_rs) || 0,
  };
}

function validateVariables(variables) {
  if (variables == null) return { ok: true, value: [] };
  if (!Array.isArray(variables)) return { ok: false, error: 'variables must be an array' };
  for (const v of variables) {
    if (!v || typeof v !== 'object') return { ok: false, error: 'variable entries must be objects' };
    if (!v.name || typeof v.name !== 'string') return { ok: false, error: 'variable.name required' };
    if (!v.label || typeof v.label !== 'string') return { ok: false, error: 'variable.label required' };
    if (!VARIABLE_SOURCES.has(v.source)) return { ok: false, error: `variable.source must be one of ${[...VARIABLE_SOURCES].join(', ')}` };
  }
  return {
    ok: true,
    value: variables.map((v) => ({
      name: String(v.name).trim(),
      label: String(v.label).trim(),
      source: v.source,
      required: !!v.required,
      example: v.example == null ? '' : String(v.example),
    })),
  };
}

function validatePayload(body, { isCreate }) {
  const errors = {};
  const out = {};

  if (isCreate || body.template_id !== undefined) {
    if (!body.template_id || typeof body.template_id !== 'string' || !body.template_id.trim()) {
      if (isCreate) errors.template_id = 'template_id is required';
    } else {
      out.template_id = body.template_id.trim();
    }
  }

  if (isCreate || body.display_name !== undefined) {
    if (!body.display_name || typeof body.display_name !== 'string' || !body.display_name.trim()) {
      if (isCreate) errors.display_name = 'display_name is required';
    } else {
      out.display_name = body.display_name.trim();
    }
  }

  if (isCreate || body.category !== undefined) {
    if (!CATEGORIES.has(body.category)) {
      if (isCreate) errors.category = `category must be one of ${[...CATEGORIES].join(', ')}`;
    } else {
      out.category = body.category;
    }
  }

  if (isCreate || body.use_case !== undefined) {
    if (!USE_CASES.has(body.use_case)) {
      if (isCreate) errors.use_case = `use_case must be one of ${[...USE_CASES].join(', ')}`;
    } else {
      out.use_case = body.use_case;
    }
  }

  if (isCreate || body.body_template !== undefined) {
    if (!body.body_template || typeof body.body_template !== 'string' || !body.body_template.trim()) {
      if (isCreate) errors.body_template = 'body_template is required';
    } else {
      out.body_template = body.body_template;
    }
  }

  if (body.language !== undefined) {
    out.language = String(body.language).trim() || 'en';
  } else if (isCreate) {
    out.language = 'en';
  }

  if (body.header_type !== undefined) {
    if (!HEADER_TYPES.has(body.header_type)) {
      errors.header_type = `header_type must be one of ${[...HEADER_TYPES].join(', ')}`;
    } else {
      out.header_type = body.header_type;
    }
  } else if (isCreate) {
    out.header_type = 'none';
  }

  if (body.header_text !== undefined) out.header_text = body.header_text == null ? null : String(body.header_text);
  if (body.footer_text !== undefined) out.footer_text = body.footer_text == null ? null : String(body.footer_text);
  if (body.cta_button_text !== undefined) out.cta_button_text = body.cta_button_text == null ? null : String(body.cta_button_text);
  if (body.preview_text !== undefined) out.preview_text = body.preview_text == null ? null : String(body.preview_text);

  if (body.variables !== undefined) {
    const v = validateVariables(body.variables);
    if (!v.ok) errors.variables = v.error;
    else out.variables = v.value;
  } else if (isCreate) {
    out.variables = [];
  }

  if (body.per_message_cost_rs !== undefined) {
    const n = Number(body.per_message_cost_rs);
    if (!Number.isFinite(n) || n < 0) errors.per_message_cost_rs = 'per_message_cost_rs must be a non-negative number';
    else out.per_message_cost_rs = n;
  } else if (isCreate && out.category) {
    out.per_message_cost_rs = DEFAULT_COST[out.category] ?? 0.65;
  }

  if (body.is_active !== undefined) out.is_active = !!body.is_active;
  else if (isCreate) out.is_active = true;

  if (body.meta_approval_status !== undefined) {
    if (!APPROVAL_STATUSES.has(body.meta_approval_status)) {
      errors.meta_approval_status = `meta_approval_status must be one of ${[...APPROVAL_STATUSES].join(', ')}`;
    } else {
      out.meta_approval_status = body.meta_approval_status;
    }
  } else if (isCreate) {
    out.meta_approval_status = 'pending';
  }

  if (body.meta_rejection_reason !== undefined) {
    out.meta_rejection_reason = body.meta_rejection_reason == null ? null : String(body.meta_rejection_reason);
  }

  if (body.applicable_restaurant_types !== undefined) {
    if (!Array.isArray(body.applicable_restaurant_types)) {
      errors.applicable_restaurant_types = 'applicable_restaurant_types must be an array';
    } else {
      out.applicable_restaurant_types = body.applicable_restaurant_types.map(String);
    }
  } else if (isCreate) {
    out.applicable_restaurant_types = [];
  }

  return { errors, out };
}

// ═══ ADMIN ═══
adminRouter.use(requireAdminAuth('restaurants', 'read'));

adminRouter.get('/', async (req, res) => {
  try {
    const filter = {};
    if (req.query.use_case) filter.use_case = String(req.query.use_case);
    if (req.query.is_active !== undefined) filter.is_active = req.query.is_active === 'true';
    if (req.query.meta_approval_status) filter.meta_approval_status = String(req.query.meta_approval_status);

    const rows = await col('campaign_templates').find(filter).toArray();
    rows.sort((a, b) => {
      const u = String(a.use_case).localeCompare(String(b.use_case));
      if (u !== 0) return u;
      return String(a.display_name).localeCompare(String(b.display_name));
    });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Internal server error' }); }
});

adminRouter.post('/', requireAdminAuth('restaurants', 'manage'), async (req, res) => {
  const { errors, out } = validatePayload(req.body || {}, { isCreate: true });
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Validation failed', fields: errors });

  const dup = await col('campaign_templates').findOne({ template_id: out.template_id });
  if (dup) return res.status(400).json({ error: 'Validation failed', fields: { template_id: 'template_id already exists' } });

  const now = new Date();
  const doc = {
    _id: newId(),
    ...out,
    created_by: req.admin?.userId ? String(req.admin.userId) : null,
    created_at: now,
    updated_at: now,
  };
  await col('campaign_templates').insertOne(doc);
  res.status(201).json(doc);
});

adminRouter.put('/:templateId', requireAdminAuth('restaurants', 'manage'), async (req, res) => {
  const body = req.body || {};
  if (body.template_id && body.template_id !== req.params.templateId) {
    return res.status(400).json({ error: 'template_id is immutable' });
  }
  const { errors, out } = validatePayload(body, { isCreate: false });
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Validation failed', fields: errors });

  delete out.template_id; // never rewrite the key
  out.updated_at = new Date();

  const result = await col('campaign_templates').findOneAndUpdate(
    { template_id: req.params.templateId },
    { $set: out },
    { returnDocument: 'after' },
  );
  if (!result) return res.status(404).json({ error: 'Template not found' });
  res.json(result);
});

adminRouter.delete('/:templateId', requireAdminAuth('restaurants', 'manage'), async (req, res) => {
  const result = await col('campaign_templates').updateOne(
    { template_id: req.params.templateId },
    { $set: { is_active: false, updated_at: new Date() } },
  );
  if (!result.matchedCount) return res.status(404).json({ error: 'Template not found' });
  res.json({ message: 'Template deactivated' });
});

adminRouter.post('/:templateId/activate', requireAdminAuth('restaurants', 'manage'), async (req, res) => {
  const result = await col('campaign_templates').updateOne(
    { template_id: req.params.templateId },
    { $set: { is_active: true, updated_at: new Date() } },
  );
  if (!result.matchedCount) return res.status(404).json({ error: 'Template not found' });
  res.json({ message: 'Template activated' });
});

adminRouter.patch('/:templateId/approval', requireAdminAuth('restaurants', 'manage'), async (req, res) => {
  const { status, rejection_reason } = req.body || {};
  if (!APPROVAL_STATUSES.has(status)) {
    return res.status(400).json({ error: `status must be one of ${[...APPROVAL_STATUSES].join(', ')}` });
  }
  const $set = { meta_approval_status: status, updated_at: new Date() };
  if (rejection_reason !== undefined) $set.meta_rejection_reason = rejection_reason == null ? null : String(rejection_reason);

  const result = await col('campaign_templates').findOneAndUpdate(
    { template_id: req.params.templateId },
    { $set },
    { returnDocument: 'after' },
  );
  if (!result) return res.status(404).json({ error: 'Template not found' });
  res.json(result);
});

// ═══ RESTAURANT (read-only, filtered to active + approved) ═══
restaurantRouter.use(requireAuth);

restaurantRouter.get('/', async (req, res) => {
  try {
    const filter = { is_active: true, meta_approval_status: 'approved' };
    if (req.query.use_case) filter.use_case = String(req.query.use_case);
    const rows = await col('campaign_templates').find(filter).toArray();
    rows.sort((a, b) => {
      const u = String(a.use_case).localeCompare(String(b.use_case));
      if (u !== 0) return u;
      return String(a.display_name).localeCompare(String(b.display_name));
    });
    res.json(rows.map(projectForRestaurant));
  } catch (e) { res.status(500).json({ error: 'Internal server error' }); }
});

restaurantRouter.get('/:templateId', async (req, res) => {
  try {
    const doc = await col('campaign_templates').findOne({
      template_id: req.params.templateId,
      is_active: true,
      meta_approval_status: 'approved',
    });
    if (!doc) return res.status(404).json({ error: 'Template not found' });
    res.json(projectForRestaurant(doc));
  } catch (e) { res.status(500).json({ error: 'Internal server error' }); }
});

module.exports = { adminRouter, restaurantRouter };
