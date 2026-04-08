// src/routes/upload.js
// Presigned URL generation for direct browser-to-S3 image uploads.
// Protected by JWT — same auth pattern as restaurant routes.

const express = require('express');
const router = express.Router();
const { requireAuth } = require('./auth');
const { generatePresignedUploadUrl, IMAGE_PIPELINE_ENABLED } = require('../services/imageUpload');
const log = require('../utils/logger').child({ component: 'upload' });

router.use(requireAuth);

// POST /api/upload/presign — generate a presigned S3 PUT URL
router.post('/presign', async (req, res) => {
  try {
    if (!IMAGE_PIPELINE_ENABLED) {
      return res.status(503).json({ error: 'Image uploads are not configured. Set AWS environment variables to enable.' });
    }

    const { filename, contentType, restaurantId, folder } = req.body;

    if (!filename || !contentType) {
      return res.status(400).json({ error: 'filename and contentType are required' });
    }
    if (!contentType.startsWith('image/')) {
      return res.status(400).json({ error: 'contentType must be an image type (e.g. image/jpeg, image/png)' });
    }

    // Use the authenticated restaurant's ID, or the provided one if admin
    const restId = restaurantId || req.restaurantId;

    const result = await generatePresignedUploadUrl(restId, filename, contentType, folder);

    res.json({
      presignedUrl: result.presignedUrl,
      cloudFrontUrl: result.cloudFrontUrl,
      thumbnailUrl: result.thumbnailUrl,
      mediumUrl: result.mediumUrl,
      s3Key: result.s3Key,
    });
  } catch (e) {
    req.log.error({ err: e }, 'Presign error');
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
