// src/routes/auth.js
// Email/password + Meta OAuth authentication

const express = require('express');
const axios   = require('axios');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const multer  = require('multer');
const router  = express.Router();
const { col, newId, getBucket } = require('../config/database');
const { Readable } = require('stream');

// ── Document upload config (GST / FSSAI certificates) ────────
const docUpload = multer({
  storage: multer.memoryStorage(),
  limits : { fileSize: 10 * 1024 * 1024 }, // 10 MB max per document
  fileFilter(req, file, cb) {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    cb(allowed.includes(file.mimetype) ? null : new Error('Only JPEG, PNG, WebP or PDF files are allowed'), allowed.includes(file.mimetype));
  },
});

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
    const ownerUser = await ensureOwnerUser(id, ownerName.trim());
    const token = jwt.sign({
      restaurantId: id,
      userId: String(ownerUser._id),
      role: 'owner',
      permissions: ROLE_PERMISSIONS.owner,
      branchIds: [],
    }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, needsOnboarding: true, onboardingStep: 1, user: { id: String(ownerUser._id), name: ownerUser.name, role: 'owner', permissions: ROLE_PERMISSIONS.owner } });
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

    const ownerUser = await ensureOwnerUser(String(restaurant._id), restaurant.owner_name);
    const token = jwt.sign({
      restaurantId: String(restaurant._id),
      userId: String(ownerUser._id),
      role: 'owner',
      permissions: ROLE_PERMISSIONS.owner,
      branchIds: [],
    }, process.env.JWT_SECRET, { expiresIn: '30d' });
    const step  = restaurant.onboarding_step || 1;
    res.json({
      token,
      approvalStatus : restaurant.approval_status || 'pending',
      onboardingStep : step,
      needsOnboarding: step < 5,
      hasMetaConnected: !!restaurant.meta_user_id,
      user: { id: String(ownerUser._id), name: ownerUser.name, role: 'owner', permissions: ROLE_PERMISSIONS.owner },
    });
  } catch (err) {
    console.error('[Signin]', err.message);
    res.status(500).json({ error: 'Sign in failed' });
  }
});

// ─── CONNECT META / WHATSAPP ───────────────────────────────────
// When the code comes from FB.login() (JS SDK), the SDK uses its own internal
// redirect URI — NOT the server-side OAuth redirect URI. We must match it exactly.
const JS_SDK_REDIRECT_URI = 'https://www.facebook.com/connect/login_success.html';

router.post('/connect-meta', requireAuth, express.json(), async (req, res) => {
  try {
    const { accessToken, code, sessionInfo, fromJsSdk } = req.body;
    if (!accessToken && !code) return res.status(400).json({ error: 'No token provided' });

    let longToken, expiresAt;
    if (code) {
      // JS SDK codes require JS_SDK_REDIRECT_URI; server-side OAuth codes use META_OAUTH_REDIRECT_URI
      const redirectUri = fromJsSdk ? JS_SDK_REDIRECT_URI : process.env.META_OAUTH_REDIRECT_URI;
      // Meta requires POST + grant_type for embedded signup code exchange
      const tokenRes = await axios.post(`${META_GRAPH_URL}/oauth/access_token`, {
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        redirect_uri: redirectUri,
        code,
        grant_type: 'authorization_code',
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

    // Get current restaurant to preserve approval_status
    const currentRestaurant = await col('restaurants').findOne(
      { _id: req.restaurantId }, { projection: { approval_status: 1, submitted_at: 1 } }
    );

    const $set = {
      meta_user_id: metaUser.id, meta_access_token: longToken, meta_token_expires_at: expiresAt,
      onboarding_step: 5, updated_at: new Date(),
    };
    // Only reset to pending if not already in an approved/rejected state
    if (!currentRestaurant?.approval_status || currentRestaurant.approval_status === 'pending') {
      $set.approval_status = 'pending';
      $set.submitted_at = currentRestaurant?.submitted_at || new Date();
    }
    if (sessionInfo?.phone_number_id) $set.meta_phone_number_id = sessionInfo.phone_number_id;
    if (sessionInfo?.waba_id) $set.meta_waba_id = sessionInfo.waba_id;
    await col('restaurants').updateOne({ _id: req.restaurantId }, { $set });

    await _saveWabaAccounts(req.restaurantId, wabaData, longToken, sessionInfo);
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

    console.log(`[delete-account] Deleted restaurant ${id} and all associated data`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[delete-account]', err.message);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// ─── INITIATE META OAUTH ──────────────────────────────────────
router.get('/login', (req, res) => {
  const source = req.query.source || 'index'; // 'signup', 'dashboard', or 'index'
  const scopes = ['whatsapp_business_management', 'whatsapp_business_messaging', 'business_management', 'catalog_management'].join(',');
  const stateObj = { ts: Date.now(), source };
  const state = Buffer.from(JSON.stringify(stateObj)).toString('base64');
  const authUrl = `${META_AUTH_URL}?client_id=${process.env.META_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(process.env.META_OAUTH_REDIRECT_URI)}` +
    `&scope=${scopes}&response_type=code` +
    `&state=${encodeURIComponent(state)}`;
  res.redirect(authUrl);
});

// ─── META OAUTH CALLBACK ──────────────────────────────────────
router.get('/callback', async (req, res) => {
  const { code, error, state } = req.query;

  // Parse source from state (signup, dashboard, or index)
  let source = 'index';
  try {
    const stateObj = JSON.parse(Buffer.from(decodeURIComponent(state || ''), 'base64').toString());
    source = stateObj.source || 'index';
  } catch {}

  if (error || !code) {
    const dest = source === 'dashboard' ? '/dashboard?error=oauth_failed' : '/?error=oauth_failed';
    return res.redirect(dest);
  }

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
    const ownerUser = await ensureOwnerUser(restaurantId, metaUser.name);
    const jwtToken = jwt.sign({
      restaurantId, metaUserId: metaUser.id,
      userId: String(ownerUser._id), role: 'owner',
      permissions: ROLE_PERMISSIONS.owner, branchIds: [],
    }, process.env.JWT_SECRET, { expiresIn: '30d' });

    // Redirect based on source — dashboard goes back to dashboard, signup/index goes to index
    if (source === 'dashboard') {
      res.redirect(`/dashboard?meta_token=${jwtToken}`);
    } else {
      res.redirect(`/?meta_token=${jwtToken}`);
    }
  } catch (err) {
    console.error('[OAuth] Callback error:', err.response?.data || err.message);
    const dest = source === 'dashboard' ? '/dashboard?error=oauth_failed' : '/?error=oauth_failed';
    res.redirect(dest);
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
    const ownerUser2 = await ensureOwnerUser(restaurantId, metaUser.name);
    const jwtToken = jwt.sign({
      restaurantId, metaUserId: metaUser.id,
      userId: String(ownerUser2._id), role: 'owner',
      permissions: ROLE_PERMISSIONS.owner, branchIds: [],
    }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token: jwtToken, approvalStatus, needsOnboarding, user: { id: String(ownerUser2._id), name: ownerUser2.name, role: 'owner', permissions: ROLE_PERMISSIONS.owner } });
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

// ─── ONBOARDING STEP 2: DOCUMENT UPLOAD (GST + FSSAI) ────────
// Uncomment this block when ready to enable mandatory document upload during onboarding.
// Accepts: gst_doc (file), fssai_doc (file), gst_number (text), fssai_license (text), fssai_expiry (text)
// Files stored in MongoDB GridFS, URLs saved on the restaurant document.
//
// router.post('/onboarding/documents',
//   requireAuth,
//   docUpload.fields([
//     { name: 'gst_doc', maxCount: 1 },
//     { name: 'fssai_doc', maxCount: 1 },
//   ]),
//   async (req, res) => {
//     try {
//       const { gst_number, fssai_license, fssai_expiry } = req.body;
//
//       if (!gst_number || !fssai_license) {
//         return res.status(400).json({ error: 'GST number and FSSAI license number are required' });
//       }
//       if (!req.files?.gst_doc?.[0] || !req.files?.fssai_doc?.[0]) {
//         return res.status(400).json({ error: 'Both GST and FSSAI document uploads are required' });
//       }
//
//       // Validate GST format: 15 chars alphanumeric
//       const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
//       if (!gstRegex.test(gst_number.toUpperCase())) {
//         return res.status(400).json({ error: 'Invalid GST number format' });
//       }
//
//       // Validate FSSAI: 14 digits
//       const fssaiRegex = /^[0-9]{14}$/;
//       if (!fssaiRegex.test(fssai_license)) {
//         return res.status(400).json({ error: 'FSSAI license must be a 14-digit number' });
//       }
//
//       const bucket = getBucket();
//       const uploadToGridFS = async (file, docType) => {
//         const ext = file.mimetype === 'application/pdf' ? 'pdf' : file.mimetype.split('/')[1].replace('jpeg', 'jpg');
//         const filename = `${req.restaurantId}-${docType}-${Date.now()}.${ext}`;
//         const uploadStream = bucket.openUploadStream(filename, {
//           contentType: file.mimetype,
//           metadata: { restaurantId: req.restaurantId, docType },
//         });
//         await new Promise((resolve, reject) => {
//           const readable = Readable.from(file.buffer);
//           readable.pipe(uploadStream);
//           uploadStream.on('finish', resolve);
//           uploadStream.on('error', reject);
//         });
//         return `${process.env.BASE_URL}/images/${String(uploadStream.id)}`;
//       };
//
//       const [gstDocUrl, fssaiDocUrl] = await Promise.all([
//         uploadToGridFS(req.files.gst_doc[0], 'gst'),
//         uploadToGridFS(req.files.fssai_doc[0], 'fssai'),
//       ]);
//
//       const now = new Date();
//       await col('restaurants').updateOne(
//         { _id: req.restaurantId },
//         {
//           $set: {
//             gst_number: gst_number.toUpperCase(),
//             gst_doc_url: gstDocUrl,
//             gst_verified: false,
//             fssai_license: fssai_license,
//             fssai_doc_url: fssaiDocUrl,
//             fssai_expiry: fssai_expiry ? new Date(fssai_expiry) : null,
//             fssai_verified: false,
//             documents_submitted_at: now,
//             updated_at: now,
//           },
//         }
//       );
//
//       res.json({ ok: true, gst_doc_url: gstDocUrl, fssai_doc_url: fssaiDocUrl });
//     } catch (err) {
//       console.error('[Onboarding/Documents]', err.message);
//       res.status(500).json({ error: 'Document upload failed: ' + err.message });
//     }
//   }
// );

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
async function _saveWabaAccounts(restaurantId, wabaData, longToken, sessionInfo = null) {
  for (const biz of wabaData) {
    for (const waba of biz.whatsapp_business_accounts?.data || []) {
      await _subscribeWaba(waba.id);

      for (const phone of waba.phone_numbers?.data || []) {
        await col('whatsapp_accounts').updateOne(
          { phone_number_id: phone.id },
          {
            $set: {
              restaurant_id : restaurantId,
              waba_id       : waba.id,
              phone_display : phone.display_phone_number,
              display_name  : phone.verified_name,
              quality_rating: phone.quality_rating?.display_value || 'GREEN',
              access_token  : longToken,
              is_active     : true,
              updated_at    : new Date(),
            },
            $setOnInsert: { _id: newId(), created_at: new Date() },
          },
          { upsert: true }
        );

        // Register phone number with Cloud API — resolves "Connecting phone number" in WA Manager
        _registerPhoneNumber(phone.id, longToken).catch(err =>
          console.error(`[Register] Phone ${phone.id} registration failed:`, err.message)
        );
      }

      // Auto-provision catalog + enable cart icon for every phone number under this WABA
      _provisionWabaCatalog(restaurantId, waba.id, longToken).catch(err =>
        console.error(`[Catalog] Auto-provision failed for WABA ${waba.id}:`, err.message)
      );
    }
  }

  // Fallback: if the businesses API returned nothing but embedded signup gave us a waba_id,
  // query that WABA's phone numbers directly — embedded signup tokens are scoped to the WABA
  if (!wabaData.length && sessionInfo?.waba_id) {
    console.log(`[saveWabaAccounts] Falling back to direct WABA query for ${sessionInfo.waba_id}`);
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
        await col('whatsapp_accounts').updateOne(
          { phone_number_id: phone.id },
          {
            $set: {
              restaurant_id : restaurantId,
              waba_id       : sessionInfo.waba_id,
              phone_display : phone.display_phone_number,
              display_name  : phone.verified_name,
              quality_rating: phone.quality_rating?.display_value || 'GREEN',
              access_token  : longToken,
              is_active     : true,
              updated_at    : new Date(),
            },
            $setOnInsert: { _id: newId(), created_at: new Date() },
          },
          { upsert: true }
        );
        _registerPhoneNumber(phone.id, longToken).catch(err =>
          console.error(`[Register] Phone ${phone.id} registration failed:`, err.message)
        );
      }

      _provisionWabaCatalog(restaurantId, sessionInfo.waba_id, longToken).catch(err =>
        console.error(`[Catalog] Auto-provision failed for WABA ${sessionInfo.waba_id}:`, err.message)
      );
    } catch (e) {
      console.warn('[saveWabaAccounts] Direct WABA fallback failed:', e.response?.data?.error?.message || e.message);
    }
  }
}

// ─── SUBSCRIBE WABA TO WEBHOOKS ───────────────────────────────
async function _subscribeWaba(wabaId) {
  const sysToken = process.env.META_SYSTEM_USER_TOKEN;
  if (!sysToken) {
    console.warn('[subscribeWaba] META_SYSTEM_USER_TOKEN not set — skipping for', wabaId);
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

// ─── REGISTER PHONE NUMBER WITH CLOUD API ────────────────────
// Resolves "Connecting phone number to [App]" in WhatsApp Business Manager.
// Must be called once per phone number after Embedded Signup.
async function _registerPhoneNumber(phoneNumberId, accessToken) {
  try {
    await axios.post(
      `${META_GRAPH_URL}/${phoneNumberId}/register`,
      { messaging_product: 'whatsapp', pin: '000000' },
      {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );
    await col('whatsapp_accounts').updateOne(
      { phone_number_id: phoneNumberId },
      { $set: { phone_registered: true, updated_at: new Date() } }
    );
    console.log(`[Register] Phone ${phoneNumberId} registered with Cloud API`);
  } catch (err) {
    const apiErr = err.response?.data?.error;
    // Code 80007 = already registered — treat as success
    if (apiErr?.code === 80007 || apiErr?.error_subcode === 2388053) {
      await col('whatsapp_accounts').updateOne(
        { phone_number_id: phoneNumberId },
        { $set: { phone_registered: true, updated_at: new Date() } }
      );
      console.log(`[Register] Phone ${phoneNumberId} was already registered`);
      return;
    }
    console.error(`[Register] Failed for phone ${phoneNumberId}:`, apiErr?.message || err.message);
    throw err;
  }
}

// ─── AUTO-PROVISION CATALOG PER WABA ─────────────────────────
// Creates one Meta catalog per WABA (if missing), links it to the WABA,
// enables the cart icon on every phone number, and propagates to branches.
async function _provisionWabaCatalog(restaurantId, wabaId, accessToken) {
  // Check if any account for this WABA already has a catalog_id
  const existingAcc = await col('whatsapp_accounts').findOne(
    { waba_id: wabaId, catalog_id: { $exists: true, $ne: null } }
  );

  let catalogId = existingAcc?.catalog_id;

  if (!catalogId) {
    const restaurant = await col('restaurants').findOne({ _id: restaurantId });
    if (!restaurant) return;

    // Try fetching catalogs already linked to this WABA (avoids (#100) permission error on creation)
    try {
      const wabaRes = await axios.get(`${META_GRAPH_URL}/${wabaId}/product_catalogs`, {
        params: { access_token: accessToken, fields: 'id,name' },
        timeout: 10000,
      });
      const existing = wabaRes.data?.data || [];
      if (existing.length) {
        catalogId = existing[0].id;
        console.log(`[Catalog] Found existing WABA catalog ${catalogId} for WABA ${wabaId}`);
      }
    } catch (e) {
      console.warn(`[Catalog] Could not fetch WABA catalogs for ${wabaId}:`, e.response?.data?.error?.message || e.message);
    }

    if (!catalogId) {
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

      // Check if business already owns any catalogs before trying to create one
      try {
        const bizCatRes = await axios.get(`${META_GRAPH_URL}/${businessId}/owned_product_catalogs`, {
          params: { access_token: accessToken, fields: 'id,name' },
          timeout: 10000,
        });
        const bizCatalogs = bizCatRes.data?.data || [];
        if (bizCatalogs.length) {
          catalogId = bizCatalogs[0].id;
          console.log(`[Catalog] Found existing business catalog ${catalogId} for WABA ${wabaId} — inheriting`);
        }
      } catch (e) {
        console.warn(`[Catalog] Could not read business catalogs:`, e.response?.data?.error?.message || e.message);
      }

      if (!catalogId) {
        // Create one catalog for this WABA named after the restaurant
        const catalogName = restaurant.brand_name || restaurant.business_name || 'GullyBite Menu';
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
      }
    }

    // Link catalog to WABA (makes it appear in WhatsApp Business Manager)
    try {
      await axios.post(
        `${META_GRAPH_URL}/${wabaId}/product_catalogs`,
        { catalog_id: catalogId },
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, timeout: 10000 }
      );
      console.log(`[Catalog] Linked catalog ${catalogId} to WABA ${wabaId}`);
    } catch (err) {
      console.warn(`[Catalog] Could not link catalog to WABA: ${err.response?.data?.error?.message || err.message}`);
    }

    // Save catalog_id on all whatsapp_accounts for this WABA
    await col('whatsapp_accounts').updateMany(
      { waba_id: wabaId },
      { $set: { catalog_id: catalogId, updated_at: new Date() } }
    );
  }

  // Enable cart icon + catalog visibility on every phone number under this WABA
  const phones = await col('whatsapp_accounts').find({ waba_id: wabaId }).toArray();
  for (const phone of phones) {
    await _enableCommerceSettings(phone.phone_number_id, catalogId, accessToken);
  }

  // Propagate catalog_id to existing branches that don't have one
  await _linkCatalogToBranches(restaurantId, catalogId);
}

// ─── ENABLE CART ICON ON A PHONE NUMBER ──────────────────────
// Calls POST /{phone_number_id}/whatsapp_commerce_settings to show
// the catalog/cart icon inside WhatsApp chats for that number.
async function _enableCommerceSettings(phoneNumberId, catalogId, accessToken) {
  try {
    await axios.post(
      `${META_GRAPH_URL}/${phoneNumberId}/whatsapp_commerce_settings`,
      {
        is_catalog_visible: true,
        is_cart_enabled   : true,
      },
      {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );
    // Mark commerce as enabled in DB
    await col('whatsapp_accounts').updateOne(
      { phone_number_id: phoneNumberId },
      { $set: { cart_enabled: true, catalog_id: catalogId, updated_at: new Date() } }
    );
    console.log(`[Commerce] Cart + catalog icon enabled on phone ${phoneNumberId}`);
  } catch (err) {
    console.error(`[Commerce] Failed to enable cart on ${phoneNumberId}:`, err.response?.data?.error?.message || err.message);
  }
}

// ─── LINK CATALOG TO BRANCHES ────────────────────────────────
// Sets catalog_id on branches that don't have one yet.
async function _linkCatalogToBranches(restaurantId, catalogId) {
  const result = await col('branches').updateMany(
    { restaurant_id: restaurantId, catalog_id: { $in: [null, undefined, ''] } },
    { $set: { catalog_id: catalogId, updated_at: new Date() } }
  );
  if (result.modifiedCount > 0) {
    console.log(`[Catalog] Linked catalog ${catalogId} to ${result.modifiedCount} branch(es)`);
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
    console.error('[PIN Login]', err.message);
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
    console.error('[requireApproved]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { router, requireAuth, requireApproved, requirePermission, ROLE_PERMISSIONS, ensureOwnerUser, _registerPhoneNumber, _provisionWabaCatalog, _enableCommerceSettings, _linkCatalogToBranches };
