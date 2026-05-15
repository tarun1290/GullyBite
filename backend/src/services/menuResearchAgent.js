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
const { callLLM, isLLMConfigured, LLMNotConfiguredError } = require('./llmClient');
const { validateAndSplitTags, computePriceBand } = require('./menuTagger');

// Auto-publish confidence threshold. Snapshots scoring at or above this
// across all populated tag fields skip human review.
const AUTO_PUBLISH_THRESHOLD = 0.75;

// Strip ```json ... ``` or ``` ... ``` fences that some models wrap
// JSON in despite jsonMode. Returns the original string if no fence
// is found.
function _stripJsonFences(raw) {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) return fenced[1].trim();
  return trimmed;
}

// Average the per-field confidence numbers the LLM returned. Defensive
// against missing/non-numeric values — returns 0 if nothing usable.
function _avgConfidence(confidence_scores) {
  if (!confidence_scores || typeof confidence_scores !== 'object') return 0;
  const nums = Object.values(confidence_scores).filter((v) => typeof v === 'number' && isFinite(v));
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

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

    // STEP 7 — structured tag extraction via LLM.
    // When CAPTAIN_LLM_PROVIDER is configured, ask the model to extract
    // structured menu items + classification from the scraped text. On
    // any failure (not configured, parse error, network, etc.) we fall
    // through to the existing `needs_review` path below — the job never
    // crashes on LLM trouble.
    let tags = null;
    let confidence_scores = null;
    let median_price_rs = null;
    let extracted_items = null;
    let unknown_tags = null;
    let snapshotStatus = 'needs_review';
    let isLive = false;
    let listingResearchStatus = 'needs_review';

    if (isLLMConfigured()) {
      try {
        const raw_extracted_texts = sources; // [{ url, text }]
        const cityNameForPrompt = cityName || '';
        const restaurantName = listing.name || '';

        // Cap concatenated content to keep token usage bounded; the
        // per-source extractor already caps each text at 4000 chars.
        const MAX_CONTENT_CHARS = 12000;
        let combinedContent = raw_extracted_texts
          .map((s, i) => `--- SOURCE ${i + 1} (${s.url}) ---\n${s.text}`)
          .join('\n\n');
        if (combinedContent.length > MAX_CONTENT_CHARS) {
          combinedContent = combinedContent.slice(0, MAX_CONTENT_CHARS);
        }

        const systemPrompt = 'You are a restaurant menu extraction specialist. Extract structured menu items and classify the restaurant from the provided web content. Respond ONLY with valid JSON. No markdown, no preamble.';

        const userPrompt = [
          `Restaurant: ${restaurantName}`,
          `City: ${cityNameForPrompt}`,
          '',
          'Taxonomy (use ONLY these values for tag fields where applicable):',
          JSON.stringify(taxonomy || {}, null, 2),
          '',
          'Web content extracted from candidate sources:',
          combinedContent,
          '',
          'Return a JSON object with this exact shape:',
          '{',
          '  "tags": {',
          '    "cuisine_primary": [string],',
          '    "vibe_tags": [string],',
          '    "meal_contexts": [string],',
          '    "service_modes": [string],',
          '    "dietary_flags": [string],',
          '    "price_band": "budget"|"mid"|"premium"|"luxury",',
          '    "veg_status": "veg"|"non-veg"|"eggetarian"',
          '  },',
          '  "items": [{ "name": string, "price_rs": number }],',
          '  "median_price_rs": number,',
          '  "confidence_scores": { "<tag_field>": number between 0 and 1 }',
          '}',
        ].join('\n');

        const rawResponse = await callLLM(systemPrompt, userPrompt, { jsonMode: true });
        const cleaned = _stripJsonFences(rawResponse);
        const parsed = JSON.parse(cleaned);

        // Validate + split against the canonical taxonomy.
        const incomingTags = parsed?.tags || {};
        const { validTags, unknownTags } = validateAndSplitTags(incomingTags, taxonomy || {});

        // Compute price band from median (only if model didn't provide
        // a valid one). computePriceBand returns null for bad input.
        const modelMedian = (typeof parsed?.median_price_rs === 'number') ? parsed.median_price_rs : null;
        median_price_rs = modelMedian;
        if (!validTags.price_band) {
          const computed = computePriceBand(modelMedian);
          if (computed) validTags.price_band = computed;
        }

        tags = validTags;
        confidence_scores = (parsed && typeof parsed.confidence_scores === 'object') ? parsed.confidence_scores : null;
        extracted_items = Array.isArray(parsed?.items) ? parsed.items : null;
        unknown_tags = (unknownTags && Object.keys(unknownTags).length > 0) ? unknownTags : null;

        // Auto-publish threshold: average confidence across populated
        // fields must clear the bar. Otherwise still surface to a human.
        const avgConf = _avgConfidence(confidence_scores);
        if (avgConf >= AUTO_PUBLISH_THRESHOLD && (!unknown_tags)) {
          snapshotStatus = 'auto_published';
          isLive = true;
          listingResearchStatus = 'complete';
        } else {
          snapshotStatus = 'needs_review';
          isLive = false;
          listingResearchStatus = 'needs_review';
        }

        log.info(
          { listingId, avgConf, hasUnknownTags: !!unknown_tags, snapshotStatus },
          'llm extraction succeeded',
        );
      } catch (err) {
        if (err instanceof LLMNotConfiguredError) {
          // Defensive — shouldn't reach this branch because of the guard above.
          log.warn({ listingId, err: err.message }, 'llm not configured during extraction (unexpected)');
        } else if (err instanceof SyntaxError) {
          log.warn({ listingId, err: err.message }, 'llm json parse failed — falling back to needs_review');
        } else {
          log.warn({ listingId, err: err.message }, 'llm extraction failed — falling back to needs_review');
        }
        // Reset to safe fallback values.
        tags = null;
        confidence_scores = null;
        median_price_rs = null;
        extracted_items = null;
        unknown_tags = null;
        snapshotStatus = 'needs_review';
        isLive = false;
        listingResearchStatus = 'needs_review';
      }
    } else {
      log.info({ listingId }, 'llm not configured — snapshot will be marked needs_review');
    }

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
      extracted_items,
      median_price_rs,
      unknown_tags,
      status: snapshotStatus,
      is_live: isLive,
      created_at: new Date(),
      schema_version: 1,
    });

    // STEP 9 — update listing. When we auto-publish, also copy tags
    // onto the listing so the discovery queries (which read
    // city_listings.tags.*) immediately reflect the new data.
    const listingUpdate = {
      research_status: listingResearchStatus,
      last_researched_at: new Date(),
      latest_snapshot_id: snapshotId,
    };
    if (snapshotStatus === 'auto_published' && tags) {
      listingUpdate.tags = tags;
    }
    await db.collection('city_listings').updateOne(
      { _id: listingId },
      { $set: listingUpdate },
    );

    log.info({ listingId, snapshotId, sourceCount: sources.length, snapshotStatus }, 'research job complete');
  } catch (err) {
    // Rethrow so BullMQ can apply its retry policy.
    log.error({ listingId, err: err.message, stack: err.stack }, 'research job failed');
    throw err;
  }
}

module.exports = { runResearchJob };
