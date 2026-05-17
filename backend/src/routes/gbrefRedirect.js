'use strict';

// Public GBREF redirect — short-link for outbound captain re-engagement
// (and future channels). Look up the code in referral_links, find the
// linked restaurant's active WhatsApp number, and 302 to a wa.me URL
// that pre-fills GBREF-<code> as the customer's first message. Mounted
// ahead of /api/* auth so deep-link taps from the captain's marketing
// template work without an auth wall.
//
//   GET /r/:code  → 302 https://wa.me/<phone>?text=Hi!%20GBREF-<code>
//
// Unknown / inactive codes 302 to the configured BASE_URL (or '/') so
// we never leak whether a code exists.

const express = require('express');
const { col } = require('../config/database');
const { rateLimitFn } = require('../middleware/rateLimit');
const log = require('../utils/logger').child({ component: 'gbrefRedirect' });

const router = express.Router();

// Public, unauthenticated, one Mongo $inc per hit — IP-throttle to blunt
// click-count inflation / DB-write abuse. 30 req / 60s per IP, Redis-backed.
const gbrefLimiter = rateLimitFn((req) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  return `gbref:${ip}`;
}, 30, 60, { message: 'Too many requests, slow down' });

function fallbackUrl() {
  const base = (process.env.BASE_URL || '').replace(/\/+$/, '');
  return base || '/';
}

router.get('/:code', gbrefLimiter, async (req, res) => {
  const code = String(req.params.code || '').trim();
  if (!code) return res.redirect(302, fallbackUrl());
  try {
    const link = await col('referral_links').findOne({ code, status: 'active' });
    if (!link) return res.redirect(302, fallbackUrl());
    let phone = String(link.restaurant_phone || '').replace(/[^0-9]/g, '');
    if (!phone) {
      // Fall back to the active WABA number on the restaurant if the
      // referral_links row was inserted without restaurant_phone.
      const waAcc = await col('whatsapp_accounts').findOne(
        { restaurant_id: link.restaurant_id, is_active: true },
        { projection: { wa_phone_number: 1 } },
      );
      phone = String(waAcc?.wa_phone_number || '').replace(/[^0-9]/g, '');
    }
    if (!phone) return res.redirect(302, fallbackUrl());
    // Click count bump — fire-and-forget; never block the redirect.
    col('referral_links').updateOne({ _id: link._id }, { $inc: { click_count: 1 } }).catch(() => {});
    // Stamp tapped_at / clicked on the originating marketing_messages
    // row so persona / engagement_score can detect real taps (vs the
    // legacy status==='read' proxy). Fire-and-forget; never block the
    // redirect. Wrapped in try/catch so even a sync throw from the
    // proxy/wrapper can't bubble out and break the response.
    if (link.marketing_message_id) {
      try {
        col('marketing_messages').updateOne(
          { _id: link.marketing_message_id },
          { $set: { tapped_at: new Date(), clicked: true } },
        ).catch((err) => {
          log.warn({ err: err.message, code }, 'tapped_at update failed (swallowed)');
        });
      } catch (err) {
        log.warn({ err: err.message, code }, 'tapped_at dispatch threw (swallowed)');
      }
    }
    const url = `https://wa.me/${phone}?text=${encodeURIComponent('Hi! GBREF-' + code)}`;
    return res.redirect(302, url);
  } catch (err) {
    log.warn({ err: err.message, code }, 'GBREF redirect failed');
    return res.redirect(302, fallbackUrl());
  }
});

module.exports = router;
