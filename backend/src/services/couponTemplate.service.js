// src/services/couponTemplate.service.js
// Admin-facing management of WhatsApp COUPON templates (Meta category='marketing',
// with a copy_code button) on a specific restaurant's WABA.
//
// Separation from services/template.js is deliberate:
//   • template.js — transactional order-lifecycle templates (utility).
//   • this file   — marketing coupon templates with copy_code button.
// All Meta calls go out through META_SYSTEM_USER_TOKEN via metaConfig.

'use strict';

const axios = require('axios');
const { col } = require('../config/database');
const metaConfig = require('../config/meta');
const { getCached } = require('../config/cache');
const log = require('../utils/logger').child({ component: 'couponTemplate' });

const LIST_TTL_SECONDS = 30 * 60; // 30 minutes
const NAME_RE = /^[a-z0-9_]+$/;

const graphUrl = (p) => `${metaConfig.graphUrl}/${p}`;
const sysToken = () => metaConfig.systemUserToken;

// Resolve the WABA id for a restaurant. Prefers the whatsapp_accounts
// row (single-brand / legacy); falls back to the brands collection for
// multi-brand tenants. Throws if none found.
async function _resolveWabaId(restaurantId) {
  const rid = String(restaurantId);
  const wa = await col('whatsapp_accounts').findOne(
    { restaurant_id: rid, is_active: true },
    { projection: { waba_id: 1 } },
  );
  if (wa?.waba_id) return wa.waba_id;

  const brand = await col('brands').findOne(
    { business_id: rid, status: 'active', waba_id: { $exists: true, $ne: null } },
    { projection: { waba_id: 1 } },
  );
  if (brand?.waba_id) return brand.waba_id;

  throw new Error(`no WABA linked to restaurant ${rid}`);
}

// A template is a "coupon template" if any component is a BUTTONS block
// containing at least one button of type COPY_CODE.
function _hasCopyCodeButton(template) {
  const comps = template?.components || [];
  return comps.some(c =>
    c.type === 'BUTTONS' &&
    Array.isArray(c.buttons) &&
    c.buttons.some(b => String(b.type || '').toUpperCase() === 'COPY_CODE'),
  );
}

// ─── CREATE ─────────────────────────────────────────────────
// payload = { restaurantId, name, headerText?, bodyText, exampleCode }
async function createCouponTemplate({ restaurantId, name, headerText, bodyText, exampleCode }) {
  if (!restaurantId) throw new Error('restaurantId required');
  if (!name || !NAME_RE.test(name)) {
    throw new Error('name must be lowercase alphanumeric with underscores only');
  }
  if (!bodyText || typeof bodyText !== 'string') throw new Error('bodyText required');
  if (!exampleCode || typeof exampleCode !== 'string') throw new Error('exampleCode required');

  const wabaId = await _resolveWabaId(restaurantId);

  // Build components. BODY requires example.body_text matching placeholder count.
  const placeholderCount = (bodyText.match(/\{\{\d+\}\}/g) || []).length;
  const bodyExample = [exampleCode];
  while (bodyExample.length < placeholderCount) bodyExample.push('10%');

  const components = [];
  if (headerText && headerText.trim()) {
    components.push({ type: 'HEADER', format: 'TEXT', text: headerText.trim() });
  }
  components.push({
    type: 'BODY',
    text: bodyText,
    ...(placeholderCount > 0 && { example: { body_text: [bodyExample] } }),
  });
  components.push({
    type: 'BUTTONS',
    buttons: [
      { type: 'COPY_CODE', example: exampleCode },
    ],
  });

  const payload = {
    name,
    category: 'MARKETING',
    language: 'en',
    components,
  };

  const url = graphUrl(`${wabaId}/message_templates`);
  let data;
  try {
    ({ data } = await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${sysToken()}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    }));
  } catch (err) {
    const metaErr = err.response?.data?.error;
    log.error({ err: metaErr || err.message, wabaId, name }, 'coupon_template.create.meta_failed');
    const msg = metaErr?.error_user_msg || metaErr?.message || err.message;
    const e = new Error(msg);
    e.meta = metaErr || null;
    throw e;
  }

  // Best-effort local mirror so the /admin/templates page still sees it.
  try {
    await col('templates').updateOne(
      { meta_id: data.id },
      {
        $set: {
          meta_id: data.id,
          waba_id: wabaId,
          restaurant_id: String(restaurantId),
          name,
          category: 'MARKETING',
          language: 'en',
          components,
          status: data.status || 'PENDING',
          template_kind: 'coupon',
          updated_at: new Date(),
        },
        $setOnInsert: { created_at: new Date() },
      },
      { upsert: true },
    );
  } catch (mirrorErr) {
    log.warn({ err: mirrorErr }, 'coupon_template.create.local_mirror_failed');
  }

  // Invalidate the list cache so the new row shows up immediately.
  try {
    const { invalidateCache } = require('../config/cache');
    await invalidateCache(`coupon_templates:${String(restaurantId)}`);
  } catch (_) { /* ignore */ }

  log.info({ wabaId, name, id: data.id, status: data.status }, 'coupon_template.created');
  return { template_id: data.id, status: data.status || 'PENDING', category: data.category || 'MARKETING' };
}

// ─── LIST ──────────────────────────────────────────────────
// Returns only templates with a COPY_CODE button. Cached 30min in _cache
// keyed by restaurant id.
async function listCouponTemplates(restaurantId) {
  if (!restaurantId) throw new Error('restaurantId required');
  const rid = String(restaurantId);
  const cacheKey = `coupon_templates:${rid}`;

  return getCached(cacheKey, async () => {
    const wabaId = await _resolveWabaId(rid);

    const params = { access_token: sysToken(), limit: 100, fields: 'name,status,category,language,components,id' };
    const firstUrl = graphUrl(`${wabaId}/message_templates`);

    const all = [];
    let url = firstUrl;
    let isFirst = true;
    while (url) {
      const { data } = await axios.get(url, {
        params: isFirst ? params : undefined,
        timeout: 15000,
      });
      if (Array.isArray(data.data)) all.push(...data.data);
      url = data.paging?.next || null;
      isFirst = false;
    }

    return all.filter(_hasCopyCodeButton).map(t => ({
      id: t.id,
      name: t.name,
      status: t.status,
      category: t.category,
      language: t.language,
      components: t.components,
    }));
  }, LIST_TTL_SECONDS);
}

module.exports = {
  createCouponTemplate,
  listCouponTemplates,
  _resolveWabaId,
};
