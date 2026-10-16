---
name: accessibility
description: "WCAG 2.2 AA requirements and ARIA anti-patterns for every user-facing surface."
always: false
globs: ["**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.svelte", "**/*.html", "**/*.css"]
---

# Accessibility
Target WCAG 2.2 AA. These are merge blockers, not polish.

## Semantics first
- Use the element that already means the thing: `<button>`, `<a>`, `<label>`, `<table>`, `<nav>`, `<main>`, `<header>`, `<footer>`, `<dialog>`.
- Never put a click handler on a `<div>` or `<span>`. A `<div role="button">` requires manual focus, Enter, and Space handling — use `<button>`.
- One `<h1>` per page, no skipped heading levels, and headings reflect structure rather than font size. Style with CSS instead of picking a heading level for its size.
- Set `<html lang="en">` (or the real language) in the root layout.
- Provide a skip link to the main content when there is repeated navigation.

## Names, roles, and values
- Every interactive control has an accessible name: visible text, `<label>`, `aria-label`, or `aria-labelledby`. Icon-only buttons need `aria-label`.
- Decorative icons and images get `aria-hidden="true"`; meaningful images get real `alt` text (never the filename, never "image").
- Never put `aria-hidden="true"` on or around a focusable element; that creates a ghost. Use `disabled`, `inert`, or removal instead.
- Remove redundant ARIA (`<button role="button">`). Never invent a role value.
- Roles with required state must have it: `tab`/`aria-selected`, `checkbox`/`aria-checked`, `combobox`/`aria-expanded`+`aria-controls`, `slider`/`aria-valuenow`+`aria-valuemin`+`aria-valuemax`.
- Data tables need `<th scope>` (and `<caption>` when the context is not obvious).

## Keyboard and focus
- Everything operable by mouse is operable by keyboard in a sensible order, with no keyboard trap.
- Focus is always visible via `:focus-visible` (the theme's `focus-visible:ring-*`). Never `outline-none`/`outline: none` without a replacement.
- Sticky headers, footers, and overlays must not cover the focused element; use `scroll-margin` so the focused control stays visible.
- Move focus into a dialog on open and return it to the trigger on close. Mark the background `inert` while a modal is open.
- Drag, swipe, and multi-point gestures need a click/tap and keyboard alternative.

## Forms
- Every control has a visible label that is clickable (`htmlFor` or wrapping). A placeholder is not a label.
- Set the right `type` (`email`, `tel`, `url`, `number`), `inputMode`, and `autocomplete`; set `spellCheck={false}` for emails, codes, and usernames.
- Validate on submit or blur, not on every keystroke. Show the error next to its field, describe it in text, and move focus to the first invalid field.
- Never block paste or autofill. Never disable the submit button while the user is still filling the form; disable only while the request is in flight, with a progress indicator.
- Errors state the fix, not just the failure: "Enter an email in the form name@example.com", not "Invalid input".

## Contrast and size
- Text: 4.5:1 for normal size, 3:1 for large (≥18.66 px bold or ≥24 px). UI components, borders that convey state, and icons: 3:1 against their background.
- Hit targets are at least 24×24 CSS px, with enough spacing for coarse pointers; 44×44 is the target for primary touch controls.
- Text must survive 200 % zoom and a 320 px viewport without loss of content or two-axis scrolling.
- Never convey information by color alone: pair it with text, an icon, or position.

## Dynamic content
- Announce status changes (toast, save, validation summary) through a live region: `role="status"`/`aria-live="polite"` for information, `role="alert"`/`assertive` for errors.
- Live regions must exist in the DOM before content is injected into them.
- Popups that appear on hover or focus are dismissible with Escape, hoverable, and persistent until dismissed.
- Auto-updating or auto-playing content can be paused, stopped, or hidden; nothing flashes more than three times per second.

## Motion and media
- Respect `prefers-reduced-motion`; provide a reduced or static variant.
- Prerecorded video needs captions; audio needs a transcript. Media controls must be keyboard operable.

## Do not report these
- A `<div>` used purely for layout with no interaction.
- `alt=""` on a decorative image — that is the correct value, not a missing one.
- A visually hidden heading or label that exists for assistive technology.
- A skip link that is only visible on focus.
- A `role="presentation"` on a genuinely decorative element.
