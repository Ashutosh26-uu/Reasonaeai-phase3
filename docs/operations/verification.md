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
| `pnpm check` | clean |
| `pnpm typecheck` | 10 of 10 tasks |
| `pnpm test` | all suites; `@reasonateai/project-state` 54, `@reasonateai/worker` 21, `@reasonateai/api` 78 |
| `pnpm build` | all packages plus the Mastra artifact |

**Migration verification:** against a freshly created database, `store.migrate()` created all 18 control-plane tables, the `mastra` schema with its threads and messages tables, the `runs.message` column, and the one-active-run index. A second `migrate()` while another session held an `access exclusive` lock on `runs` completed in 19ms, which is what proves an already-current migration takes no lock.

**Conversation verification, through the running API with real PostgreSQL and Redis:** 27 checks passed over HTTP with real session and CSRF cookies — sign-in, organization and project creation, conversation allocation carrying the opening message, the conversation listing naming the run to follow, an empty transcript before any turn finished, a second turn refused with `409` while one was in flight, the accepted turn queued at sequence 1 with its message offered to the worker, history read back in order with both roles and the stored title, a working conversation refusing to close, closing it and allocating a second conversation rather than adopting the closed one, an authenticated principal with no membership refused on both read and write, and `/api/agents`, `/api/agent-controllers`, `/api/memory/threads` still answering `404`.

**Durability verification:** after the API process was replaced by a fresh process running the built artifact, the same session cookie read the same transcript and both conversations, so the history is the database's, not one process's memory.

---

## Not yet verified

Recorded here so it is not mistaken for done:

- No live agent turn has executed: this environment holds no model credential, so the worker has never driven a real CTO run. The conversation write path was therefore exercised through the same storage adapter the API reads, not through a model.
- No preview, deployment, or artifact-spill path has been exercised.
- No end-to-end browser test exists; the web shell is not built.
