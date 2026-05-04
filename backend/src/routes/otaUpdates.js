// src/routes/otaUpdates.js
// Self-hosted Expo OTA endpoints. Lets the staff app pull JS-only
// updates straight from EC2 → S3/CloudFront, no APK rebuild required.
//
// Three surfaces, all mounted at /api/ota:
//
//   POST /api/ota/upload                — admin uploads a fresh bundle
//   POST /api/ota/activate/:updateId    — admin flips an upload live
//   GET  /api/ota/manifest              — PUBLIC; staff app polls here
//
// Storage:
//   S3 (via services/s3Storage.uploadBuffer) for bundle + assets.
//   Mongo collection `ota_updates` holds metadata + the precomputed
//   manifest blob the staff app receives verbatim.
//
// Public manifest endpoint: Expo's expo-updates protocol does NOT
// send Authorization headers on manifest fetch. Keep this route open;
// the response carries no secrets, just the immutable bundle URLs and
// hashes the runtime needs to integrity-check the download.

'use strict';

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const router = express.Router();

const { col } = require('../config/database');
const s3Storage = require('../services/s3Storage');
const { requireAdminAuth } = require('../middleware/adminAuth');
const log = require('../utils/logger').child({ component: 'otaUpdates' });

const requireAdmin = requireAdminAuth();

// Memory storage — buffers go straight to s3Storage.uploadBuffer().
// 25 MB per file ceiling matches the practical Hermes bundle size for
// a JS-only OTA. Bundle itself is typically 1-3 MB; the cap exists
// just to cut off a malformed/binary upload before it eats RAM.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ─── HELPERS ────────────────────────────────────────────────────

// CloudFront base URL — same env-var pattern as services/imageUpload.js.
// Returns the bare domain (no protocol, no trailing slash) so we can
// stitch it onto an S3 key with a single `https://${domain}/${key}`.
function _cdnDomain() {
  const raw = process.env.CLOUDFRONT_URL || process.env.AWS_CLOUDFRONT_DOMAIN || '';
  return raw.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

function _publicUrl(key) {
  const domain = _cdnDomain();
  if (!domain) {
    // No CloudFront wired up — fall back to the s3:// URL. The staff
    // app can't actually fetch this, but it surfaces the misconfig
    // loudly via the runtime "asset failed to load" path rather than a
    // generic 404.
    return `s3://${process.env.S3_BUCKET || 'unconfigured'}/${key}`;
  }
  return `https://${domain}/${key}`;
}

// Expo's manifest hashes are base64url-encoded sha256 — NOT hex, NOT
// standard base64 (which has + / and padding the protocol rejects).
function _hashBufferB64Url(buffer) {
  return crypto
    .createHash('sha256')
    .update(buffer)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Heuristic: which file in the upload is the JS launchAsset? The Expo
// CLI emits the bundle as `_expo/static/js/<platform>/index-<hash>.hbc`
// (Hermes) or `.bundle` (JSC). Match on extension; everything else is
// treated as an asset row.
function _isLaunchAsset(file) {
  const name = (file.originalname || '').toLowerCase();
  return name.endsWith('.bundle') || name.endsWith('.hbc');
}

function _fileExtension(name) {
  const m = /\.[a-z0-9]+$/i.exec(name || '');
  return m ? m[0] : '';
}

// ─── 1. POST /api/ota/upload ────────────────────────────────────
router.post(
  '/upload',
  requireAdmin,
  upload.array('files'),
  async (req, res) => {
    try {
      const { runtimeVersion, platform } = req.body || {};
      if (!runtimeVersion || typeof runtimeVersion !== 'string') {
        return res.status(400).json({ error: 'runtimeVersion is required' });
      }
      if (!platform || !['android', 'ios'].includes(platform)) {
        return res.status(400).json({ error: "platform must be 'android' or 'ios'" });
      }
      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length === 0) {
        return res.status(400).json({ error: 'files[] is required (at least one)' });
      }

      const updateId = crypto.randomUUID();
      const prefix = `ota-updates/${runtimeVersion}/${updateId}`;

      // Upload all files to S3 in parallel. Each upload returns
      // { url, storage, key } from s3Storage.uploadBuffer; we keep
      // `key` for both the manifest URL and the file_keys audit array.
      const uploaded = await Promise.all(files.map(async (f) => {
        const result = await s3Storage.uploadBuffer({
          buffer: f.buffer,
          prefix,
          originalName: f.originalname,
          contentType: f.mimetype || 'application/octet-stream',
        });
        return {
          file: f,
          key: result.key,
          hash: _hashBufferB64Url(f.buffer),
        };
      }));

      // Build the manifest. Expo expects exactly one launchAsset; if
      // we can't identify one, pick the first .bundle/.hbc match or
      // the first file as a last-resort. Bail with 400 if no plausible
      // bundle is in the upload — the runtime would fail anyway.
      let launchEntry = uploaded.find(({ file }) => _isLaunchAsset(file));
      if (!launchEntry) {
        return res.status(400).json({
          error: 'No bundle file found in upload — expected a .bundle or .hbc file',
        });
      }
      const assetEntries = uploaded.filter((u) => u !== launchEntry);

      const createdAt = new Date().toISOString();
      const manifest = {
        id: updateId,
        createdAt,
        runtimeVersion,
        launchAsset: {
          hash: launchEntry.hash,
          key: launchEntry.key,
          contentType: 'application/javascript',
          fileExtension: '.bundle',
          url: _publicUrl(launchEntry.key),
        },
        assets: assetEntries.map((u) => ({
          hash: u.hash,
          key: u.key,
          contentType: u.file.mimetype || 'application/octet-stream',
          fileExtension: _fileExtension(u.file.originalname),
          url: _publicUrl(u.key),
        })),
        metadata: {},
        extra: {},
      };

      const doc = {
        _id: updateId,
        runtime_version: runtimeVersion,
        platform,
        created_at: new Date(),
        is_active: false,            // requires explicit activation
        manifest,
        file_keys: uploaded.map((u) => u.key),
      };
      await col('ota_updates').insertOne(doc);

      log.info(
        { updateId, runtimeVersion, platform, fileCount: files.length, launchKey: launchEntry.key },
        'ota update uploaded',
      );

      res.json({ ok: true, updateId, manifest });
    } catch (err) {
      log.error({ err: err && err.message }, 'ota upload failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── 2. POST /api/ota/activate/:updateId ────────────────────────
// Atomicity note: the two updateOne calls below aren't a real Mongo
// transaction, but the order (deactivate-all-siblings first, then
// activate-target) is failure-safe in either order: the manifest GET
// reads `is_active:true` sorted by created_at desc, so a brief moment
// with two actives still resolves to "the newer one wins". A
// transaction would be tidier; keeping it simple for now.
router.post('/activate/:updateId', requireAdmin, async (req, res) => {
  try {
    const target = await col('ota_updates').findOne({ _id: req.params.updateId });
    if (!target) return res.status(404).json({ error: 'Update not found' });

    await col('ota_updates').updateMany(
      { runtime_version: target.runtime_version, platform: target.platform },
      { $set: { is_active: false } },
    );
    await col('ota_updates').updateOne(
      { _id: target._id },
      { $set: { is_active: true, activated_at: new Date() } },
    );

    log.info(
      { updateId: target._id, runtimeVersion: target.runtime_version, platform: target.platform },
      'ota update activated',
    );

    res.json({ ok: true, activated: target._id });
  } catch (err) {
    log.error({ err: err && err.message }, 'ota activate failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── 3. GET /api/ota/manifest (PUBLIC) ──────────────────────────
// No auth — the staff app's expo-updates client can't attach
// Authorization headers per the upstream protocol. The response
// carries only public bundle URLs + hashes; integrity is enforced by
// the runtime's hash check against the served bytes.
router.get('/manifest', async (req, res) => {
  try {
    // Header reads are case-insensitive in Express's req.headers
    // already, but be explicit for readability.
    const runtimeVersion = req.headers['expo-runtime-version'] || req.get('expo-runtime-version');
    const platform = req.headers['expo-platform'] || req.get('expo-platform');
    if (!runtimeVersion || !platform) {
      return res.status(400).json({
        error: 'Missing expo-runtime-version or expo-platform header',
      });
    }

    const doc = await col('ota_updates')
      .find({
        runtime_version: String(runtimeVersion),
        platform: String(platform),
        is_active: true,
      })
      .sort({ created_at: -1 })
      .limit(1)
      .next();

    if (!doc) {
      // Expo protocol: 204 means "no update available, run the bundled
      // version". Body must be empty.
      return res.status(204).end();
    }

    res.set({
      'expo-protocol-version': '1',
      'expo-sfv-version': '0',
      'cache-control': 'private, max-age=0',
      'content-type': 'application/json; charset=utf-8',
    });
    res.send(JSON.stringify(doc.manifest));
  } catch (err) {
    log.error({ err: err && err.message }, 'ota manifest failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
