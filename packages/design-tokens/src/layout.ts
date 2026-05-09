// Layout tokens — z-index layers + container widths.
//
// Reconciled with frontend/src/styles/tokens/layout.css verbatim
// (Part 3). Earlier Part 2 spec used a different shape with separate
// `fixed` and `modal-backdrop` slots; that's been dropped to keep the
// generated CSS drop-in compatible with the live consumers
// (--z-overlay / --z-toast are referenced by dashboard chrome).

export const zIndex = {
  base:     0,
  dropdown: 100,
  sticky:   200,
  overlay:  300,
  modal:    400,
  popover:  500,
  toast:    600,
  tooltip:  700,
} as const;

export const containers = {
  narrow: 640,
  base:   960,
  wide:   1120,
  max:    1280,
} as const;
