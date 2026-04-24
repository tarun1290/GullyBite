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

module.exports = slugify;
