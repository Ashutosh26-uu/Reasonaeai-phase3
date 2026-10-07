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
- A run-scoped autonomous CTO with the full approved tool, skill, workspace, browser, command, debugging, verification, and deployment surface; it may execute directly or delegate bounded work to scout, coder, debugger, reviewer, and ephemeral custom agents.
- A central, typed, tenant-scoped project-state and event log through which agents coordinate; it is authoritative over agent memory. Optional vector retrieval is scoped and supplemental.
- Workspace read, search, edit, language intelligence, debugging, execution, browser, and Git checkpoint tools.
- Persistent organizations, projects, authenticated sessions, build sessions, decisions, runs, artifacts, evidence, previews, deployments, and recovery checkpoints.
- One isolated project workspace and sandbox allocated to each active build session, shared by its authorized CTO and workers, with bounded resources and controlled network access.
- Real-browser verification, evidence-driven repair loops, and deployment of an accepted checkpoint.
- A stable deployment URL with explicit authenticated, unlisted, or public exposure and a rollback or forward-recovery path.
- Human approval, clarification, credential submission, pause, resume, exposure, and rollback.
- Per-organization plan entitlements enforced at admission and charged from metered usage: concurrent runs, projects, sandbox minutes, workspace bytes, tokens, spend, allowed models, and request rate limits. An organization's plan is a product decision; until billing owns that column, every organization is evaluated against the documented default plan.

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

### Account and workspace settings

- Users can edit their account display name; the verified sign-in email remains managed by the identity flow.
- Appearance offers System, Light, and Dark themes, saved as a browser-local preference.
- Workspace settings show the member's role, project count, current enforced plan, and metered usage against that plan's entitlements. Until billing assigns plans, the documented default plan is authoritative and the interface must identify billing and plan changes as unavailable.
- Workspace renaming is available only to owners and admins and is authorized centrally and audited. Other workspace settings are read-only unless a corresponding authorized save operation exists.
- Security settings show the current session's idle and absolute expiry and allow that session to be revoked. Device/session management and stronger authentication controls remain deferred until their server contracts exist.

## Secrets

- Secrets are encrypted at rest through a managed key system in production.
- Authorized interfaces expose metadata, never plaintext after submission.
- Plaintext is submitted through a dedicated secure route and brokered only into the approved operation.
- Agents request secret use; users approve it according to policy.
- Secret submit, approve, use, rotate, and revoke operations are audited.
- Secrets never appear in model context, resource reads, logs, artifacts, screenshots, browser storage, environment dumps, or source control.

## Agent architecture

ReasonateAI uses Mastra as the agent platform. Each project build session has one run-scoped ReasonateAI CTO with the complete approved tool, skill, workspace, browser, command, debugging, verification, and deployment surface. The CTO preserves lifecycle context and may perform work directly. It delegates only when specialization or parallelism improves delivery, using a small worker vocabulary: a read-only scout, a full-capability coder, an evidence-driven debugger, an independent verification-capable reviewer, and ephemeral custom agents for bounded objectives. The reviewer examines coherent implementation changes for correctness and exploitable security flaws and may run scoped check-mode commands; it has no direct source mutation tools, but shell execution is not a read-only guarantee. The CTO owns repairs, integration, final gates, and acceptance. Frontend, backend, database, infrastructure, accessibility, security, and release engineering are task objectives, not permanent agent identities.

An authorized project can contain multiple build sessions, each representing one CTO conversation. The first request for a conversation binds its organization, project, run, sandbox identity, conversation thread, approvals, budget, and eventual deployment records. A repeat request with the same idempotency key reconnects to that conversation; a new key starts a separate one. Later user turns create new runs in the same conversation. Project checkpoints preserve the source workspace across conversations, while at most one run mutates a project's workspace at a time.

Agents do not coordinate by unrecorded direct chat. They exchange typed, authorized project-state records, task results, artifacts, and audit events. The CTO remains the integration and completion authority, validates every delegated result, and obtains required user approval before destructive external effects, secret use, material scope changes, or public exposure.

### Production control plane and execution plane

The public API is the authenticated control plane. It owns browser sessions, organization/project authorization, build-session creation, plan and tool approvals, project state, source checkpoints, artifact metadata, deployment metadata, signed artifact access, cancellation, and reconnectable event delivery. It accepts browser commands through HTTPS JSON and streams progress through SSE; voice and interactive computer control may use WebSocket or WebRTC only where bidirectional low latency is required.

The execution plane is private. A worker fleet consumes authorized commands, obtains a scoped run lease, restores the project workspace, runs or resumes the CTO, persists state and evidence, and acknowledges work only after durable state is committed. Workers do not receive browser traffic or user cookies. Mastra's API and worker artifacts may be built from the same `apps/api/src/mastra` composition root, but `packages/cto-runtime` remains the sole owner of agent policy and behavior. The composition root registers no raw public agent or controller endpoint; authenticated custom product routes invoke the runtime through company-owned authorization and request-context adapters.

PostgreSQL is authoritative for commands, idempotency keys, build sessions, runs, leases, approval state, checkpoints, artifact metadata, deployments, audit records, and a monotonically sequenced event ledger. Each transaction writes an outbox record before a relay publishes it. Redis Streams is the distributed command and live-event transport, never the only record of a command or user-visible transition. Browser reconnect uses the durable event ledger and `Last-Event-ID`, then joins the live SSE stream.

The event stream carries two channels of different authority. The durable channel is the ledger: sequenced, replayable, and the only record of what a run did. The live channel carries versioned, bounded snapshots of ordered assistant text, explicit reasoning, and tool references on a separate topic that expires with the run, with no sequence or `id` on its frames. A snapshot revision replaces an earlier revision of that message; it never advances the durable ledger cursor. Periodic durable snapshots and a final snapshot preserve partial output through suspension or worker failure. History pages replay events across every run in the selected conversation, ordered by run creation and per-run sequence, and remain tenant/project scoped.

SSE connections send ten-second comment heartbeats without advancing the replay cursor. A failed transport closes its followers so clients can reconnect and replay the ledger; bounded status reconciliation covers a missing terminal frame. The chat's reconnect notice waits eight seconds after interruption, warns once per outage, and clears after an eight-second stable connection; short-lived handshakes do not reset its outage deadline. Live publishers copy only their declared organization/project/run scope. During worker rollout, readers accept retained frames with the older extra build-session field only when it matches the run's tenant-scoped verified owner, including inherited conversation branches; all other schema and scope validation remains strict. Stream, command, and worker failures carry correlation identifiers without logging input or credentials. Each worker schedules at most two independent project runs by default, configurable from one to eight; PostgreSQL still permits only one active run per project. An unanswered question occupies one slot rather than blocking the entire worker.

The workspace URL includes both selected resource identifiers as query parameters: `/?projectId=<id>&conversationId=<build-session-id>`. Selecting a project without a conversation opens a blank conversation pane; prior conversations open only when selected or when their URL is loaded. Browser back/forward restores the prior selection.

Mastra `AgentController` session state is process-local and therefore non-authoritative. ReasonateAI reconstructs a controller session from the durable build-session, run, approval, and thread binding after restart; no correctness, authorization, or recovery decision depends on an in-memory controller session.

`submit_plan` pauses a run when the agent submits a structured proposal. An authorized decision resumes that exact tool call. History uses the explicit `run.plan_decided` approval boolean and preserves feedback independently; a generic answer acknowledgement is not an approval. Cancellation is displayed separately. This is a run-level review step, not a separate user-selectable Plan mode or a blanket gate on every source edit.

### Source, workspace, and artifact storage

An active build session owns one mutable isolated workspace filesystem. It is backed by a sandbox provider or persistent project volume and is scoped by organization, project, and build session. The workspace is disposable infrastructure: it is restored from the latest accepted private Git checkpoint and durable project state after worker or sandbox failure. Authorized workers may share a workspace only under task ownership and per-file mutation locks; unconstrained concurrent writes are forbidden.

The default build sandbox image includes Node.js 22, Python 3.11 with a hash-locked baseline for NumPy, pandas, FastAPI/Uvicorn, Matplotlib, Seaborn, Plotly, Pillow, XLSX, and common development/API tooling, Go 1.27.1, and a pinned offline npm cache. Matplotlib uses the noninteractive Agg backend. The Python baseline is installed during image build, is available to the default interpreter, and can be inherited by project virtual environments created with `--system-site-packages`; runtime startup does not install Python packages. It covers tabular data, common statistical/scientific work, static and interactive visualizations, API services, and common raster-image processing. It intentionally excludes notebook servers, SciPy/scikit-learn, OpenCV, and deep-learning frameworks from the always-on image to constrain size; these require an explicit later runtime decision. The image also contains an optional Next.js App Router starter with React, TypeScript, Tailwind CSS v4, Vitest, shadcn-compatible configuration, editable UI components, and its preinstalled dependencies. The shadcn CLI is excluded while its dependency tree has high-severity advisories. The starter does not choose a stack: the CTO follows the user's or existing project's selection and may use the starter only when Next.js was explicitly selected for a new project. API and worker must use the same configured image reference. This image does not alter the provider-neutral sandbox contract or assume a cloud topology.

An authorized checkpoint restore takes the same project lock as worker admission and refuses queued, running, awaiting-approval, or live-leased work. It first saves a recovery checkpoint, restores the selected source, then publishes a new immutable checkpoint used by workspace readers and subsequent workers. A failed restore attempts recovery and reports the saved recovery reference. PostgreSQL and checkpoint storage do not form a distributed transaction. Restoring source does not itself rewind conversation history.

The existing local Docker build policy remains accepted: bridge networking by default, with `REASONATE_SANDBOX_NETWORK_MODE=none` available. This integration does not change networking. Production egress must still meet the security invariant below; bridge mode alone is not an allowlist.

Workspace file tools share one POSIX resolver regardless of the API or worker host OS. Relative paths and the explicit `@/` shortcut resolve under the verified workspace root; absolute paths, Windows drive-prefixed representations, and local file URIs must already identify a location inside that root. An absolute `/src/app.ts` is rejected rather than rebased to `/workspace/src/app.ts`. Genuine names such as `@scope/app.ts` retain their `@`. Read selectors are parsed separately, resource URIs retain their authorized handlers, and shell command text is not rewritten. Sandbox-side symlink checks remain enforced.

Git checkpoints are the canonical multi-file source representation. Object storage holds immutable, digest-verified artifacts: browser evidence, logs, test reports, source exports, release bundles, SBOMs, and deployment manifests. PostgreSQL stores each artifact's tenant-scoped metadata and manifest; object keys and URLs are never authorization. Private, short-lived signed URLs are issued only after centralized authorization. Browser uploads may use an authorized direct-upload grant; sandbox and worker outputs are validated and brokered by the execution plane before persistence.

### Preview and deployment isolation

Previews and deployed products are separate origins from the authenticated application. An opaque preview identifier resolves through a preview gateway that authorizes the requester, enforces expiry, and proxies only to the assigned sandbox port. Authentication cookies for `app.reasonate.ai` are never sent to previews or generated deployments. An accepted checkpoint is built into an immutable release artifact, deployed through a provider adapter, and verified before its stable URL becomes available. Default exposure is authenticated or unlisted; public exposure requires an explicit authorized decision and is auditable.

Mastra `createCodingAgent()` supplies the CTO and coding-worker loops. Mastra `AgentController` supplies isolated interactive sessions, threads, task state, constrained subagents, tool approvals, cancellation, and event streaming. Mastra `Workspace` supplies scoped filesystem, sandbox, language-intelligence, computer/browser-adjacent, and command tools. Durable-agent and background-task facilities are enabled only when their storage, PubSub/cache, idempotency, recovery, and replica-coordination requirements are met. ReasonateAI owns authorization, capability profiles, approval policy, budgets, audit events, evidence acceptance, tenant scope, deployment policy, and secret brokerage; Mastra components are adapters at those boundaries, never authorities that bypass them.

## Workspace interactions

Workspace chat keeps the existing animated Beam composer, attachments on the left, and model and voice controls on the right. The inset project/file tray appears only when no conversation is loaded. The plus control toggles a contextual Add menu for attachments, project files, project selection, and Sketch. Sketch is a general drawing canvas with dark background, floating pill controls, optional blocks/layouts/layers and properties panels, pen, shapes, labels, selection/resizing, bounded undo/redo, and local PNG export through the existing validated attachment intake. Drafts stay only in the mounted chat and clear on chat switch or reload. Tool questions appear above the input and resume the same persisted run. Consecutive tool groups describe their actual action types with singular/plural wording and truthful working, approval, or failure states; their tool count remains accessible. Refresh and Workspace use accessible icon controls. Dedicated voice mode uses explicit recording, editable transcription before submission, and available local browser speech for completed responses; provider availability and browser limitations remain visible. This is turn-based voice, with streaming ASR/TTS integration remaining separately scoped.

The composer has one primary action: voice mode in a fresh empty chat, Send when text/files or an existing conversation are present, and Stop during execution. A text follow-up can wait in the composer above the input, or its Steer action can send it to the active controller at a safe signal boundary. Steering is a bounded, idempotent, durable user command delivered only by the current run lease owner; it never starts a second unleased run. Requested, delivered, and uncertain/failed delivery remain in the durable replay ledger. Successfully delivered steering displays as an ordinary user message once its run reaches a terminal state, including after reload; delivery status remains visible during the active run, and unconfirmed or failed delivery stays visible after termination. This presentation change preserves historical commands and recovery evidence. After a worker takeover, ambiguous delivery is reported rather than automatically repeated.

The in-memory composer queue supports up to ten messages with bounded retained attachments, thumbnails, editing, removal, side chats, and a queuing toggle. Stop or a failed/cancelled generation pauses automatic follow-ups. A delivery attempt keeps its command type, target run, and idempotency key across retry; uncertain steering never becomes a new turn automatically. Edit-and-resend and Retry belong only to saved user requests. They restore the verified source boundary before the selected turn, retain the preceding active history, replace the selected turn, exclude later turns from active history, and rebuild the controller thread from retained context. Original runs, events, and checkpoints remain recovery/audit evidence. Retry reuses stored input and files; edit replaces the text while retaining its files. Both create one admitted scoped run, serialize against project work, and are idempotent. Older turns without a verified starting boundary fail visibly without changing history. Accepted commands remain accepted when a subsequent history refresh fails. Checkpoint source viewing uses escaped syntax tokens, line numbers, wrap/copy controls, and explicit plaintext fallback.

Saved assistant answers have Copy, private persisted positive/negative feedback, and Branch in new conversation; their recorded time appears on hover/focus. Branching requires a completed turn and verified checkpoint. The new conversation includes history through that turn and an independent source pointer, controller thread/resource, and sandbox identity. It preserves the original conversation and source. Inherited checkpoint details authorize active conversation membership. Schema version 7 makes active history membership and per-conversation source/thread heads authoritative; tenant/project checks remain mandatory. Workers capture a starting checkpoint before agent execution, renew leases through preparation/checkpointing/settlement, and fence source publication against the current run and live lease. Retained model context includes canonical messages, original attachments, delivered steering, and durably recorded question/plan answers. Memory import is bounded to 32 MB and fails visibly when exceeded; historical question answers cleared before version 7 cannot be reconstructed from the ledger.

Preview chrome displays the app route (starting at `/`), and Files displays `/workspace/<file>`; these are presentation paths over authorized product routes, never an alternative filesystem or authorization boundary. Each saved turn exposes a versioned checkpoint summary with real file and line changes against its restored base and bounded authorized file diffs. Failed or cancelled runs retain their actual outcome. Legacy or unavailable diffs show that limitation rather than fabricated zero counts.

The conversation header contains a single truncated title line, a menu, summary toggle, and new workspace-tab control. Authorized project editors can rename and reversibly archive conversations through scoped, audited metadata commands. Schema version 8 adds nullable title/archive metadata over the version 7 history baseline. Archive retains all history and checkpoints, excludes the conversation from the active list, and requires restoration before another turn or new Retry/Edit/Branch action; unfinished runs or live run leases prevent archiving. Archive and history commands share project/conversation lock order. Browser-local pin state remains synchronized with the conversation rail.

Workspace tab layouts belong to the organization, project, and conversation and retain only view identifiers in browser session storage. App preview, Files, Changes, and recorded Run activity are distinct views; Files and Changes also remain accessible inside App preview. A successful saved run can open App preview automatically. Summary reports persisted checkpoint changes and uploaded sources. Live browser-use streaming is a separate deferred surface, not the App preview.

The production CTO has `open_preview`: it checks an explicit HTTP localhost app URL inside the verified run sandbox, records the responding loopback host, port, and optional npm script in `.reasonate/preview.json`, and immediately requests that conversation's App preview. External URLs, credentials, query strings, fragments, privileged ports, and reserved relay port 18080 are refused. Explicit selection takes precedence over automatic discovery and never switches ports on failure. App preview uses the same run sandbox and already-running server; it must not wait for a checkpoint or create a second sandbox. A provider-owned private relay reaches only the selected app port through the authenticated preview gateway. The gateway address and app port are distinct values, and the UI reports the app port. The preview remains a separate origin from the authenticated product, and product cookies are never forwarded to generated code. A successful tool request is not browser verification.

The preview provider exposes only a private relay endpoint and binds it to one validated app port in the same run sandbox. It does not expose arbitrary sandbox ports or accept browser-supplied hosts. Vite receives the gateway base path; other frameworks must honor `REASONATE_PREVIEW_BASE_PATH` when they require prefixed assets/routes. Raw host URLs and browser credentials never become preview configuration. Files and Changes continue to read saved source checkpoints; previewing a running app does not change that saved-source contract. Provider-specific routing remains behind the sandbox contract and does not assume a cloud or host topology.

Loaded chats expose a compact message minimap inspired by the TOC Minimap reference. Hover or activation reveals user-message previews, including steering messages. Selecting an entry scrolls and focuses its stable target inside the chat, releases automatic bottom-following, and respects reduced motion. Assistant output is excluded from the navigation list; an empty chat has no minimap.

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
- Rules define constraints; skills describe task procedures. A short bundled policy is automatically included for the CTO and workers, with named immutable `rule://` resources for revisiting it. Detailed skills load on demand through the explicit `skill://` catalog. Project instruction files and bounded relative imports come only from the verified sandbox filesystem; they cannot override platform policy. An empty project-rule listing is normal, and startup enumeration is unnecessary.
- Safety decisions follow the operation's actual effect, scope, and existing authorization. Ordinary authorized development proceeds without repeated approval; sensitive external effects remain subject to control-plane policy. Prompt guidance supplements enforced controls and never constitutes a security boundary or proof that a review happened.

## Execution and verification

The provider-neutral sandbox contract owns allocation, lifecycle, commands, processes, controlled networking, brokered secrets, ports/previews, snapshots, artifacts, and resource limits. The deployment contract promotes only an evidence-accepted source checkpoint, records provider state and exposure, returns a stable URL when ready, and supports rollback or forward recovery.

The product lifecycle is:

1. Authenticate the browser request and create or resume the tenant-scoped build session.
2. Allocate or reconnect its isolated project workspace and sandbox.
3. Understand multimodal intent; produce editable requirements, architecture, acceptance criteria, and an implementation plan.
4. Obtain required approval, then create a Git checkpoint.
5. Implement the smallest coherent change directly or through bounded workers.
   Review coherent changes independently for correctness, security, and applicable quality gates. Scale review to changed boundaries and retain evidence; after repairs, re-review affected changes.
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

Mastra is the executive-agent foundation. `@reasonateai/cto-runtime` owns the branded ReasonateAI CTO instructions, configured loop budgets, core scout/coder/debugger/reviewer definitions, bundled guidance, verified run scope, and `AgentController` composition. Ephemeral custom agents remain a product requirement but are not currently registered, because their previous standalone execution bypassed controller governance; they must be reintroduced through the controller with the same verified workload grant. The `apps/api/src/mastra` composition root owns no product policy: it supplies configuration for both the authenticated API artifact and private worker artifact. It receives trusted request context only after company-owned authorization has resolved organization, project, build session, run, and workload grant.

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
