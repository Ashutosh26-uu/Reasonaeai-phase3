---
name: react-ui
description: "React 19 component conventions: server/client boundaries, state, effects, rendering correctness."
always: false
globs: ["**/*.tsx", "**/*.jsx"]
---

# React
Target React 19 with the modern JSX runtime. Do not emit patterns React itself deprecated.

## Rendering
- Components are pure: given the same props and state, they render the same output and have no render-time side effects.
- Derive values during render instead of mirroring props into state or syncing with an effect. `useEffect` is for synchronizing with an external system, never for computing or fetching data.
- Keep state minimal and colocated. Lift only when a sibling needs it; reach for context when a subtree shares it, not to avoid passing two props.
- `useMemo`/`useCallback`/`memo` only with a measured need or an identity-sensitive dependency. Do not decorate every component.
- Keys are stable domain identifiers, never the array index for reorderable, insertable, or filterable lists.
- `ref` is a normal prop on function components; do not wrap in `forwardRef`. Use `useRef` for values that must not trigger a render.
- `<Context value={…}>` renders the provider directly; the `.Provider` suffix is legacy.

## Client/server boundary
- Server Components are the default; add `"use client"` only for interactivity, browser APIs, or client-only libraries, and push it to the leaf that needs it.
- Never import a server-only module, secret, or database client into a client module. Pass data, not capabilities, across the boundary.
- Never place `next/dynamic` with `ssr: false` inside a Server Component; extract the client-only UI into its own client component instead.
- Keep props crossing the boundary serializable. No functions, class instances, or `Date`-dependent formatting that differs between server and client.

## Interactivity and forms
- Use `<form action={serverAction}>` with `useActionState` for submissions; show pending state via the action result rather than a manual `isSubmitting` flag when the framework supplies it.
- Optimistic updates use `useOptimistic` and must reconcile when the server response arrives.
- Guard against out-of-order async results: ignore a stale response rather than letting it overwrite newer state.
- Controlled inputs need `value` and `onChange` together; uncontrolled inputs need `defaultValue` — never one without the other.

## Accessibility is part of the component
- Use `<button>` for actions and `<a>`/`<Link>` for navigation. Never attach `onClick` to a `<div>` or `<span>`.
- Every interactive control has an accessible name. Icon-only buttons need `aria-label`; decorative icons need `aria-hidden="true"`.
- Every input has a `<label>` (or `aria-label`), a meaningful `name`, and the right `type`/`inputMode`/`autocomplete`.
- Keep native semantics; add ARIA only when no element provides the behavior.

## Composition
- Prefer composition and explicit props over inheritance, render-prop pyramids, or a generic "container" component.
- Split a component when it has more than one reason to change, not to hit a line count.
- Extend the existing primitives in `components/ui/*` rather than forking a second copy.
