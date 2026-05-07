'use client';

// Web-staff login. Reached via the per-branch shareable URL
// {FRONTEND_URL}/staff/{staffAccessToken} (generated from the owner
// dashboard's BranchStaffLinkPanel).
//
// Flow:
//   1. If a 'staff_web_token' is already in localStorage, redirect to
//      ./orders. (Token expiry is handled there — orders page sees a
//      401, clears the token, and bounces the user back here.)
//   2. On Android, surface an "Open in App" button that uses the
//      gullybite-staff:// scheme handed off to the native APK. The
//      web form stays visible underneath as the fallback for users
//      who don't have the app installed.
//   3. Submit name + 4-digit PIN to POST /api/staff/auth, store the
//      returned JWT, navigate to ./orders.

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { staffWebLogin } from '../../../api/staff';
import {
  getStaffToken,
  setStaffToken,
} from '../../../lib/staffApiClient';

interface PageProps {
  // Next.js 16: dynamic route params come in as a Promise.
  params: Promise<{ staffAccessToken: string }>;
}

function isAndroid(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android/i.test(navigator.userAgent || '');
}

export default function StaffLoginPage({ params }: PageProps) {
  const { staffAccessToken } = use(params);
  const router = useRouter();

  const [name, setName] = useState<string>('');
  const [pin, setPin] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [showAndroid, setShowAndroid] = useState<boolean>(false);

  // Already-signed-in short-circuit + Android deep-link surfacing.
  useEffect(() => {
    if (getStaffToken()) {
      router.replace(`/staff/${encodeURIComponent(staffAccessToken)}/orders`);
      return;
    }
    setShowAndroid(isAndroid());
  }, [router, staffAccessToken]);

  const onOpenInApp = () => {
    // Mirror the URL shape the staff-app's expo-linking handler reads
    // (see staff-app/app/_layout.tsx). The native app strips its scheme
    // prefix and persists the token via expo-secure-store.
    const deepLink = `gullybite-staff://staff/${encodeURIComponent(staffAccessToken)}`;
    window.location.href = deepLink;
  };

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return;
    if (!name.trim()) {
      setError('Please enter your name');
      return;
    }
    if (!/^\d{4}$/.test(pin)) {
      setError('PIN must be exactly 4 digits');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await staffWebLogin(staffAccessToken, name.trim(), pin);
      setStaffToken(res.token);
      router.replace(`/staff/${encodeURIComponent(staffAccessToken)}/orders`);
    } catch (err: unknown) {
      const e2 = err as { userMessage?: string | null; response?: { data?: { error?: string } }; message?: string };
      setError(e2?.userMessage || e2?.response?.data?.error || e2?.message || 'Login failed');
      setSubmitting(false);
    }
  };

  return (
    <main className="flex-1 flex items-center justify-center p-6">
      <div className="w-full max-w-[380px] bg-ink2 border border-rim rounded-xl p-6 shadow-[0_8px_24px_rgba(0,0,0,0.18)]">
        <h1 className="m-0 text-[1.25rem] font-semibold">
          GullyBite Staff
        </h1>
        <p className="mt-[0.4rem] mb-[1.2rem] text-dim text-[0.85rem]">
          Sign in with your name and 4-digit PIN.
        </p>

        {showAndroid && (
          <div className="mb-4">
            <button
              type="button"
              onClick={onOpenInApp}
              className="w-full py-[0.7rem] text-[0.95rem] bg-green-600 text-white border-0 rounded-lg cursor-pointer font-semibold"
            >
              Open in GullyBite Staff App
            </button>
            <div className="flex items-center gap-2 my-4 text-dim text-[0.75rem]">
              <div className="flex-1 h-px bg-rim" />
              <span>or sign in here</span>
              <div className="flex-1 h-px bg-rim" />
            </div>
          </div>
        )}

        <form onSubmit={onSubmit}>
          <label className="block text-[0.78rem] text-dim mb-[0.3rem]">
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            disabled={submitting}
            className="w-full py-[0.6rem] px-[0.7rem] text-[0.95rem] bg-ink border border-rim rounded-lg text-fg mb-[0.9rem]"
          />

          <label className="block text-[0.78rem] text-dim mb-[0.3rem]">
            PIN
          </label>
          <input
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={4}
            placeholder="••••"
            disabled={submitting}
            className="w-full py-[0.6rem] px-[0.7rem] text-[1.2rem] tracking-[0.4em] text-center bg-ink border border-rim rounded-lg text-fg mb-[0.9rem]"
          />

          {error && (
            <div className="py-2 px-[0.7rem] mb-[0.8rem] bg-[rgba(220,38,38,0.12)] border border-[rgba(220,38,38,0.4)] text-[#fca5a5] rounded-lg text-[0.82rem]">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className={`w-full py-[0.7rem] text-[0.95rem] text-white border-0 rounded-lg font-semibold ${submitting ? 'bg-rim cursor-default' : 'bg-green-600 cursor-pointer'}`}
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  );
}
