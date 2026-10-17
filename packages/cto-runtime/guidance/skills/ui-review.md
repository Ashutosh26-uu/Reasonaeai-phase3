---
name: ui-review
description: "Audit a user interface for accessibility, interaction, layout, and UX defects and report findings by location. Use when asked to review, audit, or check a UI, a page, a component, accessibility, design quality, or when verifying a completed interface before delivery."
---

# UI review
Audit an existing surface. Report defects that a user would actually hit; do not restate the code.

## Method
1. Read the surface's source: page, layout, components, and the styles it depends on.
2. Run the app and open the real route. Review the rendered result — never review JSX alone, because spacing, overflow, and stacking are only visible when rendered.
3. Capture the evidence per finding: the route, the viewport, what you did, what happened, what should have happened.
4. Group findings by file and location. State the defect, then the fix. No preamble, no praise, no summary of what the code does.

## Check, in this order
**Interaction and keyboard**
- Reach every control with Tab; the focus ring is visible on each and never clipped by a sticky element.
- Buttons behave as buttons, links navigate, Enter and Space activate, Escape dismisses overlays, and focus returns to the trigger on close.
- A dialog traps focus while open and marks the background inactive.

**Labels and semantics**
- Every input has a visible, clickable label; every icon-only control has an accessible name.
- One `<h1>`, no skipped heading levels, landmarks present, and the language set on `<html>`.
- Status and validation messages are announced, not just colored.

**Layout and rhythm**
- No horizontal scrolling, clipped text, overlapping elements, or content touching a container edge at 390 px, 768 px, and 1280 px.
- One spacing scale in use across the surface; siblings share a gap; the same alignment axis within a block.
- Long strings, long titles, and empty values do not break the layout.

**States**
- Loading reserves the final layout; empty is explained with an action; failure names the cause and the next step; a long request shows progress; destructive actions confirm or undo.
- Disabled and read-only states are visually distinct and still legible.

**Color, contrast, and theme**
- Text and controls meet the contrast thresholds; status is never conveyed by color alone.
- Both light and dark themes are checked, including native controls and scrollbars.

**Motion and interaction feedback**
- Reduced-motion is honored; transitions list their properties; nothing animates on scroll by default.
- Every interactive element has a hover/focus/active change that increases contrast.

**Copy**
- Labels name the outcome, the same verb is used through a flow, errors state the fix, and no placeholder text survives.

## Reporting rules
- Never report a stylistic preference as a defect. Cite the consequence for the user (cannot operate with a keyboard, cannot read at this contrast, loses data on refresh) or drop it.
- Do not report the items listed under "Not defects" in rules `interface-design` and `accessibility`.
- Do not report an issue you have not observed or read: "probably misaligned" is not a finding.
- Distinguish a merge blocker (unusable, inaccessible, data-losing) from an improvement, and say which is which.
- Do not edit files during a review unless the assignment says to fix; return findings and let the owner apply them.
- If no defect is found, say so and name what was covered — including the states and viewports you inspected.
