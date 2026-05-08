#!/usr/bin/env node
'use strict';

// scripts/test-harness/scrape-prorouting-docs.js
//
// One-shot scraper for the public Prorouting Postman docs. The page is
// SPA-rendered and lazy-loads endpoint blocks below the fold, so we drive
// it with headless Chromium, wait for the docs container, then auto-scroll
// until scrollHeight stops growing. Two outputs:
//
//   prorouting-docs.txt              full document.body.innerText
//   prorouting-docs-codeblocks.txt   every <pre> block, separated
//
// Usage:
//   cd backend && node scripts/test-harness/scrape-prorouting-docs.js
//
// Diagnostic only — not wired into any application code path.

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const URL = 'https://documenter.getpostman.com/view/30345080/2sA3Qv8B13';
const OUT_DIR = __dirname;
const TEXT_OUT = path.join(OUT_DIR, 'prorouting-docs.txt');
const CODE_OUT = path.join(OUT_DIR, 'prorouting-docs-codeblocks.txt');

async function findScrollContainer(page) {
  // Postman docs sometimes use the document scrolling root, sometimes a
  // nested scroll container inside <main>. Probe each candidate for an
  // element where scrollHeight > clientHeight + a comfortable margin.
  return await page.evaluate(() => {
    const candidates = [
      document.scrollingElement,
      document.documentElement,
      document.body,
      ...Array.from(document.querySelectorAll('main, [class*="documenter"], [class*="scroll"], [data-testid*="scroll"]')),
    ].filter(Boolean);
    let best = null;
    let bestDelta = 0;
    for (const el of candidates) {
      const delta = (el.scrollHeight || 0) - (el.clientHeight || 0);
      if (delta > bestDelta) {
        bestDelta = delta;
        best = el;
      }
    }
    if (!best) return null;
    // Tag it so we can find it again in subsequent evaluate() calls
    // without re-running the probe (object refs don't survive between
    // calls).
    best.setAttribute('data-scrape-scroll', '1');
    return {
      tag: best.tagName,
      cls: best.className,
      scrollHeight: best.scrollHeight,
      clientHeight: best.clientHeight,
    };
  });
}

async function autoScroll(page, opts = {}) {
  const step = opts.step ?? 300;
  const interval = opts.interval ?? 400;
  const stableTarget = opts.stableTarget ?? 5;
  await page.evaluate(async ({ step, interval, stableTarget }) => {
    const target = document.querySelector('[data-scrape-scroll="1"]')
      || document.scrollingElement
      || document.documentElement;
    await new Promise((resolve) => {
      let lastHeight = 0;
      let stableCount = 0;
      const timer = setInterval(() => {
        const sh = target.scrollHeight;
        target.scrollBy ? target.scrollBy(0, step) : (target.scrollTop += step);
        if (sh === lastHeight) {
          stableCount += 1;
          if (stableCount >= stableTarget) {
            clearInterval(timer);
            resolve();
          }
        } else {
          stableCount = 0;
          lastHeight = sh;
        }
      }, interval);
    });
  }, { step, interval, stableTarget });
}

async function clickAllNavLinks(page) {
  // Postman docs put every endpoint in a left-nav. Clicking each link
  // forces the corresponding section into the DOM even when the
  // viewport-based lazy-loader hasn't reached it. Best-effort — if the
  // selector shape changes we fall back to whatever scrolling captured.
  try {
    const linkCount = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href^="#"]'));
      return links.length;
    });
    if (!linkCount) return 0;
    let clicked = 0;
    for (let i = 0; i < linkCount; i += 1) {
      const ok = await page.evaluate((idx) => {
        const links = Array.from(document.querySelectorAll('a[href^="#"]'));
        const a = links[idx];
        if (!a) return false;
        a.click();
        return true;
      }, i);
      if (ok) {
        clicked += 1;
        // Tiny pause so the click-driven scroll has a chance to mount
        // the target section before we yank the next link.
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    return clicked;
  } catch (_) {
    return 0;
  }
}

(async () => {
  const t0 = Date.now();
  console.log('[scrape] launching headless chromium…');
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1800 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');

    console.log(`[scrape] navigating to ${URL}`);
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60_000 });

    // Wait for the docs to actually render. Try a few likely Postman
    // selectors first; if none of those settle quickly, fall back to a
    // body-length probe.
    const candidateSelectors = [
      '[data-testid="documenter"]',
      '[class*="documenter"]',
      'main',
      'article',
    ];
    let renderedSelector = null;
    for (const sel of candidateSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 8_000 });
        renderedSelector = sel;
        break;
      } catch (_) { /* try next */ }
    }
    if (!renderedSelector) {
      console.log('[scrape] no obvious selector matched — waiting on body length…');
      await page.waitForFunction(
        () => document.body && document.body.innerText && document.body.innerText.length > 5000,
        { timeout: 60_000 }
      );
    } else {
      console.log(`[scrape] container ready (${renderedSelector})`);
    }

    const scrollInfo = await findScrollContainer(page);
    console.log('[scrape] scroll container probe:', JSON.stringify(scrollInfo));

    console.log('[scrape] auto-scrolling pass 1 (slow, gives lazy-mounts time)…');
    await autoScroll(page, { step: 250, interval: 500, stableTarget: 6 });
    await new Promise((r) => setTimeout(r, 2500));

    // Postman docs collapse endpoint sections by default — endpoints appear
    // in the TOC but their bodies (request schemas, examples) only render
    // when the user clicks. Find every "expand" trigger we can identify and
    // click it. Patterns we've seen: aria-expanded="false" buttons, button
    // elements whose text matches a request-method label (POST/GET/etc),
    // and "View More" toggles inside response panels.
    console.log('[scrape] expanding all collapsed sections…');
    const expandStats = await page.evaluate(() => {
      const stats = { ariaExpanded: 0, viewMore: 0, methodButtons: 0 };
      // 1. aria-expanded="false" — generic disclosure pattern
      document.querySelectorAll('[aria-expanded="false"]').forEach((el) => {
        try { el.click(); stats.ariaExpanded += 1; } catch (_) {}
      });
      // 2. "View More" buttons inside long bodies / responses
      Array.from(document.querySelectorAll('button, a')).forEach((el) => {
        const t = (el.innerText || '').trim().toLowerCase();
        if (t === 'view more' || t === 'show more') {
          try { el.click(); stats.viewMore += 1; } catch (_) {}
        }
      });
      // 3. Buttons / clickable rows whose label is a method (POST, GET…)
      //    — these are the endpoint tiles in the TOC. Clicking expands
      //    the corresponding section in the main pane.
      const METHODS = new Set(['POST', 'GET', 'PUT', 'PATCH', 'DELETE']);
      Array.from(document.querySelectorAll('div, span, button, a')).forEach((el) => {
        const t = (el.innerText || el.textContent || '').trim();
        if (METHODS.has(t) && el.offsetParent !== null) {
          try { el.click(); stats.methodButtons += 1; } catch (_) {}
        }
      });
      return stats;
    });
    console.log('[scrape] expand stats:', JSON.stringify(expandStats));
    await new Promise((r) => setTimeout(r, 2500));

    // Second scroll pass after expansion — newly-expanded sections may have
    // their own lazy-loaded children (request examples, response samples)
    // that need scrolling-into-view to render.
    console.log('[scrape] auto-scrolling pass 2 (after expansion)…');
    await autoScroll(page, { step: 250, interval: 500, stableTarget: 6 });
    await new Promise((r) => setTimeout(r, 2000));

    // Repeat expansion — newly mounted sections may themselves contain
    // collapsed sub-sections (e.g. "View More" inside endpoint bodies).
    console.log('[scrape] expanding any second-tier collapsed sections…');
    const expand2 = await page.evaluate(() => {
      let n = 0;
      document.querySelectorAll('[aria-expanded="false"]').forEach((el) => {
        try { el.click(); n += 1; } catch (_) {}
      });
      Array.from(document.querySelectorAll('button, a')).forEach((el) => {
        const t = (el.innerText || '').trim().toLowerCase();
        if (t === 'view more' || t === 'show more') {
          try { el.click(); n += 1; } catch (_) {}
        }
      });
      return n;
    });
    console.log(`[scrape] second-tier expansions: ${expand2}`);
    await new Promise((r) => setTimeout(r, 2000));

    console.log('[scrape] auto-scrolling pass 3 (final settle)…');
    await autoScroll(page, { step: 250, interval: 500, stableTarget: 6 });
    await new Promise((r) => setTimeout(r, 1500));

    // Hash-anchor sweep — for each TOC anchor, navigate via location.hash
    // and wait, then aggressively re-scroll. This forces Postman to mount
    // any section it had skipped by intersection-observer alone.
    console.log('[scrape] sweeping all TOC anchors…');
    const anchorHrefs = await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll('a[href^="#"]'));
      return a.map((el) => el.getAttribute('href')).filter((h) => h && h.length > 1);
    });
    console.log(`[scrape] found ${anchorHrefs.length} anchor hrefs`);
    for (const href of anchorHrefs) {
      try {
        await page.evaluate((h) => {
          const el = document.querySelector(h.replace(/^#/, '#') + ', [id="' + h.slice(1) + '"]');
          if (el && typeof el.scrollIntoView === 'function') {
            el.scrollIntoView({ behavior: 'instant', block: 'start' });
          } else {
            window.location.hash = h;
          }
        }, href);
        await new Promise((r) => setTimeout(r, 600));
      } catch (_) { /* skip broken anchors */ }
    }
    await new Promise((r) => setTimeout(r, 2000));

    // After the anchor sweep, do one more expansion + scroll pass
    console.log('[scrape] post-sweep expansion + scroll…');
    await page.evaluate(() => {
      document.querySelectorAll('[aria-expanded="false"]').forEach((el) => {
        try { el.click(); } catch (_) {}
      });
      Array.from(document.querySelectorAll('button, a')).forEach((el) => {
        const t = (el.innerText || '').trim().toLowerCase();
        if (t === 'view more' || t === 'show more') {
          try { el.click(); } catch (_) {}
        }
      });
    });
    await new Promise((r) => setTimeout(r, 1500));
    await autoScroll(page, { step: 250, interval: 500, stableTarget: 6 });
    await new Promise((r) => setTimeout(r, 1500));

    console.log('[scrape] extracting text…');
    const innerText = await page.evaluate(() => document.body.innerText || '');
    const codeBlocks = await page.evaluate(() => {
      const out = [];
      const nodes = document.querySelectorAll('pre');
      nodes.forEach((n, i) => {
        const txt = (n.innerText || n.textContent || '').trim();
        if (txt) out.push(`===== BLOCK ${i + 1} =====\n${txt}`);
      });
      return out.join('\n\n');
    });

    fs.writeFileSync(TEXT_OUT, innerText, 'utf8');
    fs.writeFileSync(CODE_OUT, codeBlocks, 'utf8');

    const textLines = innerText.split('\n').length;
    const codeBlockCount = (codeBlocks.match(/===== BLOCK /g) || []).length;
    console.log(`[scrape] wrote ${TEXT_OUT}  (${textLines} lines, ${innerText.length} chars)`);
    console.log(`[scrape] wrote ${CODE_OUT}  (${codeBlockCount} blocks, ${codeBlocks.length} chars)`);
    console.log(`[scrape] done in ${Date.now() - t0} ms`);
  } catch (e) {
    console.error('[scrape] FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
