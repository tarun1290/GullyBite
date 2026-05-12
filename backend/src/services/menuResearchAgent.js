// src/services/menuResearchAgent.js
// Menu research agent — for a given city listing, runs 2 Google Custom
// Search queries, fetches the top non-blocked candidate pages (respecting
// robots.txt), extracts readable text via cheerio, and writes a
// `menu_snapshots` doc plus updates the listing's research_status.
//
// Structured tag extraction is not yet wired up — see the placeholder
// marker in runResearchJob (step 7) for where that call will live. For
// now the snapshot is stored with status='needs_review' so a human (or
// future extraction job) can finish it.

'use strict';

const cheerio = require('cheerio');
const robotsParser = require('robots-parser');
const { newId } = require('../config/database');
const log = require('../utils/logger').child({ component: 'menuResearchAgent' });

// ─── CONSTANTS ──────────────────────────────────────────────────────
const BLOCK_DOMAINS = [
  'zomato.com',
  'swiggy.com',
  'instagram.com',
  'facebook.com',
  'twitter.com',
  'youtube.com',
];

const UA = 'Mozilla/5.0 (compatible; GullyBiteBot/1.0; +https://gullybite.in/bot)';

const REDIS_KEY = 'captain:taxonomy';

// ─── HELPERS ────────────────────────────────────────────────────────
// Native fetch with an AbortController-backed timeout. Caller is
// responsible for try/catching network failures.
async function fetchWithTimeout(url, ms, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

// hostname.endsWith(domain) — so www.zomato.com and m.zomato.com both
// match 'zomato.com'. Returns true if the URL is on the block list or
// fails to parse (defensive: skip junk URLs).
function isBlocked(rawUrl) {
  let host;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return true;
  }
  return BLOCK_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
}

// Run one Google Custom Search query. On any failure (timeout, non-2xx,
// throw, malformed JSON) returns []. Never throws.
async function googleSearch(query, apiKey, cxId) {
  const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cxId}&q=${encodeURIComponent(query)}&num=5`;
  try {
    const resp = await fetchWithTimeout(url, 6000);
    if (!resp.ok) {
      log.warn({ query, status: resp.status }, 'google search non-2xx');
      return [];
    }
    const body = await resp.json();
    const items = Array.isArray(body.items) ? body.items : [];
    return items.map((it) => it.link).filter((u) => typeof u === 'string' && u);
  } catch (e) {
    log.warn({ query, err: e.message }, 'google search failed');
    return [];
  }
}

// Fetch a page's robots.txt (4s, fail-open) and check if the target URL
// is allowed for our UA wildcard. Returns true if allowed OR if
// robots.txt could not be fetched/was empty.
async function isRobotsAllowed(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
  let robotsTxt = '';
  try {
    const r = await fetchWithTimeout(robotsUrl, 4000);
    if (r.ok) robotsTxt = await r.text();
  } catch (e) {
    // Fail open — many sites either don't serve robots.txt or block our
    // probe entirely. Returning false here would gut the agent.
  }
  if (!robotsTxt) return true;
  const robots = robotsParser(robotsUrl, robotsTxt);
  return robots.isAllowed(rawUrl, '*') !== false;
}

// Fetch a page (8s) and return cleaned, length-capped text. Returns
// null on any failure or if the extracted text is too thin to be
// useful (<100 chars).
async function fetchAndExtract(rawUrl) {
  let html;
  try {
    const resp = await fetchWithTimeout(rawUrl, 8000, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    if (!resp.ok) {
      log.info({ url: rawUrl, status: resp.status }, 'page fetch non-2xx');
      return null;
    }
    html = await resp.text();
  } catch (e) {
    log.info({ url: rawUrl, err: e.message }, 'page fetch failed');
    return null;
  }

  const $ = cheerio.load(html);
  $('script, style, nav, footer').remove();
  const parts = [];
  $('p, li, td, h1, h2, h3, span').each((_, el) => {
    const t = $(el).text().trim();
    if (t) parts.push(t);
  });
  let text = parts.join('\n').replace(/\s+/g, ' ').trim();
  if (text.length > 4000) text = text.slice(0, 4000);
  if (text.length < 100) return null;
  return text;
}

// ─── MAIN ENTRY ─────────────────────────────────────────────────────
async function runResearchJob(db, redisClient, listingId) {
  try {
    // STEP 0 — env guard. Without Google credentials we can't make any
    // progress, so warn-and-return rather than throw (a thrown job
    // would just keep getting retried by BullMQ).
    if (!process.env.GOOGLE_SEARCH_API_KEY || !process.env.GOOGLE_SEARCH_CX_ID) {
      log.warn({ listingId }, 'missing GOOGLE_SEARCH_API_KEY or GOOGLE_SEARCH_CX_ID — skipping research');
      return;
    }

    // STEP 1 — fetch the listing and short-circuit on missing or
    // already-complete docs.
    const listing = await db.collection('city_listings').findOne({ _id: listingId });
    if (!listing) {
      log.warn({ listingId }, 'listing not found');
      return;
    }
    if (listing.research_status === 'complete') {
      log.info({ listingId }, 'already complete');
      return;
    }
    const city = await db.collection('cities').findOne({ _id: listing.city_id });

    // STEP 2 — taxonomy from Redis cache (30 min TTL), falling back to
    // platform_settings. Reserved for the extraction step (see step 7);
    // presence-only for now.
    let taxonomy = null;
    try {
      const cached = await redisClient.get(REDIS_KEY);
      if (cached) taxonomy = JSON.parse(cached);
    } catch (e) {
      log.warn({ err: e.message }, 'taxonomy cache read failed');
    }
    if (!taxonomy) {
      taxonomy = await db.collection('platform_settings').findOne({ _id: 'tag_taxonomy' });
      if (taxonomy) {
        try {
          await redisClient.set(REDIS_KEY, JSON.stringify(taxonomy), 'EX', 30 * 60);
        } catch (e) {
          log.warn({ err: e.message }, 'taxonomy cache write failed');
        }
      }
    }
    // taxonomy is reserved for the extraction step — currently unused beyond presence.

    // STEP 3 — build 2 queries.
    const cityName = city?.name || '';
    const area = listing.area || '';
    const q1 = `${listing.name} ${area} ${cityName} menu`.trim();
    const q2 = `${listing.name} ${cityName} review`.trim();

    // STEP 4 — Google Custom Search, dedupe, filter blocked domains, cap at 6.
    const allLinks = [];
    for (const q of [q1, q2]) {
      const links = await googleSearch(q, process.env.GOOGLE_SEARCH_API_KEY, process.env.GOOGLE_SEARCH_CX_ID);
      for (const l of links) allLinks.push(l);
    }
    const seen = new Set();
    const candidates = [];
    for (const url of allLinks) {
      if (seen.has(url)) continue;
      seen.add(url);
      if (isBlocked(url)) continue;
      candidates.push(url);
      if (candidates.length >= 6) break;
    }

    // STEP 5 — robots check + cheerio extract, capped at 4 successful sources.
    const sources = [];
    for (const rawUrl of candidates) {
      const allowed = await isRobotsAllowed(rawUrl);
      if (!allowed) {
        log.info({ url: rawUrl }, 'robots-disallowed; skipping');
        continue;
      }
      const text = await fetchAndExtract(rawUrl);
      if (!text) continue;
      sources.push({ url: rawUrl, text });
      if (sources.length >= 4) break;
    }

    // STEP 6 — zero-source path. Still write a snapshot so we have a
    // record of the attempt, and update the listing so it doesn't get
    // re-picked-up immediately.
    if (sources.length === 0) {
      const snapshotId = newId();
      await db.collection('menu_snapshots').insertOne({
        _id: snapshotId,
        listing_id: listing._id,
        city_id: listing.city_id,
        source: 'web_research',
        sources_cited: [],
        raw_extracted_texts: [],
        tags: null,
        confidence_scores: null,
        status: 'no_content_found',
        is_live: false,
        created_at: new Date(),
        schema_version: 1,
      });
      await db.collection('city_listings').updateOne(
        { _id: listingId },
        { $set: { research_status: 'no_content_found', last_researched_at: new Date(), latest_snapshot_id: snapshotId } },
      );
      log.info({ listingId, snapshotId }, 'no content found — snapshot stored');
      return;
    }

    // STEP 7 — placeholder for structured extraction.
    // LLM_HOOK: structured tag extraction would call out to the LLM here,
    // passing `sources` + `taxonomy` and receiving back `tags` +
    // `confidence_scores`. Until then, store raw_extracted_texts and mark
    // the snapshot needs_review so a human (or future extraction job) can finish.
    const tags = null;
    const confidence_scores = null;

    // STEP 8 — insert menu_snapshot.
    const snapshotId = newId();
    await db.collection('menu_snapshots').insertOne({
      _id: snapshotId,
      listing_id: listing._id,
      city_id: listing.city_id,
      source: 'web_research',
      sources_cited: sources.map((s) => s.url),
      raw_extracted_texts: sources, // each { url, text }
      tags,
      confidence_scores,
      status: 'needs_review',
      is_live: false,
      created_at: new Date(),
      schema_version: 1,
    });

    // STEP 9 — update listing.
    await db.collection('city_listings').updateOne(
      { _id: listingId },
      { $set: { research_status: 'needs_review', last_researched_at: new Date(), latest_snapshot_id: snapshotId } },
    );

    log.info({ listingId, snapshotId, sourceCount: sources.length }, 'research job complete');
  } catch (err) {
    // Rethrow so BullMQ can apply its retry policy.
    log.error({ listingId, err: err.message, stack: err.stack }, 'research job failed');
    throw err;
  }
}

module.exports = { runResearchJob };
