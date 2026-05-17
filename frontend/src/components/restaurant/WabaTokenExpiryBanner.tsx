'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getPlatformTokenHealth } from '../../api/auth';

// WhatsApp messaging for EVERY restaurant runs on the single platform
// (System User) token — the per-restaurant token is stored but not used
// for messaging. So this banner reflects PLATFORM token health, not any
// per-restaurant token's age. It renders ONLY when the platform token is
// expired/invalid (i.e. messaging is actually broken for everyone).
//
// Single visual state: the same red "critical" palette the previous
// implementation used for an expired connection. Markup + class names are
// unchanged from the prior banner — only the data source, the copy, and
// the visibility condition changed.
const STYLE = {
  background: '#FEE2E2',
  borderColor: '#DC2626',
  textColor: '#7F1D1D',
  btnBackground: '#DC2626',
};

type Status = 'loading' | 'healthy' | 'issue' | 'error';

export default function WabaTokenExpiryBanner() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>('loading');

  useEffect(() => {
    let cancelled = false;
    getPlatformTokenHealth()
      .then((health) => {
        if (cancelled) return;
        setStatus(health?.status === 'expired_or_invalid' ? 'issue' : 'healthy');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => { cancelled = true; };
  }, []);

  // Render ONLY when the platform token is expired/invalid. loading,
  // healthy, and error (couldn't determine) all stay silent.
  if (status !== 'issue') return null;

  return (
    <div
      role="alert"
      className="flex items-center gap-3 py-3 px-6 border-b text-base"
      style={{
        background: STYLE.background,
        borderBottomColor: STYLE.borderColor,
        color: STYLE.textColor,
      }}
    >
      <span className="text-lg shrink-0" aria-hidden="true">⚠</span>
      <span className="flex-1 leading-[1.4]">WhatsApp connection issue — contact support to restore messaging.</span>
      <button
        type="button"
        onClick={() => router.push('/dashboard/settings?section=whatsapp')}
        className="shrink-0 text-white border-0 py-2 px-4 rounded-md font-semibold text-sm cursor-pointer whitespace-nowrap"
        style={{ background: STYLE.btnBackground }}
      >
        Reconnect WhatsApp
      </button>
    </div>
  );
}
