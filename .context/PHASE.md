# Current Phase — Foundation and Identity Contracts

## Phase objective

Establish the repository, governance, identity model, centralized authorization boundary, and production-grade control-plane/execution-plane foundation for every resource, API, agent, worker, preview, deployment, and sandbox operation.

This phase is active. Authentication and authorization precede resource and tool execution because every run requires a verified, scoped principal. The public API is the control plane; a private worker fleet executes authorized runs through the shared Mastra composition root. PostgreSQL is the authoritative state store, Redis Streams carries distributed commands and live events, private object storage holds immutable artifacts, Git checkpoints recover mutable workspaces, and ReasonateAI retains ownership of typed project state, authorization, capability profiles, tool gates, approvals, budgets, audit, evidence, deployment policy, and completion.

## Scope

### Completed

- Initialized the private pnpm/Turborepo workspace.
- Pinned pnpm and selected Node.js as the repository runtime.
- Pinned TypeScript 6.0.3 because Mastra 1.67.0's production deployer uses `typescript-paths` 1.5.2, whose supported peer range ends at TypeScript 6; clean frozen installation, type checking, tests, and the Mastra production build pass with this compatible version.
- Configured Ultracite/Biome formatting and linting.
- Configured Lefthook pre-commit checks.
- Defined the product specification, engineering rules, implementation Definition of Done, and deferred-feature tracker.
- Added `@reasonateai/contracts` with branded identifiers, user/workload principals, memberships, roles, permissions, sessions, workload capability limits, audit events, authorization requests, and typed decisions.
- Added `@reasonateai/auth` with a centralized deny-by-default policy for organization roles, project roles, session state, exact tenant/project scope, and bounded workload capabilities.
- Added contract and policy tests covering strict validation, administrative-grant rejection, role permissions, missing/inactive memberships, tenant/project isolation, session revocation/expiry, workload scope/expiry, and anonymous denial.
- Added `@reasonateai/contracts` execution schemas for build sessions, product lifecycle stages, sandbox state, deployment state, exposure, stable URLs, and lifecycle advancement.
- Added `@reasonateai/cto-runtime` with the branded full-capability ReasonateAI CTO, scout/coder/debugger workers, hidden title and compaction agents, shared verified run scope, and Mastra `AgentController` composition.
- Replaced the capability enum and the default loop limits in `@reasonateai/cto-runtime`. An agent is now differentiated only by the tools it holds and its system prompt, so a read-only investigator is an agent whose tool set contains no write tool rather than a separate kind. A discovered agent definition replaces a builtin of the same name outright under a single merge rule, an empty tool allowlist means no tools rather than every tool, tool names are validated against the tools the deployment actually provides, and step budgets are optional so a run is stopped by budget, wall clock, or spend instead of a cap chosen before the task was understood.
- Added markdown-authored agent definitions with kebab, snake, and camel frontmatter aliases, nearest-wins directory discovery across `.reasonate/agents` and `.claude/agents`, and a delegation guard that distinguishes unknown, disabled, primary, self-recursive, spawn-denied, and depth-exceeded targets.
- Added the internal resource protocol to `@reasonateai/cto-runtime`: a per-run router over stateless scheme handlers, a selector grammar for line ranges, `raw`, and `conflicts`, and handlers for `artifact://`, `agent://`, `rule://`, and `docs://`. Only schemes with a real backing store are registered, so an unavailable resource fails as an unknown scheme instead of appearing available and failing on every use. The router is constructed per run rather than held as a process global, because this service runs concurrent tenants in one process.
- Added the run-scoped artifact store: output exceeding the inline size limit is written under a path nested by organization, project, build session, and run, and addressed by a per-run numeric id, with agent outputs kept in a separate namespace addressed by worker label.
- Added the system prompt composer: the prompt is assembled per run from the base role, the tools the run actually holds, the registered resource schemes, an environment block carrying the workspace root, platform, shell, session start, date, run identity, sandbox identity, and measured sandbox capacity, project references, and the workspace's own instruction files loaded with `@import` expansion and deduplicated by content hash. The composer reports a fingerprint over the assembled prompt and every source.
- Moved agent composition out of the API application; the API now hosts the shared CTO runtime and resolves one isolated Docker workspace per tenant-scoped build session.
- Added `@reasonateai/contracts` execution-protocol schemas: run command envelopes, sequenced run event envelopes, run leases, artifact manifests, preview descriptors, and release descriptors, with strict-object validation that rejects smuggled caller identity.
- Added `@reasonateai/project-state` with the authoritative PostgreSQL schema and a tenant-scoped store implementing idempotent build-session allocation, reconnect-to-active-session, per-run monotonic event ledger, transactional outbox, single-holder run leases with expiry, artifact metadata, and deployment records.
- Verified the store against real PostgreSQL 16: idempotent replay, reconnect reuse, cross-tenant refusal, contiguous event ordering with cursor replay, outbox publication, and mutually exclusive lease holders all pass as integration tests.
- Corrected the Turborepo graph: `build` now declares the `.mastra/**` output so the API artifact is cacheable and integrity-checkable, and `test` keys its cache on `DATABASE_URL` so a database-less run cannot replay as a passing integration result.
- Added organization and project membership storage, because the centralized policy is pure and receives memberships rather than loading them; nothing supplied them before.
- Added authenticated product routes: `POST /v1/build-sessions` allocates idempotently, and `GET /v1/build-sessions/:buildSessionId` reads in scope. Both resolve a session principal, authorize through the centralized policy on `agent:run` and `project:read`, and reject any body field beyond the organization and project.
- Added `GET /v1/build-sessions/:buildSessionId/events`, which authorizes the caller, replays the run's durable ledger from `Last-Event-ID`, then follows live from the same ledger.
- Fixed the DeepSeek tool loop under thinking mode. DeepSeek requires the `reasoning_content` field to be replayed on every assistant message of a subsequent request, and `@ai-sdk/deepseek` only emits that field for model ids containing `deepseek-v4`, so the `deepseek-flash` alias produced a 400 as soon as an assistant message carried no reasoning. `@reasonateai/cto-runtime` now installs a `deepseek-reasoning-echo` provider-history compatibility rule that adds a reasoning part to an assistant message that has none; the rule is scoped to DeepSeek models, leaves reasoning the model did produce untouched, rewrites only the outbound prompt, and leaves the agent's own error processors in place. The development model identifier is defined once in `apps/api/src/mastra/model.ts` and shared by the runtime and the `cto:chat` harness.
- Made the `cto:chat` harness stream a run instead of awaiting a final answer, so each step boundary, the model's reasoning, every tool call with its arguments, every tool result, and a closing step/tool/elapsed count are visible while the run happens. A rejected provider call now prints the failure plus the shape of the request that produced it — message roles in order, and per assistant message the tool-call count and whether `reasoning_content` was present — without echoing message content.
- Rewrote the CTO system prompt and wired the prompt composer into the live runtime. The prompt now states the product standard, how the agent talks to the user (including the requirement to end every turn with what changed, what was verified and how, what remains, and what it needs), its operating context, its capabilities, a delegation brief format (target, change, acceptance, plus batch goal/constraints/contract), the workflow, engineering and UI standards, verification and evidence rules, security and safety, the conditions that require asking the user first, and how to report limits and failure. Composition runs once per verified run scope and adds an `<env>` block naming the model, date, run identity, and sandbox facts; the tool inventory was removed from it because the provider already receives tool definitions as schemas, so a prose copy only drifts.
- Corrected the environment block's sandbox facts. It previously reported the host process: `windows`, `cmd.exe`, and `C:\Users\wwwmo` for a run whose commands execute in a Linux container. The sandbox profile is now defined once in `apps/api/src/mastra/workspace.ts` and used for both the container and the prompt, with platform facts probed from inside a running sandbox (`linux`, `x64`, `/bin/sh`, `/root`) and capacity reported as the enforced cgroup quota (one CPU, 2 GiB) rather than the host's 12 CPUs and 7.6 GiB that `nproc` and `/proc/meminfo` report from inside the container.
- Made agent delegation reachable. Workers were materialized with no model id unless an override existed, so the controller refused to spawn them, and the delegation tool is built only by `AgentController`, so a harness driving the agent directly never held it at all. A worker now resolves its model from the override, then the definition, then the run's model, and `cto:chat` drives a controller session — the project is the memory resource, the build session the isolation scope. Verified by a run whose CTO delegated to scout: the worker spawned with its own instructions and three tools against the parent's sixteen, streamed its own text, and returned its result before the CTO finished.
- Wired protocol resource access into the read tool and made the run's tool policy explicit. The per-run resource router is now constructed and injected, so `artifact://`, `agent://`, and `rule://` resolve inside a run, an unregistered scheme fails with a typed error instead of appearing available, and the prompt's resource catalog lists exactly the schemes that resolve — it previously advertised none. The harness also consumed raw model chunks and now consumes controller events, which is what surfaces streamed tool arguments, live shell output with exit codes, partial results, retries, and each worker's own text and tool calls. The controller parks every tool that is not explicitly allowed and consults a category policy only when a category resolver is configured, so the runtime seeds the session's approval switch rather than leaving every call parked; approval policy for this product is enforced by centralized authorization and the run's capability grant, and a tool with a destructive external effect carries its own gate when it is added.
- Verified the launch slice end to end through the running API, real PostgreSQL 16, and real Redis 7: unauthenticated requests return a typed 401; allocation returns `created: true` on a first request and `created: false` with the same session id on reconnect; a member whose role lacks the capability and a caller with no membership both receive `forbidden`; the ledger holds `run.queued` at sequence 1; the outbox relay publishes it to the run's Redis stream topic; reconnecting the event stream with `Last-Event-ID: 1` skips that sequence; and an event appended while the stream was open arrived as sequence 2. Raw Mastra routes still answer 404 with zero occurrences of the system prompt.

### In progress

- Complete the `read` tool's sandbox-backed format handling. Resource URLs now resolve through the per-run router, so the protocol half is done; what remains is the format half — archives, documents, notebooks, SQLite, images, and structural summaries need sandbox-compatible readers, and output that exceeds the inline limit needs to spill into the artifact store instead of being truncated, which is also what makes `artifact://` non-empty.
- Implement mid-turn rule enforcement: rule files carrying regex and ast-grep conditions matched against streaming text, thinking, and tool-argument deltas, either injecting a provenance-marked notice into the offending tool result or interrupting the stream, with fire-once bookkeeping that survives session resume.
- Derive each worker's tool eligibility from the actual runtime tool inventory rather than static workspace-tool names. The disconnected custom registry was removed because it was not consulted at runtime.
- Consume dispatched commands in a private worker and execute them under a run lease. The transport half is verified: committed events reach the run's Redis topic, but nothing consumes them yet, so no agent has executed.
- Select and implement the first private API/worker/Redis/PostgreSQL/object-storage local topology.
- Finalize the launch authentication architecture and provider decision from current official documentation and security evidence.

### Next

1. Implement the private worker: consume a run command through a Redis consumer group, resolve the workload grant, acquire a run lease, restore the workspace, and acknowledge only after durable state is committed.
2. Configure the documented Mastra worker split (`MASTRA_WORKERS`, shared storage, `RedisStreamsPubSub`) on the existing `apps/api/src/mastra` composition root.
3. Select the web, authentication, ORM/database library, browser-test, sandbox, preview, object-storage, and deployment adapters through documented current-version evaluation.
4. Implement organization creation and owner membership as one transaction, plus project creation, so membership provisioning is no longer a manual step.
5. Implement secure session persistence wiring for sign-in, rotation, idle/absolute expiry, and logout behind HTTP.
6. Add CSRF protection, redirect validation, identity-endpoint rate limits, and secure cookie configuration.
7. Record safe audit events for sign-in, organization/project creation, session revocation, authorization denial, run dispatch, approval, and exposure changes.
8. Add integration tests for session lifecycle, permission denial, and audit recording.
9. Exercise one authenticated build session through sandbox allocation, CTO execution, preview creation, reconnect, and Git checkpoint recovery.
10. Bind the first resource-read vertical slice to the authorization contract.
11. Implement the selected deployment adapter and verify an accepted checkpoint at its authorized URL before claiming the product-generation journey complete.

### Blocked

- None.

## Required launch vertical slice

The first working product slice must demonstrate:

1. A user signs in through verified email magic link or the selected OIDC provider.
2. The API establishes a revocable server-managed session cookie.
3. First sign-in creates an organization and owner membership transactionally.
4. The authenticated owner creates a project in that organization.
5. A second principal without membership cannot read or mutate the project, including by guessing identifiers.
6. A membership with insufficient permission receives a typed denial.
7. Sign-in, organization creation, project creation, and authorization denial produce safe audit events.
8. Session revocation immediately prevents further protected access.
9. The real API and persistence layer are exercised; no mocked identity or authorization path is presented as complete.
10. The authenticated project can allocate one tenant-scoped build session and reconnect to the same controller thread and sandbox identity.
11. The browser receives no raw Mastra agent/controller endpoint; it interacts only through authorized product commands and an SSE event stream.
12. A worker without a valid lease, workload grant, tenant scope, or idempotency key cannot execute or acknowledge the build-session command.

## Phase exit criteria

The phase is complete only when all applicable repository Definition of Done criteria in [`AGENTS.md`](../AGENTS.md#definition-of-done) pass and the following evidence exists:

- Identity, tenancy, session, permission, capability-grant, build-session, command, event, artifact, preview, deployment, and audit schemas are versioned and validated.
- Central authorization is deny-by-default and has exhaustive role/capability decision tests.
- The launch vertical slice passes through the running API, private worker, PostgreSQL, Redis Streams, and real local persistence.
- Cross-organization and cross-project access attempts fail at the query, event, artifact, workspace, and preview boundaries.
- Session creation, rotation, expiry, revocation, and logout have integration coverage.
- CSRF, redirect validation, rate limits, cookie properties, secret redaction, raw-Mastra-route denial, and service-to-service authentication are verified.
- Applicable `pnpm check`, type checking, tests, build, smoke tests, and end-to-end tests pass from a frozen-lockfile install.
- Integration tests that require PostgreSQL run against a real instance. They are skipped when `DATABASE_URL` is unset, and the Turborepo `test` cache is keyed on `DATABASE_URL` so a database-less run can never replay as a passing result.
- The running API exposes no raw Mastra agent, controller, Studio, or worker endpoint to unauthenticated callers.
- The first authenticated build-session allocation fails closed without verified organization, project, session, run scope, lease, and workload grant.
- Architecture and operational documentation match the implemented behavior.
- No required path is represented by a stub, fake success, hidden manual correction, or untracked follow-up.

## Not in this phase

The following remain out of active scope until these exit criteria pass:

- Live model-provider credentials and production model routing.
- Multi-region/disaster-recovery deployment and production-provider credentials.
- Additional sandbox and deployment providers beyond the first selected adapter.
- Real-browser repair and deployed-URL verification loops beyond the first launch slice.
- Enterprise SSO and SCIM.
- Native mobile generation.

Moving one of these items into active work requires updating this file and, when applicable, removing it from [`FUTURE.md`](./FUTURE.md) in the same change.
