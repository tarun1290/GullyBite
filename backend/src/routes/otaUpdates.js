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
//   S3 via a dedicated OTA-scoped S3Client (see _getOtaS3 below) for
//   bundle + assets. OTA uses its own IAM identity so credentials can
//   be scoped narrowly to the `ota-updates/*` prefix; menu uploads
//   continue through services/s3Storage on the default chain.
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
const fs = require('fs');
const path = require('path');
const router = express.Router();

const { col } = require('../config/database');
const { getCached, invalidateCache } = require('../config/cache');
const { requireAdminAuth } = require('../middleware/adminAuth');
const log = require('../utils/logger').child({ component: 'otaUpdates' });

const requireAdmin = requireAdminAuth();

// Runtime-freeze flag. `platform_settings._id = 'ota_frozen_runtimes'` holds
// `{ runtimes: [...] }` — manifest requests for any runtime in that list
// short-circuit to noUpdateAvailable, regardless of which bundle is
// currently `is_active` for that runtime. Used to recover from a runtime
// namespace contaminated by a bundle that the in-circulation APK can't
// actually load (e.g., bundle compiled against a native module set the
// shipped APK doesn't carry). Cached 120s so the manifest hot path
// doesn't pay an extra round-trip per request; admin freeze/unfreeze
// endpoints invalidate the cache so toggles take effect within seconds.
const FREEZE_CACHE_KEY = 'ota:frozen_runtimes';
const FREEZE_CACHE_TTL_SECONDS = 120;

async function _getFrozenRuntimes() {
  return getCached(FREEZE_CACHE_KEY, async () => {
    const doc = await col('platform_settings').findOne({ _id: 'ota_frozen_runtimes' });
    return Array.isArray(doc?.runtimes) ? doc.runtimes.map(String) : [];
  }, FREEZE_CACHE_TTL_SECONDS);
}

// Memory storage — buffers go straight to _uploadOtaBuffer().
// 25 MB per file ceiling matches the practical Hermes bundle size for
// a JS-only OTA. Bundle itself is typically 1-3 MB; the cap exists
// just to cut off a malformed/binary upload before it eats RAM.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ─── DEDICATED OTA S3 CLIENT ────────────────────────────────────
// OTA uploads run under their own IAM identity, separate from the
// shared client in services/s3Storage. When OTA_AWS_ACCESS_KEY_ID is
// set we pass it explicitly; otherwise we leave `credentials` undefined
// and the SDK falls back to its default chain (EC2 instance role in
// prod, AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY env vars locally).
const LOCAL_OTA_DIR = path.join(process.cwd(), 'ota-uploads');

let _otaS3 = null;
function _getOtaS3() {
  if (_otaS3) return _otaS3;
  if (!process.env.S3_BUCKET) return null;
  try {
    const { S3Client } = require('@aws-sdk/client-s3');
    _otaS3 = new S3Client({
      region: process.env.AWS_REGION || 'ap-south-1',
      credentials: process.env.OTA_AWS_ACCESS_KEY_ID
        ? {
            accessKeyId: process.env.OTA_AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.OTA_AWS_SECRET_ACCESS_KEY,
          }
        : undefined,
    });
    return _otaS3;
  } catch (err) {
    log.warn({ err: err && err.message }, 'ota s3 client init failed — falling back to local');
    return null;
  }
}

function _safeName(name) {
  return (name || 'file').replace(/[^\w.\-]+/g, '_');
}

function _stamp(name) {
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${_safeName(name)}`;
}

// Mirrors s3Storage.uploadBuffer's return shape ({ url, storage, key })
// so the rest of the upload route is unchanged. Local-disk fallback
// keeps dev working when S3_BUCKET isn't configured.
async function _uploadOtaBuffer({ buffer, prefix, originalName, contentType }) {
  const key = `${prefix}/${_stamp(originalName)}`;
  const s3 = _getOtaS3();

  if (s3 && process.env.S3_BUCKET) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType || 'application/octet-stream',
    }));
    return {
      url: `s3://${process.env.S3_BUCKET}/${key}`,
      storage: 's3',
      key,
      bucket: process.env.S3_BUCKET,
    };
  }

  if (!fs.existsSync(LOCAL_OTA_DIR)) fs.mkdirSync(LOCAL_OTA_DIR, { recursive: true });
  const abs = path.join(LOCAL_OTA_DIR, _safeName(path.basename(key)));
  fs.writeFileSync(abs, buffer);
  return { url: `file://${abs}`, storage: 'local', key: abs };
}

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
      // { url, storage, key } from _uploadOtaBuffer; we keep `key` for
      // both the manifest URL and the file_keys audit array.
      const uploaded = await Promise.all(files.map(async (f) => {
        const result = await _uploadOtaBuffer({
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

    // Runtime-freeze short-circuit. Checked BEFORE the bundle lookup
    // so a frozen runtime can never serve a contaminated bundle (the
    // active doc may still exist in ota_updates; we deliberately leave
    // those rows alone so unfreezing is a single config flip).
    //
    // Response shape: explicit `{type:'noUpdateAvailable'}` with HTTP
    // 200 and the full success-path header set. Some expo-updates
    // client versions fall through to a cached bundle on malformed
    // noUpdate responses (e.g. 204 empty); matching the success-path
    // headers is non-negotiable for the freeze to actually stick.
    const frozen = await _getFrozenRuntimes();
    if (frozen.includes(String(runtimeVersion))) {
      log.info({ runtimeVersion, platform }, 'ota manifest: frozen runtime — returning noUpdateAvailable');
      res.set({
        'expo-protocol-version': '1',
        'expo-sfv-version': '0',
        'cache-control': 'private, max-age=0',
        'content-type': 'application/json; charset=utf-8',
      });
      return res.send(JSON.stringify({ type: 'noUpdateAvailable' }));
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

// ─── ADMIN: FREEZE / UNFREEZE A RUNTIME ─────────────────────────
// Mounted under `/api/admin/ota` (see ec2-server.js) with jsonAndSanitize
// at the mount, so req.body is parsed JSON by the time these run. Both
// endpoints are idempotent: re-freezing an already-frozen runtime or
// unfreezing one that wasn't frozen returns the current list without
// error. Cache is invalidated on every write so the manifest hot-path
// picks up the change within seconds (next request after invalidation
// re-fetches from platform_settings).
const adminRouter = express.Router();

function _normaliseRuntime(req, res) {
  const raw = req.body?.runtime;
  if (typeof raw !== 'string' || !raw.trim()) {
    res.status(400).json({ error: 'runtime is required (string)' });
    return null;
  }
  return raw.trim();
}

adminRouter.post('/freeze-runtime', requireAdmin, async (req, res) => {
  try {
    const runtime = _normaliseRuntime(req, res);
    if (runtime == null) return;

    const result = await col('platform_settings').findOneAndUpdate(
      { _id: 'ota_frozen_runtimes' },
      { $addToSet: { runtimes: runtime }, $set: { updated_at: new Date() } },
      { upsert: true, returnDocument: 'after' },
    );
    // mongodb driver v4 returns `{ value: doc }`; v5+ returns the doc.
    const doc = result?.value ?? result;
    const runtimes = Array.isArray(doc?.runtimes) ? doc.runtimes.map(String) : [runtime];

    await invalidateCache(FREEZE_CACHE_KEY);
    log.info({ runtime, runtimes }, 'ota runtime frozen');
    res.json({ ok: true, runtimes });
  } catch (err) {
    log.error({ err: err && err.message }, 'ota freeze-runtime failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

adminRouter.post('/unfreeze-runtime', requireAdmin, async (req, res) => {
  try {
    const runtime = _normaliseRuntime(req, res);
    if (runtime == null) return;

    const result = await col('platform_settings').findOneAndUpdate(
      { _id: 'ota_frozen_runtimes' },
      { $pull: { runtimes: runtime }, $set: { updated_at: new Date() } },
      { returnDocument: 'after' },
    );
    const doc = result?.value ?? result;
    const runtimes = Array.isArray(doc?.runtimes) ? doc.runtimes.map(String) : [];

    await invalidateCache(FREEZE_CACHE_KEY);
    log.info({ runtime, runtimes }, 'ota runtime unfrozen');
    res.json({ ok: true, runtimes });
  } catch (err) {
    log.error({ err: err && err.message }, 'ota unfreeze-runtime failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
module.exports.adminRouter = adminRouter;
