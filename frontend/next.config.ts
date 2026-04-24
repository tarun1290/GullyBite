import type { NextConfig } from 'next';
import path from 'node:path';

// API base for client-side calls. Read here so the value is captured at build
// time and surfaces in the bundle for client components via process.env.
// Reference: NEXT_PUBLIC_API_BASE_URL in .env.local.
const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
if (!apiBaseUrl && process.env.NODE_ENV === 'production') {
  console.warn('[next.config] NEXT_PUBLIC_API_BASE_URL is not set');
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin Turbopack's workspace root to this project — without this, multiple
  // lockfiles in ancestor directories cause Turbopack to walk up to $HOME.
  turbopack: { root: path.resolve(__dirname) },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**.cloudfront.net' },
      { protocol: 'https', hostname: 'gullybite.duckdns.org' },
      { protocol: 'https', hostname: '**.fbcdn.net' },
      { protocol: 'https', hostname: '**.whatsapp.net' },
    ],
  },
  // TODO(pwa): Re-enable PWA support once a Next.js 16-compatible plugin
  // ships. `next-pwa` and `@next-pwa/core` are not Next 16-ready as of this
  // scaffold. Skipped per Part 1 spec instruction.
};

export default nextConfig;
