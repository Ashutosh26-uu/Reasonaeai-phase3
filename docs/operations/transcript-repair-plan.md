# Transcript and chat UI repair plan

Status: implementation complete locally; fresh authenticated read-only run and reload verified. Reconnect replay and adverse-path verification remain in progress. Recorded 2026-09-29.

## Required result

A conversation preserves the actual sequence of user messages, assistant text segments, tool activity, and final responses during streaming, after completion, after reconnect, and after reopening any turn. Consecutive tools may share a collapsible group, but a group must never cross an assistant text boundary. Ordinary assistant prose stays visible; only explicit reasoning is presented as reasoning.

User clarification, 2026-09-29: missing model thinking is part of this repair. Use the official Vercel AI Elements components for reasoning and tool presentation; the existing custom “Thought” disclosure is not the accepted implementation.

For the reported example, render:

1. User request.
2. “Let me check the workspace.”
3. The listing, reads, and commands, grouped only where consecutive in the source.
4. “Yes — reading works fine…” and its evidence/report.

Do not guess boundaries from punctuation or classify the final response by its position in a flattened string.

## Investigation and evidence

- The authenticated local UI at `http://localhost:3219` reproduces the defect in the existing “build a small todo in pure html” conversation: several narrations and the final report are concatenated, followed by one “Worked for 3m 35s” group containing 12 calls. This was a read-only inspection; no new model run was submitted.
- A read-only Node reproduction using the actual `messageText` and timeline reducers produced `Let me check the workspace.Yes — reading works fine.`, assigned that combined message the same position as the first work group, duplicated a tool when the same event was applied twice, and retained only the new run's tools after a run switch.
- Baseline verification: `pnpm --filter @reasonateai/web test` passed (2 files, 9 tests). These tests do not cover the active timeline/transcript ordering path. `git diff --check` passed for the documentation update. No implementation or full repository gate run is claimed.
- The installed Mastra controller preserves ordered `content.parts` and inserts `tool-invocation` parts with call IDs. Its message rotation depends on stream metadata; one message cannot be assumed to equal one uninterrupted piece of prose. Its type contract explicitly warns that streamed events share a mutable message object that consumers must snapshot before asynchronous retention.

### Confirmed causes

| Location | Defect and consequence |
| --- | --- |
| `packages/cto-runtime/src/message-parts.ts` | `messageText` concatenates every text part without separators and drops intervening tool/step parts. Both durable and live mappers use it, so ordering information is lost before rendering. Adding whitespace would only disguise the loss. |
| `packages/cto-runtime/src/run-events.ts` | Only `message_end` text is persisted. No ordered text segments or their tool anchors survive in the ledger; suspended or interrupted text can disappear before this event. |
| Reasoning pipeline and component inventory | The installed Mastra `MessagePartSpans` writes reasoning into ordered `content.parts` entries (`type: "reasoning"`, with `reasoning` and text details). The durable mapper instead reads `content.reasoning`, and exits early for messages with no prose. The live mapper extracts only text; the wire contract has no reasoning segment/delta. The web app has only AI Elements `message.tsx` and `conversation.tsx`; reasoning currently uses a custom `<details>` element. Thus adding a component alone cannot restore missing reasoning. |
| `apps/web/components/chat/timeline.ts` | `stepStart` places the entire completed message at the first work it encountered. A combined narration/report is consequently moved in front of its tools. `recordMessage` removes the live entry without preserving its boundary; replay can keep adding calls to the same open group across messages. |
| `apps/web/components/chat/transcript.tsx` | Messages and tool groups are independently built, then sorted by timestamps. A tie always favors a message, placing the combined answer before its work. The comparator also returns a nonzero result for equal-time items of the same kind. Ledger sequence is not used. |
| `apps/web/components/chat/use-run-stream.ts` and `timeline.ts` | Live text has one entry per message ID, so later text updates the original entry even after tools arrive. Its placement uses browser `Date.now()`. A new EventSource replays into existing state without durable-event deduplication; the reducer demonstrably duplicates calls. |
| `packages/project-state/src/postgres.ts`, API event route, and timeline reducer | Message history spans all conversation runs, but SSE reads only `buildSession.runId`, and the reducer discards previous entries when the run changes. Earlier turns therefore lose their tool history. The message contract also omits run and ledger-order information needed to correlate turns. |
| `apps/web/components/chat/activity.tsx` and `timeline.ts` | Ordinary streamed text is called “Thinking.” The `read` tool's `target` argument is missing from the detail selector. Results are irreversibly reduced to short one-line previews in the UI projection. Duration uses child start times rather than completion times. Disclosure buttons lack expanded-state attributes. |
| `transcript.tsx` and `components/workspace/workspace.tsx` | Retry calls `sendTurn` with the assistant answer instead of the originating user request. |

Additional implementation hazards: the worker queues a mutable controller event for later mapping; snapshot selected display data synchronously before adding segment persistence. Live and durable channels travel independently, and the API explicitly lets live frames overtake ledger delivery. Snapshot/history requests also replace message state without guarding against stale conversation responses. These require controlled regression scenarios; their exact contribution to the reported completed conversation has not been established.

Current tests exercise the older `run-activity.ts` reducer, not the timeline/transcript used by the workspace. Live mapper tests explicitly expect text across step boundaries to append to one string. Passing those tests cannot establish correct transcript ordering.

## Implementation sequence

### 1. Preserve the source structure at the runtime boundary

- Introduce versioned, validated display segments in `packages/contracts`: text, explicit reasoning, and tool references, with run ID, source message ID, stable segment identity/order, and tool-call correlation. Keep tool lifecycle/results in their existing authorized events.
- Normalize the installed controller's ordered parts synchronously at subscription time. Preserve text span boundaries and tool references; support both one-message-per-step and multiple-steps-per-message emission.
- Normalize reasoning from the actual installed Mastra part shape, not an assumed AI SDK `text` field or message-level `content.reasoning`. Preserve reasoning-only messages. Carry reasoning segment identity, streamed content, completion state, and measured duration through the same durable/live/history projection. Empty compatibility parts from `deepseekReasoningEcho` must not create empty thinking panels; redacted reasoning and opaque signatures must not be displayed as text.
- Persist segment boundaries and finalized text as work progresses, including before suspension/failure/cancellation. Use bounded periodic snapshots for an open segment if needed for interruption recovery, not a full ledger row per token. Flush the final snapshot before outcome/teardown.
- Keep live text ephemeral, but address it to the same segment identity with a revision and durable anchor. Buffer an early delta until its anchor arrives; reject stale revisions and deltas for finalized segments. Live revisions must not advance SSE ledger cursors.
- Persist immutable normalized payloads before asynchronous queueing. Preserve append order and report persistence failure as a run failure/recoverable condition rather than silently dropping required transcript data.

### 2. Supply complete, scoped conversation history

- Extend the history projection to include each run's ordered display segments, tool activity, status, and user-turn association. Page bounded history and expose a per-run replay watermark so initial history and SSE can reconcile without a race.
- Use durable run/turn order, ledger sequence, and source-part order; use timestamps only for display and measured durations. Never compare sequences from different runs as a global counter.
- Continue tailing the active run while retaining earlier runs. Make replay idempotent by `(runId, eventId/sequence)` and make live-to-durable replacement an in-place update of the same segment.
- Preserve organization/project authorization in queries and stream subscriptions. Cancel or ignore stale history responses when the selected conversation changes.

### 3. Render one ordered transcript

- Replace the separately sorted message list and outline with one shared projection for history and live updates. Remove `stepStart`, synthetic browser-time ordering, and duplicate message ownership.
- Render text where its source segment belongs. Form work groups only from adjacent tool entries; close a group at every visible text boundary. Tool completion updates the existing row without moving it.
- Render streamed narration as normal Markdown, with a streaming indicator. Render each explicit reasoning segment in its recorded position with the official AI Elements `Reasoning`, `ReasoningTrigger`, and `ReasoningContent`. Bind `isStreaming` to that segment's state, not the whole run; preserve manual toggling and restore completed reasoning on reload with its recorded duration.
- Preserve all prior turns and keep final answers outside tool disclosures. Scope React keys by run and segment/call identity.

#### Required Vercel AI Elements composition

| Transcript content | Component selection |
| --- | --- |
| Conversation container and scroll control | Existing `Conversation`, `ConversationContent`, and `ConversationScrollButton` |
| User and assistant prose | Existing `Message`, `MessageContent`, and `MessageResponse` |
| Explicit model reasoning | Add official `Reasoning`, `ReasoningTrigger`, and `ReasoningContent` |
| Tool calls and results | Add official `Tool`, `ToolHeader`, `ToolContent`, `ToolInput`, and `ToolOutput`; map verified lifecycle state to the component's supported states |
| Copy and retry controls | Existing `MessageActions` and `MessageAction`, with the corrected application callbacks |

Use official registry source with imports adapted to the existing `@reasonateai/ui` shadcn primitives and theme. Inspect the generated changes and evaluate any new transitive dependencies under repository dependency rules. Remove the replaced custom reasoning/tool markup and obsolete CSS. AI Elements is the presentation layer; retain the authenticated product API, Mastra runtime, and authorized SSE transport.

The official reasoning example combines all reasoning parts above the answer. Do not copy that grouping rule: this application needs reasoning → text → tools → reasoning → text to remain interleaved. Merge only adjacent fragments of the same reasoning segment. `ChainOfThought` is for explicitly structured step presentations and is not a replacement for the model's streamed reasoning or an excuse to move every tool into one group.

Primary documentation checked 2026-09-29: [Reasoning](https://elements.ai-sdk.dev/components/reasoning), [Tool](https://elements.ai-sdk.dev/components/tool), [Message](https://elements.ai-sdk.dev/components/message), and [Chain of Thought](https://elements.ai-sdk.dev/components/chain-of-thought). Their examples are component guidance, not authorization to replace the product backend or use prohibited model providers.

### 4. Repair the affected chat controls and tool presentation

- Show readable tool label and actual target/command; expose expandable, bounded input/output detail without destroying the source text. Preserve any existing authorized artifact references and make actual source truncation explicit.
- Store start and finish times for accurate duration; distinguish running, failed, denied, cancelled, and waiting states. Define disclosure defaults without overriding a user's toggle; add `aria-expanded` and `aria-controls`.
- Retry the associated user request as a clearly linked new attempt, retaining the previous attempt. Do not silently resend assistant output. Show copy failures accessibly instead of swallowing them.
- Verify spacing, long commands, code/Markdown wrapping, keyboard controls, narrow layouts, scroll anchoring, and reduced motion. Do not broaden this into an unrelated shell/composer redesign.

### 5. Handle existing history and deployment honestly

- Old ledger text has already lost boundaries. Inspect whether the correctly scoped Mastra thread still contains original ordered parts before promising recovery of existing conversations.
- If original parts exist, create an explicit, idempotent versioned repair/projection with provenance. Do not rewrite historical events or invent source ordering. If unavailable, retain the legacy text and identify that detailed interleaving is unavailable for that turn.
- Add the new reader before enabling the writer. Keep versioned legacy reading during rollout; document rollback compatibility and recovery for any new persistence/index change. No dependency upgrade is currently required by this plan.
- Correct `.context/SPEC.md`, `.context/PHASE.md`, API documentation, and verification notes in the implementation change. Keep the historical `.context/PLAN.md` unchanged.

## Verification and acceptance

First add regressions that fail against the current behavior:

- Exact reported sequence: text → several tools/results → final text, all within one source message, without inserted spaces in the fixture.
- Multiple alternating text/tool segments; tool-only messages; text-only answers; distinct messages; parallel tool calls finishing out of order; repeated tool names and stable IDs.
- Live rendering, completed rendering, reconnect replay, and reload produce the same ordered segment identities and text. Duplicate delivery is harmless; equal timestamps and delayed live frames do not reorder content.
- Two or more turns retain their own tools; rapid conversation switching and late history responses cannot mix content or overwrite newer state.
- Suspension, failure, and cancellation preserve emitted text and show the correct status; finalization removes live indicators without deleting text.
- Retry uses the originating user request; long tool details remain inspectable; reasoning is never inferred from ordinary prose.
- Reasoning → narration → tools → reasoning → answer keeps that exact order live and on replay. Reasoning-only output survives persistence; empty compatibility parts produce no panel; redacted/opaque parts expose no hidden content; finished reasoning stops its streaming indicator while later tools are still running. Exercise keyboard disclosure controls and Markdown rendering in the actual AI Elements components.
- Tenant-denial tests cover expanded history and replay paths. Payload limits and bounded buffering are tested.

Exercise the running API, real PostgreSQL/Redis, worker/controller, and authenticated browser with an allowed open-weight model. Verify the exact sequence in the browser during streaming, after completion, after a network reconnect, after reload, and after a follow-up turn. Use deterministic adapter fixtures for adverse delivery scenarios, but do not substitute them for the real runtime journey. Record screenshots and exact verification results.

Run frozen installation, `pnpm check`, `pnpm typecheck`, `pnpm test`, `pnpm build`, affected smoke/end-to-end checks, and affected dependency/secret/static security checks. Record any pre-existing failures separately. A passing typecheck or a screenshot of one finished turn does not meet acceptance.

## Related lifecycle boundary

The already recorded `ask_user` suspension/resume defect is separate from ordering but affects text durability and truthful status. Segment persistence must work when a run parks. End-to-end approval/cancellation acceptance remains blocked until the worker distinguishes suspension from completion and implements the authenticated answer/resume/cancel paths described in `PHASE.md`; do not claim these states are fixed through presentation changes alone. Sandbox edit paths, preview persistence, and plan quotas remain separate tracked defects.
