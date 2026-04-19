import { useEffect, useRef, useState, useCallback } from 'react';

const GOOGLE_CLIENT_ID =
  import.meta.env.VITE_GOOGLE_CLIENT_ID ||
  '554056535730-r6qprte4lndpak89n1dm2hmo07t6kiig.apps.googleusercontent.com';

const GIS_SRC = 'https://accounts.google.com/gsi/client';

let gisLoadingPromise = null;

function loadGis() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.google && window.google.accounts && window.google.accounts.oauth2) {
    return Promise.resolve();
  }
  if (gisLoadingPromise) return gisLoadingPromise;

  gisLoadingPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${GIS_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('GIS script failed to load')));
      return;
    }
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      gisLoadingPromise = null;
      reject(new Error('GIS script failed to load'));
    };
    document.head.appendChild(script);
  });
  return gisLoadingPromise;
}

export default function useGoogleAuth({ onCode, onError } = {}) {
  const [ready, setReady] = useState(false);
  const clientRef = useRef(null);
  const onCodeRef = useRef(onCode);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onCodeRef.current = onCode;
    onErrorRef.current = onError;
  }, [onCode, onError]);

  useEffect(() => {
    let cancelled = false;
    loadGis()
      .then(() => {
        if (cancelled) return;
        clientRef.current = window.google.accounts.oauth2.initCodeClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: 'openid email profile',
          ux_mode: 'popup',
          callback: (response) => {
            if (response && response.error) {
              onErrorRef.current?.(response.error);
              return;
            }
            if (!response || !response.code) {
              onErrorRef.current?.('no_code');
              return;
            }
            onCodeRef.current?.(response.code);
          },
        });
        setReady(true);
      })
      .catch((err) => {
        if (cancelled) return;
        onErrorRef.current?.(err?.message || 'gis_load_failed');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const requestCode = useCallback(() => {
    if (!clientRef.current) {
      onErrorRef.current?.('not_ready');
      return;
    }
    clientRef.current.requestCode();
  }, []);

  return { ready, requestCode };
}
