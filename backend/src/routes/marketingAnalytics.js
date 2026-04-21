// src/routes/marketingAnalytics.js
// Marketing-analytics endpoints (Prompt 10). Distinct from the legacy
// operational `analytics.js` admin router used by AdminAnalytics.jsx.
//
// Two routers:
//   - restaurantRouter → /api/restaurant/marketing-analytics/*
//     (full dashboard + per-section GETs, all tenant-scoped)
//   - adminRouter      → /api/admin/platform-marketing/*
//     (platform-wide roll-up used by AdminPlatformAnalytics)

'use strict';

const express = require('express');
const log = require('../utils/logger').child({ component: 'marketingAnalytics' });
const { requireAuth } = require('./auth');
const { requireAdminAuth } = require('../middleware/adminAuth');
const analytics = require('../services/analyticsService');

function readPeriod(req) {
  const p = (req.query && req.query.period) ? String(req.query.period) : '30d';
  return ['7d', '30d', '90d', 'all'].includes(p) ? p : '30d';
}

// ═══════════════════════════════════════════════════════════════
// RESTAURANT ROUTER — /api/restaurant/marketing-analytics
// ═══════════════════════════════════════════════════════════════

const restaurantRouter = express.Router();
restaurantRouter.use(requireAuth);

restaurantRouter.get('/dashboard', async (req, res) => {
  try {
    const out = await analytics.getFullDashboard(req.restaurantId, readPeriod(req));
    res.json({ ok: true, data: out });
  } catch (err) {
    log.error({ err, restaurantId: req.restaurantId }, 'dashboard failed');
    res.status(500).json({ ok: false, error: 'analytics_failed' });
  }
});

restaurantRouter.get('/campaigns', async (req, res) => {
  try {
    const out = await analytics.getCampaignSummary(req.restaurantId, readPeriod(req));
    res.json({ ok: true, data: out });
  } catch (err) {
    log.error({ err, restaurantId: req.restaurantId }, 'campaigns failed');
    res.status(500).json({ ok: false, error: 'analytics_failed' });
  }
});

restaurantRouter.get('/customers', async (req, res) => {
  try {
    const out = await analytics.getCustomerGrowth(req.restaurantId, readPeriod(req));
    res.json({ ok: true, data: out });
  } catch (err) {
    log.error({ err, restaurantId: req.restaurantId }, 'customers failed');
    res.status(500).json({ ok: false, error: 'analytics_failed' });
  }
});

restaurantRouter.get('/revenue', async (req, res) => {
  try {
    const out = await analytics.getRevenueInsights(req.restaurantId, readPeriod(req));
    res.json({ ok: true, data: out });
  } catch (err) {
    log.error({ err, restaurantId: req.restaurantId }, 'revenue failed');
    res.status(500).json({ ok: false, error: 'analytics_failed' });
  }
});

restaurantRouter.get('/feedback', async (req, res) => {
  try {
    const out = await analytics.getFeedbackInsights(req.restaurantId, readPeriod(req));
    res.json({ ok: true, data: out });
  } catch (err) {
    log.error({ err, restaurantId: req.restaurantId }, 'feedback failed');
    res.status(500).json({ ok: false, error: 'analytics_failed' });
  }
});

restaurantRouter.get('/loyalty', async (req, res) => {
  try {
    const out = await analytics.getLoyaltySummary(req.restaurantId, readPeriod(req));
    res.json({ ok: true, data: out });
  } catch (err) {
    log.error({ err, restaurantId: req.restaurantId }, 'loyalty failed');
    res.status(500).json({ ok: false, error: 'analytics_failed' });
  }
});

restaurantRouter.get('/journeys', async (req, res) => {
  try {
    const out = await analytics.getJourneySummary(req.restaurantId, readPeriod(req));
    res.json({ ok: true, data: out });
  } catch (err) {
    log.error({ err, restaurantId: req.restaurantId }, 'journeys failed');
    res.status(500).json({ ok: false, error: 'analytics_failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN ROUTER — /api/admin/platform-marketing
// ═══════════════════════════════════════════════════════════════

const adminRouter = express.Router();
adminRouter.use(requireAdminAuth());

adminRouter.get('/snapshot', async (req, res) => {
  try {
    const out = await analytics.getPlatformSnapshot(readPeriod(req));
    res.json({ ok: true, data: out });
  } catch (err) {
    log.error({ err }, 'platform snapshot failed');
    res.status(500).json({ ok: false, error: 'analytics_failed' });
  }
});

module.exports = { restaurantRouter, adminRouter };
