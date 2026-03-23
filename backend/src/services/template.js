// src/services/template.js
// Meta WhatsApp Message Templates API wrapper
// Manages template CRUD + sending via Meta Graph API
// All management calls use META_SYSTEM_USER_TOKEN (has whatsapp_business_management permission)

const axios = require('axios');
const { col, newId, mapId, mapIds } = require('../config/database');

const graphUrl = (path) =>
  `https://graph.facebook.com/${process.env.WA_API_VERSION}/${path}`;

const sysToken = () => process.env.META_SYSTEM_USER_TOKEN;

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

  const { data } = await axios.post(graphUrl(`${wabaId}/message_templates`), payload, {
    headers: { Authorization: `Bearer ${sysToken()}`, 'Content-Type': 'application/json' },
  });

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

  const url = `https://graph.facebook.com/${process.env.WA_API_VERSION}/${phoneNumberId}/messages`;
  const { data } = await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 10000,
  });
  return data;
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
  resolveTemplateVariables,
  DEFAULT_MAPPINGS,
};
