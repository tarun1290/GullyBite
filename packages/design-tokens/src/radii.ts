// Radii tokens — border-radius scale.
// Ported verbatim from frontend/src/styles/tokens/radii.css.
//
// dashboard.css spot-check (audit §1.5) shows .card uses var(--r) which is
// var(--radius-xl) under dashboard scope (12px); .btn uses var(--radius-md)
// (8px); .chip uses 100px (a literal — pill style, intentionally not in scale);
// .notice uses 0.625rem (= 10px = --radius-lg). All values match this scale
// except .chip's 100px pill which intentionally bypasses the named scale.

export const radii = {
  none:  { css: '0',      px: 0    },
  sm:    { css: '6px',    px: 6    },
  md:    { css: '8px',    px: 8    },
  lg:    { css: '10px',   px: 10   },
  xl:    { css: '12px',   px: 12   },
  '2xl': { css: '16px',   px: 16   },
  '3xl': { css: '20px',   px: 20   },
  full:  { css: '9999px', px: 9999 },
} as const;

// Legacy --r alias — surface-dependent.
//   landing/auth (global.css :root):  --r = --radius-lg (10px)
//   dashboard    (dashboard.css):     --r = --radius-xl (12px)
//
// CSS generator emits two values: the landing default goes on :root,
// the dashboard override goes inside the dashboard-surface block.
export const rAlias = {
  landing:   { ref: 'lg', css: '10px', px: 10 },
  dashboard: { ref: 'xl', css: '12px', px: 12 },
} as const;
