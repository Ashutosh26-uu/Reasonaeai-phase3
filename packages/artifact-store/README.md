# @reasonateai/artifact-store

Provider-neutral, tenant-scoped immutable artifact storage. Object storage
holds digest-verified bytes; PostgreSQL holds each artifact's metadata and
manifest. Object keys and URLs are never authorization: the store refuses
unsafe keys by itself, and a signed URL is issued only after centralized
authorization decides that a principal may read the artifact.

## Entry points

```ts
import { artifactKeyFor, artifactObjectKeyFor, signArtifactUrl, verifyArtifactUrl } from "@reasonateai/artifact-store";
import { createLocalArtifactStore } from "@reasonateai/artifact-store/local";
```

The root entry is the contract (store interface, key builders, digest
helpers, typed refusals, signed access). The filesystem implementation is
reachable through the `/local` subpath so an object-storage adapter can replace
it without touching a caller.

## Layout

```text
organizations/<organizationId>/projects/<projectId>/artifacts/<artifactId>/objects/<sha256>
```

`artifactKeyFor` builds the tenant-scoped artifact prefix and `artifactObjectKeyFor`
appends the object's digest — the only two key builders, both starting with the
tenant, both refusing an identifier that is not a UUID. `runId` is validated but
is deliberately not a path segment: `project-state` records an artifact's
manifest path per organization, project, and artifact, with no run scope, so an
access path has to recompute an object key from that record alone. Run identity
lives in the manifest and the run ledger.

## Invariants

- **Immutable.** An object is created exclusively (`wx`) and never rewritten. A
  repeated `put` of identical bytes is idempotent; an existing object whose
  bytes no longer hash to its address raises `ArtifactConflictError` instead of
  being replaced.
- **Content addressed.** The digest in the key is what `read` verifies. A
  mutated, truncated, or swapped file raises `ArtifactIntegrityError` and the
  bytes are never returned.
- **Confined.** Every path is revalidated before it is joined: `..`, absolute
  paths, backslashes, percent-encoded separators, NUL bytes, and drive letters
  fail on the key, and a key that resolves through a symlink out of the
  caller's own tenant directory fails on `realpath` containment. Writes are
  created under the caller's tenant prefix only.
- **Tenant scoped.** A key is only readable by the organization and project it
  was minted for, and a manifest describing another tenant cannot be stored.

## Signed access

`signArtifactUrl` returns a token of `base64url(payload).base64url(hmacSha256)`
over the tenant, key, and expiry, authenticated with the caller's secret. The
secret never enters the token and the token authorizes nothing by itself.
`verifyArtifactUrl` compares the signature in constant time, refuses a
non-canonical signature encoding, an expired token, a token minted for another
organization, a tampered payload, and a payload naming an unsafe or
foreign-tenant key — returning `undefined` in every refused case.

## Errors

`ArtifactStoreError` is the base. `ArtifactIdentifierError` (forged
identifier), `ArtifactKeyError` (unsafe, malformed, or foreign key),
`ArtifactNotFoundError`, `ArtifactIntegrityError` (digest mismatch on read),
`ArtifactConflictError` (immutability violated), and
`ArtifactManifestMismatchError` (the manifest does not describe the object)
are the refusals a caller branches on.

## Commands

```text
pnpm --filter @reasonateai/artifact-store test
pnpm --filter @reasonateai/artifact-store typecheck
pnpm --filter @reasonateai/artifact-store build
npx ultracite check packages/artifact-store
```

The suites need no database, no container, and no network: each one works
inside its own temporary root.
