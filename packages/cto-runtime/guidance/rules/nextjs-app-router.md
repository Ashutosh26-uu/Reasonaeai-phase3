---
name: nextjs-app-router
description: "Next.js App Router conventions for routing, data, caching, mutations, and errors."
always: false
globs: ["app/**/*.ts", "app/**/*.tsx", "src/app/**/*.ts", "src/app/**/*.tsx", "next.config.*", "middleware.ts"]
---

# Next.js App Router
Target Next.js 16 App Router. Facts below are version-specific; do not apply Pages Router or Next 14/15 habits.

## Routing and structure
- Routes live in `app/`: `page.tsx`, `layout.tsx`, `route.ts`, `loading.tsx`, `error.tsx`, `not-found.tsx`, `template.tsx`.
- `[param]` for a dynamic segment, `[...param]` for catch-all, `(group)` for a route group that does not affect the URL, `_folder` to opt out of routing.
- Use `<Link>` for navigation. Never build an internal URL with `window.location` or an `<a href>` that triggers a full reload.

## Async request APIs
- `params`, `searchParams`, `cookies()`, `headers()`, and `draftMode()` are async. Await them; do not destructure them synchronously.
- Reading request data opts the route into dynamic rendering. Read it deliberately, and isolate dynamic sections behind `<Suspense>` with a real fallback.

## Data and caching
- Fetch in Server Components or in `lib/` modules; never fetch your own route handlers from a Server Component — extract shared logic into a module and call it.
- Enable `cacheComponents: true` and mark cacheable units with the `'use cache'` directive, then tag them with `cacheTag(...)` and set lifetime with `cacheLife(...)`.
- After a mutation: use `updateTag(tag)` in a Server Action when the writer must immediately see their own change; use `revalidateTag(tag, 'max')` for stale-while-revalidate, including from route handlers and webhooks.
- `updateTag` is Server-Action-only. Never call it from a route handler or a client component.
- Do not reach for `unstable_cache`; it is legacy next to `use cache`.

## Mutations
- Server Actions (`'use server'`) validate their input with a schema, authorize the caller server-side, and return a typed result the UI can render. Never trust arguments because the client sent them.
- A Server Action is a public HTTP endpoint. Treat every field as untrusted, including hidden inputs and ids.
- Never return secrets, internal ids, or stack traces from an action.

## Errors, loading, and empty states
- Add `loading.tsx` or a `<Suspense>` fallback for anything that can be slow, `error.tsx` (client component) for a recoverable failure, and `not-found.tsx` for missing resources.
- `error.tsx` receives `reset`; use it to retry the failed segment instead of forcing a full reload.
- Never render a blank screen for a failure or an empty collection; render the empty or error state with a next action.

## Assets, environment, and build
- Use `next/image` with intrinsic `width`/`height` (or `fill` in a sized container) and `priority` only for above-the-fold images.
- Use `next/font` to load fonts; avoid layout shift from late font swaps.
- `NEXT_PUBLIC_*` values are inlined at build time — they are public and must never hold a secret. `serverRuntimeConfig`/`publicRuntimeConfig` no longer exist.
- Read secrets only on the server, from the environment, and keep them out of any module a client component can import.
- Export `metadata` or `generateMetadata` for real page titles and descriptions.
- Turbopack is the default bundler for `next dev` and `next build`; its configuration key is the top-level `turbopack`, and `experimental.turbo` no longer exists.

## Verification
- `npm run build` must pass: it type-checks, verifies server/client boundaries, and catches invalid caching directives.
- Exercise the route in a browser, including the loading, empty, and failure states — not just the happy path.
