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
// Parses the Meta webhook payload to extract both phone and BSUID.
//
// Returns three identifiers:
//   wa_phone   — the customer's WhatsApp phone (legacy primary)
//   bsuid      — GullyBite's INTERNAL BSUID (may be the userId today,
//                may be a computed identifier for legacy customers)
//   meta_bsuid — Meta's OFFICIAL BSUID, sourced ONLY from contact.user_id.
//                Stored separately so we can distinguish "Meta said this
//                is the customer's BSUID" from "we computed/inferred a
//                bsuid for this row". Critical for the June 2026 rollout
//                when meta_bsuid becomes the canonical lookup key.
const extractIdentifiers = (message, contact) => {
  const fromField = message?.from;
  const userId = message?.user_id || contact?.user_id;
  const waId = contact?.wa_id;
  const meta_bsuid = contact?.user_id || null;

  const bsuid = userId || (isBsuid(fromField) ? fromField : null);
  const wa_phone = waId || (!isBsuid(fromField) ? fromField : null);

  return { bsuid, wa_phone, meta_bsuid };
};

// ─── GET OR CREATE CUSTOMER ─────────────────────────────────
// Universal customer resolution — handles all identity scenarios:
// 1. Existing phone customer → found by phone, bsuid gets linked
// 2. Existing BSUID customer → found by bsuid, phone gets linked if provided
// 3. New customer → created with whatever identifiers are available
// 4. Phone+BSUID both present → links them together, no duplicates
// 5. (June 2026 rollout) BSUID-only message from a known customer who
//    previously messaged via phone → matched by Meta's official user_id
//    (meta_bsuid) before we'd otherwise create a duplicate row.
const getOrCreateCustomer = async ({ bsuid, wa_phone, meta_bsuid, profile_name }) => {
  const now = new Date();

  // CASE 1: BSUID present → try find by bsuid first
  if (bsuid) {
    const byBsuid = await col('customers').findOne({ bsuid });
    if (byBsuid) {
      // Split-identity merge: if a SEPARATE doc exists for the same phone
      // (created during the BSUID rollout window before the two were linked),
      // fold it into the older doc so we don't keep a duplicate. Older doc
      // wins as primary; newer is soft-deleted with a merged_into pointer.
      if (wa_phone && byBsuid.wa_phone !== wa_phone) {
        const phoneDoc = await col('customers').findOne({ wa_phone });
        if (phoneDoc && String(phoneDoc._id) !== String(byBsuid._id)) {
          const [primary, secondary] = (phoneDoc.created_at || now) <= (byBsuid.created_at || now)
            ? [phoneDoc, byBsuid]
            : [byBsuid, phoneDoc];
          const mergeSet = {
            bsuid: primary.bsuid || secondary.bsuid || bsuid,
            wa_phone: primary.wa_phone || secondary.wa_phone || wa_phone,
            identifier_type: 'both',
            bsuid_first_seen_at: primary.bsuid_first_seen_at || secondary.bsuid_first_seen_at || now,
            phone_shared_at: primary.phone_shared_at || secondary.phone_shared_at || now,
          };
          await col('customers').updateOne({ _id: primary._id }, { $set: mergeSet });
          await col('customers').updateOne(
            { _id: secondary._id },
            { $set: { merged_into: String(primary._id), merged_at: now }, $unset: { bsuid: '', wa_phone: '' } }
          );
          log.info({ primary: String(primary._id), secondary: String(secondary._id) }, '[BSUID] Merged split identity');
          Object.assign(primary, mergeSet);
          return mapId(primary);
        }
      }
      const updates = {};
      // Link phone if customer didn't have one
      if (wa_phone && !byBsuid.wa_phone) {
        updates.wa_phone = wa_phone;
        updates.identifier_type = 'both';
        updates.phone_shared_at = now;
        log.info({ bsuid: bsuid.slice(0, 10), phone: wa_phone?.slice(-4) }, 'Phone linked to BSUID customer');
      }
      // Stamp Meta's official BSUID on first sight (separate from our
      // internal bsuid — see extractIdentifiers comment).
      if (meta_bsuid && !byBsuid.meta_bsuid) {
        updates.meta_bsuid = meta_bsuid;
        updates.meta_bsuid_first_seen_at = now;
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
      if (meta_bsuid && !byPhone.meta_bsuid) {
        updates.meta_bsuid = meta_bsuid;
        updates.meta_bsuid_first_seen_at = now;
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

  // CASE 5: meta_bsuid provided but no match yet by bsuid or phone.
  // This is the June 2026 rollout safety net: a customer who previously
  // messaged via phone may switch to BSUID-only. Without this lookup,
  // CASE 3 below would create a duplicate row, orphaning their order
  // history, wallet, loyalty points, and referral attribution. By
  // matching on Meta's official BSUID stamped during a prior message,
  // we keep them linked to their original record.
  if (meta_bsuid) {
    const byMetaBsuid = await col('customers').findOne({ meta_bsuid });
    if (byMetaBsuid) {
      log.info({ meta_bsuid: meta_bsuid.slice(0, 10) }, '[BSUID] Customer found by meta_bsuid (CASE 5)');
      const updates = {};
      // First message from this BSUID since the rollout — backfill the
      // internal bsuid pointer too so future CASE 1 lookups succeed
      // without falling through to CASE 5.
      if (bsuid && !byMetaBsuid.bsuid) {
        updates.bsuid = bsuid;
        updates.bsuid_first_seen_at = now;
        if (byMetaBsuid.wa_phone) updates.identifier_type = 'both';
      }
      if (wa_phone && !byMetaBsuid.wa_phone) {
        updates.wa_phone = wa_phone;
        updates.phone_shared_at = now;
        if (byMetaBsuid.bsuid || bsuid) updates.identifier_type = 'both';
      }
      if (profile_name && byMetaBsuid.name !== profile_name) {
        updates.name = profile_name;
      }
      if (Object.keys(updates).length) {
        await col('customers').updateOne({ _id: byMetaBsuid._id }, { $set: updates });
        Object.assign(byMetaBsuid, updates);
      }
      return mapId(byMetaBsuid);
    }
  }

  // CASE 3: Not found at all → create new customer
  const identifierType = bsuid && wa_phone ? 'both' : (bsuid ? 'bsuid' : 'phone');
  const customer = {
    _id: newId(),
    bsuid: bsuid || null,
    wa_phone: wa_phone || null,
    meta_bsuid: meta_bsuid || null,
    name: profile_name || null,
    identifier_type: identifierType,
    bsuid_first_seen_at: bsuid ? now : null,
    meta_bsuid_first_seen_at: meta_bsuid ? now : null,
    phone_shared_at: wa_phone ? now : null,
    total_orders: 0,
    total_spent_rs: 0,
    last_order_at: null,
    created_at: now,
  };
  await col('customers').insertOne(customer);
  log.info({ identifierType, phone: wa_phone?.slice(-4) || 'none', bsuid: bsuid ? bsuid.slice(0, 10) : 'none' }, 'New customer created');
  try {
    require('../events').emit('user.created', {
      userId: customer._id,
      userType: 'customer',
      waPhone: customer.wa_phone || null,
      bsuid: customer.bsuid || null,
      identifierType: customer.identifier_type,
    });
  } catch (_) { /* never block customer creation on bus load */ }
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
    // Defence-in-depth for the June 2026 BSUID rollout: prevents two
    // customer rows from accidentally sharing one Meta user_id, even if
    // CASE 5's application-layer lookup is somehow bypassed.
    await col('customers').createIndex(
      { meta_bsuid: 1 },
      { unique: true, sparse: true, name: 'idx_meta_bsuid_unique' }
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
