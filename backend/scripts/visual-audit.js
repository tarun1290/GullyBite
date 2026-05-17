#!/usr/bin/env node
'use strict';

// scripts/visual-audit.js
//
// Puppeteer visual-audit: logs into the restaurant dashboard, then
// captures every dashboard page + the customer-facing store page at
// desktop and mobile viewports as full-page PNGs.
//
// NOT run automatically — Tarun runs it manually with his own env vars.
//
// Usage on EC2:
//   node --env-file=/home/ubuntu/GullyBite/.env backend/scripts/visual-audit.js
// Locally (env vars exported in the shell):
//   AUDIT_BASE_URL=http://localhost:3000 AUDIT_EMAIL=… AUDIT_PASSWORD=… \
//   AUDIT_STORE_SLUG=… node backend/scripts/visual-audit.js
//
// Required env (never hardcoded):
//   AUDIT_BASE_URL    — e.g. http://localhost:3000 or a Vercel preview URL
//   AUDIT_EMAIL       — restaurant login email
//   AUDIT_PASSWORD    — restaurant login password
//   AUDIT_STORE_SLUG  — a valid restaurant slug for /store/[slug]
//
// Output: backend/scripts/visual-audit-screenshots/  (created if missing,
// cleared on every run so stale screenshots never accumulate).
//
// Route list below was derived by reading frontend/src/app/dashboard/ and
// frontend/src/app/store/[slug]/ on the audit date. If routes change,
// re-derive manually and update DASHBOARD_PATHS. The only dynamic segment
// in scope is store/[slug] (substituted with AUDIT_STORE_SLUG); there are
// no other dynamic segments under dashboard. If a future route adds one
// (e.g. [orderId]), add it to SKIP_DYNAMIC so it is logged and skipped
// rather than requested with an unresolved placeholder.

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

// ── Config from env ──────────────────────────────────────────
const BASE_URL = process.env.AUDIT_BASE_URL;
const EMAIL = process.env.AUDIT_EMAIL;
const PASSWORD = process.env.AUDIT_PASSWORD;
const STORE_SLUG = process.env.AUDIT_STORE_SLUG;

const OUT_DIR = path.join(__dirname, 'visual-audit-screenshots');

// Dashboard routes that actually exist (frontend/src/app/dashboard/*/page.tsx).
const DASHBOARD_PATHS = [
  '/dashboard',
  '/dashboard/overview',
  '/dashboard/orders',
  '/dashboard/menu',
  '/dashboard/marketing',
  '/dashboard/messages',
  '/dashboard/payments',
  '/dashboard/reputation',
  '/dashboard/analytics',
  '/dashboard/settings',
];

// Dynamic segments other than [slug] are skipped + logged. None exist
// today; declared so the behaviour is explicit if one is ever added.
const SKIP_DYNAMIC = [];

const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false };
const MOBILE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true };

function fail(msg) {
  console.error(`FATAL: ${msg}`);
  process.exit(1);
}

// /dashboard/orders -> dashboard_orders ; /store/<slug> -> store_<slug>
function nameFromPath(urlPath) {
  return urlPath
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\//g, '_')
    .replace(/[^a-zA-Z0-9_-]/g, '-') || 'root';
}

function resetOutDir() {
  // Contained to OUT_DIR (resolved from __dirname) — never touches
  // anything outside the screenshots folder.
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

async function settle(page) {
  try {
    await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 });
  } catch (_) {
    console.warn('   ⚠ network did not idle within 15s — screenshotting anyway');
  }
}

async function shoot(page, urlPath, baseName) {
  await page.setViewport(DESKTOP);
  await settle(page);
  await page.screenshot({
    path: path.join(OUT_DIR, `${baseName}_desktop.png`),
    fullPage: true,
  });

  await page.setViewport(MOBILE);
  await settle(page);
  await page.screenshot({
    path: path.join(OUT_DIR, `${baseName}_mobile.png`),
    fullPage: true,
  });

  console.log(`✅ ${urlPath} — desktop + mobile`);
}

async function login(page) {
  const loginUrl = `${BASE_URL.replace(/\/+$/, '')}/login`;
  console.log(`Authenticating at ${loginUrl} …`);
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Default mode is 'signin'; wrapper id #pg-signin. Inputs carry no
  // name/id — select by type/autocomplete scoped to the signin wrapper.
  await page.waitForSelector('#pg-signin', { timeout: 15000 });
  const emailSel = '#pg-signin input[type="email"]';
  const pwSel = '#pg-signin input[type="password"]';
  const submitSel = '#pg-signin button[type="submit"]';
  await page.waitForSelector(emailSel, { timeout: 15000 });
  await page.waitForSelector(pwSel, { timeout: 15000 });

  // page.type dispatches real input events so React's controlled-input
  // onChange fires (setting .value via $eval would not).
  await page.type(emailSel, EMAIL, { delay: 10 });
  await page.type(pwSel, PASSWORD, { delay: 10 });
  await page.click(submitSel);

  // Success = redirected to /dashboard OR zm_token written to
  // localStorage (login page does setItem('zm_token', …) then router.push).
  const deadline = Date.now() + 20000;
  let ok = false;
  while (Date.now() < deadline) {
    if (page.url().includes('/dashboard')) { ok = true; break; }
    let token = null;
    try {
      token = await page.evaluate(() => window.localStorage.getItem('zm_token'));
    } catch (_) { /* context swapping during navigation — retry */ }
    if (token) { ok = true; break; }
    await new Promise((r) => setTimeout(r, 400));
  }

  if (!ok) {
    let bodyText = '';
    try {
      bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 300) || '');
    } catch (_) { /* ignore */ }
    fail(
      'Authentication failed — no /dashboard redirect and no zm_token after 20s. ' +
      'Check AUDIT_EMAIL / AUDIT_PASSWORD / AUDIT_BASE_URL. ' +
      `Login page said: ${bodyText.replace(/\s+/g, ' ').trim()}`,
    );
  }
  console.log('✅ Authenticated.\n');
}

async function main() {
  // Validate env up front — never hardcode, never proceed partial.
  const missing = [];
  if (!BASE_URL) missing.push('AUDIT_BASE_URL');
  if (!EMAIL) missing.push('AUDIT_EMAIL');
  if (!PASSWORD) missing.push('AUDIT_PASSWORD');
  if (!STORE_SLUG) missing.push('AUDIT_STORE_SLUG');
  if (missing.length) fail(`Missing required env var(s): ${missing.join(', ')}`);

  for (const seg of SKIP_DYNAMIC) {
    console.log(`skipped dynamic route: ${seg}`);
  }

  resetOutDir();

  const targets = [
    ...DASHBOARD_PATHS.map((p) => ({ urlPath: p, name: nameFromPath(p) })),
    {
      urlPath: `/store/${STORE_SLUG}`,
      // Filename per the documented rule (/ → _, strip leading _);
      // slug sanitised for filesystem safety.
      name: nameFromPath(`/store/${STORE_SLUG}`),
    },
  ];

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const results = { attempted: 0, succeeded: 0, failed: [] };

  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(30000);

    await login(page); // exits the process on failure (no fake screenshots)

    for (const t of targets) {
      results.attempted++;
      const url = `${BASE_URL.replace(/\/+$/, '')}${t.urlPath}`;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await shoot(page, t.urlPath, t.name);
        results.succeeded++;
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.error(`❌ ${t.urlPath} — ${msg}`);
        results.failed.push(`${t.urlPath} (${msg})`);
        // Best-effort capture of whatever rendered, so failures are visible.
        try {
          await page.setViewport(DESKTOP);
          await page.screenshot({
            path: path.join(OUT_DIR, `FAILED_${t.name}_desktop.png`),
            fullPage: true,
          });
        } catch (_) {
          console.error(`   (could not capture FAILED screenshot for ${t.urlPath})`);
        }
        // Continue — never abort the whole run.
      }
    }
  } finally {
    await browser.close();
  }

  console.log('\n──────────── SUMMARY ────────────');
  console.log(`Total pages attempted: ${results.attempted}`);
  console.log(`Succeeded: ${results.succeeded}`);
  console.log(`Failed: ${results.failed.length}`);
  for (const f of results.failed) console.log(`  - ${f}`);
  console.log(`Screenshots saved to: ${OUT_DIR}`);
}

main().catch((err) => {
  console.error('visual-audit crashed:', err && err.message ? err.message : err);
  process.exit(1);
});
