import { isStateChangingMethod, verifyCsrfToken } from "@reasonateai/auth/csrf";
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
} from "@reasonateai/contracts/auth";
import type { SessionRepository } from "@reasonateai/project-state/sessions";
import { apiErrorResponse, readCookie } from "./principal";

/**
 * CSRF and origin enforcement for the product routes.
 *
 * A browser sends its cookies on any request a page it is visiting makes, so
 * the session cookie alone cannot prove that the browser's user meant to issue
 * a command. Two checks close that gap for every state-changing method:
 *
 * - The CSRF header must carry a token that matches the CSRF cookie and
 *   verifies against the session the request presents. The cookie is readable
 *   by the page's own script and by nobody else, so echoing it in a header
 *   proves the request came from this origin's own code rather than from a
 *   form or a cross-site fetch the browser issued on the user's behalf.
 * - An `Origin` header, when the browser sends one, must name an origin this
 *   API serves. A request whose origin is somewhere else is refused even if
 *   its token somehow verified.
 *
 * Safe methods are not guarded, which is what leaves `GET /v1/auth/callback`
 * reachable: a sign-in link is followed by a top-level browser navigation that
 * carries no script and no token, so it must not be blocked by a check it can
 * never satisfy. Only the state-changing methods in `isStateChangingMethod` are.
 */

/** The product routes: everything outside the blocked built-in `/api` groups. */
export const PRODUCT_ROUTES_PATH = "/v1/*";

/**
 * The subset of a Hono context this middleware reads, declared structurally so
 * it can be driven directly in a test without a server.
 */
export interface MiddlewareContext {
  req: {
    header: (name: string) => string | undefined;
    method: string;
  };
}

export type NextFunction = () => Promise<void>;

export interface CsrfMiddlewareConfig {
  /**
   * The secret that keys CSRF tokens. Read when a token is verified rather than
   * at import, so the artifact can be built and inspected without the
   * deployment's secrets present.
   */
  csrfSecret: () => string;
  /** Origins allowed to issue browser commands, matched exactly. */
  origins: readonly string[];
  /**
   * Resolved per request so the store is created only when the authoritative
   * database is configured, and so a test can inject its own.
   */
  sessions: () => SessionRepository;
}

/**
 * One refusal shape for both failures. It says what is wrong without echoing
 * the presented token, and it never reveals whether the session exists.
 */
function csrfRefusal(requestId: string, message: string): Response {
  return apiErrorResponse({ code: "forbidden", message, requestId });
}

export function createCsrfMiddleware(config: CsrfMiddlewareConfig): {
  handler: (
    c: MiddlewareContext,
    next: NextFunction
  ) => Promise<Response | undefined>;
  path: string;
} {
  return {
    handler: async (c, next) => {
      if (!isStateChangingMethod(c.req.method)) {
        await next();
        return;
      }

      const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();

      const origin = c.req.header("origin");
      if (origin !== undefined && !config.origins.includes(origin)) {
        return csrfRefusal(
          requestId,
          "This request came from an origin the API does not serve, so it was refused."
        );
      }

      const cookieHeader = c.req.header("cookie");
      const sessionToken = readCookie(cookieHeader, SESSION_COOKIE);
      if (!sessionToken) {
        // Nothing to bind a token to. Sign-in itself is a state-changing
        // request made before the caller has a session, and every command that
        // does need one answers its own typed 401.
        await next();
        return;
      }

      const session = await config.sessions().resolveSession(sessionToken);
      if (!session || session.revokedAt !== null) {
        // A dead session cannot be CSRF-verified either; the route refuses it
        // as unauthenticated, which is the same answer a forged cookie gets.
        await next();
        return;
      }

      const presented = c.req.header(CSRF_HEADER);
      const expected = readCookie(cookieHeader, CSRF_COOKIE);
      if (
        !(presented && expected) ||
        presented !== expected ||
        !verifyCsrfToken({
          secret: config.csrfSecret(),
          sessionId: session.sessionId,
          token: presented,
        })
      ) {
        return csrfRefusal(
          requestId,
          "A valid CSRF token is required for this request."
        );
      }

      await next();
    },
    path: PRODUCT_ROUTES_PATH,
  };
}
