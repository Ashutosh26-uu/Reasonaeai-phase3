# Durable conversation attachments

Implementation branch: `codex/durable-chat-attachments`. Investigation began October 15, 2026; verification continued October 16. This is a local implementation record, not a production deployment or merge approval.

## Contract and lifecycle

Original submitted bytes remain encoded in PostgreSQL `runs.user_attachments`. Immutable private files are preserved through the existing artifact-store interface as well. Filenames, media types and content hashes derive tenant/project-scoped immutable object keys; repeated writes publish atomically and verify the existing content. PostgreSQL active conversation membership remains the authorization and recovery authority. No historical payload is rewritten and no database migration is required.

1. Existing bounded attachment intake and centralized authorization/admission accept a turn idempotently. Limits remain five files, 4 MiB each, 12 MiB combined. Filename validation rejects separators, traversal, malformed Unicode and control characters, and enforces the sandbox's 255-UTF-8-byte filename bound while preserving genuine POSIX names such as `notes:raw`.
2. Private preservation uses the files actually owned by the accepted turn, including idempotent replay. Denied admission and failed database allocation do not create upload objects. If subsequent private storage fails, the durable accepted command and original PostgreSQL payload remain available for retry/recovery; the request reports failure rather than claiming successful preservation.
3. Each worker derives a metadata-only attachment catalog from retained history before creating the controller. The first 100 references enter run instructions; `read("attachment://")` and offset pages discover more. Document content stays reference data and is never loaded as workspace instructions.
4. Current-turn files materialize under `/workspace/.reasonate/attachments/<source-run>/<index>/<original-name>`. An older retained file materializes on demand through `read("attachment://<source-run>/<index>")`, including line selectors. The broker verifies current tenant/project/conversation membership on every load. Summaries and process-local controller memory do not own attachment identity.
5. Checkpoint restore and sandbox replacement restore these files separately from project source. Retry/branch/edit use retained history; an excluded later turn cannot authorize its attachments. Broad Git staging is stripped of private originals before a source checkpoint. Existing ZIP exclusion of `.reasonate` is retained. An agent may deliberately copy an input into project source when needed.
6. Saved messages receive cookie-authorized preview/download URLs. Anonymous, foreign-tenant and unrelated-conversation reads fail. Responses are private/no-store, nosniff and sandboxed. PNG/JPEG/GIF/WebP may display inline; other types download as binary. A valid browser session is rechecked instead of embedding a reusable access token in model context.

Metadata SQL calculates decoded length from Base64 alphabet length rather than PostgreSQL `decode`. This preserves compatibility with noncanonical padding accepted by historical Node intake. Encoded originals are not normalized or destroyed.

## Reading and presentation

The production workspace reader returns actual image parts after checking dimensions, reads UTF-8 text with existing selectors, extracts PDF text in a bounded Node worker, and extracts DOCX/PPTX/XLSX paragraphs/slides/stored cell values. It does not recalculate formulas or execute document scripts. Office extraction selects supported archive members, rejects DTD/entity declarations and bounds expansion to 16 MiB. PDF extraction disables evaluation/scripting, limits pages to 500, extracted text to 2 MiB and processing to 20 seconds with cancellation. A 128 MiB worker heap is a resource limit, not a security sandbox. Scanned PDFs without extractable text report that OCR/vision is required; unsupported binaries fail explicitly.

Workspace file reads are limited to 16 MiB and transported in sequential 512 KiB chunks, keeping encoded responses below the sandbox command-output cap. Invalid transport errors omit parser output that might contain private bytes. API and worker filesystem adapters retain identical behavior. Attachment/document reads do not mint source-edit anchors.

Large paste becomes a UTF-8 `.txt` attachment at 8 KiB or 100 lines. Short text remains inline; over-limit conversion retains the normal paste path. Submitted attachments use one right-aligned responsive grid above/outside the message bubble, retaining submission order. All cards expand to the same bounded width and the largest height in that list, including wrapped rows. Images preserve their proportions with full-size viewing, original links and retry; documents show type-specific icons, filename, type and size. Long filenames truncate visually while retaining their full accessible text and title. The Bklit palette is retained.

## Dependency and runtime

`pdfjs-dist` is pinned to stable `6.4.299` (Apache-2.0); the CTO package and API declare it, and Mastra marks it external so the packaged API can resolve the worker module. Existing XML/ZIP dependencies serve Office extraction. Node 22.22+ is required by the runtime package and API/worker; the repository pins 22.22.3. Optional platform-native PDF dependencies must be installed for the deployment platform rather than copied from a Windows checkout.

Primary-source checks used the [PDF.js repository](https://github.com/mozilla/pdf.js), [distribution package](https://www.npmjs.com/package/pdfjs-dist), and [security advisories](https://github.com/mozilla/pdf.js/security/advisories). The selected release exceeds the patched versions for CVE-2024-4367 and CVE-2026-16633. Keep the frozen lockfile and production dependency scan as release gates.

## Configuration and recovery

API and worker must point `REASONATE_ARTIFACT_ROOT` at the same durable private storage. The local adapter defaults to the existing `reasonate-artifacts` directory under the host temporary root; that default is convenient local development storage, not a production durability guarantee. Production needs a backed-up private mounted volume or an approved replacement adapter behind the same interface. Never expose this directory as public static content. PostgreSQL originals remain a second recovery source.

No destructive backfill is needed: existing attachments are lazily preserved when authorized preview/read or execution requests them. If private storage is lost, restore it from backups or allow scoped reads to rebuild it from PostgreSQL. If a sandbox is lost, checkpoint restore plus the scoped attachment broker reconstructs its working copies. Never delete PostgreSQL originals after a successful file write.

Rollback API/worker/web together to the preceding version; keep PostgreSQL rows and private objects. Old clients ignore the additive preview URL. No migration rollback, database reinterpretation or object purge is needed. New intake rejects unsafe filenames that older versions might have accepted; existing unsupported names may need an explicit, audited recovery/export rather than silent rebasing. Do not place original attachments into public previews or deployments by default.

## Verification evidence

See the task's `.verification/attachment-*.log` records and `.verification/attachment-browser/` screenshots. The isolated database, Redis, mailbox and browser account are disposable fixtures; tests do not use the user's active service endpoints.

| Check | Final local result |
|---|---|
| `pnpm install --frozen-lockfile` | Pass, including repository prepare hook |
| `pnpm check` / `pnpm typecheck` | Pass; all 10 type-check tasks |
| `pnpm test` | Pass; all 17 tasks, 1,162 workspace tests plus 11 startup tests; 26 existing Windows skips |
| `pnpm build` | Pass; all 10 tasks, including packaged Mastra API and Next production output |
| `pnpm smoke:dev` | Pass; cold/repeated startup, stopped-service recovery, retained data, API/worker/web and local mailbox |
| `pnpm --filter @reasonateai/api smoke:checkpoint` | `SMOKE_OK`; snapshot/restore, successful cleanup and failed-checkpoint volume retention |
| Built API smoke | Health and both raw Mastra route denials pass |
| Packaged production reader | Real PDF text extracted from a real Docker workspace; no language model called |
| Production dependency scans | No high/critical findings; root has two low/two moderate findings, sandbox starter has none |
| Gitleaks | Full HEAD ancestry and staged patch pass |

The final root run used fresh isolated PostgreSQL/Redis fixtures and completed in 10m30.932s. An earlier run hit an existing preview-startup polling timeout while a production build competed for resources; the unchanged assertion passed independently and in the final full run. A reused database subsequently retained enough prior outbox events to invalidate fixture assumptions; recreating isolated fixtures resolved this without changing production code or weakening tests. The final 80 contract, 255 web, 177 API and 52 worker tests include the added regressions. Existing Unix-only checkpoint/restore/diff tests account for the Windows skips and must run in Linux CI.

Already exercised: actual browser file-picker upload and large clipboard paste; exact original PNG and Unicode/CRLF text retrieved through the running authenticated API; anonymous denial; thumbnail placement outside the bubble; full-size viewer; saved-history reload; real Docker cross-turn recovery with reduced model context; a near-4-MiB attachment; private checkpoint exclusion even after broad Git staging; duplicate immutable writes; Office and PDF extraction; legacy Base64 metadata; and retained-memory references.

Desktop browser acceptance used 1280×720. The browser's viewport override did not change the measured viewport, so mobile acceptance is not claimed. The intentionally unconfigured model in the disposable browser fixture produced a failed model run; this does not represent successful model understanding, and did not prevent upload persistence, preview or original-byte retrieval. Provider vision/model understanding was not exercised by these storage/runtime checks; no paid frontier-model calls were made. Company review, clean Linux hosted checks and deployment acceptance remain required.

## October 16 attachment sizing correction

The first upload screenshot demonstrated persistence and viewer behavior but missed an unusably small image beside the pasted-text card. The follow-up implements the user's equal-card requirement in one submission-ordered list. No storage, API, grant or migration contract changes.

`pnpm --filter @reasonateai/web test` passes all 258 tests, including mixed submission order, accessible file actions, type/size labels, long filenames, unusual extensions and empty lists. Repository `pnpm check` and web type checking pass; a scoped ephemeral reviewer found no actionable issue. `.verification/attachment-grid/` retains desktop/narrow/viewer screenshots and measured geometry from the actual production component and application styles, bundled into an isolated browser fixture without using the active user database, worker, mailbox or ports.

Measured viewports are 1280×900 and 390×844, with an additional 288px container. The six mixed cards are each 240×241.33px on desktop and 326.67×241.33px at the narrow viewport; every wrapped row matches, with no card or page overflow. The image-plus-text pair is uniformly 160px high and documents-only cards uniformly 112px high. An unavailable preview retains a 160px card alongside its document, Retry restores the real image, and Escape from the original viewer restores focus to its trigger. Full application mobile acceptance remains pending; this is component-level responsive acceptance, superseding the earlier failed viewport override only for this grid.

The follow-up two-file and three-file examples use image + pasted text and image + pasted text + PDF. The grid supports up to three columns when space permits, so both examples fit a single row at 1280px (each card 240×160px). At 390px both wrap into equal 326.67×160px cards without horizontal overflow. Screenshots and geometry are retained as `.verification/attachment-grid/two-and-three-files.png` and `two-and-three-measurements.json`. The scoped reviewer found no regression in the additional column.

## Relationship to research

[The Oh My Pi investigation](../research/attachment-handling.md) traces intake, local blobs, source notices, aliases, format readers, queues, compaction, session moves/forks and output artifacts. It distinguishes initial old local versions from the pulled newer implementation. We adopted durable file identity and recoverability through this product's authorization/storage boundaries; this is not a wholesale port of its terminal application.
