'use client';

// Shared zero-state block for dashboard cards/panels. Replaces the
// ad-hoc bare-text "No X yet" lines scattered across analytics,
// marketing, messages, and reputation with one consistent treatment:
// accent-tinted icon chip, primary title, dim description, optional
// ghost CTA.
//
// `icon` is a ReactNode — the project ships no icon library, so
// callers pass an emoji string (the established icon convention here,
// cf. LiveIndicator's "●" / IssueStatusBadge's "⚠"). It also accepts
// any element if an SVG icon is introduced later.
//
// Colours use the existing semantic tokens: --acc-glow (accent tint
// surface) for the chip, `text-acc` for the glyph, `text-tx` /
// `text-dim` for copy. The `.btn-g` ghost-button class is reused for
// the action so it matches every other secondary button on the
// dashboard.

import type { ReactNode } from 'react';

interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: EmptyStateAction;
}

export default function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-10 px-4 gap-3">
      <div className="rounded-xl bg-[var(--acc-glow)] text-[var(--acc)] p-3">
        <div className="w-10 h-10 flex items-center justify-center text-2xl leading-none">
          {icon}
        </div>
      </div>
      <div className="text-sm font-medium text-tx">{title}</div>
      {description && (
        <div className="text-sm text-dim max-w-xs">{description}</div>
      )}
      {action && (
        <button type="button" className="btn-g mt-1" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
