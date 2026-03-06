// src/routes/auth.js
// Meta OAuth 2.0 authentication flow
//
// HOW OAUTH WORKS (simple explanation):
// 1. Restaurant owner clicks "Connect with Meta" on your frontend
// 2. Your frontend calls GET /auth/login → you redirect to Facebook's login page
// 3. Owner logs in on Facebook, approves your app
// 4. Facebook redirects back to your /auth/callback with a one-time "code"
// 5. You exchange that code for an access token (like a long-lived key)
// 6. You store the token — now you can send/receive WhatsApp messages for them
// 7. You issue your own JWT so they stay logged into your dashboard

const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const router = express.Router();
const db = require('../config/database');

const META_GRAPH_URL = 'https://graph.facebook.com/v25.0';
const META_AUTH_URL = 'https://www.facebook.com/v25.0/dialog/oauth';

// ─── STEP 1: INITIATE OAUTH ───────────────────────────────────
// Frontend calls this → we redirect to Facebook login
// GET /auth/login
router.get('/login', (req, res) => {
  // These "scopes" are the permissions we're requesting
  const scopes = [
    'whatsapp_business_management',  // Access WA Business accounts
    'whatsapp_business_messaging',   // Send and receive messages
    'business_management',           // Access business info
  ].join(',');

  const authUrl =
    `${META_AUTH_URL}?` +
    `client_id=${process.env.META_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(process.env.META_OAUTH_REDIRECT_URI)}` +
    `&scope=${scopes}` +
    `&response_type=code` +
    `&state=${Buffer.from(Date.now().toString()).toString('base64')}`; // CSRF protection

  res.redirect(authUrl);
});

// ─── STEP 2: HANDLE CALLBACK ──────────────────────────────────
// Facebook redirects here after user approves
// GET /auth/callback?code=xxx
router.get('/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    console.error('[OAuth] Error or no code:', req.query);
    return res.redirect(`${process.env.BASE_URL}/?error=oauth_failed`);
  }

  try {
    // Exchange code for short-lived access token
    const tokenRes = await axios.get(`${META_GRAPH_URL}/oauth/access_token`, {
      params: {
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        redirect_uri: process.env.META_OAUTH_REDIRECT_URI,
        code,
      },
    });
    const shortToken = tokenRes.data.access_token;

    // Exchange short-lived token for long-lived / never-expiring token.
    // The login config (3105026846366355) has "never expire" permission enabled,
    // so expires_in will be absent — store NULL to indicate no expiry.
    const longTokenRes = await axios.get(`${META_GRAPH_URL}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        fb_exchange_token: shortToken,
      },
    });
    const longToken = longTokenRes.data.access_token;
    const expiresIn = longTokenRes.data.expires_in || null;
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;

    // Get user info from Meta
    const userRes = await axios.get(`${META_GRAPH_URL}/me`, {
      params: { fields: 'id,name,email', access_token: longToken },
    });
    const metaUser = userRes.data;

    // Get WhatsApp Business Accounts for this user
    let wabaData = [];
    try {
      const wabaRes = await axios.get(`${META_GRAPH_URL}/${metaUser.id}/businesses`, {
        params: {
          fields: 'id,name,whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name,quality_rating}}',
          access_token: longToken,
        },
      });
      wabaData = wabaRes.data?.data || [];
    } catch (e) {
      console.warn('[OAuth] Could not fetch WABAs:', e.message);
    }

    // Upsert restaurant in our DB
    const { rows: existing } = await db.query(
      'SELECT id FROM restaurants WHERE meta_user_id = $1',
      [metaUser.id]
    );

    let restaurantId;
    if (existing.length) {
      // Update existing restaurant's token
      await db.query(
        `UPDATE restaurants SET
           meta_access_token = $1,
           meta_token_expires_at = $2,
           owner_name = COALESCE(owner_name, $3),
           email = COALESCE(email, $4),
           updated_at = NOW()
         WHERE meta_user_id = $5`,
        [longToken, expiresAt, metaUser.name, metaUser.email, metaUser.id]
      );
      restaurantId = existing[0].id;
    } else {
      // New restaurant
      const { rows: created } = await db.query(
        `INSERT INTO restaurants (meta_user_id, meta_access_token, meta_token_expires_at, owner_name, email)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [metaUser.id, longToken, expiresAt, metaUser.name, metaUser.email]
      );
      restaurantId = created[0].id;
    }

    // Save WhatsApp accounts found
    for (const biz of wabaData) {
      const wabas = biz.whatsapp_business_accounts?.data || [];
      for (const waba of wabas) {
        for (const phone of waba.phone_numbers?.data || []) {
          await db.query(
            `INSERT INTO whatsapp_accounts
               (restaurant_id, waba_id, phone_number_id, phone_display, display_name, quality_rating, access_token)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (phone_number_id)
             DO UPDATE SET
               display_name = EXCLUDED.display_name,
               quality_rating = EXCLUDED.quality_rating,
               access_token = EXCLUDED.access_token,
               updated_at = NOW()`,
            [restaurantId, waba.id, phone.id, phone.display_phone_number,
             phone.verified_name, phone.quality_rating?.display_value || 'GREEN', longToken]
          );
        }
      }
    }

    // Issue our own JWT for dashboard authentication
    const jwtToken = jwt.sign(
      { restaurantId, metaUserId: metaUser.id },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Redirect to frontend with token
    res.redirect(`/dashboard.html?token=${jwtToken}`);
  } catch (err) {
    console.error('[OAuth] Callback error:', err.response?.data || err.message);
    res.redirect('/?error=oauth_failed');
  }
});

// ─── FACEBOOK JS SDK LOGIN ─────────────────────────────────────
// Called when user logs in via the Facebook JS SDK button
// Receives the short-lived client token → exchanges for long-lived → issues JWT
router.post('/facebook', express.json(), async (req, res) => {
  const { accessToken, code } = req.body;
if (!accessToken && !code) return res.status(400).json({ error: 'No token provided' });

try {
  let longToken, expiresAt;

  if (code) {
    // Embedded signup / Business Login sends a code — exchange for token.
    // Config 3105026846366355 has "never expire" enabled → expires_in absent → store NULL.
    const tokenRes = await axios.get(`${META_GRAPH_URL}/oauth/access_token`, {
      params: {
        client_id    : process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        redirect_uri : process.env.META_OAUTH_REDIRECT_URI,
        code,
      },
    });
    longToken = tokenRes.data.access_token;
    const expiresIn = tokenRes.data.expires_in || null;
    expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
  } else {
    // Direct access token from FB.login — exchange for long-lived / never-expiring.
    const longTokenRes = await axios.get(`${META_GRAPH_URL}/oauth/access_token`, {
      params: {
        grant_type       : 'fb_exchange_token',
        client_id        : process.env.META_APP_ID,
        client_secret    : process.env.META_APP_SECRET,
        fb_exchange_token: accessToken,
      },
    });
    longToken = longTokenRes.data.access_token;
    const expiresIn = longTokenRes.data.expires_in || null;
    expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
  }

    // Get Meta user profile
    const userRes = await axios.get(`${META_GRAPH_URL}/me`, {
      params: { fields: 'id,name,email', access_token: longToken },
    });
    const metaUser = userRes.data;

    // Get their WhatsApp Business Accounts
    let wabaData = [];
    try {
      const wabaRes = await axios.get(`${META_GRAPH_URL}/${metaUser.id}/businesses`, {
        params: {
          fields      : 'id,name,whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name,quality_rating}}',
          access_token: longToken,
        },
      });
      wabaData = wabaRes.data?.data || [];
    } catch (e) {
      console.warn('[Auth] Could not fetch WABAs:', e.message);
    }

    // Upsert restaurant record
    const { rows: existing } = await db.query(
      'SELECT id, approval_status, onboarding_step FROM restaurants WHERE meta_user_id = $1',
      [metaUser.id]
    );

    let restaurantId, approvalStatus, needsOnboarding;
    if (existing.length) {
      await db.query(
        `UPDATE restaurants SET
           meta_access_token     = $1,
           meta_token_expires_at = $2,
           owner_name = COALESCE(owner_name, $3),
           email      = COALESCE(email, $4),
           updated_at = NOW()
         WHERE meta_user_id = $5`,
        [longToken, expiresAt, metaUser.name, metaUser.email, metaUser.id]
      );
      restaurantId    = existing[0].id;
      approvalStatus  = existing[0].approval_status || 'pending';
      needsOnboarding = (existing[0].onboarding_step || 1) < 5;
    } else {
      const { rows: created } = await db.query(
        `INSERT INTO restaurants
           (meta_user_id, meta_access_token, meta_token_expires_at, owner_name, email, approval_status)
         VALUES ($1,$2,$3,$4,$5,'pending') RETURNING id`,
        [metaUser.id, longToken, expiresAt, metaUser.name, metaUser.email]
      );
      restaurantId    = created[0].id;
      approvalStatus  = 'pending';
      needsOnboarding = true;
    }

    // Save WhatsApp accounts
    for (const biz of wabaData) {
      for (const waba of biz.whatsapp_business_accounts?.data || []) {
        for (const phone of waba.phone_numbers?.data || []) {
          await db.query(
            `INSERT INTO whatsapp_accounts
               (restaurant_id, waba_id, phone_number_id, phone_display, display_name, quality_rating, access_token)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (phone_number_id) DO UPDATE SET
               display_name   = EXCLUDED.display_name,
               quality_rating = EXCLUDED.quality_rating,
               access_token   = EXCLUDED.access_token,
               updated_at     = NOW()`,
            [restaurantId, waba.id, phone.id, phone.display_phone_number,
             phone.verified_name, phone.quality_rating?.display_value || 'GREEN', longToken]
          );
        }
      }
    }

    // Issue our JWT
    const jwtToken = jwt.sign(
      { restaurantId, metaUserId: metaUser.id },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({ token: jwtToken, approvalStatus, needsOnboarding });

  } catch (err) {
    console.error('[Auth] Facebook login error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// ─── COMPLETE ONBOARDING ──────────────────────────────────────
// POST /auth/onboarding — Save business details after Meta OAuth
// Requires JWT (any approval_status); sets approval_status = 'pending'
router.post('/onboarding', requireAuth, express.json(), async (req, res) => {
  try {
    const {
      ownerName, phone, brandName, registeredBusinessName,
      gstNumber, fssaiLicense, fssaiExpiry, restaurantType, city,
    } = req.body;

    if (!ownerName || !phone || !brandName || !registeredBusinessName || !gstNumber || !fssaiLicense || !fssaiExpiry) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    await db.query(
      `UPDATE restaurants SET
         owner_name                = $1,
         phone                     = $2,
         business_name             = $3,
         brand_name                = $3,
         registered_business_name  = $4,
         gst_number                = $5,
         fssai_license             = $6,
         fssai_expiry              = $7,
         restaurant_type           = $8,
         city                      = $9,
         approval_status           = 'pending',
         submitted_at              = NOW(),
         onboarding_step           = 5,
         updated_at                = NOW()
       WHERE id = $10`,
      [ownerName, phone, brandName, registeredBusinessName,
       gstNumber, fssaiLicense, fssaiExpiry, restaurantType || 'both',
       city || null, req.restaurantId]
    );

    res.json({ submitted: true });
  } catch (err) {
    console.error('[Onboarding]', err.message);
    res.status(500).json({ error: 'Failed to save details' });
  }
});

// ─── GET CURRENT USER ─────────────────────────────────────────
// GET /auth/me — Returns logged-in restaurant info
router.get('/me', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT r.id, r.business_name, r.brand_name, r.owner_name, r.email, r.phone,
            r.logo_url, r.onboarding_step, r.commission_pct, r.status,
            r.approval_status, r.approval_notes, r.submitted_at,
            r.gst_number, r.fssai_license, r.fssai_expiry, r.restaurant_type,
            r.bank_name, r.bank_account_number, r.bank_ifsc
     FROM restaurants r WHERE r.id = $1`,
    [req.restaurantId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

// ─── JWT AUTH MIDDLEWARE ──────────────────────────────────────
// Attach this to any route that needs login
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.restaurantId = decoded.restaurantId;
    req.metaUserId = decoded.metaUserId;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

// ─── APPROVED-ONLY MIDDLEWARE ─────────────────────────────────
// Use on dashboard routes. Blocks access until admin approves.
async function requireApproved(req, res, next) {
  try {
    const { rows } = await db.query(
      'SELECT approval_status FROM restaurants WHERE id = $1',
      [req.restaurantId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Restaurant not found' });
    if (rows[0].approval_status !== 'approved') {
      return res.status(403).json({
        error: 'pending_approval',
        approval_status: rows[0].approval_status,
        message: 'Your application is under review. You will be notified once approved.',
      });
    }
    next();
  } catch (err) {
    console.error('[requireApproved]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { router, requireAuth, requireApproved };