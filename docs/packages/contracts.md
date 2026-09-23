# `@reasonateai/contracts`

**Status:** ✅ implemented and verified
**Owns:** `packages/contracts`
**Owner role:** Project State & Data reviews; every role consumes

---

## Purpose

The shared vocabulary of the system. Every boundary — HTTP request, command, event, job, persisted record — is described by a schema here. Downstream packages never invent their own shape for a value that crosses a boundary.

`packages/contracts` **must not** depend on applications or on other workspace packages. It depends only on Zod.

---

## Public surface

Subpath exports, each mapping to one concern.

| Subpath | Provides |
| --- | --- |
| `identity` | Branded identifiers, principals, memberships, roles, permissions, session records, audit events |
| `authorization` | Authorization request and decision shapes |
| `execution` | Build sessions, sandbox environments, product lifecycle stages, deployments, allocation request/result |
| `execution-protocol` | Run commands, sequenced run events, run leases, artifact manifests, preview and release descriptors, topic naming |
| `api-error` | The single HTTP error envelope and its code-to-status mapping |

### `identity`

Branded UUIDs prevent mixing identifiers at compile time: `UserId`, `OrganizationId`, `ProjectId`, `SessionId`, `RunId`, `WorkloadId`, `AuditEventId`.

`PrincipalSchema` is a discriminated union on `kind`:

| Variant | Meaning |
| --- | --- |
| `anonymous` | No verified identity |
| `user` | A browser session: `userId`, `sessionId`, `expiresAt`, `revokedAt` |
| `workload` | An agent, worker, or sandbox: scope, permissions, `expiresAt` |

A workload principal is deliberately **not** a user principal. A user session is never passed into an agent or sandbox.

### `execution`

Encodes the product lifecycle as a closed enum and a transition rule:

```ts
canAdvanceProductLifecycle(from, to) // idempotent or exactly one stage forward
isShareableDeployment(deployment)    // status 'ready' AND a URL exists
```

`AllocateBuildSessionRequestSchema` accepts only `idempotencyKey`, `organizationId`, `projectId`, and `userSessionId`. It is a `strictObject`, so a caller cannot smuggle a `runId` or `sandboxId` past validation.

### `execution-protocol`

The wire contract between control plane and execution plane.

`RunCommandEnvelope` carries **references and authority metadata only** — never a browser cookie, plaintext secret, or unbounded prompt payload. It is a `strictObject`, so an extra field such as `cookie` is rejected outright (covered by a test).

`RunEventEnvelope` is the durable browser-visible transition:

```ts
{ schemaVersion, eventId, runId, sequence, type, organizationId, projectId, occurredAt, payload }
```

`runEventTopic(runId)` names the transport topic. `isReplayableSequence(cursor)` guards the reconnect cursor.

### `api-error`

```ts
{ error: { code, message, requestId } }
```

The browser switches on `code`, never on prose. Codes map to statuses centrally, and a denial never reveals whether a resource exists in another tenant.

---

## Key invariants

| Invariant | Why | Defended by |
| --- | --- | --- |
| Boundaries use `strictObject` | An unexpected field is a bug or an attack, not something to ignore | `test/execution-protocol.test.ts` rejects a command carrying `cookie` |
| Identifiers are branded | `ProjectId` cannot be passed where `OrganizationId` is expected | Type checking |
| A workload principal has bounded scope and expiry | Least privilege for agents and sandboxes | `test/authorization.test.ts` |
| Lifecycle advances one stage at a time | Prevents skipping verification or approval | `test/execution.test.ts` |
| A deployment is shareable only when ready with a URL | Never present an unverified URL | `test/execution.test.ts` |
| Replay cursors must be non-negative integers | Prevents an undefined resume position | `test/execution-protocol.test.ts` |

---

## How to change a contract

1. Confirm the change is required by a real consumer, not speculative.
2. Update the schema, keeping `strictObject`.
3. Run `pnpm --filter @reasonateai/contracts build` so subpath exports resolve.
4. **Migrate every consumer in the same pull request.** No shims, aliases, or deprecated fields.
5. Add or update a test that fails for a plausible bad input.
6. If the change affects a public API or persisted shape, add a version or migration strategy and record it in [`../.context/SPEC.md`](../.context/SPEC.md).

---

## Testing

```bash
pnpm --filter @reasonateai/contracts test
```

| File | Proves |
| --- | --- |
| `test/authorization.test.ts` | Role and capability decisions, tenant isolation, session state |
| `test/execution.test.ts` | Lifecycle transitions, allocation strictness, deployment shareability |
| `test/execution-protocol.test.ts` | Envelope strictness, smuggled-field rejection, cursor guard, topic naming |

---

## Current limitations

- No published version/changeset yet; the package is private and consumes `workspace:*`.
- Cost and token budgets are declared but not yet enforced by a runtime component.
- `payload` on commands and events is `Record<string, unknown>`; per-event typed payloads arrive when the consumer exists.
