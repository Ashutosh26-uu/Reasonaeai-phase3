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
- Added `@reasonateai/cto-runtime` with the branded full-capability ReasonateAI CTO, bounded scout/coder/debugger workers, ephemeral orchestrator-authored custom agents, shared verified run scope, loop limits, and Mastra `AgentController` composition.
- Moved agent composition out of the API application; the API now hosts the shared CTO runtime and resolves one isolated Docker workspace per tenant-scoped build session.
- Added `@reasonateai/contracts` execution-protocol schemas: run command envelopes, sequenced run event envelopes, run leases, artifact manifests, preview descriptors, and release descriptors, with strict-object validation that rejects smuggled caller identity.
- Added `@reasonateai/project-state` with the authoritative PostgreSQL schema and a tenant-scoped store implementing idempotent build-session allocation, reconnect-to-active-session, per-run monotonic event ledger, transactional outbox, single-holder run leases with expiry, artifact metadata, and deployment records.
- Verified the store against real PostgreSQL 16: idempotent replay, reconnect reuse, cross-tenant refusal, contiguous event ordering with cursor replay, outbox publication, and mutually exclusive lease holders all pass as integration tests.
- Corrected the Turborepo graph: `build` now declares the `.mastra/**` output so the API artifact is cacheable and integrity-checkable, and `test` keys its cache on `DATABASE_URL` so a database-less run cannot replay as a passing integration result.

### In progress

- Bind the CTO runtime to authenticated web-request session allocation, PostgreSQL-backed project state, transactional outbox, run leases, authorization, evidence acceptance, and deployment lifecycle adapters.
- Select and implement the first private API/worker/Redis/PostgreSQL/object-storage local topology; raw Mastra routes remain disabled at public ingress.
- Finalize the launch authentication architecture and provider decision from current official documentation and security evidence.

### Next

1. Implement Redis Streams command dispatch, bounded consumer recovery, and the durable outbox relay; the API streams persisted events through SSE with `Last-Event-ID` replay.
2. Close the raw-Mastra-route exposure: register authenticated product routes and deny `/api/agents/*`, Studio, and worker endpoints at ingress.
3. Configure the documented Mastra worker split (`MASTRA_WORKERS`, shared storage, `RedisStreamsPubSub`) on the existing `apps/api/src/mastra` composition root.
4. Implement authenticated build-session allocation and bind the first browser request to its shared sandbox workspace and CTO controller session.
5. Select the web, authentication, ORM/database library, browser-test, sandbox, preview, object-storage, and deployment adapters through documented current-version evaluation.
6. Implement secure session persistence, rotation, idle/absolute expiry, revocation, and logout.
7. Implement organization creation and owner membership as one transaction.
8. Implement authenticated project creation and scoped project retrieval.
9. Record safe audit events for sign-in, organization/project creation, session revocation, authorization denial, run dispatch, approval, and exposure changes.
10. Add CSRF protection, redirect validation, identity-endpoint rate limits, and secure cookie configuration.
11. Add integration tests for session lifecycle, tenant isolation, permission denial, event ordering, idempotent command recovery, and audit recording.
12. Exercise the full launch vertical slice through the running API, private worker, Redis, PostgreSQL, and real local persistence.
13. Bind the first resource-read vertical slice to the authorization contract.
14. Exercise one authenticated build session through sandbox allocation, CTO execution, preview creation, reconnect, and Git checkpoint recovery.
15. Implement the selected deployment adapter and verify an accepted checkpoint at its authorized URL before claiming the product-generation journey complete.

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
