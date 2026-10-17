# Bundled guidance provenance

`rules/*.md` and `skills/*.md` are ReasonateAI-authored content. Every file is written for this
runtime: the sandbox image, the workspace conventions, the tenant/authority model, and the
Node/TypeScript, Python, and Go stacks the product target. No third-party text is reproduced
verbatim.

The following public collections were consulted for topic coverage, current API facts, and the
catalog of defects that agents generate by default. Licenses verified on 2026-10-17.

| Source | URL | License | Used for |
| --- | --- | --- | --- |
| GitHub Awesome Copilot — Next.js instructions | https://github.com/github/awesome-copilot/blob/main/instructions/nextjs.instructions.md | MIT | Next.js 16 App Router facts: async request APIs, cache components, route handlers, tooling changes |
| GitHub Awesome Copilot — Go instructions | https://github.com/github/awesome-copilot/blob/main/instructions/go.instructions.md | MIT | Go idiom checklist: errors, context, HTTP clients, concurrency, testing |
| GitHub Awesome Copilot — Accessibility standards | https://github.com/github/awesome-copilot/blob/main/instructions/a11y.instructions.md | MIT | WCAG 2.2 AA scope and the semantic/ARIA anti-pattern set |
| Vercel Web Interface Guidelines | https://github.com/vercel-labs/web-interface-guidelines | MIT | Interaction, focus, form, motion, and content-checklist items for `ui-review` |
| Anthropic `frontend-design` skill | https://github.com/anthropics/claude-code/blob/main/plugins/frontend-design/skills/frontend-design/SKILL.md | See repository LICENSE | Design-direction method and the "default-generated look" catalog |
| Anthropic `pdf` and `docx` skills | https://github.com/anthropics/skills | Proprietary / source-available — reference only, no text reproduced | The PDF tooling inventory and the reportlab glyph trap; the `.docx`-is-a-ZIP model and the `docx`-library footguns |
| Toss-style design system rule | https://github.com/PatrickJS/awesome-cursorrules/blob/main/rules/toss-style-design-system.mdc | MIT | Restrained product-UI discipline: grayscale hierarchy, one accent, surface rules |
| Next.js official documentation | https://nextjs.org/docs | Docs (CC BY 4.0 / MIT code) | Verified `use cache`, `cacheLife`, `cacheTag`, `updateTag`, `revalidateTag(tag, 'profile')` semantics |
| shadcn/ui Tailwind v4 documentation | https://ui.shadcn.com/docs/tailwind-v4 | MIT | Token mapping through `@theme inline`, `@custom-variant dark`, state-token conventions |
| Tailwind CSS dark mode documentation | https://tailwindcss.com/docs/dark-mode | MIT | Selector-based dark variant |
| Agent Skills specification | https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview | — | `name`/`description` frontmatter shape and on-demand loading model |

Everything version-specific that these files assert was checked against the sandbox contract in
`services/build-sandbox/` (Node 22, npm 12, Python 3.11, Go 1.27, Next.js 16, React 19,
Tailwind CSS v4) and the starter in `services/build-sandbox/templates/next-shadcn/`. Re-verify a
claim here before repeating it for a different runtime.

## How the files are consumed

`packages/cto-runtime/scripts/generate-guidance.mjs` reads this directory and emits
`src/guidance/bundled.ts`. A rule with `always: true` is injected into every system prompt; every
other rule and every skill is advertised by name and description in the prompt catalog and read on
demand through `rule://<name>` and `skill://<name>`. Edit the markdown, then run
`pnpm --filter @reasonateai/cto-runtime generate:guidance`; a test fails if the generated module is
stale.
