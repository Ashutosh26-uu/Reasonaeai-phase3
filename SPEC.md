# ReasonateAI Product Specification

## Product definition

ReasonateAI Phase 3 is an autonomous, multimodal AI CTO for nontechnical users. A user provides product intent through text, voice, images, documents, wireframes, or flowcharts. ReasonateAI turns that intent into an editable specification and implementation plan, builds the software, runs it in an isolated environment, inspects its real behavior, repairs evidence-backed failures, and presents the verified result.

The required product loop is:

```text
understand → plan → approve → build → run → inspect → repair → verify → present
```

Generated source code, successful compilation, or passing isolated unit tests do not by themselves constitute completion. Repository-wide implementation completion criteria are defined in [`AGENTS.md`](./AGENTS.md#definition-of-done).

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

- Text, voice, image, and document intake.
- Editable specification, architecture, acceptance criteria, and plan.
- One executive coding agent responsible for end-to-end delivery.
- Bounded temporary subagents for genuine parallel work, isolated investigation, specialist tools, or adversarial review.
- Workspace read, search, edit, language intelligence, debugging, execution, browser, and Git checkpoint tools.
- Persistent organizations, projects, sessions, decisions, runs, artifacts, evidence, and previews.
- Isolated application execution with bounded resources and controlled network access.
- Real-browser verification and evidence-driven repair loops.
- Text and speech milestone reporting.
- Human approval, clarification, credential submission, pause, resume, and rollback.

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

ReasonateAI uses one executive agent by default. Agent roles are task-specific prompts and permission sets, not permanent network services.

Temporary delegation is allowed only when independent work can run concurrently, a clean context boundary improves correctness, a specialist model/tool is materially better, an investigation would pollute executive context, or adversarial verification is required. The executive agent remains responsible for integration and final verification.

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

The provider-neutral sandbox contract owns lifecycle, commands, processes, controlled networking, brokered secrets, ports/previews, snapshots, artifacts, and resource limits.

Every coding task follows this observable loop:

1. Create a Git checkpoint.
2. Implement the smallest coherent change.
3. Start the real application in the sandbox.
4. Exercise the changed user path.
5. Capture relevant logs, console output, network activity, screenshots, and test evidence.
6. Classify failures from evidence.
7. Repair the owning code path.
8. Re-run the exact failed scenario.
9. Stop at bounded retry, time, and cost limits.
10. Escalate with evidence, attempted fixes, and the exact missing prerequisite.

## Durable state

Canonical state includes:

- Users, organizations, memberships, sessions, and authorization grants.
- Product specification, architecture, acceptance criteria, plans, tasks, and decisions.
- External integration requirements and secret metadata.
- Agent runs, tool events, approvals, and human responses.
- Verification evidence, artifacts, previews, and Git checkpoints.
- Audit events for authentication and security-sensitive state changes.

SQLite is the initial application source of truth. Large artifacts live in filesystem or object storage. Full-text search and structured URI selectors precede vector retrieval. Production database evolution remains an explicit decision based on measured concurrency, durability, and operational needs.

## Approved technology stack

| Concern | Approved choice |
| --- | --- |
| Primary language | TypeScript 7.0.2 wherever practical |
| Model-serving language | Python only where required by model ecosystems |
| JavaScript runtime | Node.js 22.12 or newer |
| Package manager | pnpm 10, pinned by `packageManager` |
| Monorepo orchestration | Turborepo |
| Formatting and linting | Ultracite with Biome |
| Git hooks | Lefthook |
| Schema/contracts | Zod 4.6.5 |
| Unit/integration test runner | Vitest 5.0.1 |
| Initial persistence | SQLite |
| Model/provider layer | Spectra provider abstractions |
| Source checkpoints | Git |

The web framework, API framework, ORM/database library, browser-test framework, authentication implementation/provider, queue, deployment platform, and production sandbox provider are intentionally undecided. Select each only during the phase that needs it, using current official documentation, compatibility evidence, security review, and an explicit decision recorded here.

Bun is not part of the repository runtime or package-management path. Introducing an additional JavaScript runtime requires a measured repository-wide decision.

## Intended repository shape

```text
apps/
  web/                    User-facing AI CTO PWA
  api/                    Identity, projects, sessions, artifacts, and events
  worker/                 Durable executive-agent jobs
  voice-gateway/          Streaming ASR/TTS gateway

packages/
  contracts/              Shared schemas, identifiers, and domain events
  auth/                   Principal resolution and centralized authorization
  cto-runtime/            Executive policy built on Spectra
  resource/               Unified resource router and protocol handlers
  project-state/          Persistence and resumable execution
  sandbox/                Sandbox provider contract and implementations
  verification/           Runtime, browser, and evidence contracts
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

- Model integrations remain provider-neutral through Spectra.
- No critical architecture depends on a closed frontier model or an uncapped expensive API.
- Hosted open-weight inference may be used behind spending limits; local inference remains supported.
- Production model selection is based on cost per verified completed task, including completion rate, tool validity, edit success, repair iterations, visual acceptance, elapsed time, total inference cost, and behavior under context pressure.
- Executive, ASR, and TTS model choices remain replaceable behind stable contracts.

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
