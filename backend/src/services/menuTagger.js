// src/services/menuTagger.js
// Pure-ish helpers for validating extracted tags against the canonical
// taxonomy, promoting unknown values into the tag_candidates collection
// for human review, and computing the canonical price band from a
// median price.
//
// No LLM calls here — this module operates on the output of whatever
// extractor (LLM or otherwise) produced the tags. See the placeholder
// in menuResearchAgent.js step 7 for where extraction will plug in.

'use strict';

const { newId } = require('../config/database');

// Array-valued taxonomy fields. Each is a flat string[] in the taxonomy
// doc seeded by scripts/seed-tag-taxonomy.js.
const ARRAY_FIELDS = [
  'cuisine_primary',
  'vibe_tags',
  'meal_contexts',
  'service_modes',
  'dietary_flags',
];

// ─── validateAndSplitTags ───────────────────────────────────────────
// Partition extractedTags into known-good values (validTags) and
// unknowns that need human review (unknownTags). The output shape
// mirrors the input shape for array fields; single-value fields
// (price_band, veg_status) appear in validTags only if the value is
// recognised, and in unknownTags as a single-element array if not.
//
// Tolerates missing/empty arrays — those just produce [] in validTags
// and no entry in unknownTags.
function validateAndSplitTags(extractedTags, taxonomy) {
  const validTags = {};
  const unknownTags = {};

  const tax = taxonomy || {};
  const safeTags = extractedTags || {};

  // Array-typed fields.
  for (const field of ARRAY_FIELDS) {
    const incoming = Array.isArray(safeTags[field]) ? safeTags[field] : [];
    const allowed = Array.isArray(tax[field]) ? tax[field] : [];
    const allowedSet = new Set(allowed);

    const valid = [];
    const unknown = [];
    for (const v of incoming) {
      if (v == null) continue;
      if (allowedSet.has(v)) valid.push(v);
      else unknown.push(v);
    }
    validTags[field] = valid;
    if (unknown.length > 0) unknownTags[field] = unknown;
  }

  // price_band — single value, key checked against taxonomy.price_bands[].key.
  if (Object.prototype.hasOwnProperty.call(safeTags, 'price_band') && safeTags.price_band != null) {
    const bands = Array.isArray(tax.price_bands) ? tax.price_bands : [];
    const bandKeys = new Set(bands.map((b) => b && b.key).filter(Boolean));
    if (bandKeys.has(safeTags.price_band)) {
      validTags.price_band = safeTags.price_band;
    } else {
      unknownTags.price_band = [safeTags.price_band];
    }
  }

  // veg_status — single value, checked against taxonomy.veg_status_options[].
  if (Object.prototype.hasOwnProperty.call(safeTags, 'veg_status') && safeTags.veg_status != null) {
    const opts = Array.isArray(tax.veg_status_options) ? tax.veg_status_options : [];
    const optsSet = new Set(opts);
    if (optsSet.has(safeTags.veg_status)) {
      validTags.veg_status = safeTags.veg_status;
    } else {
      unknownTags.veg_status = [safeTags.veg_status];
    }
  }

  return { validTags, unknownTags };
}

// ─── promoteCandidateTags ───────────────────────────────────────────
// For each unknown (field, value) pair, upsert into tag_candidates,
// bumping suggested_count and recording this listing as a source. Once
// suggested_count crosses some threshold a human admin can review &
// promote into the canonical taxonomy.
async function promoteCandidateTags(unknownTags, listingId, db) {
  if (!unknownTags || typeof unknownTags !== 'object') return;
  for (const [field, values] of Object.entries(unknownTags)) {
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (value == null) continue;
      await db.collection('tag_candidates').updateOne(
        { tag_field: field, candidate_value: value },
        {
          $inc: { suggested_count: 1 },
          $addToSet: { source_listing_ids: listingId },
          $setOnInsert: {
            _id: newId(),
            tag_field: field,
            candidate_value: value,
            status: 'pending',
            created_at: new Date(),
          },
        },
        { upsert: true },
      );
    }
  }
}

// ─── computePriceBand ───────────────────────────────────────────────
// Bucket a median price (₹) into the canonical price_band key. Keys
// match taxonomy.price_bands[].key.
function computePriceBand(medianPriceRs) {
  if (typeof medianPriceRs !== 'number' || !isFinite(medianPriceRs) || medianPriceRs <= 0) return null;
  if (medianPriceRs < 200) return 'budget';
  if (medianPriceRs < 500) return 'mid';
  if (medianPriceRs < 1000) return 'premium';
  return 'luxury';
}

module.exports = { validateAndSplitTags, promoteCandidateTags, computePriceBand };
