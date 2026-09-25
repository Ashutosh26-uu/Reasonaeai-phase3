import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ArtifactKeyError,
  ArtifactStoreError,
  artifactObjectKeyFor,
  signArtifactUrl,
  verifyArtifactUrl,
} from "../src/index.js";
import {
  organizationId,
  otherOrganizationId,
  otherSigningSecret,
  projectId,
  signingSecret,
} from "./support/fixtures.js";

const NOW_MS = Date.UTC(2026, 8, 25, 12, 0, 0);
const LIFETIME_MS = 60_000;
const EXPIRES_AT_MS = NOW_MS + LIFETIME_MS;
const DIGEST = "a".repeat(64);
const ARTIFACT_ID = "33333333-3333-4333-8333-333333333333";
const KEY = artifactObjectKeyFor({
  artifactId: ARTIFACT_ID,
  digest: DIGEST,
  organizationId,
  projectId,
});
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Verifies under the fixture tenant, secret, and clock. */
function verifyNow(token: string): { key: string } | undefined {
  return verifyArtifactUrl({
    nowMs: NOW_MS,
    organizationId,
    secret: signingSecret,
    token,
  });
}

/** Mints a token for a payload of the test's choosing, under a real secret. */
function craftToken(payload: unknown, secret: string = signingSecret): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url"
  );
  const signature = createHmac("sha256", secret)
    .update(encodedPayload, "utf8")
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function issueToken(): string {
  return signArtifactUrl({
    expiresAtMs: EXPIRES_AT_MS,
    key: KEY,
    organizationId,
    secret: signingSecret,
  });
}

describe("signed artifact access", () => {
  it("verifies a token it issued and returns only the key", () => {
    const token = issueToken();

    expect(verifyNow(token)).toEqual({ key: KEY });
    expect(token.split(".")).toHaveLength(2);
    expect(token).not.toContain(signingSecret);
  });

  it("refuses a token verified under another secret", () => {
    expect(
      verifyArtifactUrl({
        nowMs: NOW_MS,
        organizationId,
        secret: otherSigningSecret,
        token: issueToken(),
      })
    ).toBeUndefined();
  });

  it("refuses an expired token and accepts one that has not expired yet", () => {
    const token = issueToken();

    expect(
      verifyArtifactUrl({
        nowMs: EXPIRES_AT_MS,
        organizationId,
        secret: signingSecret,
        token,
      })
    ).toBeUndefined();
    expect(
      verifyArtifactUrl({
        nowMs: EXPIRES_AT_MS + 1,
        organizationId,
        secret: signingSecret,
        token,
      })
    ).toBeUndefined();
    expect(
      verifyArtifactUrl({
        nowMs: EXPIRES_AT_MS - 1,
        organizationId,
        secret: signingSecret,
        token,
      })
    ).toEqual({ key: KEY });
  });

  it("refuses a token minted for another organization", () => {
    expect(
      verifyArtifactUrl({
        nowMs: NOW_MS,
        organizationId: otherOrganizationId,
        secret: signingSecret,
        token: issueToken(),
      })
    ).toBeUndefined();
  });

  it("refuses a token whose payload was tampered with", () => {
    const [encodedPayload, encodedSignature] = issueToken().split(".");
    if (encodedPayload === undefined || encodedSignature === undefined) {
      throw new Error("the token did not have the expected shape");
    }
    const tamperedPayload = `${encodedPayload.slice(0, -1)}${
      encodedPayload.endsWith("A") ? "B" : "A"
    }.${encodedSignature}`;

    expect(tamperedPayload).not.toBe(issueToken());
    expect(verifyNow(tamperedPayload)).toBeUndefined();
  });

  it("refuses a token whose signature was tampered with", () => {
    const [encodedPayload, encodedSignature] = issueToken().split(".");
    if (encodedPayload === undefined || encodedSignature === undefined) {
      throw new Error("the token did not have the expected shape");
    }
    const tamperedSignature = `${encodedSignature.slice(0, -1)}${
      encodedSignature.endsWith("A") ? "B" : "A"
    }`;

    expect(verifyNow(`${encodedPayload}.${tamperedSignature}`)).toBeUndefined();
  });

  it("refuses a signature re-spelled into a non-canonical encoding", () => {
    const [encodedPayload, encodedSignature] = issueToken().split(".");
    if (encodedPayload === undefined || encodedSignature === undefined) {
      throw new Error("the token did not have the expected shape");
    }
    const lastCharacter = encodedSignature.at(-1) ?? "";
    const index = BASE64URL_ALPHABET.indexOf(lastCharacter);
    // Flipping only the bit base64url decoding discards leaves the signature
    // bytes identical while the token text differs.
    const variant = BASE64URL_ALPHABET[index % 2 === 0 ? index + 1 : index - 1];

    expect(variant).toBeDefined();
    expect(variant).not.toBe(lastCharacter);
    expect(
      Buffer.from(`${encodedSignature.slice(0, -1)}${variant}`, "base64url")
    ).toEqual(Buffer.from(encodedSignature, "base64url"));
    expect(
      verifyNow(`${encodedPayload}.${encodedSignature.slice(0, -1)}${variant}`)
    ).toBeUndefined();
  });

  it.each([
    "",
    "no-separator",
    "two.parts.extra",
    ".",
    "payload.",
    ".signature",
    `${"a".repeat(4097)}.signature`,
    "payload.not+base64url",
  ])("refuses the malformed token %s", (token) => {
    expect(verifyNow(token)).toBeUndefined();
  });

  it("refuses a payload that names another tenant's key", () => {
    expect(
      verifyNow(
        craftToken({
          expiresAtMs: EXPIRES_AT_MS,
          key: artifactObjectKeyFor({
            artifactId: ARTIFACT_ID,
            digest: DIGEST,
            organizationId: otherOrganizationId,
            projectId,
          }),
          organizationId,
          version: 1,
        })
      )
    ).toBeUndefined();
  });

  it("refuses a payload that names an unsafe key", () => {
    expect(
      verifyNow(
        craftToken({
          expiresAtMs: EXPIRES_AT_MS,
          key: `organizations/${organizationId}/../../etc/passwd`,
          organizationId,
          version: 1,
        })
      )
    ).toBeUndefined();
  });

  it("refuses a payload whose fields are not what a token carries", () => {
    const base = {
      expiresAtMs: EXPIRES_AT_MS,
      key: KEY,
      organizationId,
    };

    expect(verifyNow(craftToken({ ...base, version: 2 }))).toBeUndefined();
    expect(
      verifyNow(craftToken({ ...base, expiresAtMs: `${EXPIRES_AT_MS}` }))
    ).toBeUndefined();
    expect(
      verifyNow(craftToken({ ...base, organizationId: "not-a-uuid" }))
    ).toBeUndefined();
    expect(verifyNow(craftToken("a plain string payload"))).toBeUndefined();
    expect(verifyNow("not-json.signature")).toBeUndefined();
  });

  it("refuses to sign a key outside the signing organization", () => {
    expect(() =>
      signArtifactUrl({
        expiresAtMs: EXPIRES_AT_MS,
        key: artifactObjectKeyFor({
          artifactId: ARTIFACT_ID,
          digest: DIGEST,
          organizationId: otherOrganizationId,
          projectId,
        }),
        organizationId,
        secret: signingSecret,
      })
    ).toThrow(ArtifactKeyError);
  });

  it("refuses to sign without a valid expiry or without a secret", () => {
    expect(() =>
      signArtifactUrl({
        expiresAtMs: 0,
        key: KEY,
        organizationId,
        secret: signingSecret,
      })
    ).toThrow(ArtifactStoreError);
    expect(() =>
      signArtifactUrl({
        expiresAtMs: EXPIRES_AT_MS,
        key: KEY,
        organizationId,
        secret: "",
      })
    ).toThrow(ArtifactStoreError);
  });
});
