// GullyBite dashboard service worker.
//
// Strategy summary:
//   - API requests (EC2, /api/*, Meta Graph) → network-only, never cached
//   - Static assets (JS/CSS/img/font) → cache-first
//   - HTML navigation → network-first with /offline fallback
//
// Lives in /public/sw.js so it ships unprocessed by the Next.js build —
// every Vercel deploy serves a fresh copy. The Cache-Control: max-age=0
// header (set in next.config.ts) ensures browsers re-fetch it whenever
// the page regains focus, and the registration component reloads the
// page when a new version installs.

/* eslint-disable no-restricted-globals */

const CACHE_NAME = 'gullybite-static-v1';
const OFFLINE_URL = '/offline';

// Assets to precache on install
const PRECACHE_ASSETS = [
  '/',
  '/offline',
];

// Never cache these — always go to network
const NETWORK_ONLY_PATTERNS = [
  'gullybite.duckdns.org',
  '/api/',
  'graph.facebook.com',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      // Delete old caches
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      ),
      self.clients.claim(),
    ])
  );
});

self.addEventListener('fetch', (event) => {
  // Network-only for API calls — never serve from cache
  const isNetworkOnly = NETWORK_ONLY_PATTERNS.some(
    (pattern) => event.request.url.includes(pattern)
  );
  if (isNetworkOnly) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Cache-first for static assets
  if (
    event.request.destination === 'script' ||
    event.request.destination === 'style' ||
    event.request.destination === 'image' ||
    event.request.destination === 'font'
  ) {
    event.respondWith(
      caches.match(event.request).then((cached) =>
        cached || fetch(event.request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        })
      )
    );
    return;
  }

  // Network-first for navigation (HTML pages) with offline fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match(OFFLINE_URL).then((res) => res || caches.match('/'))
      )
    );
    return;
  }

  // Default: network
  event.respondWith(fetch(event.request));
});

// Listen for SKIP_WAITING from the registration component so a newly
// installed worker activates without waiting for all tabs to close.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
