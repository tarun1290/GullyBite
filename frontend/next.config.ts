import type { NextConfig } from 'next';
import path from 'path';
import { validateEnv } from './src/lib/validateEnv';

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
  // TODO(pwa): Re-enable PWA support once a Next.js 16-compatible plugin
  // ships. `next-pwa` and `@next-pwa/core` are not Next 16-ready as of this
  // scaffold. Skipped per Part 1 spec instruction.
};

export default nextConfig;
