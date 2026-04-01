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

const metaConfig = {
  // ── Tokens ──────────────────────────────────────────────────
  // Primary token — used for ALL Meta API calls (messaging + catalog + business)
  get systemUserToken() { return process.env.META_SYSTEM_USER_TOKEN; },

  // Catalog token: META_CATALOG_TOKEN if explicitly set, otherwise same as system user token.
  // WA_CATALOG_TOKEN is deliberately NOT checked — it was a legacy User Token that expires.
  get catalogToken() {
    if (process.env.META_CATALOG_TOKEN && process.env.META_CATALOG_TOKEN !== process.env.META_SYSTEM_USER_TOKEN) {
      console.warn('[MetaConfig] META_CATALOG_TOKEN is set separately from META_SYSTEM_USER_TOKEN — ensure both are valid System User tokens');
    }
    return process.env.META_CATALOG_TOKEN || process.env.META_SYSTEM_USER_TOKEN;
  },

  // ── App credentials (OAuth flow during Embedded Signup only) ──
  get appId()     { return process.env.META_APP_ID; },
  get appSecret() { return process.env.META_APP_SECRET; },

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

  /** Token for Catalog / Commerce API calls. Falls back to systemUserToken. */
  getCatalogToken() {
    const t = this.catalogToken;
    if (!t) throw new Error('Catalog API is not configured. Please contact support.');
    return t;
  },

  /** Token for Business Management (WABA provisioning, asset assignment) */
  getBusinessToken() {
    return this.getMessagingToken();
  },

  // ── Startup diagnostics ─────────────────────────────────────

  logStatus() {
    const mask = (v) => v ? `set (${v.length} chars)` : '⚠️  NOT SET';
    console.log('[MetaConfig] ──────────────────────────────────');
    console.log('[MetaConfig] META_SYSTEM_USER_TOKEN:', mask(this.systemUserToken));
    console.log('[MetaConfig] META_CATALOG_TOKEN:',
      process.env.META_CATALOG_TOKEN
        ? mask(process.env.META_CATALOG_TOKEN)
        : `not set → using META_SYSTEM_USER_TOKEN`);
    if (process.env.WA_CATALOG_TOKEN) {
      console.warn('[MetaConfig] ⚠️  WA_CATALOG_TOKEN is set but IGNORED — remove it from env vars to avoid confusion');
    }
    console.log('[MetaConfig] META_APP_ID:', mask(this.appId));
    console.log('[MetaConfig] META_APP_SECRET:', mask(this.appSecret));
    console.log('[MetaConfig] META_BUSINESS_ID:', this.businessId || '⚠️  NOT SET');
    console.log('[MetaConfig] API Version:', this.apiVersion);
    console.log('[MetaConfig] ──────────────────────────────────');

    // Token validation is LAZY — only runs when explicitly called (e.g., /api/webhook-health).
    // It does NOT run on cold starts to avoid adding 10-30s of latency to webhook processing.
    // If the token is invalid, Meta API calls will fail with 401 — that's sufficient feedback.
    console.log('[MetaConfig] Token validation: lazy (call verifyToken() or hit /api/webhook-health to check)');
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
      console.warn('[MetaConfig] No META_BUSINESS_ID — cannot assign catalog admin');
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
        console.log(`[MetaConfig] Assigning catalog ${catalogId} admin to system_user ${userId}`);
        await axios.post(`${this.graphUrl}/${catalogId}/assigned_users`, {
          user: userId,
          tasks: JSON.stringify(tasks),
        }, { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 });
        this._adminCache.add(catalogId);
        console.log(`[MetaConfig] ✅ Admin access granted for catalog ${catalogId}`);
        return true;
      }
    } catch (e) {
      console.warn('[MetaConfig] System user assignment failed:', e.response?.data?.error?.message || e.message);
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
        console.log(`[MetaConfig] Assigning catalog ${catalogId} admin to business_user ${userId}`);
        await axios.post(`${this.graphUrl}/${catalogId}/assigned_users`, {
          user: userId,
          tasks: JSON.stringify(tasks),
        }, { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 });
        this._adminCache.add(catalogId);
        console.log(`[MetaConfig] ✅ Admin access granted for catalog ${catalogId}`);
        return true;
      }
    } catch (e) {
      console.warn('[MetaConfig] Business user assignment failed:', e.response?.data?.error?.message || e.message);
    }

    console.error(`[MetaConfig] ❌ Could not assign admin access for catalog ${catalogId}`);
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

      console.log('[MetaConfig] Token valid:', d.is_valid, '| Type:', d.type,
        '| Expires:', d.expires_at === 0 ? 'Never' : new Date(d.expires_at * 1000).toISOString());
      console.log('[MetaConfig] Scopes:', (d.scopes || []).join(', '));
      if (missing.length) console.warn('[MetaConfig] ⚠️  MISSING SCOPES:', missing.join(', '));
      else console.log('[MetaConfig] ✅ All required scopes present');

      return { valid: d.is_valid, type: d.type, scopes: d.scopes, missingScopes: missing, expiresAt: d.expires_at };
    } catch (err) {
      // Distinguish timeout/network errors from explicit auth failures
      const metaError = err.response?.data?.error;
      if (metaError && (err.response?.status === 401 || metaError.code === 190)) {
        // Meta explicitly says token is invalid — this IS a real problem
        console.error('[MetaConfig] ❌ TOKEN INVALID (Meta confirmed):', metaError.message);
        return { valid: false, error: metaError.message };
      }
      // Timeout or network error — token is likely fine, just couldn't verify
      console.warn('[MetaConfig] ⚠️ Token validation timed out or network error — proceeding with token (likely valid):', err.message);
      return { valid: true, error: null, unverified: true };
    }
  },
};

module.exports = metaConfig;
