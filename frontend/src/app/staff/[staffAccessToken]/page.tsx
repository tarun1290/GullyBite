'use client';

// The legacy per-branch staff URL (/staff/{staffAccessToken}) is gone.
// Auth is now store_slug + staff_id + PIN at /staff/login. Anyone landing
// here from an old shared link is bounced to the new login page.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function StaffDeprecatedTokenPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/staff/login');
  }, [router]);
  return null;
}
