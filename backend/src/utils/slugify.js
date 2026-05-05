// src/utils/slugify.js
// Canonical URL-safe slug builder. Replaces 8 inline copies that previously
// existed across routes / services / integrations / scripts.
//
// NOT used by services/username.js — that file's slugify is intentionally
// different (underscore separator, apostrophe stripping, 30-char cap) to
// satisfy Meta's WhatsApp Business username rules ([a-z0-9_] only). Keeping
// it local avoids breaking username generation.

'use strict';

/**
 * Convert a string to a URL-safe, hyphen-separated slug.
 *
 * - Lowercases + trims
 * - Strips Unicode accents via NFD normalisation (café → cafe)
 * - Replaces any non-[a-z0-9] run with a single hyphen
 * - Trims leading / trailing hyphens
 * - Truncates to maxLen (default 40)
 *
 * @param {string} str
 * @param {number} [maxLen=40]
 * @returns {string}
 */
function slugify(str, maxLen = 40) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
}

/**
 * Restaurant-name-specific slug builder. Used for `restaurants.store_slug`
 * (the public storefront URL segment). Distinct from `slugify()` above
 * because the rules differ:
 *   - Strict null-return on falsy / non-string input (callers gate on this
 *     to fall back to a placeholder slug like 'my-restaurant').
 *   - "&" → " and " before stripping (so "Biryani & Co" → "biryani-and-co",
 *     not "biryani-co"). slugify() would collapse the & into a hyphen and
 *     lose the conjunction entirely.
 *   - Returns null when the result has no [a-z0-9] char — names that are
 *     pure punctuation / emoji shouldn't yield a hyphen-only slug.
 *
 * SINGLE source of truth for restaurant store slugs. The frontend's
 * `_slugify()` helper in index.html MUST stay in sync with the regex /
 * length rules below; changing either one without the other breaks the
 * preview slug shown during onboarding.
 *
 * @param {string} name
 * @returns {string|null}
 */
function slugifyRestaurantName(name) {
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

module.exports = slugify;
module.exports.slugifyRestaurantName = slugifyRestaurantName;
