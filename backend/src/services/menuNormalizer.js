// src/services/menuNormalizer.js
// Universal column auto-mapper for menu bulk uploads
// Accepts any spreadsheet format: Meta Commerce, Swiggy, Zomato, custom, or our template

'use strict';

// ─── ALIAS DICTIONARY ────────────────────────────────────────
const FIELD_ALIASES = {
  name: ['title', 'item_name', 'item', 'product_name', 'product', 'menu_item', 'dish', 'dish_name', 'item_title', 'product_title'],
  description: ['desc', 'item_description', 'product_description', 'details', 'about', 'item_desc', 'info'],
  price: ['rate', 'amount', 'cost', 'mrp', 'base_price', 'unit_price', 'selling_price', 'sp', 'rs', 'inr'],
  sale_price: ['offer_price', 'discount_price', 'special_price', 'discounted_price'],
  category: ['section', 'menu_section', 'menu_category', 'group', 'item_category', 'custom_label_4', 'course', 'cat'],
  food_type: ['type', 'veg_type', 'veg_nonveg', 'diet_type', 'food_category', 'dietary', 'veg', 'is_veg', 'veg/non-veg'],
  subcategory: ['sub_category', 'sub_cat', 'custom_label_1'],
  size: ['variant', 'portion', 'serving', 'quantity_label', 'option', 'variant_value', 'size_name'],
  branch: ['outlet', 'location', 'branch_name', 'store', 'branch_slug', 'outlet_name', 'custom_label_3', 'store_name'],
  image_url: ['image', 'image_link', 'photo', 'photo_url', 'img', 'img_url', 'picture', 'thumbnail'],
  item_group_id: ['group_id', 'variant_group', 'product_group', 'variant_id'],
  brand: ['restaurant', 'restaurant_name', 'brand_name'],
  is_bestseller: ['bestseller', 'popular', 'featured', 'hot', 'recommended', 'best', 'top'],
  availability: ['stock', 'in_stock', 'available', 'status'],
};

// Build reverse lookup: alias → field
const ALIAS_MAP = {};
for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
  ALIAS_MAP[field.toLowerCase()] = field;
  for (const alias of aliases) {
    ALIAS_MAP[alias.toLowerCase()] = field;
  }
}

// ─── PRICE NORMALIZER ────────────────────────────────────────
function normalizePrice(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'number') return val;
  const cleaned = String(val).replace(/[₹,\sINRRs.]/gi, '').trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// ─── FOOD TYPE NORMALIZER ────────────────────────────────────
function normalizeFoodType(val) {
  if (!val) return null;
  const lower = String(val).toLowerCase().trim();
  if (['veg', 'vegetarian', 'pure veg', 'v'].includes(lower)) return 'Veg';
  if (['non-veg', 'nonveg', 'non veg', 'nv', 'meat', 'non_veg'].includes(lower)) return 'Non-Veg';
  if (['egg', 'eggetarian'].includes(lower)) return 'Egg';
  if (lower === 'jain') return 'Jain';
  if (['vegan', 'plant-based', 'plant based'].includes(lower)) return 'Vegan';
  return null;
}

// ─── AVAILABILITY NORMALIZER ─────────────────────────────────
function normalizeAvailability(val) {
  if (val == null) return true;
  const lower = String(val).toLowerCase().trim();
  return lower === 'in stock' || lower === 'true' || lower === '1' || lower === 'yes' || lower === 'available';
}

// ─── CONTENT-BASED COLUMN DETECTION ──────────────────────────
function detectByContent(header, sampleValues) {
  if (!sampleValues.length) return null;
  const nonEmpty = sampleValues.filter(v => v != null && v !== '');
  if (!nonEmpty.length) return null;

  // Price detection: most values are numbers 10-50000
  const numericCount = nonEmpty.filter(v => { const n = normalizePrice(v); return n !== null && n >= 1 && n <= 50000; }).length;
  if (numericCount > nonEmpty.length * 0.7) return 'price';

  // Food type detection
  const foodTypeCount = nonEmpty.filter(v => normalizeFoodType(v) !== null).length;
  if (foodTypeCount > nonEmpty.length * 0.6) return 'food_type';

  // URL detection (image)
  const urlCount = nonEmpty.filter(v => String(v).startsWith('http')).length;
  if (urlCount > nonEmpty.length * 0.5) return 'image_url';

  // Availability detection
  const availCount = nonEmpty.filter(v => ['in stock', 'out of stock', 'available', 'unavailable'].includes(String(v).toLowerCase().trim())).length;
  if (availCount > nonEmpty.length * 0.5) return 'availability';

  return null;
}

// ─── MAIN NORMALIZER ─────────────────────────────────────────
function normalizeMenuData(headers, rows) {
  const mappedColumns = {};   // header → internal field
  const unmappedColumns = []; // headers we couldn't match
  const warnings = [];

  // Step A + B: Match headers to fields via exact match + alias match
  const usedFields = new Set();
  for (const header of headers) {
    const lower = header.toLowerCase().replace(/[\s\-\.]+/g, '_').trim();
    const field = ALIAS_MAP[lower];
    if (field && !usedFields.has(field)) {
      mappedColumns[header] = field;
      usedFields.add(field);
    }
  }

  // Step C: Content-based detection for unmapped columns
  const unmappedHeaders = headers.filter(h => !mappedColumns[h]);
  for (const header of unmappedHeaders) {
    const sampleValues = rows.slice(0, 20).map(r => r[header]).filter(v => v != null);
    const detected = detectByContent(header, sampleValues);
    if (detected && !usedFields.has(detected)) {
      mappedColumns[header] = detected;
      usedFields.add(detected);
      warnings.push(`Column "${header}" auto-detected as "${detected}" based on content`);
    } else {
      unmappedColumns.push(header);
    }
  }

  // Check required fields
  const hasMappedName = Object.values(mappedColumns).includes('name');
  const hasMappedPrice = Object.values(mappedColumns).includes('price');
  if (!hasMappedName) warnings.push('CRITICAL: Could not find a "name" column. Your file has: ' + headers.join(', '));
  if (!hasMappedPrice) warnings.push('CRITICAL: Could not find a "price" column. Your file has: ' + headers.join(', '));

  // Build reverse map: internal field → original header
  const fieldToHeader = {};
  for (const [header, field] of Object.entries(mappedColumns)) {
    fieldToHeader[field] = header;
  }

  // Normalize rows
  const normalizedRows = [];
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const normalized = {};

    for (const [header, field] of Object.entries(mappedColumns)) {
      let val = raw[header];
      if (val === undefined || val === null || val === '') { normalized[field] = null; continue; }

      // Apply field-specific normalization
      if (field === 'price' || field === 'sale_price') val = normalizePrice(val);
      else if (field === 'food_type') val = normalizeFoodType(val) || String(val).trim();
      else if (field === 'availability') val = normalizeAvailability(val);
      else if (field === 'is_bestseller') val = ['true', 'yes', '1'].includes(String(val).toLowerCase().trim());
      else val = String(val).trim();

      normalized[field] = val;
    }

    // Skip rows with no name
    if (!normalized.name) {
      if (i > 0) warnings.push(`Row ${i + 2}: skipped (no name)`);
      continue;
    }

    normalizedRows.push(normalized);
  }

  return { mappedColumns, fieldToHeader, normalizedRows, unmappedColumns, warnings };
}

module.exports = { normalizeMenuData, normalizePrice, normalizeFoodType, normalizeAvailability, FIELD_ALIASES };
