'use client';

import { useEffect, useState, type FormEvent, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAdminAuth } from '../../../contexts/AdminAuthContext';
import { adminSignin, adminSetup, getAdminSetupStatus } from '../../../api/admin';
import type { AuthResponse } from '../../../types';

const ERROR_MESSAGES: Record<string, string> = {
  invalid_email: 'Please enter a valid email address.',
  password_too_short: 'Password must be at least 12 characters.',
  name_too_short: 'Please enter your full name (at least 2 characters).',
  setup_already_complete: 'Setup has already been completed. Please sign in.',
};

interface ApiErrorBody {
  error?: string;
  message?: string;
}

function translateError(data: ApiErrorBody | undefined | null, fallback: string): string {
  const code = data?.error;
  if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  if (typeof data?.message === 'string' && data.message) return data.message;
  return fallback;
}

type LooseAuth = AuthResponse & ApiErrorBody;

export default function AdminLogin() {
  const router = useRouter();
  const { user, loading, login } = useAdminAuth();

  const [statusLoading, setStatusLoading] = useState<boolean>(true);
  const [needsSetup, setNeedsSetup] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [name, setName] = useState<string>('');
  const [confirmPw, setConfirmPw] = useState<string>('');

  // Probe whether the backend has any super_admin yet. While this is in
  // flight we render a loading indicator — never flash the login form then
  // swap to setup (looks broken).
  useEffect(() => {
    let cancelled = false;
    getAdminSetupStatus()
      .then((d) => { if (!cancelled) setNeedsSetup(Boolean(d?.needs_setup)); })
      .catch(() => { if (!cancelled) setNeedsSetup(false); })
      .finally(() => { if (!cancelled) setStatusLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // If the user already has an admin session, skip the form.
  useEffect(() => {
    if (loading) return;
    if (user?.role === 'admin') router.replace('/admin/overview');
  }, [user, loading, router]);

  const onChange = (setter: (v: string) => void) => (e: ChangeEvent<HTMLInputElement>) => setter(e.target.value);

  const handleSignin = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const d = (await adminSignin(email.trim(), password)) as LooseAuth;
      if (!d?.token || !d?.user) {
        setErr(translateError(d, 'Invalid credentials'));
        return;
      }
      login(d.token, d.user);
      router.replace('/admin/overview');
    } catch (ex: unknown) {
      const e2 = ex as { response?: { status?: number; data?: ApiErrorBody }; message?: string };
      const status = e2?.response?.status;
      if (status === 403 || status === 401) {
        setErr('Invalid credentials');
      } else {
        setErr(translateError(e2?.response?.data, e2?.message || 'Sign in failed'));
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSetup = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const emailTrim = email.trim();
    const nameTrim = name.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrim)) {
      setErr('Please enter a valid email address.'); return;
    }
    if (nameTrim.length < 2) { setErr('Please enter your full name.'); return; }
    if (password.length < 12) { setErr('Password must be at least 12 characters.'); return; }
    if (password !== confirmPw) { setErr('Passwords do not match.'); return; }

    setBusy(true); setErr(null);
    try {
      const d = (await adminSetup(emailTrim, password, nameTrim)) as LooseAuth;
      if (!d?.token || !d?.user) {
        setErr(translateError(d, 'Setup failed'));
        return;
      }
      login(d.token, d.user);
      router.replace('/admin/overview');
    } catch (ex: unknown) {
      const e2 = ex as { response?: { data?: ApiErrorBody }; message?: string };
      setErr(translateError(e2?.response?.data, e2?.message || 'Setup failed'));
    } finally {
      setBusy(false);
    }
  };

  if (statusLoading) {
    return (
      <div className="auth-wrap">
        <nav className="nav relative">
          <div className="logo"><div className="logo-ring">🍜</div>GullyBite</div>
        </nav>
        <div className="auth-body">
          <div className="auth-card text-center py-12 px-6">
            <span className="spin" aria-label="Loading" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div id={needsSetup ? 'pg-admin-setup' : 'pg-admin-signin'} className="auth-wrap">
      <nav className="nav relative">
        <div className="logo"><div className="logo-ring">🍜</div>GullyBite</div>
      </nav>
      <div className="auth-body">
        <div className="auth-card">
          {needsSetup ? (
            <>
              <h2>Admin Setup</h2>
              <p className="sub">
                This is the first admin account for this GullyBite installation.
                This form disables itself immediately after setup — save these credentials.
              </p>
              <form onSubmit={handleSetup}>
                <div className="fld">
                  <label>Email Address <span className="req">*</span></label>
                  <input type="email" autoComplete="email" required value={email} onChange={onChange(setEmail)} />
                </div>
                <div className="fld">
                  <label>Full Name <span className="req">*</span></label>
                  <input type="text" autoComplete="name" required value={name} onChange={onChange(setName)} />
                </div>
                <div className="fld">
                  <label>Password <span className="req">*</span></label>
                  <input type="password" autoComplete="new-password" required minLength={12} value={password} onChange={onChange(setPassword)} />
                </div>
                <div className="fld">
                  <label>Confirm Password <span className="req">*</span></label>
                  <input type="password" autoComplete="new-password" required value={confirmPw} onChange={onChange(setConfirmPw)} />
                </div>
                {err && (
                  <div className="text-red-600 text-[0.82rem] mb-[0.6rem]">
                    {err}
                  </div>
                )}
                <button type="submit" className="btn-full" disabled={busy}>
                  {busy ? (<><span className="spin" /> Creating admin…</>) : 'Create Admin Account →'}
                </button>
              </form>
            </>
          ) : (
            <>
              <h2>Admin Sign In</h2>
              <p className="sub">Sign in to the GullyBite admin console</p>
              <form onSubmit={handleSignin}>
                <div className="fld">
                  <label>Email Address <span className="req">*</span></label>
                  <input type="email" autoComplete="email" required value={email} onChange={onChange(setEmail)} />
                </div>
                <div className="fld">
                  <label>Password <span className="req">*</span></label>
                  <input type="password" autoComplete="current-password" required value={password} onChange={onChange(setPassword)} />
                </div>
                {err && (
                  <div className="text-red-600 text-[0.82rem] mb-[0.6rem]">
                    {err}
                  </div>
                )}
                <button type="submit" className="btn-full" disabled={busy}>
                  {busy ? (<><span className="spin" /> Signing in…</>) : 'Sign In →'}
                </button>
              </form>
            </>
          )}

          <p className="auth-switch">
            Restaurant owner? <a onClick={() => router.push('/login')}>Sign in here</a>
          </p>
        </div>
      </div>
    </div>
  );
}
