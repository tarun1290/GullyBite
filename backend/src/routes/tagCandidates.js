// src/routes/tagCandidates.js
// Admin surface for reviewing tag candidates promoted by menuTagger.
// Mounted at /api/admin/tag-candidates in ec2-server.js. Role gating
// uses requireRole() from routes/auth.js, which spreads in
// requireAdminAuth() — do NOT add it manually.

'use strict';

const express = require('express');
const router = express.Router();
const { col, connect, mapIds } = require('../config/database');
const { requireRole } = require('./auth');
const { logAdminAction } = require('../utils/adminAudit');
const redisClient = require('../queue/redis');
const log = require('../utils/logger').child({ component: 'tagCandidates' });

// ─── E1: GET / — list candidates, default to status=pending ─────────
router.get('/', ...requireRole(['super_admin']), async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const skip = (page - 1) * limit;

    const filter = { status };

    const [total, results] = await Promise.all([
      col('tag_candidates').countDocuments(filter),
      col('tag_candidates')
        .find(filter)
        .sort({ suggested_count: -1, created_at: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
    ]);

    res.json({ total, page, limit, results: mapIds(results) });
  } catch (err) {
    log.error({ err }, 'GET /api/admin/tag-candidates failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── E2: PATCH /:id — approve or reject a single candidate ──────────
// approve: $addToSet candidate_value onto taxonomy[tag_field] and
// invalidate the Redis cache so the next research job sees the new
// term. reject: status flip only.
//
// Each candidate.tag_field maps to a taxonomy field whose shape is
// either a flat string[] ('string') or an array of {key,...} objects
// ('object'). Object-shape candidates (e.g. price_band) carry their
// payload as a JSON string in candidate_value; we parse + validate
// it has at least a `key` before promoting.
const TAG_FIELD_MAP = {
  cuisine_primary:         { taxonomy_field: 'cuisine_primary',         shape: 'string' },
  vibe_tags:               { taxonomy_field: 'vibe_tags',               shape: 'string' },
  meal_contexts:           { taxonomy_field: 'meal_contexts',           shape: 'string' },
  service_modes:           { taxonomy_field: 'service_modes',           shape: 'string' },
  dietary_flags:           { taxonomy_field: 'dietary_flags',           shape: 'string' },
  specialty_tags_approved: { taxonomy_field: 'specialty_tags_approved', shape: 'string' },
  veg_status:              { taxonomy_field: 'veg_status_options',      shape: 'string' },
  price_band:              { taxonomy_field: 'price_bands',             shape: 'object' },
};

router.patch('/:id', ...requireRole(['super_admin']), async (req, res) => {
  try {
    const { action } = req.body || {};
    if (action !== 'approve' && action !== 'reject') {
      return res.status(400).json({ error: 'action must be "approve" or "reject"' });
    }

    const existing = await col('tag_candidates').findOne({ _id: req.params.id });
    if (!existing) return res.status(404).json({ error: 'Tag candidate not found' });

    const db = await connect();

    if (action === 'approve') {
      const mapping = TAG_FIELD_MAP[existing.tag_field];
      if (!mapping) {
        return res.status(400).json({ error: 'Unknown tag_field — cannot promote' });
      }

      let promotedValue;
      if (mapping.shape === 'object') {
        // price_band candidates carry the full band object as a JSON
        // string in candidate_value. Parse + validate before pushing.
        try {
          promotedValue = JSON.parse(existing.candidate_value);
        } catch (_e) {
          return res.status(400).json({ error: 'price_band candidate_value must be a JSON object string with a key field' });
        }
        if (!promotedValue || typeof promotedValue !== 'object' || !promotedValue.key) {
          return res.status(400).json({ error: 'price_band candidate_value must be a JSON object string with a key field' });
        }
      } else {
        // string-shape: addToSet the raw candidate_value.
        promotedValue = existing.candidate_value;
      }

      await col('platform_settings').updateOne(
        { _id: 'tag_taxonomy' },
        {
          $addToSet: { [mapping.taxonomy_field]: promotedValue },
          $set: { updated_at: new Date() },
        },
      );

      // Invalidate the in-memory taxonomy cache so the next research
      // job (and the /tags PATCH endpoint) sees the new term.
      try {
        await redisClient.del('captain:taxonomy');
      } catch (e) {
        log.warn({ err: e.message }, 'redis del captain:taxonomy failed');
      }

      await col('tag_candidates').updateOne(
        { _id: existing._id },
        {
          $set: {
            status: 'approved',
            approved_at: new Date(),
            approved_by: req.adminUser?._id,
          },
        },
      );

      logAdminAction(
        db,
        req.adminUser?._id,
        'tag_candidate_approved',
        'tag_candidate',
        existing._id,
        null,
        existing,
        { ...existing, status: 'approved' },
        req.ip,
      );
    } else {
      await col('tag_candidates').updateOne(
        { _id: existing._id },
        {
          $set: {
            status: 'rejected',
            rejected_at: new Date(),
            rejected_by: req.adminUser?._id,
          },
        },
      );

      logAdminAction(
        db,
        req.adminUser?._id,
        'tag_candidate_rejected',
        'tag_candidate',
        existing._id,
        null,
        existing,
        { ...existing, status: 'rejected' },
        req.ip,
      );
    }

    res.json({ success: true });
  } catch (err) {
    log.error({ err }, 'PATCH /api/admin/tag-candidates/:id failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
