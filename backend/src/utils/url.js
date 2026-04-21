'use strict';

// Single source of truth for building URLs that point at the frontend SPA.
// FRONTEND_URL is the public origin of the React app (e.g. https://app.gullybite.com).
// Distinct from BASE_URL, which is the backend origin (e.g. https://gullybite.duckdns.org).

const log = require('./logger').child({ component: 'url' });

const FRONTEND_URL = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');

if (!FRONTEND_URL) {
  log.warn('FRONTEND_URL is not set — redirects to the frontend SPA will throw at call time');
}

function frontendUrl(path = '/', query) {
  if (!FRONTEND_URL) {
    throw new Error('FRONTEND_URL env var is not set; cannot build frontend URL');
  }
  const url = new URL(path, FRONTEND_URL + '/');
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

module.exports = { frontendUrl, FRONTEND_URL };
