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
    <main
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 380,
          background: 'var(--ink2, #0f1729)',
          border: '1px solid var(--rim, #1f2a3d)',
          borderRadius: 12,
          padding: '1.5rem',
          boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
        }}
      >
        <h1 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600 }}>
          GullyBite Staff
        </h1>
        <p style={{ marginTop: '.4rem', marginBottom: '1.2rem', color: 'var(--dim, #94a3b8)', fontSize: '.85rem' }}>
          Sign in with your name and 4-digit PIN.
        </p>

        {showAndroid && (
          <div style={{ marginBottom: '1rem' }}>
            <button
              type="button"
              onClick={onOpenInApp}
              style={{
                width: '100%',
                padding: '.7rem',
                fontSize: '.95rem',
                background: 'var(--gb-green-600,#059669)',
                color: 'white',
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              Open in GullyBite Staff App
            </button>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '.5rem',
                margin: '1rem 0',
                color: 'var(--dim, #94a3b8)',
                fontSize: '.75rem',
              }}
            >
              <div style={{ flex: 1, height: 1, background: 'var(--rim, #1f2a3d)' }} />
              <span>or sign in here</span>
              <div style={{ flex: 1, height: 1, background: 'var(--rim, #1f2a3d)' }} />
            </div>
          </div>
        )}

        <form onSubmit={onSubmit}>
          <label style={{ display: 'block', fontSize: '.78rem', color: 'var(--dim,#94a3b8)', marginBottom: '.3rem' }}>
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            disabled={submitting}
            style={{
              width: '100%',
              padding: '.6rem .7rem',
              fontSize: '.95rem',
              background: 'var(--ink,#0b1220)',
              border: '1px solid var(--rim,#1f2a3d)',
              borderRadius: 8,
              color: 'var(--fg,#e6edf3)',
              marginBottom: '.9rem',
            }}
          />

          <label style={{ display: 'block', fontSize: '.78rem', color: 'var(--dim,#94a3b8)', marginBottom: '.3rem' }}>
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
            style={{
              width: '100%',
              padding: '.6rem .7rem',
              fontSize: '1.2rem',
              letterSpacing: '.4em',
              textAlign: 'center',
              background: 'var(--ink,#0b1220)',
              border: '1px solid var(--rim,#1f2a3d)',
              borderRadius: 8,
              color: 'var(--fg,#e6edf3)',
              marginBottom: '.9rem',
            }}
          />

          {error && (
            <div
              style={{
                padding: '.5rem .7rem',
                marginBottom: '.8rem',
                background: 'rgba(220,38,38,0.12)',
                border: '1px solid rgba(220,38,38,0.4)',
                color: '#fca5a5',
                borderRadius: 8,
                fontSize: '.82rem',
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            style={{
              width: '100%',
              padding: '.7rem',
              fontSize: '.95rem',
              background: submitting ? 'var(--rim,#1f2a3d)' : 'var(--gb-green-600,#059669)',
              color: 'white',
              border: 'none',
              borderRadius: 8,
              cursor: submitting ? 'default' : 'pointer',
              fontWeight: 600,
            }}
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  );
}
