// tests/catalogCompression.test.js
// Tests for the Catalog Compression Engine — signature generation and compression behavior.

'use strict';

const {
  generateSkuSignature,
  generateMasterProductSignature,
  normalizeText,
  normalizeName,
  normalizePrice,
  normalizeVariantStructure,
  normalizeFoodType,
  normalizeCategory,
} = require('../src/services/catalogCompression/skuSignature');

// ═══════════════════════════════════════════════════════════════
// SIGNATURE GENERATION TESTS
// ═══════════════════════════════════════════════════════════════

describe('SKU Signature Engine', () => {

  // ── Normalization ──────────────────────────────────────────

  test('normalizeText: lowercase, trim, collapse whitespace', () => {
    expect(normalizeText('  Butter  Chicken  ')).toBe('butter chicken');
    expect(normalizeText('PANEER TIKKA')).toBe('paneer tikka');
    expect(normalizeText('')).toBe('');
    expect(normalizeText(null)).toBe('');
  });

  test('normalizeName: removes trailing punctuation', () => {
    expect(normalizeName('Butter Chicken...')).toBe('butter chicken');
    expect(normalizeName('Dal Makhani!')).toBe('dal makhani');
  });

  test('normalizePrice: rounds to integer paise', () => {
    expect(normalizePrice(29900)).toBe(29900);
    expect(normalizePrice(299.5)).toBe(300); // rounds
    expect(normalizePrice(null)).toBe(0);
    expect(normalizePrice(undefined)).toBe(0);
  });

  test('normalizeFoodType: maps to valid enum', () => {
    expect(normalizeFoodType('veg')).toBe('veg');
    expect(normalizeFoodType('non_veg')).toBe('non_veg');
    expect(normalizeFoodType('VEG')).toBe('veg');
    expect(normalizeFoodType('unknown')).toBe('veg'); // default
    expect(normalizeFoodType(null)).toBe('veg');
  });

  test('normalizeVariantStructure: order-independent', () => {
    const a = normalizeVariantStructure({ size: 'Medium', variant_type: 'size' });
    const b = normalizeVariantStructure({ size: 'medium', variant_type: 'SIZE' });
    expect(a).toBe(b); // case insensitive
  });

  // ── Signature Identity ─────────────────────────────────────

  test('same commerce identity = same signature', () => {
    const item1 = { name: 'Butter Chicken', price_paise: 29900, food_type: 'non_veg', product_tags: ['Non-Veg', 'Main Course'] };
    const item2 = { name: 'Butter Chicken', price_paise: 29900, food_type: 'non_veg', product_tags: ['Non-Veg', 'Main Course'] };
    expect(generateSkuSignature(item1)).toBe(generateSkuSignature(item2));
  });

  test('same item from different branches = same signature', () => {
    const branch1 = { name: 'Butter Chicken', price_paise: 29900, food_type: 'non_veg', branch_id: 'branch-1', product_tags: ['Non-Veg', 'Main Course'] };
    const branch2 = { name: 'Butter Chicken', price_paise: 29900, food_type: 'non_veg', branch_id: 'branch-2', product_tags: ['Non-Veg', 'Main Course'] };
    expect(generateSkuSignature(branch1)).toBe(generateSkuSignature(branch2));
  });

  test('different price = different signature', () => {
    const item1 = { name: 'Butter Chicken', price_paise: 29900, food_type: 'non_veg' };
    const item2 = { name: 'Butter Chicken', price_paise: 34900, food_type: 'non_veg' };
    expect(generateSkuSignature(item1)).not.toBe(generateSkuSignature(item2));
  });

  test('different variants = different signature', () => {
    const small = { name: 'Butter Chicken', price_paise: 19900, size: 'Small', food_type: 'non_veg' };
    const large = { name: 'Butter Chicken', price_paise: 29900, size: 'Large', food_type: 'non_veg' };
    expect(generateSkuSignature(small)).not.toBe(generateSkuSignature(large));
  });

  test('operational-only differences do NOT change signature', () => {
    const item1 = { name: 'Dal Makhani', price_paise: 19900, food_type: 'veg', sort_order: 1, is_available: true };
    const item2 = { name: 'Dal Makhani', price_paise: 19900, food_type: 'veg', sort_order: 5, is_available: false };
    expect(generateSkuSignature(item1)).toBe(generateSkuSignature(item2));
  });

  test('case differences in name do NOT change signature', () => {
    const item1 = { name: 'Butter Chicken', price_paise: 29900, food_type: 'non_veg' };
    const item2 = { name: 'butter chicken', price_paise: 29900, food_type: 'non_veg' };
    expect(generateSkuSignature(item1)).toBe(generateSkuSignature(item2));
  });

  test('different food type = different signature', () => {
    const veg = { name: 'Biryani', price_paise: 24900, food_type: 'veg' };
    const nonveg = { name: 'Biryani', price_paise: 24900, food_type: 'non_veg' };
    expect(generateSkuSignature(veg)).not.toBe(generateSkuSignature(nonveg));
  });

  // ── Master Product Signature ───────────────────────────────

  test('master signature groups variants of same product', () => {
    const small = { name: 'Butter Chicken', price_paise: 19900, size: 'Small', food_type: 'non_veg' };
    const large = { name: 'Butter Chicken', price_paise: 29900, size: 'Large', food_type: 'non_veg' };
    // SKU signatures differ (different price/size)
    expect(generateSkuSignature(small)).not.toBe(generateSkuSignature(large));
    // Master signatures are the same (same product, different variants)
    expect(generateMasterProductSignature(small)).toBe(generateMasterProductSignature(large));
  });

  test('different products have different master signatures', () => {
    const chicken = { name: 'Butter Chicken', food_type: 'non_veg' };
    const paneer = { name: 'Paneer Butter Masala', food_type: 'veg' };
    expect(generateMasterProductSignature(chicken)).not.toBe(generateMasterProductSignature(paneer));
  });

  // ── Signature stability ────────────────────────────────────

  test('signature is a 64-char hex string (SHA-256)', () => {
    const sig = generateSkuSignature({ name: 'Test', price_paise: 100, food_type: 'veg' });
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
  });

  test('signature is deterministic across calls', () => {
    const item = { name: 'Consistent Item', price_paise: 15000, food_type: 'veg', size: 'Regular' };
    const sig1 = generateSkuSignature(item);
    const sig2 = generateSkuSignature(item);
    const sig3 = generateSkuSignature(item);
    expect(sig1).toBe(sig2);
    expect(sig2).toBe(sig3);
  });
});
