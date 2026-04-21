// src/routes/marketingWa.js
// Restaurant-scoped Marketing WhatsApp settings. POST saves the raw
// phone_number_id + waba_id, flips status to 'pending', and kicks off
// verification fire-and-forget so the owner gets near-real-time
// feedback via the front-end poll.

'use strict';

const express = require('express');
const { col } = require('../config/database');
const { requireAuth } = require('./auth');
const { verifyMarketingWaNumber } = require('../services/marketingWaVerification');
const log = require('../utils/logger').child({ component: 'marketing-wa-route' });

const router = express.Router();
router.use(requireAuth);

// GET /api/restaurant/settings/marketing-wa — current config for the
// authenticated restaurant. Error message is deliberately withheld.
router.get('/marketing-wa', async (req, res) => {
  try {
    const r = await col('restaurants').findOne(
      { _id: req.restaurantId },
      {
        projection: {
          marketing_wa_phone_number_id: 1,
          marketing_wa_waba_id: 1,
          marketing_wa_status: 1,
          marketing_wa_quality_rating: 1,
          marketing_wa_verified_at: 1,
          marketing_wa_last_checked_at: 1,
        },
      },
    );
    res.json({
      phone_number_id: r?.marketing_wa_phone_number_id || null,
      waba_id: r?.marketing_wa_waba_id || null,
      status: r?.marketing_wa_status || 'not_configured',
      quality_rating: r?.marketing_wa_quality_rating || null,
      verified_at: r?.marketing_wa_verified_at || null,
      last_checked_at: r?.marketing_wa_last_checked_at || null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load marketing WA settings' });
  }
});

// POST /api/restaurant/settings/marketing-wa — save raw ids and flip
// status to 'pending'. Verification runs in the background.
router.post('/marketing-wa', async (req, res) => {
  const { phone_number_id, waba_id } = req.body || {};
  if (typeof phone_number_id !== 'string' || !phone_number_id.trim()) {
    return res.status(400).json({ error: 'phone_number_id is required' });
  }
  if (typeof waba_id !== 'string' || !waba_id.trim()) {
    return res.status(400).json({ error: 'waba_id is required' });
  }

  try {
    await col('restaurants').updateOne(
      { _id: req.restaurantId },
      {
        $set: {
          marketing_wa_phone_number_id: phone_number_id.trim(),
          marketing_wa_waba_id: waba_id.trim(),
          marketing_wa_status: 'pending',
          marketing_wa_error_message: null,
          updated_at: new Date(),
        },
      },
    );

    // Fire-and-forget — the restaurant polls the GET endpoint for the
    // eventual status. verifyMarketingWaNumber never throws to caller.
    verifyMarketingWaNumber(req.restaurantId).catch((err) => {
      log.warn({ err: err?.message, restaurantId: req.restaurantId }, 'inline verification failed');
    });

    res.json({
      message: 'Marketing WhatsApp number saved. Verification in progress.',
      status: 'pending',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save marketing WA settings' });
  }
});

module.exports = router;
