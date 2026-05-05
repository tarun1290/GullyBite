// src/jobs/templateSync.js
// Daily sync of Meta template statuses into the local templates collection.
//
// Why: services/template.js exposes syncTemplates(wabaId) but nothing
// schedules it. If Meta PAUSES or REJECTS a template (quality flag, policy
// violation), the local templates.status stays at APPROVED and restaurants
// keep mapping / sending it. Sends fail; the text-fallback in
// notifyOrderStatus rescues the customer message but the merchant has no
// signal that their template is dead. This cron narrows that window to
// at most 24h.
//
// Scope:
//   - All distinct waba_id values from whatsapp_accounts where
//     is_active=true (one sync call per WABA, deduped)
//   - GullyBite's central WABA via process.env.META_WABA_ID (where
//     campaign / cross-tenant templates live). Skipped silently if the
//     env var is not set.
//
// Schedule: 02:00 IST daily — quiet window, well after the last
// settlement run, no contention with live order traffic.
//
// Idempotent: syncTemplates is itself an upsert + status-flip; running
// twice in a row is a no-op against unchanged Meta state.

'use strict';

const cron = require('node-cron');
const { col } = require('../config/database');
const templateSvc = require('../services/template');
const log = require('../utils/logger').child({ component: 'templateSync' });

// Cron expression. Override via TEMPLATE_SYNC_CRON for ad-hoc tuning.
const CRON_EXPR = process.env.TEMPLATE_SYNC_CRON || '0 2 * * *';

async function _collectWabaIds() {
  const ids = new Set();

  // Restaurant-owned WABAs from whatsapp_accounts.
  try {
    const rows = await col('whatsapp_accounts').find(
      { is_active: true, waba_id: { $exists: true, $ne: null } },
      { projection: { waba_id: 1 } }
    ).toArray();
    for (const r of rows) {
      if (r.waba_id) ids.add(String(r.waba_id));
    }
  } catch (err) {
    log.error({ err: err?.message }, 'template_sync.collect_restaurant_wabas_failed');
  }

  // GullyBite's central WABA (campaign templates / shared library).
  // Env-gated: ops sets META_WABA_ID once; absent → skip silently.
  if (process.env.META_WABA_ID) {
    ids.add(String(process.env.META_WABA_ID));
  }

  return [...ids];
}

async function runTemplateSync() {
  const startedAt = Date.now();
  let totalSynced = 0;
  let succeeded = 0;
  let failed = 0;

  let wabaIds;
  try {
    wabaIds = await _collectWabaIds();
  } catch (err) {
    log.error({ err: err?.message }, 'template_sync.collect_failed');
    return { error: err?.message, totalSynced: 0, succeeded: 0, failed: 0 };
  }

  if (!wabaIds.length) {
    log.info('template_sync.skip.no_wabas');
    return { totalSynced: 0, succeeded: 0, failed: 0, wabaCount: 0 };
  }

  log.info({ wabaCount: wabaIds.length }, 'template_sync.start');

  for (const wabaId of wabaIds) {
    try {
      const out = await templateSvc.syncTemplates(wabaId);
      totalSynced += out?.synced || 0;
      succeeded++;
      log.info({ wabaId, synced: out?.synced, total: out?.total }, 'template_sync.waba.ok');
    } catch (err) {
      failed++;
      // Per-WABA failures must not stop the loop. The most common cause
      // is a stale token on a single restaurant — let the others sync.
      log.error({
        err: err?.response?.data?.error?.message || err?.message,
        wabaId,
      }, 'template_sync.waba.failed');
    }
  }

  // Auto-glue: hydrate campaign_templates.meta_approval_status from the
  // local templates collection that syncTemplates just refreshed. The
  // campaign-template flow only sees Meta state through this mirror —
  // without the sweep, the marketing dashboard's
  // {is_active, meta_approval_status:'approved'} filter never lights up
  // because nothing else flips that field.
  let approvedSynced = 0;
  let rejectedSynced = 0;
  try {
    const linkedTemplates = await col('templates').find(
      { meta_id: { $exists: true, $ne: null } },
      { projection: { meta_id: 1, status: 1, rejection_reason: 1 } },
    ).toArray();

    for (const tpl of linkedTemplates) {
      if (tpl.status === 'APPROVED') {
        const r = await col('campaign_templates').updateOne(
          { meta_template_id: tpl.meta_id },
          { $set: { meta_approval_status: 'approved', approved_at: new Date(), updated_at: new Date() } },
        );
        if (r.modifiedCount) approvedSynced++;
      } else if (tpl.status === 'REJECTED') {
        const r = await col('campaign_templates').updateOne(
          { meta_template_id: tpl.meta_id },
          { $set: {
              meta_approval_status: 'rejected',
              rejection_reason: tpl.rejection_reason || 'unknown',
              updated_at: new Date(),
            } },
        );
        if (r.modifiedCount) rejectedSynced++;
      }
    }
    log.info({ approved: approvedSynced, rejected: rejectedSynced }, `auto-glue: synced ${approvedSynced} approved, ${rejectedSynced} rejected to campaign_templates`);
  } catch (err) {
    log.error({ err: err?.message }, 'template_sync.auto_glue.failed');
  }

  const elapsedMs = Date.now() - startedAt;
  log.info({
    wabaCount: wabaIds.length, succeeded, failed, totalSynced,
    autoGlueApproved: approvedSynced, autoGlueRejected: rejectedSynced,
    elapsedMs,
  }, 'template_sync.done');
  return {
    wabaCount: wabaIds.length, succeeded, failed, totalSynced,
    autoGlueApproved: approvedSynced, autoGlueRejected: rejectedSynced,
    elapsedMs,
  };
}

function scheduleTemplateSync() {
  cron.schedule(CRON_EXPR, () => {
    runTemplateSync().catch(err => log.error({ err }, 'template_sync.cron.unhandled'));
  }, { timezone: 'Asia/Kolkata' });
  log.info({ cron: CRON_EXPR }, 'template sync cron scheduled');
}

module.exports = { scheduleTemplateSync, runTemplateSync };
