import {
  type ApiErrorCode,
  ApiErrorSchema,
  apiErrorStatus,
} from "@reasonateai/contracts/api-error";
import {
  SessionSchema,
  type UserPrincipal,
  UserPrincipalSchema,
} from "@reasonateai/contracts/identity";
import type { SessionRepository } from "@reasonateai/project-state/sessions";

export const SESSION_COOKIE_NAME = "reasonate_session";
export const PRINCIPAL_CONTEXT_KEY = "reasonateai.principal";

/**
 * Reads one cookie from a `Cookie` header without decoding or normalizing the
 * value. Session tokens are base64url and contain no separators, so the value
 * is taken verbatim and never URL-decoded into a different value.
 */
export function readSessionCookie(
  cookieHeader: string | undefined,
  name: string = SESSION_COOKIE_NAME
): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() !== name) {
      continue;
    }
    const value = part.slice(separator + 1).trim();
    return value.length > 0 ? value : undefined;
  }

  return undefined;
}

function effectiveExpiry(session: {
  absoluteExpiresAt: string;
  idleExpiresAt: string;
}): string {
  return new Date(session.idleExpiresAt).getTime() <
    new Date(session.absoluteExpiresAt).getTime()
    ? session.idleExpiresAt
    : session.absoluteExpiresAt;
}

/**
 * Resolves the opaque session cookie into a verified user principal. A session
 * that is missing, unknown, revoked, or expired yields `undefined` so callers
 * fail closed rather than continuing with a partially trusted request.
 *
 * Revocation and expiry are re-checked here even though the repository already
 * filters them: this is the point where an untrusted cookie becomes a trusted
 * principal, so it must not depend on any single storage implementation for
 * the decision that a session is dead.
 */
export async function resolveSessionPrincipal(input: {
  cookieHeader: string | undefined;
  cookieName?: string;
  now?: Date;
  sessions: SessionRepository;
}): Promise<UserPrincipal | undefined> {
  const token = readSessionCookie(input.cookieHeader, input.cookieName);
  if (!token) {
    return undefined;
  }

  const session = await input.sessions.resolveSession(token);
  if (!session || session.revokedAt !== null) {
    return undefined;
  }

  const expiresAt = effectiveExpiry(session);
  const now = input.now ?? new Date();
  if (new Date(expiresAt).getTime() <= now.getTime()) {
    return undefined;
  }

  return UserPrincipalSchema.parse({
    expiresAt,
    kind: "user",
    revokedAt: null,
    sessionId: SessionSchema.shape.sessionId.parse(session.sessionId),
    userId: SessionSchema.shape.userId.parse(session.userId),
  });
}

export function apiErrorResponse(input: {
  code: ApiErrorCode;
  message: string;
  requestId: string;
}): Response {
  const body = ApiErrorSchema.parse({
    error: {
      code: input.code,
      message: input.message,
      requestId: input.requestId,
    },
  });

  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: apiErrorStatus[input.code],
  });
}

export function unauthenticatedResponse(requestId: string): Response {
  return apiErrorResponse({
    code: "unauthenticated",
    message: "A valid browser session is required for this request.",
    requestId,
  });
}
