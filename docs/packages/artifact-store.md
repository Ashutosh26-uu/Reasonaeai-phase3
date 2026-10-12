# Artifact Store — Immutable Storage and Access Brokering

**Status:** 🟢
**Owns:** packages/artifact-store, packages/cto-runtime (durable spill + evidence), apps/api/src/mastra/routes/artifacts.ts
**Author:** Sarthak Aggarwal
**Owner role:** Sarthak (Agent Runtime / Project State & Data)
**Tracker row:** "Build immutable artifact storage and access brokering" — Artifacts & Evidence, P1 — High, In review

## Purpose

Every artifact in the system carries a validated manifest and digest; object
keys never authorize anything; signed access is short-lived and centrally
authorized; cross-tenant access fails. Beyond the store itself, two product
guarantees are wired end-to-end: `artifact://` resolves durably (spilled tool
output survives a restart), and every completed `browser_verify` produces
downloadable evidence.

## The immutable store (packages/artifact-store, landed in acb78b4)

- Provider-neutral `ArtifactStore` contract with a local filesystem
  implementation. Writes are content-addressed under
  `organizations/<orgId>/projects/<projId>/artifacts/<artifactId>/objects/<sha256>`,
  exclusive-create: an existing key is verified against its digest, never
  rewritten; a conflicting write is a typed refusal.
- Reads rehash the bytes and compare against the key's digest. An altered or
  truncated object is refused (`ArtifactIntegrityError`), never served.
- Keys are never authorization. Keys come only from the package's own builder,
  are re-parsed and revalidated on read, are confined to the caller's tenant
  prefix, and refuse traversal, absolute paths, encoded separators, and
  junction/symlink escapes (every existing ancestor is realpath-checked during
  directory creation).
- Manifests are validated server-side (`ArtifactManifestSchema`, strict
  object): digest, size, and object key are computed from the bytes received,
  never trusted from the caller.
- Access is brokered, not implied: every route decides through the same
  centralized policy as the rest of the product, and a download URL is a
  5-minute token bound to organization and expiry, verified in constant time.
  A tampered, expired, or foreign-tenant token yields no bytes.
- Product routes: record (bytes + metadata written together, so a row exists
  only for bytes that exist), list (a non-member gets a typed refusal, not an
  empty list), access (signed URL), download (streams only after token
  verification).
- 40 package tests + 15 through the real API handlers cover a mutated on-disk
  object, a tampered token, an expired token, and a token minted for another
  organization.

## Durable spill (packages/cto-runtime/src/durable-artifacts.ts)

- `createDurableSpillSink`: every spilled read output is put through the
  immutable store — digest computed from the bytes, key built only via
  `artifactObjectKeyFor`, manifest zod-validated — and recorded in PostgreSQL,
  best effort. The local copy already answers the read, so a durable failure
  is reported, not thrown.
- Restart resolution needs no new schema: a spill's artifact id is derived
  deterministically (UUID-shaped hash of the verified scope + per-run index).
  A restarted process recomputes the id, looks up the recorded digest,
  rebuilds the key, and reads the bytes. Only a recorded digest can produce a
  key — an unrecorded spill is reported as absent, never guessed at, and a
  tampered record produces a key whose bytes fail the store's rehash check.
- The per-run store keeps its local write/read path unchanged and adds a
  durable write-through plus a fallback read. Both composition roots (API and
  worker) wire the same sink through `createDurableSpillSink` on the runtime
  config — no existing signatures changed. The worker takes its store root
  from `REASONATE_ARTIFACT_ROOT`.
- 8 tests: write-through + record, cross-process resolution after a wipe,
  tampered-digest refusal, concurrent index alignment, absence reporting, one
  against the real local store, plus the per-run-store restart-fallback and
  sink-outage tests.

## Evidence production (packages/cto-runtime/src/evidence.ts)

- A completed `browser_verify` is recorded as a `kind: "browser-evidence"`
  artifact containing the verification report (JSON: status, URL, title, HTTP
  status, duration, pass/fail, console and network observations) and the
  screenshot (PNG, byte-identical to what the driver captured).
- One manifest over both files; each file's declaration is derived from the
  bytes the store actually accepted, addressed under the verified run's tenant
  scope — evidence is exactly as immutable and tenant-confined as uploads.
- The manifest is recorded in the authoritative store, so evidence is listable
  via `/v1/artifacts` and downloadable via the signed access route after the
  run ends. The tool result carries `screenshotArtifactId`, so the transcript
  names the durable handle.
- Recording is best effort by composition: a storage outage is reported and
  never inverts the verdict; a run composed without a recorder verifies
  transcript-only, exactly as before. Wired through `createEvidenceRecorder`
  on the runtime config into both composition roots.
- 8 tests: 4 recorder tests against the real local store (byte-identical
  screenshot round-trip, report-only path, bytes survive a record failure,
  storage-refusal propagation) and 4 tool-level tests (evidence produced with
  the verified scope, no-recorder passthrough, outage resilience, runtime
  threading).

## Test status

- Full cto-runtime suite: 415 passing. The 5 remaining failures are
  pre-existing Windows path-escape issues on a clean checkout (verified via
  `git stash`), unrelated to this work.
- Typecheck clean across packages/cto-runtime, apps/api, apps/worker.

## Known limitations / next steps

- Spills and evidence land in the local filesystem store
  (`REASONATE_ARTIFACT_ROOT`); production needs the S3-backed implementation
  of the same provider-neutral interface — no call-site changes required.
- Evidence is visible through the artifact API but not yet in the web UI.
- `artifact.recorded` ledger events are not yet emitted for spills/evidence,
  so run transcripts do not link their artifacts yet.
- The artifacts row stores the first file's digest for multi-file evidence
  artifacts; a manifest-object-key column would make full-manifest retrieval
  exact.
