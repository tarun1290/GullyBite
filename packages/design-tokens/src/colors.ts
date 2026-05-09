// Color tokens — primitives + semantic (landing + dashboard) + overlays.
//
// Primitives are raw palette values (hex). Semantic tokens reference a
// primitive (`ref`) and resolve to a literal `value`. The CSS generator
// emits `var(--primitive-…)` for any token with a ref; the RN
// generator uses the resolved `value`.
//
// Brand-accent codification (Part 2):
//   - Landing/auth `--acc` keeps indigo (#4f46e5) — landing & auth surfaces
//     retain indigo branding.
//   - Dashboard `--acc` is teal (#0F766E) — the dashboard already overrides
//     to teal in dashboard.css; native.ts mirrors the dashboard surface so
//     the staff/owner RN app aligns to teal.
//   - Indigo primitives (indigo.500–800, violet.600) STAY — consumed by
//     the dashboard's .sb-av / .logo-ring gradient and by landing.
//
// Deferred from this package (Part 7 cleanup decides backing or deletion):
//   - The 2 unused tokens in the live colors.css (`--accent-color`,
//     `--accent-color-soft`).
//   - The 11 Tailwind `@theme` vars referenced in frontend/src/styles/global.css
//     but never defined: --fg, --green, --bdr, --bd, --panel, --brand-50,
//     --brand-300, --brand-600, --bg-soft, --line, --primary.

export type SemanticToken = {
  // Path into `primitives` or `overlays`, dot-separated. The CSS generator
  // emits `var(--primitive-{path-flat})`. `null` = no primitive backing,
  // emit the literal value (e.g. dashboard --ink which has no primitive
  // match in the existing token tree).
  ref: string | null;
  // Resolved literal value (hex / rgba / clamp). Always populated.
  value: string;
};

// ─── Primitives ─────────────────────────────────────────────────────────

export const primitives = {
  // Tailwind neutral/gray — used by dashboard/admin
  neutral: {
    '0':   '#ffffff',
    '50':  '#f9fafb',
    '100': '#f3f4f6',
    '200': '#e5e7eb',
    '300': '#d1d5db',
    '400': '#9ca3af',
    '500': '#6b7280',
    '600': '#4b5563',
    '700': '#374151',
    '800': '#1f2937',
    '900': '#111827',
  },
  // Tailwind slate — used by landing/auth
  slate: {
    '50':  '#f8fafc',
    '100': '#f1f5f9',
    '200': '#e2e8f0',
    '300': '#cbd5e1',
    '400': '#94a3b8',
    '500': '#64748b',
    '600': '#475569',
    '700': '#334155',
    '800': '#1e293b',
    '900': '#0f172a',
  },
  // Indigo — landing accent + dashboard logo gradient. STAYS in this package
  // even though dashboard --acc is teal; the gradient and landing surfaces
  // keep indigo.
  indigo: {
    '100': '#e0e7ff', // (audit §5.1 new) past-mode pill bg
    '500': '#6366f1',
    '600': '#4f46e5',
    '700': '#4338ca',
    '800': '#3730a3',
  },
  violet: {
    '600': '#7c3aed',
  },
  // Teal — dashboard action color. Brand decision: RN colors.acc resolves here.
  teal: {
    '700':      '#0F766E',
    '800':      '#0D5F58',
    '700-glow': 'rgba(15, 118, 110, 0.18)',
  },
  // Fresh Leaf green — landing brand palette
  green: {
    '50':  '#E6F5EC',
    '100': '#C7E8D5',
    '300': '#5DBD8F',
    '500': '#0D9B6A',
    '600': '#078A5A',
    '700': '#04724A',
    '900': '#0A1F17',
  },
  // WhatsApp green (status + wa-connect CTA)
  wa: {
    light:   '#dcfce7',
    '500':   '#16a34a',
    '600':   '#15803d',
    // (audit §5.1 new) Official WhatsApp brand green — distinct from
    // operational success green (--gb-wa-500 #16a34a). Used by .btn-wa
    // and the staff PWA login banner.
    brand:       '#25D366',
    'brand-hover': '#1fbd5a',
  },
  // Status: red / amber / blue / orange / rose
  red: {
    '100': '#fee2e2',
    '200': '#fecaca',
    '300': '#fca5a5', // (audit §5.1 new) error chip text
    '500': '#dc2626',
    '600': '#b91c1c',
    '900': '#991b1b',
  },
  amber: {
    '100': '#fef3c7',
    '200': '#fde68a', // (audit §5.1 new) warning-box bg, dashboard admin
    '500': '#d97706',
    '600': '#b45309',
    '900': '#92400e', // (audit §5.1 new) warning text, notification banner
  },
  blue: {
    '100': '#dbeafe', // (audit §5.1 new) CONFIRMED status badge bg
    '500': '#2563eb',
    '600': '#1d4ed8',
  },
  orange: {
    '200': '#fed7aa', // (audit §5.1 new) PREPARING status badge bg
    '500': '#F28D35',
  },
  rose: {
    '50':  '#fff1f2', // (audit §5.1 new) error toast bg
  },
  // Landing warmth surfaces
  cream: '#FAF8F3',
  sand:  '#F3EFE6',
  // GullyBite brand palette (landing surfaces)
  brand: {
    yellow:        '#F9C303',
    red:           '#E42623',
    green:         '#0D5F3C',
    'green-hover': '#0A4A2E',
    cream:         '#F9F8F1',
  },
} as const;

// ─── Overlays ───────────────────────────────────────────────────────────

// Translucent values that don't fit the "primitive ramp" model — modal
// backdrops, glow halos, status-state tints. Stored flat so the CSS
// generator emits `--overlay-{key}` directly.
export const overlays = {
  // Modal backdrop — currently inconsistent across RN screens (audit §3.7).
  // This token codifies one value; RN screens migrate in Part 5.
  modal:        'rgba(0,0,0,0.5)',
  modalTinted:  'rgba(15,23,42,0.45)',
  // Red status overlays — staff PWA orders page uses two opacities
  // inconsistently (audit §2.4); this package collapses them to one fill
  // and one stroke value.
  redGlow:      'rgba(220,38,38,0.10)',
  redStroke:    'rgba(220,38,38,0.45)',
  // Existing landing/dashboard glows preserved (verbatim from colors.css
  // and dashboard.css):
  accGlowLanding:   'rgba(79, 70, 229, .12)',  // landing --acc-glow
  accGlowDashboard: 'rgba(15, 118, 110, 0.18)', // dashboard --acc-glow
  waGlow:           'rgba(22, 163, 74, .1)',
  goldGlow:         'rgba(217, 119, 6, .1)',
} as const;

// ─── Semantic — landing/auth defaults ───────────────────────────────────
//
// Mirrors the existing :root block in frontend/src/styles/tokens/colors.css.
// The CSS generator emits these on `:root` so landing/auth surfaces inherit
// them by default. Tokens whose value is not backed by a primitive carry
// `ref: null` — the generator emits the literal.

export const semanticLanding: Record<string, SemanticToken> = {
  bg:        { ref: 'slate.100',     value: '#f1f5f9' },
  bg2:       { ref: 'neutral.0',     value: '#ffffff' },
  surface:   { ref: null,            value: '#fff' },
  surface2:  { ref: 'slate.100',     value: '#f1f5f9' },
  rim:       { ref: 'slate.200',     value: '#e2e8f0' },
  rim2:      { ref: 'slate.300',     value: '#cbd5e1' },
  tx:        { ref: 'slate.900',     value: '#0f172a' },
  dim:       { ref: 'slate.500',     value: '#64748b' },
  mute:      { ref: 'slate.400',     value: '#94a3b8' },
  acc:       { ref: 'indigo.600',    value: '#4f46e5' },
  acc2:      { ref: 'indigo.700',    value: '#4338ca' },
  'acc-glow':{ ref: 'overlays.accGlowLanding', value: 'rgba(79, 70, 229, .12)' },
  wa:        { ref: 'wa.500',        value: '#16a34a' },
  'wa-light':{ ref: 'wa.light',      value: '#dcfce7' },
  gold:      { ref: 'amber.500',     value: '#d97706' },
  red:       { ref: 'red.500',       value: '#dc2626' },
};

// ─── Semantic — dashboard overrides ─────────────────────────────────────
//
// Mirrors the :root block in frontend/src/styles/dashboard.css. The CSS
// generator emits these inside `[data-surface="dashboard"], .dashboard-surface`
// so dashboard pages get the override. Tokens that exist ONLY in the
// dashboard scope (--ink, --ink2/3/4, --wa2, --wa-glow, --gold2, --gold-glow,
// --blue) are included here too.

export const semanticDashboard: Record<string, SemanticToken> = {
  // Body bg — no primitive match; literal preserved (dashboard.css:15).
  ink:       { ref: null,            value: '#f8f9fb' },
  ink2:      { ref: 'neutral.0',     value: '#ffffff' },
  ink3:      { ref: 'neutral.0',     value: '#ffffff' },
  ink4:      { ref: 'neutral.100',   value: '#f3f4f6' },
  bg:        { ref: null,            value: '#f8f9fb' },     // alias of --ink for code that reads --bg
  bg2:       { ref: 'neutral.0',     value: '#ffffff' },
  surface:   { ref: 'neutral.0',     value: '#ffffff' },
  surface2:  { ref: 'neutral.100',   value: '#f3f4f6' },
  rim:       { ref: 'neutral.200',   value: '#e5e7eb' },
  rim2:      { ref: 'neutral.300',   value: '#d1d5db' },
  tx:        { ref: 'neutral.900',   value: '#111827' },
  dim:       { ref: 'neutral.500',   value: '#6b7280' },
  mute:      { ref: 'neutral.400',   value: '#9ca3af' },
  acc:       { ref: 'teal.700',      value: '#0F766E' },
  acc2:      { ref: 'teal.800',      value: '#0D5F58' },
  'acc-glow':{ ref: 'teal.700-glow', value: 'rgba(15, 118, 110, 0.18)' },
  wa:        { ref: 'wa.500',        value: '#16a34a' },
  wa2:       { ref: 'wa.600',        value: '#15803d' },
  'wa-glow': { ref: 'overlays.waGlow', value: 'rgba(22, 163, 74, .1)' },
  gold:      { ref: 'amber.500',     value: '#d97706' },
  gold2:     { ref: 'amber.600',     value: '#b45309' },
  'gold-glow': { ref: 'overlays.goldGlow', value: 'rgba(217, 119, 6, .1)' },
  red:       { ref: 'red.500',       value: '#dc2626' },
  blue:      { ref: 'blue.500',      value: '#2563eb' },
};

// ─── Landing-specific tokens ────────────────────────────────────────────
//
// Marketing/landing surfaces only — emitted to :root alongside semanticLanding.
// Not overridden by dashboard. Mirrors lines 129–157 in colors.css.

export const landingExtras: Record<string, SemanticToken> = {
  'landing-hero-bg':        { ref: 'brand.cream',         value: '#F9F8F1' },
  'landing-section-bg':     { ref: 'brand.cream',         value: '#F9F8F1' },
  'landing-section-alt-bg': { ref: 'sand',                value: '#F3EFE6' },
  'landing-dark-bg':        { ref: 'green.900',           value: '#0A1F17' },
  'landing-ink':            { ref: 'green.900',           value: '#0A1F17' },
  'landing-slate':          { ref: 'slate.700',           value: '#334155' },
  'landing-mute':           { ref: 'slate.500',           value: '#64748b' },
  'landing-line':           { ref: 'neutral.200',         value: '#e5e7eb' },
  'cta-primary-bg':         { ref: 'brand.green',         value: '#0D5F3C' },
  'cta-primary-hover':      { ref: 'brand.green-hover',   value: '#0A4A2E' },
  'cta-primary-text':       { ref: 'neutral.0',           value: '#ffffff' },
  'cta-ghost-border':       { ref: 'green.900',           value: '#0A1F17' },
  'cta-ghost-text':         { ref: 'green.900',           value: '#0A1F17' },
  'cta-secondary-bg':       { ref: 'brand.yellow',        value: '#F9C303' },
  'cta-secondary-text':     { ref: 'green.900',           value: '#0A1F17' },
  'landing-accent-yellow':  { ref: 'brand.yellow',        value: '#F9C303' },
  'landing-accent-red':     { ref: 'brand.red',           value: '#E42623' },
};
