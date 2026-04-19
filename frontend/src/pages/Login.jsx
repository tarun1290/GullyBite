import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useToast } from '../components/Toast.jsx';
import { emailSignin, emailSignup, googleAuth, getMe } from '../api/auth.js';
import useGoogleAuth from '../hooks/useGoogleAuth.js';
import { routeByStatus } from '../utils/routeByStatus.js';

function GoogleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

const PWD_RULES = [
  { key: 'len', label: 'At least 8 characters', test: (v) => v.length >= 8 },
  { key: 'upper', label: 'One uppercase letter (A–Z)', test: (v) => /[A-Z]/.test(v) },
  { key: 'lower', label: 'One lowercase letter (a–z)', test: (v) => /[a-z]/.test(v) },
  { key: 'num', label: 'One number (0–9)', test: (v) => /[0-9]/.test(v) },
  { key: 'sym', label: 'One special character (@, #, ! …)', test: (v) => /[^A-Za-z0-9]/.test(v) },
];

export default function Login() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, loading, login } = useAuth();
  const { showToast } = useToast();
  const toastRef = useRef(showToast);
  toastRef.current = showToast;

  const initialMode = searchParams.get('mode') === 'signup' ? 'signup' : 'signin';
  const [mode, setMode] = useState(initialMode);
  const [busy, setBusy] = useState(false);

  const [siEmail, setSiEmail] = useState('');
  const [siPw, setSiPw] = useState('');

  const [suName, setSuName] = useState('');
  const [suEmail, setSuEmail] = useState('');
  const [suPw, setSuPw] = useState('');
  const [suPw2, setSuPw2] = useState('');

  useEffect(() => {
    if (loading) return;
    if (user) routeByStatus(user, { navigate });
  }, [user, loading, navigate]);

  const switchTo = (next) => {
    setMode(next);
    const nextParams = new URLSearchParams(searchParams);
    if (next === 'signup') nextParams.set('mode', 'signup');
    else nextParams.delete('mode');
    setSearchParams(nextParams, { replace: true });
  };

  const finalizeAuth = async (token) => {
    localStorage.setItem('zm_token', token);
    try {
      const me = await getMe();
      if (!me || me.error) {
        localStorage.removeItem('zm_token');
        toastRef.current(me?.error || 'Sign in failed', 'error');
        return;
      }
      login(token, me);
      routeByStatus(me, { navigate });
    } catch (err) {
      toastRef.current(err?.userMessage || err?.message || 'Sign in failed', 'error');
    }
  };

  const handleSignin = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const d = await emailSignin(siEmail.trim(), siPw);
      if (!d?.token) {
        toastRef.current(d?.error || 'Sign in failed', 'error');
        return;
      }
      await finalizeAuth(d.token);
    } catch (err) {
      toastRef.current(err?.userMessage || err?.message || 'Sign in failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleSignup = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (suPw !== suPw2) {
      toastRef.current('Passwords do not match', 'error');
      return;
    }
    setBusy(true);
    try {
      const d = await emailSignup({
        ownerName: suName.trim(),
        email: suEmail.trim(),
        password: suPw,
      });
      if (!d?.token) {
        toastRef.current(d?.error || 'Sign up failed', 'error');
        return;
      }
      toastRef.current('Account created!', 'success');
      await finalizeAuth(d.token);
    } catch (err) {
      toastRef.current(err?.userMessage || err?.message || 'Sign up failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleGoogleCode = async (code) => {
    if (busy) return;
    setBusy(true);
    try {
      const d = await googleAuth(code);
      if (!d?.token) {
        toastRef.current(d?.error || 'Google sign-in failed', 'error');
        return;
      }
      await finalizeAuth(d.token);
    } catch (err) {
      toastRef.current(err?.userMessage || err?.message || 'Google sign-in failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const { ready: googleReady, requestCode } = useGoogleAuth({
    onCode: handleGoogleCode,
    onError: (reason) => {
      if (reason === 'not_ready') {
        toastRef.current('Google sign-in loading — please wait a moment', 'error');
      } else if (reason && reason !== 'popup_closed_by_user' && reason !== 'no_code') {
        toastRef.current('Google sign-in failed: ' + reason, 'error');
      }
    },
  });

  const onGoogleClick = () => {
    if (!googleReady) {
      toastRef.current('Google sign-in loading — please wait a moment', 'error');
      return;
    }
    requestCode();
  };

  return (
    <div id={mode === 'signup' ? 'pg-signup' : 'pg-signin'} className="auth-wrap">
      <nav className="nav" style={{ position: 'relative' }}>
        <div className="logo"><div className="logo-ring">🍜</div>GullyBite</div>
      </nav>
      <div className="auth-body">
        <div className="auth-card">
          {mode === 'signup' ? (
            <>
              <h2>Create Account</h2>
              <p className="sub">Start your free 14-day trial — no credit card required</p>
            </>
          ) : (
            <>
              <h2>Welcome Back</h2>
              <p className="sub">Sign in to your GullyBite restaurant dashboard</p>
            </>
          )}

          <button type="button" className="btn-google" onClick={onGoogleClick} disabled={busy || !googleReady}>
            <GoogleIcon />
            Continue with Google
          </button>

          <div className="auth-divider"><span>OR</span></div>

          {mode === 'signup' ? (
            <form onSubmit={handleSignup}>
              <div className="fld">
                <label>Your Full Name <span className="req">*</span></label>
                <input
                  type="text"
                  placeholder="Ravi Kumar"
                  autoComplete="name"
                  required
                  value={suName}
                  onChange={(e) => setSuName(e.target.value)}
                />
              </div>
              <div className="fld">
                <label>Work Email <span className="req">*</span></label>
                <input
                  type="email"
                  placeholder="ravi@restaurant.com"
                  autoComplete="email"
                  required
                  value={suEmail}
                  onChange={(e) => setSuEmail(e.target.value)}
                />
              </div>
              <div className="fld">
                <label>Password <span className="req">*</span></label>
                <input
                  type="password"
                  placeholder="Min 8 characters"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={suPw}
                  onChange={(e) => setSuPw(e.target.value)}
                />
                <ul className="pwd-rules">
                  {PWD_RULES.map((r) => (
                    <li key={r.key} className={r.test(suPw) ? 'ok' : ''}>{r.label}</li>
                  ))}
                </ul>
              </div>
              <div className="fld">
                <label>Confirm Password <span className="req">*</span></label>
                <input
                  type="password"
                  placeholder="Re-enter password"
                  autoComplete="new-password"
                  required
                  value={suPw2}
                  onChange={(e) => setSuPw2(e.target.value)}
                />
              </div>
              <button type="submit" className="btn-full" disabled={busy}>
                {busy ? (<><span className="spin" /> Creating account…</>) : 'Create Account →'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleSignin}>
              <div className="fld">
                <label>Email Address <span className="req">*</span></label>
                <input
                  type="email"
                  placeholder="ravi@restaurant.com"
                  autoComplete="email"
                  required
                  value={siEmail}
                  onChange={(e) => setSiEmail(e.target.value)}
                />
              </div>
              <div className="fld">
                <label>Password <span className="req">*</span></label>
                <input
                  type="password"
                  placeholder="Your password"
                  autoComplete="current-password"
                  required
                  value={siPw}
                  onChange={(e) => setSiPw(e.target.value)}
                />
              </div>
              <button type="submit" className="btn-full" disabled={busy}>
                {busy ? (<><span className="spin" /> Signing in…</>) : 'Sign In →'}
              </button>
            </form>
          )}

          <p className="auth-switch">
            {mode === 'signup' ? (
              <>Already have an account? <a onClick={() => switchTo('signin')}>Sign In</a></>
            ) : (
              <>New to GullyBite? <a onClick={() => switchTo('signup')}>Create Account</a></>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
