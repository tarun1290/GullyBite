'use client';

// Patched (Bearer-only) staff login. Replaces the per-branch URL-token
// flow at /staff/[staffAccessToken].
//
// Three-field form:
//   store_slug (text)
//   staff_id   (text)
//   pin        (4-digit numeric, on-screen keypad)
//
// On submit → POST /api/staff/auth. Response is { ok, token, staff }.
// We persist token under 'staff_web_token' (existing canonical key —
// see lib/staffApiClient.STAFF_TOKEN_KEY) and navigate to /staff/orders.
//
// Error map:
//   401 → inline "Invalid credentials"
//   429 → inline "Too many attempts. Try again in 15 minutes."
//   else → inline generic "Something went wrong, try again."

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { staffLogin } from '../../../api/staffAuth';
import { getStaffToken, setStaffToken } from '../../../lib/staffApiClient';

interface ApiError {
  response?: { status?: number; data?: { error?: string } };
  message?: string;
}

export default function StaffLoginPage() {
  const router = useRouter();

  const [storeSlug, setStoreSlug] = useState<string>('');
  const [staffId, setStaffId] = useState<string>('');
  const [pin, setPin] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Already-signed-in short-circuit. The orders page calls /me on
  // mount and bounces to /staff/login on 401, so a stale token can't
  // get the user stuck here.
  useEffect(() => {
    if (getStaffToken()) {
      router.replace('/staff/orders');
    }
  }, [router]);

  // Pure submit so the on-screen keypad can call it with the freshly
  // entered 4th digit before React has flushed the pin state.
  const submit = useCallback(async (slug: string, sid: string, p: string) => {
    if (submitting) return;
    if (!slug.trim()) { setError('Store ID is required'); return; }
    if (!sid.trim()) { setError('Staff ID is required'); return; }
    if (!/^\d{4}$/.test(p)) { setError('PIN must be exactly 4 digits'); return; }
    setError(null);
    setSubmitting(true);
    try {
      const res = await staffLogin({
        store_slug: slug.trim(),
        staff_id: sid.trim(),
        pin: p,
      });
      setStaffToken(res.token);
      router.replace('/staff/orders');
    } catch (err: unknown) {
      const e = err as ApiError;
      const status = e?.response?.status;
      if (status === 401) {
        setError('Invalid credentials');
      } else if (status === 429) {
        setError('Too many attempts. Try again in 15 minutes.');
      } else {
        setError(e?.response?.data?.error || e?.message || 'Something went wrong, try again.');
      }
      setSubmitting(false);
    }
  }, [router, submitting]);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void submit(storeSlug, staffId, pin);
  };

  // Keypad handlers. On the 4th digit we auto-submit if the other two
  // fields are filled — otherwise hold the value and let the operator
  // tap "Sign in".
  const onDigit = (d: string) => {
    setPin((cur) => {
      if (cur.length >= 4 || submitting) return cur;
      const next = (cur + d).slice(0, 4);
      if (next.length === 4 && storeSlug.trim() && staffId.trim()) {
        // Defer to the microtask queue so React commits the new pin
        // state before submit() reads from it. We pass the value
        // explicitly anyway so this is belt-and-suspenders.
        queueMicrotask(() => { void submit(storeSlug, staffId, next); });
      }
      return next;
    });
  };

  const onBackspace = () => {
    if (submitting) return;
    setPin((cur) => cur.slice(0, -1));
  };

  return (
    <main className="bg-bg min-h-screen px-5 sm:px-6 pt-8 pb-12">
      <div className="w-full max-w-md mx-auto bg-surface border border-rim rounded-2xl shadow-md p-6 sm:p-8">
        <h1 className="text-tx font-semibold text-xl mb-1">
          GullyBite Staff
        </h1>
        <p className="text-dim text-sm mb-6">
          Sign in with your Restaurant ID, Staff ID, and PIN.
        </p>

        <form onSubmit={onSubmit}>
          <label className="block text-xs text-tx mb-1">
            Restaurant ID
          </label>
          <input
            type="text"
            value={storeSlug}
            onChange={(e) => setStoreSlug(e.target.value)}
            autoComplete="organization"
            disabled={submitting}
            placeholder="e.g. dosa-junction"
            className="border border-rim bg-surface rounded-lg px-4 py-3 w-full text-sm text-tx mb-4"
          />

          <label className="block text-xs text-tx mb-1">
            Staff ID
          </label>
          <input
            type="text"
            value={staffId}
            onChange={(e) => setStaffId(e.target.value)}
            autoComplete="username"
            disabled={submitting}
            placeholder="e.g. priya"
            className="border border-rim bg-surface rounded-lg px-4 py-3 w-full text-sm text-tx mb-4"
          />

          <label className="block text-xs text-tx mb-1">
            PIN
          </label>
          {/* PIN display row: 4 dots that fill as digits are entered.
              We deliberately don't render a native input here because
              the on-screen keypad is the canonical entry surface and a
              soft keyboard popping up over the keypad on touch devices
              would be a UX regression. */}
          <div
            className="border border-rim bg-surface rounded-lg px-4 py-3 w-full text-lg tracking-[0.5em] text-center text-tx mb-4 select-none font-mono"
            role="status"
            aria-label={`PIN: ${pin.length} of 4 digits entered`}
          >
            {('•'.repeat(pin.length) + '○'.repeat(4 - pin.length)).split('').map((c, i) => (
              <span key={i} className={c === '•' ? 'text-tx' : 'text-dim'}>{c}</span>
            ))}
          </div>

          {/* Inline 3×4 keypad. Buttons use bg-rim for digit keys and
              bg-acc for the explicit submit. Backspace is bg-rim. */}
          <div className="grid grid-cols-3 gap-2 mb-4">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => onDigit(d)}
                disabled={submitting}
                className="bg-rim text-tx text-xl font-semibold py-4 rounded-lg cursor-pointer border-0 active:bg-mute"
              >
                {d}
              </button>
            ))}
            <button
              type="button"
              onClick={onBackspace}
              disabled={submitting || pin.length === 0}
              className="bg-rim text-tx text-lg py-4 rounded-lg cursor-pointer border-0 active:bg-mute disabled:opacity-50"
              aria-label="Backspace"
            >
              ⌫
            </button>
            <button
              type="button"
              onClick={() => onDigit('0')}
              disabled={submitting}
              className="bg-rim text-tx text-xl font-semibold py-4 rounded-lg cursor-pointer border-0 active:bg-mute"
            >
              0
            </button>
            <button
              type="button"
              onClick={() => setPin('')}
              disabled={submitting || pin.length === 0}
              className="bg-rim text-tx text-xs py-4 rounded-lg cursor-pointer border-0 active:bg-mute disabled:opacity-50"
              aria-label="Clear PIN"
            >
              Clear
            </button>
          </div>

          {error && (
            <div className="py-2 px-3 mb-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className={`w-full py-3 text-sm text-white border-0 rounded-lg font-semibold ${submitting ? 'bg-mute cursor-default' : 'bg-acc cursor-pointer'}`}
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  );
}
