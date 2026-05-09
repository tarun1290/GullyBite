// Barrel re-export. Web consumers import named exports from here; RN
// consumers either import the resolved default from `./native` (via the
// generated tokens.ts file in staff-app), or import this module directly
// for typed access to the source-of-truth shape.

export * from './colors';
export * from './typography';
export * from './spacing';
export * from './radii';
export * from './shadows';
export * from './layout';
export * from './breakpoints';
export * from './components';

// Re-import for the aggregate `tokens` object below.
import * as colorsMod from './colors';
import * as typographyMod from './typography';
import * as spacingMod from './spacing';
import * as radiiMod from './radii';
import * as shadowsMod from './shadows';
import * as layoutMod from './layout';
import * as breakpointsMod from './breakpoints';
import * as componentsMod from './components';

// Web-style aggregate. Generators read this; downstream code can also
// import it directly when it wants a single namespace.
export const tokens = {
  colors:       colorsMod,
  typography:   typographyMod,
  spacing:      spacingMod,
  radii:        radiiMod,
  shadows:      shadowsMod,
  layout:       layoutMod,
  breakpoints:  breakpointsMod,
  components:   componentsMod,
} as const;

// RN re-export shape — pre-resolved literals, brand-accent flipped to teal.
export { default as native } from './native';
