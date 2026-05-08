// src/routes/petpoojaIntegration.js
//
// Petpooja integration management. Two distinct concerns mounted under
// the same router:
//   (A) Admin-facing CRUD for restaurant_integrations rows — one row per
//       (branch_id, platform: 'petpooja'). Stores the four credentials
//       Petpooja's APIs need.
//   (B) Inbound store-status endpoints — Petpooja calls these (no auth)
//       to read or write the per-branch is_open flag, so a restaurant
//       toggling closed in Petpooja's UI propagates to our customer
//       order routing in the WhatsApp flow.
//
// Mount in ec2-server.js as a separate change. No menu sync logic here
// (intentionally) — that lives in the dedicated petpoojaSync service
// when it's added.

'use strict';

const express = require('express');
const router = express.Router();

const { v4: uuidv4 } = require('uuid');
const { col } = require('../config/database');
const { requireAdminAuth } = require('../middleware/adminAuth');
const memcache = require('../config/memcache');
const log = require('../utils/logger').child({ component: 'PetpoojaIntegration' });

const requireAdmin = requireAdminAuth();

// ─── HELPERS ────────────────────────────────────────────────
function maskSecret(secret) {
  if (typeof secret !== 'string' || secret.length === 0) return secret;
  if (secret.length <= 4) return '****';
  return `${secret.slice(0, 4)}****`;
}

// ═══════════════════════════════════════════════════════════
// SECTION A: ADMIN CRUD
// ═══════════════════════════════════════════════════════════

// GET /branches/:branchId/integration
// Returns the current Petpooja integration for a branch with the
// app_secret masked. 404 when no row exists.
router.get('/branches/:branchId/integration', requireAdmin, async (req, res) => {
  try {
    const { branchId } = req.params;
    const integration = await col('restaurant_integrations').findOne({
      platform: 'petpooja',
      branch_id: branchId,
    });
    if (!integration) {
      return res.status(404).json({ error: 'No Petpooja integration for this branch' });
    }
    return res.json({
      ...integration,
      app_secret: maskSecret(integration.app_secret),
    });
  } catch (err) {
    log.error({ err: err?.message, branchId: req.params.branchId }, 'GET integration failed');
    return res.status(500).json({ error: 'Failed to load integration' });
  }
});

// POST /branches/:branchId/integration
// Upsert the credential set. All four fields are required and must be
// non-empty strings. is_active resets to true on every write so a
// previously soft-deleted row reactivates when the operator re-saves.
router.post('/branches/:branchId/integration', requireAdmin, express.json(), async (req, res) => {
  try {
    const { branchId } = req.params;
    const { app_key, app_secret, access_token, outlet_id } = req.body || {};

    const fields = { app_key, app_secret, access_token, outlet_id };
    for (const [name, value] of Object.entries(fields)) {
      if (typeof value !== 'string' || !value.trim()) {
        return res.status(400).json({ error: `${name} is required` });
      }
    }

    const branch = await col('branches').findOne({ _id: branchId });
    if (!branch) {
      return res.status(404).json({ error: 'Branch not found' });
    }

    const now = new Date();
    const result = await col('restaurant_integrations').updateOne(
      { platform: 'petpooja', branch_id: branchId },
      {
        $set: {
          app_key: app_key.trim(),
          app_secret: app_secret.trim(),
          access_token: access_token.trim(),
          outlet_id: outlet_id.trim(),
          platform: 'petpooja',
          branch_id: branchId,
          is_active: true,
          updated_at: now,
        },
        $setOnInsert: {
          _id: uuidv4(),
          created_at: now,
        },
      },
      { upsert: true },
    );

    log.info(
      { branchId, upserted: result.upsertedCount > 0, modified: result.modifiedCount },
      'petpooja integration upserted',
    );

    return res.json({ success: true, upserted: result.upsertedCount > 0 });
  } catch (err) {
    log.error({ err: err?.message, branchId: req.params.branchId }, 'POST integration failed');
    return res.status(500).json({ error: 'Failed to save integration' });
  }
});

// DELETE /branches/:branchId/integration
// Soft delete only — flips is_active to false so the row stays in place
// for audit. Re-activating just means re-POSTing the credentials.
router.delete('/branches/:branchId/integration', requireAdmin, async (req, res) => {
  try {
    const { branchId } = req.params;
    await col('restaurant_integrations').updateOne(
      { platform: 'petpooja', branch_id: branchId },
      { $set: { is_active: false, updated_at: new Date() } },
    );
    log.info({ branchId }, 'petpooja integration deactivated');
    return res.json({ success: true });
  } catch (err) {
    log.error({ err: err?.message, branchId: req.params.branchId }, 'DELETE integration failed');
    return res.status(500).json({ error: 'Failed to deactivate integration' });
  }
});

// ═══════════════════════════════════════════════════════════
// SECTION B: STORE STATUS (NO AUTH — called by Petpooja)
// ═══════════════════════════════════════════════════════════

// Resolve the (integration, branch) pair from Petpooja's restID. Returns
// { integration, branch } or null when either lookup misses; callers
// translate null into the Petpooja-shaped error response.
async function _resolveStore(restID) {
  if (!restID) return null;
  const integration = await col('restaurant_integrations').findOne({
    platform: 'petpooja',
    outlet_id: restID,
    is_active: true,
  });
  if (!integration) return null;
  const branch = await col('branches').findOne({ _id: integration.branch_id });
  if (!branch) return null;
  return { integration, branch };
}

// GET /store-status
// Petpooja sends restID in body OR query — accept both. Response shape
// matches Petpooja's documented contract exactly: '1' = open, '0' = closed.
router.get('/store-status', express.json(), async (req, res) => {
  try {
    const restID = req.body?.restID || req.query?.restID;
    const found = await _resolveStore(restID);
    if (!found) {
      return res.json({ code: '400', status: 'failed', message: 'Store not found' });
    }
    return res.json({
      status: 'success',
      store_status: found.branch.is_open ? '1' : '0',
      http_code: '200',
      message: 'ok',
    });
  } catch (err) {
    log.error({ err: err?.message }, 'GET /store-status failed');
    return res.json({ code: '500', status: 'failed', message: 'Internal error' });
  }
});

// POST /store-status
// Petpooja toggles the store open/closed and we mirror it onto the
// branch doc. is_open is the canonical flag the WhatsApp customer flow
// reads to decide if a branch can take orders.
router.post('/store-status', express.json(), async (req, res) => {
  try {
    const { restID, store_status, reason, turn_on_time } = req.body || {};
    const found = await _resolveStore(restID);
    if (!found) {
      return res.json({ code: '400', status: 'failed', message: 'Store not found' });
    }
    const { branch } = found;

    await col('branches').updateOne(
      { _id: branch._id },
      { $set: {
          is_open: store_status === '1',
          updated_at: new Date(),
        } },
    );

    // Cache invalidation — owner-dashboard / customer-flow read paths
    // cache the branches list keyed by restaurant_id. Swallow errors so
    // a Redis hiccup doesn't fail a status update Petpooja is retrying.
    try {
      memcache.del(`restaurant:${branch.restaurant_id}:branches`);
    } catch (_) { /* swallow */ }

    log.info(
      { branchId: branch._id, store_status, reason, turn_on_time },
      'petpooja: store status updated',
    );

    return res.json({
      status: 'success',
      store_status,
      message: 'Store status updated',
      http_code: '200',
    });
  } catch (err) {
    log.error({ err: err?.message }, 'POST /store-status failed');
    return res.json({ code: '500', status: 'failed', message: 'Internal error' });
  }
});

module.exports = router;
