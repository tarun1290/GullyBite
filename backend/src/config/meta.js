// src/config/meta.js
// Centralized Meta API configuration — single source of truth for all tokens.
//
// A single System User token handles ALL Meta API operations:
//   - WhatsApp Cloud API (messaging, templates, phone registration)
//   - Catalog / Commerce API (create catalog, sync products, product sets)
//   - Business Management API (WABA provisioning, asset management)
//
// Required scopes when generating the token:
//   whatsapp_business_messaging, whatsapp_business_management,
//   catalog_management, business_management
//
// Generate at: Business Manager -> System Users -> [your user] -> Generate Token

'use strict';

const axios = require('axios');
const log = require('../utils/logger').child({ component: 'meta' });

const metaConfig = {
  // ── Tokens ──────────────────────────────────────────────────
  // Single source of truth for ALL Meta API calls (messaging + catalog + business).
  // Any legacy *_CATALOG_TOKEN env vars are deliberately NOT read here — they were
  // User tokens that expire, and supporting them invited silent misconfiguration.
  get systemUserToken() { return process.env.META_SYSTEM_USER_TOKEN; },

  // ── App credentials (OAuth flow during Embedded Signup only) ──
  get appId()     { return process.env.META_APP_ID; },
  get appSecret() { return process.env.META_APP_SECRET; },

  // Meta Embedded Signup config ID — created in Meta App Dashboard
  // → WhatsApp → Configuration → Login Configuration. Frontend uses it
  // as `config_id` in FB.login() to launch the WABA signup flow.
  get loginConfigId() { return process.env.META_LOGIN_CONFIG_ID; },

  // ── Business / API ──────────────────────────────────────────
  get businessId()  { return process.env.META_BUSINESS_ID; },
  get apiVersion()  { return process.env.WA_API_VERSION || 'v25.0'; },

  // Graph API base URL
  get graphUrl() { return `https://graph.facebook.com/${this.apiVersion}`; },

  // ── Token getters (with validation) ─────────────────────────

  /** Token for WhatsApp messaging, templates, phone registration */
  getMessagingToken() {
    const t = this.systemUserToken;
    if (!t) throw new Error('WhatsApp messaging is not configured. Please contact support.');
    return t;
  },

  /** Token for Catalog / Commerce API calls. Uses the single System User token. */
  getCatalogToken() {
    const t = this.systemUserToken;
    if (!t) throw new Error(
      'META_SYSTEM_USER_TOKEN is not set. Set a System User token with whatsapp_business_messaging, ' +
      'whatsapp_business_management, catalog_management, and business_management scopes before starting the server.'
    );
    return t;
  },

  /** Token for Business Management (WABA provisioning, asset assignment) */
  getBusinessToken() {
    return this.getMessagingToken();
  },

  // ── Startup diagnostics ─────────────────────────────────────

  logStatus() {
    const mask = (v) => v ? `set (${v.length} chars)` : 'NOT SET';
    log.info({
      systemUserToken: mask(this.systemUserToken),
      appId: mask(this.appId),
      appSecret: mask(this.appSecret),
      loginConfigId: this.loginConfigId || 'NOT SET',
      businessId: this.businessId || 'NOT SET',
      apiVersion: this.apiVersion,
    }, 'Meta config status');
    if (process.env.WA_CATALOG_TOKEN) {
      log.warn('WA_CATALOG_TOKEN is set but IGNORED — remove it from env vars to avoid confusion');
    }

    // Token validation is LAZY — only runs when explicitly called (e.g., /api/webhook-health).
    // It does NOT run on cold starts to avoid adding 10-30s of latency to webhook processing.
    // If the token is invalid, Meta API calls will fail with 401 — that's sufficient feedback.
    log.info('Token validation: lazy (call verifyToken() or hit /api/webhook-health to check)');
  },

  // ── Catalog admin access ─────────────────────────────────────
  // Cache: catalogId → true (assigned this session)
  _adminCache: new Set(),

  /**
   * Ensure the system user has admin access to a catalog.
   * Tries business_users first, then system_users.
   * Caches per catalogId to avoid repeated calls.
   */
  async ensureCatalogAdminAccess(catalogId) {
    if (this._adminCache.has(catalogId)) return true;

    const token = this.getCatalogToken();
    const bizId = this.businessId;
    if (!bizId) {
      log.warn('No META_BUSINESS_ID — cannot assign catalog admin');
      return false;
    }

    const tasks = ['MANAGE', 'MANAGE_AR', 'AA_ANALYZE'];

    // Try 1: Get system users and assign
    try {
      const suRes = await axios.get(`${this.graphUrl}/${bizId}/system_users`, {
        params: { access_token: token },
        timeout: 10000,
      });
      const systemUsers = suRes.data?.data || [];
      if (systemUsers.length) {
        const userId = systemUsers[0].id;
        log.info({ catalogId, userId, userType: 'system_user' }, 'Assigning catalog admin');
        await axios.post(`${this.graphUrl}/${catalogId}/assigned_users`, {
          user: userId,
          tasks: JSON.stringify(tasks),
        }, { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 });
        this._adminCache.add(catalogId);
        log.info({ catalogId }, 'Admin access granted for catalog');
        return true;
      }
    } catch (e) {
      log.warn({ err: e, metaError: e.response?.data?.error?.message }, 'System user assignment failed');
    }

    // Try 2: Get business users and assign
    try {
      const buRes = await axios.get(`${this.graphUrl}/${bizId}/business_users`, {
        params: { access_token: token },
        timeout: 10000,
      });
      const bizUsers = buRes.data?.data || [];
      if (bizUsers.length) {
        const userId = bizUsers[0].id;
        log.info({ catalogId, userId, userType: 'business_user' }, 'Assigning catalog admin');
        await axios.post(`${this.graphUrl}/${catalogId}/assigned_users`, {
          user: userId,
          tasks: JSON.stringify(tasks),
        }, { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 });
        this._adminCache.add(catalogId);
        log.info({ catalogId }, 'Admin access granted for catalog');
        return true;
      }
    } catch (e) {
      log.warn({ err: e, metaError: e.response?.data?.error?.message }, 'Business user assignment failed');
    }

    log.error({ catalogId }, 'Could not assign admin access for catalog');
    return false;
  },

  /** Debug the current system user token — checks scopes, validity, expiry */
  async verifyToken() {
    const token = this.systemUserToken;
    if (!token) return { valid: false, error: 'META_SYSTEM_USER_TOKEN not set' };

    try {
      const res = await axios.get('https://graph.facebook.com/debug_token', {
        params: { input_token: token, access_token: token },
        timeout: 30000, // 30s for cold starts on Vercel
      });
      const d = res.data.data;
      const requiredScopes = [
        'whatsapp_business_messaging', 'whatsapp_business_management',
        'catalog_management', 'business_management',
      ];
      const missing = requiredScopes.filter(s => !d.scopes?.includes(s));

      log.info({
        valid: d.is_valid,
        type: d.type,
        expires: d.expires_at === 0 ? 'Never' : new Date(d.expires_at * 1000).toISOString(),
        scopes: (d.scopes || []).join(', '),
      }, 'Token verification result');
      if (missing.length) log.warn({ missingScopes: missing }, 'Missing required scopes');
      else log.info('All required scopes present');

      return { valid: d.is_valid, type: d.type, scopes: d.scopes, missingScopes: missing, expiresAt: d.expires_at };
    } catch (err) {
      // Distinguish timeout/network errors from explicit auth failures
      const metaError = err.response?.data?.error;
      if (metaError && (err.response?.status === 401 || metaError.code === 190)) {
        // Meta explicitly says token is invalid — this IS a real problem
        log.error({ metaError: metaError.message }, 'TOKEN INVALID (Meta confirmed)');
        return { valid: false, error: metaError.message };
      }
      // Timeout or network error — token is likely fine, just couldn't verify
      log.warn({ err }, 'Token validation timed out or network error — proceeding with token (likely valid)');
      return { valid: true, error: null, unverified: true };
    }
  },
};

// Fail loudly at module load if the single required token is missing.
// Startup-time validation so a missing env var blows up on boot instead of
// silently falling through to 401s from Meta on every catalog/messaging call.
if (!process.env.META_SYSTEM_USER_TOKEN) {
  throw new Error(
    'META_SYSTEM_USER_TOKEN is not set. Set a System User token with whatsapp_business_messaging, ' +
    'whatsapp_business_management, catalog_management, and business_management scopes before starting the server.'
  );
}

module.exports = metaConfig;
