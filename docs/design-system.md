# Credence Design System

Single source of truth for UI primitives. All colors, spacing, border radius, and
typography are defined as CSS custom properties in `src/index.css` and consumed via
`var(--credence-*)` throughout any UI layer.

## Quick Start

```html
<!-- HTML -->
<link rel="stylesheet" href="./src/index.css" />
```

```css
/* CSS / SCSS */
@import url('../src/index.css');

.button {
  background: var(--credence-color-accent);
  padding: var(--credence-space-2) var(--credence-space-4);
  border-radius: var(--credence-radius-md);
  font-family: var(--credence-font-sans);
  font-size: var(--credence-text-sm);
  font-weight: var(--credence-font-weight-semibold);
}
```

**Rule:** Never write a hex value or raw `px` size in component CSS. Use a token.

---

## Token Reference

### Colors — Primary

Blue palette. Conveys trust, authority, and financial precision.

| Token | Hex | Typical use |
|---|---|---|
| `--credence-color-primary-50` | `#eff6ff` | Subtle tint backgrounds, hover highlights |
| `--credence-color-primary-100` | `#dbeafe` | Light backgrounds, tags |
| `--credence-color-primary-200` | `#bfdbfe` | Borders, dividers on primary surfaces |
| `--credence-color-primary-300` | `#93c5fd` | Decorative accents |
| `--credence-color-primary-400` | `#60a5fa` | Secondary interactive elements |
| `--credence-color-primary-500` | `#3b82f6` | Brand baseline reference |
| `--credence-color-primary-600` | `#2563eb` | Primary CTAs, links (4.68:1 on white) |
| `--credence-color-primary-700` | `#1d4ed8` | Hover/focus states (5.9:1 on white) |
| `--credence-color-primary-800` | `#1e40af` | Active/pressed states |
| `--credence-color-primary-900` | `#1e3a8a` | Text on light backgrounds |

### Colors — Neutral

Cool slate grays. Slightly blue-tinted for cohesion with the primary palette.

| Token | Hex | Typical use |
|---|---|---|
| `--credence-color-neutral-50` | `#f8fafc` | Page backgrounds |
| `--credence-color-neutral-100` | `#f1f5f9` | Card/panel backgrounds |
| `--credence-color-neutral-200` | `#e2e8f0` | Default borders |
| `--credence-color-neutral-300` | `#cbd5e1` | Subtle borders, placeholder text |
| `--credence-color-neutral-400` | `#94a3b8` | Disabled text, icons |
| `--credence-color-neutral-500` | `#64748b` | Captions, metadata |
| `--credence-color-neutral-600` | `#475569` | Secondary body text (5.9:1 on white) |
| `--credence-color-neutral-700` | `#334155` | Emphasized body text |
| `--credence-color-neutral-800` | `#1e293b` | Headings |
| `--credence-color-neutral-900` | `#0f172a` | High-contrast text, near-black |

### Colors — Semantic

Each semantic group has three variants: `light` (background tint), `base` (default),
`dark` (hover / high-contrast use).

| Token | Hex | Group |
|---|---|---|
| `--credence-color-success-light` | `#f0fdf4` | Success background |
| `--credence-color-success-base` | `#16a34a` | Success default (4.5:1+ on white) |
| `--credence-color-success-dark` | `#15803d` | Success hover |
| `--credence-color-error-light` | `#fef2f2` | Error background |
| `--credence-color-error-base` | `#dc2626` | Error default (4.5:1 on white) |
| `--credence-color-error-dark` | `#b91c1c` | Error hover |
| `--credence-color-warning-light` | `#fffbeb` | Warning background |
| `--credence-color-warning-base` | `#d97706` | Warning default |
| `--credence-color-warning-dark` | `#b45309` | Warning hover |
| `--credence-color-info-light` | `#eff6ff` | Info background |
| `--credence-color-info-base` | `#2563eb` | Info default |
| `--credence-color-info-dark` | `#1d4ed8` | Info hover |

### Colors — Semantic Aliases

High-level aliases that map to primitives. Prefer these in component code.

| Token | Maps to | Purpose |
|---|---|---|
| `--credence-color-bg-page` | `neutral-50` | Page / app background |
| `--credence-color-bg-surface` | `#ffffff` | Card / panel surface |
| `--credence-color-bg-elevated` | `neutral-100` | Elevated surface (dropdown, modal) |
| `--credence-color-text-primary` | `neutral-900` | Primary body text |
| `--credence-color-text-secondary` | `neutral-600` | Secondary / supporting text |
| `--credence-color-text-disabled` | `neutral-400` | Disabled state text |
| `--credence-color-text-inverse` | `#ffffff` | Text on dark backgrounds |
| `--credence-color-border` | `neutral-200` | Default border |
| `--credence-color-border-strong` | `neutral-400` | Prominent border |
| `--credence-color-accent` | `primary-600` | Primary interactive color |
| `--credence-color-accent-hover` | `primary-700` | Hover on accent elements |
| `--credence-color-accent-subtle` | `primary-50` | Subtle accent tint |

---

### Spacing

4px base grid. All values in `rem` for accessibility (scales with browser font size).

| Token | rem | px | Use |
|---|---|---|---|
| `--credence-space-px` | — | 1px | Hairline rules |
| `--credence-space-0` | `0` | 0 | Zero |
| `--credence-space-0-5` | `0.125rem` | 2px | Micro gaps |
| `--credence-space-1` | `0.25rem` | 4px | Tight padding |
| `--credence-space-1-5` | `0.375rem` | 6px | — |
| `--credence-space-2` | `0.5rem` | 8px | Compact padding |
| `--credence-space-2-5` | `0.625rem` | 10px | — |
| `--credence-space-3` | `0.75rem` | 12px | Small padding |
| `--credence-space-4` | `1rem` | 16px | Default padding |
| `--credence-space-5` | `1.25rem` | 20px | — |
| `--credence-space-6` | `1.5rem` | 24px | Section padding |
| `--credence-space-8` | `2rem` | 32px | Large padding |
| `--credence-space-10` | `2.5rem` | 40px | — |
| `--credence-space-12` | `3rem` | 48px | Section gaps |
| `--credence-space-16` | `4rem` | 64px | Page sections |
| `--credence-space-20` | `5rem` | 80px | Large sections |
| `--credence-space-24` | `6rem` | 96px | Hero / layout gaps |

---

### Border Radius

Conservative by default — financial UIs trend towards authority, not playfulness.

| Token | Value | px | Use |
|---|---|---|---|
| `--credence-radius-none` | `0` | 0 | Tables, dividers |
| `--credence-radius-sm` | `0.125rem` | 2px | Subtle rounding |
| `--credence-radius-base` | `0.25rem` | 4px | Inputs, small buttons |
| `--credence-radius-md` | `0.375rem` | 6px | Cards, panels (default) |
| `--credence-radius-lg` | `0.5rem` | 8px | Modals, large cards |
| `--credence-radius-xl` | `0.75rem` | 12px | Large panels |
| `--credence-radius-2xl` | `1rem` | 16px | Hero cards |
| `--credence-radius-3xl` | `1.5rem` | 24px | Pill-style containers |
| `--credence-radius-full` | `9999px` | — | Badges, avatars, status pills |

---

### Typography — Font Families

| Token | Stack |
|---|---|
| `--credence-font-sans` | Inter → system-ui → sans-serif fallback chain |
| `--credence-font-mono` | JetBrains Mono → ui-monospace → Consolas fallback chain |

Use `--credence-font-mono` for wallet addresses, hashes, and cryptographic identifiers.

### Typography — Font Sizes

| Token | rem | px | Use |
|---|---|---|---|
| `--credence-text-xs` | `0.75rem` | 12px | Labels, legal text, captions |
| `--credence-text-sm` | `0.875rem` | 14px | Secondary body, table cells |
| `--credence-text-base` | `1rem` | 16px | Body copy default |
| `--credence-text-lg` | `1.125rem` | 18px | Lead paragraphs |
| `--credence-text-xl` | `1.25rem` | 20px | Card titles, sub-headings |
| `--credence-text-2xl` | `1.5rem` | 24px | Section headings |
| `--credence-text-3xl` | `1.875rem` | 30px | Page headings |
| `--credence-text-4xl` | `2.25rem` | 36px | Hero headings |
| `--credence-text-5xl` | `3rem` | 48px | Display text |

### Typography — Font Weights

| Token | Value | Use |
|---|---|---|
| `--credence-font-weight-regular` | `400` | Body text |
| `--credence-font-weight-medium` | `500` | UI labels, emphasized text |
| `--credence-font-weight-semibold` | `600` | Sub-headings, CTAs |
| `--credence-font-weight-bold` | `700` | Headings, high-emphasis |

### Typography — Line Heights

| Token | Value | Use |
|---|---|---|
| `--credence-leading-none` | `1` | Badges, chips (single-line UI) |
| `--credence-leading-tight` | `1.25` | Headings |
| `--credence-leading-snug` | `1.375` | Sub-headings |
| `--credence-leading-normal` | `1.5` | Body copy default |
| `--credence-leading-relaxed` | `1.625` | Long-form documentation |
| `--credence-leading-loose` | `2` | Spacious lists |

### Typography — Letter Spacing

| Token | Value | Use |
|---|---|---|
| `--credence-tracking-tighter` | `-0.05em` | Display / hero text |
| `--credence-tracking-tight` | `-0.025em` | Large headings |
| `--credence-tracking-normal` | `0em` | Body text default |
| `--credence-tracking-wide` | `0.025em` | UI labels |
| `--credence-tracking-wider` | `0.05em` | Uppercase labels |
| `--credence-tracking-widest` | `0.1em` | All-caps tags, micro-caps |

---

## Design Principles

**Trust & authority.** Blue primary, conservative border radius, Inter typeface — all
signals used by leading financial and developer-tool products. Avoid warm tones and
large radius values in core UI components.

**Accessibility first.** Key contrast ratios against `#ffffff`:
- `--credence-color-primary-600` (#2563eb): 4.68:1 — passes WCAG AA large text
- `--credence-color-primary-700` (#1d4ed8): 5.9:1 — passes WCAG AA all text
- `--credence-color-neutral-600` (#475569): 5.9:1 — passes WCAG AA all text
- `--credence-color-neutral-900` (#0f172a): 19.4:1 — passes WCAG AAA
- `--credence-color-error-base` (#dc2626): 4.5:1 — passes WCAG AA

**4px grid.** All spacing must snap to the `--credence-space-*` scale. Intermediate
values like `10px` or `14px` do not exist outside the token set.

**No one-off hex values.** Hex literals belong only in `src/index.css` as primitive
token definitions. Component CSS references `var(--credence-*)` exclusively.

---

## Changelog

| Version | Date | Notes |
|---|---|---|
| 0.1.0 | 2026-04-28 | Initial token set — colors, spacing, radius, typography |
