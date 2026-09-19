# Verification

**Status:** ✅ policy in force
**Owner role:** Platform, DevEx & Security, with every role applying it

---

## The rule

Compilation is not verification. Local happy-path success is not verification. A passing mocked test is not verification.

Work is complete only when the changed behaviour has been exercised through the real surface and the evidence is recorded.

| Change type | Proof required |
| --- | --- |
| Experiment or investigation | Run it; the output is the proof; no test needed |
| Bug fix | Reproduce first, fix, then confirm the reproduction no longer triggers. Keep the reproduction as a regression test when practical |
| Feature or API change | Fix any existing test the changed contract breaks, and prove the new behaviour with a throwaway script or a test that fails without the change |
| UI change | Verify in a real browser |
| Runtime, worker, or sandbox change | Start the real process and exercise the changed path |
| Persistence or migration change | Run against a real database, including rollback or recovery notes |

If the surface cannot be exercised in this environment, say so explicitly rather than implying it was verified.

---

## Gates

Run from the repository root.

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

With services running, so integration tests actually execute rather than skip:

```bash
export DATABASE_URL="postgres://reasonate:reasonate@127.0.0.1:55432/reasonate"
export REDIS_URL="redis://127.0.0.1:56379"
pnpm test
```

Confirm a service-dependent suite really ran, not skipped:

```bash
pnpm --filter @reasonateai/project-state test
```

A line reading `↓ test/postgres.test.ts (4 tests | 4 skipped)` means it did **not** run.

---

## What each suite proves

| Suite | Proves | Needs services |
| --- | --- | --- |
| `@reasonateai/contracts` (14) | Boundary schemas reject unexpected fields, identifiers stay branded, lifecycle advances one stage, deployments are only shareable when ready with a URL | No |
| `@reasonateai/auth` (11) | Role and capability decisions, tenant isolation, session state, workload scope and expiry, anonymous denial | No |
| `@reasonateai/project-state` (15) | Idempotent allocation, reconnect reuse, cross-tenant refusal, ledger contiguity and cursor replay, outbox publication and recovery, mutual lease exclusion, token hashing, revocation, rotation, expiry, concurrent migrations | **Yes** |
| `@reasonateai/cto-runtime` (7) | CTO mode unrestricted, scout read-only, coder and debugger capable, unbounded loops refused, run-scope isolation and sanitisation | No |
| `@reasonateai/api` (14) | Required denial set, one middleware per blocked group, 404 answer, cookie matching, fail-closed principal resolution, error envelope, runtime registration | No |

---

## Writing a test that earns its place

A test must defend an observable contract and fail for a plausible regression.

**Keep** tests that assert behaviour, boundaries, invariants, transitions, precedence, and real errors.

**Delete** tests that assert implementation: wiring, field copies, defaults, forwarding, mock echoes, or source text. A test pinned to wording or to internal call order will pass while the product is broken.

**Never pad** with same-path parameter rows, tautologies, bare not-throw assertions, or "length grew" checks.

Ask: *if someone made the most likely mistake here, would this test fail?* If not, it is not a test — it is decoration.

---

## Evidence to record

Every pull request and every tracker entry records:

1. The exact commands run, with their observed results.
2. The scenarios exercised, and through which surface.
3. Screenshots or artifacts for visual or UI changes.
4. Known limitations and anything intentionally not covered.
5. Any explicitly accepted risk, with an owner.

For the delivery tracker, evidence goes in the **Evidence Link** field once a pull request or artifact URL exists. Before that, record the branch, the commits, and the test counts in the update log rather than linking a URL that does not resolve.

---

## Verification log for the current work

Recorded here because the commits are local and not yet pushed, so no commit URL resolves for a reviewer.

**Branch:** `feat/executive-runtime`

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | OK |
| `pnpm check` | 50 files, no fixes needed |
| `pnpm typecheck` | 5 of 5 packages |
| `pnpm test` | 8 of 8 tasks, 61 tests passing |
| `pnpm build` | 5 of 5 tasks; Mastra build successful |

**Runtime verification:** the built server was started with `node .mastra/output/index.mjs`. `/health` returned `{"success": true}`. `/api/agents`, `/api/agents/reasonate-cto`, `/api/memory/threads`, `/api/tools`, `/api/workflows`, `/api/logs`, `/api/observability`, `/api/openapi.json`, and `/swagger-ui` all returned `404` with body `Not Found`, and the response contained zero occurrences of the CTO system prompt.

**Integration verification:** PostgreSQL 16 and Redis 7 containers were started locally; `@reasonateai/project-state` ran its 15 tests against them rather than skipping.

---

## Not yet verified

Recorded here so it is not mistaken for done:

- No agent run has executed end to end; no live model provider is wired.
- No sandbox container has ever been provisioned; the workspace resolver is configured but never invoked.
- No product route exists, so principal resolution has not been exercised on a live request path.
- No SSE stream, preview, artifact, or deployment path has been exercised.
- No end-to-end browser test exists.
