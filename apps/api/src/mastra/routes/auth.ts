import { createHash } from "node:crypto";
import { mintCsrfToken } from "@reasonateai/auth/csrf";
import { safeRedirectPath } from "@reasonateai/auth/redirect";
import { sessionCookie, sessionState } from "@reasonateai/auth/session-policy";
import {
  CSRF_COOKIE,
  MagicLinkAcceptedSchema,
  MagicLinkRequestSchema,
  SESSION_COOKIE,
  SessionViewSchema,
  SignedOutSchema,
} from "@reasonateai/contracts/auth";
import {
  type AuditAction,
  type AuditEvent,
  AuditEventSchema,
  type OrganizationId,
  type Principal,
  type ProjectId,
  UserPrincipalSchema,
} from "@reasonateai/contracts/identity";
import type { ProjectStateStore } from "@reasonateai/project-state/postgres";
import type { MagicLinkSender } from "../adapters/magic-link-sender";
import {
  apiErrorResponse,
  effectiveSessionExpiry,
  readCookie,
  readJsonBody,
  resolveSessionPrincipal,
  unauthenticatedResponse,
} from "../principal";
import type { HandlerContext } from "./build-sessions";

/**
 * Identity routes: starting a sign-in, redeeming a link, reading the caller's
 * own session, and ending it.
 *
 * The sign-in surface is deliberately uninformative. A link request answers the
 * same way for every address, and a link that is unknown, expired, or already
 * used is one refusal, so neither endpoint can be used to find out who has an
 * account. The token exists in exactly two places: the mailbox it is sent to
 * and the callback that redeems it. It is never echoed to the caller.
 */

export const MAGIC_LINKS_PATH = "/v1/auth/magic-links";
export const AUTH_CALLBACK_PATH = "/v1/auth/callback";
export const AUTH_SESSION_PATH = "/v1/auth/session";

/**
 * How long a sign-in link lives. It is a bearer credential delivered over
 * email, and a mailbox is not a secret store, so it is short-lived: an unread
 * message stops being usable long before it is cleaned up.
 */
const MAGIC_LINK_TTL_MS = 1000 * 60 * 15;

/**
 * Session lifetimes. Idle expiry is the deadline a working browser keeps
 * pushing back; absolute expiry bounds how long one captured cookie stays
 * useful no matter how much it is used.
 *
 * Both are exported because the store that extends a session on use must
 * extend it to the same idle window the route issued it with: two different
 * values would make the deadline the browser was told a lie.
 */
export const SESSION_IDLE_TTL_MS = 1000 * 60 * 60 * 24;
export const SESSION_ABSOLUTE_TTL_MS = 1000 * 60 * 60 * 24 * 14;

/**
 * Abuse limits for sign-in, counted per address and per requesting address.
 * They are far tighter than an organization's plan rate limit because this
 * endpoint is unauthenticated, it causes a message to be sent, and it is the
 * one place an anonymous caller can spend the product's money and reach
 * somebody else's inbox.
 */
const MAGIC_LINK_EMAIL_LIMIT = { burstPerMinute: 5, requestsPerDay: 20 };
const MAGIC_LINK_ADDRESS_LIMIT = { burstPerMinute: 20, requestsPerDay: 200 };

export interface AuthRouteDeps {
  /**
   * The secret that keys CSRF tokens. Read when a token is minted rather than
   * at import, so the artifact can be built and inspected without the
   * deployment's secrets present; a deployment that never provides one fails
   * loudly at its first sign-in instead of issuing forgeable tokens.
   */
  csrfSecret: () => string;
  /**
   * The origin a sign-in link points back at, which is this API's own public
   * address. It comes from configuration and never from the request, so a
   * caller cannot have the link mailed to a host of their choosing.
   */
  publicOrigin: string;
  /** Whether cookies are marked `Secure`; false only for plain-HTTP development. */
  secureCookies: boolean;
  sender: MagicLinkSender;
  /**
   * Resolved per request so the store is created only when the authoritative
   * database is configured, and so tests can inject their own.
   */
  store: () => ProjectStateStore;
}

/**
 * Counters are keyed by a digest rather than the address itself, so signing in
 * does not copy an email address or a client address into Redis.
 */
function rateLimitKey(kind: "address" | "email", value: string): string {
  const digest = createHash("sha256").update(value).digest("hex");
  return `identity:magic-link:${kind}:${digest}`;
}

/**
 * The caller's address as far as the trusted ingress reports it. Without a
 * proxy the caller can name this itself, which is why it only ever feeds a
 * rate-limit counter and a hashed session column — never an authorization
 * decision.
 */
function clientAddress(c: HandlerContext): string | undefined {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded && forwarded.length > 0) {
    return forwarded;
  }
  const real = c.req.header("x-real-ip")?.trim();
  return real && real.length > 0 ? real : undefined;
}

/**
 * A configured origin may be written with a trailing slash; the link is built
 * by plain concatenation, so exactly one is removed here.
 */
const TRAILING_SLASHES = /\/+$/;

/**
 * The link points at this API's callback, which is the only place a token is
 * redeemed.
 */
function magicLinkUrl(publicOrigin: string, token: string): string {
  const origin = publicOrigin.replace(TRAILING_SLASHES, "");
  return `${origin}${AUTH_CALLBACK_PATH}?token=${encodeURIComponent(token)}`;
}

/**
 * A first sign-in has no organization to name, and the caller has told us
 * exactly one thing about themselves: their address. The domain after the `@`
 * is therefore the tenant's name, and an address with no domain part — which
 * the request schema rejects, but a stored address is re-read here — falls back
 * to the generic name. An owner renames the organization afterwards.
 */
function firstOrganizationName(email: string): string {
  const separator = email.lastIndexOf("@");
  const domain = separator === -1 ? "" : email.slice(separator + 1).trim();
  return domain.length > 0 ? domain : "My organization";
}

/**
 * One builder for every security-relevant record this API writes, so the
 * schema version, the event identifier, and the observation time are produced
 * one way rather than three. The tenancy routes share it; the organization and
 * project identifiers it leaves null are the ones the store's transaction
 * generates and stamps.
 */
export function auditEvent(input: {
  action: AuditAction;
  actor: Principal;
  metadata: Record<string, boolean | null | number | string>;
  organizationId: OrganizationId | null;
  projectId: ProjectId | null;
  requestId: string;
}): AuditEvent {
  return AuditEventSchema.parse({
    action: input.action,
    actor: input.actor,
    eventId: crypto.randomUUID(),
    metadata: input.metadata,
    occurredAt: new Date().toISOString(),
    organizationId: input.organizationId,
    projectId: input.projectId,
    requestId: input.requestId,
    schemaVersion: 1,
  });
}

/**
 * The clearing half of a cookie's life. `sessionCookie` refuses a non-positive
 * Max-Age by design — a session that ends immediately is not a session — so
 * sign-out writes the immediate-expiry header itself rather than loosening
 * that rule for every other caller.
 */
function clearedCookie(
  name: string,
  options: { httpOnly: boolean; secure: boolean }
): string {
  const attributes = ["Path=/", "SameSite=Lax"];
  if (options.httpOnly) {
    attributes.push("HttpOnly");
  }
  if (options.secure) {
    attributes.push("Secure");
  }
  attributes.push("Max-Age=0");
  return `${name}=; ${attributes.join("; ")}`;
}

export function createAuthHandlers(deps: AuthRouteDeps) {
  const cookieMaxAgeSeconds = SESSION_ABSOLUTE_TTL_MS / 1000;

  return {
    /**
     * Redeems a sign-in link and establishes the browser session.
     *
     * The token is single-use by construction in the store, so a link that has
     * already been followed cannot be replayed even with the exact bytes.
     */
    callback: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();

      const token = c.req.query("token");
      const consumed = token
        ? await deps.store().magicLinks.consume({ token })
        : undefined;
      if (!consumed) {
        // Unknown, expired, and already-used are one refusal on purpose:
        // telling them apart would report whether a token ever existed.
        return apiErrorResponse({
          code: "unauthenticated",
          message: "This sign-in link is not valid. Request a new one.",
          requestId: rid,
        });
      }

      const store = deps.store();
      const account = await store.users.claimByEmail({ email: consumed.email });

      // The session is established before the organization is, so that every
      // audit event below names the user who actually acted. A tenant's trail
      // must not record a real action as one nobody took, and an actor that
      // carries a session id is the only principal the contract can express.
      const issued = await store.sessions.createSession({
        absoluteTtlMs: SESSION_ABSOLUTE_TTL_MS,
        idleTtlMs: SESSION_IDLE_TTL_MS,
        ip: clientAddress(c),
        userAgent: c.req.header("user-agent"),
        userId: account.userId,
      });
      const principal = UserPrincipalSchema.parse({
        expiresAt: effectiveSessionExpiry(issued.session),
        kind: "user",
        revokedAt: null,
        sessionId: issued.session.sessionId,
        userId: issued.session.userId,
      });

      let organizations = await store.listOrganizationMemberships({
        userId: account.userId,
      });
      if (organizations.length === 0) {
        // A first sign-in owns the organization it creates. Nothing else grants
        // owner, so this transaction is the only way an organization with an
        // owner comes to exist at all.
        const name = firstOrganizationName(consumed.email);
        const created = await store.createOrganizationWithOwner({
          audit: auditEvent({
            action: "organization.created",
            actor: principal,
            metadata: { name },
            // Generated inside the transaction, which is what makes it the
            // organization's real identifier; the store stamps the audit row
            // with it.
            organizationId: null,
            projectId: null,
            requestId: rid,
          }),
          name,
          userId: account.userId,
        });
        organizations = [
          {
            name: created.name,
            organizationId: created.organizationId,
            role: created.membershipRole,
          },
        ];
      }

      await store.audit.record(
        auditEvent({
          action: "identity.signed_in",
          actor: principal,
          metadata: { firstSignIn: account.created },
          organizationId: organizations[0]?.organizationId ?? null,
          projectId: null,
          requestId: rid,
        })
      );

      const response = new Response(null, {
        headers: { "Cache-Control": "no-store" },
        status: 303,
      });
      response.headers.append(
        "Set-Cookie",
        sessionCookie(SESSION_COOKIE, issued.token, {
          httpOnly: true,
          maxAgeSeconds: cookieMaxAgeSeconds,
          secure: deps.secureCookies,
        })
      );
      // The CSRF cookie is deliberately readable by the page's own script:
      // echoing it into the header is what proves a command came from this
      // origin's code, and a script that cannot read it cannot echo it.
      response.headers.append(
        "Set-Cookie",
        sessionCookie(
          CSRF_COOKIE,
          mintCsrfToken({
            secret: deps.csrfSecret(),
            sessionId: issued.session.sessionId,
          }),
          {
            httpOnly: false,
            maxAgeSeconds: cookieMaxAgeSeconds,
            secure: deps.secureCookies,
          }
        )
      );
      response.headers.set(
        "Location",
        safeRedirectPath(c.req.query("redirectTo"), { fallback: "/" })
      );

      return response;
    },

    /**
     * The caller's own session. It reports the session's clocks and the
     * caller's tenancy, and never the token that authenticates it.
     */
    readSession: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();

      const sessionToken = readCookie(c.req.header("cookie"), SESSION_COOKIE);
      const store = deps.store();
      // The session row itself, rather than only a principal, because the view
      // reports both of its deadlines. Whether it may still be used is the
      // shared session policy's decision, not this route's.
      const session = sessionToken
        ? await store.sessions.resolveSession(sessionToken)
        : undefined;
      if (!session || sessionState({ now: new Date(), session }) !== "active") {
        return unauthenticatedResponse(rid);
      }

      const response = c.json(
        SessionViewSchema.parse({
          absoluteExpiresAt: session.absoluteExpiresAt,
          idleExpiresAt: session.idleExpiresAt,
          organizations: await store.listOrganizationMemberships({
            userId: session.userId,
          }),
          sessionId: session.sessionId,
          userId: session.userId,
        }),
        200
      );
      // One user's session view must never be served from a shared cache.
      response.headers.set("Cache-Control", "no-store");
      return response;
    },
    /**
     * Starts a sign-in. The answer carries only the acceptance deadline, which
     * is the same fact whether or not the address has an account, so this
     * endpoint cannot be used to enumerate users.
     */
    requestMagicLink: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();

      const body = MagicLinkRequestSchema.safeParse(await readJsonBody(c.req));
      if (!body.success) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "A valid email address is required.",
          requestId: rid,
        });
      }

      const address = clientAddress(c);
      // Both windows are consumed before either answer is read, so a refused
      // request still costs its caller the slot it took in every window it is
      // over rather than resetting its own counter.
      const perEmail = await deps.store().rateLimiter.consumeKey({
        ...MAGIC_LINK_EMAIL_LIMIT,
        key: rateLimitKey("email", body.data.email.toLowerCase()),
      });
      const perAddress = await deps.store().rateLimiter.consumeKey({
        ...MAGIC_LINK_ADDRESS_LIMIT,
        key: rateLimitKey("address", address ?? "unknown"),
      });

      if (!(perEmail.allowed && perAddress.allowed)) {
        const response = apiErrorResponse({
          code: "rate_limited",
          message:
            "Too many sign-in links have been requested. Try again shortly.",
          requestId: rid,
        });
        response.headers.set(
          "Retry-After",
          String(
            Math.max(
              1,
              perEmail.retryAfterSeconds ?? 0,
              perAddress.retryAfterSeconds ?? 0
            )
          )
        );
        return response;
      }

      const issued = await deps.store().magicLinks.issue({
        email: body.data.email,
        ip: address,
        ttlMs: MAGIC_LINK_TTL_MS,
      });

      // The only moment the token leaves the database in plaintext is the
      // delivery call; the response never carries it.
      await deps.sender.send({
        email: body.data.email,
        url: magicLinkUrl(deps.publicOrigin, issued.token),
      });

      return c.json(
        MagicLinkAcceptedSchema.parse({
          expiresAt: issued.expiresAt.toISOString(),
        }),
        202
      );
    },

    /**
     * Ends the caller's session. Revocation is what makes it immediate: the
     * next request presenting the same cookie has no live session to resolve,
     * whatever the browser still holds. CSRF is enforced by the middleware in
     * front of this route, like every other state-changing command.
     */
    signOut: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();

      const store = deps.store();
      const principal = await resolveSessionPrincipal({
        cookieHeader: c.req.header("cookie"),
        sessions: store.sessions,
      });
      if (!principal) {
        return unauthenticatedResponse(rid);
      }

      const revoked = await store.sessions.revokeSession(principal.sessionId);
      const [organization] = await store.listOrganizationMemberships({
        userId: principal.userId,
      });

      await store.audit.record(
        auditEvent({
          action: "identity.signed_out",
          actor: principal,
          metadata: { revoked },
          organizationId: organization?.organizationId ?? null,
          projectId: null,
          requestId: rid,
        })
      );

      const response = c.json(SignedOutSchema.parse({ revoked }), 200);
      response.headers.append(
        "Set-Cookie",
        clearedCookie(SESSION_COOKIE, {
          httpOnly: true,
          secure: deps.secureCookies,
        })
      );
      response.headers.append(
        "Set-Cookie",
        clearedCookie(CSRF_COOKIE, {
          httpOnly: false,
          secure: deps.secureCookies,
        })
      );
      response.headers.set("Cache-Control", "no-store");
      return response;
    },
  };
}
