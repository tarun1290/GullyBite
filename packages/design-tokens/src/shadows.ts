// Shadow tokens — web (dual scale: soft + crisp) + RN elevation map.
// Ported verbatim from frontend/src/styles/tokens/shadows.css.
//
// Two web scales exist because landing and dashboard had subtly different
// shadow treatments (slate-tinted vs black-tinted). The semantic aliases
// (sm / md / lg) default to soft for landing and crisp for dashboard —
// the CSS generator emits the soft mapping in :root and the crisp
// mapping inside the dashboard-surface block.

export const shadowsWeb = {
  // Soft (slate-tinted) — landing, auth, onboarding
  soft: {
    sm: '0 1px 3px rgba(15, 23, 42, .07), 0 1px 2px rgba(15, 23, 42, .04)',
    md: '0 4px 16px rgba(15, 23, 42, .08)',
    lg: '0 20px 60px rgba(15, 23, 42, .12)',
  },
  // Crisp (black-tinted, Tailwind-flavored) — dashboard, admin
  crisp: {
    sm: '0 1px 2px rgba(0, 0, 0, .04), 0 1px 3px rgba(0, 0, 0, .06)',
    md: '0 4px 6px -1px rgba(0, 0, 0, .07), 0 2px 4px -2px rgba(0, 0, 0, .05)',
    lg: '0 10px 25px -5px rgba(0, 0, 0, .08), 0 8px 10px -6px rgba(0, 0, 0, .04)',
  },
} as const;

// Semantic aliases — landing → soft, dashboard → crisp.
// `--shadow-md` is a symmetric alias of `--shadow` (matches existing
// shadows.css line 30 — added so the *-sm/-md/-lg triplet is symmetric).
export const shadowsSemantic = {
  landing: {
    sm: { ref: 'soft.sm' },
    md: { ref: 'soft.md' },
    lg: { ref: 'soft.lg' },
  },
  dashboard: {
    sm: { ref: 'crisp.sm' },
    md: { ref: 'crisp.md' },
    lg: { ref: 'crisp.lg' },
  },
} as const;

// RN elevation map — RN doesn't render box-shadow strings, it consumes
// shadowColor + shadowOffset + shadowOpacity + shadowRadius (iOS) and
// elevation (Android). Tuned to roughly match the crisp web scale
// visually since the RN apps are dashboard-flavored operational tools.
export const elevation = {
  '0': { shadowColor: '#000', shadowOffset: { width: 0, height: 0  }, shadowOpacity: 0,    shadowRadius: 0,  elevation: 0  },
  '1': { shadowColor: '#000', shadowOffset: { width: 0, height: 1  }, shadowOpacity: 0.06, shadowRadius: 2,  elevation: 1  }, // ~ crisp.sm
  '2': { shadowColor: '#000', shadowOffset: { width: 0, height: 2  }, shadowOpacity: 0.07, shadowRadius: 4,  elevation: 3  }, // ~ crisp.md
  '3': { shadowColor: '#000', shadowOffset: { width: 0, height: 4  }, shadowOpacity: 0.08, shadowRadius: 8,  elevation: 6  }, // ~ crisp.lg
  '4': { shadowColor: '#000', shadowOffset: { width: 0, height: 8  }, shadowOpacity: 0.10, shadowRadius: 16, elevation: 12 },
  '5': { shadowColor: '#000', shadowOffset: { width: 0, height: 16 }, shadowOpacity: 0.14, shadowRadius: 24, elevation: 18 },
} as const;
