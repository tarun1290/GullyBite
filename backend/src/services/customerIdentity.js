// src/services/customerIdentity.js
// [BSUID] Universal customer identity resolution
// Handles phone numbers, BSUIDs, and linked identities
// This is the SINGLE SOURCE OF TRUTH for customer lookup/creation

const { col, newId, mapId } = require('../config/database');
const log = require('../utils/logger').child({ component: 'CustomerIdentity' });

// ─── BSUID DETECTION ────────────────────────────────────────
// BSUIDs start with 'w', are 20+ chars alphanumeric
const isBsuid = (str) => typeof str === 'string' && str.startsWith('w') && str.length > 20;
const isPhone = (str) => typeof str === 'string' && /^\d{10,15}$/.test(str);

// ─── RESOLVE RECIPIENT ──────────────────────────────────────
// Returns the best identifier to reach a customer via WhatsApp
// Phone preferred (works everywhere), BSUID as fallback
const resolveRecipient = (customer) => {
  if (!customer) throw new Error('[BSUID] No customer provided to resolveRecipient');
  if (customer.wa_phone) return customer.wa_phone;
  if (customer.bsuid) return customer.bsuid;
  throw new Error(`[BSUID] No reachable identifier for customer ${customer.id || customer._id}`);
};

// Returns phone specifically (for Razorpay, 3PL, auth templates)
// Returns null if unavailable — caller must handle
const resolveRecipientForPayment = (customer) => {
  if (!customer) return null;
  return customer.wa_phone || null;
};

// Display string for logging/UI
const displayIdentifier = (customer) => {
  if (!customer) return 'unknown';
  if (customer.wa_phone && customer.bsuid) return `${customer.wa_phone} (${customer.bsuid.slice(0, 10)}…)`;
  return customer.wa_phone || customer.bsuid || 'unknown';
};

// ─── EXTRACT IDENTIFIERS FROM WEBHOOK ───────────────────────
// Parses the Meta webhook payload to extract both phone and BSUID
const extractIdentifiers = (message, contact) => {
  const fromField = message?.from;
  const userId = message?.user_id || contact?.user_id;
  const waId = contact?.wa_id;

  const bsuid = userId || (isBsuid(fromField) ? fromField : null);
  const wa_phone = waId || (!isBsuid(fromField) ? fromField : null);

  return { bsuid, wa_phone };
};

// ─── GET OR CREATE CUSTOMER ─────────────────────────────────
// Universal customer resolution — handles all identity scenarios:
// 1. Existing phone customer → found by phone, bsuid gets linked
// 2. Existing BSUID customer → found by bsuid, phone gets linked if provided
// 3. New customer → created with whatever identifiers are available
// 4. Phone+BSUID both present → links them together, no duplicates
const getOrCreateCustomer = async ({ bsuid, wa_phone, profile_name }) => {
  const now = new Date();

  // CASE 1: BSUID present → try find by bsuid first
  if (bsuid) {
    const byBsuid = await col('customers').findOne({ bsuid });
    if (byBsuid) {
      const updates = {};
      // Link phone if customer didn't have one
      if (wa_phone && !byBsuid.wa_phone) {
        updates.wa_phone = wa_phone;
        updates.identifier_type = 'both';
        updates.phone_shared_at = now;
        log.info({ bsuid: bsuid.slice(0, 10), phone: wa_phone?.slice(-4) }, 'Phone linked to BSUID customer');
      }
      // Update name if changed
      if (profile_name && byBsuid.name !== profile_name) {
        updates.name = profile_name;
      }
      if (Object.keys(updates).length) {
        await col('customers').updateOne({ _id: byBsuid._id }, { $set: updates });
        Object.assign(byBsuid, updates);
      }
      return mapId(byBsuid);
    }
  }

  // CASE 2: Not found by BSUID → try phone
  if (wa_phone) {
    const byPhone = await col('customers').findOne({ wa_phone });
    if (byPhone) {
      const updates = {};
      // Link BSUID if customer didn't have one
      if (bsuid && !byPhone.bsuid) {
        updates.bsuid = bsuid;
        updates.identifier_type = 'both';
        updates.bsuid_first_seen_at = now;
        log.info({ phone: wa_phone?.slice(-4), bsuid: bsuid.slice(0, 10) }, 'BSUID linked to phone customer');
      }
      if (profile_name && byPhone.name !== profile_name) {
        updates.name = profile_name;
      }
      if (Object.keys(updates).length) {
        await col('customers').updateOne({ _id: byPhone._id }, { $set: updates });
        Object.assign(byPhone, updates);
      }
      return mapId(byPhone);
    }
  }

  // CASE 3: Not found at all → create new customer
  const identifierType = bsuid && wa_phone ? 'both' : (bsuid ? 'bsuid' : 'phone');
  const customer = {
    _id: newId(),
    bsuid: bsuid || null,
    wa_phone: wa_phone || null,
    name: profile_name || null,
    identifier_type: identifierType,
    bsuid_first_seen_at: bsuid ? now : null,
    phone_shared_at: wa_phone ? now : null,
    total_orders: 0,
    total_spent_rs: 0,
    last_order_at: null,
    created_at: now,
  };
  await col('customers').insertOne(customer);
  log.info({ identifierType, phone: wa_phone?.slice(-4) || 'none', bsuid: bsuid ? bsuid.slice(0, 10) : 'none' }, 'New customer created');
  return mapId(customer);
};

// ─── ENSURE INDEXES ─────────────────────────────────────────
// Call once at startup to create sparse unique indexes
const ensureIndexes = async () => {
  try {
    await col('customers').createIndex(
      { bsuid: 1 },
      { unique: true, sparse: true, name: 'idx_bsuid_unique' }
    );
    await col('customers').createIndex(
      { wa_phone: 1 },
      { unique: true, sparse: true, name: 'idx_wa_phone_unique' }
    );
    log.info('Customer indexes ensured');
  } catch (e) {
    // Index may already exist — that's fine
    if (e.code !== 85 && e.code !== 86) {
      log.error({ err: e }, 'Index creation error');
    }
  }
};

// ─── CHECK IF IDENTIFIER IS BLOCKED ─────────────────────────
// Works with both phone and BSUID
const isIdentifierBlocked = async (identifier) => {
  if (!identifier) return null;
  const query = isBsuid(identifier)
    ? { $or: [{ bsuid: identifier }, { wa_phone: identifier }] }
    : { wa_phone: identifier };
  try {
    return await col('blocked_phones').findOne({
      ...query,
      $or: [{ expires_at: null }, { expires_at: { $gt: new Date() } }],
    });
  } catch {
    return null;
  }
};

module.exports = {
  isBsuid,
  isPhone,
  resolveRecipient,
  resolveRecipientForPayment,
  displayIdentifier,
  extractIdentifiers,
  getOrCreateCustomer,
  ensureIndexes,
  isIdentifierBlocked,
};
