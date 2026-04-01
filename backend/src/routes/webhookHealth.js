// src/routes/webhookHealth.js
// Diagnostic endpoint: GET /api/webhook-health?key=WEBHOOK_HEALTH_KEY
// Returns a JSON report on the full WhatsApp webhook pipeline health.

'use strict';

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { col } = require('../config/database');
const metaConfig = require('../config/meta');

// ─── AUTH ────────────────────────────────────────────────────
router.use((req, res, next) => {
  const key = req.query.key;
  const secret = process.env.WEBHOOK_HEALTH_KEY;
  if (!secret || key !== secret) {
    return res.status(401).json({ error: 'Unauthorized — provide ?key=WEBHOOK_HEALTH_KEY' });
  }
  next();
});

// ─── MAIN HEALTH CHECK ──────────────────────────────────────
router.get('/', async (req, res) => {
  const checks = {};
  let overall = 'HEALTHY';

  const flag = (check, status) => {
    if (status === 'error' && overall !== 'CRITICAL') overall = 'CRITICAL';
    if (status === 'warning' && overall === 'HEALTHY') overall = 'WARNING';
    return status;
  };

  // ── Check 1: Meta Token Validity ──────────────────────────
  try {
    const token = metaConfig.systemUserToken;
    if (!token) {
      checks.meta_token = { status: flag('meta_token', 'error'), details: { message: 'META_SYSTEM_USER_TOKEN not set' } };
    } else {
      const { data } = await axios.get(`${metaConfig.graphUrl}/debug_token`, {
        params: { input_token: token, access_token: token },
        timeout: 8000,
      });
      const d = data.data || {};
      const isValid = d.is_valid !== false;
      const expiresAt = d.expires_at === 0 ? 'Never' : d.expires_at ? new Date(d.expires_at * 1000).toISOString() : 'Unknown';
      checks.meta_token = {
        status: flag('meta_token', isValid ? 'ok' : 'error'),
        details: { valid: isValid, expires: expiresAt, scopes: d.scopes || [], app_id: d.app_id },
      };
    }
  } catch (e) {
    checks.meta_token = { status: flag('meta_token', 'error'), details: { message: e.response?.data?.error?.message || e.message } };
  }

  // ── Check 2: Webhook Subscription Status ──────────────────
  try {
    const appId = metaConfig.appId;
    const appSecret = metaConfig.appSecret;
    if (!appId || !appSecret) {
      checks.webhook_subscription = { status: flag('webhook_subscription', 'warning'), details: { message: 'META_APP_ID or META_APP_SECRET not set' } };
    } else {
      const appToken = `${appId}|${appSecret}`;
      const { data } = await axios.get(`${metaConfig.graphUrl}/${appId}/subscriptions`, {
        params: { access_token: appToken },
        timeout: 8000,
      });
      const waSub = (data.data || []).find(s => s.object === 'whatsapp_business_account');
      if (waSub) {
        const msgField = (waSub.fields || []).find(f => f.name === 'messages');
        checks.webhook_subscription = {
          status: flag('webhook_subscription', waSub.active ? 'ok' : 'warning'),
          details: { active: waSub.active, callback_url: waSub.callback_url, messages_subscribed: !!msgField },
        };
      } else {
        checks.webhook_subscription = { status: flag('webhook_subscription', 'error'), details: { message: 'No WhatsApp subscription found' } };
      }
    }
  } catch (e) {
    checks.webhook_subscription = { status: flag('webhook_subscription', 'warning'), details: { message: e.response?.data?.error?.message || e.message } };
  }

  // ── Check 3: Last Webhook Received ────────────────────────
  try {
    const lastLog = await col('webhook_logs').findOne({}, { sort: { received_at: -1 }, projection: { received_at: 1, source: 1, event_type: 1 } });
    if (lastLog?.received_at) {
      const ago = Date.now() - new Date(lastLog.received_at).getTime();
      const agoText = ago < 60000 ? `${Math.round(ago / 1000)}s ago`
        : ago < 3600000 ? `${Math.round(ago / 60000)}m ago`
        : ago < 86400000 ? `${Math.round(ago / 3600000)}h ago`
        : `${Math.round(ago / 86400000)}d ago`;
      const severity = ago > 6 * 3600000 ? 'error' : ago > 3600000 ? 'warning' : 'ok';
      checks.last_webhook = {
        status: flag('last_webhook', severity),
        details: { received_at: lastLog.received_at, ago: agoText, source: lastLog.source, event_type: lastLog.event_type },
      };
    } else {
      checks.last_webhook = { status: flag('last_webhook', 'warning'), details: { message: 'No webhook logs found' } };
    }
  } catch (e) {
    checks.last_webhook = { status: flag('last_webhook', 'warning'), details: { message: e.message } };
  }

  // ── Check 4: WABA Phone Number Status ─────────────────────
  try {
    const waAccount = await col('whatsapp_accounts').findOne({ is_active: true }, { projection: { phone_number_id: 1, waba_id: 1 } });
    if (!waAccount?.phone_number_id) {
      checks.phone_number = { status: flag('phone_number', 'warning'), details: { message: 'No active WhatsApp account found' } };
    } else {
      const token = metaConfig.getMessagingToken();
      const { data } = await axios.get(`${metaConfig.graphUrl}/${waAccount.phone_number_id}`, {
        params: { fields: 'verified_name,quality_rating,messaging_limit_tier,display_phone_number,status', access_token: token },
        timeout: 8000,
      });
      checks.phone_number = {
        status: flag('phone_number', data.quality_rating === 'GREEN' ? 'ok' : data.quality_rating === 'YELLOW' ? 'warning' : 'error'),
        details: {
          phone_number_id: waAccount.phone_number_id,
          display_phone_number: data.display_phone_number,
          verified_name: data.verified_name,
          quality_rating: data.quality_rating,
          messaging_limit_tier: data.messaging_limit_tier,
          status: data.status,
        },
      };
    }
  } catch (e) {
    checks.phone_number = { status: flag('phone_number', 'warning'), details: { message: e.response?.data?.error?.message || e.message } };
  }

  // ── Check 5: Recent Error Rate (24h) ──────────────────────
  try {
    const since = new Date(Date.now() - 24 * 3600000);
    const errorCount = await col('activity_logs').countDocuments({
      severity: { $in: ['error', 'critical'] },
      created_at: { $gte: since },
    });
    const lastError = await col('activity_logs').findOne(
      { severity: { $in: ['error', 'critical'] }, created_at: { $gte: since } },
      { sort: { created_at: -1 }, projection: { action: 1, description: 1, created_at: 1 } }
    );
    checks.error_rate = {
      status: flag('error_rate', errorCount > 50 ? 'error' : errorCount > 10 ? 'warning' : 'ok'),
      details: { errors_24h: errorCount, last_error: lastError ? { action: lastError.action, description: lastError.description, at: lastError.created_at } : null },
    };
  } catch (e) {
    checks.error_rate = { status: flag('error_rate', 'warning'), details: { message: e.message } };
  }

  // ── Summary ───────────────────────────────────────────────
  const issues = Object.entries(checks).filter(([, v]) => v.status !== 'ok').map(([k, v]) => `${k}: ${v.details?.message || v.status}`);
  const summary = issues.length ? issues.join('; ') : 'All checks passed — webhook pipeline is healthy';

  res.json({ status: overall, timestamp: new Date().toISOString(), checks, summary });
});

module.exports = router;
