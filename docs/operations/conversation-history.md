# Conversation history controls

This change is on `codex/chat-history-controls`, based on main after PR #29 merged as `e8c3c92`. It adds saved assistant Copy/feedback/Branch controls and user-only Retry/Edit-and-resend. Spectra's local TUI is the behavioral reference; its local session truncation and filesystem reversal are adapted to our authenticated, tenant-scoped server and private worker.

## Behavior and boundaries

Retrying request six of ten retains requests one through five, restores the checkpoint before six, queues a replacement sixth request, and excludes the superseded sixth through tenth runs from active conversation history. Editing uses the same operation with replacement text and original attachments. Runs, ledger events, and immutable bundles are preserved for audit/recovery. The source pointer and active history change together under the project lock; the worker restores that source before execution and records a fresh starting boundary. Failure to verify the stored bundle aborts the history transaction and refunds reserved usage.

Branching through a completed answer copies active history through that turn into a new conversation, with a distinct thread/resource and sandbox identity. The source pointer selects that turn's final checkpoint. Future writes publish only to their owning conversation. Source reads and new previews follow the selected conversation; changing the source retires an adopted preview when the panel starts the replacement. Inherited checkpoint diffs require active membership rather than original run ownership. Feedback belongs to the authenticated user and selected conversation; it persists across reload and can be cleared.

Both history actions reject project-wide queued, running, approval-waiting, or live-leased work. Retry requires both agent execution and checkpoint restore permissions and normal quota/rate admission. An idempotency key is bound to its action, source turn, and replacement text. Replays succeed without consuming another quota slot, even after the source leaves active history. Superseded turns cannot be retried with a fresh key or used for checkpoint details.

Workers renew leases from workspace preparation through source publication and settlement. Publication checks the owning current run and live lease in PostgreSQL; a stale worker cannot replace the conversation head. Failed source preparation preserves the volume and selected pointer. Before restoring over retained edits, the worker saves a separate immutable recovery checkpoint.

Retained context imports canonical saved messages, original attachments, delivered steering, and persisted question/plan answers into a fresh Mastra PostgreSQL thread. Imports are idempotent and bounded to 32 MB; over-limit imports fail visibly without silently dropping messages. Version 7 records ordinary question answers durably when accepted. Older cleared question answers cannot be recovered from the historical ledger. Older turns without a recorded starting boundary or measured checkpoint base are refused without altering active history/source.

## Migration and recovery

Schema version 7 adds `conversation_history`, `conversation_heads`, `run_workspace_boundaries`, `conversation_history_commands`, and `conversation_feedback`. Initial backfill includes existing runs in chronological order. A head row marks the conversation as migrated, so subsequent migrations never reintroduce superseded runs. No existing ledger payload is reinterpreted.

Drain/stop version 6 workers and coordinate the API/worker upgrade before enabling history actions: version 6 writers do not maintain active membership or conversation heads. Keep all new tables and immutable bundles. After a history action, rollback to a version 6 reader/worker is unsafe because it would resurrect superseded history or restore the project's unrelated latest checkpoint. Recover with a compatible version 7 artifact or forward fix. PostgreSQL backup plus tenant checkpoint storage is the recovery authority; Redis and mutable volumes are not the sole record.

No new dependency, provider credentials, hosted-model call, or deployment is introduced. All changed workspace packages/apps are private; no package publication or product release tag is performed.

## Verification status

- Frozen-lockfile installation passed.
- Seven API regressions passed against real PostgreSQL 16, Redis 7, and Git bundles, including ten-to-six rewind, branch isolation, inherited diffs, editing, unverified boundary refusal, permission/validation denial, private feedback, quota replay, migration replay, and expired-lease publication denial.
- Retained context passed against actual Mastra PostgreSQL memory, checking the five-turn prefix, image, delivered steering, saved question answer, import replay, and resource isolation.
- `pnpm check` passed 403 files; `pnpm typecheck` passed all ten tasks. `pnpm build` passed all ten tasks; the final API packaging build and worker build also passed after the final changes.
- `pnpm test` passed all 17 tasks with 905 tests against a fresh disposable PostgreSQL database and Redis. The default Windows run skipped 26 shell-dependent checks; all 10 sandbox checkpoint tests and all 22 API checkpoint-diff/restore tests then passed with the installed Git shell on PATH. Together these runs cover 931 distinct tests, including all 47 worker tests.
- The restore concurrency regression now verifies that turn admission waits for the restoration lock, and a worker can claim the queued turn afterwards. Retained-memory regressions cover attachment-only requests as well as text with images. Review identified and fixed inherited-diff authorization, lease fencing, durable question answers, and attachment-only context retention.
- The user requested stopping our development servers, and we stopped them. Fresh browser acceptance, built-API smoke, and CI scans remain pending; no servers were restarted by this task. This feature remains in progress and is not ready to merge under the repository Definition of Done.
