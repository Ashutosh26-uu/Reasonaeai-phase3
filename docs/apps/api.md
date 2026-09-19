# `apps/api`

**Status:** ✅ ingress denial and principal resolution implemented and verified · 🟡 product routes not yet built
**Owns:** `apps/api`
**Owner role:** API Control Plane

---

## Purpose

The authenticated control plane, and the single Mastra composition root for both the API role and the worker role.

Two responsibilities, deliberately separated in the code:

| Responsibility | Files |
| --- | --- |
| Compose configuration for Mastra | `src/mastra/index.ts`, `src/mastra/workspace.ts` |
| Protect the public surface | `src/mastra/server.ts`, `src/mastra/principal.ts` |

Agent behaviour is **not** here. It lives in `@reasonateai/cto-runtime`. This application supplies storage, observability, model configuration, workspace, and the ingress policy.

---

## File map

| File | Responsibility |
| --- | --- |
| `src/mastra/index.ts` | Mastra instance: storage, observability, runtime registration, ingress denial |
| `src/mastra/server.ts` | Blocked built-in route groups and the middleware that denies them |
| `src/mastra/principal.ts` | Session cookie reading, principal resolution, typed error responses |
| `src/mastra/workspace.ts` | One Docker workspace per verified run scope, with approval and read-before-write policy |
| `test/server.test.ts` | The required denial set, one middleware per group, and the 404 answer |
| `test/principal.test.ts` | Cookie matching, fail-closed resolution, error envelope |
| `test/cto-runtime.test.ts` | The runtime registers under the branded name with an unrestricted mode |

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

- **No product routes.** Nothing under `/v1` exists, so the principal middleware is not yet called by any route.
- **No SSE endpoint.** Browser progress streaming is not implemented.
- **No body validation on requests.** Route-level schemas arrive with the first product route.
- **No CORS policy.** Mastra's default applies; it must be narrowed before the browser client ships.
- **Storage is LibSQL and DuckDB**, not the PostgreSQL project-state store, and PubSub is in-process rather than Redis Streams. The worker split is therefore not yet configured.
- **No CSRF protection** on state-changing requests.

---

## How to add a product route

1. Register it with `registerApiRoute` at a path **outside** `/api`, for example `/v1/build-sessions/:id/events`.
2. Resolve the principal with `resolveSessionPrincipal`, and return `unauthenticatedResponse` when it is absent.
3. Validate the body and params with a schema from `@reasonateai/contracts`.
4. Authorize through `@reasonateai/auth` before touching state.
5. Take the tenant scope from storage, never from the request body.
6. Add the route to the required-denial reasoning in `test/server.test.ts` if it must never be shadowed by a built-in group.
