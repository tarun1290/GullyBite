// src/webhooks/catalog.js
// Handles Meta Catalog API webhook events:
//   - items_batch  : fires when a batch upload completes (success/failure per item)
//   - product_feed : fires when a product feed is processed

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const db      = require('../config/database');

// ─── GET: WEBHOOK VERIFICATION ────────────────────────────────
// Meta calls this once when you configure the webhook URL.
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('[Catalog Webhook] Verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── POST: CATALOG EVENTS ─────────────────────────────────────
router.post('/', express.raw({ type: '*/*' }), async (req, res) => {
  // Respond immediately — Meta will retry if we take >5s
  res.sendStatus(200);

  try {
    // Verify HMAC-SHA256 signature using App Secret
    const sig      = req.headers['x-hub-signature-256']?.split('sha256=')[1];
    const expected = crypto
      .createHmac('sha256', process.env.META_APP_SECRET)
      .update(req.body)
      .digest('hex');

    if (!sig || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
      console.warn('[Catalog Webhook] Invalid signature — ignoring');
      return;
    }

    const body = JSON.parse(req.body.toString());

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const field = change.field;
        const value = change.value;

        if (field === 'items_batch') {
          await handleItemsBatch(entry.id, value);
        } else if (field === 'product_feed') {
          await handleProductFeed(entry.id, value);
        } else {
          console.log(`[Catalog Webhook] Unhandled field: ${field}`);
        }
      }
    }
  } catch (err) {
    console.error('[Catalog Webhook] Error:', err.message);
  }
});

// ─── items_batch handler ──────────────────────────────────────
// Fires after each batch push to /{catalog_id}/batch
// value = { catalog_id, event_type, errors: [...] }
const handleItemsBatch = async (catalogId, value) => {
  const { event_type, errors = [] } = value;

  if (errors.length > 0) {
    console.warn(`[Catalog] Batch errors for catalog ${catalogId}:`, JSON.stringify(errors));

    // Mark the branch sync as having errors so dashboard can show a warning
    await db.query(
      `UPDATE branches
         SET catalog_synced_at = NOW(),
             catalog_sync_error = $2
       WHERE catalog_id = $1`,
      [catalogId, `Batch errors: ${errors.map(e => e.message || JSON.stringify(e)).join('; ')}`]
    ).catch(() => {}); // non-fatal if column doesn't exist yet
  } else {
    console.log(`[Catalog] Batch ${event_type} completed for catalog ${catalogId}`);

    await db.query(
      `UPDATE branches
         SET catalog_synced_at = NOW(),
             catalog_sync_error = NULL
       WHERE catalog_id = $1`,
      [catalogId]
    ).catch(() => {});
  }
};

// ─── product_feed handler ─────────────────────────────────────
// Fires when a product feed upload/schedule is processed by Meta
// value = { catalog_id, feed_id, event_type, status, errors: [...] }
const handleProductFeed = async (catalogId, value) => {
  const { feed_id, event_type, status, errors = [] } = value;

  console.log(`[Catalog] Feed ${feed_id} event="${event_type}" status="${status}" catalog=${catalogId}`);

  if (errors.length > 0) {
    console.warn(`[Catalog] Feed errors:`, JSON.stringify(errors));
  }

  // Update branch sync timestamp on successful feed processing
  if (status === 'complete' || status === 'completed') {
    await db.query(
      `UPDATE branches
         SET catalog_synced_at = NOW(),
             catalog_sync_error = NULL
       WHERE catalog_id = $1`,
      [catalogId]
    ).catch(() => {});
  }
};

module.exports = router;
