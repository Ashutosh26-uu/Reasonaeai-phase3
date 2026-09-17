# Current Phase — Foundation and Identity Contracts

## Phase objective

Establish the repository, governance, identity model, and centralized authorization boundary that every resource, API, agent, worker, preview, and sandbox operation will use.

This phase is active. Authentication and authorization precede the unified resource implementation because resource access requires a verified, scoped principal.

## Scope

### Completed

- Initialized the private pnpm/Turborepo workspace.
- Pinned pnpm and selected Node.js as the repository runtime.
- Configured Ultracite/Biome formatting and linting.
- Configured Lefthook pre-commit checks.
- Defined the product specification, engineering rules, implementation Definition of Done, and deferred-feature tracker.
- Added `@reasonateai/contracts` with branded identifiers, user/workload principals, memberships, roles, permissions, sessions, workload capability limits, audit events, authorization requests, and typed decisions.
- Added `@reasonateai/auth` with a centralized deny-by-default policy for organization roles, project roles, session state, exact tenant/project scope, and bounded workload capabilities.
- Added contract and policy tests covering strict validation, administrative-grant rejection, role permissions, missing/inactive memberships, tenant/project isolation, session revocation/expiry, workload scope/expiry, and anonymous denial.

### In progress

- Finalize the launch authentication architecture and provider decision from current official documentation and security evidence.

### Next

1. Select the web, API, authentication, persistence, and browser-test stack through documented current-version evaluation.
2. Implement secure session persistence, rotation, idle/absolute expiry, revocation, and logout.
3. Implement organization creation and owner membership as one transaction.
4. Implement authenticated project creation and scoped project retrieval.
5. Record safe audit events for sign-in, organization/project creation, session revocation, and authorization denial.
6. Add CSRF protection, redirect validation, identity-endpoint rate limits, and secure cookie configuration.
7. Add integration tests for session lifecycle, tenant isolation, permission denial, and audit recording.
8. Exercise the full launch vertical slice through the running API and real local persistence.
9. Bind the first resource-read vertical slice to the authorization contract.

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

## Phase exit criteria

The phase is complete only when all applicable repository Definition of Done criteria in [`AGENTS.md`](./AGENTS.md#definition-of-done) pass and the following evidence exists:

- Identity, tenancy, session, permission, capability-grant, and audit schemas are versioned and validated.
- Central authorization is deny-by-default and has exhaustive role/capability decision tests.
- The launch vertical slice passes through the running application and real local persistence.
- Cross-organization and cross-project access attempts fail at the query/resource boundary.
- Session creation, rotation, expiry, revocation, and logout have integration coverage.
- CSRF, redirect validation, rate limits, cookie properties, and secret redaction are verified.
- Applicable `pnpm check`, type checking, tests, build, smoke tests, and end-to-end tests pass from a frozen-lockfile install.
- Architecture and operational documentation match the implemented behavior.
- No required path is represented by a stub, fake success, hidden manual correction, or untracked follow-up.

## Not in this phase

The following remain out of active scope until these exit criteria pass:

- Voice model integration.
- Production sandbox provider implementation.
- Full executive-agent workflow.
- Browser repair loops.
- Enterprise SSO and SCIM.
- Native mobile generation.

Moving one of these items into active work requires updating this file and, when applicable, removing it from [`FUTURE.md`](./FUTURE.md) in the same change.
