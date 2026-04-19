import { useCallback, useEffect, useRef, useState } from 'react';
import { startMetaOAuth, pollMetaResult } from '../api/auth.js';

// Exact UA checks from legacy shared.js:126-140.
// Returns false for webviews, mobile, and Safari (excluding Chrome/Firefox/Edge
// on iOS which all include "Safari" in UA).
function _canUsePopup() {
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
function _openAboutBlankPopup() {
  const w = 600;
  const h = 720;
  const screenW = (window.screen && window.screen.width) || 1280;
  const screenH = (window.screen && window.screen.height) || 800;
  const left = Math.max(0, Math.round((screenW - w) / 2));
  const top = Math.max(0, Math.round((screenH - h) / 2));
  const features =
    'width=' + w + ',height=' + h + ',left=' + left + ',top=' + top +
    ',resizable=yes,scrollbars=yes,status=no,toolbar=no,menubar=no,location=no';
  let popup = null;
  try {
    popup = window.open('about:blank', 'gb-meta-connect', features);
  } catch (_) {
    popup = null;
  }
  if (!popup || popup.closed || typeof popup.closed === 'undefined') return null;
  try {
    popup.document.open();
    popup.document.write('<!doctype html><html><head><title>Connecting\u2026</title></head><body style="font-family:system-ui;text-align:center;padding:60px 20px;color:#1f2937"><p>Loading Meta authorization\u2026</p></body></html>');
    popup.document.close();
  } catch (_) { /* some browsers reject document.write on about:blank — non-fatal */ }
  return popup;
}

export function useMetaOAuth({ onSuccess, onError } = {}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const popupRef = useRef(null);
  const pollRef = useRef(null);
  const listenerRef = useRef(null);
  const inProgressRef = useRef(false);
  const onSuccessRef = useRef(onSuccess);
  const onErrorRef = useRef(onError);

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

  const triggerMetaOAuth = useCallback(async ({ returnTo = '/dashboard' } = {}) => {
    if (inProgressRef.current) return;
    inProgressRef.current = true;
    setError(null);
    setLoading(true);

    const token = localStorage.getItem('zm_token') || '';
    if (!token) {
      teardown();
      setError('not_authenticated');
      onErrorRef.current?.('Please sign in first');
      return;
    }

    // window.open MUST be synchronous; open before any await.
    const popup = _canUsePopup() ? _openAboutBlankPopup() : null;

    try {
      const data = await startMetaOAuth(token, {
        mode: popup ? 'popup' : 'redirect',
        return_to: returnTo,
      });
      if (!data || !data.authUrl) {
        if (popup) { try { popup.close(); } catch (_) {} }
        teardown();
        const msg = (data && data.error) || 'Could not start Meta connection';
        setError(msg);
        onErrorRef.current?.(msg);
        return;
      }

      if (popup) {
        popup.location.href = data.authUrl;
        popupRef.current = popup;

        const onMessage = async (ev) => {
          if (!ev || ev.origin !== window.location.origin) return;
          const d = ev.data;
          if (!d || d.type !== 'gb-meta-connect-result' || !d.resultId) return;

          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          if (listenerRef.current) {
            window.removeEventListener('message', listenerRef.current);
            listenerRef.current = null;
          }
          inProgressRef.current = false;
          setLoading(false);

          try {
            const result = await pollMetaResult(d.resultId);
            if (result && result.ok) {
              onSuccessRef.current?.(result);
            } else {
              const msg = (result && (result.message || result.error)) || 'Meta connection failed \u2014 please try again';
              setError(msg);
              onErrorRef.current?.(msg);
            }
          } catch (err) {
            const msg = err?.userMessage || err?.message || 'Meta connection failed';
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
    } catch (err) {
      if (popup) { try { popup.close(); } catch (_) {} }
      teardown();
      const msg = err?.userMessage || err?.message || 'Network error starting Meta connection';
      setError(msg);
      onErrorRef.current?.(msg);
    }
  }, [teardown]);

  return { triggerMetaOAuth, loading, error };
}

export default useMetaOAuth;
