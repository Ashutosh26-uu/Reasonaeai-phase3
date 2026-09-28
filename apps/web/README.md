# ReasonateAI web

This workspace contains the browser product's framework and component foundation. The root route and `/draft-2` are static theme studies for reviewing typography, palette, spacing, and workspace direction. Draft two explores fine-grain ASCII art across the hero and smaller process notation. Authenticated journeys and the agent conversation remain subsequent work.

## Run locally

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @reasonateai/web dev
```

Open `http://localhost:3000` and `http://localhost:3000/draft-2` to compare the studies. Their interface copy and controls are illustrative; they do not submit a request or start a build session. `pnpm --filter @reasonateai/web build` checks the web app. The root `pnpm check`, `pnpm typecheck`, `pnpm test`, and `pnpm build` commands cover this workspace.

## Structure

- `app/page.tsx` and `app/draft-2/` contain the two static theme studies; the required Next.js root document wrapper lives in `app/layout.tsx`.
- `components/ai-elements/` contains selected AI Elements source components for the later conversation surface.
- `public/brand/reasonateai-icon.png` is the approved icon cropped directly from the selected image prototype with its alpha channel intact.
- `packages/ui` owns shared design tokens and shadcn-compatible primitives. Both workspaces have `components.json` so the shadcn CLI can route shared primitives into the package.

The initial theme uses restrained charcoal and warm-white values. The icon is displayed as an image without a CSS glow. Interactive controls use visible keyboard focus and tokenized contrast. Fine monospace decoration remains secondary to product content.

## Agent and Markdown boundary

The browser will call only company-owned `/v1` product routes with server-managed cookies and CSRF protection. It will not call Mastra's raw agent, controller, or Studio routes, nor use an AI Gateway key. The product API owns the durable event stream and replay cursor; AI Elements are presentation components for those validated events.

`streamdown` with its code, Mermaid, and math plugins renders Markdown, Shiki-highlighted code, Mermaid diagrams, and LaTeX equations. Math uses KaTeX with its stylesheet loaded by the app; it supports inline and display equations delimited by `$$`. MathJax is not part of the runtime, so MathJax-only extensions are outside this scaffold. The renderer must retain sanitization, restrict links and external images for untrusted agent content, and use Mermaid's strict security level. An unknown code language remains readable as plain code.

## Current boundary

The theme study establishes visual direction. Sign-in, project selection, authorized event streaming, approvals, preview, evidence, and deployment controls depend on product API contracts and are not represented as working here.
