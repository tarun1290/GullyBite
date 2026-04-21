// src/routes/festivals.js
// Mounts two routers:
//   - restaurantRouter → /api/restaurant/festivals + /api/restaurant/campaigns
//     (upcoming festivals list + smart send time endpoint)
//   - adminRouter      → /api/admin/festivals (CRUD + toggle + seed)

'use strict';

const express = require('express');
const { col, newId } = require('../config/database');
const log = require('../utils/logger').child({ component: 'festivals' });
const { requireAuth } = require('./auth');
const { requireAdminAuth } = require('../middleware/adminAuth');
const smartSendTime = require('../services/smartSendTime');
const seedFestivalCalendar = require('../jobs/seedFestivalCalendar');

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function projectFestival(doc, extra = {}) {
  if (!doc) return null;
  return {
    id: doc._id,
    name: doc.name,
    slug: doc.slug,
    date: doc.date,
    notification_date: doc.notification_date,
    default_template_use_case: doc.default_template_use_case || 'festival',
    suggested_message_hint: doc.suggested_message_hint || null,
    applicable_to: doc.applicable_to || 'all',
    is_active: doc.is_active !== false,
    year: doc.year,
    created_at: doc.created_at,
    updated_at: doc.updated_at || null,
    ...extra,
  };
}

// ═══════════════════════════════════════════════════════════════
// RESTAURANT ROUTER
// ═══════════════════════════════════════════════════════════════

const restaurantRouter = express.Router();
restaurantRouter.use(requireAuth);

// GET /api/restaurant/festivals/upcoming
// Returns festivals in the next 60 days. For each, flag whether this
// restaurant has already sent a marketing campaign aimed at it — we
// approximate by looking for a campaign created within ±7 days of the
// festival date whose display_name or use_case references the festival.
restaurantRouter.get('/upcoming', async (req, res) => {
  try {
    const restaurantId = req.restaurantId;
    const now = new Date();
    const until = new Date(now.getTime() + SIXTY_DAYS_MS);

    const festivals = await col('festivals_calendar').find({
      is_active: true,
      date: { $gte: now, $lte: until },
    }).sort({ date: 1 }).toArray();

    if (!festivals.length) return res.json({ festivals: [] });

    // Recent marketing campaigns (broad window — we filter per festival
    // below with a ±7-day window around each festival date).
    const campaignLookback = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const recentCampaigns = await col('marketing_campaigns').find(
      {
        restaurant_id: restaurantId,
        created_at: { $gte: campaignLookback },
      },
      { projection: { display_name: 1, use_case: 1, created_at: 1 } },
    ).toArray();

    const out = festivals.map((f) => {
      const daysUntil = Math.max(0, Math.ceil((f.date.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
      const festivalDateMs = f.date.getTime();
      const windowStart = festivalDateMs - SEVEN_DAYS_MS;
      const windowEnd = festivalDateMs + SEVEN_DAYS_MS;
      const nameLower = String(f.name || '').toLowerCase();
      const alreadySent = recentCampaigns.some((c) => {
        const created = c.created_at?.getTime ? c.created_at.getTime() : 0;
        if (!created || created < windowStart || created > windowEnd) return false;
        const hay = String(c.display_name || '').toLowerCase();
        return hay.includes(nameLower) || hay.includes(f.slug);
      });
      return projectFestival(f, { days_until: daysUntil, already_sent: alreadySent });
    });

    res.json({ festivals: out });
  } catch (err) {
    log.error({ err, restaurantId: req.restaurantId }, 'upcoming festivals failed');
    res.status(500).json({ error: 'Failed to load upcoming festivals' });
  }
});

// Separate "campaigns" sub-router — the same logical file but a second
// mount point so /api/restaurant/campaigns/smart-send-time doesn't
// collide with the legacy catalog-based /campaigns namespace.
const restaurantCampaignsRouter = express.Router();
restaurantCampaignsRouter.use(requireAuth);

// GET /api/restaurant/campaigns/smart-send-time
// Returns the computed peak-hour recommendation, or null if the tenant
// has fewer than MIN_ORDERS paid orders in the rolling 90-day window.
restaurantCampaignsRouter.get('/smart-send-time', async (req, res) => {
  try {
    const restaurantId = req.restaurantId;
    const result = await smartSendTime.getSmartSendTime(restaurantId);
    res.json(result || null);
  } catch (err) {
    log.error({ err, restaurantId: req.restaurantId }, 'smart send time failed');
    res.status(500).json({ error: 'Failed to compute smart send time' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN ROUTER
// ═══════════════════════════════════════════════════════════════

const adminRouter = express.Router();

adminRouter.get('/', requireAdminAuth(), async (req, res) => {
  try {
    const filter = {};
    if (req.query.year) {
      const y = Number(req.query.year);
      if (!Number.isFinite(y)) return res.status(400).json({ error: 'year must be a number' });
      filter.year = y;
    }
    const rows = await col('festivals_calendar').find(filter).sort({ date: 1 }).toArray();
    res.json({ festivals: rows.map((r) => projectFestival(r)) });
  } catch (err) {
    log.error({ err }, 'admin list festivals failed');
    res.status(500).json({ error: 'Failed to list festivals' });
  }
});

adminRouter.post('/', requireAdminAuth(), async (req, res) => {
  try {
    const {
      name, slug, date, notification_date,
      default_template_use_case, suggested_message_hint,
      applicable_to, is_active, year,
    } = req.body || {};

    if (!name || !slug || !date) {
      return res.status(400).json({ error: 'name, slug, date are required' });
    }

    const festivalDate = new Date(date);
    if (isNaN(festivalDate.getTime())) return res.status(400).json({ error: 'date is not a valid date' });

    const notifDate = notification_date
      ? new Date(notification_date)
      : new Date(festivalDate.getTime() - 48 * 60 * 60 * 1000);
    if (isNaN(notifDate.getTime())) return res.status(400).json({ error: 'notification_date is not a valid date' });

    const doc = {
      _id: newId(),
      name: String(name).trim(),
      slug: String(slug).trim(),
      date: festivalDate,
      notification_date: notifDate,
      default_template_use_case: default_template_use_case || 'festival',
      suggested_message_hint: suggested_message_hint || null,
      applicable_to: applicable_to || 'all',
      is_active: is_active !== false,
      year: Number.isFinite(Number(year)) ? Number(year) : festivalDate.getUTCFullYear(),
      created_at: new Date(),
      updated_at: null,
    };

    try {
      await col('festivals_calendar').insertOne(doc);
    } catch (err) {
      if (err && err.code === 11000) {
        return res.status(409).json({ error: 'A festival with this slug already exists' });
      }
      throw err;
    }

    res.status(201).json(projectFestival(doc));
  } catch (err) {
    log.error({ err }, 'admin create festival failed');
    res.status(500).json({ error: 'Failed to create festival' });
  }
});

adminRouter.put('/:slug', requireAdminAuth(), async (req, res) => {
  try {
    const slug = String(req.params.slug);
    const body = req.body || {};
    const updates = { updated_at: new Date() };

    if (body.name !== undefined) updates.name = String(body.name).trim();
    if (body.date !== undefined) {
      const d = new Date(body.date);
      if (isNaN(d.getTime())) return res.status(400).json({ error: 'date is not a valid date' });
      updates.date = d;
      if (body.notification_date === undefined) {
        updates.notification_date = new Date(d.getTime() - 48 * 60 * 60 * 1000);
      }
    }
    if (body.notification_date !== undefined) {
      const nd = new Date(body.notification_date);
      if (isNaN(nd.getTime())) return res.status(400).json({ error: 'notification_date is not a valid date' });
      updates.notification_date = nd;
    }
    if (body.default_template_use_case !== undefined) updates.default_template_use_case = body.default_template_use_case;
    if (body.suggested_message_hint !== undefined) updates.suggested_message_hint = body.suggested_message_hint;
    if (body.applicable_to !== undefined) updates.applicable_to = body.applicable_to;
    if (body.is_active !== undefined) updates.is_active = !!body.is_active;
    if (body.year !== undefined && Number.isFinite(Number(body.year))) updates.year = Number(body.year);

    const result = await col('festivals_calendar').findOneAndUpdate(
      { slug },
      { $set: updates },
      { returnDocument: 'after' },
    );
    const updated = result?.value || result;
    if (!updated) return res.status(404).json({ error: 'Festival not found' });

    res.json(projectFestival(updated));
  } catch (err) {
    log.error({ err }, 'admin update festival failed');
    res.status(500).json({ error: 'Failed to update festival' });
  }
});

adminRouter.patch('/:slug/toggle', requireAdminAuth(), async (req, res) => {
  try {
    const slug = String(req.params.slug);
    const current = await col('festivals_calendar').findOne({ slug });
    if (!current) return res.status(404).json({ error: 'Festival not found' });

    const nextActive = !current.is_active;
    const result = await col('festivals_calendar').findOneAndUpdate(
      { slug },
      { $set: { is_active: nextActive, updated_at: new Date() } },
      { returnDocument: 'after' },
    );
    const updated = result?.value || result || { ...current, is_active: nextActive };
    res.json(projectFestival(updated));
  } catch (err) {
    log.error({ err }, 'admin toggle festival failed');
    res.status(500).json({ error: 'Failed to toggle festival' });
  }
});

adminRouter.post('/seed', requireAdminAuth(), async (req, res) => {
  try {
    const years = Array.isArray(req.body?.years) ? req.body.years.map(Number).filter(Number.isFinite) : undefined;
    const result = await seedFestivalCalendar.run({ years });
    res.json(result);
  } catch (err) {
    log.error({ err }, 'admin festival seed failed');
    res.status(500).json({ error: 'Failed to seed festival calendar' });
  }
});

module.exports = { restaurantRouter, restaurantCampaignsRouter, adminRouter };
