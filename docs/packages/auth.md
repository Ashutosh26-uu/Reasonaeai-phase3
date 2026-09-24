# `@reasonateai/auth`

**Status:** ✅ policy implemented and verified · 🟡 not yet wired to HTTP routes
**Owns:** `packages/auth`
**Owner role:** Identity & Access

---

## Purpose

One centralized, deny-by-default decision point. Every protected action — API route, agent tool, preview, artifact download, checkpoint operation, sandbox command — resolves through the same function.

Authorization is decided from a single expression:

```text
principal + action + organization scope + project/resource scope + context
```

Scattering permission checks across handlers is explicitly prohibited, because a handler that forgets one is a silent privilege escalation.

---

## Public surface

| Export | Kind | Purpose |
| --- | --- | --- |
| `authorize` | function | Returns a typed allow or deny decision |

Request and decision shapes live in `@reasonateai/contracts/authorization`:

| Export | Purpose |
| --- | --- |
| `AuthorizationRequest` | Principal, action, resource, and context |
| `AuthorizationResource` / `AuthorizationResourceKind` | What is being acted on |
| `AuthorizationDecision` | Discriminated union on `allowed` |
| `AuthorizationDenialReason` | Typed reason, safe to expose |

---

## Decision inputs

| Input | Source | Why it matters |
| --- | --- | --- |
| Principal | Resolved session or workload grant | A user session is never passed to an agent or sandbox |
| Action | The requested operation | Explicit capability, not a role implication |
| Organization scope | Request context, resolved from storage | Never trusted from a client identifier |
| Project scope | Request context, resolved from storage | Same |
| Context | Session state, expiry, membership status | A revoked session or suspended membership denies |

---

## Key invariants

| Invariant | Reason |
| --- | --- |
| Deny by default | An unknown action or missing context denies rather than allows |
| Tenant scope is exact | A membership in another organization never authorizes a project |
| Identifier knowledge is not authority | Guessing a project id yields a denial, never a row |
| Administrative grants are not member-grantable | Prevents self-escalation |
| Workload capabilities are bounded and expiring | Agents and sandboxes hold least privilege |
| Session state is evaluated | A revoked or expired session cannot act |
| Denial reasons are typed and safe | Callers branch on data, and nothing leaks existence |

---

## How it works

`authorize` receives a validated `AuthorizationRequest` and returns a validated `AuthorizationDecision`. It performs no I/O: the caller resolves the principal and scope first, then asks for a decision. Keeping it pure is what makes it exhaustively testable and safe to call from any boundary.

The deny path returns a typed `AuthorizationDenialReason`. The HTTP layer maps that to the shared error envelope in `@reasonateai/contracts/api-error`, so a browser receives a stable code and the same response whether a resource is missing or belongs to another tenant.

---

## What is not built yet

- **HTTP wiring.** No product route calls `authorize` yet, so the policy is enforced in tests but not yet on a live request path.
- **Session and membership loading.** `authorize` receives already-resolved inputs; the loader that reads memberships and project scope from PostgreSQL is part of the Identity & Access workstream.
- **Capability issuance.** Workload grants are described by schema; issuing, scoping, and revoking them is not implemented.
- **Audit emission.** Denials must produce a safe audit event; that write path does not exist yet.

---

## Testing

```bash
pnpm --filter @reasonateai/auth test
```

`test/authorize.test.ts` covers role permissions, missing and inactive memberships, rejection of administrative self-grants, tenant and project isolation, session revocation and expiry, workload scope and expiry, and anonymous denial.

---

## How to extend it

1. Add the capability to `permissions` in `@reasonateai/contracts/identity` first, so the action name is shared.
2. Extend the decision table in `authorize`.
3. Add a case to `test/authorize.test.ts` that asserts both the allow and the deny, including the denial reason.
4. If the change affects a public route or a security invariant, record it in [`../.context/SPEC.md`](../.context/SPEC.md).

Never add a second permission check inside a handler. If a handler needs a narrower decision, add a capability.
