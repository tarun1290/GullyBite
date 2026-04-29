'use client';

// Minimal slide-in drawer. The codebase has no shared Drawer/Sheet
// primitive (and pulling in headlessui/radix just for two screens
// would balloon the bundle), so this is a small inline component
// reused by AdminMessageDrawer + RestaurantMessageDrawer.
//
// Behaviour:
//   • Right-anchored panel, full-height, ~420px wide on desktop
//     and full-width on mobile.
//   • Backdrop click + ESC close. Body scroll locked while open.
//   • `aria-hidden` on the panel mirrors `open` so SR users don't
//     focus inside a hidden subtree.
//
// Keep the styling inline — no global class additions — so the
// drawer doesn't fight whatever theme the parent app is on.

import { useEffect, type ReactNode } from 'react';

interface SlideOverDrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

export default function SlideOverDrawer({ open, onClose, title, children }: SlideOverDrawerProps) {
  // ESC to close + body scroll lock while open. Both undone on close
  // so other drawers / modals don't inherit the lock.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={open ? onClose : undefined}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.35)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity .18s ease',
          zIndex: 1000,
        }}
      />
      {/* Panel */}
      <aside
        aria-hidden={!open}
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          height: '100vh',
          width: 'min(420px, 100vw)',
          background: 'var(--surface, #ffffff)',
          color: 'var(--fg, inherit)',
          boxShadow: '-12px 0 32px rgba(0,0,0,.12)',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform .22s ease',
          zIndex: 1001,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '.85rem 1rem',
            borderBottom: '1px solid var(--rim, #e5e7eb)',
          }}
        >
          <h3 style={{ margin: 0, fontSize: '.95rem', fontWeight: 600 }}>{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent',
              border: 'none',
              fontSize: '1.2rem',
              cursor: 'pointer',
              color: 'var(--dim, #6b7280)',
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {children}
        </div>
      </aside>
    </>
  );
}
