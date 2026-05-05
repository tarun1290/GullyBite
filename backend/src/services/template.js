// src/services/template.js
// Meta WhatsApp Message Templates API wrapper
// Manages template CRUD + sending via Meta Graph API
// All management calls use META_SYSTEM_USER_TOKEN (has whatsapp_business_management permission)

const axios = require('axios');
const { col, newId, mapId, mapIds } = require('../config/database');
const metaConfig = require('../config/meta');
const log = require('../utils/logger').child({ component: 'template' });

const graphUrl = (path) => `${metaConfig.graphUrl}/${path}`;

const sysToken = () => metaConfig.systemUserToken;

// ─── LIST TEMPLATES ─────────────────────────────────────────
// Fetches all templates for a WABA, with optional status/name filters
const listTemplates = async (wabaId, { status, name, limit = 100 } = {}) => {
  const params = { access_token: sysToken(), limit };
  if (status) params.status = status;
  if (name) params.name = name;

  const allTemplates = [];
  let url = graphUrl(`${wabaId}/message_templates`);

  // Paginate through all results
  while (url) {
    const { data } = await axios.get(url, { params: url === graphUrl(`${wabaId}/message_templates`) ? params : undefined });
    if (data.data) allTemplates.push(...data.data);
    url = data.paging?.next || null;
    // After first request, params are baked into paging URL
  }

  return allTemplates;
};

// ─── GET SINGLE TEMPLATE ────────────────────────────────────
const getTemplate = async (templateId) => {
  const { data } = await axios.get(graphUrl(templateId), {
    params: { access_token: sysToken() },
  });
  return data;
};

// ─── CREATE TEMPLATE ────────────────────────────────────────
// templateData: { name, category, language, components, allow_category_change }
const createTemplate = async (wabaId, templateData) => {
  const payload = {
    name: templateData.name,
    category: templateData.category || 'UTILITY',
    language: templateData.language || 'en',
    components: templateData.components || [],
  };
  if (templateData.allow_category_change !== undefined) {
    payload.allow_category_change = templateData.allow_category_change;
  }

  let data;
  try {
    ({ data } = await axios.post(graphUrl(`${wabaId}/message_templates`), payload, {
      headers: { Authorization: `Bearer ${sysToken()}`, 'Content-Type': 'application/json' },
    }));
  } catch (e) {
    // Surface every diagnostic field Meta sends. error_user_msg + error_subcode
    // are where the actual rejection reason lives ("Invalid parameter" at the
    // top-level `message` field is generic). fbtrace_id lets ops cross-ref a
    // specific failure with Meta support.
    const metaErr = e.response?.data?.error;
    log.error({
      templateName: payload.name,
      templatePayload: payload,
      metaCode: metaErr?.code,
      metaSubcode: metaErr?.error_subcode,
      metaUserTitle: metaErr?.error_user_title,
      metaUserMsg: metaErr?.error_user_msg,
      metaFbtrace: metaErr?.fbtrace_id,
      metaMessage: metaErr?.message,
      httpStatus: e.response?.status,
      rawMetaErr: metaErr || null,
    }, 'createTemplate: Meta rejected — full error');
    throw e;
  }

  // Store in local DB for tracking
  await col('templates').updateOne(
    { meta_id: data.id },
    {
      $set: {
        meta_id: data.id,
        waba_id: wabaId,
        name: payload.name,
        category: payload.category,
        language: payload.language,
        components: payload.components,
        status: data.status || 'PENDING',
        updated_at: new Date(),
      },
      $setOnInsert: { _id: newId(), created_at: new Date() },
    },
    { upsert: true }
  );

  return data;
};

// ─── UPDATE TEMPLATE ────────────────────────────────────────
// Only components can be updated (name/category are immutable after creation)
const updateTemplate = async (templateId, components) => {
  const { data } = await axios.post(graphUrl(templateId), {
    components,
  }, {
    headers: { Authorization: `Bearer ${sysToken()}`, 'Content-Type': 'application/json' },
  });

  // Update local DB
  await col('templates').updateOne(
    { meta_id: templateId },
    { $set: { components, status: 'PENDING', updated_at: new Date() } }
  );

  return data;
};

// ─── DELETE TEMPLATE ────────────────────────────────────────
// Deletes by name (Meta API requirement — deletes all languages of that name)
const deleteTemplate = async (wabaId, templateName) => {
  const { data } = await axios.delete(graphUrl(`${wabaId}/message_templates`), {
    params: { access_token: sysToken(), name: templateName },
  });

  // Remove from local DB
  await col('templates').deleteMany({ waba_id: wabaId, name: templateName });

  return data;
};

// ─── SYNC TEMPLATES FROM META ───────────────────────────────
// Pulls all templates from Meta and upserts into local DB
const syncTemplates = async (wabaId) => {
  const remote = await listTemplates(wabaId);
  const now = new Date();
  let synced = 0;

  for (const t of remote) {
    await col('templates').updateOne(
      { meta_id: t.id },
      {
        $set: {
          meta_id: t.id,
          waba_id: wabaId,
          name: t.name,
          category: t.category,
          language: t.language,
          components: t.components || [],
          status: t.status,
          updated_at: now,
        },
        $setOnInsert: { _id: newId(), created_at: now },
      },
      { upsert: true }
    );
    synced++;
  }

  // Mark locally-stored templates that no longer exist on Meta
  const remoteIds = new Set(remote.map(t => t.id));
  const locals = await col('templates').find({ waba_id: wabaId }).toArray();
  for (const local of locals) {
    if (local.meta_id && !remoteIds.has(local.meta_id)) {
      await col('templates').updateOne(
        { _id: local._id },
        { $set: { status: 'DELETED', updated_at: now } }
      );
    }
  }

  return { synced, total: remote.length };
};

// ─── SEND TEMPLATE MESSAGE ─────────────────────────────────
// Sends a template message to a customer via WhatsApp
// componentParams: array of component objects for variable substitution
// e.g. [{ type: 'body', parameters: [{ type: 'text', text: 'John' }, { type: 'text', text: '#ZM-001' }] }]
const sendTemplateMessage = async (phoneNumberId, toPhone, templateName, languageCode, componentParams = []) => {
  const token = sysToken();
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toPhone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode || 'en' },
    },
  };

  if (componentParams.length > 0) {
    payload.template.components = componentParams;
  }

  const url = graphUrl(`${phoneNumberId}/messages`);
  const { data } = await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 10000,
  });
  return data;
};

// ─── DEFAULT TEMPLATE LIBRARY ───────────────────────────────
// Templates the platform expects to exist on Meta for the lifecycle
// events wired into DEFAULT_MAPPINGS below. Seeded by
// seedDefaultTemplates() so an empty WABA can boot to a working state
// without an admin hand-crafting each template in the dashboard.
//
// Only the templates we genuinely need at boot. Existing approved
// templates (order_confirmed, order_prepar, out_for_delivery,
// order_delivered) live on Meta already and are excluded here — Meta
// rejects re-creation by name and the seed would log a noisy "already
// exists" skip on every run.
//
// Language: en_US (matches our other approved templates on Meta).
// Examples are required for any component containing {{N}} variables.
const DEFAULT_TEMPLATES = [
  {
    name: 'order_packed',
    category: 'UTILITY',
    language: 'en_US',
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'Order Packed' },
      {
        type: 'BODY',
        text: "Hi {{1}}, your order #{{2}} is packed and ready for pickup by the delivery rider. We'll notify you as soon as a rider is assigned.",
        example: { body_text: [['John', '#ZM-20260504-0001']] },
      },
    ],
  },
  {
    name: 'order_cancelled',
    category: 'UTILITY',
    language: 'en_US',
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'Order Cancelled' },
      {
        type: 'BODY',
        text: "Hi {{1}}, your order #{{2}} has been cancelled. Reason: {{3}}. If you've been charged, your refund will be processed within 5-7 business days.",
        example: { body_text: [['John', '#ZM-20260504-0001', 'Restaurant unavailable']] },
      },
    ],
  },
  {
    name: 'payment_received',
    category: 'UTILITY',
    language: 'en_US',
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'Payment Confirmed' },
      {
        type: 'BODY',
        text: "Hi {{1}}, we've received your payment of ₹{{3}} for order #{{2}}. The restaurant will start preparing your order shortly.",
        example: { body_text: [['John', '#ZM-20260504-0001', '498']] },
      },
    ],
  },

  // ─── MARKETING TEMPLATES ────────────────────────────────────
  // These carry extra metadata fields (displayName, useCase, bodyNamed,
  // variables, buttonText) so seedDefaultTemplates can mirror the row
  // into the campaign_templates collection after Meta accepts the create.
  // Meta itself sees only the standard {name, category, language,
  // components} payload; the extra fields are read by the seed wrapper.
  // No HEADER block — Meta rejects emojis in MARKETING headers, and a
  // text-only header without variables adds no value here. Emojis in
  // the BODY are accepted by Meta for MARKETING templates.
  {
    name: 'marketing_welcome_v1',
    displayName: 'Welcome — First Order Offer',
    useCase: 'welcome',
    category: 'MARKETING',
    language: 'en_US',
    bodyNamed: "Hi {{customer_name}}! Welcome to {{restaurant_name}}. As a thank you, here's {{discount_pct}}% off your first order. Tap below to start exploring our menu!",
    variables: [
      { name: 'customer_name', label: 'Customer Name', source: 'customer_data', required: true, example: 'Tarun' },
      { name: 'restaurant_name', label: 'Restaurant Name', source: 'auto', required: true, example: 'GullyBite' },
      { name: 'discount_pct', label: 'Discount %', source: 'restaurant_input', required: true, example: '10' },
    ],
    buttonText: 'Order Now',
    components: [
      {
        type: 'BODY',
        text: "Hi {{1}}! Welcome to {{2}}. As a thank you, here's {{3}}% off your first order. Tap below to start exploring our menu!",
        example: { body_text: [['Tarun', 'GullyBite', '10']] },
      },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Order Now' }] },
    ],
  },
  {
    name: 'marketing_winback_short_v1',
    displayName: 'Win-back — Short (14 days)',
    useCase: 'winback_short',
    category: 'MARKETING',
    language: 'en_US',
    bodyNamed: "Hey {{customer_name}}, we've missed you at {{restaurant_name}}! It's been a while since your last visit. Here's {{discount_pct}}% off to bring you back. Valid for 7 days.",
    variables: [
      { name: 'customer_name', label: 'Customer Name', source: 'customer_data', required: true, example: 'Priya' },
      { name: 'restaurant_name', label: 'Restaurant Name', source: 'auto', required: true, example: 'Spice Kitchen' },
      { name: 'discount_pct', label: 'Discount %', source: 'restaurant_input', required: true, example: '15' },
    ],
    buttonText: 'Order Now',
    components: [
      {
        type: 'BODY',
        text: "Hey {{1}}, we've missed you at {{2}}! It's been a while since your last visit. Here's {{3}}% off to bring you back. Valid for 7 days.",
        example: { body_text: [['Priya', 'Spice Kitchen', '15']] },
      },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Order Now' }] },
    ],
  },
  {
    name: 'marketing_winback_long_v1',
    displayName: 'Win-back — Long (30 days)',
    useCase: 'winback_long',
    category: 'MARKETING',
    language: 'en_US',
    bodyNamed: "Hi {{customer_name}}, it's been a month since your last order at {{restaurant_name}}. We'd love to have you back — enjoy {{discount_pct}}% off + free delivery on your next order.",
    variables: [
      { name: 'customer_name', label: 'Customer Name', source: 'customer_data', required: true, example: 'Rajesh' },
      { name: 'restaurant_name', label: 'Restaurant Name', source: 'auto', required: true, example: 'Cafe Delight' },
      { name: 'discount_pct', label: 'Discount %', source: 'restaurant_input', required: true, example: '20' },
    ],
    buttonText: 'Reorder Now',
    components: [
      {
        type: 'BODY',
        text: "Hi {{1}}, it's been a month since your last order at {{2}}. We'd love to have you back — enjoy {{3}}% off + free delivery on your next order.",
        example: { body_text: [['Rajesh', 'Cafe Delight', '20']] },
      },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Reorder Now' }] },
    ],
  },
  {
    name: 'marketing_birthday_v1',
    displayName: 'Birthday Greeting + Discount',
    useCase: 'birthday',
    category: 'MARKETING',
    language: 'en_US',
    bodyNamed: 'Happy birthday {{customer_name}}! 🎂 Treat yourself today with {{discount_pct}}% off your favorite from {{restaurant_name}}. Make it a delicious day!',
    variables: [
      { name: 'customer_name', label: 'Customer Name', source: 'customer_data', required: true, example: 'Anjali' },
      { name: 'discount_pct', label: 'Discount %', source: 'restaurant_input', required: true, example: '25' },
      { name: 'restaurant_name', label: 'Restaurant Name', source: 'auto', required: true, example: 'Pizza Palace' },
    ],
    buttonText: 'Order My Favorite',
    components: [
      {
        type: 'BODY',
        text: 'Happy birthday {{1}}! 🎂 Treat yourself today with {{2}}% off your favorite from {{3}}. Make it a delicious day!',
        example: { body_text: [['Anjali', '25', 'Pizza Palace']] },
      },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Order My Favorite' }] },
    ],
  },
  {
    name: 'marketing_loyalty_milestone_v1',
    displayName: 'Loyalty Milestone Reward',
    useCase: 'milestone',
    category: 'MARKETING',
    language: 'en_US',
    bodyNamed: "Wow {{customer_name}}, you've reached {{total_orders}} orders with {{restaurant_name}}! 🎉 You've earned {{points_balance}} loyalty points — redeem now for exclusive rewards.",
    variables: [
      { name: 'customer_name', label: 'Customer Name', source: 'customer_data', required: true, example: 'Vikram' },
      { name: 'total_orders', label: 'Total Orders', source: 'customer_data', required: true, example: '10' },
      { name: 'restaurant_name', label: 'Restaurant Name', source: 'auto', required: true, example: 'Biryani Hub' },
      { name: 'points_balance', label: 'Points Balance', source: 'system', required: true, example: '500' },
    ],
    buttonText: 'Redeem Points',
    components: [
      {
        type: 'BODY',
        text: "Wow {{1}}, you've reached {{2}} orders with {{3}}! 🎉 You've earned {{4}} loyalty points — redeem now for exclusive rewards.",
        example: { body_text: [['Vikram', '10', 'Biryani Hub', '500']] },
      },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Redeem Points' }] },
    ],
  },
  {
    name: 'marketing_loyalty_expiry_v1',
    displayName: 'Loyalty Points Expiring',
    useCase: 'loyalty_expiry',
    category: 'MARKETING',
    language: 'en_US',
    bodyNamed: "Heads up {{customer_name}}! Your {{points_balance}} loyalty points at {{restaurant_name}} expire in {{days_left}} days. Order now to redeem before they're gone.",
    variables: [
      { name: 'customer_name', label: 'Customer Name', source: 'customer_data', required: true, example: 'Sneha' },
      { name: 'points_balance', label: 'Points Balance', source: 'system', required: true, example: '300' },
      { name: 'restaurant_name', label: 'Restaurant Name', source: 'auto', required: true, example: 'South Spice' },
      { name: 'days_left', label: 'Days Left', source: 'system', required: true, example: '5' },
    ],
    buttonText: 'Order Now',
    components: [
      {
        type: 'BODY',
        text: "Heads up {{1}}! Your {{2}} loyalty points at {{3}} expire in {{4}} days. Order now to redeem before they're gone.",
        example: { body_text: [['Sneha', '300', 'South Spice', '5']] },
      },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Order Now' }] },
    ],
  },
  {
    name: 'marketing_cart_recovery_v1',
    displayName: 'Cart Recovery — Abandoned Order',
    useCase: 'cart_recovery',
    category: 'MARKETING',
    language: 'en_US',
    bodyNamed: 'Hey {{customer_name}}, you left items in your cart at {{restaurant_name}}. Complete your order now and save {{discount_pct}}% — your favorites are still waiting!',
    variables: [
      { name: 'customer_name', label: 'Customer Name', source: 'customer_data', required: true, example: 'Arjun' },
      { name: 'restaurant_name', label: 'Restaurant Name', source: 'auto', required: true, example: 'Burger Stop' },
      { name: 'discount_pct', label: 'Discount %', source: 'restaurant_input', required: true, example: '10' },
    ],
    buttonText: 'Complete Order',
    components: [
      {
        type: 'BODY',
        text: 'Hey {{1}}, you left items in your cart at {{2}}. Complete your order now and save {{3}}% — your favorites are still waiting!',
        example: { body_text: [['Arjun', 'Burger Stop', '10']] },
      },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Complete Order' }] },
    ],
  },
  {
    name: 'marketing_reorder_suggestion_v1',
    displayName: 'Reorder Reminder — Your Usual',
    useCase: 'reorder_suggestion',
    category: 'MARKETING',
    language: 'en_US',
    bodyNamed: "Hi {{customer_name}}! It's been a while since your last {{last_item}} from {{restaurant_name}}. Reorder your favorite now in just one tap!",
    variables: [
      { name: 'customer_name', label: 'Customer Name', source: 'customer_data', required: true, example: 'Meera' },
      { name: 'last_item', label: 'Last Item', source: 'customer_data', required: true, example: 'Paneer Tikka' },
      { name: 'restaurant_name', label: 'Restaurant Name', source: 'auto', required: true, example: 'Tandoor House' },
    ],
    buttonText: 'Reorder',
    components: [
      {
        type: 'BODY',
        text: "Hi {{1}}! It's been a while since your last {{2}} from {{3}}. Reorder your favorite now in just one tap!",
        example: { body_text: [['Meera', 'Paneer Tikka', 'Tandoor House']] },
      },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Reorder' }] },
    ],
  },
  {
    name: 'marketing_new_dish_v1',
    displayName: 'New Menu Item Launch',
    useCase: 'new_dish',
    category: 'MARKETING',
    language: 'en_US',
    bodyNamed: 'Hey {{customer_name}}, something new at {{restaurant_name}}! 🌟 Try our latest dish: {{dish_name}}. Get {{discount_pct}}% off this week as a launch offer.',
    variables: [
      { name: 'customer_name', label: 'Customer Name', source: 'customer_data', required: true, example: 'Karthik' },
      { name: 'restaurant_name', label: 'Restaurant Name', source: 'auto', required: true, example: 'Coastal Bites' },
      { name: 'dish_name', label: 'Dish Name', source: 'restaurant_input', required: true, example: 'Prawn Curry' },
      { name: 'discount_pct', label: 'Discount %', source: 'restaurant_input', required: true, example: '20' },
    ],
    buttonText: 'Try Now',
    components: [
      {
        type: 'BODY',
        text: 'Hey {{1}}, something new at {{2}}! 🌟 Try our latest dish: {{3}}. Get {{4}}% off this week as a launch offer.',
        example: { body_text: [['Karthik', 'Coastal Bites', 'Prawn Curry', '20']] },
      },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Try Now' }] },
    ],
  },
  {
    name: 'marketing_festival_v1',
    displayName: 'Festival / Seasonal Promo',
    useCase: 'festival',
    category: 'MARKETING',
    language: 'en_US',
    bodyNamed: 'Celebrate {{festival_name}} with {{restaurant_name}}! 🎊 Enjoy {{discount_pct}}% off on all orders above ₹{{min_amount}} this festive season.',
    variables: [
      { name: 'festival_name', label: 'Festival Name', source: 'restaurant_input', required: true, example: 'Diwali' },
      { name: 'restaurant_name', label: 'Restaurant Name', source: 'auto', required: true, example: 'Mithai Mart' },
      { name: 'discount_pct', label: 'Discount %', source: 'restaurant_input', required: true, example: '15' },
      { name: 'min_amount', label: 'Minimum Order ₹', source: 'restaurant_input', required: true, example: '500' },
    ],
    buttonText: 'Order Now',
    components: [
      {
        type: 'BODY',
        text: 'Celebrate {{1}} with {{2}}! 🎊 Enjoy {{3}}% off on all orders above ₹{{4}} this festive season.',
        example: { body_text: [['Diwali', 'Mithai Mart', '15', '500']] },
      },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Order Now' }] },
    ],
  },
];

// Build the campaign_templates row for a MARKETING entry. metaTemplateId
// is the Meta-side id (string) — comes either from a fresh createTemplate
// response or from a name-collision lookup against listTemplates.
function _buildCampaignTemplateRow(t, metaTemplateId) {
  return {
    template_id: t.name,
    display_name: t.displayName,
    category: 'marketing',          // lowercase per validator at routes/campaignTemplates.js:21
    use_case: t.useCase,
    language: 'en_US',
    header_type: 'none',
    header_text: null,
    body_template: t.bodyNamed,
    variables: t.variables || [],
    footer_text: null,
    cta_button_text: t.buttonText || null,
    preview_text: t.displayName,
    per_message_cost_rs: 0.65,
    meta_template_id: metaTemplateId || null,
    meta_approval_status: 'pending',
    is_active: true,
    created_by: 'seed-defaults',
  };
}

// Upsert the campaign_templates mirror row for a MARKETING entry. Keyed
// on template_id so re-runs are idempotent: unchanged metadata is rewritten
// to the same values; new fields (e.g. meta_template_id discovered on a
// later seed) get filled in. created_at is set once via $setOnInsert.
async function _mirrorToCampaignTemplates(t, metaTemplateId) {
  const row = _buildCampaignTemplateRow(t, metaTemplateId);
  await col('campaign_templates').updateOne(
    { template_id: t.name },
    {
      $set: { ...row, updated_at: new Date() },
      $setOnInsert: { _id: newId(), created_at: new Date() },
    },
    { upsert: true },
  );
}

// Idempotently create the DEFAULT_TEMPLATES on Meta. Skips any name
// already present in the local templates collection for this WABA;
// also catches Meta's "name already exists" error (code 192) so a
// half-synced state still progresses cleanly.
//
// MARKETING entries also mirror into campaign_templates so the marketing
// dashboard / journey engine can pick them up. Mirror happens in three
// branches: fresh-create (use Meta's returned id), local-skip (look up
// the existing local templates row and reuse its meta_id), and
// already_exists_meta (fetch Meta's templates list and find the row by
// name to recover the id).
const seedDefaultTemplates = async (wabaId) => {
  if (!wabaId) throw new Error('seedDefaultTemplates: wabaId required');
  const created = [];
  const skipped = [];
  const mirrored = [];
  for (const t of DEFAULT_TEMPLATES) {
    const isMarketing = t.category === 'MARKETING';
    const existing = await col('templates').findOne({ waba_id: wabaId, name: t.name });
    if (existing) {
      skipped.push({ name: t.name, reason: 'already_exists_local', status: existing.status || null });
      // Marketing entries still need their campaign_templates mirror —
      // a fresh deploy where the templates row pre-exists (e.g. someone
      // re-seeded after a partial failure) shouldn't leave the mirror
      // missing.
      if (isMarketing) {
        try {
          await _mirrorToCampaignTemplates(t, existing.meta_id || null);
          mirrored.push({ name: t.name, source: 'existing_local' });
        } catch (mirrorErr) {
          log.warn({ template: t.name, err: mirrorErr?.message }, 'campaign_templates mirror failed (existing_local)');
        }
      }
      continue;
    }
    try {
      const result = await createTemplate(wabaId, t);
      created.push({ name: t.name, meta_id: result.id, status: result.status || 'PENDING' });
      if (isMarketing) {
        try {
          await _mirrorToCampaignTemplates(t, result.id);
          mirrored.push({ name: t.name, source: 'fresh_create' });
        } catch (mirrorErr) {
          log.warn({ template: t.name, err: mirrorErr?.message }, 'campaign_templates mirror failed (fresh_create)');
        }
      }
    } catch (e) {
      const metaErr = e.response?.data?.error;
      const msg = metaErr?.message || e.message || 'unknown error';
      if (metaErr?.code === 192 || /already exists/i.test(msg)) {
        skipped.push({ name: t.name, reason: 'already_exists_meta' });
        // Recover the Meta id by listing the WABA's templates and
        // finding the one that matches by name. listTemplates is
        // already implemented above and pages through the full set, so
        // a 1000-template WABA won't hide the lookup. Mirror with the
        // recovered id so meta_template_id isn't null on collision.
        if (isMarketing) {
          try {
            const remote = await listTemplates(wabaId, { name: t.name, limit: 5 });
            const match = (remote || []).find((r) => r.name === t.name);
            await _mirrorToCampaignTemplates(t, match?.id || null);
            mirrored.push({ name: t.name, source: 'meta_collision_lookup', meta_id_resolved: !!match?.id });
          } catch (lookupErr) {
            log.warn({ template: t.name, err: lookupErr?.message }, 'campaign_templates mirror failed (meta_collision_lookup)');
            // Mirror anyway with null meta_template_id so the row
            // exists; templateSync auto-glue will fill in the id once
            // the local templates row is populated by syncTemplates.
            try {
              await _mirrorToCampaignTemplates(t, null);
              mirrored.push({ name: t.name, source: 'meta_collision_no_id' });
            } catch (_) { /* swallow — already logged */ }
          }
        }
      } else {
        // Full diagnostic surface for non-duplicate failures. error_user_msg
        // is where Meta puts the actual rejection reason (e.g. "Headers
        // cannot contain emojis"); the top-level `message` is generic.
        // rawMetaErr is included so any field we forgot to break out
        // explicitly still hits the log.
        log.error({
          templateName: t.name,
          templatePayload: t,
          metaCode: metaErr?.code,
          metaSubcode: metaErr?.error_subcode,
          metaUserTitle: metaErr?.error_user_title,
          metaUserMsg: metaErr?.error_user_msg,
          metaFbtrace: metaErr?.fbtrace_id,
          metaMessage: metaErr?.message,
          httpStatus: e.response?.status,
          rawMetaErr: metaErr || null,
        }, 'seedDefaultTemplates: Meta rejected — full error');
        skipped.push({ name: t.name, reason: msg });
      }
    }
  }
  return { created, skipped, mirrored };
};

// ─── TEMPLATE EVENT MAPPINGS ────────────────────────────────
// Maps order lifecycle events to template names + variable configs

// Default event-to-template mappings (seeded on first use)
const DEFAULT_MAPPINGS = [
  {
    event: 'order_confirmed',
    template_name: 'order_confirmed',
    description: 'Sent when restaurant confirms the order',
    variables: [
      { position: 1, source: 'order.customer_name', fallback: 'Customer' },
      { position: 2, source: 'order.order_number' },
      { position: 3, source: 'order.total_rs', format: 'currency' },
    ],
    is_active: true,
  },
  {
    event: 'order_preparing',
    template_name: 'order_preparing',
    description: 'Sent when kitchen starts preparing',
    variables: [
      { position: 1, source: 'order.customer_name', fallback: 'Customer' },
      { position: 2, source: 'order.order_number' },
    ],
    is_active: true,
  },
  {
    event: 'order_packed',
    template_name: 'order_packed',
    description: 'Sent when order is packed and ready',
    variables: [
      { position: 1, source: 'order.customer_name', fallback: 'Customer' },
      { position: 2, source: 'order.order_number' },
    ],
    is_active: true,
  },
  {
    event: 'order_dispatched',
    template_name: 'order_dispatched',
    description: 'Sent when rider picks up the order',
    variables: [
      { position: 1, source: 'order.customer_name', fallback: 'Customer' },
      { position: 2, source: 'order.order_number' },
      { position: 3, source: 'delivery.driver_name', fallback: 'your rider' },
      { position: 4, source: 'delivery.tracking_url', fallback: '' },
    ],
    is_active: true,
  },
  {
    event: 'order_delivered',
    template_name: 'order_delivered',
    description: 'Sent after successful delivery',
    variables: [
      { position: 1, source: 'order.customer_name', fallback: 'Customer' },
      { position: 2, source: 'order.order_number' },
      { position: 3, source: 'order.business_name', fallback: 'the restaurant' },
    ],
    is_active: true,
  },
  {
    event: 'order_cancelled',
    template_name: 'order_cancelled',
    description: 'Sent when order is cancelled',
    variables: [
      { position: 1, source: 'order.customer_name', fallback: 'Customer' },
      { position: 2, source: 'order.order_number' },
      { position: 3, source: 'order.cancel_reason', fallback: 'No reason provided' },
    ],
    is_active: true,
  },
  {
    event: 'payment_received',
    template_name: 'payment_received',
    description: 'Sent when payment is confirmed',
    variables: [
      { position: 1, source: 'order.customer_name', fallback: 'Customer' },
      { position: 2, source: 'order.order_number' },
      { position: 3, source: 'order.total_rs', format: 'currency' },
    ],
    is_active: true,
  },
];

// Get all event mappings
const getEventMappings = async () => {
  let mappings = await col('template_mappings').find({}).toArray();
  if (mappings.length === 0) {
    // Seed defaults
    await seedDefaultMappings();
    mappings = await col('template_mappings').find({}).toArray();
  }
  return mapIds(mappings);
};

// Seed default mappings
const seedDefaultMappings = async () => {
  const now = new Date();
  for (const m of DEFAULT_MAPPINGS) {
    const exists = await col('template_mappings').findOne({ event: m.event });
    if (!exists) {
      await col('template_mappings').insertOne({
        _id: newId(),
        ...m,
        created_at: now,
        updated_at: now,
      });
    }
  }
};

// Get mapping for a specific event
const getMappingForEvent = async (event) => {
  let mapping = await col('template_mappings').findOne({ event, is_active: true });
  if (!mapping) {
    // Try seeding defaults first
    await seedDefaultMappings();
    mapping = await col('template_mappings').findOne({ event, is_active: true });
  }
  return mapping ? mapId(mapping) : null;
};

// Update an event mapping
const updateEventMapping = async (event, updates) => {
  const result = await col('template_mappings').findOneAndUpdate(
    { event },
    {
      $set: { ...updates, updated_at: new Date() },
      $setOnInsert: { _id: newId(), created_at: new Date() },
    },
    { upsert: true, returnDocument: 'after' }
  );
  return mapId(result);
};

// ─── RESOLVE TEMPLATE VARIABLES ─────────────────────────────
// Takes a variable config array and an order context, returns Meta-format component params
const resolveTemplateVariables = (variableConfig, context) => {
  if (!variableConfig?.length) return [];

  const params = variableConfig.map(v => {
    let value = resolveContextPath(context, v.source);

    // Apply fallback
    if (value === null || value === undefined || value === '') {
      value = v.fallback || '';
    }

    // Apply format
    if (v.format === 'currency' && value !== '') {
      value = `₹${parseFloat(value).toFixed(0)}`;
    } else if (v.format === 'date' && value) {
      value = new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
    }

    return { type: 'text', text: String(value) };
  });

  return [{ type: 'body', parameters: params }];
};

// Resolve a dot-path like "order.customer_name" from context object
const resolveContextPath = (obj, path) => {
  if (!path || !obj) return null;
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return null;
    current = current[part];
  }
  return current;
};

module.exports = {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  syncTemplates,
  sendTemplateMessage,
  getEventMappings,
  getMappingForEvent,
  updateEventMapping,
  seedDefaultMappings,
  seedDefaultTemplates,
  resolveTemplateVariables,
  DEFAULT_MAPPINGS,
  DEFAULT_TEMPLATES,
};
