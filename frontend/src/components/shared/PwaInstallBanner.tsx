'use client';

// Bottom-of-screen "Install GullyBite" banner. Mounted in the dashboard
// layout only — restaurant owners see it; admins do not. Shown when:
//   1. The browser fires `beforeinstallprompt` (PWA criteria met)
//   2. The user has not already dismissed it (localStorage)
//   3. The app is not already installed (display-mode: standalone)
//
// Uses the dashboard's btn-p / btn-g btn-sm classes for consistency with
// the rest of the dashboard chrome.

import { useState, useEffect } from 'react';

// BeforeInstallPromptEvent is not in the standard TS lib.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISSED_KEY = 'pwa_install_dismissed';

export function PwaInstallBanner() {
  const [installPrompt, setInstallPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState<boolean>(false);

  useEffect(() => {
    // Don't show if already dismissed or already installed (standalone mode).
    if (typeof window === 'undefined') return;
    if (window.localStorage.getItem(DISMISSED_KEY)) return;
    if (window.matchMedia('(display-mode: standalone)').matches) return;

    const handler = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
      setVisible(true);
    };

    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstall = async () => {
    if (!installPrompt) return;
    try {
      await installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice;
      if (outcome === 'accepted') setVisible(false);
    } catch {
      /* user rejected mid-prompt — leave banner visible so they can retry */
    }
    setInstallPrompt(null);
  };

  const handleDismiss = () => {
    try { window.localStorage.setItem(DISMISSED_KEY, '1'); } catch { /* private mode */ }
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-label="Install GullyBite"
      style={{
        position: 'fixed',
        bottom: 16,
        left: 16,
        right: 16,
        zIndex: 9999,
        background: 'var(--bg, #fff)',
        border: '1px solid var(--rim, rgba(0,0,0,0.08))',
        borderRadius: 12,
        padding: '.7rem .9rem',
        boxShadow: '0 6px 24px rgba(0,0,0,0.12)',
        display: 'flex',
        alignItems: 'center',
        gap: '.6rem',
      }}
    >
      <span style={{ flex: 1, fontSize: '.85rem' }}>
        Install GullyBite on your phone for faster access.
      </span>
      <button
        type="button"
        className="btn-p btn-sm"
        onClick={handleInstall}
      >
        Install
      </button>
      <button
        type="button"
        className="btn-g btn-sm"
        onClick={handleDismiss}
        aria-label="Dismiss install prompt"
      >
        ✕
      </button>
    </div>
  );
}
