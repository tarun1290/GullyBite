// Thin adapter over the generated design-tokens module
// (src/styling/_generated/tokens.ts), itself produced by
// packages/design-tokens. Existing import shape is preserved so every
// `import { colors, statusBadge, badgeFor } from '@/theme'` site keeps
// working unchanged.
//
// Brand-accent codified (Part 5):
//   colors.acc = '#0F766E' (dashboard teal). Sourced from the
//   generated `surface.acc`, which mirrors the dashboard semantic
//   override. Was '#4338ca' (indigo) before this part. The two RN
//   files that previously hardcoded teal as a workaround
//   (app/(app)/_layout.tsx, src/components/BranchSelector.tsx) now
//   import the value from here.
//
// PREPARING badge reconciliation (audit §3.7 drift):
//   The generated `statusBadge.PREPARING` carries `bg: '#fef3c7'`
//   (amber-100, inherited from the legacy theme.ts). orders/[orderId].tsx
//   had been inlining `bg: '#fed7aa'` (orange-200). This adapter
//   overrides PREPARING.bg to match the orange-200 value so badgeFor()
//   is the single source of truth and the inline divergence in
//   [orderId].tsx (the old `badgeStyleFor` function) collapses to a
//   call to badgeFor() in Part 5 Phase 4.

import tokens from './styling/_generated/tokens';

const { primitives: prim, overlays, surface, statusBadge: gen, subscriptionBadge: subGen } =
  tokens.colors;

// Re-export the primitive ramp for screens that need a specific shade
// not exposed via the semantic `colors` surface (e.g. amber.100 for a
// pill bg, indigo.100 for the past-mode pill).
export const primitives = prim;

// ─── Colors ─────────────────────────────────────────────────────────
//
// `surface` already carries every legacy key the staff-app consumed:
//   acc, acc2, accGlow, ink, ink2, ink3, ink4, rim, rim2, tx, dim,
//   mute, wa, wa2, waGlow, gold, gold2, goldGlow, red, blue, purple.
// Spread it and add the two new modal-overlay keys Part 5 codifies.

export const colors = {
  ...surface,
  // Modal backdrops — exposed so screens can drop the inline rgba()
  // literals (audit §3.7: orders/index.tsx had rgba(0,0,0,0.5) and
  // BranchSelector.tsx had rgba(15,23,42,0.45) — two different values
  // for the same role).
  overlayModal:        overlays.modal,        // rgba(0,0,0,0.5)
  overlayModalTinted:  overlays.modalTinted,  // rgba(15,23,42,0.45)
} as const;

// ─── Status badges ──────────────────────────────────────────────────
//
// PREPARING bg overridden to orange-200 (#fed7aa) — see file header.
// Both case variants overridden to keep the map symmetric.

const PREPARING_BG = prim.orange['200']; // '#fed7aa'

export const statusBadge = {
  ...gen,
  PREPARING: { ...gen.PREPARING, bg: PREPARING_BG },
  preparing: { ...gen.preparing, bg: PREPARING_BG },
} as const;

export function badgeFor(status: string | undefined | null) {
  if (!status) {
    return {
      bg: prim.neutral['100'],   // '#f3f4f6'
      fg: prim.neutral['600'],   // '#4b5563'
      label: 'Unknown',
    };
  }
  return (
    (statusBadge as Record<string, { bg: string; fg: string; label: string }>)[status] || {
      bg: prim.neutral['100'],
      fg: prim.neutral['600'],
      label: status,
    }
  );
}

// ─── Subscription badge ─────────────────────────────────────────────
//
// dashboard.tsx and branches/index.tsx both render branch
// subscription status with identical inlined hexes. This consolidates
// the resolver. Status mapping mirrors the existing local helpers:
//   'active'                  → green
//   'paused' | 'force_paused' → red
//   anything else / null      → gray default

export function subscriptionBadgeFor(
  status: string | null | undefined,
): { bg: string; fg: string } {
  if (status === 'active') return subGen.active;
  if (status === 'paused' || status === 'force_paused') return subGen.paused;
  return subGen.default;
}
