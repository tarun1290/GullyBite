// src/services/marketingWaVerification.js
// Verifies a restaurant's marketing WhatsApp number against Meta.
// Separate from the ordering WABA health checks — this covers only
// the number the restaurant enters manually in Settings. Runs on a
// nightly cron plus fire-and-forget after each Save in Settings.

'use strict';

const axios = require('axios');
const { col } = require('../config/database');
const metaConfig = require('../config/meta');
const log = require('../utils/logger').child({ component: 'marketing-wa-verify' });

// Meta's /phone_number status values that we treat as healthy.
const HEALTHY_STATUSES = new Set(['CONNECTED', 'VERIFIED']);

async function _persist(restaurantId, $set) {
  await col('restaurants').updateOne(
    { _id: restaurantId },
    { $set: { ...$set, updated_at: new Date() } },
  );
}

async function verifyMarketingWaNumber(restaurantId) {
  const now = new Date();
  try {
    const r = await col('restaurants').findOne(
      { _id: restaurantId },
      {
        projection: {
          marketing_wa_phone_number_id: 1,
          marketing_wa_waba_id: 1,
        },
      },
    );
    if (!r) {
      return { status: 'error', quality_rating: null };
    }

    const phoneNumberId = r.marketing_wa_phone_number_id;
    const wabaId = r.marketing_wa_waba_id;

    if (!phoneNumberId || !wabaId) {
      await _persist(restaurantId, {
        marketing_wa_status: 'not_configured',
        marketing_wa_last_checked_at: now,
        marketing_wa_error_message: null,
      });
      return { status: 'not_configured', quality_rating: null };
    }

    let resp;
    try {
      resp = await axios.get(`${metaConfig.graphUrl}/${encodeURIComponent(phoneNumberId)}`, {
        params: { fields: 'verified_name,code_verification_status,quality_rating,status' },
        headers: { Authorization: `Bearer ${metaConfig.systemUserToken}` },
        timeout: 10000,
      });
    } catch (err) {
      const code = err?.response?.status;
      if (code === 400 || code === 404) {
        const msg = err?.response?.data?.error?.message || `Meta API error ${code}`;
        await _persist(restaurantId, {
          marketing_wa_status: 'error',
          marketing_wa_last_checked_at: now,
          marketing_wa_error_message: msg,
        });
        return { status: 'error', quality_rating: null };
      }
      log.warn({ err: err?.message, restaurantId }, 'marketing wa verification network error');
      await _persist(restaurantId, {
        marketing_wa_status: 'error',
        marketing_wa_last_checked_at: now,
        marketing_wa_error_message: 'Verification request failed',
      });
      return { status: 'error', quality_rating: null };
    }

    const data = resp?.data || {};
    const statusValue = String(data.status || '').toUpperCase();
    const qualityRating = data.quality_rating || null;

    if (HEALTHY_STATUSES.has(statusValue)) {
      await _persist(restaurantId, {
        marketing_wa_status: 'active',
        marketing_wa_quality_rating: qualityRating,
        marketing_wa_verified_at: now,
        marketing_wa_last_checked_at: now,
        marketing_wa_error_message: null,
      });
      return { status: 'active', quality_rating: qualityRating };
    }

    // Non-healthy but the API returned — FLAGGED / RESTRICTED / etc.
    await _persist(restaurantId, {
      marketing_wa_status: 'flagged',
      marketing_wa_quality_rating: qualityRating,
      marketing_wa_last_checked_at: now,
      marketing_wa_error_message: statusValue || 'unknown_status',
    });
    return { status: 'flagged', quality_rating: qualityRating };
  } catch (err) {
    log.error({ err: err?.message, restaurantId }, 'marketing wa verification crashed');
    try {
      await _persist(restaurantId, {
        marketing_wa_status: 'error',
        marketing_wa_last_checked_at: new Date(),
        marketing_wa_error_message: 'Verification failed unexpectedly',
      });
    } catch { /* swallow — we never throw to caller */ }
    return { status: 'error', quality_rating: null };
  }
}

module.exports = { verifyMarketingWaNumber };
