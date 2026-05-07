'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../Toast';
import { getMe } from '../../../api/auth';
import useMetaOAuth from '../../../hooks/useMetaOAuth';
import { routeByStatus } from '../../../utils/routeByStatus';
import type { AuthUser } from '../../../types';

// Ports _slugify / _isPlaceholderSlug from legacy index.html:883-896.
function slugify(name: string | null | undefined): string | null {
  if (!name || typeof name !== 'string') return null;
  const slug = name.toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 40);
  return slug || null;
}
function isPlaceholderSlug(slug: string | null | undefined): boolean {
  return !slug || slug === 'my-restaurant' || /^my-restaurant(-\d+)?$/.test(slug);
}

const PLACEHOLDER = 'Enter your business name on the previous step to generate your URL';

interface PgConnectProps {
  onLogout?: () => void;
  showPage?: (id: string) => void;
  brandNameHint?: string | null;
}

type LooseMe = AuthUser & {
  error?: string;
  store_base_url?: string;
  store_slug?: string;
  store_url?: string;
  business_name?: string;
};

export default function PgConnect({ onLogout, showPage, brandNameHint }: PgConnectProps) {
  const router = useRouter();
  const { user, login } = useAuth();
  const { showToast } = useToast();
  const toastRef = useRef(showToast);
  toastRef.current = showToast;

  const [storeUrl, setStoreUrl] = useState('Loading…');

  const navigate = useCallback((path: string, opts?: { replace?: boolean }) => {
    if (opts?.replace) router.replace(path);
    else router.push(path);
  }, [router]);

  // Matches legacy _fetchStoreUrl priority chain:
  //   1) saved real slug + URL from /auth/me
  //   2) live brandNameHint (user just typed it on pg-onboard)
  //   3) brand_name from /auth/me
  //   4) friendly placeholder
  const resolveStoreUrl = useCallback(async () => {
    const token = typeof window !== 'undefined' ? window.localStorage.getItem('zm_token') : null;
    let baseUrl = typeof window !== 'undefined' ? window.location.origin : '';
    let savedSlug: string | null = null;
    let savedUrl: string | null = null;
    let brandFromBackend: string | null = null;
    if (token) {
      try {
        const me = (await getMe()) as LooseMe;
        if (me) {
          if (me.store_base_url) baseUrl = me.store_base_url;
          savedSlug = me.store_slug || null;
          savedUrl = me.store_url || null;
          brandFromBackend = me.brand_name || me.business_name || null;
        }
      } catch (_err) { /* network error — fall through to preview */ }
    }
    if (savedUrl && savedSlug && !isPlaceholderSlug(savedSlug)) {
      setStoreUrl(savedUrl);
      return;
    }
    const nameSource = brandNameHint || brandFromBackend || null;
    const previewSlug = slugify(nameSource);
    if (previewSlug) {
      setStoreUrl(`${baseUrl}/store/${previewSlug}`);
      return;
    }
    setStoreUrl(PLACEHOLDER);
  }, [brandNameHint]);

  useEffect(() => { resolveStoreUrl(); }, [resolveStoreUrl]);

  const onMetaSuccess = useCallback(async () => {
    try {
      const me = (await getMe()) as LooseMe;
      if (!me || me.error) {
        toastRef.current(me?.error || 'Could not refresh account', 'error');
        return;
      }
      const token = typeof window !== 'undefined' ? window.localStorage.getItem('zm_token') : null;
      if (token) login(token, me);
      toastRef.current('WhatsApp connected!', 'success');
      routeByStatus(me, { navigate, ...(showPage && { showPage }) });
    } catch (err: unknown) {
      const e = err as { userMessage?: string; message?: string };
      toastRef.current(e?.userMessage || e?.message || 'Could not refresh account', 'error');
    }
  }, [login, showPage, navigate]);

  const onMetaError = useCallback((msg: string) => {
    if (!msg) return;
    toastRef.current(msg, 'error');
  }, []);

  const { triggerMetaOAuth, loading } = useMetaOAuth({
    onSuccess: onMetaSuccess,
    onError: onMetaError,
  });

  const handleConnect = () => {
    triggerMetaOAuth({ returnTo: '/dashboard' });
  };

  const handleCopy = async () => {
    const val = storeUrl || '';
    if (!val || val === 'Loading…' || !val.includes('/store/') || !/^https?:\/\//.test(val)) {
      toastRef.current('Enter your business name first to generate the URL', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(val);
      toastRef.current('Store URL copied!', 'success');
    } catch (_err) {
      toastRef.current('Copy failed — long-press to select', 'error');
    }
  };

  const handleSkip = () => {
    const dest = user?.role === 'admin' ? '/admin/flows' : '/dashboard/overview';
    router.replace(dest);
  };

  return (
    <div id="pg-connect" className="auth-wrap">
      <nav className="nav relative">
        <div className="logo"><div className="logo-ring">🍜</div>GullyBite</div>
        <button
          type="button"
          className="btn-outline text-[0.76rem] py-[0.42rem] px-[0.95rem]"
          onClick={onLogout}
        >
          Sign out
        </button>
      </nav>
      <div className="auth-body items-start pt-6">
        <div className="ob-wrap max-w-[640px]">
          <div className="ob-header">
            <h2>Connect WhatsApp Business</h2>
            <p>Follow the steps below, then click Connect.</p>
          </div>
          <div className="ob-steps">
            <div className="ob-step-item">
              <div className="ob-step-dot done">✓</div>
              <div className="ob-step-label">Account</div>
            </div>
            <div className="ob-connector done"></div>
            <div className="ob-step-item">
              <div className="ob-step-dot done">✓</div>
              <div className="ob-step-label">Restaurant Info</div>
            </div>
            <div className="ob-connector done"></div>
            <div className="ob-step-item">
              <div className="ob-step-dot active">3</div>
              <div className="ob-step-label active">Connect WhatsApp</div>
            </div>
          </div>

          <div className="bg-green-50 border border-green-200 rounded-[10px] py-4 px-[1.2rem] mb-[1.1rem]">
            <p className="text-[0.72rem] font-bold tracking-[0.06em] text-wa-600 mb-[0.3rem]">
              YOUR STORE URL — copy this, you'll need it below
            </p>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={storeUrl}
                className="flex-1 bg-white border border-green-200 rounded-[7px] py-[0.4rem] px-[0.7rem] text-[0.8rem] text-tx outline-hidden font-mono"
              />
              <button
                type="button"
                onClick={handleCopy}
                className="bg-wa-500 text-white border-0 rounded-[7px] py-[0.4rem] px-[0.9rem] text-[0.78rem] font-semibold cursor-pointer whitespace-nowrap"
              >
                Copy
              </button>
            </div>
          </div>

          <div className="bg-white border border-rim rounded-[10px] py-[1.1rem] px-[1.2rem] mb-[1.1rem]">
            <p className="text-[0.82rem] font-bold mb-[0.8rem]">
              Setting up for the first time? Follow these steps:
            </p>
            <ol className="pl-[1.1rem] flex flex-col gap-[0.6rem] text-[0.8rem] text-dim leading-[1.55]">
              <li><strong>Open Meta Business Manager</strong> → <a href="https://business.facebook.com" target="_blank" rel="noreferrer" className="text-indigo-600">business.facebook.com</a> → create a Business Portfolio if you don't have one yet.</li>
              <li><strong>Create a WhatsApp Business Account (WABA)</strong> → inside your Portfolio → Accounts → WhatsApp Accounts → Add.</li>
              <li><strong>Add a phone number</strong> to your WABA. Use a number that is NOT already on the regular WhatsApp app. Verify it via OTP.</li>
              <li><strong>Set Privacy Policy &amp; Website URL</strong> → Business Settings → WhatsApp Accounts → your account → Settings → paste your Store URL (green box above) into both fields.</li>
              <li><strong>Now click the button below</strong> → select your Business Portfolio → select your WABA and phone number → authorise GullyBite.</li>
            </ol>
          </div>

          <div className="bg-white border border-rim rounded-[10px] p-[1.2rem] text-center">
            <p className="text-[0.8rem] text-mute mb-[0.9rem]">
              Done with the steps above? Connect now.
            </p>
            <button
              type="button"
              className="btn-wa-connect btn-lg"
              onClick={handleConnect}
              disabled={loading}
            >
              {loading ? (
                <><span className="spin" /> Connecting…</>
              ) : (
                <>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                  </svg>
                  Connect WhatsApp Business
                </>
              )}
            </button>
            <p className="mt-[0.6rem] text-[0.72rem] text-dim">
              Takes about 2 minutes. You'll be redirected back automatically.
            </p>
            <div className="mt-4 pt-[0.9rem] border-t border-rim">
              <p className="text-[0.75rem] text-dim mb-[0.4rem]">
                Not ready yet? You can always connect later from your dashboard.
              </p>
              <button
                type="button"
                className="btn-outline text-[0.78rem]"
                onClick={handleSkip}
              >
                Skip for now → Go to Dashboard
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
