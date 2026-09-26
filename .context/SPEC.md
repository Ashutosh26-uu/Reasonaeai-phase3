# ReasonateAI Product Specification

## Product definition

ReasonateAI Phase 3 is a zero-technical-background user’s autonomous, multimodal AI CTO and software factory. A user provides product intent through natural speech, text, images, documents, wireframes, or flowcharts. ReasonateAI turns that input into editable requirements and an implementation plan, architects and builds the software, runs it in an isolated environment, repairs evidence-backed failures, and presents the verified result with spoken progress.

Product direction: an easier, more autonomous alternative to AI application builders such as Lovable. The differentiator is not raw code generation; it is an accountable CTO workflow that plans, delegates, verifies real runtime behavior, pauses safely for human decisions, and resumes from durable project state.

The required product loop is:

```text
understand → plan → approve → architect → build → run → inspect → repair → verify → present
```

Generated source code, successful compilation, or passing isolated unit tests do not by themselves constitute completion. Repository-wide implementation completion criteria are defined in [`AGENTS.md`](../AGENTS.md#definition-of-done).

## MVP acceptance scenario

From a clean account and project:

1. A user authenticates and creates or selects an organization.
2. The user speaks a small web-application idea and uploads a rough wireframe.
3. The system transcribes the request and extracts visual intent.
4. The executive agent produces editable requirements, architecture, acceptance criteria, and an implementation plan.
5. The user approves the plan.
6. The agent builds the TypeScript application in a controlled workspace.
7. The application starts in an isolated sandbox.
8. ReasonateAI opens the real preview, exercises its principal flow, and captures runtime and visual evidence.
9. At least one controlled defect is detected, repaired, and re-tested through the same failed scenario.
10. The user receives a live preview, evidence summary, source checkpoint, and spoken completion report.
11. Closing and reopening the project preserves its decisions, state, runs, and artifacts.
12. An authorized user can restore the preceding Git checkpoint through the interface.

The MVP is complete only when this scenario runs reliably without hidden manual code correction.

## Scope

### MVP target

The first complete generation target is a TypeScript web application.

The product includes:

- Text, voice, image, and document intake for nontechnical users.
- Speech-to-text intake and text-to-speech milestone reporting behind replaceable ASR and TTS adapters.
- Vision-to-architecture extraction that converts wireframes, screenshots, and flowcharts into a reviewable structured specification.
- Editable requirements, architecture, acceptance criteria, API contract, and plan.
- A run-scoped autonomous CTO with the full approved tool, skill, workspace, browser, command, debugging, verification, and deployment surface; it may execute directly or delegate bounded work to scout, coder, debugger, and ephemeral custom agents.
- A central, typed, tenant-scoped project-state and event log through which agents coordinate; it is authoritative over agent memory. Optional vector retrieval is scoped and supplemental.
- Workspace read, search, edit, language intelligence, debugging, execution, browser, and Git checkpoint tools.
- Persistent organizations, projects, authenticated sessions, build sessions, decisions, runs, artifacts, evidence, previews, deployments, and recovery checkpoints.
- One isolated project workspace and sandbox allocated to each active build session, shared by its authorized CTO and workers, with bounded resources and controlled network access.
- Real-browser verification, evidence-driven repair loops, and deployment of an accepted checkpoint.
- A stable deployment URL with explicit authenticated, unlisted, or public exposure and a rollback or forward-recovery path.
- Human approval, clarification, credential submission, pause, resume, exposure, and rollback.

### Explicitly deferred

Deferred capabilities are tracked in [`FUTURE.md`](./FUTURE.md). They are not implied by the MVP contract.

## Users and tenancy

ReasonateAI is a multi-tenant product.

- A user may belong to multiple organizations.
- Every project belongs to exactly one organization.
- Every project-owned session, run, artifact, preview, checkpoint, memory entry, and secret reference carries organization and project scope.
- Tenant scope is enforced in authorization, storage queries, cache keys, object paths, events, logs, and audit records.
- Resource identifiers and URLs are never treated as proof of access.

### Organization roles

| Role | Intended authority |
| --- | --- |
| `owner` | Ownership transfer, billing, destructive organization actions, and all administrative authority |
| `admin` | Membership, projects, integrations, and organization settings |
| `builder` | Project modification, plan approval, agent execution, and authorized credential requests |
| `reviewer` | Plan, evidence, preview, and checkpoint review without implementation authority |
| `viewer` | Read-only access to authorized project information |

Authorization uses explicit capabilities in addition to roles. Initial capabilities include project lifecycle, plan approval, agent execution, artifact access, preview access, checkpoint restoration, credential submission, membership administration, integration management, and billing management.

## Authentication and authorization

Authentication is a prerequisite for the resource and agent systems.

### Launch identity flows

- Verified email magic-link sign-in.
- At least one OIDC provider; provider selection remains an implementation decision until current provider requirements are evaluated.
- Server-managed, revocable sessions using opaque identifiers in `HttpOnly`, `Secure`, appropriately scoped `SameSite` cookies.
- Absolute and idle session expiry.
- Session rotation after login, privilege changes, and step-up authentication.
- Device/session listing, individual logout, and global logout.
- CSRF protection for state-changing browser requests.
- Strict redirect allowlists and rate limits on identity endpoints.

Locally managed passwords are not part of the initial authentication surface.

### Authorization contract

Every protected action is decided centrally from:

```text
principal + action + organization scope + project/resource scope + context
```

Authorization is deny-by-default. API routes, resource handlers, agent tools, previews, artifact downloads, checkpoint operations, sandbox commands, and secret brokerage all use the same authorization boundary.

### Agent and workload identity

Agents, workers, and sandboxes are workload principals, not users. They receive short-lived capability grants constrained by organization, project, session/run, allowed operations, expiry, and execution/spend limits. A user session or broad API key is never passed into an agent or sandbox.

### Full-product identity capabilities

Passkeys, MFA, recovery codes, enterprise SSO, domain verification, and SCIM are approved product direction but are sequenced in [`FUTURE.md`](./FUTURE.md) unless promoted into the active phase.

## Secrets

- Secrets are encrypted at rest through a managed key system in production.
- Authorized interfaces expose metadata, never plaintext after submission.
- Plaintext is submitted through a dedicated secure route and brokered only into the approved operation.
- Agents request secret use; users approve it according to policy.
- Secret submit, approve, use, rotate, and revoke operations are audited.
- Secrets never appear in model context, resource reads, logs, artifacts, screenshots, browser storage, environment dumps, or source control.

## Agent architecture

ReasonateAI uses Mastra as the agent platform. Each project build session has one run-scoped ReasonateAI CTO with the complete approved tool, skill, workspace, browser, command, debugging, verification, and deployment surface. The CTO preserves lifecycle context and may perform work directly. It delegates only when specialization or parallelism improves delivery, using a small worker vocabulary: a read-only scout, a full-capability coder, an evidence-driven debugger that can diagnose and repair, and ephemeral custom agents whose system instructions are authored by the CTO for one bounded objective. Frontend, backend, database, infrastructure, accessibility, security, and release engineering are task objectives, not permanent agent identities.

The first authorized web request creates or resumes a build session and binds its organization, project, run, shared sandbox workspace, conversation thread, approvals, budget, and eventual deployment records. All authorized agents in that build session operate on the same project workspace; tool concurrency and file mutation remain controlled. A reconnect resolves the same durable session and workspace rather than silently creating a disconnected project.

Agents do not coordinate by unrecorded direct chat. They exchange typed, authorized project-state records, task results, artifacts, and audit events. The CTO remains the integration and completion authority, validates every delegated result, and obtains required user approval before destructive external effects, secret use, material scope changes, or public exposure.

### Production control plane and execution plane

The public API is the authenticated control plane. It owns browser sessions, organization/project authorization, build-session creation, plan and tool approvals, project state, source checkpoints, artifact metadata, deployment metadata, signed artifact access, cancellation, and reconnectable event delivery. It accepts browser commands through HTTPS JSON and streams progress through SSE; voice and interactive computer control may use WebSocket or WebRTC only where bidirectional low latency is required.

The execution plane is private. A worker fleet consumes authorized commands, obtains a scoped run lease, restores the project workspace, runs or resumes the CTO, persists state and evidence, and acknowledges work only after durable state is committed. Workers do not receive browser traffic or user cookies. Mastra's API and worker artifacts may be built from the same `apps/api/src/mastra` composition root, but `packages/cto-runtime` remains the sole owner of agent policy and behavior. The composition root registers no raw public agent or controller endpoint; authenticated custom product routes invoke the runtime through company-owned authorization and request-context adapters.

PostgreSQL is authoritative for commands, idempotency keys, build sessions, runs, leases, approval state, checkpoints, artifact metadata, deployments, audit records, and a monotonically sequenced event ledger. Each transaction writes an outbox record before a relay publishes it. Redis Streams is the distributed command and live-event transport, never the only record of a command or user-visible transition. Browser reconnect uses the durable event ledger and `Last-Event-ID`, then joins the live SSE stream.

Mastra `AgentController` session state is process-local and therefore non-authoritative. ReasonateAI reconstructs a controller session from the durable build-session, run, approval, and thread binding after restart; no correctness, authorization, or recovery decision depends on an in-memory controller session.

### Source, workspace, and artifact storage

An active build session owns one mutable isolated workspace filesystem. It is backed by a sandbox provider or persistent project volume and is scoped by organization, project, and build session. The workspace is disposable infrastructure: it is restored from the latest accepted private Git checkpoint and durable project state after worker or sandbox failure. Authorized workers may share a workspace only under task ownership and per-file mutation locks; unconstrained concurrent writes are forbidden.

Git checkpoints are the canonical multi-file source representation. Object storage holds immutable, digest-verified artifacts: browser evidence, logs, test reports, source exports, release bundles, SBOMs, and deployment manifests. PostgreSQL stores each artifact's tenant-scoped metadata and manifest; object keys and URLs are never authorization. Private, short-lived signed URLs are issued only after centralized authorization. Browser uploads may use an authorized direct-upload grant; sandbox and worker outputs are validated and brokered by the execution plane before persistence.

### Preview and deployment isolation

Previews and deployed products are separate origins from the authenticated application. An opaque preview identifier resolves through a preview gateway that authorizes the requester, enforces expiry, and proxies only to the assigned sandbox port. Authentication cookies for `app.reasonate.ai` are never sent to previews or generated deployments. An accepted checkpoint is built into an immutable release artifact, deployed through a provider adapter, and verified before its stable URL becomes available. Default exposure is authenticated or unlisted; public exposure requires an explicit authorized decision and is auditable.

Mastra `createCodingAgent()` supplies the CTO and coding-worker loops. Mastra `AgentController` supplies isolated interactive sessions, threads, task state, constrained subagents, tool approvals, cancellation, and event streaming. Mastra `Workspace` supplies scoped filesystem, sandbox, language-intelligence, computer/browser-adjacent, and command tools. Durable-agent and background-task facilities are enabled only when their storage, PubSub/cache, idempotency, recovery, and replica-coordination requirements are met. ReasonateAI owns authorization, capability profiles, approval policy, budgets, audit events, evidence acceptance, tenant scope, deployment policy, and secret brokerage; Mastra components are adapters at those boundaries, never authorities that bypass them.

## Unified resources

One read surface resolves ordinary paths, URLs, supported documents, and registered internal URI schemes.

Initial schemes:

- `skill://` — immutable bundled, user, and project skills.
- `rule://` — active behavioral and project rules.
- `agent://` — typed current or persisted agent outputs.
- `artifact://` — recoverable large or truncated tool output.
- `memory://` — scoped user, project, and session memory.
- `local://` — session-local files and shared task artifacts.
- `mcp://` — resources exposed by connected MCP servers.
- `history://` — persisted agent histories.
- `project://` — canonical specification, architecture, decisions, plan, and acceptance criteria.
- `run://` — commands, logs, tests, processes, and runtime state.
- `preview://` — screenshots, accessibility trees, network records, and browser console output.
- `git://` — read-only commits, checkpoints, and diffs.
- `sandbox://` — sandbox files and status.

Resource invariants:

- Resources are nouns addressed by URIs; tools are verbs.
- Every request carries an authenticated principal or bounded workload principal.
- Every protocol declares mutability; write support is explicit and opt-in.
- Selectors, ranges, pagination, raw mode, conversion, and artifact recovery are consistent across resource types.
- Handlers reject traversal, symlink escape, unauthorized scope, ownership violations, and oversized output.
- Large output returns a stable authorized artifact reference instead of disappearing after truncation.
- Skills and rules are loaded on demand rather than permanently occupying model context.

## Execution and verification

The provider-neutral sandbox contract owns allocation, lifecycle, commands, processes, controlled networking, brokered secrets, ports/previews, snapshots, artifacts, and resource limits. The deployment contract promotes only an evidence-accepted source checkpoint, records provider state and exposure, returns a stable URL when ready, and supports rollback or forward recovery.

The product lifecycle is:

1. Authenticate the browser request and create or resume the tenant-scoped build session.
2. Allocate or reconnect its isolated project workspace and sandbox.
3. Understand multimodal intent; produce editable requirements, architecture, acceptance criteria, and an implementation plan.
4. Obtain required approval, then create a Git checkpoint.
5. Implement the smallest coherent change directly or through bounded workers.
6. Start the real application in the sandbox and expose an authorized preview.
7. Exercise the changed user path in a real browser.
8. Capture relevant logs, console output, network activity, screenshots, security results, and test evidence.
9. Classify failures, repair the owning code path, and rerun the exact failed scenario.
10. Stop at bounded retry, time, token, resource, and spending limits; escalate with evidence and the exact missing prerequisite.
11. Promote the accepted checkpoint through the selected deployment provider.
12. Verify the deployed principal flow and present the authorized deployment URL, evidence, source checkpoint, and recovery path.

## Durable state

Canonical state includes:

- Users, organizations, memberships, authenticated sessions, authorization grants, and build sessions.
- Product specification, architecture, acceptance criteria, plans, tasks, decisions, idempotency keys, and run leases.
- Sandbox allocation and lifecycle, external integration requirements, secret metadata, and deployment records.
- Agent runs, tool events, approvals, human responses, budgets, cancellation state, transactional outbox records, and sequenced browser events.
- Git checkpoints as canonical source history; verification evidence, immutable artifact manifests, previews, deployment URLs, exposure decisions, and release digests.
- Audit events for authentication and security-sensitive state changes.

PostgreSQL is the authoritative production source of truth. Redis Streams distributes commands and live events across replicas with consumer groups and bounded redelivery. Private S3-compatible object storage holds immutable artifacts, while sandbox filesystems hold mutable workspaces. SQLite remains allowed only for isolated local development; it is not a replica-coordinated production state store.

## Approved technology stack

| Concern | Approved choice |
| --- | --- |
| Primary language | TypeScript 6.0.3 wherever practical; TypeScript 7 is deferred until Mastra's deployer dependency supports its compiler API |
| Model-serving language | Python only where required by model ecosystems |
| JavaScript runtime | Node.js 22.22 or newer |
| Package manager | pnpm 10, pinned by `packageManager` |
| Monorepo orchestration | Turborepo |
| Formatting and linting | Ultracite with Biome |
| Git hooks | Lefthook |
| Schema/contracts | Zod 4.6.5 |
| Unit/integration test runner | Vitest 5.0.1 |
| Authoritative state | PostgreSQL with transactional outbox, scoped repositories, idempotency, and run leases |
| Distributed command and Mastra PubSub transport | Redis 7 Streams |
| Immutable artifacts | Private S3-compatible object storage with tenant-scoped manifests and signed access |

| Mutable project workspace | Provider-neutral isolated sandbox filesystem restored from private Git checkpoints |
| Public client protocol | HTTPS JSON commands and SSE progress streams; WebSocket/WebRTC only for bidirectional real-time features |
| Worker topology | Private API/worker split; workers consume Redis Streams, use shared PostgreSQL/object storage, and never receive browser traffic |

The browser framework is Next.js 16 App Router with React 19 and Tailwind CSS 4. It is hosted as a Node.js application, uses `packages/ui` for shared shadcn-compatible components and design tokens, and uses selected AI Elements components for conversation presentation. Streamdown with its Shiki code, Mermaid, and KaTeX math plugins renders agent Markdown. This stack matches the component libraries' documented prerequisites and supports server-rendered shell content with client-side event views. Its tradeoffs are a larger dependency and build surface than a static React app and the need to keep browser-to-agent access behind company-owned authenticated product routes. The ORM/database library, browser-test framework, authentication implementation/provider, production sandbox provider, object-store provider, deployment provider, and queue operations provider remain intentionally undecided. Their selected adapters must preserve the PostgreSQL/Redis/object-storage/Git contracts above and be chosen through current official documentation, compatibility evidence, security review, and an explicit decision recorded here.

TypeScript is pinned to 6.0.3 because Mastra 1.67.0 uses `typescript-paths` 1.5.2 during production builds, whose declared peer range ends at TypeScript 6 and whose legacy compiler-API access fails under TypeScript 7. Re-evaluate TypeScript 7 after that dependency path declares and demonstrates compatibility.

## Agent orchestration foundation

Mastra is the executive-agent foundation. `@reasonateai/cto-runtime` owns the branded ReasonateAI CTO instructions, bounded loop defaults, core scout/coder/debugger definitions, verified run scope, and `AgentController` composition. Ephemeral custom agents remain a product requirement but are not currently registered, because their previous standalone execution bypassed controller governance; they must be reintroduced through the controller with the same verified workload grant. The `apps/api/src/mastra` composition root owns no product policy: it supplies configuration for both the authenticated API artifact and private worker artifact. It receives trusted request context only after company-owned authorization has resolved organization, project, build session, run, and workload grant.

The runtime follows the useful coding-harness properties proven by Spectra and Mastra Code—fresh bounded workers, explicit capability profiles, focused assignments, task state, resumable approvals, child-result correlation, and evidence-based reporting—without copying their product boundary. ReasonateAI remains an autonomous product CTO and software factory that owns intake through deployed product, not a coding TUI.

Durable mode is selected only for runs that require pause/resume or disconnect recovery; its PostgreSQL storage, Redis Streams PubSub, crash recovery, and idempotency requirements are configured deliberately. Mastra-provided routes are never exposed as a substitute for ReasonateAI's authenticated product API. No second graph-only or application-local orchestration convention is retained.

## Intended repository shape

```text
apps/
  web/                    User-facing AI CTO PWA
  api/                    Authenticated public control plane and Mastra composition root
  worker/                 Optional product-run dispatcher and non-Mastra jobs
  voice-gateway/          Streaming ASR/TTS gateway

packages/
  contracts/              Shared schemas, identifiers, commands, and domain events
  auth/                   Principal resolution and centralized authorization
  cto-runtime/            Executive policy and Mastra integration
  project-state/          PostgreSQL state, outbox, run leases, and resumable execution
  artifact-store/         Tenant-scoped immutable artifact manifests and object-storage adapters
  sandbox/                Sandbox provider contract and implementations
  verification/           Runtime, browser, and evidence contracts
  deployment/             Preview and release deployment-provider contracts
  resource/               Unified resource router and protocol handlers
  model-evals/            Repeatable model evaluation scenarios
  ui/                     Shared UI components

services/
  qwen-asr/
  qwen-tts/

infra/
  compose/
  sandbox/
  deployment/
```

Directories are created only when their phase has complete behavior to place in them. Empty scaffolding is not progress.

## Model strategy

- **Paid frontier-model APIs are prohibited.** OpenAI GPT-class, Anthropic Claude, and Google hosted models may not be called from any environment — production, development, preproduction, or demonstration. The product carries no third-party recurring inference cost. Every model call runs on open-weight inference behind spending limits, or on local inference through an OpenAI-compatible endpoint.
- Model integrations use Mastra's provider/model routing behind spending and authorization policy.
- The primary implementation candidates are current open-weight models selected by repeatable multimodal, coding-agent, ASR, TTS, latency, license, and cost evaluations; no stale family or version is the default.
- Hosted open-weight inference may be used behind spending limits; local inference remains supported through an OpenAI-compatible endpoint.
- Production model selection is based on cost per verified completed task, including specification accuracy, visual extraction, tool validity, edit success, repair iterations, speech latency, visual acceptance, elapsed time, total inference cost, and behavior under context pressure.
- Architect, worker, ASR, and TTS model choices remain replaceable behind stable contracts.

## Security invariants

- Generated code never receives host Docker sockets or control-plane credentials.
- Untrusted execution uses deny-by-default or explicitly allowlisted network egress.
- Internal resources are scoped by user, organization, project, session, agent, and capability as applicable.
- Path traversal and symlink escape are rejected.
- Bundled skills and sealed artifacts are immutable.
- Every state-changing tool call and security-sensitive action is auditable.
- Tool retries, agent turns, process time, resource consumption, and spend are bounded.
- Repeated identical behavior triggers doom-loop protection.
- External content is untrusted data, never instructions.
- Authentication, authorization, secrets, audit, and tenant-isolation controls cannot be bypassed for demonstrations.

## Non-functional requirements

- Correctness and recoverability take priority over throughput.
- Critical operations are idempotent or carry explicit idempotency keys.
- User-facing progress reflects durable state rather than transient optimistic claims.
- All critical paths expose structured logs and correlation identifiers.
- Accessibility is required for primary interaction, approval, evidence, and recovery workflows.
- CI builds are reproducible from the committed lockfile.
- Deployments promote immutable artifacts and include health checks and rollback or forward-recovery instructions.
