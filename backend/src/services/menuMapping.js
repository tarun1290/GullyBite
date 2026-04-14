// src/services/menuMapping.js
// Auto-mapping + transformation + normalisation for raw XLSX menu uploads.
//
// Pipeline (called from routes/menuUpload.js):
//   raw_data ─▶ autoMapColumns ─▶ transformUpload ─▶ normalizeProduct ─▶ insert
//
// Each step is a pure function so it can be unit-tested without DB.
// Existing menu_items schema is NOT modified — `meta_status`,
// `normalized`, and `source_upload_id` are simply additive fields
// stamped onto inserted rows.

'use strict';

const fs = require('fs');
const { col } = require('../config/database');
const productSvc = require('./product.service');
const { parseXlsxBuffer } = require('../utils/xlsxParser');
const log = require('../utils/logger').child({ component: 'menuMapping' });

// Phase 4: re-parse an upload's XLSX from its storage backend
// (S3 or local disk). Returns the full row array as `parseXlsxBuffer`
// would, or [] if the fetch fails.
async function _reparseFromStorage(upload) {
  try {
    let buffer;
    if (upload.file_storage === 's3' && upload.file_bucket && upload.file_key) {
      const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
      const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
      const out = await s3.send(new GetObjectCommand({ Bucket: upload.file_bucket, Key: upload.file_key }));
      const chunks = [];
      for await (const chunk of out.Body) chunks.push(chunk);
      buffer = Buffer.concat(chunks);
    } else {
      // local fallback — file_url is 'file://<abs>' or a raw path
      const absPath = upload.file_url?.startsWith('file://')
        ? upload.file_url.slice('file://'.length)
        : (upload.file_key || upload.file_url);
      buffer = fs.readFileSync(absPath);
    }
    const parsed = parseXlsxBuffer(buffer);
    return parsed.rows || [];
  } catch (err) {
    log.error({ err, uploadId: upload._id }, 'failed to re-parse XLSX from storage');
    return [];
  }
}

// ─── 1. AUTO-MAPPING ────────────────────────────────────────
// Keyword → canonical-field detection. Header matching is
// case-insensitive, ignores non-alphanumeric chars, and prefers the
// first column that contains ANY of the keywords. Returning a sparse
// object lets the caller fill remaining fields manually.
const FIELD_KEYWORDS = {
  name:        ['itemname', 'productname', 'item', 'product', 'name', 'dish'],
  price:       ['price', 'rate', 'cost', 'mrp', 'amount', 'sellingprice'],
  category:    ['category', 'cat', 'type', 'section', 'group'],
  description: ['description', 'desc', 'about', 'details'],
  image:       ['image', 'imageurl', 'photo', 'picture', 'img'],
  food_type:   ['foodtype', 'vegnonveg', 'vegnon', 'vegtype', 'diet'],
  tax:         ['tax', 'taxpercentage', 'gst', 'gstpct'],
  availability:['available', 'availability', 'instock', 'isavailable', 'active'],
};

function _normHeader(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function autoMapColumns(rawDataSample) {
  const sample = Array.isArray(rawDataSample) ? rawDataSample : [];
  const headers = sample.length ? Object.keys(sample[0]) : [];
  const headersNorm = headers.map(h => ({ raw: h, norm: _normHeader(h) }));

  const mapping = {};
  for (const [field, keywords] of Object.entries(FIELD_KEYWORDS)) {
    // Pick the first header whose normalised form contains any keyword.
    // Prefer exact match over substring (e.g., "name" beats "brandname").
    const exact = headersNorm.find(h => keywords.includes(h.norm));
    const fuzzy = headersNorm.find(h => keywords.some(k => h.norm.includes(k)));
    const chosen = exact || fuzzy;
    if (chosen) mapping[field] = chosen.raw;
  }
  return mapping;
}

// ─── 2. TRANSFORMATION ──────────────────────────────────────
// Apply mapping_config to each raw row. Output rows are NOT yet
// inserted — they're just shaped into the canonical product object.
function _row(raw, map) {
  const get = field => map[field] ? raw[map[field]] : undefined;
  return {
    name:        get('name'),
    price:       get('price'),
    category:    get('category'),
    description: get('description'),
    image_url:   get('image'),
    food_type:   get('food_type'),
    tax_percentage: get('tax'),
    availability:   get('availability'),
  };
}

async function transformUpload(uploadId, mappingOverride) {
  const upload = await col('menu_uploads').findOne({ _id: String(uploadId) });
  if (!upload) throw Object.assign(new Error('upload not found'), { statusCode: 404 });

  // Phase 4: raw_data is no longer persisted for new uploads — the
  // XLSX lives in S3 (or local fallback). Re-parse on demand.
  let raw = Array.isArray(upload.raw_data) ? upload.raw_data : null;
  if (!raw) raw = await _reparseFromStorage(upload);

  // Mapping precedence: explicit override → stored mapping → auto-detected
  const mapping = mappingOverride
    || upload.column_mapping
    || autoMapColumns(raw.slice(0, 5));

  const products = raw.map(r => _row(r, mapping));
  return { upload, mapping, products };
}

// ─── 2b. CATEGORY DETECTION ─────────────────────────────────
// Lightweight keyword classifier for product names. Used ONLY when
// the upload row has no category, or has the catch-all "General".
// Order matters: more specific keywords must precede broader ones
// (e.g., "paneer biryani" should land in Biryani, not Veg).
const CATEGORY_KEYWORDS = [
  ['Pizza',         ['pizza']],
  ['Burgers',       ['burger']],
  ['Sandwiches',    ['sandwich']],
  ['South Indian',  ['dosa', 'idli', 'vada', 'uttapam', 'sambar']],
  ['Biryani',       ['biryani', 'biriyani']],
  ['Beverages',     ['beverage', 'drink', 'juice', 'soda', 'coffee', 'tea', 'lassi', 'shake', 'smoothie']],
  ['Non-Veg',       ['chicken', 'mutton', 'fish', 'prawn', 'egg', 'lamb', 'beef']],
  ['Veg',           ['paneer', 'aloo', 'dal', 'veg ', 'vegetable']],
];

function detectCategory(productName) {
  const n = String(productName || '').toLowerCase().trim();
  if (!n) return 'General';
  for (const [label, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some(k => n.includes(k))) return label;
  }
  return 'General';
}

// ─── 2c. PRICE ANOMALY DETECTION ────────────────────────────
// Cheap range-check used to flag obviously-off prices on import.
// Flagging only — never blocks creation. Bands are intentionally
// blunt (₹ assumed); refine with per-category baselines later.
const PRICE_LOW_THRESHOLD  = 150;
const PRICE_HIGH_THRESHOLD = 500;

function detectPriceAnomaly(product) {
  const p = product && product.price;
  if (p == null || !Number.isFinite(p)) return 'normal';
  if (p < PRICE_LOW_THRESHOLD)  return 'low';
  if (p > PRICE_HIGH_THRESHOLD) return 'high';
  return 'normal';
}

// ─── 3. NORMALISATION ───────────────────────────────────────
// Fill defaults, coerce types, decide meta_status. The output is
// safe to insert: required fields are present or explicitly nulled,
// and meta_status flags rows that still need operator attention.
const DEFAULT_IMAGE_URL = process.env.MENU_DEFAULT_IMAGE_URL
  || 'https://placehold.co/600x400?text=No+Image';

function _toNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  // Strip currency symbols, commas, whitespace.
  const cleaned = String(v).replace(/[^\d.\-]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function _toBool(v, fallback = true) {
  if (v == null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase().trim();
  if (['1', 'true', 'yes', 'y', 'available', 'in stock', 'active'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'unavailable', 'out of stock', 'inactive'].includes(s)) return false;
  return fallback;
}

function normalizeProduct(input) {
  const name = (input.name || '').toString().trim();
  const price = _toNumber(input.price);

  // Existing logic preserved: trimmed input wins, fallback "General".
  // Enhancement: if the result is missing/empty/"General", try the
  // keyword classifier on the product name to upgrade it.
  let category = input.category?.toString().trim() || 'General';
  if (!category || category.toLowerCase() === 'general') {
    category = detectCategory(name);
  }

  const out = {
    name,
    description:  input.description?.toString().trim() || name,
    category,
    price,                                  // ₹; null if unparseable
    currency:     'INR',
    availability: _toBool(input.availability, true),
    image_url:    input.image_url?.toString().trim() || DEFAULT_IMAGE_URL,
    food_type:    input.food_type?.toString().toLowerCase().trim() || null,
    tax_percentage: _toNumber(input.tax_percentage),
    normalized:   true,
  };

  // Price-anomaly flag (advisory; never rejects).
  out.price_flag = detectPriceAnomaly(out);

  // Required = name + numeric price. Anything else missing is a soft
  // gap that operators can fix later without blocking the import.
  out.meta_status = (out.name && out.price != null && out.price >= 0) ? 'ready' : 'incomplete';

  // Anomalous prices downgrade meta_status so operators review them
  // before WhatsApp sync. The product is still inserted (not rejected).
  if (out.meta_status === 'ready' && out.price_flag !== 'normal') {
    out.meta_status = 'incomplete';
  }
  return out;
}

// ─── 4. INSERT INTO menu_items ──────────────────────────────
// Reuses product.service.createProduct so the legacy schema rules
// (retailer_id, timestamps, branch_ids defaults) stay centralised.
// Stamps the additive trace fields: source_upload_id, normalized,
// meta_status. Branch assignment is intentionally skipped — products
// land as is_unassigned=true per spec.
async function insertNormalizedProducts(restaurantId, uploadId, normalizedRows) {
  const inserted = [];
  const skipped  = [];
  for (const row of normalizedRows) {
    if (row.meta_status !== 'ready') {
      skipped.push({ name: row.name || '(unnamed)', reason: 'incomplete' });
      // Still insert incomplete rows so operators can fix them in-app —
      // but mark them clearly. Comment out this block to hard-skip.
    }
    try {
      const product = await productSvc.createProduct({
        restaurant_id: restaurantId,
        name:          row.name || '(unnamed)',
        description:   row.description,
        price_rs:      row.price ?? 0,
        tax_percentage:row.tax_percentage,
        food_type:     row.food_type,
        image_url:     row.image_url,
      });
      // Stamp additive fields on the row we just wrote.
      await col('menu_items').updateOne(
        { _id: product._id },
        { $set: {
            source_upload_id: String(uploadId),
            normalized:       true,
            meta_status:      row.meta_status,
            category_name:    row.category,
            currency:         row.currency,
            is_available:     row.availability,
            price_flag:       row.price_flag || 'normal',
        }},
      );
      inserted.push({ id: product._id, name: product.name, meta_status: row.meta_status });
    } catch (e) {
      skipped.push({ name: row.name || '(unnamed)', reason: e.message });
    }
  }
  return { inserted, skipped };
}

module.exports = {
  autoMapColumns,
  transformUpload,
  normalizeProduct,
  insertNormalizedProducts,
  detectCategory,
  detectPriceAnomaly,
};
