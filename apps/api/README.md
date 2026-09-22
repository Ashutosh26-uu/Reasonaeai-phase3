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

The current development model-router identifier is `deepseek/deepseek-flash`. Live provider credentials and production routing remain outside the active foundation phase.

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

## Current boundary

This change establishes the branded agent harness and typed lifecycle contracts. Authenticated build-session allocation, durable project state, browser verification, controlled network brokerage, preview routing, and the production deployment provider are still tracked as in progress or future work in `.context/PHASE.md`; they are not represented here as completed behavior.
