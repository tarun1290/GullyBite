// Component default tokens.
//
// Net-new in this package — fills the "thin component defaults" gap
// (STYLING_PARITY_AUDIT.md §1.4). Values are extracted from
// frontend/src/styles/dashboard.css patterns. Where dashboard.css is
// internally inconsistent (audit §1.5: `.ch` / `.cb` / `--card-padding`
// disagree), this token codifies what's currently shipped (the actual
// `.ch` and `.cb` paddings) and treats `--card-padding` as a legacy alias
// — the existing `1.3rem` value is preserved so a future component that
// adopts the token isn't forced into a pixel shift.

// ─── Card ───────────────────────────────────────────────────────────
//
// Direct reads from dashboard.css:
//   .ch                           padding: 1rem 1.5rem        (16 / 24)
//   .cb                           padding: 1.4rem 1.5rem      (22.4 / 24) ← vertical mismatch with .ch, preserved
//   .card > *:not(.ch):not(.cb)   padding: 1.25rem 1.5rem     (20 / 24)
//   --card-padding (live token)   1.3rem                       (currently unused)

export const card = {
  paddingHeader:   '1rem 1.5rem',     // .ch
  paddingBody:     '1.4rem 1.5rem',   // .cb
  paddingFallback: '1.25rem 1.5rem',  // .card > *:not(.ch):not(.cb)
  paddingDefault:  '1.3rem',          // legacy --card-padding alias
  // Card outer radius — pulls from rAlias (legacy --r), which resolves
  // to radius.lg (10px) on landing and radius.xl (12px) on dashboard.
  radius:          { ref: 'r' },
} as const;

// ─── Button ─────────────────────────────────────────────────────────
//
// Direct reads from dashboard.css:
//   .btn / .btn-p   padding: .52rem 1.1rem   font-size: .8rem    min-height: 2rem
//   .btn-g          padding: .48rem .95rem   font-size: .78rem   min-height: 1.9rem
//   .btn-sm         padding: .3rem .65rem    font-size: .73rem   (no min-height — inherits .btn)
//   .btn-xs         padding: .2rem .55rem    font-size: .7rem    min-height: 1.5rem
//   .btn-del        padding: .4rem .75rem    font-size: .76rem
//
// `height.{sm,md,lg}` are RN px equivalents tuned to look right next to
// the rem-based web sizes. `lg` doesn't have a web counterpart; it's a
// native-only bigger touch target.

export const button = {
  paddingX: { md: '1.1rem', sm: '0.65rem',  xs: '0.55rem' },
  paddingY: { md: '0.52rem', sm: '0.3rem',   xs: '0.2rem' },
  fontSize: { md: '0.8rem', sm: '0.73rem', xs: '0.7rem' },
  minHeight: { md: '2rem', xs: '1.5rem' },
  // RN-friendly numeric heights (audit §1.4 — these are net-new).
  height:   { sm: 28, md: 36, lg: 44 },
  radius:   { ref: 'radius.md' },
  gap:      '0.38rem',
} as const;

// ─── Input ──────────────────────────────────────────────────────────
//
// Direct read from dashboard.css `.inp, input, select, textarea`:
//   padding: .52rem .8rem   font-size: .82rem   border-radius: var(--radius-md)
//
// `height` is a net-new RN-friendly numeric token (web sizes via
// padding + line-height which lands ~40px tall).

export const input = {
  height:   40,         // RN dp / px
  paddingX: '0.8rem',
  paddingY: '0.52rem',
  fontSize: '0.82rem',
  radius:   { ref: 'radius.md' },
} as const;

// ─── Modal ──────────────────────────────────────────────────────────
//
// Backdrop and z-index aliases. The `ref` strings are resolved by the
// CSS generator to `var(--overlay-modal)` and `var(--z-modal-backdrop)`.

export const modal = {
  backdropColor: { ref: 'overlays.modal' },
  zIndex:        { ref: 'zIndex.modal' },
} as const;
