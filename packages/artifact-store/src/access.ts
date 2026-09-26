import { createHmac, timingSafeEqual } from "node:crypto";
import type { OrganizationId } from "@reasonateai/contracts/identity";
import { ArtifactStoreError } from "./errors.js";
import { isUuid, requireTenantScopedKey, requireUuid } from "./keys.js";

/** Version tag, so a future token format cannot be mistaken for this one. */
const TOKEN_VERSION = 1;
const TOKEN_SEPARATOR = ".";
/** Bounds the work a hostile token can ask for before anything is parsed. */
const TOKEN_MAX_LENGTH = 4096;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * What a signed artifact access token carries: which object, for which tenant,
 * until when. It carries no secret and nothing that authorizes anything by
 * itself — centralized authorization decides whether a token is issued at all,
 * and the store revalidates the key and the bytes when they are read.
 */
export interface ArtifactAccessTokenPayload {
  readonly expiresAtMs: number;
  readonly key: string;
  readonly organizationId: string;
  readonly version: number;
}

export interface ArtifactSignInput {
  readonly expiresAtMs: number;
  readonly key: string;
  readonly organizationId: OrganizationId;
  readonly secret: string;
}

export interface ArtifactVerifyInput {
  readonly nowMs: number;
  readonly organizationId: OrganizationId;
  readonly secret: string;
  readonly token: string;
}

/**
 * Mints a short-lived access token over the tenant, the key, and the expiry,
 * authenticated with the caller's secret. The secret itself never enters the
 * token, and a token for a key outside the signing organization is refused.
 */
export function signArtifactUrl(input: ArtifactSignInput): string {
  const organizationId = requireUuid("organizationId", input.organizationId);
  if (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= 0) {
    throw new ArtifactStoreError(
      "Signing an artifact access token requires expiresAtMs as a positive integer of milliseconds since the epoch."
    );
  }
  if (typeof input.secret !== "string" || input.secret.length === 0) {
    throw new ArtifactStoreError(
      "Signing an artifact access token requires a non-empty secret."
    );
  }

  const key = requireTenantScopedKey(input.key, organizationId);
  const encodedPayload = encodePayload({
    expiresAtMs: input.expiresAtMs,
    key,
    organizationId,
    version: TOKEN_VERSION,
  });
  return [encodedPayload, signatureFor(input.secret, encodedPayload)].join(
    TOKEN_SEPARATOR
  );
}

/**
 * Verifies a token and returns only the key it names, or `undefined` when it
 * is expired, tampered with, minted for another organization, or malformed.
 * The signature is compared in constant time over the encoded payload, and a
 * non-canonical signature encoding is refused so two spellings can never
 * share one signature.
 */
export function verifyArtifactUrl(
  input: ArtifactVerifyInput
): { key: string } | undefined {
  const { secret, token } = input;
  if (
    typeof secret !== "string" ||
    secret.length === 0 ||
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > TOKEN_MAX_LENGTH
  ) {
    return undefined;
  }
  if (!(Number.isFinite(input.nowMs) && isUuid(input.organizationId))) {
    return undefined;
  }

  const parts = token.split(TOKEN_SEPARATOR);
  const [encodedPayload, encodedSignature] = parts;
  if (
    parts.length !== 2 ||
    encodedPayload === undefined ||
    encodedSignature === undefined ||
    !(
      BASE64URL_PATTERN.test(encodedPayload) &&
      BASE64URL_PATTERN.test(encodedSignature)
    )
  ) {
    return undefined;
  }

  const provided = Buffer.from(encodedSignature, "base64url");
  if (provided.toString("base64url") !== encodedSignature) {
    return undefined;
  }
  const expected = Buffer.from(
    signatureFor(secret, encodedPayload),
    "base64url"
  );
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(expected, provided)
  ) {
    return undefined;
  }

  const payload = decodePayload(encodedPayload);
  if (payload === undefined) {
    return undefined;
  }
  if (payload.organizationId !== input.organizationId.toLowerCase()) {
    return undefined;
  }
  if (input.nowMs >= payload.expiresAtMs) {
    return undefined;
  }
  return { key: payload.key };
}

function signatureFor(secret: string, encodedPayload: string): string {
  return createHmac("sha256", secret)
    .update(encodedPayload, "utf8")
    .digest("base64url");
}

function encodePayload(payload: ArtifactAccessTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * A signed payload is still untrusted input: every field is checked again, and
 * a payload naming an unsafe key or another tenant's key is refused.
 */
function decodePayload(
  encodedPayload: string
): ArtifactAccessTokenPayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    );
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const { expiresAtMs, key, organizationId, version } = parsed as Record<
    string,
    unknown
  >;
  if (version !== TOKEN_VERSION) {
    return undefined;
  }
  if (
    typeof expiresAtMs !== "number" ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= 0
  ) {
    return undefined;
  }
  if (typeof organizationId !== "string" || !isUuid(organizationId)) {
    return undefined;
  }
  if (typeof key !== "string") {
    return undefined;
  }
  try {
    requireTenantScopedKey(key, organizationId);
  } catch {
    return undefined;
  }

  return { expiresAtMs, key, organizationId, version: TOKEN_VERSION };
}
