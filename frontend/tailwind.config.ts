import type { Config } from 'tailwindcss'

export default {
  content: [
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
    './src/pages/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      // Map the four most-referenced semantic CSS vars (defined in
      // src/styles/tokens/colors.css and re-aliased per surface in
      // src/styles/dashboard.css) so new components can write
      // `className="border-rim text-dim text-tx bg-acc"` instead of
      // `style={{ borderColor: 'var(--rim)', ... }}`. Existing
      // inline-style consumers continue to work unchanged — these are
      // additive, not a replacement.
      colors: {
        rim: 'var(--rim)',
        dim: 'var(--dim)',
        tx:  'var(--tx)',
        acc: 'var(--acc)',
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        fg: 'var(--fg)',
        rim2: 'var(--rim2)',
        green: 'var(--green)',
        red: 'var(--red)',
        'red-500': 'var(--gb-red-500)',
        'neutral-0': 'var(--gb-neutral-0)',
        'wa-500': 'var(--gb-wa-500)',
        ink: 'var(--ink)',
        ink2: 'var(--ink2)',
        ink4: 'var(--ink4)',
        'brand-50': 'var(--brand-50)',
        'brand-300': 'var(--brand-300)',
        'brand-600': 'var(--brand-600)',
        mute: 'var(--mute)',
      },
      boxShadow: {
        'sm-token': 'var(--shadow-sm)',
      },
      // Override responsive prefixes to match the codebase's existing
      // hand-coded @media breakpoints in dashboard.css / global.css.
      // `sm`/`md` keep Tailwind's default values (640/768); `lg`/`xl`
      // override defaults (1024/1280) to align with the existing
      // 900/1024 breakpoints in tokens/breakpoints.css. `xs:480px` is
      // a new prefix matching the narrow-phone edge breakpoint. The
      // legacy `--bp-2xl: 960` is intentionally dropped — the codebase
      // uses it in only one place (landing hero stack) and the closer
      // standard is `lg:900`.
      screens: {
        xs: '480px',
        sm: '640px',
        md: '768px',
        lg: '900px',
        xl: '1024px',
      },
    },
  },
  plugins: [],
} satisfies Config

