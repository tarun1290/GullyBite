import { useCallback, useEffect, useRef, useState } from 'react';

const GOOGLE_CLIENT_ID =
  process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ||
  '554056535730-r6qprte4lndpak89n1dm2hmo07t6kiig.apps.googleusercontent.com';

const GIS_SRC = 'https://accounts.google.com/gsi/client';

interface GoogleCodeClient {
  requestCode: () => void;
}

interface GoogleCodeResponse {
  code?: string;
  error?: string;
}

type GoogleWindow = Window & {
  google?: {
    accounts?: {
      oauth2?: {
        initCodeClient: (config: Record<string, unknown>) => GoogleCodeClient;
      };
    };
  };
};

let gisLoadingPromise: Promise<void> | null = null;

function loadGis(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  const w = window as GoogleWindow;
  if (w.google?.accounts?.oauth2) return Promise.resolve();
  if (gisLoadingPromise) return gisLoadingPromise;

  gisLoadingPromise = new Promise<void>((resolve, reject) => {
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

interface UseGoogleAuthOptions {
  onCode?: (code: string) => void;
  onError?: (err: string) => void;
}

interface UseGoogleAuthReturn {
  ready: boolean;
  requestCode: () => void;
}

export default function useGoogleAuth(options: UseGoogleAuthOptions = {}): UseGoogleAuthReturn {
  const { onCode, onError } = options;
  const [ready, setReady] = useState<boolean>(false);
  const clientRef = useRef<GoogleCodeClient | null>(null);
  const onCodeRef = useRef<UseGoogleAuthOptions['onCode']>(onCode);
  const onErrorRef = useRef<UseGoogleAuthOptions['onError']>(onError);

  useEffect(() => {
    onCodeRef.current = onCode;
    onErrorRef.current = onError;
  }, [onCode, onError]);

  useEffect(() => {
    let cancelled = false;
    loadGis()
      .then(() => {
        if (cancelled) return;
        const w = window as GoogleWindow;
        const oauth2 = w.google?.accounts?.oauth2;
        if (!oauth2) {
          onErrorRef.current?.('gis_not_loaded');
          return;
        }
        clientRef.current = oauth2.initCodeClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: 'openid email profile',
          ux_mode: 'popup',
          callback: (response: GoogleCodeResponse) => {
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
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = (err as { message?: string })?.message || 'gis_load_failed';
        onErrorRef.current?.(msg);
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
