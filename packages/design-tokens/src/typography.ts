// Typography tokens — families, sizes, weights, line-heights.
// Ported verbatim from frontend/src/styles/tokens/typography.css.
//
// Each size carries `css` (the rem string emitted to CSS) and `px`
// (numeric px equivalent for RN consumers). The 4xl size uses clamp()
// in CSS; for RN we expose the upper bound rounded to whole px.

export const fontFamilies = {
  // Landing/auth stack — no -apple-system in fallback (preserves existing behavior).
  sans: "'Plus Jakarta Sans', system-ui, sans-serif",
  // Dashboard stacks — adds -apple-system in fallback.
  head: "'Plus Jakarta Sans', system-ui, -apple-system, sans-serif",
  body: "'Plus Jakarta Sans', system-ui, -apple-system, sans-serif",
  mono: "ui-monospace, 'SF Mono', Menlo, monospace",
} as const;

export const sizes = {
  xs:    { css: '0.72rem', px: 11.5 }, // microcopy, captions
  sm:    { css: '0.82rem', px: 13 },   // body small, buttons
  base:  { css: '0.87rem', px: 14 },   // default body
  md:    { css: '0.95rem', px: 15 },   // nav, inputs
  lg:    { css: '1.05rem', px: 17 },   // lead body
  xl:    { css: '1.25rem', px: 20 },   // h4
  '2xl': { css: '1.6rem',  px: 26 },   // h3
  '3xl': { css: '2rem',    px: 32 },   // h2
  // Responsive h1: clamp(2.2rem, 4.8vw, 3.6rem). RN uses upper bound.
  '4xl': { css: 'clamp(2.2rem, 4.8vw, 3.6rem)', px: 58 },
} as const;

export const weights = {
  regular:    400,
  medium:     500,
  semibold:   600,
  bold:       700,
  extrabold:  800,
} as const;

export const lineHeights = {
  tight:   1.1,   // tight headings
  snug:    1.3,   // short paragraphs / dense UI
  normal:  1.5,   // default body
  relaxed: 1.65,  // landing prose
  loose:   1.75,  // long-form sections
} as const;
