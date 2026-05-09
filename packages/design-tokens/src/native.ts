// RN-friendly re-export shape.
//
// Resolves every `ref` chain in the source modules to a literal value
// (no `var(--…)` indirection — RN doesn't speak CSS custom properties)
// and exposes a flat-ish default export object that the staff-app
// generator can serialize verbatim.
//
// Brand-accent decision codified here (Part 2):
//   colors.acc        → '#0F766E'  (dashboard teal)
//   colors.acc2       → '#0D5F58'
//   colors.accGlow    → 'rgba(15, 118, 110, 0.18)'
//
// The legacy staff-app/src/theme.ts had colors.acc = '#4338ca' (indigo).
// Two RN files (staff-app/app/(app)/_layout.tsx,
// staff-app/src/components/BranchSelector.tsx) already hardcoded the
// teal as a partial workaround; this codifies the direction.
//
// Indigo primitives are STILL exposed under primitives.indigo.* — any RN
// consumer that wants raw indigo (e.g. for a teal→indigo gradient) can
// reach for them explicitly.

import {
  primitives,
  overlays,
  semanticDashboard,
  semanticLanding,
  landingExtras,
  type SemanticToken,
} from './colors';
import { fontFamilies, sizes, weights, lineHeights } from './typography';
import { spacing } from './spacing';
import { radii, rAlias } from './radii';
import { shadowsWeb, elevation } from './shadows';
import { zIndex, containers } from './layout';
import { breakpoints } from './breakpoints';
import { card, button, input, modal } from './components';

// Resolve a semantic-token map to plain { key: value } literals for RN.
function resolveSemantic(map: Record<string, SemanticToken>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, tok] of Object.entries(map)) {
    out[key] = tok.value;
  }
  return out;
}

// Flat px-only sizes for RN (the CSS clamp/rem strings aren't usable).
function pxOnly<T extends Record<string, { px: number }>>(map: T): Record<keyof T, number> {
  const out = {} as Record<keyof T, number>;
  for (const [key, val] of Object.entries(map) as Array<[keyof T, { px: number }]>) {
    out[key] = val.px;
  }
  return out;
}

// The RN-side colors object. Mirrors the dashboard-surface semantics
// since the staff/owner RN apps are dashboard-flavored operational
// tools — landing/auth visual treatment doesn't apply on mobile.
const dashboardSemanticResolved = resolveSemantic(semanticDashboard);

export const colors = {
  // Primary brand-decision: teal (was '#4338ca' indigo in the legacy theme.ts).
  acc:     dashboardSemanticResolved.acc,        // '#0F766E'
  acc2:    dashboardSemanticResolved.acc2,       // '#0D5F58'
  accGlow: dashboardSemanticResolved['acc-glow'], // 'rgba(15, 118, 110, 0.18)'

  // Surfaces / borders / text
  ink:    dashboardSemanticResolved.ink,    // '#f8f9fb' — body bg
  ink2:   dashboardSemanticResolved.ink2,   // '#ffffff' — card surface
  ink3:   dashboardSemanticResolved.ink3,
  ink4:   dashboardSemanticResolved.ink4,
  rim:    dashboardSemanticResolved.rim,    // '#e5e7eb'
  rim2:   dashboardSemanticResolved.rim2,   // '#d1d5db'
  tx:     dashboardSemanticResolved.tx,     // '#111827'
  dim:    dashboardSemanticResolved.dim,    // '#6b7280'
  mute:   dashboardSemanticResolved.mute,   // '#9ca3af'

  // Semantic actions
  wa:     dashboardSemanticResolved.wa,     // '#16a34a'
  wa2:    dashboardSemanticResolved.wa2,    // '#15803d'
  waGlow: dashboardSemanticResolved['wa-glow'],
  gold:   dashboardSemanticResolved.gold,   // '#d97706'
  gold2:  dashboardSemanticResolved.gold2,  // '#b45309'
  goldGlow: dashboardSemanticResolved['gold-glow'],
  red:    dashboardSemanticResolved.red,    // '#dc2626'
  blue:   dashboardSemanticResolved.blue,   // '#2563eb'

  // Legacy compatibility — staff-app/src/theme.ts had `purple` (violet-600).
  // Kept under the same name so a future drop-in import doesn't break
  // existing references; sourced from the indigo/violet primitive ramp.
  purple: primitives.violet['600'],         // '#7c3aed'
} as const;

// Status badge map — same shape as legacy staff-app/src/theme.ts:statusBadge.
// Codifies the existing values into the package; resolves the audit §3.7
// drift (the orders/[orderId].tsx PREPARING badge had `#fed7aa` / orange-200,
// which differs from theme's `#fef3c7` / amber-100 — this map keeps amber-100
// as the canonical value, and a Part 5 refactor of [orderId].tsx will adopt it).
export const statusBadge = {
  PENDING_PAYMENT:   { bg: '#fff7ed',                     fg: '#c2410c',                     label: 'Pending Payment' },
  pending:           { bg: '#fff7ed',                     fg: '#c2410c',                     label: 'New' },
  CONFIRMED:         { bg: primitives.blue['100'],        fg: primitives.blue['600'],        label: 'Confirmed' },
  confirmed:         { bg: primitives.blue['100'],        fg: primitives.blue['600'],        label: 'Confirmed' },
  PREPARING:         { bg: primitives.amber['100'],       fg: primitives.amber['600'],       label: 'Preparing' },
  preparing:         { bg: primitives.amber['100'],       fg: primitives.amber['600'],       label: 'Preparing' },
  PACKED:            { bg: '#d1fae5',                     fg: primitives.wa['600'],          label: 'Ready' },
  ready:             { bg: '#d1fae5',                     fg: primitives.wa['600'],          label: 'Ready' },
  DISPATCHED:        { bg: '#ede9fe',                     fg: '#6d28d9',                     label: 'Out for Delivery' },
  out_for_delivery:  { bg: '#ede9fe',                     fg: '#6d28d9',                     label: 'Out for Delivery' },
  DELIVERED:         { bg: primitives.neutral['100'],     fg: primitives.neutral['600'],     label: 'Delivered' },
  delivered:         { bg: primitives.neutral['100'],     fg: primitives.neutral['600'],     label: 'Delivered' },
  CANCELLED:         { bg: primitives.red['100'],         fg: primitives.red['600'],         label: 'Cancelled' },
  cancelled:         { bg: primitives.red['100'],         fg: primitives.red['600'],         label: 'Cancelled' },
} as const;

// Subscription badge — owner dashboard / branches list. Replaces the
// duplicated literals in staff-app/app/(owner)/dashboard.tsx and
// staff-app/app/(owner)/branches/index.tsx (audit §3.7).
export const subscriptionBadge = {
  active:  { bg: primitives.wa.light,        fg: primitives.wa['600']      },
  paused:  { bg: primitives.red['100'],      fg: primitives.red['600']     },
  default: { bg: primitives.neutral['100'],  fg: primitives.neutral['600'] },
} as const;

// Default export — full RN-shape token object. The generator
// JSON.stringify's this directly into staff-app/src/styling/_generated/tokens.ts.
const tokens = {
  colors: {
    primitives,
    overlays,
    semantic: {
      landing:   resolveSemantic(semanticLanding),
      dashboard: dashboardSemanticResolved,
    },
    landingExtras: resolveSemantic(landingExtras),
    // Pre-resolved flat surface that mirrors the legacy theme.ts shape
    // — staff-app screens consume `tokens.colors.surface.{key}` as a
    // drop-in replacement for `colors.{key}`.
    surface: colors,
    statusBadge,
    subscriptionBadge,
  },
  typography: {
    families: fontFamilies,
    sizes:    pxOnly(sizes),
    weights,
    lineHeights,
  },
  spacing: pxOnly(spacing),
  radii: {
    ...pxOnly(radii),
    // --r alias — RN consumers default to dashboard (12px) since the RN apps
    // are dashboard-flavored.
    r: rAlias.dashboard.px,
  },
  shadows: {
    elevation,
  },
  layout: {
    zIndex,
    containers,
  },
  breakpoints,
  components: {
    card: {
      paddingDefault: card.paddingDefault,
      // RN consumers pull radius via tokens.radii.{lg|xl}; the {ref}
      // form is web-only.
    },
    button: {
      height:   button.height,
      // gap as a numeric px value for RN. 0.38rem ≈ 6px.
      gap:      6,
    },
    input: {
      height:   input.height,
    },
    modal: {
      backdropColor: overlays.modal,
      zIndex:        zIndex.modal,
    },
  },
} as const;

export default tokens;
