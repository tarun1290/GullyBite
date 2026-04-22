import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { adminSignin, adminSetup, getAdminSetupStatus } from '../../api/admin.js';

// Admin sign-in + first-run super admin setup. Two modes picked by the
// getAdminSetupStatus probe; the server-side recheck inside POST /auth/setup
// is the actual security gate — this page's mode is a UX hint only.
//
// Visual tokens mirror pages/Login.jsx exactly: auth-wrap / auth-body /
// auth-card / fld / btn-full / spin / auth-switch. No Google button —
// admin is JWT-only. Skips the /auth/me round-trip the restaurant Login
// does because POST /api/admin/auth already returns the full user object.

const ERROR_MESSAGES = {
  invalid_email: 'Please enter a valid email address.',
  password_too_short: 'Password must be at least 12 characters.',
  name_too_short: 'Please enter your full name (at least 2 characters).',
  setup_already_complete: 'Setup has already been completed. Please sign in.',
};

function translateError(data, fallback) {
  const code = data?.error;
  if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  if (typeof data?.message === 'string' && data.message) return data.message;
  return fallback;
}

export default function AdminLogin() {
  const navigate = useNavigate();
  const { user, loading, login } = useAuth();

  const [statusLoading, setStatusLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [confirmPw, setConfirmPw] = useState('');

  // Probe whether the backend has any super_admin yet. While this is in
  // flight we render a loading indicator — never flash the login form then
  // swap to setup (looks broken).
  useEffect(() => {
    let cancelled = false;
    getAdminSetupStatus()
      .then((d) => { if (!cancelled) setNeedsSetup(!!d?.needs_setup); })
      .catch(() => { if (!cancelled) setNeedsSetup(false); })
      .finally(() => { if (!cancelled) setStatusLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // If the user already has an admin session, skip the form.
  useEffect(() => {
    if (loading) return;
    if (user?.role === 'admin') navigate('/admin/overview', { replace: true });
  }, [user, loading, navigate]);

  const handleSignin = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const d = await adminSignin(email.trim(), password);
      if (!d?.token || !d?.user) {
        setErr(translateError(d, 'Invalid credentials'));
        return;
      }
      login(d.token, d.user);
      navigate('/admin/overview', { replace: true });
    } catch (ex) {
      const status = ex?.response?.status;
      if (status === 403 || status === 401) {
        setErr('Invalid credentials');
      } else {
        setErr(translateError(ex?.response?.data, ex?.message || 'Sign in failed'));
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSetup = async (e) => {
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
      const d = await adminSetup(emailTrim, password, nameTrim);
      if (!d?.token || !d?.user) {
        setErr(translateError(d, 'Setup failed'));
        return;
      }
      login(d.token, d.user);
      navigate('/admin/overview', { replace: true });
    } catch (ex) {
      setErr(translateError(ex?.response?.data, ex?.message || 'Setup failed'));
    } finally {
      setBusy(false);
    }
  };

  if (statusLoading) {
    return (
      <div className="auth-wrap">
        <nav className="nav" style={{ position: 'relative' }}>
          <div className="logo"><div className="logo-ring">🍜</div>GullyBite</div>
        </nav>
        <div className="auth-body">
          <div className="auth-card" style={{ textAlign: 'center', padding: '3rem 1.5rem' }}>
            <span className="spin" aria-label="Loading" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div id={needsSetup ? 'pg-admin-setup' : 'pg-admin-signin'} className="auth-wrap">
      <nav className="nav" style={{ position: 'relative' }}>
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
                  <input
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <div className="fld">
                  <label>Full Name <span className="req">*</span></label>
                  <input
                    type="text"
                    autoComplete="name"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className="fld">
                  <label>Password <span className="req">*</span></label>
                  <input
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={12}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
                <div className="fld">
                  <label>Confirm Password <span className="req">*</span></label>
                  <input
                    type="password"
                    autoComplete="new-password"
                    required
                    value={confirmPw}
                    onChange={(e) => setConfirmPw(e.target.value)}
                  />
                </div>
                {err && (
                  <div style={{ color: '#b91c1c', fontSize: '.82rem', marginBottom: '.6rem' }}>
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
                  <input
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <div className="fld">
                  <label>Password <span className="req">*</span></label>
                  <input
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
                {err && (
                  <div style={{ color: '#b91c1c', fontSize: '.82rem', marginBottom: '.6rem' }}>
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
            Restaurant owner? <a onClick={() => navigate('/login')}>Sign in here</a>
          </p>
        </div>
      </div>
    </div>
  );
}
