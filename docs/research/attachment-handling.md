# Attachment handling: Oh My Pi and ReasonateAI

Research date: October 15, 2026.

## Authorized follow-up and implementation

After the initial investigation below, the user approved the newer flow and requested updating both existing reference repositories. Both were fast-forward pulled on October 15: `reference-projects/oh-my-pi` to `df16eb991d78f86705f5fb5e53f1f3f80e261740`, and `reference-projects/oh-my-pi-src` to `c0713894879e89eae049fa0ee4f15f616b5a0edd`. The existing untracked `findings/` directory was preserved. Comparing the traced attachment intake, session, local/attachment protocols, compaction, queue, artifacts, document conversion and vision-fallback files against research commit `6631c464` found only reader changes: terminal-newline/range behavior and clearer SVG rasterization guidance. The attachment lifecycle conclusions remain applicable. Neither reference project's runtime was installed or executed.

The user explicitly clarified that PostgreSQL encoded originals must remain alongside private files. The implementation on `codex/durable-chat-attachments` follows that decision. Stable references use `attachment://<source-run-uuid>/<file-index>` and scoped sandbox paths, derived from retained PostgreSQL conversation membership. Older files load on demand; current files are restored before execution. This avoids copying every prior binary payload into model memory or restoring an unbounded conversation's files at startup.

The implementation reuses existing turn ownership instead of adding a separate upload database table or migration. File preservation follows durable acceptance; authorized access can also reconstruct private files from existing JSONB originals. The browser uses cookie-authorized, uncached product routes rather than expiring object tokens. PDF and Office text extraction are local; images return real media parts. This does not implement Oh My Pi's optional separate vision-question provider, OCR, EPUB/video/SQLite converters, converter caches, or all its CLI/session-management features.

The remaining sections preserve the **initial research and proposed design**, including the July versions before pulling and the ReasonateAI baseline before implementation. They are not a statement that the application still has that baseline behavior, nor a claim every proposal below was adopted. Baseline local line links may shift as the implementation changes; commit-pinned upstream links remain the research evidence. Current behavior, verification, deployment recovery and limitations are recorded in [the operational record](../operations/conversation-attachments.md).

## Local-reference correction

The initial report below reviewed a new upstream checkout, not the user's existing home-directory reference repositories. Following the user's clarification, both local copies were located and their attachment entry points were inspected:

| Local copy | Commit | Commit date |
|---|---|---|
| `C:/Users/wwwmo/reference-projects/oh-my-pi` | `d0c1890a6c0809507d534840f0e31a6b31a76619` (v16.3.4) | July 3, 2026 |
| `C:/Users/wwwmo/reference-projects/oh-my-pi-src` | `39c95e5e29b1c8b082059f57421ce445c3dffdd4` | July 19, 2026 |

These are older implementations. Do not attribute every behavior described in the upstream sections to the local copies. The local checks establish these material differences:

- Both local versions already save large text through the selected file option, using `local://attachment-N` rather than the newer `local://paste-N.md` naming.
- Local image intake materializes normalized, optionally resized image data through `putBlob` for image links. It does not have the newer clipboard-original `#persistPastedImage` plus hidden image-source-notice flow described below. Therefore original-resolution preservation before automatic resizing must not be assumed for these local intake paths.
- Their `getImageAttachments()` returns the latest image-bearing user/developer message's image payloads and numbered aliases, without the newer `sourcePath` field.
- They provide a separate `inspect_image` tool for vision questions; the local `read` implementation can direct analysis there. The newer upstream's unified `?q=` interface is not the interface in these inspected local versions.
- Both already externalize larger image payloads into blobs during session persistence. The distinction between saved binary data and a durable agent-discoverable file reference still applies.

Local evidence: [July 3 image preparation](C:/Users/wwwmo/reference-projects/oh-my-pi/packages/coding-agent/src/modes/controllers/input-controller.ts:1302), [July 3 large-paste files](C:/Users/wwwmo/reference-projects/oh-my-pi/packages/coding-agent/src/modes/controllers/input-controller.ts:1601), [July 3 attachment aliases](C:/Users/wwwmo/reference-projects/oh-my-pi/packages/coding-agent/src/session/agent-session.ts:6571), [July 19 large-paste files](C:/Users/wwwmo/reference-projects/oh-my-pi-src/packages/coding-agent/src/modes/controllers/input-controller.ts:1705), and [July 19 image inspection](C:/Users/wwwmo/reference-projects/oh-my-pi-src/packages/coding-agent/src/tools/inspect-image.ts:180).

This addendum is a targeted local-version comparison, not a claim that the entire upstream investigation has been repeated against both local copies. Neither local checkout was fetched, reset, or modified; the existing untracked `findings/` directory in `oh-my-pi` was preserved.

## Outcome

ReasonateAI needs one end-to-end attachment lifecycle: preserve the original file, give the agent a stable readable reference, retain its association with the conversation, and render an authorized preview. A thumbnail change alone cannot solve later rereading. Saving files alone cannot solve it either: the production workspace reader currently reads text and does not return image pixels or convert documents.

The supplied screenshot establishes the requested presentation: a right-aligned image thumbnail above and outside the user's rounded text bubble. Its embedded conversation text was treated as image content, not an instruction to research that conversation's subject.

This is source research and an implementation recommendation. No application changes, dependency installations, model calls, or runtime acceptance tests were performed. Existing tests were inspected, not executed. The pre-existing change to `apps/web/next-env.d.ts` was left untouched.

## Research boundary and evidence

Reviewed Oh My Pi's public upstream `can1357/oh-my-pi`, pinned to [6631c46470974abf1fc21e4ef784f2bbceb80b60](https://github.com/can1357/oh-my-pi/tree/6631c46470974abf1fc21e4ef784f2bbceb80b60), dated October 15, 2026. Traced input, composer atoms, image preparation, source notices, queues, provider adaptation, session persistence, blob storage, local and attachment protocols, format reading, compaction serialization, history recovery, session copying, output artifacts, and relevant regression tests. This does not claim an exhaustive audit of unrelated debugger, provider, browser, or collaboration features.

Compared ReasonateAI at local HEAD `2da0ca7`, including its canonical specification and phase records, composer, contracts, API intake, PostgreSQL persistence, worker delivery, retained-memory reconstruction, production reader wiring, and artifact facilities.

## 1. What ReasonateAI actually does today

| Stage | Existing behavior | Consequence |
|---|---|---|
| Composer | File selection, file paste/drop, removal, and draft previews; five files, 4 MiB each, 12 MiB combined | Intake is bounded, but attachments remain encoded payloads |
| Request | `{ filename, mediaType, data: data-URL }` travels with a turn | No durable attachment identity or readable file reference |
| Persistence | Full attachment payloads are stored in `runs.user_attachments` JSONB | Bytes survive a saved turn; this is not filesystem materialization |
| Worker | Calls Mastra `sendMessage({ content, files })` | Original submission can reach the provider adapter; no attachment file is created by this handoff |
| History | Returns filename, media type, and size | No authorized preview/download reference reaches the saved message renderer |
| Transcript | Reuses compact composer chips inside the text bubble | Images become icon/name chips rather than the screenshot's thumbnail layout |
| Retained memory | Reconstructs original attachments using `experimental_attachments`; bounded to 32 MiB | Recovery support exists, but repeats payloads and supplies no stable read target |
| Paste | Clipboard handler intercepts files only | Large plain text stays in the textarea; normal turn schemas cap text at 20,000 characters |
| Live `read` | Reads scoped workspace files as UTF-8 and checks for text | Merely placing a PNG/PDF on disk will not make it visually/document readable |

Evidence: [attachment contracts](C:/Users/wwwmo/Development/Interships/Reasonaeai-phase3/packages/contracts/src/execution.ts:104), [composer intake](C:/Users/wwwmo/Development/Interships/Reasonaeai-phase3/apps/web/components/chat/composer.tsx:412), [paste handler](C:/Users/wwwmo/Development/Interships/Reasonaeai-phase3/apps/web/components/ai-elements/prompt-input.tsx:1014), [JSONB persistence](C:/Users/wwwmo/Development/Interships/Reasonaeai-phase3/packages/project-state/src/schema.ts:66), [history projection](C:/Users/wwwmo/Development/Interships/Reasonaeai-phase3/packages/project-state/src/postgres.ts:1326), [worker handoff](C:/Users/wwwmo/Development/Interships/Reasonaeai-phase3/apps/worker/src/executor.ts:731), [retained-memory import](C:/Users/wwwmo/Development/Interships/Reasonaeai-phase3/apps/worker/src/runtime.ts:257), and [transcript placement](C:/Users/wwwmo/Development/Interships/Reasonaeai-phase3/apps/web/components/chat/transcript.tsx:500).

The important distinction is **persisted bytes versus agent recoverability**. It would be inaccurate to say attachments are never saved today. They are saved, but the agent cannot later ask the existing `read` tool for an attachment by durable identity.

There is also a reader integration gap. [Production runtime composition](C:/Users/wwwmo/Development/Interships/Reasonaeai-phase3/packages/cto-runtime/src/runtime.ts:208) uses `createWorkspaceReadTool`, whose [file path](C:/Users/wwwmo/Development/Interships/Reasonaeai-phase3/packages/cto-runtime/src/tools/workspace-read.ts:188) reads UTF-8. A separate generic reader/registry exists, but its [image reader](C:/Users/wwwmo/Development/Interships/Reasonaeai-phase3/packages/cto-runtime/src/tools/readers/image.ts:1) reports headers and dimensions only. Its [registry](C:/Users/wwwmo/Development/Interships/Reasonaeai-phase3/packages/cto-runtime/src/tools/readers/registry.ts:1) explicitly documents that Office files are archive listings, not converted document content. These pieces are not evidence that production already supports Oh My Pi's multimodal rereading.

## 2. Oh My Pi's image lifecycle

### Intake and original preservation

The input controller normalizes images into a provider-supported format and may resize the model-facing image. It separately preserves a usable source:

- A pasted/dropped filesystem image keeps its original path.
- A clipboard bitmap is written under the session's `local://` root, using a content-derived filename such as `local://pasted-image-<hash>.png`.
- The clipboard write uses the supplied image before the controller's automatic resizing, so the readable source and the model preview have distinct purposes.
- Source metadata is carried on the image object during input processing.

Source: [image preparation and persistence](https://github.com/can1357/oh-my-pi/blob/6631c46470974abf1fc21e4ef784f2bbceb80b60/packages/coding-agent/src/modes/controllers/input-controller.ts#L2094).

### Model-visible reference, separate from visible UI

On submission, `AgentSession` emits a hidden companion message identifying the image number and source path. The visible user message keeps the image and its marker; the agent receives an explanation of how to inspect/copy/read the file. The notice also has structured `{ index, path }` details.

This is a valuable design pattern: the user does not need an internal filesystem path printed in the bubble, while the agent does need an exact machine-readable reference. Source notices are also formatted into concise history with the full path, so transcript readers can recover them.

Sources: [notice creation](https://github.com/can1357/oh-my-pi/blob/6631c46470974abf1fc21e4ef784f2bbceb80b60/packages/coding-agent/src/session/agent-session.ts#L7228), [notice renderer](https://github.com/can1357/oh-my-pi/blob/6631c46470974abf1fc21e4ef784f2bbceb80b60/packages/coding-agent/src/session/attachment-source-notice.ts), [history formatting](https://github.com/can1357/oh-my-pi/blob/6631c46470974abf1fc21e4ef784f2bbceb80b60/packages/coding-agent/src/session/session-history-format.ts#L435).

### Durable binary storage

There are two related mechanisms, not one:

1. Session-local files provide convenient readable sources and scratch artifacts.
2. A SHA-256 content-addressed blob store externalizes image payloads from session JSONL records. Binary data is stored separately and records contain `blob:sha256:...` references; loading resolves those references again.

The persistence threshold is 1,024 base64 characters; tiny image payloads can remain inline. The blob store deduplicates content, stages writes before publication, and can create extension-bearing hardlinks/copies for OS viewers. Garbage collection tracks references and uses a write grace period to avoid collecting a newly reused blob before its journal reference lands.

Sources: [blob store](https://github.com/can1357/oh-my-pi/blob/6631c46470974abf1fc21e4ef784f2bbceb80b60/packages/coding-agent/src/session/blob-store.ts), [session persistence](https://github.com/can1357/oh-my-pi/blob/6631c46470974abf1fc21e4ef784f2bbceb80b60/packages/coding-agent/src/session/session-persistence.ts), [garbage collection](https://github.com/can1357/oh-my-pi/blob/6631c46470974abf1fc21e4ef784f2bbceb80b60/packages/coding-agent/src/cli/gc-cli.ts).

### `attachment://` is a convenience alias

`attachment://1` locates an image's backing file. If an image has no file source, Oh My Pi can materialize a blob copy. Crucially, the catalog is built from the newest image-bearing user/developer message or image-bearing `ask` result in the active message context. It is not a permanent conversation-wide attachment identifier. Earlier images should be recovered through their stable source reference/history, not an assumption that `attachment://1` always means the first image ever uploaded.

Sources: [attachment catalog](https://github.com/can1357/oh-my-pi/blob/6631c46470974abf1fc21e4ef784f2bbceb80b60/packages/coding-agent/src/session/session-provider-boundary.ts#L61), [protocol handler](https://github.com/can1357/oh-my-pi/blob/6631c46470974abf1fc21e4ef784f2bbceb80b60/packages/coding-agent/src/internal-urls/attachment-protocol.ts).

## 3. Large pasted text: the important distinction

Oh My Pi offers three behaviors once a paste reaches its configurable menu threshold, which defaults to 100 lines:

| Behavior | What the user sees | What the model receives |
|---|---|---|
| Inline paste chip | Compact chip | Expanded original text at submission |
| Wrapped attachment chip | Compact chip | Expanded text inside an attachment block |
| Attach as local file | File reference | `local://paste-N.md`, readable on demand |

The first two reduce composer clutter but do not inherently reduce model context or create a durable text file. The third writes the text and inserts its URI. It avoids existing filenames; a write failure keeps the text as a chip and exposes the failure. Cancellation of the menu also preserves the content. Paste bursts containing Enter have special handling so the menu cannot swallow submission.

Your requested automatic conversion is therefore a stronger default than Oh My Pi's menu behavior. For ReasonateAI, use a UTF-8 `.txt` attachment automatically when a paste exceeds a documented size or line threshold, with an optional return-to-inline action. A proposed starting point is 8 KiB **or** 100 lines, subject to acceptance; this is a recommendation, not an existing contract. Checking bytes as well as lines catches huge single-line JSON/logs. Preserve exact content and existing draft text, and enforce server-side limits independently.

Sources: [large-paste flow](https://github.com/can1357/oh-my-pi/blob/6631c46470974abf1fc21e4ef784f2bbceb80b60/packages/coding-agent/src/modes/controllers/input-controller.ts#L2485), [composer atom expansion](https://github.com/can1357/oh-my-pi/blob/6631c46470974abf1fc21e4ef784f2bbceb80b60/packages/tui/src/prompt/custom-editor.ts#L714), [settings](https://github.com/can1357/oh-my-pi/blob/6631c46470974abf1fc21e4ef784f2bbceb80b60/packages/coding-agent/src/modes/settings.ts#L1040).

## 4. Why rereading can work after compaction

Compaction reduces active context; it does not need to destroy original attachment files. Oh My Pi supports recovery through several layers:

- The file can remain under `local://` or in blob storage after its original image block leaves active context.
- The source notice provides a readable reference while it is retained or recoverable from history.
- Concise history renders image source paths explicitly.
- Summarization asks for exact paths and relevant context; compaction also tracks file operations.
- Persisted history is distinct from the reduced active context. There are history protocols, including an experimental, caller-bound `history://current/full` route that requires its feature setting and a bound session branch.

This is recoverability, not a guarantee that the agent automatically remembers every image after every compaction mode. A text summary is lossy; the plain summary serializer does not preserve image pixels. The latest-image alias also depends on active messages. Reliable recovery therefore needs the file **and** discoverable references. For ReasonateAI, regenerate a compact attachment index from authoritative conversation membership when rebuilding context; do not rely on the summarizer remembering all references.

Sources: [summary serialization](https://github.com/can1357/oh-my-pi/blob/6631c46470974abf1fc21e4ef784f2bbceb80b60/packages/agent/src/compaction/utils.ts#L208), [summary requirements](https://github.com/can1357/oh-my-pi/blob/6631c46470974abf1fc21e4ef784f2bbceb80b60/packages/agent/src/compaction/prompts/compaction-summary.md), [history recovery](https://github.com/can1357/oh-my-pi/blob/6631c46470974abf1fc21e4ef784f2bbceb80b60/packages/coding-agent/src/internal-urls/history-protocol.ts).

## 5. The unified reader and adjacent flows

Oh My Pi's reader resolves a URI to a backing file and sends that file through the same format-aware pipeline as a normal path. This avoids separate, inconsistent readers for local files and attachment URLs.

- **Images:** returns pixels plus metadata to an image-capable model. A text-only model gets metadata and a way to ask a vision model a focused question using `?q=`.
- **Text-only image intake:** an optional vision fallback saves the image, obtains a description, and retains the reference. Missing vision configuration or an empty result is made explicit.
- **Documents:** converts PDF, DOCX, PPTX, XLSX, and EPUB to Markdown. Legacy DOC/PPT/XLS are deliberately excluded from that converter set. Conversion caches include source content, format, and converter/package version.
- **Structured data:** archive members, SQLite queries, notebooks, PDF page images, and video-related selectors have dedicated reading paths. This is broad format support, not arbitrary binary comprehension.
- **CLI `@file`:** is a separate intake path. It may inline text/converted documents, attach images, or retain only a path for oversized content. It should not be confused with clipboard persistence.
- **Queues and questions:** source notices travel as companions of their user prompt; queue removal/editing keeps those associations together. Image markers are renumbered when restored queues merge with a draft. Image-bearing question answers can also be addressed.
- **Session moves/forks/handoffs:** artifact copying and relocation-safe local references carry files forward. Some copying failures are logged rather than fatal. Temporary-root fallbacks also exist, so desktop-local storage is not automatically a cloud durability guarantee.
- **Large tool/worker output:** full output can be saved behind an artifact reference rather than silently truncated. Atomic publication prevents exposing partially written artifacts.

Sources: [reader dispatch and images](https://github.com/can1357/oh-my-pi/blob/6631c46470974abf1fc21e4ef784f2bbceb80b60/packages/coding-agent/src/tools/read.ts#L1390), [vision fallback](https://github.com/can1357/oh-my-pi/blob/6631c46470974abf1fc21e4ef784f2bbceb80b60/packages/coding-agent/src/utils/image-vision-fallback.ts), [document conversion](https://github.com/can1357/oh-my-pi/blob/6631c46470974abf1fc21e4ef784f2bbceb80b60/packages/coding-agent/src/utils/markit.ts), [CLI intake](https://github.com/can1357/oh-my-pi/blob/6631c46470974abf1fc21e4ef784f2bbceb80b60/packages/coding-agent/src/cli/file-processor.ts), [queue companions](https://github.com/can1357/oh-my-pi/blob/6631c46470974abf1fc21e4ef784f2bbceb80b60/packages/coding-agent/src/session/queued-messages.ts#L77), [local lifecycle](https://github.com/can1357/oh-my-pi/blob/6631c46470974abf1fc21e4ef784f2bbceb80b60/packages/coding-agent/src/internal-urls/local-protocol.ts#L238), [session artifact copying](https://github.com/can1357/oh-my-pi/blob/6631c46470974abf1fc21e4ef784f2bbceb80b60/packages/coding-agent/src/session/session-manager.ts#L161), [output artifacts](https://github.com/can1357/oh-my-pi/blob/6631c46470974abf1fc21e4ef784f2bbceb80b60/packages/coding-agent/src/session/artifacts.ts).

## 6. Recommended ReasonateAI design

### Persist once; reference across turns

Use the existing private artifact-storage boundary for immutable originals and PostgreSQL for attachment metadata and message/conversation membership. Store a stable attachment ID, original filename, detected media type, size, SHA-256, provenance (`upload`, `clipboard-image`, `large-paste`, `sketch`), and attachment relationships. Keep derived thumbnails/extracted text separately versioned.

An authorized upload should transition through explicit pending, ready, failed, and removed states. Admit a turn only when its attachments are verified and ready. Idempotency must prevent duplicate uploads/relationships on retry; cleanup must distinguish abandoned uploads from files referenced by saved or branched history. New attachment records and contracts require a versioned migration, while old JSONB payloads remain recoverable until migration is verified.

### Expose real files inside the verified sandbox

Materialize authorized originals into a reserved attachment area, for example `/workspace/.reasonate/attachments/<stable-id>/<filename>`, and expose a stable URI such as `attachment://<stable-id>`. Both paths are proposed conventions. The original remains immutable; tools may copy it into editable project source when needed. The reader and command tools should reach the same bytes.

This meets the request that agents can work with attachments as files. It should not automatically put private user documents into Git checkpoints, source ZIPs, public previews, or deployment bundles. The canonical original belongs in private artifact storage; sandbox materialization is a recoverable working copy. Restore it independently after a checkpoint rollback or container replacement.

### Recover identity independently of summaries

On each run/rebuild, supply a bounded attachment index derived from the active conversation's retained history: ID, name, type, source turn, and read URI. Provide a paged listing for older attachments when the index grows. On branch/retry/edit, resolve exactly the retained boundary: earlier attachments remain available, later excluded turns do not become context, and the original audit history remains intact.

This is also why existing run-scoped numeric `artifact://` spill IDs are not sufficient as permanent conversation attachment IDs.

### Make the production reader format-aware

Build on the scoped workspace filesystem adapter, preserving centralized authorization. Extend its result contract to carry image parts when supported; add bounded document extraction and useful selectors. Keep text line ranges, pagination, cancellation, unsupported-format errors, and explicit truncation. Do not wire the host-filesystem reader directly to untrusted model paths.

Vision must respect the repository's approved-provider and budget policy. A successful upload does not prove the selected model can inspect it. Expose missing capabilities clearly while retaining the original file for later use.

### Match the screenshot

Render submitted images in a right-aligned gallery above the text bubble, preserving aspect ratio with rounded thumbnails and an accessible full-size viewer/download action. Use a separate document card for non-images. Keep composer removal/upload controls separate from submitted-message presentation. Authorized preview references must refresh after expiry and survive reload; a broken preview must retain filename and a useful retry state. Handle image-only turns without an empty text bubble, multiple images, mobile layouts, loading, and failures. Match placement and hierarchy while retaining the approved Bklit palette.

### Preserve the instruction boundary

User-uploaded documents and pasted text are reference material. Their contents must not be discovered as repository instructions or promoted into higher-priority messages. Preserve provenance when extracting, summarizing, or delegating. Attachment read access does not authorize executing an uploaded script. Enforce tenant/project/conversation membership, byte/dimension/decompression limits, filename/path containment, and revocation at the server/tool boundary. Browser URLs are short-lived access mechanisms, never permanent model references.

## 7. Acceptance evidence required for implementation

1. Submit a real PNG, reload, and open its thumbnail above the bubble; test multiple images, image-only turns, small screens, keyboard access, and expired preview recovery.
2. Prove the sandbox file has the original upload's digest; read it through the production tool and verify actual image content reaches a permitted vision path.
3. Paste multiline text and huge single-line text; verify automatic text-file conversion, exact UTF-8 content, removal, failed upload, retry, and ordinary short paste behavior.
4. Force context reduction, then ask about an early attachment without reuploading; prove discovery and rereading from the durable reference.
5. Restart the worker, replace the sandbox, and restore a checkpoint; prove original attachment recovery in each case.
6. Exercise queue editing, cancellation, resend, retry, and branch boundaries; assert correct attachment identity and no duplicate/later-turn leakage.
7. Deny cross-tenant and unauthorized-conversation reads/previews; test traversal, symlink escape, forged MIME, oversized/decompression inputs, and embedded instruction attempts.
8. Test supported documents through the running reader; unsupported formats and missing vision must fail clearly rather than claim successful understanding.
9. Verify legacy JSONB migration/recovery and retention cleanup against representative data, then run the repository's required quality, integration, smoke, browser, and security gates.

Oh My Pi has relevant regression tests for source-path delivery and moves, local-image reading and symlink denial, large-paste choices and filename collisions, image persistence, vision fallback, and images queued during compaction. They are useful contract examples. They were reviewed as source; no passing result for them is claimed here.

## Recommendation

Implement this as one attachment lifecycle requirement covering storage, sandbox access, production reading, conversation recovery, and presentation. Review those contracts together before claiming completion. The key property is that an attachment can leave the model's current context while its original content and authorized read reference remain recoverable.
