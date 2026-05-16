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
  '/dashboard/marketing-analytics': '/dashboard/analytics',
  // /dashboard/campaigns was renamed to /dashboard/marketing (canonical
  // Marketing workspace; absorbed the old hub's Coupons + Messages tabs).
  '/dashboard/campaigns': '/dashboard/marketing',
  // Phase-2 consolidation: these standalone routes are now tabs inside
  // /dashboard/marketing (captain-listing merged into the Referrals tab).
  '/dashboard/customers': '/dashboard/marketing',
  '/dashboard/loyalty': '/dashboard/marketing',
  '/dashboard/referrals': '/dashboard/marketing',
  '/dashboard/captain-listing': '/dashboard/marketing',
  '/dashboard/dine-in': '/dashboard/marketing',
  // Admin: coupon-codes folded into /admin/coupons as the "Codes" tab.
  '/admin/coupon-codes': '/admin/coupons',
};

// Prefix redirects: any path at or under the key (e.g. a sub-path like
// /dashboard/restaurant/anything) redirects to the value.
const PREFIX_REDIRECTS: ReadonlyArray<readonly [string, string]> = [
  ['/dashboard/restaurant/', '/dashboard/settings'],
  ['/dashboard/penalties/', '/dashboard/payments'],
  // Defensive: marketing-analytics removed; any sub-path → analytics.
  ['/dashboard/marketing-analytics/', '/dashboard/analytics'],
  // campaigns/ renamed to marketing/; any sub-path → marketing.
  ['/dashboard/campaigns/', '/dashboard/marketing'],
  // Phase-2 consolidation: folded into /dashboard/marketing tabs.
  ['/dashboard/customers/', '/dashboard/marketing'],
  ['/dashboard/loyalty/', '/dashboard/marketing'],
  ['/dashboard/referrals/', '/dashboard/marketing'],
  ['/dashboard/captain-listing/', '/dashboard/marketing'],
  ['/dashboard/dine-in/', '/dashboard/marketing'],
  // Admin: coupon-codes folded into /admin/coupons "Codes" tab.
  ['/admin/coupon-codes/', '/admin/coupons'],
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
    '/dashboard/marketing-analytics',
    '/dashboard/marketing-analytics/:path*',
    '/dashboard/campaigns',
    '/dashboard/campaigns/:path*',
    '/dashboard/customers',
    '/dashboard/customers/:path*',
    '/dashboard/loyalty',
    '/dashboard/loyalty/:path*',
    '/dashboard/referrals',
    '/dashboard/referrals/:path*',
    '/dashboard/captain-listing',
    '/dashboard/captain-listing/:path*',
    '/dashboard/dine-in',
    '/dashboard/dine-in/:path*',
    '/admin/coupon-codes',
    '/admin/coupon-codes/:path*',
  ],
};
