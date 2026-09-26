import type { Session } from "@reasonateai/contracts/identity";

/**
 * Session lifecycle policy.
 *
 * A session is judged only against the clocks it carries and the injected
 * `now`, so the routes can decide whether a request may proceed, whether the
 * cookie should be reissued, and what to write on the wire without reading the
 * clock themselves. Ordering is deliberate: revocation is an explicit decision
 * that outranks both deadlines.
 */

/** How a session reads at one instant. */
export type SessionState = "revoked" | "expired" | "idle_expired" | "active";

/**
 * How the session reads now. A revoked session is never active, even while its
 * absolute and idle deadlines both still lie in the future, and an absolute
 * deadline outranks the idle one because it cannot be extended by activity.
 */
export const sessionState = (input: {
  now: Date;
  session: Session;
}): SessionState => {
  const { now, session } = input;
  if (session.revokedAt !== null) {
    return "revoked";
  }
  const nowTime = now.getTime();
  if (nowTime >= Date.parse(session.absoluteExpiresAt)) {
    return "expired";
  }
  if (nowTime >= Date.parse(session.idleExpiresAt)) {
    return "idle_expired";
  }
  return "active";
};

/**
 * Whether the session is old enough to reissue. True only once it is strictly
 * older than the rotation interval, so a session sitting exactly on the
 * interval is left alone; a session that is revoked or past either deadline is
 * never rotated, because rotating it would hand out a fresh credential for a
 * session that must stay dead.
 */
export const shouldRotateSession = (input: {
  now: Date;
  rotateAfterMs: number;
  session: Session;
}): boolean => {
  const { now, rotateAfterMs, session } = input;
  if (sessionState({ now, session }) !== "active") {
    return false;
  }
  return now.getTime() - Date.parse(session.createdAt) > rotateAfterMs;
};

/** RFC 6265 token characters, which are what a cookie name may contain. */
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * The RFC 6265 cookie-octet set, written as the allowlist inverted: printable
 * ASCII except space, quote, comma, semicolon, and backslash. A value carrying
 * anything else could end its own attribute or inject a header of its own.
 */
const INVALID_COOKIE_VALUE = /[^\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]/;

/**
 * The `Set-Cookie` value for a session cookie. `HttpOnly` and `Secure` are
 * emitted only when the caller asks, because dev-mode sign-in runs over plain
 * HTTP on a host `Secure` would make the cookie undeliverable. `Max-Age` must
 * be a positive integer: a non-positive one is the caller asking to clear the
 * cookie, which this serializer does not express.
 */
export const sessionCookie = (
  name: string,
  value: string,
  options: { httpOnly: boolean; maxAgeSeconds: number; secure: boolean }
): string => {
  if (!COOKIE_NAME.test(name)) {
    throw new TypeError("Session cookie name must be an RFC 6265 token.");
  }
  if (INVALID_COOKIE_VALUE.test(value)) {
    throw new TypeError(
      "Session cookie value must contain only RFC 6265 cookie-octets."
    );
  }
  const { httpOnly, maxAgeSeconds, secure } = options;
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new RangeError(
      "Session cookie Max-Age must be a positive integer number of seconds."
    );
  }

  const attributes = ["Path=/", "SameSite=Lax"];
  if (httpOnly) {
    attributes.push("HttpOnly");
  }
  if (secure) {
    attributes.push("Secure");
  }
  attributes.push(`Max-Age=${maxAgeSeconds}`);
  return `${name}=${value}; ${attributes.join("; ")}`;
};
