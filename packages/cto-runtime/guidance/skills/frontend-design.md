---
name: frontend-design
description: "Design and build a new user interface, or materially reshape an existing one, so it is specific to the product rather than generic. Use when creating pages, screens, dashboards, landing pages, marketing sections, or when the user asks for a redesign, a better look, or a distinctive visual direction."
---

# Frontend design
Use before writing UI code for a new surface or a redesign. It replaces the default "generate a plausible layout" reflex with a deliberate decision, made once, then executed.

## 1. Establish the subject
Write down, in one or two sentences: what the product is, who uses it, and the single job of this screen. If the brief does not say, decide and state your assumption. Every visual choice below must be justifiable from that subject — industry, materials, vocabulary, and audience. A dashboard for financial analysts and a booking page for a climbing gym cannot share a visual answer.

## 2. Decide the direction before writing code
Produce a compact plan and keep it to the length of a short paragraph each:
- **Color**: the base surface, foreground, one accent, and status colors, as a short named list. Light and dark both.
- **Type**: one family, or two clearly distinct ones, with the roles (display, heading, body, caption) and weights.
- **Layout**: the page's structure in one sentence plus an ASCII wireframe — the grid, what is full-bleed, what is contained, one alignment axis, and the content width.
- **Hierarchy**: what the eye should see first, second, third, and how that is achieved (weight, space, color, size — in that order of preference).
- **Signature**: the one element that carries the product's character. Exactly one.

## 3. Reject the default before building
Compare the plan against the plan you would have produced for any other product. If a choice would be identical for a different brief, it is a default, not a decision — revise it and say what changed. The generic tells to check against are listed under "Default-generated look" in rule `interface-design`; they are legitimate only when the brief asks for them.

## 4. Build
- Implement the token system first in `app/globals.css` (`:root`, `.dark`, `@theme inline`), then the layout shell, then sections, then states.
- Add the page's real content as you go. Never ship "Lorem ipsum", "Feature one", or an unnamed placeholder block; invent specific products, names, and numbers consistent with the subject.
- Add one motion moment at most, and only where it shows a change the user caused.
- Write the copy as UI, not as decoration: sentence case, active voice, the label names the outcome, the same verb across the whole flow, errors name the fix, empty states invite the action.

## 5. Verify before claiming it is done
- Run the app and open the real page. Look at it: 390 px, 768 px, and 1280 px. Check for horizontal scroll, clipped controls, overlapping text, inconsistent gutters, and content touching edges.
- Keyboard-only pass: reach every control with Tab, see the focus ring on each, and confirm the order is sensible.
- Check the states: empty, loading, error, success, disabled, and long content.
- Take a screenshot if you can and critique it against the plan from step 2. When something looks off, fix the plan's execution — not by adding a decoration on top.
- Finish the accessibility pass with skill `ui-review` on any surface that a user must operate.

## Restraint
Spend boldness in exactly one place. Everything around the signature element stays quiet and disciplined. When in doubt, remove one accessory: fewer colors, fewer surfaces, fewer effects, fewer words.
