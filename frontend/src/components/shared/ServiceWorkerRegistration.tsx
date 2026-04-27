'use client';

// Registers /sw.js on mount and self-updates whenever the page regains
// focus. Renders nothing. Mounted once in the root layout.
//
// Update flow: a Vercel deploy serves a new sw.js (Cache-Control: max-age=0
// in next.config.ts). On focus we call registration.update(); the browser
// fetches the new file and detects the byte diff. The new worker installs
// and we post SKIP_WAITING + reload so the page picks it up immediately
// instead of waiting for all tabs to close.

import { useEffect } from 'react';

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        console.log('[SW] Registered:', registration.scope);

        // Refresh the registration whenever the page regains focus.
        const onFocus = () => {
          registration.update().catch(() => {});
        };
        window.addEventListener('focus', onFocus);

        // When a new SW is waiting, activate it immediately.
        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (
              newWorker.state === 'installed' &&
              navigator.serviceWorker.controller
            ) {
              // New version available — post SKIP_WAITING so it activates,
              // then reload so the page picks up the new bundles.
              newWorker.postMessage({ type: 'SKIP_WAITING' });
              window.location.reload();
            }
          });
        });
      })
      .catch((err) => console.error('[SW] Registration failed:', err));
  }, []);

  return null;
}
