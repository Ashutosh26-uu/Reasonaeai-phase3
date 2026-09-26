/**
 * Refusals raised by the artifact store. Each one is a distinct class so a
 * caller can branch on the reason instead of parsing a message, and none of
 * them ever carries artifact bytes: a refused read returns nothing.
 */
export class ArtifactStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ArtifactStoreError";
  }
}

/** An identifier that has to be a UUID and is not one. */
export class ArtifactIdentifierError extends ArtifactStoreError {
  readonly field: string;
  readonly identifier: string;

  constructor(field: string, identifier: unknown) {
    super(
      `Refused artifact ${field} ${JSON.stringify(identifier)}: expected a UUID.`
    );
    this.name = "ArtifactIdentifierError";
    this.field = field;
    this.identifier =
      typeof identifier === "string" ? identifier : String(identifier);
  }
}

/**
 * A key that is malformed or unsafe, or that resolves outside the caller's
 * tenant prefix. Traversal, absolute paths, backslashes, encoded separators,
 * and symlinked escapes all end here.
 */
export class ArtifactKeyError extends ArtifactStoreError {
  readonly key: string;

  constructor(key: unknown, reason: string) {
    super(`Refused artifact key ${JSON.stringify(key)}: ${reason}.`);
    this.name = "ArtifactKeyError";
    this.key = typeof key === "string" ? key : String(key);
  }
}

/** No object exists at that key inside the caller's tenant prefix. */
export class ArtifactNotFoundError extends ArtifactStoreError {
  readonly key: string;

  constructor(key: string, options?: { cause?: unknown }) {
    super(`Artifact object ${JSON.stringify(key)} does not exist.`, options);
    this.name = "ArtifactNotFoundError";
    this.key = key;
  }
}

/**
 * The bytes about to be returned do not hash to the digest the artifact's
 * manifest records for this object. The bytes are withheld: a mutated,
 * truncated, or swapped object fails the read instead of being served.
 */
export class ArtifactIntegrityError extends ArtifactStoreError {
  readonly actualDigest: string;
  readonly expectedDigest: string;
  readonly key: string;

  constructor(input: {
    actualDigest: string;
    expectedDigest: string;
    key: string;
  }) {
    super(
      `Artifact digest mismatch for ${JSON.stringify(input.key)}: the manifest requires ${input.expectedDigest} but the stored bytes hash to ${input.actualDigest}.`
    );
    this.name = "ArtifactIntegrityError";
    this.actualDigest = input.actualDigest;
    this.expectedDigest = input.expectedDigest;
    this.key = input.key;
  }
}

/**
 * An object already exists at this content address with different bytes.
 * Stored objects are immutable, so the write is refused rather than replaced.
 */
export class ArtifactConflictError extends ArtifactStoreError {
  readonly existingDigest: string;
  readonly incomingDigest: string;
  readonly key: string;

  constructor(input: {
    existingDigest: string;
    incomingDigest: string;
    key: string;
  }) {
    super(
      `Artifact object ${JSON.stringify(input.key)} already holds ${input.existingDigest}; an immutable object is never replaced with ${input.incomingDigest}.`
    );
    this.name = "ArtifactConflictError";
    this.existingDigest = input.existingDigest;
    this.incomingDigest = input.incomingDigest;
    this.key = input.key;
  }
}

/**
 * The manifest handed to `put` does not describe the object being written:
 * a different tenant, or a different digest or size for the same object.
 */
export class ArtifactManifestMismatchError extends ArtifactStoreError {
  readonly detail: string;

  constructor(detail: string) {
    super(`Artifact manifest mismatch: ${detail}.`);
    this.name = "ArtifactManifestMismatchError";
    this.detail = detail;
  }
}
