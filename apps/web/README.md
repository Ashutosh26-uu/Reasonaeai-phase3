# ReasonateAI web

This workspace is the authenticated browser workspace for projects and CTO conversations.

## Run locally

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @reasonateai/web dev -- -p 3219
```

Run the product API on port 4111 with PostgreSQL, Redis, and a private worker. For local sign-in through the web origin, set `REASONATE_PUBLIC_ORIGIN=http://localhost:3219` and `REASONATE_ALLOWED_ORIGINS=http://localhost:3219` in `apps/api/.env`. The web app proxies `/v1/*` to `REASONATE_API_ORIGIN` (default `http://localhost:4111`); browser cookies remain on the web origin. In development, the API prints the one-use sign-in link to its terminal; no email is sent. The worker needs Docker and the same `DATABASE_URL` and model credential as the API.

The browser loads the signed-in account's organizations, lists authorized projects, creates projects, and shows project conversations. Each message is admitted as a durable run. The conversation follows replayable run events and reloads stored messages when progress arrives. A new conversation is created by sending its opening message from the blank composer.

## Structure

- `app/` contains the workspace screen, API proxy configuration, and theme.
- `components/ai-elements/` contains the conversation and message presentation components.
- `public/brand/reasonateai-icon.png` is the approved icon cropped directly from the selected image prototype with its alpha channel intact.
- `packages/ui` owns shared design tokens and shadcn-compatible primitives. Both workspaces have `components.json` so the shadcn CLI can route shared primitives into the package.

The workspace theme uses charcoal, warm-white text, square controls, and a fine ASCII field on an empty conversation. The icon is displayed as an image without a CSS glow. Prompt starters fill the real composer; they do not submit a request until the user sends it. Interactive controls have visible keyboard focus and reduced-motion support.

## Agent and Markdown boundary

The browser will call only company-owned `/v1` product routes with server-managed cookies and CSRF protection. It will not call Mastra's raw agent, controller, or Studio routes, nor use an AI Gateway key. The product API owns the durable event stream and replay cursor; AI Elements are presentation components for those validated events.

`streamdown` with its code, Mermaid, and math plugins renders Markdown, Shiki-highlighted code, Mermaid diagrams, and LaTeX equations. Math uses KaTeX with its stylesheet loaded by the app; it supports inline and display equations delimited by `$$`. MathJax is not part of the runtime, so MathJax-only extensions are outside this scaffold. The renderer must retain sanitization, restrict links and external images for untrusted agent content, and use Mermaid's strict security level. An unknown code language remains readable as plain code.

## Current boundary

The chat and project selection use real API routes. The custom composer submits to the product conversation route while the installed AI Elements conversation and message components present the response. Approval decisions, preview, evidence inspection, deployment controls, uploads, and turn-level checkpoint restore require their own working product routes before those controls can appear in the workspace.
