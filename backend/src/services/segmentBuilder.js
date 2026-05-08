'use strict';

// Compound-segment query builder. Owns the translation from
// operator-supplied { field, op, value } conditions into the actual
// MongoDB filters that resolve to a customer recipient set.
//
// Conditions are AND-only — every condition must match.
//
// Two scoping paths sit underneath every segment:
//   • RFM-profile scoping (customer_rfm_profiles → customer_id) for any
//     condition over an RFM field. This is the canonical per-tenant
//     customer set since profiles are the only per-tenant view of a
//     globally-shared customers row.
//   • Captain-attribution scoping (referrals → customers.captain_referral_id)
//     for the special captain_acquired condition. Lives on the global
//     customers collection, not on customer_rfm_profiles, so it's
//     handled outside the profile query.
//
// When both kinds of conditions appear, the recipient set is the
// intersection. When only captain_acquired:true appears, the result
// pulls directly from the captain set so brand-new captain customers
// who haven't been picked up by the nightly RFM rebuild yet still
// appear (mirrors the behavior of the existing captain_acquired_90d
// branch in services/marketingCampaigns.js).

const { col } = require('../config/database');
const log = require('../utils/logger').child({ component: 'segment-builder' });

// ─── FIELD METADATA ──────────────────────────────────────────
// Each entry: { type, mapsTo, special? }.
//   type:    expected JS type for `value` (or 'month' for DD/MM regex,
//            'boolean' for captain_acquired)
//   mapsTo:  the actual document field on customer_rfm_profiles
//   special: 'captain' for the captain_acquired field — never lands in
//            the profile query; resolved via referrals + customers
//            instead.
const SUPPORTED_FIELDS = {
  days_since_last_order: { type: 'number', mapsTo: 'days_since_last_order' },
  order_count:           { type: 'number', mapsTo: 'order_count' },
  total_spend_rs:        { type: 'number', mapsTo: 'total_spend_rs' },
  avg_order_value_rs:    { type: 'number', mapsTo: 'avg_order_value_rs' },
  rfm_label:             { type: 'string', mapsTo: 'rfm_label' },
  first_order_at:        { type: 'date',   mapsTo: 'first_order_at' },
  acquisition_source:    { type: 'string', mapsTo: 'acquisition_source' },
  // Stored as DD/MM string on the profile. Operator supplies a 1-12
  // month integer (or array of integers for `in`); we build a regex
  // against the trailing /MM portion of the stored value.
  birthday_month:        { type: 'month',  mapsTo: 'birthday' },
  // Captain attribution — not on customer_rfm_profiles. Boolean: true
  // = include only captain-acquired customers, false = exclude them.
  captain_acquired:      { type: 'boolean', special: 'captain' },
};

// op → MongoDB query-operator (or null for direct equality)
const OP_TO_MONGO = {
  gte: '$gte',
  lte: '$lte',
  gt:  '$gt',
  lt:  '$lt',
  eq:  null,    // handled as direct equality
  neq: '$ne',
  in:  '$in',
};
const SUPPORTED_OPS = Object.keys(OP_TO_MONGO);

// ─── VALUE COERCION ──────────────────────────────────────────
// Coerces a single value to the type the field expects. Returns
// { ok: true, value: coerced } or { ok: false, reason }.
function _coerceValue(value, fieldType) {
  if (value === undefined || value === null) {
    return { ok: false, reason: 'value missing' };
  }
  switch (fieldType) {
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) return { ok: false, reason: 'value not a finite number' };
      return { ok: true, value: n };
    }
    case 'string': {
      if (typeof value !== 'string') return { ok: false, reason: 'value not a string' };
      const s = value.trim();
      if (!s) return { ok: false, reason: 'value empty' };
      return { ok: true, value: s };
    }
    case 'date': {
      // Accept ISO string or Date; reject anything else so a stray
      // number doesn't get reinterpreted as a Unix timestamp by accident.
      if (value instanceof Date) {
        if (isNaN(value.getTime())) return { ok: false, reason: 'value invalid Date' };
        return { ok: true, value };
      }
      if (typeof value === 'string') {
        const d = new Date(value);
        if (isNaN(d.getTime())) return { ok: false, reason: 'value not a parseable ISO date' };
        return { ok: true, value: d };
      }
      return { ok: false, reason: 'value not a Date or ISO string' };
    }
    case 'month': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 12) return { ok: false, reason: 'value not an integer 1-12' };
      return { ok: true, value: n };
    }
    case 'boolean': {
      if (typeof value !== 'boolean') return { ok: false, reason: 'value not a boolean' };
      return { ok: true, value };
    }
    default:
      return { ok: false, reason: `unknown field type: ${fieldType}` };
  }
}

// Build a regex that matches a DD/MM string ending in any of the given
// month numbers. Single month: /\/03$/. Multi-month: /\/(03|07|12)$/.
// Used for both eq and in ops on birthday_month.
function _birthdayRegex(months) {
  const padded = months.map((m) => String(m).padStart(2, '0'));
  return padded.length === 1
    ? new RegExp('/' + padded[0] + '$')
    : new RegExp('/(' + padded.join('|') + ')$');
}

// ─── VALIDATION ──────────────────────────────────────────────
// Checks every condition's shape, field name, op, and value type.
// Doesn't run any DB queries.
function validateConditions(conditions) {
  if (!Array.isArray(conditions)) {
    return { valid: false, errors: ['conditions must be an array'] };
  }
  const errors = [];
  conditions.forEach((cond, idx) => {
    const prefix = `[${idx}]`;
    if (!cond || typeof cond !== 'object') {
      errors.push(`${prefix} must be an object`);
      return;
    }
    const { field, op, value } = cond;
    const meta = SUPPORTED_FIELDS[field];
    if (!meta) {
      errors.push(`${prefix} unknown field: ${field}`);
      return;
    }
    if (!SUPPORTED_OPS.includes(op)) {
      errors.push(`${prefix} unknown op: ${op}`);
      return;
    }
    // 'in' op requires array value, every element coerces; other ops
    // require a single coercible value.
    if (op === 'in') {
      if (!Array.isArray(value) || value.length === 0) {
        errors.push(`${prefix} op 'in' requires a non-empty array value`);
        return;
      }
      value.forEach((v, vi) => {
        const r = _coerceValue(v, meta.type);
        if (!r.ok) errors.push(`${prefix} value[${vi}]: ${r.reason}`);
      });
    } else {
      const r = _coerceValue(value, meta.type);
      if (!r.ok) errors.push(`${prefix} ${r.reason}`);
    }
  });
  return errors.length ? { valid: false, errors } : { valid: true };
}

// ─── PROFILE QUERY BUILDER ───────────────────────────────────
// Returns a MongoDB filter object for customer_rfm_profiles, scoped to
// restaurantId and AND-combining every non-captain condition. Captain
// conditions are silently skipped here; the caller handles them via
// the customers/referrals path.
//
// Validation should run BEFORE this function — buildProfileQuery
// assumes inputs already passed validateConditions, so it doesn't
// re-check shape. A bad input produces an unusable filter rather than
// a thrown error.
function buildProfileQuery(restaurantId, conditions) {
  const filter = { restaurant_id: String(restaurantId) };
  if (!Array.isArray(conditions)) return filter;

  for (const cond of conditions) {
    const meta = SUPPORTED_FIELDS[cond?.field];
    if (!meta || meta.special === 'captain') continue;

    // birthday_month — regex against the DD/MM string. Both eq and in
    // collapse to a single regex; we never emit a $or here.
    if (cond.field === 'birthday_month') {
      const months = cond.op === 'in'
        ? cond.value.map((v) => Number(v))
        : [Number(cond.value)];
      filter[meta.mapsTo] = { $regex: _birthdayRegex(months) };
      continue;
    }

    // Coerce per-field. We trust validation, but coerce defensively
    // (string→Date for first_order_at, etc.).
    const coerce = (v) => {
      const r = _coerceValue(v, meta.type);
      return r.ok ? r.value : v;
    };

    let mongoValue;
    if (cond.op === 'in') {
      mongoValue = { $in: (cond.value || []).map(coerce) };
    } else if (cond.op === 'eq') {
      mongoValue = coerce(cond.value);
    } else {
      const opKey = OP_TO_MONGO[cond.op];
      mongoValue = { [opKey]: coerce(cond.value) };
    }

    // If the same field already has a partial filter (e.g. a previous
    // condition wrote { $gte: 5 } and this one adds { $lt: 100 }), merge
    // both into one operator object so the AND works. Without this merge
    // the second write would overwrite the first.
    const existing = filter[meta.mapsTo];
    if (existing && typeof existing === 'object' && !(existing instanceof RegExp) &&
        mongoValue && typeof mongoValue === 'object' && !(mongoValue instanceof RegExp)) {
      filter[meta.mapsTo] = { ...existing, ...mongoValue };
    } else {
      filter[meta.mapsTo] = mongoValue;
    }
  }
  return filter;
}

// ─── CAPTAIN-ACQUIRED LOOKUP ─────────────────────────────────
// Returns a Set of customer_ids that are captain-acquired for this
// restaurant. Mirrors the join pattern in services/marketingCampaigns.js
// captain_acquired_90d branch — referrals.restaurant_id scopes the
// captain set to THIS restaurant so a customer captain-acquired by
// restaurant A doesn't bleed into restaurant B's segments.
//
// No 90d window here (unlike the marketingCampaigns branch) — segments
// can target the full captain history; if the operator wants a window,
// they add a captain_acquired_at-style condition (not yet supported as
// a scalar field — flagged as a future extension).
async function _getCaptainCustomerIds(restaurantId) {
  const referralRows = await col('referrals').find(
    { restaurant_id: String(restaurantId), source: 'gbref' },
    { projection: { _id: 1 } },
  ).toArray();
  const referralIds = referralRows.map((r) => r._id);
  if (!referralIds.length) return new Set();

  const captainRows = await col('customers').find(
    {
      captain_referral_id: { $in: referralIds },
      captain_acquired_at: { $exists: true, $ne: null },
    },
    { projection: { _id: 1 } },
  ).toArray();
  return new Set(captainRows.map((c) => c._id));
}

// ─── RECIPIENT BUILDER ───────────────────────────────────────
// Resolves the full customer_id set matching the conditions, then
// applies the wa_phone-exists final filter. Returns customer_ids +
// count so the caller can both display the count AND iterate the ids
// for an actual send.
//
// Set semantics:
//   profileQuery → set A (RFM-profile-matching customer ids in tenant)
//   captain set  → set B (restaurant's captain-acquired customer ids)
//
//   profile-only conditions, no captain      → A
//   only captain:true                        → B (captures customers
//                                                 without RFM profiles)
//   only captain:false                       → A \ B
//   profile + captain:true                   → A ∩ B
//   profile + captain:false                  → A \ B
//
// Then both are finally filtered by `wa_phone exists` on customers,
// since you can't send a marketing message to a customer without a
// phone.
async function buildRecipients(restaurantId, conditions = []) {
  if (!restaurantId) return { customerIds: [], count: 0 };

  const captainConds = (conditions || []).filter((c) => c?.field === 'captain_acquired');
  const profileConds = (conditions || []).filter((c) => c?.field !== 'captain_acquired');

  let candidateIds;

  // Path 1: pure captain query. Skip the profile read entirely so
  // brand-new captain customers without an RFM profile yet still
  // appear (matches the existing captain_acquired_90d branch's
  // profile-optional treatment in marketingCampaigns.js).
  if (profileConds.length === 0 && captainConds.length > 0 && captainConds[0].value === true) {
    candidateIds = await _getCaptainCustomerIds(restaurantId);
  } else {
    // Path 2 / 3: profile-based. Run the profile query (with empty
    // non-captain conditions if captain is the only condition with
    // value:false, returning the tenant's full RFM-profile set as the
    // baseline to subtract captains from).
    const profileQuery = buildProfileQuery(restaurantId, profileConds);
    const profiles = await col('customer_rfm_profiles').find(
      profileQuery,
      { projection: { customer_id: 1 } },
    ).toArray();
    candidateIds = new Set(profiles.map((p) => p.customer_id).filter(Boolean));

    if (captainConds.length > 0) {
      const wantCaptain = captainConds[0].value === true;
      const captainSet = await _getCaptainCustomerIds(restaurantId);
      if (wantCaptain) {
        // Intersect — keep only candidates also in the captain set.
        candidateIds = new Set([...candidateIds].filter((id) => captainSet.has(id)));
      } else {
        // Exclude — drop any candidate in the captain set.
        candidateIds = new Set([...candidateIds].filter((id) => !captainSet.has(id)));
      }
    }
  }

  if (candidateIds.size === 0) {
    return { customerIds: [], count: 0 };
  }

  const ids = [...candidateIds];
  // Final wa_phone filter. Done in one query rather than countDocuments
  // + find so both ids and count come from the same indexed scan.
  // NOTE: $in array size is bounded by the 16MB BSON limit (~250k ids).
  // For tenants approaching that scale we'd need a chunked / aggregation
  // pipeline; not in scope here.
  const validRows = await col('customers').find(
    { _id: { $in: ids }, wa_phone: { $exists: true, $ne: null } },
    { projection: { _id: 1 } },
  ).toArray();

  const customerIds = validRows.map((r) => r._id);
  return { customerIds, count: customerIds.length };
}

// ─── COUNT-ONLY CONVENIENCE ──────────────────────────────────
// Used by the cost estimator at POST /create. Same logic as
// buildRecipients but only returns the integer count — callers that
// don't need the id list can avoid materialising it.
async function countRecipients(restaurantId, conditions = []) {
  const { count } = await buildRecipients(restaurantId, conditions);
  return count;
}

module.exports = {
  validateConditions,
  buildProfileQuery,
  buildRecipients,
  countRecipients,
  // Exported for tests / consumers that want to introspect the supported
  // surface without re-declaring it.
  SUPPORTED_FIELDS,
  SUPPORTED_OPS,
};
