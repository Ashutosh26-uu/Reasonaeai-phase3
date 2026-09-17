# ReasonateAI Engineering Rules

This file is the operating contract for every human and automated contributor in this repository. Read it before planning or changing code.

## Canonical project context

Read the documents relevant to the task before implementation:

- [`SPEC.md`](./SPEC.md) — current product specification, architecture, security invariants, and approved technology stack.
- [`PHASE.md`](./PHASE.md) — current delivery phase, active scope, status, exit criteria, and immediate next work.
- [`FUTURE.md`](./FUTURE.md) — accepted ideas intentionally deferred beyond the current phase.
- [`PLAN.md`](./PLAN.md) — original Phase 3 plan and delivery rationale. It is historical planning context; `SPEC.md` and `PHASE.md` describe the current contract and execution state.

When these files conflict, use this precedence:

1. Security and data-integrity invariants in `SPEC.md`.
2. Current scope and exit criteria in `PHASE.md`.
3. Current product contract in `SPEC.md`.
4. Deferred intent in `FUTURE.md`.
5. Historical intent in `PLAN.md`.

Do not silently resolve a material product conflict. Record the chosen resolution in the appropriate canonical file in the same change.

## Self-maintaining project context

These context files are living repository state, not passive documentation. Update them as part of the work that makes them inaccurate.

- Update `AGENTS.md` when a stable repository-wide engineering rule, workflow, security boundary, or architectural convention changes.
- Update `SPEC.md` when an accepted product requirement, system boundary, public contract, technology choice, or security invariant changes.
- Update `PHASE.md` when work starts, completes, becomes blocked, changes order, or satisfies/fails an exit criterion.
- Add an item to `FUTURE.md` when a worthwhile feature is explicitly deferred. Remove it when it moves into `PHASE.md` or is rejected, recording the decision.
- Keep `PLAN.md` unchanged unless the historical plan itself is being corrected. Do not use it as a live task tracker.
- Documentation updates belong in the same commit as the code or decision they describe.
- Do not rewrite these files for incidental implementation details. Keep them concise, durable, and free of duplicated status.
- Before finishing a task, check whether its implementation changed any statement in these four files. If so, update the affected files before committing.

## Delivery workflow

1. Read `SPEC.md` and `PHASE.md`; read `FUTURE.md` when considering scope expansion.
2. Inspect existing code, tests, configuration, and call sites before designing a change. Reuse an existing pattern instead of introducing a second convention.
3. For third-party libraries, gather current primary-source context before use:
   - Prefer an installed project skill when one applies.
   - Otherwise use current official documentation through MCP or the web.
   - Verify the latest stable release, runtime compatibility, migration notes, security advisories, license, and maintenance state.
   - Use the latest stable compatible version for new dependencies. Do not adopt prereleases without an explicit recorded reason.
   - Never rely only on remembered APIs or generated examples.
4. Design the smallest coherent end-to-end change. Identify affected contracts, authorization boundaries, migrations, observability, rollback, and tests before editing.
5. Implement the real behavior. A change is either complete or explicitly tracked as in progress in `PHASE.md`.
6. Exercise the actual changed path. Fix the owning code rather than suppressing errors or weakening checks.
7. Update canonical context, operational documentation, and version metadata when their contracts changed.
8. Commit only a coherent, verified unit of work.

## Completion standard

Never merge or present incomplete behavior as finished.

### Definition of Done

An implementation may be concluded **complete** only when every applicable criterion below has objective evidence. If a criterion does not apply, record why in the pull request or task evidence. Any unmet applicable criterion means the work remains in progress or blocked in `PHASE.md`.

1. **Contract satisfied** — every accepted requirement and acceptance criterion is implemented end to end; the result does not silently narrow the requested scope.
2. **Real behavior present** — production paths contain working behavior, not a stub, no-op, mock disguised as production, placeholder, hard-coded success, or deferred mandatory step.
3. **Complete paths** — success, validation, empty, loading, failure, authorization-denial, retry/recovery, and cancellation paths relevant to the change behave intentionally.
4. **Integration complete** — every caller, consumer, schema, event, migration, configuration value, permission, and public export affected by the change is migrated. Obsolete paths are removed.
5. **Security preserved** — authentication, authorization, tenant isolation, secret handling, input validation, audit, and abuse limits have been evaluated and tested where affected. No unresolved critical/high exploitable vulnerability is introduced.
6. **Data safe** — persistence changes include reviewed migrations, compatibility during deployment, data recovery or rollback instructions, and tests against representative data.
7. **Observable** — failures are actionable; critical transitions have structured logs, metrics/traces where applicable, correlation identifiers, and auditable events without exposing secrets.
8. **Verified at the real surface** — the changed behavior is exercised through the actual runtime. UI work is browser-verified; API work is called through the running API; worker/sandbox work runs the real process.
9. **Tests protect the contract** — applicable unit and integration tests pass; fixed defects have regression tests; critical journeys have smoke and end-to-end coverage. Tests would fail for a plausible regression.
10. **Quality gates pass** — formatting/linting, type checking, tests, build, affected smoke tests, affected end-to-end tests, and security scans pass on a clean frozen-lockfile installation.
11. **Performance is acceptable** — relevant latency, throughput, memory, allocation, query-count, concurrency, timeout, and cost budgets are met. Performance claims have measurements.
12. **Deployable and recoverable** — configuration is documented, secrets remain external, health/readiness checks cover the change, and deployment has rollback or forward-recovery instructions.
13. **Context is current** — `SPEC.md`, `PHASE.md`, `FUTURE.md`, `AGENTS.md`, API documentation, and operational instructions reflect the implemented reality.
14. **Reviewable evidence exists** — the task or pull request records commands/scenarios run, their results, relevant screenshots/artifacts, known limitations, and any explicitly accepted risk.

“Code complete,” compilation, local happy-path success, or a passing mocked test alone never satisfies this definition.

Prohibited in production paths:

- Empty handlers, no-op implementations, placeholder UI, fake success responses, hard-coded demonstration data, and silent fallbacks.
- `TODO`/`FIXME` markers standing in for required behavior.
- Interfaces whose only implementation throws “not implemented.”
- Mocks presented as real integrations.
- Catching or suppressing failures only to make checks pass.

If external credentials or infrastructure prevent completion:

- Finish all locally reachable behavior.
- Mark the work blocked or in progress in `PHASE.md`.
- Expose any mock adapter clearly in the UI and through the same replaceable contract.
- Record the exact missing prerequisite and tested boundary.

## Code quality

Optimize for correctness first, then maintainability and measured performance.

- Prefer simple, explicit modules with narrow responsibilities over speculative abstractions.
- Keep domain logic independent from frameworks and transport layers.
- Validate untrusted input at system boundaries with shared schemas.
- Preserve type safety; avoid `any`, unchecked casts, non-null assertions, and stringly typed state.
- Make invalid states unrepresentable where practical.
- Use dependency injection at external boundaries, not pervasive indirection.
- Avoid unnecessary allocations, copies, serialization, network calls, database round trips, and repeated computation.
- Measure before adding performance complexity. Record benchmarks for performance-motivated changes.
- Bound concurrency, retries, queues, output size, execution time, and spending.
- Make operations idempotent where retries are possible.
- Keep errors typed, actionable, and safe to expose. Preserve the causal error internally.
- Remove obsolete code, exports, compatibility shims, and comments during clean cutovers.
- Use Node.js for repository JavaScript execution. Do not introduce Bun or another runtime without a measured, repository-wide decision recorded in `SPEC.md`.

Formatting and linting are owned by Ultracite/Biome. Do not add ESLint, Prettier, or a competing formatter.

## Architecture rules

- `packages/contracts` owns shared schemas, domain events, identifiers, and cross-package interfaces; it must not depend on applications.
- Applications compose packages. Packages must not import application code.
- Framework-specific code stays at adapters and application boundaries.
- Authentication establishes a principal; centralized authorization decides whether that principal may act on a resource.
- Every tenant-owned row and resource is scoped to an organization, and project-owned data is additionally scoped to a project.
- Agents and sandboxes use short-lived, least-privilege capability grants; they never receive a user session or unrestricted credential.
- Resources are nouns addressed by paths or URIs; tools are verbs. Resource handlers do not bypass centralized authorization.
- Secrets are brokered. They never enter model context, resource reads, logs, artifacts, screenshots, browser storage, or source control.
- Persist important transitions and emit auditable events for security-sensitive state changes.

## Required patterns

- Explicit schemas at API, event, configuration, persistence, and tool boundaries.
- Server-managed, revocable browser sessions using secure cookies.
- Central authorization API with deny-by-default behavior.
- Organization and project scoping in queries, cache keys, object paths, events, and audit records.
- Repository/service boundaries around persistence and external providers.
- Provider-neutral adapters only where the product must support replacement.
- Structured logging with request, organization, project, session, run, and trace identifiers as applicable.
- Database migrations that are reviewable, forward-safe, and paired with rollback or recovery instructions.
- Accessible UI states for loading, empty, error, blocked, approval, and success paths.

## Anti-patterns

- Authorization implemented only in UI controls or scattered independently across handlers.
- Long-lived browser JWTs, tokens in local storage, or project IDs trusted without membership resolution.
- User cookies or broad API keys passed to agents, workers, previews, or sandboxes.
- Cross-tenant queries followed by application-side filtering.
- Generic “manager,” “helper,” or “utils” modules that hide domain ownership.
- Permanent role-specific agent services when bounded temporary delegation is sufficient.
- A vector database, distributed service, queue, cache, or abstraction added before measured need.
- Retrying non-idempotent operations without a key or recovery strategy.
- Logging raw request bodies, authorization headers, cookies, tokens, prompts containing secrets, or environment dumps.
- Tests that assert implementation details, source text, or mocks without exercising observable behavior.

## Testing and verification

Every test must defend an observable contract and fail for a plausible regression.

- Unit tests: deterministic domain rules, schema boundaries, state transitions, authorization decisions, and error precedence.
- Integration tests: persistence, provider adapters, session lifecycle, tenant isolation, migrations, and failure recovery against real local dependencies where practical.
- End-to-end tests: critical user journeys through the deployed application and real browser.
- Smoke tests: start the built application and exercise its health endpoint plus the changed principal flow.
- Security tests: cross-tenant denial, privilege escalation, CSRF, session rotation/revocation, token expiry, path traversal, secret redaction, and webhook verification.
- Regression tests: required for every fixed externally observable defect.

A change is not verified by compilation alone. Run the narrowest checks that exercise the changed behavior, then the applicable repository gates. UI changes require browser verification. Runtime changes require starting and exercising the runtime.

Required pull-request gates for affected code:

```text
pnpm install --frozen-lockfile
pnpm check
pnpm typecheck
pnpm test
pnpm build
affected smoke tests
affected end-to-end tests
```

The root commands may initially have no package work to run; each new package must provide the applicable scripts before it is considered complete.

## Security and dependency hygiene

- Apply least privilege and deny by default.
- Follow current OWASP ASVS guidance for authentication, session management, access control, input handling, and secrets.
- Threat-model new trust boundaries and high-risk flows before implementation.
- Pin the package manager and commit the lockfile. CI uses frozen installs.
- Before adding a dependency, verify that the standard library or an existing dependency cannot meet the need.
- Review direct dependencies for known vulnerabilities, provenance, license compatibility, maintenance health, and transitive cost.
- Run dependency and secret scanning in CI. Critical or high exploitable findings block release until fixed or explicitly risk-accepted with owner and expiry.
- Never weaken a security control to satisfy a test or deadline.
- Never commit secrets, production data, private keys, access tokens, or usable example credentials.

## Versioning and releases

- Follow Semantic Versioning for every publishable package and public API.
- While the product remains pre-1.0, breaking package/API changes increment the minor version; backward-compatible features increment the minor version; fixes increment the patch version.
- Use Changesets when the first publishable workspace package is introduced. Every externally visible package change must include an appropriate changeset.
- Keep internal private applications versioned through release tags rather than independent package publication.
- Release tags use `vMAJOR.MINOR.PATCH` for the product release.
- Database and event contracts require explicit versioning and migration strategy; never reinterpret persisted historical data in place.
- Update release notes with features, fixes, migrations, security impact, known limitations, and rollback instructions.

## Commit rules

Use Conventional Commit structure with an explicit workspace scope:

```text
<type>(<scope>): <imperative message>
```

Allowed primary types:

- `feat` — user- or operator-visible capability.
- `fix` — defect correction.
- `chore` — tooling, dependency, or repository maintenance.
- `refactor` — behavior-preserving restructuring.
- `test` — test-only change.
- `docs` — documentation-only change.
- `perf` — measured performance improvement.
- `ci` — CI/CD workflow change.
- `build` — build or packaging change.
- `revert` — explicit reversal.

Scopes use the affected app or package name, for example:

```text
feat(web): add organization switcher
fix(api): reject revoked sessions
chore(resource): update URI parser dependency
ci(repo): add frozen-lockfile verification
```

Rules:

- Use lowercase type and scope.
- Use an imperative message without a trailing period; keep the subject concise.
- Do not include literal quotation marks around the message.
- Use `repo` for repository-wide work and `deps` for dependency-only updates when no single workspace owns the change.
- One commit represents one coherent change and includes its tests, migrations, and context updates.
- Mark breaking changes with `!` and a `BREAKING CHANGE:` footer.
- Reference an issue or decision in the footer when applicable.
- Never mix unrelated formatting, generated output, or refactors into a feature/fix commit.

## CI/CD and deployment

Pull requests must run on clean, reproducible infrastructure with least-privilege credentials:

1. Frozen dependency installation and lockfile validation.
2. Formatting/linting, type checking, unit and integration tests.
3. Build and artifact integrity checks.
4. Dependency, secret, and static security scanning.
5. Affected smoke and end-to-end tests.
6. Ephemeral preview deployment for affected user-facing applications.

Deployment progression:

```text
pull request preview → staging → production
```

- Build once and promote the same immutable, signed artifact between environments.
- Use environment-scoped identities and secret stores; never copy production secrets into preview environments.
- Apply database migrations as a separately observable deployment step. Prefer expand/migrate/contract changes compatible with rolling deployment.
- Staging must pass smoke tests and critical end-to-end journeys before production promotion.
- Production requires an explicit approval until automated promotion is proven safe.
- Use health checks, readiness checks, structured logs, metrics, traces, and release markers.
- Every release needs rollback or forward-recovery instructions. Automatically halt or roll back on failed health and smoke checks.
- Never deploy from an unreviewed local working tree.
