// src/services/imageUpload.js
// Product image pipeline — S3 upload, sharp optimization, CloudFront CDN delivery.
// All images resized, compressed to JPEG, stripped of EXIF, served via CloudFront.
// Feature-flagged: auto-enables when AWS env vars are present.

'use strict';

const axios = require('axios');
const { IMAGE_PIPELINE_ENABLED } = require('../config/features');

const DISABLED_RESULT = { url: null, thumbnail_url: null, s3_key: null, thumbnail_s3_key: null, skipped: true, reason: 'Image pipeline not configured — set AWS env vars to enable' };

// ─── LAZY-LOAD HEAVY DEPS (only when pipeline enabled) ─────────
let s3, S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, sharp;

if (IMAGE_PIPELINE_ENABLED) {
  ({ S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3'));
  sharp = require('sharp');

  s3 = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

const BUCKET = process.env.AWS_S3_BUCKET || 'gullybite-images';
const CDN_DOMAIN = process.env.AWS_CLOUDFRONT_DOMAIN || '';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_FORMATS = ['jpeg', 'png', 'webp', 'gif', 'tiff'];

// ─── PLACEHOLDER MAPPING ────────────────────────────────────────
const PLACEHOLDERS = {
  'momos': 'placeholders/momos.jpg',
  'dumpling': 'placeholders/momos.jpg',
  'sushi': 'placeholders/sushi.jpg',
  'coffee': 'placeholders/coffee.jpg',
  'latte': 'placeholders/coffee.jpg',
  'espresso': 'placeholders/coffee.jpg',
  'cappuccino': 'placeholders/coffee.jpg',
  'matcha': 'placeholders/matcha.jpg',
  'dessert': 'placeholders/desserts.jpg',
  'cake': 'placeholders/desserts.jpg',
  'sweet': 'placeholders/desserts.jpg',
  'gulab': 'placeholders/desserts.jpg',
  'pastry': 'placeholders/pastry.jpg',
  'croissant': 'placeholders/pastry.jpg',
  'donut': 'placeholders/pastry.jpg',
  'mocktail': 'placeholders/mocktails.jpg',
  'milkshake': 'placeholders/milkshakes.jpg',
  'shake': 'placeholders/milkshakes.jpg',
  'smoothie': 'placeholders/milkshakes.jpg',
  'biryani': 'placeholders/biryani.jpg',
  'pulao': 'placeholders/biryani.jpg',
  'curry': 'placeholders/curry.jpg',
  'dal': 'placeholders/curry.jpg',
  'paneer': 'placeholders/curry.jpg',
  'pizza': 'placeholders/pizza.jpg',
  'burger': 'placeholders/burger.jpg',
  'sandwich': 'placeholders/sandwich.jpg',
  'wrap': 'placeholders/sandwich.jpg',
  'roll': 'placeholders/sandwich.jpg',
  'salad': 'placeholders/salad.jpg',
  'noodle': 'placeholders/noodles.jpg',
  'pasta': 'placeholders/noodles.jpg',
  'chowmein': 'placeholders/noodles.jpg',
  'thali': 'placeholders/thali.jpg',
  'rice': 'placeholders/biryani.jpg',
  'soup': 'placeholders/soup.jpg',
  'tea': 'placeholders/tea.jpg',
  'chai': 'placeholders/tea.jpg',
};

// ─── OPTIMIZE IMAGE ─────────────────────────────────────────────
async function optimizeImage(inputBuffer, opts = {}) {
  const maxDim = opts.maxDimension || 1200;
  const quality = opts.quality || 85;

  const image = sharp(inputBuffer);
  const metadata = await image.metadata();

  if (!ALLOWED_FORMATS.includes(metadata.format)) {
    throw new Error(`Unsupported image format: ${metadata.format}. Use JPEG, PNG, or WebP.`);
  }

  const optimized = await image
    .resize(maxDim, maxDim, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .rotate() // auto-rotate based on EXIF orientation
    .jpeg({
      quality,
      progressive: true,
      mozjpeg: true,
    })
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: optimized.data,
    width: optimized.info.width,
    height: optimized.info.height,
    sizeBytes: optimized.info.size,
  };
}

// ─── GENERATE THUMBNAIL ─────────────────────────────────────────
async function generateThumbnail(inputBuffer) {
  const result = await sharp(inputBuffer)
    .resize(200, 200, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 70, progressive: true })
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: result.data,
    width: result.info.width,
    height: result.info.height,
    sizeBytes: result.info.size,
  };
}

// ─── UPLOAD TO S3 ───────────────────────────────────────────────
async function putS3(s3Key, buffer, contentType = 'image/jpeg') {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: s3Key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: 'max-age=2592000', // 30 days
  }));
  return cdnUrl(s3Key);
}

function cdnUrl(s3Key) {
  if (!CDN_DOMAIN) return `https://${BUCKET}.s3.${process.env.AWS_REGION || 'ap-south-1'}.amazonaws.com/${s3Key}`;
  return `https://${CDN_DOMAIN}/${s3Key}`;
}

// ─── UPLOAD IMAGE (CORE) ────────────────────────────────────────
// Takes a raw buffer, optimizes, uploads main image + thumbnail to S3.
// opts: { restaurantId, branchId, itemId, prefix }
async function uploadImage(buffer, opts = {}) {
  if (!IMAGE_PIPELINE_ENABLED) return DISABLED_RESULT;
  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error(`Image too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Maximum is 10 MB.`);
  }

  const optimized = await optimizeImage(buffer, opts);
  const thumb = await generateThumbnail(buffer);

  const ts = Date.now();
  const prefix = opts.prefix || `${opts.restaurantId || 'unknown'}/${opts.branchId || 'general'}`;
  const name = opts.itemId || `img-${ts}`;

  const mainKey = `${prefix}/${name}-${ts}.jpg`;
  const thumbKey = `${prefix}/thumb-${name}-${ts}.jpg`;

  const [url, thumbnailUrl] = await Promise.all([
    putS3(mainKey, optimized.buffer),
    putS3(thumbKey, thumb.buffer),
  ]);

  console.log(`[Image] Uploaded ${mainKey} (${optimized.width}x${optimized.height}, ${(optimized.sizeBytes / 1024).toFixed(0)} KB)`);

  return {
    url,
    thumbnail_url: thumbnailUrl,
    s3_key: mainKey,
    thumbnail_s3_key: thumbKey,
    width: optimized.width,
    height: optimized.height,
    size_bytes: optimized.sizeBytes,
  };
}

// ─── UPLOAD FROM URL ────────────────────────────────────────────
// Downloads an image from an external URL and re-uploads to S3.
async function uploadImageFromUrl(sourceUrl, opts = {}) {
  if (!IMAGE_PIPELINE_ENABLED) return DISABLED_RESULT;
  if (!sourceUrl) throw new Error('No source URL provided');

  let buffer;
  try {
    const response = await axios.get(sourceUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      maxContentLength: MAX_FILE_SIZE,
      headers: { 'User-Agent': 'GullyBite-ImagePipeline/1.0' },
    });
    buffer = Buffer.from(response.data);
  } catch (err) {
    throw new Error(`Failed to download image from URL: ${err.message}`);
  }

  return uploadImage(buffer, opts);
}

// ─── DELETE IMAGE ───────────────────────────────────────────────
async function deleteImage(s3Key) {
  if (!IMAGE_PIPELINE_ENABLED || !s3Key) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: s3Key }));
    console.log(`[Image] Deleted ${s3Key}`);
  } catch (err) {
    console.error(`[Image] Delete failed for ${s3Key}:`, err.message);
  }
}

// ─── DELETE MULTIPLE ────────────────────────────────────────────
async function deleteImages(s3Keys) {
  await Promise.allSettled(s3Keys.filter(Boolean).map(k => deleteImage(k)));
}

// ─── UPLOAD LOGO / BRAND IMAGE ──────────────────────────────────
// Square crop, 640×640 for logos
async function uploadLogo(buffer, restaurantId) {
  if (!IMAGE_PIPELINE_ENABLED) return DISABLED_RESULT;
  if (buffer.length > MAX_FILE_SIZE) throw new Error('Image too large. Maximum is 10 MB.');

  const optimized = await sharp(buffer)
    .resize(640, 640, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 90, progressive: true })
    .toBuffer({ resolveWithObject: true });

  const ts = Date.now();
  const s3Key = `${restaurantId}/logo-${ts}.jpg`;
  const url = await putS3(s3Key, optimized.data);

  console.log(`[Image] Logo uploaded ${s3Key}`);
  return { url, s3_key: s3Key, width: optimized.info.width, height: optimized.info.height };
}

// ─── UPLOAD BRANCH PHOTO ────────────────────────────────────────
async function uploadBranchPhoto(buffer, restaurantId, branchId) {
  if (!IMAGE_PIPELINE_ENABLED) return DISABLED_RESULT;
  if (buffer.length > MAX_FILE_SIZE) throw new Error('Image too large. Maximum is 10 MB.');

  const optimized = await optimizeImage(buffer, { maxDimension: 1600, quality: 88 });
  const ts = Date.now();
  const s3Key = `${restaurantId}/${branchId}/branch-photo-${ts}.jpg`;
  const url = await putS3(s3Key, optimized.buffer);

  console.log(`[Image] Branch photo uploaded ${s3Key}`);
  return { url, s3_key: s3Key, width: optimized.width, height: optimized.height };
}

// ─── PLACEHOLDER URL ────────────────────────────────────────────
// Returns a category-appropriate placeholder image URL for items without photos.
function getPlaceholderUrl(item) {
  if (!CDN_DOMAIN) return '';

  const tags = (item.product_tags || []).map(t => (t || '').toLowerCase());
  const name = (item.name || '').toLowerCase();
  const category = (tags[1] || '').toLowerCase();

  for (const [keyword, path] of Object.entries(PLACEHOLDERS)) {
    if (name.includes(keyword) || category.includes(keyword)) {
      return cdnUrl(path);
    }
  }

  // Fallback by rough classification
  if (tags.includes('beverage') || /coffee|tea|juice|shake|smoothie|latte|drink|lassi|soda|mojito/.test(name)) {
    return cdnUrl('placeholders/default-beverage.jpg');
  }

  return cdnUrl('placeholders/default-food.jpg');
}

// ─── VALIDATE IMAGE FOR META ────────────────────────────────────
// Checks if an image URL meets Meta's catalog requirements.
async function validateImageForMeta(imageUrl) {
  const result = { valid: true, warnings: [], errors: [] };

  if (!imageUrl) {
    result.valid = false;
    result.errors.push('No image URL');
    return result;
  }

  if (!imageUrl.startsWith('https://')) {
    result.valid = false;
    result.errors.push('Image URL must be HTTPS');
    return result;
  }

  try {
    const head = await axios.head(imageUrl, { timeout: 10000 });
    const contentType = head.headers['content-type'] || '';
    if (!contentType.startsWith('image/')) {
      result.valid = false;
      result.errors.push(`Invalid content type: ${contentType}`);
    }
    const size = parseInt(head.headers['content-length'] || '0');
    if (size > 8 * 1024 * 1024) {
      result.warnings.push('Image larger than 8 MB — Meta may reject');
    }
  } catch (err) {
    result.valid = false;
    result.errors.push(`Image URL not accessible: ${err.message}`);
  }

  return result;
}

// ─── LIST S3 KEYS FOR RESTAURANT ────────────────────────────────
// Used by orphan detection
async function listS3Keys(prefix) {
  if (!IMAGE_PIPELINE_ENABLED) return [];
  const keys = [];
  let continuationToken;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    for (const obj of (res.Contents || [])) {
      keys.push({ key: obj.Key, size: obj.Size, lastModified: obj.LastModified });
    }
    continuationToken = res.NextContinuationToken;
  } while (continuationToken);
  return keys;
}

// ─── BACKGROUND IMAGE RE-HOSTING ────────────────────────────────
// Re-hosts POS images to S3 in batches of 5. Non-blocking, fire-and-forget.
async function rehostPosImages(items, branchId, restaurantId) {
  if (!IMAGE_PIPELINE_ENABLED) {
    console.log('[Image] POS image re-hosting skipped — image pipeline disabled. Using POS URLs as-is.');
    return;
  }
  const toRehost = items.filter(i =>
    i.image_url &&
    !i.image_url.startsWith(`https://${CDN_DOMAIN}`) &&
    !i.image_url.startsWith(cdnUrl(''))
  );
  if (!toRehost.length) return;

  console.log(`[Image] Re-hosting ${toRehost.length} POS images for branch ${branchId}`);
  const { col } = require('../config/database');
  const BATCH = 5;

  for (let i = 0; i < toRehost.length; i += BATCH) {
    const batch = toRehost.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (item) => {
        try {
          const result = await uploadImageFromUrl(item.image_url, {
            restaurantId,
            branchId,
            itemId: String(item._id),
          });
          await col('menu_items').updateOne(
            { _id: item._id },
            { $set: {
              image_url: result.url,
              thumbnail_url: result.thumbnail_url,
              image_s3_key: result.s3_key,
              thumbnail_s3_key: result.thumbnail_s3_key,
              image_source: 'pos_rehosted',
              catalog_sync_status: 'pending',
              updated_at: new Date(),
            }}
          );
        } catch (err) {
          console.warn(`[Image] Re-host failed for item ${item._id}: ${err.message}`);
          await col('menu_items').updateOne(
            { _id: item._id },
            { $set: { image_rehost_failed: true } }
          );
        }
      })
    );
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    if (succeeded > 0) console.log(`[Image] Re-hosted batch ${Math.floor(i / BATCH) + 1}: ${succeeded}/${batch.length}`);
  }

  console.log(`[Image] POS image re-hosting complete for branch ${branchId}`);
}

module.exports = {
  IMAGE_PIPELINE_ENABLED,
  uploadImage,
  uploadImageFromUrl,
  deleteImage,
  deleteImages,
  uploadLogo,
  uploadBranchPhoto,
  getPlaceholderUrl,
  validateImageForMeta,
  listS3Keys,
  rehostPosImages,
  optimizeImage,
  generateThumbnail,
  cdnUrl,
};
