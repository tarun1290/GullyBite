import { useCallback, useEffect, useRef, useState } from 'react';
import { startMetaOAuth, pollMetaResult } from '../api/auth';

// Exact UA checks from legacy shared.js:126-140.
// Returns false for webviews, mobile, and Safari (excluding Chrome/Firefox/Edge
// on iOS which all include "Safari" in UA).
function _canUsePopup(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/FBAN|FBAV|FB_IAB|Instagram|Twitter|Line\/|MicroMessenger|MQQBrowser|WhatsApp|Snapchat|LinkedInApp|Pinterest/i.test(ua)) return false;
  if (/Mobile|Android|iPhone|iPad|iPod|Windows Phone|webOS|BlackBerry/i.test(ua)) return false;
  const isSafari = /Safari/i.test(ua) && !/Chrome|CriOS|FxiOS|EdgiOS|OPR|Opera/i.test(ua);
  if (isSafari) return false;
  return true;
}

// Must run synchronously inside the click handler — popup blockers reject
// window.open() calls that happen after an await.
function _openAboutBlankPopup(): Window | null {
  const w = 600;
  const h = 720;
  const screenW = window.screen?.width || 1280;
  const screenH = window.screen?.height || 800;
  const left = Math.max(0, Math.round((screenW - w) / 2));
  const top = Math.max(0, Math.round((screenH - h) / 2));
  const features =
    'width=' + w + ',height=' + h + ',left=' + left + ',top=' + top +
    ',resizable=yes,scrollbars=yes,status=no,toolbar=no,menubar=no,location=no';
  let popup: Window | null = null;
  try {
    popup = window.open('about:blank', 'gb-meta-connect', features);
  } catch (_e) {
    popup = null;
  }
  if (!popup || popup.closed || typeof popup.closed === 'undefined') return null;
  try {
    popup.document.open();
    popup.document.write('<!doctype html><html><head><title>Connecting…</title></head><body style="font-family:system-ui;text-align:center;padding:60px 20px;color:#1f2937"><p>Loading Meta authorization…</p></body></html>');
    popup.document.close();
  } catch (_e) { /* some browsers reject document.write on about:blank — non-fatal */ }
  return popup;
}

interface UseMetaOAuthOptions {
  onSuccess?: (result: Record<string, unknown>) => void;
  onError?: (msg: string) => void;
}

interface TriggerOptions {
  returnTo?: string;
}

interface UseMetaOAuthReturn {
  triggerMetaOAuth: (opts?: TriggerOptions) => Promise<void>;
  loading: boolean;
  error: string | null;
}

type MessageListener = (ev: MessageEvent) => void;

export function useMetaOAuth(options: UseMetaOAuthOptions = {}): UseMetaOAuthReturn {
  const { onSuccess, onError } = options;
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const popupRef = useRef<Window | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const listenerRef = useRef<MessageListener | null>(null);
  const inProgressRef = useRef<boolean>(false);
  const onSuccessRef = useRef<UseMetaOAuthOptions['onSuccess']>(onSuccess);
  const onErrorRef = useRef<UseMetaOAuthOptions['onError']>(onError);

  useEffect(() => {
    onSuccessRef.current = onSuccess;
    onErrorRef.current = onError;
  });

  const teardown = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (listenerRef.current) {
      window.removeEventListener('message', listenerRef.current);
      listenerRef.current = null;
    }
    popupRef.current = null;
    inProgressRef.current = false;
    setLoading(false);
  }, []);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (listenerRef.current) window.removeEventListener('message', listenerRef.current);
    };
  }, []);

  const triggerMetaOAuth = useCallback(async (opts: TriggerOptions = {}) => {
    const { returnTo = '/dashboard' } = opts;
    if (inProgressRef.current) return;
    inProgressRef.current = true;
    setError(null);
    setLoading(true);

    const token = (typeof window !== 'undefined' && window.localStorage.getItem('zm_token')) || '';
    if (!token) {
      teardown();
      setError('not_authenticated');
      onErrorRef.current?.('Please sign in first');
      return;
    }

    // window.open MUST be synchronous; open before await.
    const popup = _canUsePopup() ? _openAboutBlankPopup() : null;

    try {
      const raw = await startMetaOAuth(token, {
        mode: popup ? 'popup' : 'redirect',
        return_to: returnTo,
      });
      const data = raw as { authUrl?: string; error?: string } | null | undefined;
      if (!data || !data.authUrl) {
        if (popup) { try { popup.close(); } catch (_e) {} }
        teardown();
        const msg = data?.error || 'Could not start Meta connection';
        setError(msg);
        onErrorRef.current?.(msg);
        return;
      }

      if (popup) {
        popup.location.href = data.authUrl;
        popupRef.current = popup;

        const onMessage: MessageListener = async (ev) => {
          if (!ev || ev.origin !== window.location.origin) return;
          const d = ev.data as { type?: string; resultId?: string } | null | undefined;
          if (!d || d.type !== 'gb-meta-connect-result' || !d.resultId) return;

          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          if (listenerRef.current) {
            window.removeEventListener('message', listenerRef.current);
            listenerRef.current = null;
          }
          inProgressRef.current = false;
          setLoading(false);

          try {
            const rawResult = await pollMetaResult(d.resultId);
            const result = rawResult as { ok?: boolean; message?: string; error?: string } | null | undefined;
            if (result && result.ok) {
              onSuccessRef.current?.(result as Record<string, unknown>);
            } else {
              const msg = result?.message || result?.error || 'Meta connection failed — please try again';
              setError(msg);
              onErrorRef.current?.(msg);
            }
          } catch (err: unknown) {
            const e = err as { userMessage?: string; message?: string };
            const msg = e?.userMessage || e?.message || 'Meta connection failed';
            setError(msg);
            onErrorRef.current?.(msg);
          }
        };
        listenerRef.current = onMessage;
        window.addEventListener('message', onMessage);

        pollRef.current = setInterval(() => {
          if (popup.closed) {
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
            if (inProgressRef.current) {
              if (listenerRef.current) {
                window.removeEventListener('message', listenerRef.current);
                listenerRef.current = null;
              }
              inProgressRef.current = false;
              setLoading(false);
              onErrorRef.current?.('Meta connection cancelled');
            }
          }
        }, 500);
        return;
      }

      // Redirect path — full-page external navigation is the correct call here.
      window.location.href = data.authUrl;
      // inProgress stays true on purpose; page is unloading.
    } catch (err: unknown) {
      if (popup) { try { popup.close(); } catch (_e) {} }
      teardown();
      const e = err as { userMessage?: string; message?: string };
      const msg = e?.userMessage || e?.message || 'Network error starting Meta connection';
      setError(msg);
      onErrorRef.current?.(msg);
    }
  }, [teardown]);

  return { triggerMetaOAuth, loading, error };
}

export default useMetaOAuth;
