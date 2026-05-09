'use client';

// Web-staff login. Reached via the per-branch shareable URL
// {FRONTEND_URL}/staff/{staffAccessToken} (generated from the owner
// dashboard's BranchStaffLinkPanel).
//
// Flow:
//   1. On mount, hit GET /api/staff/branch-info to resolve the token
//      to its display context. While the lookup is in flight we render
//      a centered loading state. A 404 means the token is not on any
//      branch — render "This link is invalid or expired" and stop.
//   2. If a 'staff_web_token' is already in localStorage, redirect to
//      ./orders. (Token expiry is handled there — orders page sees a
//      401, clears the token, and bounces the user back here.)
//   3. On Android, surface an "Open in App" button that uses the
//      gullybite-staff:// scheme handed off to the native APK. The
//      web form stays visible underneath as the fallback for users
//      who don't have the app installed.
//   4. Submit name + 4-digit PIN to POST /api/staff/auth, store the
//      returned JWT, navigate to ./orders. Auto-submits the moment a
//      4th PIN digit is entered (only when the name field is also
//      filled — otherwise the inline name validation fires instead).

import { use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { staffWebLogin, getStaffBranchInfo, type StaffBranchInfo } from '../../../api/staff';
import {
  getStaffToken,
  setStaffToken,
} from '../../../lib/staffApiClient';

interface PageProps {
  // Next.js 16: dynamic route params come in as a Promise.
  params: Promise<{ staffAccessToken: string }>;
}

// Discriminated union for the branch-info lookup. `idle` is the
// pre-fetch transient state, `invalid` is a 404 from the backend
// (token doesn't match any branch), `error` is anything else.
type BranchInfoState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: StaffBranchInfo }
  | { kind: 'invalid' }
  | { kind: 'error'; message: string };

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
  const [branchInfo, setBranchInfo] = useState<BranchInfoState>({ kind: 'loading' });

  // Already-signed-in short-circuit + Android deep-link surfacing.
  useEffect(() => {
    if (getStaffToken()) {
      router.replace(`/staff/${encodeURIComponent(staffAccessToken)}/orders`);
      return;
    }
    setShowAndroid(isAndroid());
  }, [router, staffAccessToken]);

  // localStorage key note: the JWT is persisted under 'staff_web_token'
  // via setStaffToken (see lib/staffApiClient.ts). The original spec
  // suggested 'staff_token', renamed here so the staff orders/menu
  // pages — which consume the same key through staffClient — keep
  // working without a parallel migration. Single source of truth =
  // STAFF_TOKEN_KEY in staffApiClient.

  // Fetch branch context. 404 → invalid-link surface (the rest of the
  // form is hidden in that branch); other failures fall through to
  // generic-error and still let the user attempt PIN entry — better
  // than locking them out on a transient 5xx if their token IS valid.
  useEffect(() => {
    let cancelled = false;
    setBranchInfo({ kind: 'loading' });
    getStaffBranchInfo(staffAccessToken)
      .then((data) => {
        if (cancelled) return;
        setBranchInfo({ kind: 'ready', data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const e = err as { response?: { status?: number; data?: { error?: string } }; message?: string };
        if (e?.response?.status === 404) {
          setBranchInfo({ kind: 'invalid' });
          return;
        }
        setBranchInfo({
          kind: 'error',
          message: e?.response?.data?.error || e?.message || 'Could not load branch info',
        });
      });
    return () => { cancelled = true; };
  }, [staffAccessToken]);

  const onOpenInApp = () => {
    // Mirror the URL shape the staff-app's expo-linking handler reads
    // (see staff-app/app/_layout.tsx). The native app strips its scheme
    // prefix and persists the token via expo-secure-store.
    const deepLink = `gullybite-staff://staff/${encodeURIComponent(staffAccessToken)}`;
    window.location.href = deepLink;
  };

  // Pure submit logic — accepts explicit name+pin so auto-submit can
  // call it with the freshly-entered PIN value before React's state
  // batch has flushed (relying on `pin` state inside an onChange would
  // see the previous value).
  const submitLogin = useCallback(async (submittedName: string, submittedPin: string) => {
    if (submitting) return;
    if (!submittedName.trim()) {
      setError('Please enter your name');
      return;
    }
    if (!/^\d{4}$/.test(submittedPin)) {
      setError('PIN must be exactly 4 digits');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await staffWebLogin(staffAccessToken, submittedName.trim(), submittedPin);
      setStaffToken(res.token);
      router.replace(`/staff/${encodeURIComponent(staffAccessToken)}/orders`);
    } catch (err: unknown) {
      const e2 = err as { response?: { status?: number }; message?: string };
      if (e2?.response?.status === 401) {
        setError('Invalid name or PIN');
      } else {
        setError('Something went wrong, try again.');
      }
      setSubmitting(false);
    }
  }, [router, staffAccessToken, submitting]);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void submitLogin(name, pin);
  };

  // PIN onChange normaliser. Strips non-digits and caps at 4. When the
  // 4th digit lands and the name is filled, auto-submits — eliminates
  // a final tap on tablets where the operator's hands are full. If
  // name is empty we leave the PIN value set and let the operator
  // either type their name or hit Sign in (which surfaces the inline
  // name-required error).
  const onPinChange = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, 4);
    setPin(digits);
    if (digits.length === 4 && name.trim() && !submitting) {
      void submitLogin(name, digits);
    }
  };

  const apkUrl = process.env.NEXT_PUBLIC_STAFF_APK_URL;
  const banner = showAndroid && apkUrl ? (
    <div className="w-full bg-[#25D366] flex items-center justify-between px-4 py-3">
      <div className="font-semibold text-white text-sm">
        <span className="mr-2">📲</span>Get the GullyBite Staff App
      </div>
      <div className="flex flex-col items-end gap-1">
        <a
          href={apkUrl}
          download
          className="bg-white text-[#25D366] rounded-full px-3 py-1 text-xs font-semibold no-underline"
        >
          Download App
        </a>
        <button
          type="button"
          onClick={() => setShowAndroid(false)}
          className="text-white/80 text-xs underline bg-transparent border-0 cursor-pointer p-0"
        >
          Continue in browser
        </button>
      </div>
    </div>
  ) : null;

  // ── Invalid link: surface a single-line message and bail. We
  // deliberately don't render the form so a stale link can't be used
  // as a brute-force surface against the (already rate-limited) PIN
  // endpoint.
  if (branchInfo.kind === 'invalid') {
    return (
      <>
        {banner}
        <main className="bg-white min-h-screen flex items-center justify-center px-4">
          <div className="w-full max-w-sm mx-auto bg-white rounded-2xl shadow-md p-8 text-center">
            <h1 className="text-gray-900 font-semibold text-xl mb-1">
              This link is invalid or expired
            </h1>
            <p className="text-gray-500 text-sm mt-2">
              Ask your manager to re-share the staff login link from the GullyBite dashboard.
            </p>
          </div>
        </main>
      </>
    );
  }

  // ── Loading: keep the surface stable so the operator doesn't see
  // form fields flash before the heading appears.
  if (branchInfo.kind === 'loading') {
    return (
      <>
        {banner}
        <main className="bg-white min-h-screen flex items-center justify-center px-4">
          <div className="w-full max-w-sm mx-auto bg-white rounded-2xl shadow-md p-8 text-center">
            <p className="text-gray-500 text-sm">Loading…</p>
          </div>
        </main>
      </>
    );
  }

  // ── Ready (or transient error during info fetch — we still render
  // the form because a working PIN POST means their token is valid).
  const heading = branchInfo.kind === 'ready'
    ? [branchInfo.data.restaurant_name, branchInfo.data.branch_name].filter(Boolean).join(' — ')
    : null;

  return (
    <>
      {banner}
      <main className="bg-white min-h-screen flex items-center justify-center px-4">
        <div className="w-full max-w-sm mx-auto bg-white rounded-2xl shadow-md p-8">
        <h1 className="text-gray-900 font-semibold text-xl mb-1">
          {heading || 'GullyBite Staff'}
        </h1>
        <p className="text-gray-500 text-sm mb-6">
          Sign in with your name and 4-digit PIN.
        </p>

        {showAndroid && (
          <div className="mb-4">
            <button
              type="button"
              onClick={onOpenInApp}
              className="w-full py-3 text-sm bg-green-600 text-white border-0 rounded-lg cursor-pointer font-semibold"
            >
              Open in GullyBite Staff App
            </button>
            <div className="flex items-center gap-2 my-4 text-gray-500 text-xs">
              <div className="flex-1 h-px bg-gray-200" />
              <span>or sign in here</span>
              <div className="flex-1 h-px bg-gray-200" />
            </div>
          </div>
        )}

        <form onSubmit={onSubmit}>
          <label className="block text-xs text-gray-700 mb-1">
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            disabled={submitting}
            className="border border-gray-300 rounded-lg px-4 py-3 w-full text-sm text-gray-900 mb-4"
          />

          <label className="block text-xs text-gray-700 mb-1">
            PIN
          </label>
          <input
            type="password"
            value={pin}
            onChange={(e) => onPinChange(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={4}
            placeholder="••••"
            disabled={submitting}
            className="border border-gray-300 rounded-lg px-4 py-3 w-full text-lg tracking-[0.4em] text-center text-gray-900 mb-4"
          />

          {error && (
            <div className="py-2 px-3 mb-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className={`w-full py-3 text-sm text-white border-0 rounded-lg font-semibold ${submitting ? 'bg-gray-400 cursor-default' : 'bg-green-600 cursor-pointer'}`}
          >
            {submitting ? 'Signing in…' : 'Log in'}
          </button>
        </form>
        </div>
      </main>
    </>
  );
}
