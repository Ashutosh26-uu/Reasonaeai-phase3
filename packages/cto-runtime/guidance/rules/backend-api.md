---
name: backend-api
description: "HTTP service discipline: validation, authorization, error contracts, idempotency, limits, observability."
always: false
globs: ["**/app/api/**/*.ts", "**/route.ts", "**/routes/**", "**/server/**", "**/api/**/*.py", "**/*.go", "**/handlers/**"]
---

# Backend and API
## Request handling
- One handler does one thing: validate → authorize → execute → serialize. Keep the layers distinguishable in the code, even in a single file.
- Validate the whole request at the boundary with a schema: path params, query, headers used, and body. Reject unknown fields rather than ignoring them.
- Convert a validated request into a domain call. Never pass a request object, `FormData`, or a raw parsed JSON blob into persistence or business logic.
- Never trust a client-supplied identity, tenant id, role, price, or total. Resolve identity from the authenticated principal and authorize the specific resource.
- Return only the fields the contract needs. Serialize through an explicit response shape; never return a database row, ORM entity, or user record wholesale.

## Errors
- Map domain failures to a small, consistent set of status codes: 400 malformed input, 401 unauthenticated, 403 unauthorized, 404 unknown resource, 409 conflict or duplicate, 422 semantic validation, 429 rate limited, 500 unexpected.
- Return a stable error body with a machine-readable code and a human-readable message; never leak a stack trace, SQL, file path, or internal id.
- Do not use a 200 with `{ "error": … }`. The status code is part of the contract.
- Log the cause server-side with a correlation id; return that id to the caller when it helps support, never the exception text.
- Never swallow an exception to return an empty list or a default object: that turns a failure into silent data loss.

## Mutations
- Make every non-idempotent mutation safe to retry: accept an idempotency key, or make the operation naturally idempotent (upsert with a stable key, conditional update).
- Wrap a multi-step write in one transaction. Do not leave a half-applied state that a retry then duplicates.
- Return the resulting resource, not just a success flag, so the caller does not have to re-read.
- Reject transitions that are invalid for the current state with 409, not by silently ignoring them.

## Reads
- Always paginate a collection; default to a bounded page size and reject an unbounded `limit`.
- Sort deterministically; an unstable order makes pagination drop or duplicate rows.
- Keep response size bounded; cap or stream what can be arbitrarily large.

## Limits and availability
- Set explicit timeouts on every outbound call, database query, and lock wait. No unbounded wait anywhere.
- Bound concurrency for parallel work, and bound retries with backoff and jitter. Retry only idempotent or keyed operations.
- Apply rate limits to endpoints that can be abused, and stream or buffer-cap uploads.
- Add health and readiness endpoints that reflect real dependencies instead of returning a constant.

## Observability
- Use structured logs with the request id, route, outcome, and duration. Never log secrets, tokens, cookies, authorization headers, full request bodies, or prompts containing user data.
- Log at boundaries: request rejected, authorization denied, mutation applied, dependency failed. Do not log inside a loop.
- Emit a metric or counter for failures that operators must act on; make the failure actionable, not just noisy.

## Configuration and secrets
- Read configuration from the environment at startup, validate it once, and fail fast with a clear message when required values are missing.
- Never commit a secret, default credential, API key, or connection string. Never expose one to a client bundle.
- Keep environment-specific values out of code paths; no `if (process.env.NODE_ENV === "production")` branching for behavior that should be configured.
