// src/routes/auth.js
// Email/password + Meta OAuth authentication

const express = require('express');
const axios   = require('axios');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const router  = express.Router();
const { col, newId } = require('../config/database');

const META_GRAPH_URL = 'https://graph.facebook.com/v25.0';
const META_AUTH_URL  = 'https://www.facebook.com/v25.0/dialog/oauth';

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
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

    const passwordHash = await bcrypt.hash(password, 12);
    const id = newId();
    await col('restaurants').insertOne({
      _id: id, owner_name: ownerName.trim(), email: email.toLowerCase().trim(),
      password_hash: passwordHash, approval_status: 'pending', onboarding_step: 1,
      business_name: 'My Restaurant', status: 'active',
      created_at: new Date(), updated_at: new Date(),
    });
    const token = jwt.sign({ restaurantId: id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, needsOnboarding: true, onboardingStep: 1 });
  } catch (err) {
    console.error('[Signup]', err.message);
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
      return res.status(401).json({ error: 'This account was created via Meta. Use "Continue with Meta" below.' });

    const valid = await bcrypt.compare(password, restaurant.password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    const token = jwt.sign({ restaurantId: String(restaurant._id) }, process.env.JWT_SECRET, { expiresIn: '30d' });
    const step  = restaurant.onboarding_step || 1;
    res.json({
      token,
      approvalStatus : restaurant.approval_status || 'pending',
      onboardingStep : step,
      needsOnboarding: step < 5,
      hasMetaConnected: !!restaurant.meta_user_id,
    });
  } catch (err) {
    console.error('[Signin]', err.message);
    res.status(500).json({ error: 'Sign in failed' });
  }
});

// ─── CONNECT META / WHATSAPP ───────────────────────────────────
router.post('/connect-meta', requireAuth, express.json(), async (req, res) => {
  try {
    const { accessToken, code, sessionInfo } = req.body;
    if (!accessToken && !code) return res.status(400).json({ error: 'No token provided' });

    let longToken, expiresAt;
    if (code) {
      const tokenRes = await axios.get(`${META_GRAPH_URL}/oauth/access_token`, {
        params: { client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET,
                  redirect_uri: process.env.META_OAUTH_REDIRECT_URI, code },
      });
      longToken = tokenRes.data.access_token;
      expiresAt = tokenRes.data.expires_in ? new Date(Date.now() + tokenRes.data.expires_in * 1000) : null;
    } else {
      const longRes = await axios.get(`${META_GRAPH_URL}/oauth/access_token`, {
        params: { grant_type: 'fb_exchange_token', client_id: process.env.META_APP_ID,
                  client_secret: process.env.META_APP_SECRET, fb_exchange_token: accessToken },
      });
      longToken = longRes.data.access_token;
      expiresAt = longRes.data.expires_in ? new Date(Date.now() + longRes.data.expires_in * 1000) : null;
    }

    const userRes  = await axios.get(`${META_GRAPH_URL}/me`, { params: { fields: 'id,name,email', access_token: longToken } });
    const metaUser = userRes.data;

    let wabaData = [];
    try {
      const wabaRes = await axios.get(`${META_GRAPH_URL}/${metaUser.id}/businesses`, {
        params: { fields: 'id,name,whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name,quality_rating}}', access_token: longToken },
      });
      wabaData = wabaRes.data?.data || [];
    } catch (e) { console.warn('[connect-meta] Could not fetch WABAs:', e.message); }

    const $set = {
      meta_user_id: metaUser.id, meta_access_token: longToken, meta_token_expires_at: expiresAt,
      onboarding_step: 5, submitted_at: new Date(), approval_status: 'pending', updated_at: new Date(),
    };
    if (sessionInfo?.phone_number_id) $set.meta_phone_number_id = sessionInfo.phone_number_id;
    if (sessionInfo?.waba_id) $set.meta_waba_id = sessionInfo.waba_id;
    await col('restaurants').updateOne({ _id: req.restaurantId }, { $set });

    await _saveWabaAccounts(req.restaurantId, wabaData, longToken);
    res.json({ connected: true });
  } catch (err) {
    console.error('[connect-meta]', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to connect WhatsApp' });
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
    await col('restaurants').updateOne({ _id: req.restaurantId }, { $set: { password_hash: hash, updated_at: new Date() } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[change-password]', err.message);
    res.status(500).json({ error: 'Password update failed' });
  }
});

// ─── INITIATE META OAUTH ──────────────────────────────────────
router.get('/login', (req, res) => {
  const scopes = ['whatsapp_business_management', 'whatsapp_business_messaging', 'business_management'].join(',');
  const authUrl = `${META_AUTH_URL}?client_id=${process.env.META_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(process.env.META_OAUTH_REDIRECT_URI)}` +
    `&scope=${scopes}&response_type=code` +
    `&state=${Buffer.from(Date.now().toString()).toString('base64')}`;
  res.redirect(authUrl);
});

// ─── META OAUTH CALLBACK ──────────────────────────────────────
router.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect(`${process.env.BASE_URL}/?error=oauth_failed`);

  try {
    const tokenRes = await axios.get(`${META_GRAPH_URL}/oauth/access_token`, {
      params: { client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET,
                redirect_uri: process.env.META_OAUTH_REDIRECT_URI, code },
    });
    const longTokenRes = await axios.get(`${META_GRAPH_URL}/oauth/access_token`, {
      params: { grant_type: 'fb_exchange_token', client_id: process.env.META_APP_ID,
                client_secret: process.env.META_APP_SECRET, fb_exchange_token: tokenRes.data.access_token },
    });
    const longToken = longTokenRes.data.access_token;
    const expiresAt = longTokenRes.data.expires_in ? new Date(Date.now() + longTokenRes.data.expires_in * 1000) : null;

    const userRes  = await axios.get(`${META_GRAPH_URL}/me`, { params: { fields: 'id,name,email', access_token: longToken } });
    const metaUser = userRes.data;

    let wabaData = [];
    try {
      const wabaRes = await axios.get(`${META_GRAPH_URL}/${metaUser.id}/businesses`, {
        params: { fields: 'id,name,whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name,quality_rating}}', access_token: longToken },
      });
      wabaData = wabaRes.data?.data || [];
    } catch (e) { console.warn('[OAuth] Could not fetch WABAs:', e.message); }

    // Find by meta_user_id first, then by matching email (to link to existing email signup)
    let existing = await col('restaurants').findOne({ meta_user_id: metaUser.id });
    if (!existing && metaUser.email) {
      existing = await col('restaurants').findOne({ email: metaUser.email.toLowerCase() });
    }
    let restaurantId;
    if (existing) {
      await col('restaurants').updateOne({ _id: existing._id }, { $set: {
        meta_user_id: metaUser.id, meta_access_token: longToken, meta_token_expires_at: expiresAt,
        onboarding_step: Math.max(existing.onboarding_step || 1, 5),
        submitted_at: existing.submitted_at || new Date(), updated_at: new Date(),
      }});
      restaurantId = String(existing._id);
    } else {
      restaurantId = newId();
      await col('restaurants').insertOne({
        _id: restaurantId, meta_user_id: metaUser.id, meta_access_token: longToken,
        meta_token_expires_at: expiresAt, owner_name: metaUser.name, email: metaUser.email,
        business_name: 'My Restaurant', status: 'active', approval_status: 'pending',
        onboarding_step: 5, submitted_at: new Date(), created_at: new Date(), updated_at: new Date(),
      });
    }

    await _saveWabaAccounts(restaurantId, wabaData, longToken);
    const jwtToken = jwt.sign({ restaurantId, metaUserId: metaUser.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    // Pass token via URL fragment (not query string) to avoid it appearing in server logs
    res.redirect(`/?meta_token=${jwtToken}`);
  } catch (err) {
    console.error('[OAuth] Callback error:', err.response?.data || err.message);
    res.redirect('/?error=oauth_failed');
  }
});

// ─── FACEBOOK JS SDK LOGIN ─────────────────────────────────────
router.post('/facebook', express.json(), async (req, res) => {
  const { accessToken, code } = req.body;
  if (!accessToken && !code) return res.status(400).json({ error: 'No token provided' });

  try {
    let longToken, expiresAt;
    if (code) {
      const tokenRes = await axios.get(`${META_GRAPH_URL}/oauth/access_token`, {
        params: { client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET,
                  redirect_uri: process.env.META_OAUTH_REDIRECT_URI, code },
      });
      longToken = tokenRes.data.access_token;
      expiresAt = tokenRes.data.expires_in ? new Date(Date.now() + tokenRes.data.expires_in * 1000) : null;
    } else {
      const longTokenRes = await axios.get(`${META_GRAPH_URL}/oauth/access_token`, {
        params: { grant_type: 'fb_exchange_token', client_id: process.env.META_APP_ID,
                  client_secret: process.env.META_APP_SECRET, fb_exchange_token: accessToken },
      });
      longToken = longTokenRes.data.access_token;
      expiresAt = longTokenRes.data.expires_in ? new Date(Date.now() + longTokenRes.data.expires_in * 1000) : null;
    }

    const userRes  = await axios.get(`${META_GRAPH_URL}/me`, { params: { fields: 'id,name,email', access_token: longToken } });
    const metaUser = userRes.data;

    let wabaData = [];
    try {
      const wabaRes = await axios.get(`${META_GRAPH_URL}/${metaUser.id}/businesses`, {
        params: { fields: 'id,name,whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name,quality_rating}}', access_token: longToken },
      });
      wabaData = wabaRes.data?.data || [];
    } catch (e) { console.warn('[Auth] Could not fetch WABAs:', e.message); }

    const existing = await col('restaurants').findOne({ meta_user_id: metaUser.id });
    let restaurantId, approvalStatus, needsOnboarding;
    if (existing) {
      await col('restaurants').updateOne({ meta_user_id: metaUser.id }, { $set: {
        meta_access_token: longToken, meta_token_expires_at: expiresAt, updated_at: new Date(),
      }});
      restaurantId    = String(existing._id);
      approvalStatus  = existing.approval_status || 'pending';
      needsOnboarding = (existing.onboarding_step || 1) < 5;
    } else {
      restaurantId = newId();
      await col('restaurants').insertOne({
        _id: restaurantId, meta_user_id: metaUser.id, meta_access_token: longToken,
        meta_token_expires_at: expiresAt, owner_name: metaUser.name, email: metaUser.email,
        business_name: 'My Restaurant', status: 'active', approval_status: 'pending',
        onboarding_step: 1, created_at: new Date(), updated_at: new Date(),
      });
      approvalStatus  = 'pending';
      needsOnboarding = true;
    }

    await _saveWabaAccounts(restaurantId, wabaData, longToken);
    const jwtToken = jwt.sign({ restaurantId, metaUserId: metaUser.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token: jwtToken, approvalStatus, needsOnboarding });
  } catch (err) {
    console.error('[Auth] Facebook login error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// ─── SLUG HELPER ───────────────────────────────────────────────
async function generateUniqueSlug(brandName) {
  const base = brandName.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '').trim()
    .replace(/\s+/g, '-').replace(/-+/g, '-').substring(0, 40);
  let slug = base;
  let n = 1;
  while (await col('restaurants').findOne({ store_slug: slug })) {
    slug = `${base}-${n++}`;
  }
  return slug;
}

// ─── ONBOARDING ────────────────────────────────────────────────
router.post('/onboarding', requireAuth, express.json(), async (req, res) => {
  try {
    const {
      ownerName, phone, brandName, restaurantType, city,
    } = req.body;

    if (!ownerName || !phone || !brandName)
      return res.status(400).json({ error: 'Name, phone and restaurant name are required' });

    // Generate unique store slug (only if not already set)
    const existing = await col('restaurants').findOne({ _id: req.restaurantId }, { projection: { store_slug: 1 } });
    let storeSlug = existing?.store_slug;
    if (!storeSlug) {
      storeSlug = await generateUniqueSlug(brandName);
    }
    const storeUrl = `${process.env.BASE_URL}/store/${storeSlug}`;

    const $set = {
      owner_name: ownerName, phone, business_name: brandName, brand_name: brandName,
      restaurant_type: restaurantType || 'both', city: city || null,
      store_slug: storeSlug, store_url: storeUrl,
      approval_status: 'pending', onboarding_step: 2, updated_at: new Date(),
    };

    await col('restaurants').updateOne({ _id: req.restaurantId }, { $set });
    res.json({ submitted: true, storeUrl });
  } catch (err) {
    console.error('[Onboarding]', err.message);
    res.status(500).json({ error: 'Failed to save details' });
  }
});

// ─── GET CURRENT USER ─────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  let restaurant = await col('restaurants').findOne({ _id: req.restaurantId });
  if (!restaurant) return res.status(404).json({ error: 'Not found' });

  // Auto-generate store slug/url for restaurants that don't have one yet
  if (!restaurant.store_url) {
    const name = restaurant.brand_name || restaurant.business_name || 'my-restaurant';
    const slug = await generateUniqueSlug(name);
    const storeUrl = `${process.env.BASE_URL}/store/${slug}`;
    await col('restaurants').updateOne(
      { _id: req.restaurantId },
      { $set: { store_slug: slug, store_url: storeUrl } }
    );
    restaurant = { ...restaurant, store_slug: slug, store_url: storeUrl };
  }

  const waAccounts = await col('whatsapp_accounts').find({ restaurant_id: req.restaurantId }).toArray();
  const waba_accounts = waAccounts.map(w => ({ waba_id: w.waba_id, name: w.display_name, phone: w.phone_display }));

  const { meta_access_token, password_hash, ...safe } = restaurant;
  res.json({ ...safe, id: String(restaurant._id), waba_accounts });
});

// ─── WABA ACCOUNTS HELPER ─────────────────────────────────────
async function _saveWabaAccounts(restaurantId, wabaData, longToken) {
  for (const biz of wabaData) {
    for (const waba of biz.whatsapp_business_accounts?.data || []) {
      // Subscribe this WABA to GullyBite's app webhooks using system user token
      await _subscribeWaba(waba.id);

      for (const phone of waba.phone_numbers?.data || []) {
        await col('whatsapp_accounts').updateOne(
          { phone_number_id: phone.id },
          { $set: { restaurant_id: restaurantId, waba_id: waba.id,
              phone_display: phone.display_phone_number, display_name: phone.verified_name,
              quality_rating: phone.quality_rating?.display_value || 'GREEN',
              access_token: longToken, is_active: true, updated_at: new Date() },
            $setOnInsert: { _id: newId(), created_at: new Date() } },
          { upsert: true }
        );
      }

      // Auto-provision a catalog for this WABA (fire-and-forget, non-blocking)
      _provisionWabaCatalog(restaurantId, waba.id, longToken).catch(err =>
        console.error(`[Catalog] Auto-provision failed for WABA ${waba.id}:`, err.message)
      );
    }
  }
}

// ─── AUTO-PROVISION CATALOG PER WABA ─────────────────────────
// Creates one Meta catalog per WABA if it doesn't already exist,
// links it to the WABA, and propagates catalog_id to all branches.
async function _provisionWabaCatalog(restaurantId, wabaId, accessToken) {
  // Check if any whatsapp_account for this WABA already has a catalog_id
  const existingAcc = await col('whatsapp_accounts').findOne(
    { waba_id: wabaId, catalog_id: { $exists: true, $ne: null } }
  );
  if (existingAcc?.catalog_id) {
    console.log(`[Catalog] WABA ${wabaId} already has catalog ${existingAcc.catalog_id} — skipping`);
    // Still ensure branches are linked (in case new branches were added since last connect)
    await _linkCatalogToBranches(restaurantId, existingAcc.catalog_id);
    return;
  }

  const restaurant = await col('restaurants').findOne({ _id: restaurantId });
  if (!restaurant) return;

  // Get the Meta Business ID that owns this WABA
  let businessId;
  try {
    const meRes = await axios.get(`${META_GRAPH_URL}/me/businesses`, {
      params: { access_token: accessToken, fields: 'id,name' },
      timeout: 10000,
    });
    const businesses = meRes.data?.data || [];
    if (!businesses.length) throw new Error('No Meta Business account found');
    businessId = businesses[0].id;
  } catch (err) {
    throw new Error(`Could not fetch business account: ${err.response?.data?.error?.message || err.message}`);
  }

  // Create the catalog (one per WABA, named after the restaurant)
  const catalogName = restaurant.brand_name || restaurant.business_name || 'GullyBite Menu';
  let catalogId;
  try {
    const createRes = await axios.post(
      `${META_GRAPH_URL}/${businessId}/owned_product_catalogs`,
      { name: catalogName, vertical: 'commerce' },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    catalogId = createRes.data.id;
    console.log(`[Catalog] Created catalog "${catalogName}" (${catalogId}) for WABA ${wabaId}`);
  } catch (err) {
    throw new Error(`Catalog creation failed: ${err.response?.data?.error?.message || err.message}`);
  }

  // Link the catalog to the WABA so it appears in WhatsApp Business
  try {
    await axios.post(
      `${META_GRAPH_URL}/${wabaId}/product_catalogs`,
      { catalog_id: catalogId },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    console.log(`[Catalog] Linked catalog ${catalogId} to WABA ${wabaId}`);
  } catch (err) {
    // Non-fatal — catalog is created even if linking fails (can retry later)
    console.warn(`[Catalog] Could not link catalog to WABA: ${err.response?.data?.error?.message || err.message}`);
  }

  // Save catalog_id on all whatsapp_accounts for this WABA
  await col('whatsapp_accounts').updateMany(
    { waba_id: wabaId },
    { $set: { catalog_id: catalogId, updated_at: new Date() } }
  );

  // Propagate to existing branches
  await _linkCatalogToBranches(restaurantId, catalogId);
}

// Set catalog_id on all branches of a restaurant that don't have one yet
async function _linkCatalogToBranches(restaurantId, catalogId) {
  const result = await col('branches').updateMany(
    { restaurant_id: restaurantId, catalog_id: { $in: [null, undefined, ''] } },
    { $set: { catalog_id: catalogId, updated_at: new Date() } }
  );
  if (result.modifiedCount > 0) {
    console.log(`[Catalog] Linked catalog ${catalogId} to ${result.modifiedCount} branch(es) of restaurant ${restaurantId}`);
  }
}

// Subscribe a WABA to GullyBite's app so we receive webhook events
// Requires META_SYSTEM_USER_TOKEN in env (system user with whatsapp_business_management permission)
async function _subscribeWaba(wabaId) {
  const sysToken = process.env.META_SYSTEM_USER_TOKEN;
  if (!sysToken) {
    console.warn('[subscribeWaba] META_SYSTEM_USER_TOKEN not set — skipping WABA subscription for', wabaId);
    return;
  }
  try {
    await axios.post(`${META_GRAPH_URL}/${wabaId}/subscribed_apps`, {}, {
      params: { access_token: sysToken },
    });
    console.log(`[subscribeWaba] Subscribed WABA ${wabaId} to app webhooks`);
  } catch (err) {
    console.error(`[subscribeWaba] Failed for WABA ${wabaId}:`, err.response?.data || err.message);
  }
}

// ─── JWT AUTH MIDDLEWARE ──────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded    = jwt.verify(token, process.env.JWT_SECRET);
    req.restaurantId = decoded.restaurantId;
    req.metaUserId   = decoded.metaUserId;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
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
    console.error('[requireApproved]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { router, requireAuth, requireApproved, _provisionWabaCatalog, _linkCatalogToBranches };
