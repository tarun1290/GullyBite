'use client';

// Deprecation surface for the legacy per-branch staff URL
// (/staff/{staffAccessToken}). The auth model has shifted to
// store_slug + staff_id + PIN at /staff/login. Anyone landing here
// from an old shared link gets a friendly explanation and a CTA to
// the new login page.
//
// Optional nicety: if the URL token still resolves to a valid branch
// (GET /api/staff/branch-info), surface "Restaurant: <name>" so a
// stranded staffer knows whom to ask. Wrapped in try/catch — if the
// lookup fails the line just doesn't render.

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { getStaffBranchInfo } from '../../../api/staff';

interface PageProps {
  // Next.js 16: dynamic route params come in as a Promise.
  params: Promise<{ staffAccessToken: string }>;
}

export default function StaffDeprecatedTokenPage({ params }: PageProps) {
  const { staffAccessToken } = use(params);
  const [restaurantName, setRestaurantName] = useState<string | null>(null);

  // Best-effort context fetch. We never throw from this branch —
  // a 404 (token unknown) or any other failure simply leaves the
  // restaurant name unset, which collapses the optional line above
  // the deprecation copy.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await getStaffBranchInfo(staffAccessToken);
        if (cancelled) return;
        if (info?.restaurant_name) setRestaurantName(info.restaurant_name);
      } catch {
        /* ignore — render the generic message */
      }
    })();
    return () => { cancelled = true; };
  }, [staffAccessToken]);

  return (
    <main className="bg-bg min-h-screen px-5 sm:px-6 pt-8 pb-12">
      <div className="w-full max-w-md mx-auto bg-surface border border-rim rounded-2xl shadow-md p-6 sm:p-8 text-center">
        {restaurantName && (
          <div className="text-xs text-dim uppercase tracking-wide mb-2">
            Restaurant: {restaurantName}
          </div>
        )}
        <h1 className="text-tx font-semibold text-xl mb-2">
          This staff link has been deprecated
        </h1>
        <p className="text-dim text-sm mb-6">
          Please log in with your Restaurant ID, Staff ID, and PIN. If you
          don&apos;t have these, contact your restaurant owner.
        </p>
        <Link
          href="/staff/login"
          className="inline-block w-full py-3 text-sm text-white bg-acc rounded-lg font-semibold no-underline"
        >
          Go to staff login
        </Link>
      </div>
    </main>
  );
}
