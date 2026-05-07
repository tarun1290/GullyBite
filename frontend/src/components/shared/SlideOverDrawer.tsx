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
// Surface/foreground colours come from CSS vars (with fallbacks) so
// the drawer doesn't fight whatever theme the parent app is on.

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
        className={`fixed inset-0 bg-black/35 z-1000 transition-opacity duration-180 ease ${
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
      />
      {/* Panel */}
      <aside
        aria-hidden={!open}
        className={`fixed top-0 right-0 h-screen w-[min(420px,100vw)] bg-surface text-fg shadow-[-12px_0_32px_rgba(0,0,0,0.12)] transition-transform duration-220 ease z-1001 flex flex-col ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between py-[0.85rem] px-4 border-b border-rim">
          <h3 className="m-0 text-[0.95rem] font-semibold">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="bg-transparent border-0 text-[1.2rem] cursor-pointer text-dim leading-none"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 min-h-0 flex flex-col">
          {children}
        </div>
      </aside>
    </>
  );
}
