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

  // ── Invalid link: surface a single-line message and bail. We
  // deliberately don't render the form so a stale link can't be used
  // as a brute-force surface against the (already rate-limited) PIN
  // endpoint.
  if (branchInfo.kind === 'invalid') {
    return (
      <main className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-sm bg-ink2 border border-rim rounded-xl p-6 shadow-[0_8px_24px_rgba(0,0,0,0.18)] text-center">
          <h1 className="m-0 mb-3 text-[1.1rem] font-semibold text-fg">
            This link is invalid or expired
          </h1>
          <p className="text-dim text-[0.85rem] m-0">
            Ask your manager to re-share the staff login link from the GullyBite dashboard.
          </p>
        </div>
      </main>
    );
  }

  // ── Loading: keep the surface stable so the operator doesn't see
  // form fields flash before the heading appears.
  if (branchInfo.kind === 'loading') {
    return (
      <main className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-sm bg-ink2 border border-rim rounded-xl p-6 shadow-[0_8px_24px_rgba(0,0,0,0.18)] text-center">
          <p className="text-dim text-[0.9rem] m-0">Loading…</p>
        </div>
      </main>
    );
  }

  // ── Ready (or transient error during info fetch — we still render
  // the form because a working PIN POST means their token is valid).
  const heading = branchInfo.kind === 'ready'
    ? [branchInfo.data.restaurant_name, branchInfo.data.branch_name].filter(Boolean).join(' — ')
    : null;

  return (
    <main className="flex-1 flex items-center justify-center p-6">
      <div className="w-full max-w-sm bg-ink2 border border-rim rounded-xl p-6 shadow-[0_8px_24px_rgba(0,0,0,0.18)]">
        <h1 className="m-0 text-[1.25rem] font-semibold">
          {heading || 'GullyBite Staff'}
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
            onChange={(e) => onPinChange(e.target.value)}
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
            {submitting ? 'Signing in…' : 'Log in'}
          </button>
        </form>
      </div>
    </main>
  );
}
