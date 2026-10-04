# Workspace interactions and checkpoints

Branch: `codex/workspace-interactions-checkpoints`. Implementation is in progress until the authenticated browser and live controller scenarios below pass.

## Behavior

- The existing PromptInput and animated BorderBeam remain. The smaller composer has an inset project/file tray below, attached questions and queued text above, and stronger surface contrast. A low-specificity inherited control color no longer hides primary button labels.
- One primary control opens voice mode in a fresh empty chat, sends a draft or a text conversation, and stops an executing run. Controller cancellation confirmation removes the executing appearance while the worker saves its checkpoint; bounded status polling then reconciles the durable final state.
- Up to ten queued messages appear above the composer, with attachment thumbnails, edit/delete, side-chat, and queuing controls. The memory budget is 24 MiB; each submission still obeys the existing five-file/12 MiB intake limits. Follow-ups dispatch in order after success; Stop, failure, and cancellation pause dispatch. Active steering accepts text only. Queues remain local to the current mounted chat and are not persisted across reload.
- A row records its delivery type, original target run, and request key before sending. An uncertain steering or side-chat response stays on that endpoint when retried and never becomes an automatic follow-up. A successful command response consumes its row even when the subsequent history refresh fails.
- `POST /v1/build-sessions/:buildSessionId/runs/:runId/retry` accepts scoped query parameters and `Idempotency-Key`, with no body. Only failed/cancelled generations qualify; the new run reuses original prompt/file bytes internally, while history remains metadata-only. Replay returns the accepted result before reserving quota again; concurrent retries produce one new run. The queued event records `retryOfRunId`.
- Files render escaped syntax tokens with line numbers, wrap, and copy controls. Unknown formats use explicit plaintext; the source remains the authorized immutable checkpoint rather than a live filesystem editor.
- Voice mode records only after an explicit action, caps recording time/size, releases tracks, reviews transcription before sending, and uses the same scoped conversation. Available local browser speech is a fallback. Configured ASR and the separately developed TTS provider remain deployment requirements; this is not streaming voice.
- Preview chrome shows a logical app route; Files shows `/workspace/<file>`. Navigation stays within the assigned authorized preview proxy.
- Saved turns show actual changed files and added/removed lines. Expandable diffs come from that turn's private Git bundle, even after later turns change the workspace. Binary, oversized, legacy, and unavailable diffs are explicit. Cancelled/failed turns can still save partial work.

## Persistence and rollout

Apply the additive `RUN_STEERING_MIGRATION_SQL` through the existing separately observable `ProjectStateStore.migrate()` deployment step before starting updated workers. It adds `run_steering` and its indexes; existing rows are not reinterpreted. Build/deploy contracts, project state, API, worker, and web together so new package exports and routes are available.

Admission, idempotency, queue limits, and steering events are one PostgreSQL transaction. Only the scoped run lease owner claims and acknowledges messages. Delivery to Mastra uses an active-only user signal, with idle discard and a bounded acceptance wait. A takeover marks uncertain earlier delivery failed; it never repeats that signal automatically. The UI reports delivery acknowledgment, not a guarantee that the model followed the guidance.

Checkpoint summaries are optional version-1 terminal-event payloads. Existing historical events remain valid and display an unavailable summary. Diff reads verify membership, conversation/run/event provenance, bundle digest/commit, literal file confinement, and output bounds. Preview and voice retain the existing session, CSRF, and authorization boundaries.

For rollback, stop admitting new work and drain or cancel active runs with the updated worker first. Confirm pending steering is retired, then restore the previous application artifacts. Keep the additive table and durable events; old code can ignore them. Preserve bundles and their base references. Do not drop pending rows or rewrite historical checkpoint events as a recovery shortcut.

## Stream and worker recovery

The API sends an initial connection comment and ten-second SSE heartbeats. Comments have no event ID. A failed durable or live transport closes every follower so native EventSource reconnects from its last durable ID. Missed live deltas are replaced by retained snapshots; the durable ledger is the recovery authority. The web reconciles status sequentially every fifteen seconds while connected or five seconds while interrupted/stopping, with ten-second request timeouts.

`WORKER_MAX_CONCURRENT_RUNS` defaults to 2 and accepts 1–8 per worker. An unanswered question occupies one slot; another project can use the other. One active run per project remains enforced by PostgreSQL across the fleet, and admission quotas apply independently. At default sandbox caps, two executing sandboxes can consume two CPU cores and 4 GiB; size hosts and inference budgets before raising the limit. Discovery excludes occupied projects before applying its result limit.

`run.stream.opened/closed/failed`, browser `run.stream.connected/interrupted`, request failures, and reconciliation failures include correlation identifiers and safe reason codes. Worker cleanup/recovery logs carry run and scope identifiers. They omit prompts, attachment contents, cookies, provider headers, and raw environment values. Match the browser request ID with API diagnostics when reporting an outage. A development API rebuild can interrupt streams; reconnect should recover after the process becomes ready.

Reference behavior was checked against [Mastra signals](https://mastra.ai/docs/harness/signals), the installed Session reference, and local oh-my-pi steering/follow-up queues. The product uses the existing active-only user signal with idle discard rather than replacing durable commands with process-local queues. Heartbeat comments follow [MDN SSE guidance](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events).

## Recovery follow-up evidence — October 3, 2026

- Frozen installation passed with no dependency changes. The web suite passed 82 tests before the final three delivery-intent regressions; scoped queue tests now pass 14.
- Real PostgreSQL/Redis SSE tests passed 19; real HTTP steering returned 202 and replayed its key. Through the running Next proxy, a quiet stream lasted 40,024 ms with four heartbeats; abort/reconnect replayed the missed ledger event.
- Real PostgreSQL retry tests passed 16 API and 8 store checks, including source-file preservation, quota-exhausted replay, concurrent retries, and tenant denial. Worker suite passed 35 and scoped project scheduling suite passed 11 before the final uncheckpointed-edit recovery refinement.
- An independent read-only review identified ambiguous queue delivery, failure-pause loss, quota replay, and retained-workspace overwrite risks. The follow-up implements delivery binding, failure/cancellation pause, retry replay before quota reservation, and checkpointing retained edits before restoring project state. Final integrated regression evidence remains pending; the earlier gate results below do not verify this final snapshot.
- Final integrated gates and authenticated browser/live-model verification are still in progress. A test account signs in through the official callback; repeated development API rebuilds interrupted project creation, so final browser evidence will use a stable running artifact. TTS remains separately owned and unchanged.

## Local preservation — October 4, 2026

The user requested committing all local follow-up work for preservation and previously stopped extended verification. The follow-up is recorded on `codex/workspace-interactions-checkpoints` as work in progress, including regression tests and `/.context/evidence/recovery-queue.png`. The screenshot documents the queue layout while waiting for a worker; it is not evidence of successful model execution. Final integrated gates and authenticated acceptance remain pending. Reconcile the branch with current `main` and update draft PR #20 before release. The generated `apps/web/next-env.d.ts` development-path change is retained locally and in the recovery copy rather than included in the product change; TTS and user servers remain untouched.

## Main integration — October 4, 2026

Integrate `main` at `95f3227` into the published feature branch without rewriting its history. Preserve the preview repository/export/migration and API startup recovery from PR #25 together with steering/retry routes and project-aware scheduling. Retain the CI and volume reclamation from PRs #23/#24 and the shared sandbox path contract from PR #26. The phase-document conflict is resolved by keeping workspace acceptance in progress and recording PR #26 as merged with passing CI. The generated Next.js development-path file remains outside the commit. Verification results for this combined snapshot are recorded below as they become available; earlier snapshot results remain historical evidence.

- `pnpm check`: passed, 343 files.
- `pnpm typecheck`: passed, all ten workspace tasks.
- `pnpm --filter @reasonateai/web exec vitest run`: passed, 85 tests across twelve files.
- Focused CTO path/read/write/edit suite: passed, 93 tests across five files.
- `pnpm --filter @reasonateai/cto-runtime build`: passed. The first worker check found the old local build missing the newly merged workspace-path export; rebuilding resolved package loading.
- Worker config/scheduling check: six config tests passed; three database-backed scheduling tests were skipped locally because no test `DATABASE_URL` was supplied. The new recovery and store/API integration regressions must run against GitHub CI's private PostgreSQL/Redis/Docker services rather than user data.
- No product server, live project run, or TTS checkout was started or changed by verification. Full CI and authenticated acceptance remain pending.
- First combined CI run `37184400772`: dependency/secret scan, frozen installation, lint, type checking, and build passed; 16 of 17 test tasks passed. The API heartbeat test failed because its global fake-timer assertion included PostgreSQL timers. It now fakes only heartbeat intervals, retains the zero-heartbeat-timer assertion, and also verifies the cancelled reader has ended. All 19 SSE tests then passed against disposable PostgreSQL/Redis containers on private loopback ports; both test containers were removed. The corrected snapshot still requires full CI and signed-in acceptance.

## Verification evidence — October 3, 2026

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed; no dependency or lockfile changes |
| `pnpm check` | Passed, 323 files |
| `pnpm typecheck` | Passed, 10 workspace tasks; new composer test/config checked separately |
| `pnpm test` | Passed, 17 tasks and 633 tests, with real PostgreSQL, Redis, Docker, and Git |
| `pnpm --filter @reasonateai/web test` after final regressions | Passed, 9 files and 59 tests; five additional tests beyond the root run |
| `pnpm build` | Passed, 10 workspace tasks, including Next.js and the Mastra production artifact |
| `pnpm audit --prod --audit-level high` | Passed; one existing moderate `uuid@10` advisory through `@mastra/docker → dockerode`, GHSA-w5hq-g745-h8pq; no high/critical advisories |
| Built runtime smoke | Web `/` and API `/health` return 200; proxied unauthenticated session returns 401; worker starts with the configured runtime |
| Browser | Built sign-in surface reached; authenticated interaction verification pending |

The first full test run exposed the real Git suite's default five-second timeout under concurrent Windows processes. Its integration-test timeout is now thirty seconds; the full suite then passed. No assertion or security control was relaxed. The independent read-only review found a draft-clearing whitespace mismatch; it was fixed to preserve newer writing.

## Remaining acceptance checks

Use a signed-in development account and configured open-weight model. Verify fresh-chat waveform, draft/existing-chat Send, a single Stop control, cancellation during streaming and while awaiting a question, and the stopped sidebar indicator. Verify the top question card resumes the same run and its Continue label remains readable, including Settings primary labels. Verify queue edit/remove, active steering delivery, follow-up order, reload/replay, rejected steering, and worker takeover.

Verify attached tray contrast and Beam animation at desktop/mobile widths and reduced motion. Exercise dedicated voice open/close, denied microphone, transcription failure, reviewed submission, cancellation, and available speech playback. Verify preview navigation/path validation and per-turn checkpoint totals/diffs for edits, additions, deletions, failures, and cancellations after subsequent turns. Save screenshots and report provider limitations separately. Completion remains pending until these real surfaces are exercised.
