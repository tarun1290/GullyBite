import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// NOTE: In Next.js 16 the `middleware` file convention is deprecated and
// renamed to `proxy` (see node_modules/next/dist/docs/.../proxy.md). A
// `middleware.ts` file would be ignored, so all legacy → canonical
// dashboard route redirects are consolidated here as permanent (308)
// redirects.

// Exact-path redirects: the request pathname must match the key exactly.
const EXACT_REDIRECTS: Record<string, string> = {
  '/dashboard/ratings': '/dashboard/reputation',
  '/dashboard/feedback': '/dashboard/reputation',
  '/dashboard/restaurant': '/dashboard/settings',
  '/dashboard/penalties': '/dashboard/payments',
};

// Prefix redirects: any path at or under the key (e.g. a sub-path like
// /dashboard/restaurant/anything) redirects to the value.
const PREFIX_REDIRECTS: ReadonlyArray<readonly [string, string]> = [
  ['/dashboard/restaurant/', '/dashboard/settings'],
  ['/dashboard/penalties/', '/dashboard/payments'],
];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const exact = EXACT_REDIRECTS[pathname];
  if (exact) {
    return NextResponse.redirect(new URL(exact, request.url), 308);
  }

  for (const [prefix, target] of PREFIX_REDIRECTS) {
    if (pathname.startsWith(prefix)) {
      return NextResponse.redirect(new URL(target, request.url), 308);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/dashboard/ratings',
    '/dashboard/feedback',
    '/dashboard/restaurant',
    '/dashboard/restaurant/:path*',
    '/dashboard/penalties',
    '/dashboard/penalties/:path*',
  ],
};
