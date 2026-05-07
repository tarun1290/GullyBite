// Standalone wrapper for the web-staff POS. The root layout
// (app/layout.tsx) already supplies <html>/<body> and the global token /
// dashboard CSS imports — this file is a thin segment layout, NOT a
// second root, so we don't redeclare those tags. The dashboard nav lives
// under /dashboard/layout.tsx, so /staff/* routes naturally render
// without any owner-side chrome.
//
// We give the segment its own stacking context (full-viewport flex
// column) so the login + orders pages can paint corner-to-corner on a
// tablet without inheriting any container width set elsewhere.

import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'GullyBite Staff',
  // Don't index the staff pages — the URL embeds a per-branch UUID and
  // is meant to be shared privately.
  robots: { index: false, follow: false },
};

export default function StaffLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="min-h-screen flex flex-col bg-ink text-fg">
      {children}
    </div>
  );
}
