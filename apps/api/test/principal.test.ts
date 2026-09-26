import { ApiErrorSchema } from "@reasonateai/contracts/api-error";
import { SESSION_COOKIE } from "@reasonateai/contracts/auth";
import type { SessionRepository } from "@reasonateai/project-state/sessions";
import { describe, expect, it } from "vitest";
import {
  apiErrorResponse,
  PRINCIPAL_CONTEXT_KEY,
  readCookie,
  resolveSessionPrincipal,
  unauthenticatedResponse,
} from "../src/mastra/principal";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const SESSION_ID = "00000000-0000-4000-8000-000000000002";
const NOW = Date.now();

function liveSession(overrides: Record<string, unknown> = {}) {
  return {
    absoluteExpiresAt: new Date(NOW + 86_400_000).toISOString(),
    createdAt: new Date(NOW).toISOString(),
    idleExpiresAt: new Date(NOW + 3_600_000).toISOString(),
    lastSeenAt: new Date(NOW).toISOString(),
    revokedAt: null,
    rotatedFromSessionId: null,
    sessionId: SESSION_ID,
    userId: USER_ID,
    ...overrides,
  };
}

function sessionsResolving(result: unknown): SessionRepository {
  return {
    createSession: () => {
      throw new Error("not used");
    },
    resolveSession: async () => result as never,
    revokeAllUserSessions: async () => 0,
    revokeSession: async () => false,
    rotateSession: async () => undefined,
  };
}

describe("session cookie reading", () => {
  it("returns the exact value of the named cookie", () => {
    expect(
      readCookie(`${SESSION_COOKIE}=abc123; other=xyz`, SESSION_COOKIE)
    ).toBe("abc123");
  });

  it("does not confuse a similarly named cookie for the session cookie", () => {
    expect(readCookie("reasonate_session_backup=evil", SESSION_COOKIE)).toBe(
      undefined
    );
    expect(readCookie("xreasonate_session=evil", SESSION_COOKIE)).toBe(
      undefined
    );
  });

  it("fails closed on an absent, empty, or malformed header", () => {
    expect(readCookie(undefined, SESSION_COOKIE)).toBe(undefined);
    expect(readCookie("", SESSION_COOKIE)).toBe(undefined);
    expect(readCookie(`${SESSION_COOKIE}=`, SESSION_COOKIE)).toBe(undefined);
    expect(readCookie("novalue", SESSION_COOKIE)).toBe(undefined);
  });
});

describe("principal resolution", () => {
  it("resolves a live session into a user principal bounded by the earlier expiry", async () => {
    const principal = await resolveSessionPrincipal({
      cookieHeader: `${SESSION_COOKIE}=token-value`,
      sessions: sessionsResolving(liveSession()),
    });

    expect(principal?.kind).toBe("user");
    expect(principal?.userId).toBe(USER_ID);
    expect(principal?.sessionId).toBe(SESSION_ID);
    // Idle expiry (1h) is earlier than absolute (24h), so it governs.
    expect(principal?.expiresAt).toBe(liveSession().idleExpiresAt);
  });

  it("fails closed when no cookie, an unknown token, or a revoked session is presented", async () => {
    expect(
      await resolveSessionPrincipal({
        cookieHeader: undefined,
        sessions: sessionsResolving(liveSession()),
      })
    ).toBe(undefined);

    expect(
      await resolveSessionPrincipal({
        cookieHeader: `${SESSION_COOKIE}=token-value`,
        sessions: sessionsResolving(undefined),
      })
    ).toBe(undefined);

    expect(
      await resolveSessionPrincipal({
        cookieHeader: `${SESSION_COOKIE}=token-value`,
        sessions: sessionsResolving(
          liveSession({ revokedAt: new Date().toISOString() })
        ),
      })
    ).toBe(undefined);
  });

  it("rejects an expired session even when the repository still returns it", async () => {
    const expired = liveSession({
      absoluteExpiresAt: new Date(NOW - 1000).toISOString(),
      idleExpiresAt: new Date(NOW - 1000).toISOString(),
    });

    expect(
      await resolveSessionPrincipal({
        cookieHeader: `${SESSION_COOKIE}=token-value`,
        now: new Date(NOW),
        sessions: sessionsResolving(expired),
      })
    ).toBe(undefined);
  });

  it("rejects a session whose identifiers are not usable principal identifiers", async () => {
    await expect(
      resolveSessionPrincipal({
        cookieHeader: `${SESSION_COOKIE}=token-value`,
        sessions: sessionsResolving(liveSession({ userId: "not-a-uuid" })),
      })
    ).rejects.toThrow();
  });
});

describe("api error envelope", () => {
  it("answers an unauthenticated request with a typed 401 that leaks nothing", async () => {
    const response = unauthenticatedResponse("req-1");

    expect(response.status).toBe(401);
    const body = ApiErrorSchema.parse(await response.json());
    expect(body.error.code).toBe("unauthenticated");
    expect(body.error.requestId).toBe("req-1");
    expect(body.error.message).not.toMatch(USER_ID);
  });

  it("maps each error code to its documented status", () => {
    expect(
      apiErrorResponse({ code: "forbidden", message: "nope", requestId: "r" })
        .status
    ).toBe(403);
    expect(
      apiErrorResponse({ code: "not_found", message: "nope", requestId: "r" })
        .status
    ).toBe(404);
    expect(
      apiErrorResponse({ code: "conflict", message: "nope", requestId: "r" })
        .status
    ).toBe(409);
    expect(
      apiErrorResponse({
        code: "invalid_request",
        message: "no",
        requestId: "r",
      }).status
    ).toBe(400);
    expect(
      apiErrorResponse({
        code: "rate_limited",
        message: "slow",
        requestId: "r",
      }).status
    ).toBe(429);
  });

  it("exposes a stable context key for the resolved principal", () => {
    expect(PRINCIPAL_CONTEXT_KEY).toBe("reasonateai.principal");
  });
});
