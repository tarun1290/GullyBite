// src/routes/auth.js
// Email/password + Google OAuth + Meta WhatsApp authentication

const express = require('express');
const axios   = require('axios');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const router  = express.Router();
const { col, newId } = require('../config/database');
const { logActivity } = require('../services/activityLog');
const metaConfig = require('../config/meta');
// memcache is the in-memory cache used by webhooks/whatsapp.js → cachedLookup.getWaAccount.
// Required so _saveWabaAccounts can invalidate stale entries when a restaurant
// changes their connected WABA — without this, webhook routing for the OLD
// phone_number_id would continue for up to the cache TTL (5 minutes).
const memcache = require('../config/memcache');

const crypto = require('crypto');
const log = require('../utils/logger').child({ component: 'auth' });

const META_GRAPH_URL = metaConfig.graphUrl;

// ── META OAUTH STATE / RESULT STORAGE ────────────────────────
// Persisted in MongoDB so the flow survives across Lambda instances on Vercel.
// Two collections (with TTL indexes — see config/indexes.js):
//
//   meta_oauth_states     — CSRF state, restaurant binding, single-use
//   meta_connect_results  — callback outcome handed off to the dashboard
//
// The previous in-memory `_metaConnectStore = new Map()` was the root cause of
// the "authentication error" users were seeing: on Vercel, the Lambda that ran
// the callback was usually a different instance from the one serving the
// dashboard's resolve request, so the entry was always missing.
const META_STATE_TTL_MS  = 10 * 60 * 1000; // 10 minutes — covers slow Meta consent + 2FA
const META_RESULT_TTL_MS = 10 * 60 * 1000;

// ── Log OAuth redirect URIs at startup ──
log.info({
  googleCallback: `${process.env.BASE_URL}/auth/google/callback`,
  metaOAuthRedirect: process.env.META_OAUTH_REDIRECT_URI || '(not set)',
  googleClientId: process.env.GOOGLE_CLIENT_ID?.slice(0, 30) + '...' || '(not set)',
}, 'OAuth redirect URIs configured');

// ─── PUBLIC META CONFIG ───────────────────────────────────────
// Returns the *public* Meta App identifiers needed by the frontend
// to launch FB SDK + Embedded Signup. These values are intentionally
// public (they appear in the OAuth dialog URL anyway). Secrets like
// META_APP_SECRET and META_SYSTEM_USER_TOKEN are NEVER returned.
//
// Single source of truth: backend env vars (META_APP_ID,
// META_LOGIN_CONFIG_ID, WA_API_VERSION). The frontend bootstraps
// this once on page load — see dashboard.html / index.html.
router.get('/meta-config', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300'); // 5 min — values rarely change
  res.json({
    appId: metaConfig.appId || null,
    loginConfigId: metaConfig.loginConfigId || null,
    apiVersion: metaConfig.apiVersion,
  });
});

// ─── SIGN UP ──────────────────────────────────────────────────
router.post('/signup', express.json(), async (req, res) => {
  try {
    const { ownerName, email, password } = req.body;
    if (!ownerName || !email || !password)
      return res.status(400).json({ error: 'Name, email and password are required' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!/[A-Z]/.test(password))
      return res.status(400).json({ error: 'Password must contain at least one uppercase letter' });
    if (!/[a-z]/.test(password))
      return res.status(400).json({ error: 'Password must contain at least one lowercase letter' });
    if (!/[0-9]/.test(password))
      return res.status(400).json({ error: 'Password must contain at least one number' });
    if (!/[^A-Za-z0-9]/.test(password))
      return res.status(400).json({ error: 'Password must contain at least one special character (e.g. @, #, !)' });

    const existing = await col('restaurants').findOne({ email: email.toLowerCase() });
    if (existing) {
      if (existing.google_id && !existing.password_hash)
        return res.status(409).json({ error: 'An account with this email already exists. Please sign in with Google.' });
      return res.status(409).json({ error: 'An account with this email already exists. Try signing in instead.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const id = newId();
    await col('restaurants').insertOne({
      _id: id, owner_name: ownerName.trim(), email: email.toLowerCase().trim(),
      password_hash: passwordHash, auth_provider: 'local',
      approval_status: 'pending', onboarding_step: 1,
      business_name: 'My Restaurant', status: 'active',
      created_at: new Date(), updated_at: new Date(),
    });
    const ownerUser = await ensureOwnerUser(id, ownerName.trim());
    const token = jwt.sign({
      restaurantId: id,
      userId: String(ownerUser._id),
      role: 'owner',
      permissions: ROLE_PERMISSIONS.owner,
      branchIds: [],
    }, process.env.JWT_SECRET, { expiresIn: '30d' });
    logActivity({ actorType: 'restaurant', actorId: id, action: 'restaurant.signup', category: 'auth', description: `New restaurant registered: ${req.body.ownerName || 'Unknown'}`, restaurantId: id, severity: 'info' });
    res.json({ token, needsOnboarding: true, onboardingStep: 1, user: { id: String(ownerUser._id), name: ownerUser.name, role: 'owner', permissions: ROLE_PERMISSIONS.owner } });
  } catch (err) {
    req.log.error({ err }, 'Signup failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── SIGN IN ──────────────────────────────────────────────────
router.post('/signin', express.json(), async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required' });

    const restaurant = await col('restaurants').findOne({ email: email.toLowerCase() });
    if (!restaurant) return res.status(401).json({ error: 'No account found with this email' });
    if (!restaurant.password_hash)
      return res.status(401).json({ error: 'This account uses Google sign-in. Please use "Continue with Google" instead.' });

    const valid = await bcrypt.compare(password, restaurant.password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    const ownerUser = await ensureOwnerUser(String(restaurant._id), restaurant.owner_name);
    const token = jwt.sign({
      restaurantId: String(restaurant._id),
      userId: String(ownerUser._id),
      role: 'owner',
      permissions: ROLE_PERMISSIONS.owner,
      branchIds: [],
    }, process.env.JWT_SECRET, { expiresIn: '30d' });
    const step = restaurant.onboarding_step || 1;
    res.json({
      token,
      approvalStatus: restaurant.approval_status || 'pending',
      onboardingStep: step,
      needsOnboarding: step < 2,
      user: { id: String(ownerUser._id), name: ownerUser.name, role: 'owner', permissions: ROLE_PERMISSIONS.owner },
    });
  } catch (err) {
    req.log.error({ err }, 'Signin failed');
    res.status(500).json({ error: 'Sign in failed' });
  }
});

// ─── GOOGLE SIGN IN ──────────────────────────────────────────
router.post('/google', express.json(), async (req, res) => {
  try {
    const { code } = req.body;
    req.log.info({ codePresent: !!code }, 'Route hit');
    if (!code) return res.status(400).json({ error: 'Authorization code required' });

    // 1. Exchange auth code for tokens
    req.log.info({ clientId: process.env.GOOGLE_CLIENT_ID?.slice(0, 20) + '...' }, 'Exchanging code');
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: 'postmessage',
      grant_type: 'authorization_code',
    });
    req.log.info('Token exchange successful');

    // 2. Fetch user profile
    const userRes = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` },
    });
    const { id: googleId, name, email, picture } = userRes.data;
    req.log.info({ googleId, name, email }, 'User profile fetched');

    // 3. Find or create restaurant
    let restaurant = await col('restaurants').findOne({ google_id: googleId });
    if (!restaurant && email) {
      restaurant = await col('restaurants').findOne({ email: email.toLowerCase() });
    }

    let restaurantId, needsOnboarding, approvalStatus;
    if (restaurant) {
      const $set = { google_id: googleId, updated_at: new Date() };
      if (picture) $set.profile_picture = picture;
      if (name && !restaurant.owner_name) $set.owner_name = name;
      // Link accounts: if they signed up with email/password, mark as 'both'
      if (restaurant.auth_provider === 'local') $set.auth_provider = 'both';
      else if (!restaurant.auth_provider) $set.auth_provider = 'google';
      await col('restaurants').updateOne({ _id: restaurant._id }, { $set });
      restaurantId    = String(restaurant._id);
      approvalStatus  = restaurant.approval_status || 'pending';
      needsOnboarding = (restaurant.onboarding_step || 1) < 2;
    } else {
      restaurantId = newId();
      await col('restaurants').insertOne({
        _id: restaurantId, google_id: googleId,
        owner_name: name || 'Owner', email: email?.toLowerCase(),
        profile_picture: picture || null, auth_provider: 'google',
        business_name: 'My Restaurant', status: 'active',
        approval_status: 'pending', onboarding_step: 1,
        created_at: new Date(), updated_at: new Date(),
      });
      approvalStatus  = 'pending';
      needsOnboarding = true;
    }

    // 4. Issue JWT
    const ownerUser = await ensureOwnerUser(restaurantId, name);
    const token = jwt.sign({
      restaurantId,
      userId: String(ownerUser._id),
      role: 'owner',
      permissions: ROLE_PERMISSIONS.owner,
      branchIds: [],
    }, process.env.JWT_SECRET, { expiresIn: '30d' });

    req.log.info({ restaurantId, needsOnboarding, approvalStatus }, 'Google auth success');
    res.json({
      token, approvalStatus, needsOnboarding,
      onboardingStep: restaurant?.onboarding_step || 1,
      user: { id: String(ownerUser._id), name: ownerUser.name, role: 'owner', permissions: ROLE_PERMISSIONS.owner },
    });
  } catch (err) {
    req.log.error({ err, responseData: err.response?.data }, 'Google auth failed');
    res.status(500).json({ error: 'Google authentication failed' });
  }
});

// ─── GOOGLE OAUTH REDIRECT CALLBACK ──────────────────────────
// Google redirects here after user consents (redirect mode)
router.get('/google/callback', async (req, res) => {
  const { code, error } = req.query;
  req.log.info({ codePresent: !!code, error: error || 'none' }, 'Google callback hit');

  if (error || !code) {
    return res.redirect('/?error=google_auth_failed');
  }

  try {
    // Use BASE_URL to ensure https — req.protocol returns 'http' behind Vercel's proxy
    const redirectUri = `${process.env.BASE_URL}/auth/google/callback`;
    req.log.info({ redirectUri }, 'Using redirect_uri');

    // 1. Exchange code for tokens
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    req.log.info('Token exchange successful');

    // 2. Fetch user profile
    const userRes = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` },
    });
    const { id: googleId, name, email, picture } = userRes.data;
    req.log.info({ googleId, name, email }, 'User profile fetched');

    // 3. Find or create restaurant
    let restaurant = await col('restaurants').findOne({ google_id: googleId });
    if (!restaurant && email) {
      restaurant = await col('restaurants').findOne({ email: email.toLowerCase() });
    }

    let restaurantId;
    if (restaurant) {
      const $set = { google_id: googleId, updated_at: new Date() };
      if (picture) $set.profile_picture = picture;
      if (name && !restaurant.owner_name) $set.owner_name = name;
      if (restaurant.auth_provider === 'local') $set.auth_provider = 'both';
      else if (!restaurant.auth_provider) $set.auth_provider = 'google';
      await col('restaurants').updateOne({ _id: restaurant._id }, { $set });
      restaurantId = String(restaurant._id);
    } else {
      restaurantId = newId();
      await col('restaurants').insertOne({
        _id: restaurantId, google_id: googleId,
        owner_name: name || 'Owner', email: email?.toLowerCase(),
        profile_picture: picture || null, auth_provider: 'google',
        business_name: 'My Restaurant', status: 'active',
        approval_status: 'pending', onboarding_step: 1,
        created_at: new Date(), updated_at: new Date(),
      });
    }

    // 4. Issue JWT
    const ownerUser = await ensureOwnerUser(restaurantId, name);
    const jwtToken = jwt.sign({
      restaurantId,
      userId: String(ownerUser._id),
      role: 'owner',
      permissions: ROLE_PERMISSIONS.owner,
      branchIds: [],
    }, process.env.JWT_SECRET, { expiresIn: '30d' });

    req.log.info('Success, redirecting with token');
    // Redirect to frontend with token in URL — frontend will pick it up
    res.redirect(`/?google_token=${jwtToken}`);
  } catch (err) {
    req.log.error({ err, responseData: err.response?.data }, 'Google callback failed');
    res.redirect('/?error=google_auth_failed');
  }
});

// ─── META OAUTH START (redirect-only) ─────────────────────────
// Authenticated. Generates a CSRF state row in MongoDB, builds the canonical
// Meta OAuth URL, and returns it to the frontend. The frontend then does
// `window.location.href = url` — NO popup, NO FB.login.
//
// The state row carries the restaurant_id binding, so the unauthenticated
// callback can link the WABA to the correct tenant without needing to read
// any cookie or Bearer header.
router.post('/meta/start', requireAuth, express.json(), async (req, res) => {
  try {
    const redirectUri = process.env.META_OAUTH_REDIRECT_URI;
    if (!redirectUri) {
      req.log.error('META_OAUTH_REDIRECT_URI not configured');
      return res.status(500).json({ error: 'Meta OAuth is not configured. Please contact support.' });
    }
    if (!metaConfig.appId || !metaConfig.appSecret) {
      req.log.error({ appId: !!metaConfig.appId, appSecret: !!metaConfig.appSecret }, 'Meta app credentials missing');
      return res.status(500).json({ error: 'Meta App credentials are not configured. Please contact support.' });
    }

    // Auth strategy: redirect (default, guaranteed) OR popup (optional enhancement
    // when the frontend detects a popup-friendly browser). The callback reads
    // this field to decide whether to render a postMessage HTML page (popup) or
    // do a 302 to /dashboard.html (redirect).
    const requestedMode = req.body?.mode;
    const mode = requestedMode === 'popup' ? 'popup' : 'redirect';

    const state = crypto.randomBytes(32).toString('hex');
    const now = new Date();
    await col('meta_oauth_states').insertOne({
      _id: state,
      restaurant_id: req.restaurantId,
      created_at: now,
      expires_at: new Date(now.getTime() + META_STATE_TTL_MS),
      used: false,
      mode,
      // Where to send the user after the dashboard finishes processing — useful
      // for resuming flows like settings vs onboarding.
      return_to: typeof req.body?.return_to === 'string' ? req.body.return_to : null,
    });

    // Standard Meta scopes for WhatsApp Business onboarding.
    const scope = 'business_management,whatsapp_business_management,whatsapp_business_messaging';

    const params = new URLSearchParams({
      client_id:    metaConfig.appId,
      redirect_uri: redirectUri,
      state,
      scope,
      response_type: 'code',
    });

    // If a Meta Embedded Signup config_id is configured, include it so the user
    // sees the streamlined WABA signup UI instead of the generic OAuth dialog.
    // Both flows return a `code` we can exchange — the difference is purely UX.
    if (metaConfig.loginConfigId) {
      params.set('config_id', metaConfig.loginConfigId);
      params.set('override_default_response_type', 'true');
    }

    const authUrl = `https://www.facebook.com/${metaConfig.apiVersion}/dialog/oauth?${params.toString()}`;
    req.log.info({ statePrefix: state.slice(0, 8), restaurantId: req.restaurantId, mode, hasConfigId: !!metaConfig.loginConfigId }, 'Meta OAuth start');
    res.json({ authUrl, state, mode });
  } catch (err) {
    req.log.error({ err }, 'Meta OAuth start failed');
    res.status(500).json({ error: 'Could not start Meta connection. Please try again.' });
  }
});

// ─── META OAUTH REDIRECT CALLBACK ────────────────────────────────
// Meta redirects here after the user authorizes our app. UNAUTHENTICATED —
// identity is supplied by the `state` row in MongoDB, NOT by any cookie/Bearer.
//
// This handler does the entire link end-to-end (token exchange + WABA discovery
// + DB persistence) so the dashboard does not need to do any further work. It
// then redirects to /dashboard.html?meta_connect_id=<resultId>, where the
// dashboard reads a small status row to show success or failure.
router.get('/callback', async (req, res) => {
  const { code, state, error, error_reason, error_description } = req.query;
  req.log.info({ codePresent: !!code, statePresent: !!state, error: error || 'none', reason: error_reason || 'none' }, 'Meta callback hit');

  // Mode is read from the state row (set at /auth/meta/start time). We capture
  // it in this closure variable so finishWithResult below knows whether to
  // render the popup HTML page or do a redirect. Default to 'redirect' so an
  // unknown/missing state still falls through the safe path.
  let resolvedMode = 'redirect';

  // Helper: persist the result row and either redirect (default) or render
  // a popup-callback HTML page that postMessages window.opener and closes.
  const finishWithResult = async (restaurantId, payload) => {
    const resultId = crypto.randomBytes(24).toString('hex');
    const now = new Date();
    try {
      await col('meta_connect_results').insertOne({
        _id: resultId,
        restaurant_id: restaurantId || null,
        created_at: now,
        expires_at: new Date(now.getTime() + META_RESULT_TTL_MS),
        consumed: false,
        ...payload,
      });
    } catch (e) {
      req.log.error({ err: e }, 'Could not persist meta_connect_result');
    }

    if (resolvedMode === 'popup') {
      // Render a tiny self-contained HTML page that:
      //   1. postMessages the result to window.opener (origin-locked)
      //   2. closes the popup
      //   3. Falls back to a top-level navigation if window.opener is gone
      //      (covers the rare case where the user navigated the original tab
      //      away while the popup was running)
      const target = restaurantId ? '/dashboard.html' : '/';
      const fallbackUrl = `${target}?meta_connect_id=${resultId}`;
      const baseUrl = process.env.BASE_URL || '';
      // Inject only the minimal data the opener needs — the resultId. The
      // opener will fetch /auth/meta/result?id=... to get the authoritative
      // payload (and mark the row consumed).
      const safeJson = (s) => JSON.stringify(s).replace(/</g, '\\u003c');
      const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Connecting WhatsApp Business…</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; text-align: center; padding: 40px 20px; color: #1f2937; background: #f8fafc; }
    .spin { width: 38px; height: 38px; margin: 0 auto 20px; border: 3px solid #e5e7eb; border-top-color: #4f46e5; border-radius: 50%; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    a { color: #4f46e5; }
  </style>
</head>
<body>
  <div class="spin"></div>
  <p>Finishing your WhatsApp Business connection…</p>
  <p style="font-size:.85rem;color:#64748b">If this window does not close automatically, <a id="gb-fallback" href="${fallbackUrl}">click here</a>.</p>
  <script>
  (function () {
    var msg = { type: 'gb-meta-connect-result', resultId: ${safeJson(resultId)} };
    var origin = ${safeJson(baseUrl)} || window.location.origin;
    var sent = false;
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(msg, origin);
        sent = true;
      }
    } catch (e) { /* opener cross-origin or gone */ }
    if (sent) {
      // Give the opener a tick to receive the message before we close.
      setTimeout(function () { try { window.close(); } catch (e) {} }, 150);
      // If close() fails (popup-blocker rules in some browsers), fall back to
      // navigating this window to the dashboard so the user is not stranded.
      setTimeout(function () { window.location.replace(${safeJson(fallbackUrl)}); }, 1500);
    } else {
      // No usable opener — bounce this window itself to the dashboard.
      window.location.replace(${safeJson(fallbackUrl)});
    }
  })();
  </script>
</body>
</html>`;
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Cache-Control', 'no-store');
      // X-Frame-Options DENY: callback should never render in an iframe.
      res.set('X-Frame-Options', 'DENY');
      return res.send(html);
    }

    // Default redirect path — same behavior as before.
    const target = restaurantId ? '/dashboard.html' : '/';
    return res.redirect(`${target}?meta_connect_id=${resultId}`);
  };

  // 1. Validate state — atomically claim it so it cannot be replayed.
  if (!state || typeof state !== 'string') {
    req.log.warn('Meta callback missing state');
    return finishWithResult(null, { ok: false, error: 'invalid_state', message: 'Missing security state. Please retry the connection from the dashboard.' });
  }
  const stateDoc = await col('meta_oauth_states').findOneAndDelete({ _id: state });
  // findOneAndDelete returns the doc directly in some driver versions, or { value: doc } in others.
  const stateRow = stateDoc?.value || stateDoc;
  if (!stateRow || !stateRow.restaurant_id) {
    req.log.warn({ statePrefix: String(state).slice(0, 8) }, 'Meta callback: state not found or already used');
    return finishWithResult(null, { ok: false, error: 'invalid_state', message: 'Security state expired or already used. Please retry the connection from the dashboard.' });
  }
  // Resolve mode from the state row so finishWithResult knows whether to
  // render popup HTML or do a redirect. Default to redirect on missing/unknown.
  if (stateRow.mode === 'popup') resolvedMode = 'popup';
  if (stateRow.expires_at && new Date(stateRow.expires_at) < new Date()) {
    req.log.warn({ statePrefix: String(state).slice(0, 8) }, 'Meta callback: state expired');
    return finishWithResult(stateRow.restaurant_id, { ok: false, error: 'state_expired', message: 'Connection link expired. Please reconnect from the dashboard.' });
  }
  const restaurantId = stateRow.restaurant_id;

  // 2. Surface user-cancel and Meta errors verbatim.
  if (error || !code) {
    req.log.warn({ error, error_reason, error_description }, 'Meta callback: no code (user cancelled or Meta error)');
    return finishWithResult(restaurantId, {
      ok: false,
      error: error || 'no_code',
      message: error_description || error_reason || 'Meta did not return an authorization code. Please try again.',
    });
  }

  try {
    // 3. Exchange code → long-lived access token.
    req.log.info({ restaurantId, redirectUri: process.env.META_OAUTH_REDIRECT_URI, appId: metaConfig.appId }, 'Exchanging code');
    const tokenRes = await axios.get(`${META_GRAPH_URL}/oauth/access_token`, {
      params: {
        client_id:     metaConfig.appId,
        client_secret: metaConfig.appSecret,
        redirect_uri:  process.env.META_OAUTH_REDIRECT_URI,
        code,
      },
      timeout: 15000,
    });
    const longToken = tokenRes.data?.access_token;
    const expiresIn = tokenRes.data?.expires_in;
    if (!longToken) {
      req.log.error({ responseData: tokenRes.data }, 'Token exchange returned no access_token');
      return finishWithResult(restaurantId, { ok: false, error: 'no_token', message: 'Meta did not return an access token. Please try again.' });
    }
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
    req.log.info({ restaurantId, tokenLength: longToken.length, expiresIn }, 'Code exchange successful');

    // 4. Fetch Meta user profile.
    const userRes = await axios.get(`${META_GRAPH_URL}/me`, {
      params: { fields: 'id,name,email', access_token: longToken },
      timeout: 10000,
    });
    const metaUser = userRes.data;
    req.log.info({ restaurantId, metaUserId: metaUser.id }, 'Meta user fetched');

    // 5. Discover WABAs via /me/businesses → /me/whatsapp_business_accounts fallback.
    let wabaData = [];
    try {
      const wabaRes = await axios.get(`${META_GRAPH_URL}/${metaUser.id}/businesses`, {
        params: {
          fields: 'id,name,whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name,quality_rating}}',
          access_token: longToken,
        },
        timeout: 15000,
      });
      wabaData = wabaRes.data?.data || [];
    } catch (e) {
      req.log.warn({ err: e?.response?.data || e?.message }, 'WABA discovery via /me/businesses failed');
    }
    if (!wabaData.length) {
      try {
        const directRes = await axios.get(`${META_GRAPH_URL}/me/whatsapp_business_accounts`, {
          params: { fields: 'id,name,phone_numbers{id,display_phone_number,verified_name,quality_rating}', access_token: longToken },
          timeout: 15000,
        });
        const directWabas = directRes.data?.data || [];
        if (directWabas.length) {
          wabaData = [{ id: 'direct', name: 'Direct', whatsapp_business_accounts: { data: directWabas } }];
        }
      } catch (e) {
        req.log.warn({ err: e?.response?.data || e?.message }, 'Direct WABA fallback failed');
      }
    }

    // 6. Persist on the restaurant doc + whatsapp_accounts.
    const currentRestaurant = await col('restaurants').findOne(
      { _id: restaurantId }, { projection: { approval_status: 1, submitted_at: 1 } }
    );
    if (!currentRestaurant) {
      req.log.error({ restaurantId }, 'Callback: restaurant not found for state');
      return finishWithResult(restaurantId, { ok: false, error: 'tenant_missing', message: 'Your account could not be located. Please sign in and retry.' });
    }
    const $set = {
      meta_user_id: metaUser.id,
      meta_access_token: longToken,
      meta_token_expires_at: expiresAt,
      whatsapp_connected: true,
      onboarding_step: 5,
      updated_at: new Date(),
    };
    if (!currentRestaurant.approval_status || currentRestaurant.approval_status === 'pending') {
      $set.approval_status = 'pending';
      $set.submitted_at = currentRestaurant.submitted_at || new Date();
    }
    await col('restaurants').updateOne({ _id: restaurantId }, { $set });

    // Initialize messaging wallet (fire-and-forget — never blocks the redirect)
    require('../services/wallet').ensureWallet(restaurantId).catch(e => log.warn({ err: e, restaurantId }, 'Wallet init failed'));

    // [WABA-BIND-FIX] Read the granular_scopes from the user's token to learn
    // EXACTLY which WABAs they selected during Embedded Signup. _saveWabaAccounts
    // will refuse to bind any WABA that's not in this set, which prevents the
    // platform/admin WABAs (or any other WABA the user happens to have access
    // to) from leaking into this restaurant's account.
    const allowedWabaIds = await _fetchGranularScopeWabaIds(longToken);
    await _saveWabaAccounts(restaurantId, wabaData, longToken, null, allowedWabaIds);

    // Auto-fetch catalog info using system token (best-effort)
    try {
      const catToken = metaConfig.catalogToken;
      if (catToken) {
        // [WABA-BIND-FIX] Use the EXPLICIT linked_waba_id we recorded during
        // _saveWabaAccounts, not "the first WABA in the collection". This is
        // the linkage source of truth.
        const linkedRestaurant = await col('restaurants').findOne(
          { _id: restaurantId },
          { projection: { linked_waba_id: 1, linked_phone_number_id: 1 } }
        );
        const wa_acc = linkedRestaurant?.linked_phone_number_id
          ? await col('whatsapp_accounts').findOne({
              phone_number_id: linkedRestaurant.linked_phone_number_id,
              restaurant_id: restaurantId,
              is_active: true,
            })
          : null;
        if (wa_acc?.waba_id) {
          const wabaCatRes = await axios.get(`${META_GRAPH_URL}/${wa_acc.waba_id}/product_catalogs`, {
            params: { fields: 'id,name,product_count', access_token: catToken },
            timeout: 10000,
          });
          const catalogs = wabaCatRes.data?.data || [];
          if (catalogs.length) {
            const primary = catalogs[0];
            await col('restaurants').updateOne({ _id: restaurantId }, { $set: {
              meta_catalog_id: primary.id,
              meta_catalog_name: primary.name,
              meta_available_catalogs: catalogs.map(c => ({ id: c.id, name: c.name, product_count: c.product_count })),
              catalog_auto_fetched: true,
              catalog_fetched_at: new Date(),
            }});
          }
        }
      }
    } catch (e) {
      req.log.warn({ err: e?.response?.data || e?.message }, 'Catalog auto-fetch failed (non-fatal)');
    }

    const waAccountCount = await col('whatsapp_accounts').countDocuments({ restaurant_id: restaurantId });
    req.log.info({ restaurantId, metaUserId: metaUser.id, waAccountCount }, 'Meta connected successfully (callback)');

    return finishWithResult(restaurantId, {
      ok: true,
      meta_user_id: metaUser.id,
      meta_user_name: metaUser.name || null,
      waba_count: waAccountCount,
      return_to: stateRow.return_to || null,
    });
  } catch (err) {
    const metaErrMsg = err.response?.data?.error?.message || err.message;
    req.log.error({ err, responseData: err.response?.data, restaurantId }, 'Meta callback failed during exchange/link');
    return finishWithResult(restaurantId, {
      ok: false,
      error: 'exchange_failed',
      message: metaErrMsg || 'Could not link your WhatsApp account. Please try again.',
    });
  }
});

// ─── META OAUTH RESULT (dashboard handoff) ─────────────────────
// Authenticated. Reads the meta_connect_result row written by the callback,
// strictly enforces tenant isolation (the row's restaurant_id must match the
// caller's), and marks it consumed so it cannot be re-read.
router.get('/meta/result', requireAuth, async (req, res) => {
  const id = req.query.id;
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'meta_connect_id is required' });

  try {
    const row = await col('meta_connect_results').findOne({ _id: id });
    if (!row) {
      return res.status(410).json({ error: 'Connection result expired or already consumed. Please reconnect.' });
    }
    // Tenant isolation — refuse to leak another restaurant's outcome.
    if (row.restaurant_id && row.restaurant_id !== req.restaurantId) {
      req.log.warn({ id: id.slice(0, 8), expected: req.restaurantId, actual: row.restaurant_id }, 'Tenant mismatch on meta_connect_result');
      return res.status(403).json({ error: 'This connection result belongs to a different account.' });
    }
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      await col('meta_connect_results').deleteOne({ _id: id });
      return res.status(410).json({ error: 'Connection result expired. Please reconnect.' });
    }
    if (row.consumed) {
      return res.status(410).json({ error: 'Connection result already consumed. Please reconnect.' });
    }
    // Mark consumed (atomic) — but still return the payload to the caller.
    await col('meta_connect_results').updateOne({ _id: id }, { $set: { consumed: true, consumed_at: new Date() } });
    res.json({
      ok: !!row.ok,
      error: row.error || null,
      message: row.message || null,
      meta_user_id: row.meta_user_id || null,
      meta_user_name: row.meta_user_name || null,
      waba_count: row.waba_count || 0,
      return_to: row.return_to || null,
    });
  } catch (e) {
    req.log.error({ err: e }, 'Meta result lookup failed');
    res.status(500).json({ error: 'Could not load connection result.' });
  }
});

// ─── DEPRECATED: /resolve-meta-connect (popup-era) ─────────────
// Kept as a stub so old in-flight clients get a clear error instead of a 404.
router.get('/resolve-meta-connect', requireAuth, (req, res) => {
  res.status(410).json({ error: 'This endpoint is no longer used. Please refresh and reconnect.' });
});

// ─── BACKWARD COMPAT: Warn if old meta_access_token flow is used ──
// This will be removed after migration period.

// ─── CONNECT META / WHATSAPP ───────────────────────────────────
// Embedded Signup (config_id) codes: exchange WITHOUT redirect_uri per Meta docs.
// Server-side redirect codes: exchange WITH META_OAUTH_REDIRECT_URI.

router.post('/connect-meta', requireAuth, express.json(), async (req, res) => {
  try {
    const { accessToken, code, sessionInfo, fromJsSdk } = req.body;
    req.log.info({ codePresent: !!code, accessTokenPresent: !!accessToken, fromJsSdk: !!fromJsSdk, sessionInfo: sessionInfo || {} }, 'Route hit');
    if (!accessToken && !code) return res.status(400).json({ error: 'No token provided' });

    let longToken, expiresAt;
    if (code) {
      // For Embedded Signup (FB.login with config_id), Meta docs say to exchange
      // WITHOUT redirect_uri. For server-side redirect codes, use META_OAUTH_REDIRECT_URI.
      const exchangeParams = {
        client_id: metaConfig.appId,
        client_secret: metaConfig.appSecret,
        code,
      };
      if (!fromJsSdk) {
        exchangeParams.redirect_uri = process.env.META_OAUTH_REDIRECT_URI;
      }
      req.log.info({ fromJsSdk, redirectUri: exchangeParams.redirect_uri || '(omitted for Embedded Signup)', appId: metaConfig.appId, appSecretSet: !!metaConfig.appSecret }, 'Exchanging code');
      const tokenRes = await axios.get(`${META_GRAPH_URL}/oauth/access_token`, {
        params: exchangeParams,
      });
      longToken = tokenRes.data.access_token;
      if (!longToken) {
        req.log.error({ responseData: tokenRes.data }, 'No access_token in response');
        return res.status(400).json({ error: 'Meta returned no access token — please try again' });
      }
      expiresAt = tokenRes.data.expires_in ? new Date(Date.now() + tokenRes.data.expires_in * 1000) : null;
      req.log.info({ tokenLength: longToken?.length }, 'Code exchange successful');
    } else {
      // accessToken path — exchange short-lived token for long-lived
      req.log.info({ tokenLength: accessToken?.length }, 'Exchanging access token via fb_exchange_token');
      const longRes = await axios.get(`${META_GRAPH_URL}/oauth/access_token`, {
        params: { grant_type: 'fb_exchange_token', client_id: metaConfig.appId,
                  client_secret: metaConfig.appSecret, fb_exchange_token: accessToken },
      });
      longToken = longRes.data.access_token;
      expiresAt = longRes.data.expires_in ? new Date(Date.now() + longRes.data.expires_in * 1000) : null;
      req.log.info({ tokenLength: longToken?.length }, 'Token exchange successful');
    }

    req.log.info('Fetching Meta user profile');

    const userRes  = await axios.get(`${META_GRAPH_URL}/me`, { params: { fields: 'id,name,email', access_token: longToken } });
    const metaUser = userRes.data;
    req.log.info({ metaUserId: metaUser.id, name: metaUser.name, email: metaUser.email }, 'Meta user fetched');

    // Step 3: Fetch WABA data from businesses endpoint
    let wabaData = [];
    try {
      req.log.info('Fetching WABAs via /me/businesses');
      const wabaRes = await axios.get(`${META_GRAPH_URL}/${metaUser.id}/businesses`, {
        params: { fields: 'id,name,whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name,quality_rating}}', access_token: longToken },
      });
      wabaData = wabaRes.data?.data || [];
      req.log.info({ businessCount: wabaData.length }, 'WABA data from businesses');
    } catch (e) {
      req.log.warn({ err: e }, 'Could not fetch WABAs via businesses');
    }

    // Step 3b: If businesses endpoint returned nothing, try shared WABAs endpoint
    if (!wabaData.length) {
      try {
        req.log.info('Trying /me/whatsapp_business_accounts fallback');
        const directRes = await axios.get(`${META_GRAPH_URL}/me/whatsapp_business_accounts`, {
          params: { fields: 'id,name,phone_numbers{id,display_phone_number,verified_name,quality_rating}', access_token: longToken },
        });
        const directWabas = directRes.data?.data || [];
        if (directWabas.length) {
          req.log.info({ wabaCount: directWabas.length }, 'Found WABAs via direct endpoint');
          // Wrap in businesses format for _saveWabaAccounts
          wabaData = [{ id: 'direct', name: 'Direct', whatsapp_business_accounts: { data: directWabas } }];
        }
      } catch (e) {
        req.log.warn({ err: e }, 'Direct WABA fetch also failed');
      }
    }

    // Step 4: Save to database
    req.log.info({ restaurantId: req.restaurantId }, 'Saving to database');
    const currentRestaurant = await col('restaurants').findOne(
      { _id: req.restaurantId }, { projection: { approval_status: 1, submitted_at: 1 } }
    );
    req.log.info({ approvalStatus: currentRestaurant?.approval_status, hasSubmittedAt: !!currentRestaurant?.submitted_at }, 'Current restaurant state');

    const $set = {
      meta_user_id: metaUser.id, meta_access_token: longToken, meta_token_expires_at: expiresAt,
      whatsapp_connected: true,
      onboarding_step: 5, updated_at: new Date(),
    };
    // Only reset to pending if not already in an approved/rejected state
    if (!currentRestaurant?.approval_status || currentRestaurant.approval_status === 'pending') {
      $set.approval_status = 'pending';
      $set.submitted_at = currentRestaurant?.submitted_at || new Date();
    }
    if (sessionInfo?.phone_number_id) $set.meta_phone_number_id = sessionInfo.phone_number_id;
    if (sessionInfo?.waba_id) $set.meta_waba_id = sessionInfo.waba_id;
    const updateResult = await col('restaurants').updateOne({ _id: req.restaurantId }, { $set });
    req.log.info({ matchedCount: updateResult.matchedCount, modifiedCount: updateResult.modifiedCount }, 'Database update result');

    // Initialize messaging wallet (fire-and-forget)
    require('../services/wallet').ensureWallet(req.restaurantId).catch(e => log.warn({ err: e, restaurantId: req.restaurantId }, 'Wallet init failed'));

    // [WABA-BIND-FIX] Read granular_scopes to scope WABA discovery to ONLY
    // the WABAs the user explicitly selected during Embedded Signup. Plus,
    // if Embedded Signup gave us an explicit (waba_id, phone_number_id) in
    // sessionInfo, build a single-element allowed-set so we never even
    // attempt to save other WABAs the user has access to.
    let allowedWabaIds = await _fetchGranularScopeWabaIds(longToken);
    if (sessionInfo?.waba_id) {
      // sessionInfo is the most authoritative source — it carries the exact
      // WABA the user picked in the Embedded Signup wizard. Trust it.
      allowedWabaIds = new Set([String(sessionInfo.waba_id)]);
    }
    await _saveWabaAccounts(req.restaurantId, wabaData, longToken, sessionInfo, allowedWabaIds);

    // Step 6: Auto-fetch catalog info using system token
    // [WABA-BIND-FIX] Read the catalog for the EXPLICITLY linked WABA, not
    // "the first wa_account row found". The linkage was recorded by
    // _saveWabaAccounts as restaurants.linked_phone_number_id.
    const catToken = metaConfig.catalogToken;
    if (catToken) {
      try {
        const linkedRest = await col('restaurants').findOne(
          { _id: req.restaurantId },
          { projection: { linked_phone_number_id: 1, linked_waba_id: 1 } }
        );
        const wa_acc = linkedRest?.linked_phone_number_id
          ? await col('whatsapp_accounts').findOne({
              phone_number_id: linkedRest.linked_phone_number_id,
              restaurant_id: req.restaurantId,
              is_active: true,
            })
          : null;
        if (wa_acc?.waba_id) {
          req.log.info({ wabaId: wa_acc.waba_id }, 'Auto-fetching catalogs for WABA');
          const wabaCatRes = await axios.get(`${META_GRAPH_URL}/${wa_acc.waba_id}/product_catalogs`, {
            params: { fields: 'id,name,product_count', access_token: catToken }, timeout: 10000,
          });
          const catalogs = wabaCatRes.data?.data || [];
          if (catalogs.length) {
            const primaryCatalog = catalogs.find(c => c.vertical === 'commerce') || catalogs[0];
            await col('restaurants').updateOne({ _id: req.restaurantId }, { $set: {
              meta_catalog_id: primaryCatalog.id,
              meta_catalog_name: primaryCatalog.name,
              meta_available_catalogs: catalogs.map(c => ({ id: c.id, name: c.name, product_count: c.product_count })),
              catalog_auto_fetched: true,
              catalog_fetched_at: new Date(),
            }});
            req.log.info({ catalogName: primaryCatalog.name, catalogId: primaryCatalog.id }, 'Auto-linked catalog');
          } else {
            req.log.info('No existing catalogs found — will be created on first menu item');
          }
        }
      } catch (e) {
        req.log.warn({ err: e }, 'Catalog auto-fetch failed (non-fatal)');
      }
    }

    // Step 7: Verify what was saved
    const waAccountCount = await col('whatsapp_accounts').countDocuments({ restaurant_id: req.restaurantId });
    req.log.info({ restaurantId: req.restaurantId, metaUserId: metaUser.id, waAccountCount }, 'Meta connected successfully');
    res.json({ connected: true });
  } catch (err) {
    req.log.error({ err, responseData: err.response?.data }, 'Connect-meta failed');
    res.status(500).json({ error: 'Failed to connect WhatsApp: ' + (err.response?.data?.error?.message || err.message) });
  }
});

// ─── CHANGE PASSWORD ──────────────────────────────────────────
router.post('/change-password', requireAuth, express.json(), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8)
      return res.status(400).json({ error: 'New password must be at least 8 characters' });

    const restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
    if (!restaurant) return res.status(404).json({ error: 'Not found' });

    if (restaurant.password_hash) {
      if (!currentPassword) return res.status(400).json({ error: 'Current password is required' });
      const valid = await bcrypt.compare(currentPassword, restaurant.password_hash);
      if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    const $set = { password_hash: hash, updated_at: new Date() };
    // If Google-only account sets a password, upgrade to 'both'
    if (restaurant.auth_provider === 'google') $set.auth_provider = 'both';
    else if (!restaurant.auth_provider) $set.auth_provider = 'local';
    await col('restaurants').updateOne({ _id: req.restaurantId }, { $set });
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, 'Password change failed');
    res.status(500).json({ error: 'Password update failed' });
  }
});

// ─── DELETE ACCOUNT ──────────────────────────────────────────
router.delete('/delete-account', requireAuth, async (req, res) => {
  try {
    const id = req.restaurantId;

    // Get branch IDs to clean up menu items/categories linked by branch
    const branches = await col('branches').find({ restaurant_id: id }, { projection: { _id: 1 } }).toArray();
    const branchIds = branches.map(b => b._id);

    // Delete all related data across collections
    await Promise.all([
      col('restaurants').deleteOne({ _id: id }),
      col('whatsapp_accounts').deleteMany({ restaurant_id: id }),
      col('branches').deleteMany({ restaurant_id: id }),
      col('menu_items').deleteMany({ restaurant_id: id }),
      col('menu_categories').deleteMany({ branch_id: { $in: branchIds } }),
      col('orders').deleteMany({ restaurant_id: id }),
      col('payments').deleteMany({ restaurant_id: id }),
      col('coupons').deleteMany({ restaurant_id: id }),
      col('settlements').deleteMany({ restaurant_id: id }),
      col('referrals').deleteMany({ restaurant_id: id }),
    ]);

    req.log.info({ restaurantId: id }, 'Deleted restaurant and all associated data');
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, 'Delete account failed');
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// ─── SLUG HELPER ───────────────────────────────────────────────
// Slugifies a brand/business name into a URL-safe slug. Returns null if the
// resulting slug would be empty or unusable (e.g., name was only special chars).
// This is the SINGLE source of truth for slug generation — the frontend has a
// matching `_slugify()` helper in index.html that MUST stay in sync with the
// regex/length rules below.
function slugifyName(name) {
  if (!name || typeof name !== 'string') return null;
  const slug = name.toLowerCase()
    .replace(/&/g, ' and ')           // "Biryani & Co" → "biryani and co"
    .replace(/[^a-z0-9\s-]/g, '')     // strip punctuation
    .replace(/\s+/g, '-')             // spaces → hyphens
    .replace(/-+/g, '-')              // collapse repeats
    .replace(/^-+|-+$/g, '')          // trim leading/trailing hyphens
    .substring(0, 40);
  return slug && /[a-z0-9]/.test(slug) ? slug : null;
}

// Returns a unique store_slug derived from brandName. Pass `excludeId` to
// allow the same restaurant to keep (or rebuild) its own slug without
// triggering a self-collision suffix.
async function generateUniqueSlug(brandName, excludeId = null) {
  const base = slugifyName(brandName);
  if (!base) return null;
  let slug = base;
  let n = 1;
  // Build the conflict filter — exclude self when renaming.
  const conflictFilter = (s) => excludeId
    ? { store_slug: s, _id: { $ne: excludeId } }
    : { store_slug: s };
  while (await col('restaurants').findOne(conflictFilter(slug))) {
    slug = `${base}-${n++}`;
  }
  return slug;
}

// Detects placeholder/legacy slugs that should be regenerated when a real
// brand name becomes available. Used by /auth/me lazy-heal and /auth/onboarding.
function isPlaceholderSlug(slug) {
  if (!slug) return true;
  return slug === 'my-restaurant' || /^my-restaurant(-\d+)?$/.test(slug);
}

// ─── ONBOARDING ────────────────────────────────────────────────
router.post('/onboarding', requireAuth, express.json(), async (req, res) => {
  try {
    const {
      ownerName, phone, brandName, restaurantType, city,
      gstNumber, fssaiLicense,
    } = req.body;

    if (!ownerName || !phone || !brandName)
      return res.status(400).json({ error: 'Name, phone and restaurant name are required' });

    // Resolve store slug with this priority:
    //   1. Keep existing real slug (e.g., "beyond-snacks") — never break a live URL
    //   2. Regenerate if missing OR if previous slug was a "my-restaurant" placeholder
    //      that was auto-created by /auth/me before onboarding completed
    //   3. Fall back to a placeholder only if slugifyName(brandName) returns null
    //      (e.g., name was purely special characters)
    const existing = await col('restaurants').findOne(
      { _id: req.restaurantId },
      { projection: { store_slug: 1, brand_name: 1 } }
    );
    let storeSlug = existing?.store_slug;
    if (!storeSlug || isPlaceholderSlug(storeSlug)) {
      const fresh = await generateUniqueSlug(brandName, req.restaurantId);
      if (fresh) storeSlug = fresh;
      else if (!storeSlug) storeSlug = 'my-restaurant'; // last-resort fallback
    }
    const storeUrl = `${process.env.BASE_URL}/store/${storeSlug}`;

    const $set = {
      owner_name: ownerName, phone, business_name: brandName, brand_name: brandName,
      restaurant_type: restaurantType || 'both', city: city || null,
      store_slug: storeSlug, store_url: storeUrl,
      approval_status: 'pending', onboarding_step: 2, updated_at: new Date(),
    };
    if (gstNumber) $set.gst_number = gstNumber;
    if (fssaiLicense) $set.fssai_license = fssaiLicense;

    await col('restaurants').updateOne({ _id: req.restaurantId }, { $set });
    res.json({ submitted: true, storeUrl });
  } catch (err) {
    req.log.error({ err }, 'Onboarding failed');
    res.status(500).json({ error: 'Failed to save details' });
  }
});

/* ═══ FUTURE FEATURE: Onboarding Document Upload (GST + FSSAI) ═══
   Accepts: gst_doc (file), fssai_doc (file), gst_number (text), fssai_license (text), fssai_expiry (text)
   NOTE: Originally used MongoDB GridFS for file storage. When re-enabling, rewrite to use S3 (see imageUpload.js).
   Requires: multer (add back: const multer = require('multer')), S3 upload service.

   const docUpload = multer({
     storage: multer.memoryStorage(),
     limits : { fileSize: 10 * 1024 * 1024 },
     fileFilter(req, file, cb) {
       const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
       cb(allowed.includes(file.mimetype) ? null : new Error('Only JPEG, PNG, WebP or PDF files are allowed'), allowed.includes(file.mimetype));
     },
   });

   router.post('/onboarding/documents',
     requireAuth,
     docUpload.fields([
       { name: 'gst_doc', maxCount: 1 },
       { name: 'fssai_doc', maxCount: 1 },
     ]),
     async (req, res) => {
       try {
         const { gst_number, fssai_license, fssai_expiry } = req.body;

         if (!gst_number || !fssai_license) {
           return res.status(400).json({ error: 'GST number and FSSAI license number are required' });
         }
         if (!req.files?.gst_doc?.[0] || !req.files?.fssai_doc?.[0]) {
           return res.status(400).json({ error: 'Both GST and FSSAI document uploads are required' });
         }

         // Validate GST format: 15 chars alphanumeric
         const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
         if (!gstRegex.test(gst_number.toUpperCase())) {
           return res.status(400).json({ error: 'Invalid GST number format' });
         }

         // Validate FSSAI: 14 digits
         const fssaiRegex = /^[0-9]{14}$/;
         if (!fssaiRegex.test(fssai_license)) {
           return res.status(400).json({ error: 'FSSAI license must be a 14-digit number' });
         }

         // TODO: Replace GridFS with S3 upload (use imgSvc.uploadImage or similar)
         // const uploadToS3 = async (file, docType) => { ... };

         // const [gstDocUrl, fssaiDocUrl] = await Promise.all([
         //   uploadToS3(req.files.gst_doc[0], 'gst'),
         //   uploadToS3(req.files.fssai_doc[0], 'fssai'),
         // ]);

         const now = new Date();
         await col('restaurants').updateOne(
           { _id: req.restaurantId },
           {
             $set: {
               gst_number: gst_number.toUpperCase(),
               gst_doc_url: gstDocUrl,
               gst_verified: false,
               fssai_license: fssai_license,
               fssai_doc_url: fssaiDocUrl,
               fssai_expiry: fssai_expiry ? new Date(fssai_expiry) : null,
               fssai_verified: false,
               documents_submitted_at: now,
               updated_at: now,
             },
           }
         );

         res.json({ ok: true, gst_doc_url: gstDocUrl, fssai_doc_url: fssaiDocUrl });
       } catch (err) {
         console.error('[Onboarding/Documents]', err.message);
         res.status(500).json({ error: 'Document upload failed: ' + err.message });
       }
     }
   );
   ═══ END FUTURE FEATURE ═══ */

// ─── GET CURRENT USER ─────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  let restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
  if (!restaurant) return res.status(404).json({ error: 'Not found' });

  // ── STORE URL RESOLUTION ────────────────────────────────────
  // Three cases:
  //   (a) restaurant has a real brand name AND no slug → generate from name
  //   (b) restaurant has a "my-restaurant" placeholder slug AND now has a real
  //       brand name → heal it to the real slug (safe because the placeholder
  //       was never useful in Meta and no public traffic relies on it)
  //   (c) restaurant has no brand name yet → DO NOTHING. Returning a real
  //       slug-less response lets the frontend show a live preview computed
  //       from the brand-name input, instead of locking in "my-restaurant"
  //       before the user has typed anything.
  const realName = restaurant.brand_name || restaurant.business_name;
  const baseUrl = process.env.BASE_URL || '';
  if (realName && (!restaurant.store_slug || isPlaceholderSlug(restaurant.store_slug))) {
    const fresh = await generateUniqueSlug(realName, req.restaurantId);
    if (fresh) {
      const storeUrl = `${baseUrl}/store/${fresh}`;
      await col('restaurants').updateOne(
        { _id: req.restaurantId },
        { $set: { store_slug: fresh, store_url: storeUrl } }
      );
      restaurant = { ...restaurant, store_slug: fresh, store_url: storeUrl };
    }
  }

  const waAccounts = await col('whatsapp_accounts').find({ restaurant_id: req.restaurantId }).toArray();
  const waba_accounts = waAccounts.map(w => ({ waba_id: w.waba_id, name: w.display_name, phone: w.phone_display }));

  const { meta_access_token, password_hash, ...safe } = restaurant;
  // Derive whatsapp_connected from actual data if not explicitly set
  const whatsapp_connected = !!(restaurant.whatsapp_connected || restaurant.meta_user_id || waba_accounts.length > 0);
  // store_base_url lets the frontend build a preview that exactly matches the
  // canonical host the backend will save to (vs. location.origin which can
  // differ on Vercel preview deployments).
  res.json({ ...safe, id: String(restaurant._id), waba_accounts, whatsapp_connected, store_base_url: baseUrl });
});

// ─── WABA ACCOUNTS HELPER ─────────────────────────────────────
// ─── META TOKEN GRANULAR SCOPE EXTRACTION ────────────────────
// When the user completes Meta Embedded Signup with a config_id, the
// resulting access token has GRANULAR scopes — meaning it can ONLY access
// the specific WABA(s) the user picked in the signup wizard. We use this
// to scope the discovery loop so we never save WABAs the user didn't
// explicitly choose (e.g., the platform's own WABAs that the user might
// happen to have access to as a colleague on the platform's BM).
//
// Returns: Set of WABA IDs the token has explicit access to, or null if
// the token doesn't have granular scopes (older Meta config / fallback path).
async function _fetchGranularScopeWabaIds(token) {
  if (!token) return null;
  try {
    const res = await axios.get(`${META_GRAPH_URL}/debug_token`, {
      params: { input_token: token, access_token: token },
      timeout: 10000,
    });
    const granular = res.data?.data?.granular_scopes;
    if (!Array.isArray(granular) || !granular.length) {
      log.warn('debug_token returned no granular_scopes — falling back to discovery (broader)');
      return null;
    }
    // Pull WABA target_ids from any whatsapp_business_* scope
    const wabaIds = new Set();
    for (const g of granular) {
      const isWhatsapp = typeof g.scope === 'string' && g.scope.startsWith('whatsapp_business_');
      if (!isWhatsapp) continue;
      for (const id of (g.target_ids || [])) wabaIds.add(String(id));
    }
    log.info({ wabaCount: wabaIds.size, wabaIds: [...wabaIds].map(s => s.slice(0, 8)) }, 'Granular scope WABA target_ids');
    return wabaIds;
  } catch (e) {
    log.warn({ err: e?.response?.data || e?.message }, 'Failed to fetch granular_scopes — falling back to discovery');
    return null;
  }
}

// Returns true if a phone_number_id is registered as a platform admin/directory
// number (NOT a restaurant number). Used to refuse cross-tenant binding of
// platform-owned phone numbers to restaurant accounts.
async function _isPlatformAdminPhoneNumber(phoneNumberId) {
  if (!phoneNumberId) return false;
  try {
    const row = await col('admin_numbers').findOne({ phone_number_id: phoneNumberId });
    return !!row;
  } catch (_) { return false; }
}

async function _saveWabaAccounts(restaurantId, wabaData, longToken, sessionInfo = null, allowedWabaIds = null) {
  log.info({
    businessCount: wabaData.length,
    sessionInfo: sessionInfo || {},
    granularWabaCount: allowedWabaIds ? allowedWabaIds.size : 'none'
  }, 'Saving WABA accounts');

  // ─── WABA CHANGE DETECTION ────────────────────────────────────
  // [CHANGE-WABA] Read the existing linked phone BEFORE any new rows are
  // saved. We use this at the END of this function to:
  //   1. Deactivate every other active row for this restaurant (one-WABA rule)
  //   2. Disconnect the catalog from each deactivated phone at Meta
  //   3. Invalidate the webhook routing cache for each deactivated phone
  //
  // We capture this up front so the deactivation step can compute "rows that
  // are not the new one" using the post-save state, while still knowing
  // whether this is a fresh connect (oldPhoneId === null) or a change
  // (oldPhoneId is set and !== newPhoneId).
  let priorLinkedPhoneId = null;
  try {
    const priorRest = await col('restaurants').findOne(
      { _id: restaurantId },
      { projection: { linked_phone_number_id: 1 } }
    );
    priorLinkedPhoneId = priorRest?.linked_phone_number_id || null;
  } catch (_) { /* non-fatal — treat as fresh connect */ }

  // Helper: write a single (waba, phone) pair into whatsapp_accounts under
  // the calling restaurant_id, with all the safety checks centralized.
  // Returns true on success, false if skipped/refused.
  const savePhone = async (waba, phone) => {
    // 1. Granular scope filter — if the token has explicit scope, the WABA
    //    must be in the allowed set, otherwise the user did NOT select it.
    if (allowedWabaIds && allowedWabaIds.size > 0 && !allowedWabaIds.has(String(waba.id))) {
      log.warn({ wabaId: waba.id, restaurantId }, 'Skipping WABA: not in granular_scopes target_ids');
      return false;
    }

    // 2. Platform admin/directory blocklist — never assign a phone number
    //    that is registered as a platform admin/directory number.
    if (await _isPlatformAdminPhoneNumber(phone.id)) {
      log.error({ phoneId: phone.id, wabaId: waba.id, restaurantId }, 'CRITICAL: Refusing to bind platform admin phone_number_id to restaurant');
      logActivity({
        actorType: 'system',
        action: 'restaurant.waba_bind_blocked',
        category: 'auth',
        description: `Refused to bind platform admin phone ${phone.id} to restaurant ${restaurantId}`,
        restaurantId,
        resourceType: 'whatsapp_account',
        resourceId: phone.id,
        severity: 'critical',
      });
      return false;
    }

    // 3. Cross-tenant collision check — if this phone_number_id is already
    //    linked to a DIFFERENT restaurant, refuse to overwrite. (Composite
    //    upsert filter below ALSO prevents this; the check here logs the
    //    attempt loudly so we notice.)
    const existing = await col('whatsapp_accounts').findOne({ phone_number_id: phone.id });
    if (existing && existing.restaurant_id && existing.restaurant_id !== restaurantId) {
      log.error({
        phoneId: phone.id,
        wabaId: waba.id,
        existingRestaurantId: existing.restaurant_id,
        attemptedRestaurantId: restaurantId,
      }, 'CRITICAL: phone_number_id already linked to a different restaurant — refusing to reassign');
      logActivity({
        actorType: 'system',
        action: 'restaurant.waba_bind_collision',
        category: 'auth',
        description: `phone_number_id ${phone.id} is already linked to a different restaurant`,
        restaurantId,
        resourceType: 'whatsapp_account',
        resourceId: phone.id,
        severity: 'critical',
      });
      return false;
    }

    // 4. Composite upsert filter — phone_number_id AND restaurant_id. This
    //    means cross-tenant reassignment is structurally impossible: if the
    //    phone is unowned the upsert inserts under this restaurant; if it's
    //    already owned by THIS restaurant the existing row is updated; if
    //    it's owned by a DIFFERENT restaurant the upsert filter never
    //    matches and would try to insert a duplicate (caught by step 3).
    await col('whatsapp_accounts').updateOne(
      { phone_number_id: phone.id, restaurant_id: restaurantId },
      {
        $set: {
          restaurant_id : restaurantId,
          waba_id       : waba.id,
          phone_display : phone.display_phone_number,
          display_name  : phone.verified_name,
          quality_rating: phone.quality_rating?.display_value || phone.quality_rating || 'GREEN',
          access_token  : longToken,
          is_active     : true,
          // Tag rows so the Settings read path can exclude any future
          // platform/admin/directory rows that might be added under the
          // same collection.
          account_type  : 'restaurant',
          updated_at    : new Date(),
        },
        $setOnInsert: { _id: newId(), created_at: new Date() },
      },
      { upsert: true }
    );
    log.info({ phoneId: phone.id, phoneDisplay: phone.display_phone_number?.slice(-4), restaurantId }, 'Saved phone');
    _registerPhoneNumber(phone.id, longToken).catch(err =>
      log.error({ err, phoneId: phone.id }, 'Phone registration failed')
    );
    return true;
  };

  let savedCount = 0;
  // Track the FIRST successfully saved (waba, phone) pair so we can record
  // it as the restaurant's explicit linked connection. The Settings read
  // path uses linked_phone_number_id / linked_waba_id as the source of
  // truth for "which WABA is this restaurant's primary?".
  let firstSavedWabaId = null;
  let firstSavedPhoneId = null;

  for (const biz of wabaData) {
    const wabas = biz.whatsapp_business_accounts?.data || [];
    log.info({ businessId: biz.id, wabaCount: wabas.length }, 'Processing business WABAs');
    for (const waba of wabas) {
      // Skip the WABA entirely if it's not in the granular scopes.
      if (allowedWabaIds && allowedWabaIds.size > 0 && !allowedWabaIds.has(String(waba.id))) {
        log.info({ wabaId: waba.id }, 'Skipping WABA (not in granular_scopes)');
        continue;
      }
      await _subscribeWaba(waba.id);

      const phones = waba.phone_numbers?.data || [];
      log.info({ wabaId: waba.id, phoneCount: phones.length }, 'Processing WABA phone numbers');
      for (const phone of phones) {
        const ok = await savePhone(waba, phone);
        if (ok) {
          savedCount++;
          if (!firstSavedWabaId) {
            firstSavedWabaId = waba.id;
            firstSavedPhoneId = phone.id;
          }
        }
      }

      logActivity({ actorType: 'system', action: 'restaurant.waba_provisioned', category: 'auth', description: `WABA ${waba.id} provisioned for restaurant ${restaurantId}`, restaurantId, resourceType: 'whatsapp_account', resourceId: waba.id, severity: 'info' });
      _provisionWabaCatalog(restaurantId, waba.id, longToken).catch(err =>
        log.error({ err, wabaId: waba.id }, 'Catalog auto-provision failed')
      );
    }
  }

  // Fallback: if the businesses API returned nothing but embedded signup gave us a waba_id,
  // query that WABA's phone numbers directly — embedded signup tokens are scoped to the WABA
  if (!savedCount && sessionInfo?.waba_id) {
    log.info({ wabaId: sessionInfo.waba_id }, 'Falling back to direct WABA query');
    try {
      const phoneRes = await axios.get(`${META_GRAPH_URL}/${sessionInfo.waba_id}/phone_numbers`, {
        params: { fields: 'id,display_phone_number,verified_name,quality_rating', access_token: longToken },
        timeout: 10000,
      });
      const phones = phoneRes.data?.data || [];

      // If WABA has no registered phone numbers yet but we know the phone_number_id from sessionInfo,
      // create a placeholder record so the UI shows "Connected"
      if (!phones.length && sessionInfo.phone_number_id) {
        phones.push({ id: sessionInfo.phone_number_id, display_phone_number: '—', verified_name: 'WhatsApp Business', quality_rating: null });
      }

      await _subscribeWaba(sessionInfo.waba_id);

      for (const phone of phones) {
        const ok = await savePhone({ id: sessionInfo.waba_id }, phone);
        if (ok) {
          savedCount++;
          if (!firstSavedWabaId) {
            firstSavedWabaId = sessionInfo.waba_id;
            firstSavedPhoneId = phone.id;
          }
        }
      }

      _provisionWabaCatalog(restaurantId, sessionInfo.waba_id, longToken).catch(err =>
        log.error({ err, wabaId: sessionInfo.waba_id }, 'Catalog auto-provision failed')
      );
    } catch (e) {
      log.warn({ err: e }, 'Direct WABA fallback failed');
    }
  }

  // Record the explicit linkage on the restaurant doc. Settings read path
  // uses these as the source of truth for "which WABA is the primary?".
  if (firstSavedWabaId && firstSavedPhoneId) {
    await col('restaurants').updateOne(
      { _id: restaurantId },
      {
        $set: {
          linked_waba_id: firstSavedWabaId,
          linked_phone_number_id: firstSavedPhoneId,
          linked_at: new Date(),
          updated_at: new Date(),
          whatsapp_connected: true,
        },
        // [DISCONNECT-FIX] Clear the disconnected_at timestamp on reconnect
        // so the restaurant doc reflects the current connected state
        // accurately. Without this, a reconnect after a disconnect would
        // leave a stale disconnected_at field that could mislead UI / audit
        // queries.
        $unset: { disconnected_at: '' },
      }
    ).catch(err => log.error({ err, restaurantId }, 'Failed to record linked WABA on restaurant doc'));

    // ─── [CHANGE-WABA] DEACTIVATE OLD ROWS + RECONNECT CATALOG ──
    // After the new row is saved and the linkage is recorded, ensure the
    // strict one-WABA-per-restaurant invariant by deactivating every OTHER
    // active row for this restaurant. This is the surgical "change account"
    // step that converts a connect-to-additional flow into a true REPLACE.
    //
    // The condition that triggers reconnect-catalog work is:
    //   priorLinkedPhoneId && priorLinkedPhoneId !== firstSavedPhoneId
    // i.e. there was previously a linked phone AND it differs from the new one.
    //
    // For fresh connects (priorLinkedPhoneId === null) the deactivation
    // pass is still safe — it filters by `phone_number_id !== firstSavedPhoneId`
    // so a fresh connect is a no-op.
    try {
      // 1. Find every OTHER active row for this restaurant
      const oldRows = await col('whatsapp_accounts').find({
        restaurant_id: restaurantId,
        is_active: true,
        phone_number_id: { $ne: firstSavedPhoneId },
        $or: [{ account_type: 'restaurant' }, { account_type: { $exists: false } }],
      }).toArray();

      if (oldRows.length) {
        log.info({
          restaurantId,
          oldPhoneIds: oldRows.map(r => r.phone_number_id),
          newPhoneId: firstSavedPhoneId,
          isChange: priorLinkedPhoneId && priorLinkedPhoneId !== firstSavedPhoneId,
        }, '[CHANGE-WABA] Deactivating old WABA rows');

        // 2. Disconnect catalog from each old phone at Meta. We do this
        //    BEFORE deactivating the row so the row still has the
        //    phone_number_id available for the API call. Errors are
        //    swallowed by _disconnectCatalogFromPhone — onboarding cannot
        //    fail because of a stale catalog binding on a phone we no
        //    longer own.
        for (const old of oldRows) {
          if (old.phone_number_id) {
            await _disconnectCatalogFromPhone(old.phone_number_id);
          }
        }

        // 3. Deactivate the rows in our DB. Tokens are preserved (we use
        //    $set with is_active: false, not deleteOne) so the user could
        //    reconnect to the same number later without re-running the
        //    full OAuth flow.
        await col('whatsapp_accounts').updateMany(
          {
            restaurant_id: restaurantId,
            is_active: true,
            phone_number_id: { $ne: firstSavedPhoneId },
            $or: [{ account_type: 'restaurant' }, { account_type: { $exists: false } }],
          },
          {
            $set: {
              is_active: false,
              disconnected_at: new Date(),
              disconnect_reason: 'replaced_by_change_account',
              updated_at: new Date(),
            },
          }
        );

        // 4. Invalidate the webhook-routing cache for each deactivated
        //    phone. CRITICAL: without this, getWaAccount() in
        //    cachedLookup.js would return the stale `is_active: true` row
        //    for up to 5 minutes, and the webhook handler would keep
        //    routing messages to the old WABA after the change.
        for (const old of oldRows) {
          if (old.phone_number_id) {
            memcache.del(`wa_account:${old.phone_number_id}`);
          }
        }

        // 5. Audit log so support can trace WABA changes after the fact.
        logActivity({
          actorType: 'system',
          action: 'restaurant.waba_replaced',
          category: 'auth',
          description: `WABA changed: deactivated ${oldRows.length} previous WABA row(s)`,
          restaurantId,
          resourceType: 'whatsapp_account',
          resourceId: firstSavedPhoneId,
          severity: 'info',
          metadata: {
            new_phone_number_id: firstSavedPhoneId,
            new_waba_id: firstSavedWabaId,
            previous_phone_number_id: priorLinkedPhoneId,
            deactivated_phone_number_ids: oldRows.map(r => r.phone_number_id).filter(Boolean),
            deactivated_count: oldRows.length,
          },
        });
      } else if (priorLinkedPhoneId === firstSavedPhoneId) {
        log.info({ restaurantId, phoneId: firstSavedPhoneId }, '[CHANGE-WABA] Same phone — no deactivation needed (reconnect to same number)');
      } else {
        log.info({ restaurantId, phoneId: firstSavedPhoneId }, '[CHANGE-WABA] Fresh connect — no old rows to deactivate');
      }

      // 6. Reconnect the catalog to the NEW phone. We read the catalog
      //    that was just provisioned for the NEW WABA via
      //    _provisionWabaCatalog (which fired earlier in this function).
      //    If a catalog exists, enable commerce settings on the new phone
      //    so cart icon + visibility are turned on.
      const newRow = await col('whatsapp_accounts').findOne({
        phone_number_id: firstSavedPhoneId,
        restaurant_id: restaurantId,
      });
      if (newRow?.catalog_id) {
        await _enableCommerceSettings(firstSavedPhoneId, newRow.catalog_id, longToken);
      } else {
        // The catalog may not be provisioned yet on the new WABA — this is
        // common for fresh WABAs that have no catalog assets. The async
        // _provisionWabaCatalog call (fired earlier) will eventually create
        // one and call _enableCommerceSettings itself. We log so support
        // knows the catalog reconnect was deferred to the async path.
        log.info({ restaurantId, newPhoneId: firstSavedPhoneId }, '[CHANGE-WABA] No catalog yet on new WABA — catalog enablement deferred to async _provisionWabaCatalog');
      }
    } catch (changeErr) {
      // The change-WABA cleanup is best-effort. If it fails, the new row
      // is still saved correctly and the restaurant linkage is updated —
      // we just log the error and continue. A subsequent reconnect or
      // manual support intervention can clean up any drift.
      log.error({ err: changeErr, restaurantId, newPhoneId: firstSavedPhoneId }, '[CHANGE-WABA] Cleanup of old WABA rows failed (non-fatal)');
    }
  }

  if (savedCount === 0) {
    log.warn({
      restaurantId,
      businessCount: wabaData.length,
      sessionWabaId: sessionInfo?.waba_id || 'none',
      granularWabaCount: allowedWabaIds ? allowedWabaIds.size : 'none',
    }, 'Zero whatsapp_accounts saved — whatsapp_connected flag is still set');
  } else {
    log.info({ restaurantId, savedCount, firstSavedWabaId, firstSavedPhoneId }, 'WABA accounts saved');
  }
}

// ─── SUBSCRIBE WABA TO WEBHOOKS ───────────────────────────────
async function _subscribeWaba(wabaId) {
  const sysToken = metaConfig.systemUserToken;
  if (!sysToken) {
    log.warn({ wabaId }, 'System user token not set — skipping subscription');
    return;
  }
  try {
    await axios.post(`${META_GRAPH_URL}/${wabaId}/subscribed_apps`, {}, {
      params: { access_token: sysToken },
    });
    log.info({ wabaId }, 'Subscribed WABA to app webhooks');
  } catch (err) {
    log.error({ err, wabaId, responseData: err.response?.data }, 'Failed to subscribe WABA');
  }
}

// ─── REGISTER PHONE NUMBER WITH CLOUD API ────────────────────
// Resolves "Connecting phone number to [App]" in WhatsApp Business Manager.
// Must be called once per phone number after Embedded Signup.
async function _registerPhoneNumber(phoneNumberId, _accessToken) {
  const sysToken = metaConfig.systemUserToken || _accessToken;
  if (!sysToken) { log.warn('System user token not configured, skipping registration'); return; }
  try {
    await axios.post(
      `${META_GRAPH_URL}/${phoneNumberId}/register`,
      { messaging_product: 'whatsapp', pin: '000000' },
      {
        headers: { Authorization: `Bearer ${sysToken}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );
    await col('whatsapp_accounts').updateOne(
      { phone_number_id: phoneNumberId },
      { $set: { phone_registered: true, updated_at: new Date() } }
    );
    log.info({ phoneNumberId }, 'Phone registered with Cloud API');
  } catch (err) {
    const apiErr = err.response?.data?.error;
    // Code 80007 = already registered — treat as success
    if (apiErr?.code === 80007 || apiErr?.error_subcode === 2388053) {
      await col('whatsapp_accounts').updateOne(
        { phone_number_id: phoneNumberId },
        { $set: { phone_registered: true, updated_at: new Date() } }
      );
      log.info({ phoneNumberId }, 'Phone was already registered');
      return;
    }
    log.error({ err, phoneNumberId }, 'Phone registration failed');
    throw err;
  }
}

// ─── AUTO-PROVISION CATALOG PER WABA ─────────────────────────
// Creates one Meta catalog per WABA (if missing), links it to the WABA,
// enables the cart icon on every phone number, and propagates to branches.
async function _provisionWabaCatalog(restaurantId, wabaId, _accessToken) {
  const catToken = metaConfig.catalogToken || _accessToken;
  if (!catToken) { log.warn('No catalog token available, skipping'); return; }

  // Check if any account for this WABA already has a catalog_id
  const existingAcc = await col('whatsapp_accounts').findOne(
    { waba_id: wabaId, catalog_id: { $exists: true, $ne: null } }
  );

  let catalogId = existingAcc?.catalog_id;

  if (!catalogId) {
    const restaurant = await col('restaurants').findOne({ _id: restaurantId });
    if (!restaurant) return;

    // Try fetching catalogs already linked to this WABA
    try {
      const wabaRes = await axios.get(`${META_GRAPH_URL}/${wabaId}/product_catalogs`, {
        params: { access_token: catToken, fields: 'id,name' },
        timeout: 10000,
      });
      const existing = wabaRes.data?.data || [];
      if (existing.length) {
        catalogId = existing[0].id;
        log.info({ catalogId, wabaId }, 'Found existing WABA catalog');
      }
    } catch (e) {
      log.warn({ err: e, wabaId }, 'Could not fetch WABA catalogs');
    }

    if (!catalogId) {
      // Get the Meta Business ID — prefer env var, fallback to API query
      let businessId = metaConfig.businessId;
      if (!businessId) {
        try {
          log.info('META_BUSINESS_ID not set — querying /me/businesses');
          const meRes = await axios.get(`${META_GRAPH_URL}/me/businesses`, {
            params: { access_token: catToken, fields: 'id,name' },
            timeout: 10000,
          });
          const businesses = meRes.data?.data || [];
          if (!businesses.length) throw new Error('No Meta Business account found. Set META_BUSINESS_ID in environment variables.');
          businessId = businesses[0].id;
          log.info({ businessId }, 'Discovered business ID');
        } catch (err) {
          throw new Error(`Could not fetch business account: ${err.response?.data?.error?.message || err.message}`);
        }
      }

      // Check if business already owns any catalogs before trying to create one
      try {
        const bizCatRes = await axios.get(`${META_GRAPH_URL}/${businessId}/owned_product_catalogs`, {
          params: { access_token: catToken, fields: 'id,name' },
          timeout: 10000,
        });
        const bizCatalogs = bizCatRes.data?.data || [];
        if (bizCatalogs.length) {
          catalogId = bizCatalogs[0].id;
          log.info({ catalogId, wabaId }, 'Found existing business catalog — inheriting');
        }
      } catch (e) {
        log.warn({ err: e }, 'Could not read business catalogs');
      }

      if (!catalogId) {
        // Create one catalog for this WABA named after the restaurant
        const catalogName = restaurant.brand_name || restaurant.business_name || 'GullyBite Menu';
        try {
          const createRes = await axios.post(
            `${META_GRAPH_URL}/${businessId}/owned_product_catalogs`,
            { name: catalogName, vertical: 'commerce' },
            { headers: { Authorization: `Bearer ${catToken}`, 'Content-Type': 'application/json' }, timeout: 15000 }
          );
          catalogId = createRes.data.id;
          log.info({ catalogName, catalogId, wabaId }, 'Created catalog');
          logActivity({ actorType: 'system', action: 'restaurant.catalog_created', category: 'catalog', description: `Catalog "${catalogName}" created during onboarding for WABA ${wabaId}`, restaurantId, resourceType: 'catalog', resourceId: catalogId, severity: 'info' });
        } catch (err) {
          throw new Error(`Catalog creation failed: ${err.response?.data?.error?.message || err.message}`);
        }
      }
    }

    // Link catalog to WABA (makes it appear in WhatsApp Business Manager)
    try {
      await axios.post(
        `${META_GRAPH_URL}/${wabaId}/product_catalogs`,
        { catalog_id: catalogId },
        { headers: { Authorization: `Bearer ${catToken}`, 'Content-Type': 'application/json' }, timeout: 10000 }
      );
      log.info({ catalogId, wabaId }, 'Linked catalog to WABA');
    } catch (err) {
      log.warn({ err, catalogId, wabaId }, 'Could not link catalog to WABA');
    }

    // Save catalog_id on all whatsapp_accounts for this WABA
    await col('whatsapp_accounts').updateMany(
      { waba_id: wabaId },
      { $set: { catalog_id: catalogId, updated_at: new Date() } }
    );
  }

  // Store catalog info on the restaurant document for dashboard display
  if (catalogId) {
    await col('restaurants').updateOne(
      { _id: restaurantId },
      { $set: { meta_catalog_id: catalogId, catalog_fetched_at: new Date() } }
    );
  }

  // Enable cart icon + catalog visibility on every phone number under this WABA
  const sysToken = metaConfig.systemUserToken || catToken;
  const phones = await col('whatsapp_accounts').find({ waba_id: wabaId }).toArray();
  for (const phone of phones) {
    await _enableCommerceSettings(phone.phone_number_id, catalogId, sysToken);
  }

  // Propagate catalog_id to existing branches that don't have one
  await _linkCatalogToBranches(restaurantId, catalogId);
}

// ─── ENABLE CART ICON ON A PHONE NUMBER ──────────────────────
// Calls POST /{phone_number_id}/whatsapp_commerce_settings to show
// the catalog/cart icon inside WhatsApp chats for that number.
async function _enableCommerceSettings(phoneNumberId, catalogId, _accessToken) {
  const sysToken = metaConfig.systemUserToken || _accessToken;
  if (!sysToken) { log.warn('System user token not configured, skipping commerce settings'); return; }
  try {
    await axios.post(
      `${META_GRAPH_URL}/${phoneNumberId}/whatsapp_commerce_settings`,
      {
        is_catalog_visible: true,
        is_cart_enabled   : true,
      },
      {
        headers: { Authorization: `Bearer ${sysToken}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );
    // Mark commerce as enabled in DB
    await col('whatsapp_accounts').updateOne(
      { phone_number_id: phoneNumberId },
      { $set: { cart_enabled: true, catalog_id: catalogId, updated_at: new Date() } }
    );
    log.info({ phoneNumberId }, 'Cart + catalog icon enabled on phone');
  } catch (err) {
    log.error({ err, phoneNumberId }, 'Failed to enable cart on phone');
  }
}

// ─── DISCONNECT CATALOG FROM A PHONE NUMBER ────────────────────
// Hides the catalog cart icon and disables visibility on a specific phone
// number. Used during a WABA change to release the OLD phone before binding
// the catalog to the NEW phone.
//
// Safe to call when:
//   • the phone has no catalog linked (Meta returns 200 — idempotent on Meta's side)
//   • the phone no longer exists at Meta (we catch and log the error)
//   • the catalog was deleted externally (same — caught + logged)
//
// NEVER throws — errors are logged but onboarding must not fail because of
// a stale catalog binding on a phone the user no longer owns.
async function _disconnectCatalogFromPhone(phoneNumberId) {
  const sysToken = metaConfig.systemUserToken;
  if (!phoneNumberId || !sysToken) return;
  try {
    await axios.post(
      `${META_GRAPH_URL}/${phoneNumberId}/whatsapp_commerce_settings`,
      {
        is_catalog_visible: false,
        is_cart_enabled   : false,
      },
      {
        headers: { Authorization: `Bearer ${sysToken}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );
    log.info({ phoneNumberId }, 'Catalog disconnected from old phone (commerce settings disabled at Meta)');
  } catch (err) {
    // Common cases that are NOT actual problems:
    //   • Phone no longer registered with our app (user removed it from Meta)
    //   • Phone never had commerce settings to disable
    // In all cases, we still mark the row inactive in our DB below — Meta's
    // side may be drifted but our side is the source of truth for routing.
    log.warn({
      err: err?.response?.data || err?.message,
      phoneNumberId,
    }, 'Could not disconnect catalog from old phone (non-fatal)');
  }
  // Always mirror the change in our DB regardless of the Meta API result.
  try {
    await col('whatsapp_accounts').updateOne(
      { phone_number_id: phoneNumberId },
      { $set: {
        catalog_linked: false,
        cart_enabled: false,
        catalog_visible: false,
        updated_at: new Date(),
      }}
    );
  } catch (_) { /* non-fatal */ }
}

// ─── LINK CATALOG TO BRANCHES ────────────────────────────────
// Sets catalog_id on branches that don't have one yet.
async function _linkCatalogToBranches(restaurantId, catalogId) {
  const result = await col('branches').updateMany(
    { restaurant_id: restaurantId, catalog_id: { $in: [null, undefined, ''] } },
    { $set: { catalog_id: catalogId, updated_at: new Date() } }
  );
  if (result.modifiedCount > 0) {
    log.info({ catalogId, branchCount: result.modifiedCount }, 'Linked catalog to branches');
  }
}

// ─── ROLE PERMISSION TEMPLATES ───────────────────────────────
const ROLE_PERMISSIONS = {
  owner:    { view_orders:true, manage_orders:true, view_menu:true, manage_menu:true, view_analytics:true, manage_settings:true, manage_coupons:true, manage_users:true, view_payments:true },
  manager:  { view_orders:true, manage_orders:true, view_menu:true, manage_menu:true, view_analytics:true, manage_settings:false, manage_coupons:true, manage_users:false, view_payments:true },
  kitchen:  { view_orders:true, manage_orders:true, view_menu:true, manage_menu:false, view_analytics:false, manage_settings:false, manage_coupons:false, manage_users:false, view_payments:false },
  delivery: { view_orders:true, manage_orders:true, view_menu:false, manage_menu:false, view_analytics:false, manage_settings:false, manage_coupons:false, manage_users:false, view_payments:false },
};

// ─── AUTO-CREATE OWNER USER ──────────────────────────────────
async function ensureOwnerUser(restaurantId, ownerName, phone) {
  const existing = await col('restaurant_users').findOne({ restaurant_id: restaurantId, role: 'owner' });
  if (existing) return existing;
  const doc = {
    _id: newId(),
    restaurant_id: restaurantId,
    name: ownerName || 'Owner',
    phone: phone || '',
    email: null,
    pin_hash: null,
    role: 'owner',
    branch_ids: [],
    permissions: { ...ROLE_PERMISSIONS.owner },
    is_active: true,
    last_login_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
  };
  await col('restaurant_users').insertOne(doc);
  return doc;
}

// ─── PIN LOGIN ───────────────────────────────────────────────
router.post('/pin-login', express.json(), async (req, res) => {
  try {
    const { restaurantId, phone, pin } = req.body;
    if (!restaurantId || !phone || !pin)
      return res.status(400).json({ error: 'Restaurant ID, phone and PIN are required' });

    const user = await col('restaurant_users').findOne({
      restaurant_id: restaurantId,
      phone,
      is_active: true,
    });
    if (!user) return res.status(401).json({ error: 'No account found with this phone number' });
    if (!user.pin_hash) return res.status(401).json({ error: 'PIN not set. Ask the owner to set your PIN.' });

    const valid = await bcrypt.compare(pin, user.pin_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect PIN' });

    await col('restaurant_users').updateOne({ _id: user._id }, { $set: { last_login_at: new Date() } });

    const token = jwt.sign({
      restaurantId,
      userId: String(user._id),
      role: user.role,
      permissions: user.permissions,
      branchIds: user.branch_ids,
    }, process.env.JWT_SECRET, { expiresIn: '12h' });

    res.json({
      token,
      user: { id: String(user._id), name: user.name, role: user.role, permissions: user.permissions, branchIds: user.branch_ids },
    });
  } catch (err) {
    req.log.error({ err }, 'PIN login failed');
    res.status(500).json({ error: 'Login failed' });
  }
});

// ─── JWT AUTH MIDDLEWARE ──────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded    = jwt.verify(token, process.env.JWT_SECRET);
    req.restaurantId = decoded.restaurantId;
    req.metaUserId   = decoded.metaUserId;
    req.userId       = decoded.userId || null;
    req.userRole     = decoded.role || 'owner';
    req.userPermissions = decoded.permissions || ROLE_PERMISSIONS.owner;
    req.userBranchIds   = decoded.branchIds || [];
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

// ─── PERMISSION MIDDLEWARE ───────────────────────────────────
function requirePermission(permKey) {
  return (req, res, next) => {
    if (req.userRole === 'owner') return next(); // owner has all
    if (req.userPermissions?.[permKey]) return next();
    res.status(403).json({ error: `Permission denied: ${permKey}` });
  };
}

// ─── APPROVED-ONLY MIDDLEWARE ─────────────────────────────────
async function requireApproved(req, res, next) {
  try {
    const restaurant = await col('restaurants').findOne(
      { _id: req.restaurantId }, { projection: { approval_status: 1 } }
    );
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
    if (restaurant.approval_status !== 'approved') {
      return res.status(403).json({
        error: 'pending_approval',
        approval_status: restaurant.approval_status,
        message: 'Your application is under review. You will be notified once approved.',
      });
    }
    next();
  } catch (err) {
    log.error({ err }, 'requireApproved check failed');
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { router, requireAuth, requireApproved, requirePermission, ROLE_PERMISSIONS, ensureOwnerUser, _registerPhoneNumber, _provisionWabaCatalog, _enableCommerceSettings, _linkCatalogToBranches };
