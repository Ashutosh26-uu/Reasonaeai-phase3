import { type Session, SessionSchema } from "@reasonateai/contracts/identity";
import { describe, expect, it } from "vitest";
import {
  sessionCookie,
  sessionState,
  shouldRotateSession,
} from "../src/session-policy.js";

const baseSession: Session = SessionSchema.parse({
  absoluteExpiresAt: "2026-09-17T14:00:00.000Z",
  createdAt: "2026-09-17T12:00:00.000Z",
  idleExpiresAt: "2026-09-17T12:30:00.000Z",
  lastSeenAt: "2026-09-17T12:00:00.000Z",
  revokedAt: null,
  rotatedFromSessionId: null,
  sessionId: "66666666-6666-4666-8666-666666666666",
  userId: "55555555-5555-4555-8555-555555555555",
});

const stateAt = (now: string, session: Partial<Session> = {}) =>
  sessionState({
    now: new Date(now),
    session: { ...baseSession, ...session },
  });

const rotatesAt = (
  now: string,
  rotateAfterMs: number,
  session: Partial<Session> = {}
) =>
  shouldRotateSession({
    now: new Date(now),
    rotateAfterMs,
    session: { ...baseSession, ...session },
  });

describe("sessionState", () => {
  it("reports a session inside both deadlines as active", () => {
    expect(stateAt("2026-09-17T12:10:00.000Z")).toBe("active");
    expect(stateAt("2026-09-17T12:29:59.999Z")).toBe("active");
  });

  it("reports a revoked session as revoked even while both clocks are in the future", () => {
    const revoked = { revokedAt: "2026-09-17T12:05:00.000Z" };

    expect(stateAt("2026-09-17T12:10:00.000Z", revoked)).toBe("revoked");
    expect(stateAt("2026-09-17T13:00:00.000Z", revoked)).toBe("revoked");
    expect(stateAt("2026-09-17T15:00:00.000Z", revoked)).toBe("revoked");
  });

  it("reports an elapsed absolute deadline as expired", () => {
    expect(stateAt("2026-09-17T14:00:00.000Z")).toBe("expired");
    expect(stateAt("2026-09-17T14:00:00.001Z")).toBe("expired");
    expect(stateAt("2026-09-17T15:00:00.000Z")).toBe("expired");
  });

  it("reports an elapsed idle deadline as idle_expired", () => {
    expect(stateAt("2026-09-17T12:30:00.000Z")).toBe("idle_expired");
    expect(stateAt("2026-09-17T13:59:59.999Z")).toBe("idle_expired");
  });

  it("prefers the absolute deadline over the idle one", () => {
    expect(
      stateAt("2026-09-17T12:20:00.000Z", {
        absoluteExpiresAt: "2026-09-17T12:15:00.000Z",
      })
    ).toBe("expired");
  });
});

describe("shouldRotateSession", () => {
  const fifteenMinutes = 15 * 60 * 1000;

  it("rotates only once the session is strictly older than the interval", () => {
    expect(rotatesAt("2026-09-17T12:14:59.999Z", fifteenMinutes)).toBe(false);
    expect(rotatesAt("2026-09-17T12:15:00.000Z", fifteenMinutes)).toBe(false);
    expect(rotatesAt("2026-09-17T12:15:00.001Z", fifteenMinutes)).toBe(true);
    expect(rotatesAt("2026-09-17T12:20:00.000Z", fifteenMinutes)).toBe(true);
  });

  it("never rotates a session that is revoked or past a deadline", () => {
    expect(
      rotatesAt("2026-09-17T12:45:00.000Z", fifteenMinutes, {
        revokedAt: "2026-09-17T12:01:00.000Z",
      })
    ).toBe(false);
    expect(rotatesAt("2026-09-17T15:00:00.000Z", fifteenMinutes)).toBe(false);
    expect(
      rotatesAt("2026-09-17T12:45:00.000Z", fifteenMinutes, {
        idleExpiresAt: "2026-09-17T12:30:00.000Z",
      })
    ).toBe(false);
  });
});

describe("sessionCookie", () => {
  it("serializes a dev-mode cookie without Secure or HttpOnly", () => {
    expect(
      sessionCookie("reasonate_session", "token-value", {
        httpOnly: false,
        maxAgeSeconds: 86_400,
        secure: false,
      })
    ).toBe(
      "reasonate_session=token-value; Path=/; SameSite=Lax; Max-Age=86400"
    );
  });

  it("adds HttpOnly and Secure only when asked", () => {
    expect(
      sessionCookie("reasonate_session", "token-value", {
        httpOnly: true,
        maxAgeSeconds: 86_400,
        secure: true,
      })
    ).toBe(
      "reasonate_session=token-value; Path=/; SameSite=Lax; HttpOnly; Secure; Max-Age=86400"
    );
    expect(
      sessionCookie("reasonate_session", "token-value", {
        httpOnly: true,
        maxAgeSeconds: 60,
        secure: false,
      })
    ).toBe(
      "reasonate_session=token-value; Path=/; SameSite=Lax; HttpOnly; Max-Age=60"
    );
  });

  it("refuses a Max-Age that is not a positive integer", () => {
    for (const maxAgeSeconds of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(() =>
        sessionCookie("reasonate_session", "token-value", {
          httpOnly: true,
          maxAgeSeconds,
          secure: true,
        })
      ).toThrow(RangeError);
    }
  });

  it("refuses a name or value that could break out of its attribute", () => {
    expect(() =>
      sessionCookie("reasonate session", "token-value", {
        httpOnly: true,
        maxAgeSeconds: 60,
        secure: true,
      })
    ).toThrow(TypeError);
    expect(() =>
      sessionCookie("reasonate_session", "value; Domain=evil.example", {
        httpOnly: true,
        maxAgeSeconds: 60,
        secure: true,
      })
    ).toThrow(TypeError);
    expect(() =>
      sessionCookie("reasonate_session", "value\r\nSet-Cookie: injected=1", {
        httpOnly: true,
        maxAgeSeconds: 60,
        secure: true,
      })
    ).toThrow(TypeError);
  });
});
