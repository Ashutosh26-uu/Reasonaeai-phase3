---
name: tailwind-shadcn
description: "Tailwind CSS v4 and shadcn-style component conventions: tokens, CVA variants, class composition."
always: false
globs: ["**/*.tsx", "**/*.css", "components.json", "postcss.config.*"]
---

# Tailwind CSS v4 and shadcn-style components
The starter uses Tailwind v4 with the CSS-first configuration. Match it; do not reintroduce v3 conventions.

## Configuration
- `app/globals.css` is the configuration: `@import "tailwindcss";`, then design tokens, then `@theme inline { … }` mapping each token to a `--color-*`/`--radius-*` utility.
- There is no `tailwind.config.js`, no `content` array, and no `@tailwind base/components/utilities` directives. Create none of them.
- Theme values reach components only through `@theme` mapping. Adding a raw CSS variable without mapping it produces no utility.
- `components.json` declares `style`, `rsc: true`, `cssVariables: true`, and the `@/components`, `@/lib`, `@/hooks` aliases. Keep those paths.

## Color and tokens
- Use semantic utilities — `bg-background`, `text-foreground`, `bg-card`, `text-muted-foreground`, `border-border`, `ring-ring` — plus the component's own variants. Never use Tailwind's raw palette (`bg-gray-100`, `text-blue-600`) for product surfaces.
- One accent carries primary actions, selection, and links. Use semantic status tokens for success, warning, and error only.
- Never communicate status by color alone; pair it with text or an icon.
- Dark mode is a token override, not per-utility overrides: define `@custom-variant dark (&:where(.dark, .dark *))`, set the `.dark` class on `<html>`, and provide every token the light theme defines. Rebuild the grayscale for dark rather than inverting it.
- `color-scheme` must match the active theme; native controls (including `<select>`) need explicit background and color in dark mode.

## Class composition
- Compose conditional classes with `cn()` from `@/lib/utils` (clsx + tailwind-merge). Never string-concatenate class names or hand-roll a merge.
- Variants are `class-variance-authority` definitions with `defaultVariants`, and props are typed through `VariantProps`. Do not branch on props inside `className` for what is a variant.
- Components accept and merge `className` last so callers can override, and spread the remaining native props onto the underlying element.
- Prefer `size-*` over `h-* w-*` for squares, logical properties (`ps-*`, `pe-*`, `ms-*`, `me-*`) for direction-sensitive spacing, and `gap-*` over margins for sibling rhythm.
- Avoid `@apply` in components; write utilities on the element or extend the primitives.
- Do not add `!important` or `[&>*]:…` chains to win a specificity fight; fix the composition.

## Scale discipline
- Spacing comes from the scale (`gap-2`, `p-4`, `px-6`), never arbitrary values such as `p-[13px]` or `mt-[7px]`. If the scale genuinely cannot express it, add a named token.
- Radius comes from `--radius` and its `rounded-*` derivations; do not mix five different radii in one view.
- Elevation uses one shadow step per surface level; do not combine a heavy shadow and a border on the same card.

## Components
- The starter ships editable source in `components/ui/*` (button, card, input, badge) plus `cn()`. Extend those files in place; never add a parallel component library.
- The shadcn CLI is not installed in the sandbox. Compose additional primitives from the same conventions as source files instead of trying to run the CLI.
- Keep interactive primitives accessible at the source: focus-visible ring, disabled state, and the correct element type.
