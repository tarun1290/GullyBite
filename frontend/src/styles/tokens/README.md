# GullyBite Design Tokens

Authoritative source for colors, typography, spacing, radii, shadows, z-index layers, breakpoints. Every component should reference tokens, not literal values.

## Two-layer system

Tokens are split into two layers. Components should almost always reference the second layer.

**Layer 1 — Primitives (`--gb-*`)**: raw palette values. Edit when adding a new shade or correcting a scale. Never reference directly from a feature component unless no semantic fits.

**Layer 2 — Semantics (`--bg`, `--tx`, `--acc`, `--radius-md`, etc.)**: usage-intent aliases that point at primitives. This is the stable contract components depend on.

Example — landing/auth:
```
--gb-indigo-600: #4f46e5      ← primitive
--acc:           var(--gb-indigo-600)   ← semantic (landing default)
```

Dashboard/admin re-bind a handful of semantics to neutral-gray primitives in the `:root` block at the top of `dashboard.css`. That surface keeps its original look because semantics are re-routed, not because it ignores tokens.

## File structure

```
src/styles/tokens/
  index.css         — entry (imported by global.css)
  colors.css        — palette primitives + landing/auth semantic defaults
  typography.css    — font families, size scale, weight scale, line-heights
  spacing.css       — 4px-based scale (--space-0..32)
  radii.css         — --radius-sm/md/lg/xl/2xl/3xl/full + --r alias
  shadows.css       — soft (slate-tinted) + crisp (black-tinted) + legacy aliases
  layout.css        — z-index layers, container widths
  breakpoints.css   — documented constants (CSS vars can't be used in @media)
```

`global.css` imports `./tokens/index.css` first; all other stylesheets inherit tokens via the `:root` cascade.

## Using tokens

### CSS

```css
.card {
  background: var(--bg2);
  border: 1px solid var(--rim);
  border-radius: var(--radius-md);
  padding: var(--space-4) var(--space-5);
  color: var(--tx);
  box-shadow: var(--shadow-sm);
}
```

### React inline styles

`style={{}}` accepts `'var(...)'` strings:

```jsx
<span style={{ color: 'var(--gb-red-500)', fontSize: 'var(--text-sm)' }}>
  Error
</span>
```

### Media queries

CSS custom properties are not supported inside `@media` conditions in any shipped browser (the custom-media spec is still a draft). Use the literal pixel values documented in `breakpoints.css`:

```css
@media (max-width: 768px) { ... }
```

## Per-surface semantic overrides

Landing/auth and dashboard/admin share the same primitives but route a handful of semantics differently:

| Semantic   | Landing/auth default  | Dashboard override           |
|------------|-----------------------|------------------------------|
| `--bg`     | `--gb-slate-100`      | `--ink` (`#f8f9fb`)          |
| `--tx`     | `--gb-slate-900`      | `--gb-neutral-900`           |
| `--dim`    | `--gb-slate-500`      | `--gb-neutral-500`           |
| `--rim`    | `--gb-slate-200`      | `--gb-neutral-200`           |
| `--acc`    | `--gb-indigo-600`     | `--gb-indigo-700`            |
| `--r`      | `--radius-lg` (10px)  | `--radius-xl` (12px)         |
| `--shadow-*` | `--shadow-soft-*`   | `--shadow-crisp-*`           |

The override block lives at the top of `dashboard.css`. Landing uses the slate scale; dashboard uses Tailwind's neutral-gray and a slightly deeper indigo/crisper shadows, matching its pre-refactor look exactly.

## How to add a new token

1. If you need a new primitive shade, add it to the right scale in `colors.css` (e.g., `--gb-blue-400`). Primitives are named after the palette, not the usage.
2. If you need a new semantic alias (e.g., `--color-success-text`), add it to `colors.css` under the semantic section and map it to an existing primitive.
3. If the token is surface-specific (different on dashboard vs landing), add the default mapping in `colors.css` and the dashboard override in `dashboard.css`' `:root` block.

## How to change a brand color

Change the primitive in `colors.css`. Every component that uses the corresponding semantic will update automatically.

Example — to swap landing's indigo CTA to a different hex:
```css
/* colors.css */
--gb-indigo-600: #5855e6;   /* was #4f46e5 */
```
No component edits required.

## Anti-patterns to avoid

- **Literal hex in a new component.** Reach for `--tx`, `--dim`, `--acc`, `--gb-*` first. Literals are only acceptable for a one-off surface that has no matching token (and even then, consider adding a primitive).
- **Referencing a primitive where a semantic exists.** Use `var(--tx)` for body text, not `var(--gb-neutral-900)` directly. Primitives can be renumbered; semantics are the stable contract.
- **Using tokens inside `rgba(...)` alpha channels.** CSS `var()` can't carry an alpha byte. Keep those literal, or define a glow token (`--acc-glow`) once.
- **Putting a semantic override anywhere except the surface's `:root`.** If dashboard needs a different `--acc`, it belongs in the `dashboard.css` `:root` block — not inline on individual components.

## Scale reference

Type scale (`typography.css`): `--text-xs` / `sm` / `base` / `md` / `lg` / `xl` / `2xl` / `3xl` / `4xl` (clamp).

Spacing (`spacing.css`): `--space-1..8` at 4px increments, then `10/12/14/16/20/24/32` at 8px-then-wider increments. Matches Tailwind's default spacing scale.

Radii (`radii.css`): `--radius-sm` (6px) / `md` (8px) / `lg` (10px) / `xl` (12px) / `2xl` (16px) / `3xl` (20px) / `full` (9999px).

Z-index (`layout.css`): 100-unit gaps — `--z-base` (0) / `--z-dropdown` (100) / `--z-sticky` (200) / `--z-overlay` (300) / `--z-modal` (400) / `--z-popover` (500) / `--z-toast` (600) / `--z-tooltip` (700). Dashboard still uses legacy literal z-indexes (40/50/55/60/9999) because the original stacking order doesn't align with the 100-unit scale.

Breakpoints (`breakpoints.css`, documented constants): 480 / 640 / 768 / 900 / 960 / 1024.

## What isn't tokenized (yet)

Pixel-oddball values are deliberately left as literals to preserve dashboard/admin pixel parity:

- Non-scale radii: `7px`, `9px`, `11px`, `100px` (pill).
- Non-scale font-sizes: `.58rem`, `.65rem`, `.7rem`, `.74rem`, `.78rem`, `.83rem`, etc.
- Non-scale paddings/gaps: `.26rem`, `.28rem`, `.35rem`, `.52rem`, `.65rem`, etc.
- Pastel tint backgrounds: `#fafbfc`, `#f5f6f8`, `#fff1f2`, `#f0fdf4`, `#eff6ff`, etc.
- Alpha-channel rgba (`rgba(67, 56, 202, .12)` glows).

Migrating these is Part 1+ work — they need either new primitive entries or designer-approved rounding. Don't force them into the scale ad-hoc.
