#!/usr/bin/env node
// scripts/verify-waba-token-expiry.js
//
// Calls Meta's debug_token endpoint against ONE stored per-WABA token from
// whatsapp_accounts. Reveals whether Embedded Signup tokens are issued as:
//   - Business Integration System User (type = SYSTEM_USER, expires_at = 0)
//     → effectively non-expiring; Path B is safe with no refresh cron
//   - Regular User access token (type = USER, expires_at = unix epoch ~60d out)
//     → tokens expire; Path B requires refresh / re-OAuth infrastructure
//
// Run on EC2 where env vars are present:
//   cd /home/ubuntu/GullyBite/backend && node scripts/verify-waba-token-expiry.js
//
// Optional argument: pass a specific waba_id or restaurant_id to debug_token a
// non-default row. Default = most recently created active row.
//
// Read-only: makes ONE Meta API call. No DB writes. No side effects.

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { MongoClient } = require('mongodb');
const axios = require('axios');

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB  = process.env.MONGODB_DB || 'gullybite';
const SYSTEM_TOKEN = process.env.META_SYSTEM_USER_TOKEN;
const API_VERSION = process.env.WA_API_VERSION || 'v25.0';
const GRAPH_BASE  = `https://graph.facebook.com/${API_VERSION}`;
// debug_token lives at the unversioned root, but the v* prefix also works.

if (!MONGODB_URI) {
  console.error('FATAL: MONGODB_URI is not set');
  process.exit(1);
}
if (!SYSTEM_TOKEN) {
  console.error('FATAL: META_SYSTEM_USER_TOKEN is not set');
  process.exit(1);
}

function formatExpiry(unixSec) {
  if (unixSec == null) return '(field absent)';
  if (unixSec === 0)   return 'Never (0)';
  const ms = unixSec * 1000;
  const d  = new Date(ms);
  const daysFromNow = Math.round((ms - Date.now()) / 86400000);
  return `${d.toISOString()}  (${daysFromNow >= 0 ? `${daysFromNow}d from now` : `EXPIRED ${-daysFromNow}d ago`})`;
}

(async () => {
  const filterArg = process.argv[2]; // optional waba_id or restaurant_id
  const filter = { access_token: { $exists: true, $ne: null, $ne: '' }, is_active: true };
  if (filterArg) {
    filter.$or = [{ waba_id: filterArg }, { restaurant_id: filterArg }];
  }

  const client = await MongoClient.connect(MONGODB_URI);
  try {
    const db  = client.db(MONGODB_DB);
    const col = db.collection('whatsapp_accounts');

    // Pick most recently created matching row.
    const row = await col.findOne(filter, { sort: { created_at: -1 } });
    if (!row) {
      console.error('No whatsapp_accounts row matched the filter:', filter);
      process.exit(2);
    }

    console.log('=== Source row (whatsapp_accounts) ===');
    console.log(JSON.stringify({
      _id:              String(row._id),
      restaurant_id:    row.restaurant_id,
      waba_id:          row.waba_id,
      phone_number_id:  row.phone_number_id,
      phone_display:    row.phone_display,
      display_name:     row.display_name,
      is_active:        row.is_active,
      created_at:       row.created_at,
      updated_at:       row.updated_at,
      access_token_length: row.access_token ? String(row.access_token).length : 0,
      access_token_prefix: row.access_token ? String(row.access_token).slice(0, 8) + '...' : null,
      // Surface any expiry-like field that already exists on the row, in case
      // a legacy code path persisted one under a name we missed.
      existing_expiry_fields: Object.fromEntries(
        Object.entries(row).filter(([k]) => /expire|expiry/i.test(k))
      ),
    }, null, 2));

    // Call Meta debug_token: input_token = the token we want to inspect,
    // access_token = a token with permission to inspect it. Using the platform
    // System User token as the inspector is the standard pattern.
    console.log('\n=== Calling Meta debug_token ===');
    console.log(`GET ${GRAPH_BASE}/debug_token?input_token=<waba_token>&access_token=<system_user_token>\n`);

    const res = await axios.get(`${GRAPH_BASE}/debug_token`, {
      params: { input_token: row.access_token, access_token: SYSTEM_TOKEN },
      timeout: 30000,
    });

    const d = res.data?.data || {};

    console.log('=== Meta debug_token response ===');
    console.log(JSON.stringify(res.data, null, 2));

    console.log('\n=== Decisive fields ===');
    console.log(`type:                       ${d.type || '(missing)'}`);
    console.log(`is_valid:                   ${d.is_valid}`);
    console.log(`application:                ${d.application || '(missing)'}`);
    console.log(`app_id:                     ${d.app_id || '(missing)'}`);
    console.log(`user_id:                    ${d.user_id || '(missing — would be present for USER tokens)'}`);
    console.log(`expires_at:                 ${formatExpiry(d.expires_at)}`);
    console.log(`data_access_expires_at:     ${formatExpiry(d.data_access_expires_at)}`);
    console.log(`issued_at:                  ${d.issued_at ? new Date(d.issued_at * 1000).toISOString() : '(missing)'}`);
    console.log(`scopes (count):             ${(d.scopes || []).length}`);
    console.log(`scopes:                     ${(d.scopes || []).join(', ')}`);
    if (d.granular_scopes?.length) {
      console.log(`granular_scopes (count):    ${d.granular_scopes.length}`);
      console.log(`granular_scopes:            ${JSON.stringify(d.granular_scopes, null, 2)}`);
    }

    console.log('\n=== Verdict hint ===');
    if (d.type === 'SYSTEM_USER' && d.expires_at === 0) {
      console.log('Tech Provider / Business Integration System User — non-expiring token.');
      console.log('Path B is safe with no refresh cron. Per-WABA token can be primary.');
    } else if (d.type === 'USER') {
      console.log('Regular User access token — WILL EXPIRE.');
      console.log(`Expires: ${formatExpiry(d.expires_at)}`);
      console.log('Path B requires expiration tracking + refresh/re-OAuth flow.');
    } else if (d.type === 'PAGE') {
      console.log('PAGE token — unexpected for WABA context.');
    } else {
      console.log(`type=${d.type}, expires_at=${d.expires_at} — interpret manually using Meta docs.`);
    }
  } catch (err) {
    if (err.response) {
      console.error('Meta API error:');
      console.error(`  status: ${err.response.status}`);
      console.error(`  body:   ${JSON.stringify(err.response.data, null, 2)}`);
    } else {
      console.error('Script error:', err.message);
    }
    process.exit(1);
  } finally {
    await client.close();
  }
})();
