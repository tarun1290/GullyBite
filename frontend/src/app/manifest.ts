import type { MetadataRoute } from 'next';

// PWA manifest. Next.js auto-serves this at /manifest.webmanifest with the
// correct Content-Type. Brand colors and copy mirror the legacy
// public/manifest.json (deleted) so installed PWAs keep the same chrome
// across the cutover.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'GullyBite Dashboard',
    short_name: 'GullyBite',
    description: 'Restaurant management dashboard — orders, menu, settlements',
    start_url: '/dashboard',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#FAF8F3',
    theme_color: '#0D9B6A',
    // The same PNG serves both `any` and `maskable` — we baked the
    // ~80% safe-area inset at icon-generation time. Next.js's
    // MetadataRoute.Manifest type only accepts one purpose per entry,
    // so we declare two entries per size.
    icons: [
      { src: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
