// src/services/catalogCompression/skuSignature.js
// Deterministic signature engine for catalog compression.
// Generates stable, order-independent signatures based on commerce identity.
// Used to decide whether two raw menu items map to the same compressed SKU.

'use strict';

const crypto = require('crypto');

// ─── TEXT NORMALIZATION ─────────────────────────────────────
// Normalize a string for signature comparison — lowercase, trim, collapse whitespace,
// remove common noise words that don't change commerce identity.
function normalizeText(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')          // collapse whitespace
    .replace(/[''`]/g, "'")        // normalize quotes
    .replace(/[""]/g, '"')
    .replace(/[—–]/g, '-')         // normalize dashes
    .replace(/[^\w\s\-.'"/&+()]/g, '') // strip non-semantic chars
    .trim();
}

// Normalize a product name — more aggressive: remove articles, trailing punctuation
function normalizeName(name) {
  if (!name) return '';
  let n = normalizeText(name);
  // Remove trailing special chars that don't affect commerce identity
  n = n.replace(/[.!?:;,]+$/, '').trim();
  return n;
}

// Normalize price to integer paise (stable, no floating point issues)
function normalizePrice(pricePaise) {
  if (pricePaise == null) return 0;
  return Math.round(Number(pricePaise) || 0);
}

// Normalize variant structure for signature — order-independent
// Input: { size: "Medium", variant_type: "size", variant_value: "Medium" }
// Output: deterministic string
function normalizeVariantStructure(item) {
  const parts = [];
  const size = normalizeText(item.size || item.variant_value || '');
  const variantType = normalizeText(item.variant_type || '');
  if (size) parts.push(`size:${size}`);
  if (variantType && variantType !== 'size') parts.push(`type:${variantType}`);
  // Sort for order-independence
  parts.sort();
  return parts.join('|');
}

// Normalize food type for signature
function normalizeFoodType(foodType) {
  const valid = { veg: 'veg', non_veg: 'non_veg', vegan: 'vegan', egg: 'egg' };
  return valid[normalizeText(foodType)] || 'veg';
}

// Normalize category for signature
function normalizeCategory(item) {
  // Use product_tags[1] (category tag) if available, else category name
  const catTag = (item.product_tags && item.product_tags[1]) ? normalizeText(item.product_tags[1]) : '';
  return catTag || normalizeText(item.category_name || '');
}

// Normalize media identity — image URL affects published appearance
function normalizeMediaIdentity(item) {
  // If item has an image, include a normalized form in signature
  // Only the path matters (ignore CDN domain, query params)
  if (!item.image_url) return '';
  try {
    const url = new URL(item.image_url);
    return url.pathname.toLowerCase();
  } catch {
    return normalizeText(item.image_url);
  }
}

// ─── SIGNATURE GENERATION ───────────────────────────────────

/**
 * Generate a deterministic SKU signature from a raw menu item.
 * Two items with the same signature should map to the same compressed SKU.
 *
 * Based on commerce identity:
 * - normalized name
 * - price (in paise)
 * - variant structure
 * - food type
 * - category
 * - media identity (optional — set includeMedia:true for image-sensitive compression)
 *
 * NOT included (operational-only):
 * - branch_id, prep_time, stock, sort_order, internal notes, availability
 *
 * @param {object} item - Raw menu_items document
 * @param {object} opts - { includeMedia: boolean }
 * @returns {string} - Hex SHA-256 signature (64 chars)
 */
function generateSkuSignature(item, opts = {}) {
  const parts = [
    'n:' + normalizeName(item.name),
    'p:' + normalizePrice(item.price_paise),
    'v:' + normalizeVariantStructure(item),
    'f:' + normalizeFoodType(item.food_type),
    'c:' + normalizeCategory(item),
  ];

  if (opts.includeMedia) {
    parts.push('m:' + normalizeMediaIdentity(item));
  }

  const input = parts.join('||');
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Generate a master product signature — groups all variants of the same product.
 * Based on normalized name + food type + category only (not price/size).
 *
 * @param {object} item - Raw menu_items document
 * @returns {string} - Hex SHA-256 (64 chars)
 */
function generateMasterProductSignature(item) {
  const parts = [
    'n:' + normalizeName(item.name),
    'f:' + normalizeFoodType(item.food_type),
    'c:' + normalizeCategory(item),
  ];
  const input = parts.join('||');
  return crypto.createHash('sha256').update(input).digest('hex');
}

module.exports = {
  generateSkuSignature,
  generateMasterProductSignature,
  // Expose internals for testing
  normalizeText,
  normalizeName,
  normalizePrice,
  normalizeVariantStructure,
  normalizeFoodType,
  normalizeCategory,
  normalizeMediaIdentity,
};
