'use strict';

// Public review-link redirect.
//
// Mounted BEFORE auth so a customer tapping the Google/Zomato link in
// WhatsApp isn't bounced to a login. For each hit we stamp
// `review_link_clicked=true` on the feedback_events row so the
// dashboard's review-funnel metrics include click-through without
// relying on the customer's browser UA.
//
//   GET /api/review-redirect/:id            → Google review link
//   GET /api/review-redirect/:id/zomato     → Zomato review link
//
// Unknown ids or missing review URLs 302 to '/' so we never leak
// whether a feedback_event exists.

const express = require('express');
const { col } = require('../config/database');
const log = require('../utils/logger').child({ component: 'review-redirect' });

const router = express.Router();

function fallbackUrl() {
  const base = (process.env.BASE_URL || '').replace(/\/+$/, '');
  return base || '/';
}

async function resolve(req, res, field) {
  const id = req.params.id;
  if (!id) return res.redirect(302, fallbackUrl());
  try {
    const row = await col('feedback_events').findOne({ _id: id });
    if (!row) return res.redirect(302, fallbackUrl());

    const restaurant = await col('restaurants').findOne({ _id: row.restaurant_id });
    const target = restaurant?.[field];
    if (!target) return res.redirect(302, fallbackUrl());

    // Fire-and-forget — redirect should not wait for the write.
    col('feedback_events').updateOne(
      { _id: id },
      { $set: { review_link_clicked: true, updated_at: new Date() } }
    ).catch((err) => log.warn({ err, id }, 'review click stamp failed'));

    return res.redirect(302, target);
  } catch (err) {
    log.error({ err, id }, 'review redirect failed');
    return res.redirect(302, fallbackUrl());
  }
}

router.get('/:id', (req, res) => resolve(req, res, 'google_review_link'));
router.get('/:id/zomato', (req, res) => resolve(req, res, 'zomato_review_link'));

module.exports = router;
