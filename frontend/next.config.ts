import type { NextConfig } from 'next';
import path from 'path';
import { validateEnv } from './src/lib/validateEnv';

console.log('🔧 BUILD ENV:', process.env.NEXT_PUBLIC_API_BASE_URL);

// API base for client-side calls. Read here so the value is captured at build
// time and surfaces in the bundle for client components via process.env.
// Reference: NEXT_PUBLIC_API_BASE_URL in .env.local.
//
// Hard-fail production builds when the API base is missing or non-HTTPS so
// a misconfigured Vercel env can't ship a bundle that 404s against the
// Vercel origin or downgrades requests to plain HTTP.
if (process.env.NODE_ENV === 'production') {
  validateEnv();
}

// Repo root — one level above frontend/. Used for both Turbopack's workspace
// root (so it stops walking up to $HOME when it sees ancestor lockfiles) and
// Next.js's file-trace root (so build output can reach shared assets and the
// monorepo lockfile). Both must point to the same place to keep dev and build
// in sync.
const repoRoot = path.resolve(__dirname, '..');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**.cloudfront.net' },
      { protocol: 'https', hostname: 'gullybite.duckdns.org' },
      { protocol: 'https', hostname: '**.fbcdn.net' },
      { protocol: 'https', hostname: '**.whatsapp.net' },
    ],
  },
  async headers() {
    return [
      {
        // Disable CDN/browser caching for ALL HTML pages.
        // HTML must always be fetched fresh because it references JS chunk
        // hashes that change with every deploy. Stale HTML → 404 on chunks.
        source: '/:path*',
        has: [
          {
            type: 'header',
            key: 'accept',
            value: '.*text/html.*',
          },
        ],
        headers: [
          {
            key: 'Cache-Control',
            value: 'no-store, no-cache, must-revalidate, max-age=0',
          },
          {
            key: 'CDN-Cache-Control',
            value: 'no-store',
          },
          {
            key: 'Vercel-CDN-Cache-Control',
            value: 'no-store',
          },
        ],
      },
      {
        // Static assets under /_next/static are hash-named and immutable.
        // Keep them aggressively cached to avoid breaking page-load perf.
        // (Next.js sets this by default but we make it explicit so future
        // edits don't accidentally drop it.)
        source: '/_next/static/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
    ];
  },
  // TODO(pwa): Re-enable PWA support once a Next.js 16-compatible plugin
  // ships. `next-pwa` and `@next-pwa/core` are not Next 16-ready as of this
  // scaffold. Skipped per Part 1 spec instruction.
};

export default nextConfig;
