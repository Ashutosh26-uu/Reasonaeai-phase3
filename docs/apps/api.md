# `apps/api`

**Status:** ✅ authenticated product control plane implemented and verified · 🟡 preview, deployment, and approval-resolution routes not yet built
**Owns:** `apps/api`
**Owner role:** API Control Plane

---

## Purpose

The authenticated control plane, and the single Mastra composition root for both the API role and the worker role.

Three responsibilities, deliberately separated in the code:

| Responsibility | Files |
| --- | --- |
| Compose configuration for Mastra | `src/mastra/index.ts`, `src/mastra/workspace.ts` |
| Protect the public surface | `src/mastra/server.ts`, `src/mastra/principal.ts` |
| Serve the product routes | `src/mastra/routes/*`, `src/mastra/run-event-fanout.ts`, `src/mastra/outbox-relay.ts` |

Agent behaviour is **not** here. It lives in `@reasonateai/cto-runtime`. This application supplies storage, observability, model configuration, workspace, and the ingress policy.

---

## File map

| File | Responsibility |
| --- | --- |
| `src/mastra/index.ts` | Mastra instance: storage, observability, runtime registration, ingress denial, route registration, outbox relay |
| `src/mastra/server.ts` | Blocked built-in route groups and the middleware that denies them |
| `src/mastra/principal.ts` | Session cookie reading, principal resolution, typed error responses |
| `src/mastra/middleware.ts` | CSRF pair verification and the `Origin` allowlist on state-changing requests |
| `src/mastra/workspace.ts` | One Docker workspace per verified run scope, with approval and read-before-write policy |
| `src/mastra/outbox-relay.ts` | Publishes committed outbox records onto Redis, surviving a transport outage |
| `src/mastra/run-event-fanout.ts` | One transport subscription per run per topic, fanned out to every follower in the process |
| `src/mastra/routes/auth.ts` | Sign-in link issue and redemption, session read and revocation |
| `src/mastra/routes/organizations.ts` | Organization creation and membership grant |
| `src/mastra/routes/projects.ts` | Project creation and scoped listing |
| `src/mastra/routes/build-sessions.ts` | Build-session allocation, conversation turns, conversation history and listing |
| `src/mastra/routes/run-events.ts` | The durable and live event streams a browser follows |
| `src/mastra/routes/artifacts.ts` | Artifact recording, listing, signed access, and download |
| `src/mastra/routes/voice.ts` | Recording transcription and bounded turn synthesis behind the replaceable ASR/TTS adapters |
| `src/mastra/adapters/magic-link-sender.ts` | The delivery boundary for sign-in links |
| `src/mastra/adapters/asr.ts` | The OpenAI-compatible speech-to-text boundary and its environment resolution |
| `src/mastra/adapters/tts.ts` | The OpenAI-compatible text-to-speech boundary and its environment resolution |
| `test/server.test.ts` | The required denial set, one middleware per group, and the 404 answer |
| `test/principal.test.ts` | Cookie matching, fail-closed resolution, error envelope |
| `test/run-events.test.ts` | Durable replay, gap backfill, live delivery, and the live topic over real Redis |
| `test/voice.test.ts` | Refusal ordering, upload bounds, provider-error redaction, and the synthesis contract |

---

## Product routes

Every route lives outside `/api`, resolves a session principal, authorizes through `@reasonateai/auth`, and takes its tenant scope from storage rather than from a request body.

```text
POST   /v1/auth/magic-links                                  request a sign-in link
GET    /v1/auth/callback                                     redeem it, establish the session
GET    /v1/auth/session                                      read the caller's session
DELETE /v1/auth/session                                      revoke it
POST   /v1/organizations                                     create an organization (owner membership)
POST   /v1/projects                                          create a project
GET    /v1/projects                                          list the caller's projects
POST   /v1/build-sessions                                    allocate or reconnect a build session
GET    /v1/build-sessions/:buildSessionId                     read it in scope
GET    /v1/projects/:projectId/conversations                  list a project's conversations
GET    /v1/build-sessions/:buildSessionId/messages            read the conversation history
POST   /v1/build-sessions/:buildSessionId/turns                append one turn
GET    /v1/build-sessions/:buildSessionId/events               follow the run's events (SSE)
POST   /v1/artifacts  · GET /v1/artifacts                        record and list artifact metadata
POST   /v1/artifacts/:artifactId/access · GET .../download       signed access and byte delivery
```

---

## The event stream

One SSE route carries two channels of different authority.

| Channel | Frames | Carries | Replay |
| --- | --- | --- | --- |
| Durable | `event: <run event type>`, with `id: <ledger sequence>` | committed transitions: run status, agent boundaries, tool calls and results, approvals, tasks, previews, deployments | `Last-Event-ID` resumes from the ledger; a gap the transport cannot bridge is backfilled from it |
| Live | `event: message.snapshot` and `event: subagent.delta`, with **no** `id` | bounded ordered snapshots of streaming assistant text, explicit reasoning, and tool references, plus delegated-worker text | none, deliberately |

The live channel carries no `id` because `id` is what a reconnecting browser replays as `Last-Event-ID`: numbering a snapshot would move the cursor to a position the ledger never issued. Snapshot revisions replace the previous view of one message; periodic durable snapshots and a final ledger snapshot preserve partial output across reconnects and worker failures. Live frames travel on a separate, bounded topic per run (`reasonateai.run.live.<runId>`, `MAXLEN ~512`, one-hour expiry) that the worker's publisher writes and this process reads. `GET /v1/build-sessions/:id/messages` returns bounded event pages across every run in that conversation; its `after` cursor addresses the conversation page, not a run sequence. Both history and live subscriptions are organization/project scoped.

Both channels are fanned out through `run-event-fanout.ts`, which holds one transport subscription per run per topic no matter how many browsers follow it, and releases them when the last follower leaves.

---

## Ingress policy

Mastra's generated server exposes agent, controller, memory, tool, workflow, observability, OpenAPI, and Studio routes. None of them enforces ReasonateAI authorization, and `GET /api/agents` returned an agent's **entire system prompt** to any caller.

Every built-in group is now unreachable:

```text
/api/agents/*          /api/agents/reasonate-cto      → 404
/api/memory/*          /api/tools/*                   → 404
/api/workflows/*       /api/logs/*                    → 404
/api/observability/*   /api/openapi.json              → 404
/swagger-ui/*                                         → 404
```

`/health` still answers `200` so readiness checks work.

The mechanism is Mastra's documented approach for blocking built-in route groups: a middleware that returns a response without calling `next`. Two constraints matter:

1. Middleware paths must include the configured API prefix (`/api` by default).
2. Product routes must live **outside** that prefix, or they are blocked too.

Verified on the built server, not only in tests.

---

## Principal resolution

```ts
resolveSessionPrincipal({ cookieHeader, sessions, now? }) // UserPrincipal | undefined
readSessionCookie(cookieHeader, name?)                    // string | undefined
unauthenticatedResponse(requestId)                        // typed 401 Response
```

| Behaviour | Reason |
| --- | --- |
| Only the exact cookie name resolves | `reasonate_session_backup` must not substitute for `reasonate_session` |
| Revocation and expiry are re-checked here | This is where an untrusted cookie becomes a trusted principal; the decision must not depend on one storage implementation |
| An unusable identifier throws | A malformed session row is a bug, not a request to continue with |
| The error body carries no identifiers | A denial must not reveal whether a resource exists in another tenant |

---

## Workspace

One stable sandbox identity derived from the verified organization, project, and build session. The scope is read only from server-populated request context, so a request without a verified scope fails closed instead of sharing a sandbox.

Policy applied to workspace tools:

| Setting | Value |
| --- | --- |
| Default approval | Required |
| Write and edit | Required, plus read-before-write |
| Delete | Required |
| Execute command | Required, output capped |

Generated code never receives a host Docker socket.

---

## Build and run

```bash
pnpm --filter @reasonateai/api run dev     # Mastra dev server and Studio
pnpm --filter @reasonateai/api run build   # .mastra/output
pnpm --filter @reasonateai/api run start   # serve the built artifact
```

The build is intentionally **not** cached by Turborepo. `mastra build` runs a package install into its output directory, which contains symlinked `node_modules`; caching it made Turbo archive that install, slowed the build past two minutes, emitted a tar warning about writing outside the directory, and risked restoring an artifact with no dependencies installed.

---

## What is not built yet

- **No preview, deployment, or approval-resolution routes.** The ledger already carries `preview.*`, `deployment.*`, and `approval.*` events, and the browser renders a parked approval, but no route decides one or promotes a checkpoint.
- **No cancellation route.** `run.cancel` exists in the command contract and nothing consumes it.
- **Mastra storage is still LibSQL and DuckDB** for the composition root's own memory and observability, while the product's authoritative state is PostgreSQL through `@reasonateai/project-state`.
- **Oversized tool output still spills to the host filesystem** rather than the artifact store, so `artifact://` does not yet resolve a durable artifact.

---

## How to add a product route

1. Register it with `registerApiRoute` at a path **outside** `/api`, for example `/v1/build-sessions/:id/events`.
2. Resolve the principal with `resolveSessionPrincipal`, and return `unauthenticatedResponse` when it is absent.
3. Validate the body and params with a schema from `@reasonateai/contracts`.
4. Authorize through `@reasonateai/auth` before touching state.
5. Take the tenant scope from storage, never from the request body.
6. Add the route to the required-denial reasoning in `test/server.test.ts` if it must never be shadowed by a built-in group.

Mastra's generated server exposes agent, controller, memory, tool, workflow, observability, OpenAPI, and Studio routes. None of them enforces ReasonateAI authorization, and `GET /api/agents` returned an agent's **entire system prompt** to any caller.

Every built-in group is now unreachable:

```text
/api/agents/*          /api/agents/reasonate-cto      → 404
/api/memory/*          /api/tools/*                   → 404
/api/workflows/*       /api/logs/*                    → 404
/api/observability/*   /api/openapi.json              → 404
/swagger-ui/*                                         → 404
```

`/health` still answers `200` so readiness checks work.

The mechanism is Mastra's documented approach for blocking built-in route groups: a middleware that returns a response without calling `next`. Two constraints matter:

1. Middleware paths must include the configured API prefix (`/api` by default).
2. Product routes must live **outside** that prefix, or they are blocked too.

Verified on the built server, not only in tests.

---

## Principal resolution

```ts
resolveSessionPrincipal({ cookieHeader, sessions, now? }) // UserPrincipal | undefined
readSessionCookie(cookieHeader, name?)                    // string | undefined
unauthenticatedResponse(requestId)                        // typed 401 Response
```

| Behaviour | Reason |
| --- | --- |
| Only the exact cookie name resolves | `reasonate_session_backup` must not substitute for `reasonate_session` |
| Revocation and expiry are re-checked here | This is where an untrusted cookie becomes a trusted principal; the decision must not depend on one storage implementation |
| An unusable identifier throws | A malformed session row is a bug, not a request to continue with |
| The error body carries no identifiers | A denial must not reveal whether a resource exists in another tenant |

---

## Workspace

One stable sandbox identity derived from the verified organization, project, and build session. The scope is read only from server-populated request context, so a request without a verified scope fails closed instead of sharing a sandbox.

Policy applied to workspace tools:

| Setting | Value |
| --- | --- |
| Default approval | Required |
| Write and edit | Required, plus read-before-write |
| Delete | Required |
| Execute command | Required, output capped |

Generated code never receives a host Docker socket.

---

## Build and run

```bash
pnpm --filter @reasonateai/api run dev     # Mastra dev server and Studio
pnpm --filter @reasonateai/api run build   # .mastra/output
pnpm --filter @reasonateai/api run start   # serve the built artifact
```

The build is intentionally **not** cached by Turborepo. `mastra build` runs a package install into its output directory, which contains symlinked `node_modules`; caching it made Turbo archive that install, slowed the build past two minutes, emitted a tar warning about writing outside the directory, and risked restoring an artifact with no dependencies installed.

---

## How to add a product route

1. Register it with `registerApiRoute` at a path **outside** `/api`, for example `/v1/build-sessions/:id/events`.
2. Resolve the principal with `resolveSessionPrincipal`, and return `unauthenticatedResponse` when it is absent.
3. Validate the body and params with a schema from `@reasonateai/contracts`.
4. Authorize through `@reasonateai/auth` before touching state.
5. Take the tenant scope from storage, never from the request body.
6. Add the route to the required-denial reasoning in `test/server.test.ts` if it must never be shadowed by a built-in group.
