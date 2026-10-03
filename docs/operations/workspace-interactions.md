# Workspace interactions and checkpoints

Branch: `codex/workspace-interactions-checkpoints`. Implementation is in progress until the authenticated browser and live controller scenarios below pass.

## Behavior

- The existing PromptInput and animated BorderBeam remain. The smaller composer has an inset project/file tray below, attached questions and queued text above, and stronger surface contrast. A low-specificity inherited control color no longer hides primary button labels.
- One primary control opens voice mode in a fresh empty chat, sends a draft or a text conversation, and stops an executing run. Controller cancellation confirmation removes the executing appearance while the worker saves its checkpoint; bounded status polling then reconciles the durable final state.
- Queued text sends as a subsequent turn when the active run finishes. Steer requests delivery to the existing run instead. Attachments remain in the draft during execution; this first steering contract accepts text only.
- Voice mode records only after an explicit action, caps recording time/size, releases tracks, reviews transcription before sending, and uses the same scoped conversation. Available local browser speech is a fallback. Configured ASR and the separately developed TTS provider remain deployment requirements; this is not streaming voice.
- Preview chrome shows a logical app route; Files shows `/workspace/<file>`. Navigation stays within the assigned authorized preview proxy.
- Saved turns show actual changed files and added/removed lines. Expandable diffs come from that turn's private Git bundle, even after later turns change the workspace. Binary, oversized, legacy, and unavailable diffs are explicit. Cancelled/failed turns can still save partial work.

## Persistence and rollout

Apply the additive `RUN_STEERING_MIGRATION_SQL` through the existing separately observable `ProjectStateStore.migrate()` deployment step before starting updated workers. It adds `run_steering` and its indexes; existing rows are not reinterpreted. Build/deploy contracts, project state, API, worker, and web together so new package exports and routes are available.

Admission, idempotency, queue limits, and steering events are one PostgreSQL transaction. Only the scoped run lease owner claims and acknowledges messages. Delivery to Mastra uses an active-only user signal, with idle discard and a bounded acceptance wait. A takeover marks uncertain earlier delivery failed; it never repeats that signal automatically. The UI reports delivery acknowledgment, not a guarantee that the model followed the guidance.

Checkpoint summaries are optional version-1 terminal-event payloads. Existing historical events remain valid and display an unavailable summary. Diff reads verify membership, conversation/run/event provenance, bundle digest/commit, literal file confinement, and output bounds. Preview and voice retain the existing session, CSRF, and authorization boundaries.

For rollback, stop admitting new work and drain or cancel active runs with the updated worker first. Confirm pending steering is retired, then restore the previous application artifacts. Keep the additive table and durable events; old code can ignore them. Preserve bundles and their base references. Do not drop pending rows or rewrite historical checkpoint events as a recovery shortcut.

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
