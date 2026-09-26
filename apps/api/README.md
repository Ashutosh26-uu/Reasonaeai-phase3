# `@reasonateai/api`

Application host for the ReasonateAI CTO runtime. The user-facing product is an autonomous product CTO and software factory: it owns the journey from multimodal intent through an evidence-verified deployment, not merely an interactive coding shell.

## Runtime composition

Agent policy and prompts live in `@reasonateai/cto-runtime`; this application supplies Mastra storage, observability, model configuration, and the build workspace.

| Runtime actor | Responsibility |
| --- | --- |
| ReasonateAI CTO | Full approved workspace, command, debugging, verification, and deployment authority. It may execute directly or delegate while retaining completion responsibility. |
| Scout | Focused read-only investigation. |
| Coder | Bounded implementation or verification work with full workspace capabilities. |
| Debugger | Reproduces, diagnoses, repairs, and reruns evidence-backed failures. |

Frontend, backend, database, infrastructure, accessibility, security, and release engineering are objectives assigned to these workers rather than permanent agent types.

## Build-session boundary

The first authorized browser request will create or resume a tenant-scoped build session. Its authenticated session, organization, project, run, Mastra controller thread, sandbox, evidence, checkpoint, and deployment records must remain correlated.

The current workspace adapter derives one stable Docker sandbox identity from the verified organization, project, and build-session identifiers. The CTO and its authorized workers share that project workspace. A malformed or incomplete scope fails closed.

The CTO receives three custom tools whose filesystem calls resolve through that scoped sandbox on every invocation: `read` reads project paths and directories; registered resource URIs need a run-specific authorized handler that is not wired in this launch slice; `write` creates a file or replaces a fully read file only when its current hash anchor is supplied; and `edit` performs exact or hashline-anchored edits. Mastra's generic filesystem mutation tools remain disabled.

Current Docker limits:

- Node.js 22 slim image
- no network access
- 2 GB memory and swap ceiling
- one CPU quota
- 256-process limit
- all Linux capabilities dropped
- `no-new-privileges`
- 120-second command timeout
- non-networked command execution inside the sandbox
- generic filesystem read/write/edit/delete/mkdir tools disabled in favor of the scoped `read`, `write`, and `edit` tools

Generated application code never receives the host Docker socket.

## Model

The current development model-router identifier is `deepseek/deepseek-flash`, pinned in `src/mastra/model.ts`. It is DeepSeek's moving alias for the latest V4 Flash model. Live provider credentials and production routing remain outside the active foundation phase.

DeepSeek serves that alias in thinking mode, which requires the `reasoning_content` field to be replayed on every assistant message of a subsequent request. `@ai-sdk/deepseek` only guarantees that field for model ids containing `deepseek-v4`, so on this alias a request whose assistant message carried no reasoning was rejected with `The reasoning_content in the thinking mode must be passed back to the API`. `@reasonateai/cto-runtime` closes the gap with a `deepseek-reasoning-echo` provider-history compatibility rule, which adds a reasoning part to an assistant message that has none. The rule is scoped to DeepSeek models, leaves reasoning the model did produce untouched, and rewrites only the outbound prompt.

## System prompt

The CTO's prompt is composed per run, not stored as one string: the base role and policy from `@reasonateai/cto-runtime/src/prompts.ts`, then an `<env>` block naming the model, the date, the verified run identity, and the resources the sandbox enforces, then the project's own instruction files when it has any. Composition is cached per run scope, so the prompt prefix does not change between steps of one run.

Two things are deliberately absent. Tool definitions are not restated: the provider receives them as schemas beside the prompt, so a second copy in prose would only drift. And sandbox facts are not probed from the host — `nproc` and `/proc/meminfo` inside the container describe the host machine, so the block reports the enforced cgroup quota (one CPU, 2 GiB) instead of the 12 CPUs and 7.6 GiB a probe would claim.

## Commands

```bash
pnpm --filter @reasonateai/api run dev
pnpm --filter @reasonateai/api run build
pnpm --filter @reasonateai/api run start
pnpm --filter @reasonateai/api run test
pnpm --filter @reasonateai/api run typecheck
pnpm --filter @reasonateai/api run check
pnpm --filter @reasonateai/api run cto:chat
```

`cto:chat` is a local terminal harness for the sandboxed CTO. Set `MASTRA_MODEL` and the matching provider credential before issuing a prompt. It starts with a new isolated run scope and Docker workspace each time; it does not exercise HTTP sign-in or the private worker, which remain separate launch-slice work.

The harness streams the run instead of awaiting a final answer, so the work the CTO performs is visible while it happens: each step boundary, the model's reasoning, every tool call with its arguments, every tool result, and a closing count of steps, tool calls, and elapsed time. A rejected provider call prints the failure plus the shape of the request that produced it — message roles in order, and per assistant message the tool-call count and whether `reasoning_content` was present — without echoing message content.

## Configuration

| Variable | Needed for | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | every request | PostgreSQL holding tenants, sessions, sign-in links, the event ledger, and the audit trail. Read on first use, so the artifact still builds without it. |
| `REDIS_URL` | sign-in and run admission | Fixed-window counters for the identity rate limits and the per-organization plan limit. |
| `SESSION_SECRET` | sign-in and every command | Keys the CSRF token that binds a browser command to its session. Read on first use and required: without it a state-changing request fails loudly instead of accepting a forgeable token. |
| `REASONATE_PUBLIC_ORIGIN` | production | Absolute origin a sign-in link points back at. Development falls back to `http://localhost:4111`. |
| `REASONATE_ALLOWED_ORIGINS` | production | Comma-separated origins allowed to issue browser commands. A state-changing request whose `Origin` names anything else is refused. |
| `NODE_ENV` | — | `production` marks cookies `Secure` and disables the development magic-link sender. Anything else is treated as development. |

Sign-in is email magic link. No email provider is configured in this environment, so the sender in `src/mastra/adapters/magic-link-sender.ts` prints the link to stdout, announces itself as the development sender, and refuses to run outside development. A real provider replaces it behind the same `MagicLinkSender` contract.

## Current boundary

This change establishes the branded agent harness and typed lifecycle contracts. Authenticated build-session allocation, durable project state, browser verification, controlled network brokerage, preview routing, and the production deployment provider are still tracked as in progress or future work in `.context/PHASE.md`; they are not represented here as completed behavior.
