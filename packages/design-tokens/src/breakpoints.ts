// Breakpoints — numeric pixel values.
//
// CSS custom properties cannot be used in @media queries (the
// custom-media spec is still a draft and unshipped in browsers); these
// are documented for use in the generated CSS as raw values via the
// build script, and as numeric breakpoints in JS/RN logic.
//
// Values match the existing frontend/src/styles/tokens/breakpoints.css
// verbatim. Future consolidation target (per a comment in that file) is
// 640 / 768 / 1024 — the package preserves all six current points so
// dashboard.css migration in Part 3 doesn't need to chase down stray
// 900 / 960 @media rules in the same pass.

export const breakpoints = {
  sm:    480,
  md:    640,
  lg:    768,
  xl:    900,
  '2xl': 960,
  '3xl': 1024,
} as const;
