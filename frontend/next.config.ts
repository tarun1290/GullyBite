import type { NextConfig } from 'next';
import path from 'path';

// API base for client-side calls. Read here so the value is captured at build
// time and surfaces in the bundle for client components via process.env.
// Reference: NEXT_PUBLIC_API_BASE_URL in .env.local.
const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
if (!apiBaseUrl && process.env.NODE_ENV === 'production') {
  console.warn('[next.config] NEXT_PUBLIC_API_BASE_URL is not set');
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
  // TODO(pwa): Re-enable PWA support once a Next.js 16-compatible plugin
  // ships. `next-pwa` and `@next-pwa/core` are not Next 16-ready as of this
  // scaffold. Skipped per Part 1 spec instruction.
};

export default nextConfig;
