import { describe, expect, it } from "vitest";
import {
  isStateChangingMethod,
  mintCsrfToken,
  verifyCsrfToken,
} from "../src/csrf.js";

const secret = "test-secret-not-a-real-key";
const sessionId = "66666666-6666-4666-8666-666666666666";
const otherSessionId = "77777777-7777-4777-8777-777777777777";

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** The token travels in a cookie and a header, so it must need no escaping. */
const URL_SAFE_TOKEN = /^[A-Za-z0-9_-]+$/;

/**
 * Replace one character with one whose value differs by 16, which moves a high
 * bit of that six-bit group. Adding one instead would leave a differently
 * encoded but identical digest when the character is the final, partially
 * significant one.
 */
const flipCharacter = (token: string, index: number): string => {
  const value = BASE64URL_ALPHABET.indexOf(token.charAt(index));
  const replacement = BASE64URL_ALPHABET.charAt(
    (value + 16) % BASE64URL_ALPHABET.length
  );
  return `${token.slice(0, index)}${replacement}${token.slice(index + 1)}`;
};

describe("mintCsrfToken", () => {
  it("mints a cookie-safe token that verifies for its own session", () => {
    const token = mintCsrfToken({ secret, sessionId });

    expect(token).toMatch(URL_SAFE_TOKEN);
    expect(verifyCsrfToken({ secret, sessionId, token })).toBe(true);
  });

  it("mints a different token per session and per secret", () => {
    expect(mintCsrfToken({ secret, sessionId })).not.toBe(
      mintCsrfToken({ secret, sessionId: otherSessionId })
    );
    expect(mintCsrfToken({ secret, sessionId })).not.toBe(
      mintCsrfToken({ secret: `${secret}-other`, sessionId })
    );
  });

  it("refuses an empty secret instead of signing with nothing", () => {
    expect(() => mintCsrfToken({ secret: "", sessionId })).toThrow(RangeError);
  });
});

describe("verifyCsrfToken", () => {
  it("rejects a token minted for another session", () => {
    const token = mintCsrfToken({ secret, sessionId: otherSessionId });

    expect(verifyCsrfToken({ secret, sessionId, token })).toBe(false);
  });

  it("rejects a token minted under another secret", () => {
    const token = mintCsrfToken({ secret: `${secret}-other`, sessionId });

    expect(verifyCsrfToken({ secret, sessionId, token })).toBe(false);
  });

  it("rejects empty, truncated, and over-long tokens without throwing", () => {
    const token = mintCsrfToken({ secret, sessionId });
    const candidates = [
      "",
      "!",
      token.slice(0, 8),
      token.slice(0, token.length - 1),
      `${token}${token}`,
      `${token}A`,
    ];

    for (const candidate of candidates) {
      expect(() =>
        verifyCsrfToken({ secret, sessionId, token: candidate })
      ).not.toThrow();
      expect(verifyCsrfToken({ secret, sessionId, token: candidate })).toBe(
        false
      );
    }
  });

  it("rejects a token that differs anywhere, not just at its end", () => {
    const token = mintCsrfToken({ secret, sessionId });

    for (const index of [
      0,
      1,
      Math.floor(token.length / 2),
      token.length - 1,
    ]) {
      const tampered = flipCharacter(token, index);
      expect(tampered).not.toBe(token);
      expect(verifyCsrfToken({ secret, sessionId, token: tampered })).toBe(
        false
      );
    }
  });

  it("refuses an empty secret instead of verifying against nothing", () => {
    const token = mintCsrfToken({ secret, sessionId });

    expect(() => verifyCsrfToken({ secret: "", sessionId, token })).toThrow(
      RangeError
    );
  });
});

describe("isStateChangingMethod", () => {
  it("accepts the mutating methods in any case", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "delete", "pOsT"]) {
      expect(isStateChangingMethod(method)).toBe(true);
    }
  });

  it("refuses read-only and unknown methods", () => {
    for (const method of [
      "GET",
      "HEAD",
      "OPTIONS",
      "TRACE",
      "",
      "CONSTRUCTOR",
    ]) {
      expect(isStateChangingMethod(method)).toBe(false);
    }
  });
});
