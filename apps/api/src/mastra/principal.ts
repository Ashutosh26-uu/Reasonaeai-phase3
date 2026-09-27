import {
  type ApiErrorCode,
  ApiErrorSchema,
  apiErrorStatus,
} from "@reasonateai/contracts/api-error";
import { SESSION_COOKIE } from "@reasonateai/contracts/auth";
import {
  SessionSchema,
  type UserPrincipal,
  UserPrincipalSchema,
} from "@reasonateai/contracts/identity";
import type { SessionRepository } from "@reasonateai/project-state/sessions";

export const PRINCIPAL_CONTEXT_KEY = "reasonateai.principal";

/**
 * Reads one cookie from a `Cookie` header without decoding or normalizing the
 * value. Session tokens and CSRF tokens are base64url and contain no
 * separators, so the value is taken verbatim and never URL-decoded into a
 * different value. This is the only cookie parser in the API: the session
 * cookie and its CSRF companion are read by the same rules.
 */
export function readCookie(
  cookieHeader: string | undefined,
  name: string
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

/**
 * The earlier of a session's two deadlines, which is the moment trust in it
 * ends. Idle expiry moves with activity and absolute expiry does not, so
 * whichever comes first is the one a principal may rely on.
 */
export function effectiveSessionExpiry(session: {
  absoluteExpiresAt: string;
  idleExpiresAt: string;
}): string {
  return new Date(session.idleExpiresAt).getTime() <
    new Date(session.absoluteExpiresAt).getTime()
    ? session.idleExpiresAt
    : session.absoluteExpiresAt;
}

/**
 * The body of a request, or `undefined` when it is not JSON at all. A caller
 * that sends a body this API cannot read is a boundary failure like any other
 * invalid input, so it is answered with the route's typed refusal rather than
 * escaping as a framework-level 500.
 */
export async function readJsonBody(request: {
  json: () => Promise<unknown>;
}): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
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
  const token = readCookie(
    input.cookieHeader,
    input.cookieName ?? SESSION_COOKIE
  );
  if (!token) {
    return undefined;
  }

  const session = await input.sessions.resolveSession(token);
  if (!session || session.revokedAt !== null) {
    return undefined;
  }

  const expiresAt = effectiveSessionExpiry(session);
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
