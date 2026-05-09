// Spacing tokens — 4px-based scale.
// Ported verbatim from frontend/src/styles/tokens/spacing.css.
//
// Use for padding / gap / margin. The CSS generator emits rem strings;
// the RN generator emits raw px integers (RN style numeric values are
// in dp, which equals px on iOS and roughly px on Android).
//
// Oddball legacy values (0.26rem, 1.3rem, 1.8rem, 2.4rem) deliberately
// stay literal in the dashboard CSS — forcing them into the scale would
// produce visible pixel shifts.

export const spacing = {
  '0':  { css: '0',       px: 0   },
  '1':  { css: '0.25rem', px: 4   },
  '2':  { css: '0.5rem',  px: 8   },
  '3':  { css: '0.75rem', px: 12  },
  '4':  { css: '1rem',    px: 16  },
  '5':  { css: '1.25rem', px: 20  },
  '6':  { css: '1.5rem',  px: 24  },
  '7':  { css: '1.75rem', px: 28  },
  '8':  { css: '2rem',    px: 32  },
  '10': { css: '2.5rem',  px: 40  },
  '12': { css: '3rem',    px: 48  },
  '14': { css: '3.5rem',  px: 56  },
  '16': { css: '4rem',    px: 64  },
  '20': { css: '5rem',    px: 80  },
  '24': { css: '6rem',    px: 96  },
  '32': { css: '8rem',    px: 128 },
} as const;
