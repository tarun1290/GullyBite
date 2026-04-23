// src/routes/menuUpload.js
// XLSX-only menu file ingestion. Stores raw rows in `menu_uploads`.
// Mapping/normalisation is deliberately out-of-scope — see spec.
//
// Mounted at: /api/restaurant/menu
//   POST /upload   — multipart "file" field, .xlsx only
//   GET  /uploads  — list this restaurant's previous uploads (ops/debug)

'use strict';

const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const { col, newId } = require('../config/database');
const { requireAuth } = require('./auth');
const { parseXlsxBuffer } = require('../utils/xlsxParser');
const mappingSvc = require('../services/menuMapping');
const s3Storage = require('../services/s3Storage');
const log = require('../utils/logger').child({ component: 'menuUpload' });

// ── Storage: local disk by default. Override dir via MENU_UPLOAD_DIR.
// S3 can be wired in later by swapping the writer below — kept simple
// to avoid coupling this route to the image-upload pipeline.
const UPLOAD_DIR = process.env.MENU_UPLOAD_DIR
  || path.join(process.cwd(), 'uploads', 'menu');

function _ensureDir() {
  try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (_) { /* ignore */ }
}

// ── Multer: in-memory, 10 MB cap, XLSX MIME / extension only.
const XLSX_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel.sheet.macroEnabled.12',                    // .xlsm (treated as xlsx-family)
  'application/octet-stream', // some clients send this; we re-validate by extension
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits : { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const okExt  = ext === '.xlsx';
    const okMime = XLSX_MIMES.has(file.mimetype);
    if (okExt && okMime) return cb(null, true);
    cb(new Error('Only .xlsx files are accepted'));
  },
});

// ── POST /upload ────────────────────────────────────────────
router.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: file)' });
    const restaurantId = req.restaurantId;
    if (!restaurantId) return res.status(401).json({ error: 'No restaurant context' });

    // Parse first (validates the file before we persist anything).
    const parsed = parseXlsxBuffer(req.file.buffer);

    // Phase 4: push the raw XLSX to S3 (or local-disk fallback) and
    // persist ONLY a preview sample on the Mongo row. Full rows are
    // re-parsed from the stored file at import time. Keeps the
    // menu_uploads collection query-fast and backup-friendly.
    const uploaded = await s3Storage.uploadBuffer({
      buffer: req.file.buffer,
      prefix: `menu-uploads/${restaurantId}`,
      originalName: req.file.originalname,
      contentType: req.file.mimetype || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    const doc = {
      _id:            newId(),
      restaurant_id:  restaurantId,
      file_type:      'xlsx',
      file_url:       uploaded.url,
      file_storage:   uploaded.storage,   // 's3' | 'local'
      file_key:       uploaded.key,
      file_bucket:    uploaded.bucket || null,
      file_size:      req.file.size || req.file.buffer.length,
      original_name:  req.file.originalname,
      sheet_name:     parsed.sheetName,
      row_count:      parsed.rowCount,
      // Small inline preview — enough to power /mapping UX without
      // reading the full file. Full rows are re-parsed at import.
      preview_sample: parsed.rows.slice(0, 20),
      status:         'uploaded',
      created_at:     new Date(),
    };
    await col('menu_uploads').insertOne(doc);

    log.info({ restaurantId, uploadId: doc._id, rows: parsed.rowCount }, 'menu xlsx ingested');
    res.json({
      upload_id:  doc._id,
      file_type:  doc.file_type,
      file_url:   doc.file_url,
      sheet_name: doc.sheet_name,
      row_count:  doc.row_count,
      status:     doc.status,
      preview:    parsed.rows.slice(0, 5),
    });
  } catch (e) {
    if (e instanceof multer.MulterError || /Only .xlsx files/.test(e.message)) {
      return res.status(400).json({ error: e.message });
    }
    log.error({ err: e }, 'menu upload failed');
    res.status(500).json({ error: e.message });
  }
});

// ── GET /uploads ────────────────────────────────────────────
router.get('/uploads', requireAuth, async (req, res) => {
  try {
    const restaurantId = req.restaurantId;
    const items = await col('menu_uploads').find({ restaurant_id: restaurantId })
      .sort({ created_at: -1 }).toArray();
    res.json(items.map(d => ({
      upload_id: d._id, file_type: d.file_type, file_url: d.file_url,
      sheet_name: d.sheet_name, row_count: d.row_count,
      status: d.status, created_at: d.created_at,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /mapping ───────────────────────────────────────────
// Body: { upload_id, column_mapping? }
// If column_mapping is omitted, autoMapColumns runs against the
// first 5 raw rows. The chosen mapping is persisted on the upload
// so /import can replay it without re-detecting.
router.post('/mapping', express.json({ limit: '2mb' }), requireAuth, async (req, res) => {
  try {
    const restaurantId = req.restaurantId;
    const { upload_id, column_mapping } = req.body || {};
    if (!upload_id) return res.status(400).json({ error: 'upload_id required' });

    const upload = await col('menu_uploads').findOne({ _id: String(upload_id), restaurant_id: restaurantId });
    if (!upload) return res.status(404).json({ error: 'upload not found' });

    // Phase 4: prefer the inline preview_sample (new uploads); fall
    // back to legacy raw_data for rows written before the S3 refactor.
    const sample = (upload.preview_sample || upload.raw_data || []).slice(0, 5);
    const auto   = mappingSvc.autoMapColumns(sample);
    const final  = column_mapping && Object.keys(column_mapping).length
      ? { ...auto, ...column_mapping } // operator override wins per-field
      : auto;

    await col('menu_uploads').updateOne(
      { _id: upload._id },
      { $set: { column_mapping: final, auto_mapping: auto, status: 'mapped', mapped_at: new Date() } },
    );

    res.json({
      upload_id: upload._id,
      auto_mapping: auto,
      column_mapping: final,
      detected_headers: sample.length ? Object.keys(sample[0]) : [],
      sample_rows: sample,
    });
  } catch (e) {
    log.error({ err: e }, 'menu mapping failed');
    res.status(500).json({ error: e.message });
  }
});

// ── POST /import ────────────────────────────────────────────
// Body: { upload_id, column_mapping? }
// One-shot: transform → normalize → insert. Operates whether or not
// /mapping was called first; if column_mapping is missing on the
// upload doc and not in the body, autoMapColumns kicks in.
router.post('/import', express.json({ limit: '2mb' }), requireAuth, async (req, res) => {
  try {
    const restaurantId = req.restaurantId;
    const { upload_id, column_mapping } = req.body || {};
    if (!upload_id) return res.status(400).json({ error: 'upload_id required' });

    const owned = await col('menu_uploads').findOne({ _id: String(upload_id), restaurant_id: restaurantId });
    if (!owned) return res.status(404).json({ error: 'upload not found' });

    const { mapping, products } = await mappingSvc.transformUpload(upload_id, column_mapping);

    // CRIT-2A-03: normalizeProduct now builds retailer_id / product_tags
    // from a slug context. Upload is restaurant-level (products land
    // unassigned), so we seed the slug from the restaurant. When the
    // item carries an explicit branch, that still wins inside the
    // normalizer.
    const restaurant = await col('restaurants').findOne(
      { _id: restaurantId },
      { projection: { slug: 1, business_name: 1, name: 1 } },
    );
    const context = {
      restaurantSlug: restaurant?.slug || null,
      restaurantName: restaurant?.business_name || restaurant?.name || null,
    };
    const normalized = products.map(p => mappingSvc.normalizeProduct(p, context));

    let result;
    try {
      result = await mappingSvc.insertNormalizedProducts(restaurantId, upload_id, normalized);
    } catch (e) {
      if (e.statusCode === 400 && Array.isArray(e.duplicates)) {
        return res.status(400).json({
          error: 'retailer_id conflicts in upload',
          duplicates: e.duplicates,
        });
      }
      throw e;
    }

    await col('menu_uploads').updateOne(
      { _id: owned._id },
      { $set: {
          status: result.inserted.length ? 'imported' : 'failed',
          mapping_used: mapping,
          imported_at: new Date(),
          imported_count: result.inserted.length,
          skipped_count:  result.skipped.length,
      }},
    );

    res.json({
      upload_id,
      mapping_used: mapping,
      total: normalized.length,
      inserted: result.inserted.length,
      skipped:  result.skipped.length,
      ready:       normalized.filter(n => n.meta_status === 'ready').length,
      incomplete:  normalized.filter(n => n.meta_status === 'incomplete').length,
      details: { inserted: result.inserted, skipped: result.skipped },
    });
  } catch (e) {
    log.error({ err: e }, 'menu import failed');
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
