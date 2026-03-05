// src/routes/admin.js
// Admin-only endpoints for testing and management
// In production: add proper admin authentication!

const express = require('express');
const router = express.Router();
const { runSettlement } = require('../jobs/settlement');

// POST /api/admin/run-settlement
// Manually trigger the settlement job (for testing)
router.post('/run-settlement', async (req, res) => {
  // Basic key check — replace with proper admin auth in production
  const key = req.headers['x-admin-key'];
  if (key !== process.env.ADMIN_KEY && process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  res.json({ message: 'Settlement started' });
  runSettlement().catch(console.error);
});

module.exports = router;