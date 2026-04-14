// src/services/s3Storage.js
// Phase 4: thin S3 uploader used by menu_uploads (and any future
// large-blob writer). Keeps the big bytes out of Mongo so the
// collection stays query-fast and backups stay small.
//
// Config (env):
//   S3_BUCKET, AWS_REGION           — required for S3 mode
//   AWS_ACCESS_KEY_ID + SECRET_ACCESS_KEY — optional if running on an
//       IAM-backed host (the SDK will use the default credential chain).
//
// If S3_BUCKET is unset we fall back to local disk at
// `menu-uploads/<prefix>/...` — same behavior as the pre-Phase-4 code,
// so local development keeps working without AWS.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('../utils/logger').child({ component: 's3Storage' });

const LOCAL_DIR = path.join(process.cwd(), 'menu-uploads');

let _s3 = null;
function _getS3() {
  if (_s3) return _s3;
  if (!process.env.S3_BUCKET) return null;
  try {
    // Lazy require so bootstrap stays fast when S3 isn't configured.
    const { S3Client } = require('@aws-sdk/client-s3');
    _s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
    return _s3;
  } catch (err) {
    log.warn({ err }, 's3 client init failed — falling back to local');
    return null;
  }
}

function _safeName(name) {
  return (name || 'file').replace(/[^\w.\-]+/g, '_');
}

function _stamp(name) {
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${_safeName(name)}`;
}

// Upload to S3 (or local fallback). Returns { url, storage, key }.
//   url      — s3://bucket/key OR file://abs/path
//   storage  — 's3' | 'local'
//   key      — bucket-relative key (s3) or abs path (local)
async function uploadBuffer({ buffer, prefix = 'menu-uploads', originalName, contentType = 'application/octet-stream' }) {
  const key = `${prefix}/${_stamp(originalName)}`;
  const s3 = _getS3();

  if (s3 && process.env.S3_BUCKET) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }));
    return {
      url: `s3://${process.env.S3_BUCKET}/${key}`,
      storage: 's3',
      key,
      bucket: process.env.S3_BUCKET,
    };
  }

  // Local fallback.
  if (!fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR, { recursive: true });
  const abs = path.join(LOCAL_DIR, _safeName(path.basename(key)));
  fs.writeFileSync(abs, buffer);
  return { url: `file://${abs}`, storage: 'local', key: abs };
}

module.exports = { uploadBuffer };
