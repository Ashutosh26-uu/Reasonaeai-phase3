---
name: interface-design
description: "Visual and interaction quality: hierarchy, spacing rhythm, alignment, states, and the defects agents ship by default."
always: false
globs: ["**/*.tsx", "**/*.jsx", "**/*.css", "**/*.vue", "**/*.svelte", "**/*.html"]
---

# Interface design quality
Product UI is judged on hierarchy, rhythm, and alignment before it is judged on decoration. Get those right, then spend boldness in exactly one place.

## Hierarchy
- Every screen has one primary action and one dominant heading. If two things compete for first attention, one of them is wrong.
- Establish rank with weight, color, and space before reaching for size. Use the type scale's roles (page title, section title, body, supporting, metadata) instead of inventing sizes per screen.
- Never use pure black on white or pure white on black; use the theme's foreground and muted tokens.
- For a metric, make the number dominant and the unit quieter but still legible; use `tabular-nums` wherever numbers are compared in a column.

## Spacing and rhythm
- One spacing scale, applied consistently: siblings share a gap, sections share a larger one. Related content is close; unrelated content is separated by space, not by another border.
- Do not mix spacing systems. A view that uses `gap-2`/`p-4` in one panel and `mt-[7px]`/`p-[13px]` in the next reads as broken even when nothing overlaps.
- Vertical rhythm is a multiple of one step. Three consecutive values (12/16/20 px) on the same axis is a defect unless the hierarchy demands it.
- Insufficient padding is as wrong as excessive padding: content must never touch a container edge, and a card's internal padding must not exceed the gap between cards.

## Alignment
- Pick one alignment axis per block and keep it. Do not alternate left, center, and justified between adjacent sections.
- Left-align body copy and form fields; center only genuinely centered content (empty state, confirmation, hero). Centering a dashboard is almost always wrong.
- Baseline-align text beside an icon or control; use flex alignment, not manual margins, to line things up.
- Keep gutters, card widths, and control heights consistent across a row. A ragged right edge on a toolbar is a defect.
- Constrain line length: body text around 60–80 characters, `max-w-*` on prose containers. Never let text run the full width of a wide screen.

## Surfaces
- Use a card when content needs a surface, not to separate every element. Never nest a card inside a card.
- Choose either a border or a shadow as the primary separator for a given surface level, not both heavily.
- Keep radius consistent within a level; do not mix pill, 6 px, and 16 px corners on peer elements.
- Do not put important controls on a low-contrast decorative surface.

## States
- Every surface that loads has a loading state that reserves its final layout (skeleton or placeholder), not a spinner that replaces it.
- Every collection has an empty state that explains what belongs here and offers the action to add it. Never render a broken shell for an empty array, null, or empty string.
- Every failure shows what happened and the next step, in the interface's voice; never a raw error code alone, and never a silent no-op.
- Long content is handled: `truncate`/`line-clamp-*`/`break-words` on text containers, and `min-w-0` on the flex children that must shrink.
- Destructive actions are confirmed or undoable; disabled states beyond contrast reduction explain why.

## Motion
- Animate `transform` and `opacity`, list transition properties explicitly, and never use `transition: all`.
- Respect `prefers-reduced-motion`; provide the reduced variant.
- One orchestrated moment (a page reveal, a confirmation) beats an entrance animation on every section. Do not animate on scroll by default.

## Copy
- Sentence case, active voice, second person. The label names the outcome: "Save changes", "Create project", "Invite teammate" — never "Submit", "Continue", or "OK".
- Keep a verb consistent through the flow: a button that says Publish produces a confirmation that says Published.
- Errors name the cause and the fix. Empty states invite the action.
- Use `…` and curly quotes; end loading labels with `…` ("Loading…").

## Responsive
- Verify at 390 px, 768 px, and 1280 px. No horizontal scrolling, no clipped controls, no overlapping text.
- Use flex/grid and container queries for layout; never measure with JavaScript to decide structure.
- Reflow instead of shrinking: stack, then reduce secondary content, rather than scaling text down.

## Default-generated look (reject unless the brief asks for it)
These are the recognizable tells of an unconsidered generated page. None is forbidden when the brief specifies it; all are defects as an unexamined default:
- Chopped-into-identical-rounded-cards layout with one radius and the same soft grey shadow everywhere, plus decorative gradient washes.
- A tracked-out ALL-CAPS eyebrow label above every heading; metadata joined with middle dots (`A · B · C`); `WORD — fragment` labels with a spaced em dash.
- Monospace type for small data labels; a `→` appended to every button or link; one word emphasized inside a headline; decorative `01 / 02 / 03` numbering on content that has no order.
- Warm cream background with a high-contrast serif and a terracotta accent, or near-black with a single acid accent — chosen by reflex rather than from the subject.
- Fade-and-slide-up on every section and a hover transition on every card.
- Generic placeholder copy ("Lorem ipsum", "Feature one") left in a delivered UI.

## Not defects (do not "fix" these)
- A deliberate single accent color, or grayscale-dominant UI with one saturated element.
- Deliberate asymmetry, a wide hero, or generous whitespace around one focal element.
- Hidden decorative elements (`aria-hidden`, background SVG, gradient overlay) with no text alternative.
- A dense data table with small type when the row count and comparison task justify it.
- Repeated identical cards when the content genuinely is a uniform list of peers.
