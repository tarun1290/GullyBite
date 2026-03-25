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

  // Legacy: if someone set a dedicated catalog token, prefer it; else fall back to system token
  get catalogToken() { return process.env.META_CATALOG_TOKEN || process.env.WA_CATALOG_TOKEN || process.env.META_SYSTEM_USER_TOKEN; },

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
        : `not set → fallback ${this.systemUserToken ? 'META_SYSTEM_USER_TOKEN' : '⚠️  NONE'}`);
    console.log('[MetaConfig] META_APP_ID:', mask(this.appId));
    console.log('[MetaConfig] META_APP_SECRET:', mask(this.appSecret));
    console.log('[MetaConfig] META_BUSINESS_ID:', this.businessId || '⚠️  NOT SET');
    console.log('[MetaConfig] API Version:', this.apiVersion);
    console.log('[MetaConfig] ──────────────────────────────────');
  },

  /** Debug the current system user token — checks scopes, validity, expiry */
  async verifyToken() {
    const token = this.systemUserToken;
    if (!token) return { valid: false, error: 'META_SYSTEM_USER_TOKEN not set' };

    try {
      const res = await axios.get('https://graph.facebook.com/debug_token', {
        params: { input_token: token, access_token: token },
        timeout: 10000,
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

      return { valid: d.is_valid, scopes: d.scopes, missingScopes: missing, expiresAt: d.expires_at };
    } catch (err) {
      console.error('[MetaConfig] Token debug failed:', err.response?.data?.error?.message || err.message);
      return { valid: false, error: err.response?.data?.error?.message || err.message };
    }
  },
};

module.exports = metaConfig;
