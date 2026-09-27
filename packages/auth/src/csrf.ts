import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * CSRF policy for browser sessions.
 *
 * The token is a keyed digest of the session id, so it is bound to exactly one
 * session: a token minted for another session, or for this session under
 * another secret, never verifies. Nothing here reads the environment or the
 * clock; the routes own the secret and the cookie, so every branch below is
 * reachable from a test.
 */

/** Methods that change state, and so must present a CSRF token. */
const stateChangingMethods: Readonly<Record<string, true>> = {
  DELETE: true,
  PATCH: true,
  POST: true,
  PUT: true,
};

/**
 * The raw HMAC-SHA256 bytes a session's token must equal, shared by minting and
 * verification so the two can never disagree about the formula. The secret is
 * the only thing that makes the digest unpredictable, and an empty one would
 * still produce a stable, guessable value, so a caller that forgot to configure
 * one fails loudly instead of issuing forgeable tokens.
 */
const csrfDigest = (secret: string, sessionId: string): Buffer => {
  if (secret.length === 0) {
    throw new RangeError("CSRF secret must be a non-empty string.");
  }
  return createHmac("sha256", secret).update(sessionId).digest();
};

/** The token a browser must echo back for one session, as base64url text. */
export const mintCsrfToken = (input: {
  secret: string;
  sessionId: string;
}): string => csrfDigest(input.secret, input.sessionId).toString("base64url");

/**
 * Whether the presented token is this session's token. A wrong token is a
 * refusal, never an exception, because the value arrives from the network.
 */
export const verifyCsrfToken = (input: {
  secret: string;
  sessionId: string;
  token: string;
}): boolean => {
  const expected = csrfDigest(input.secret, input.sessionId);
  const presented = Buffer.from(input.token, "base64url");
  // A digest has a fixed published size, so learning that a presented token is
  // the wrong length reveals nothing; checking it first also keeps
  // timingSafeEqual, which throws on unequal lengths, out of reach of input
  // that chooses its own size.
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  );
};

/** Whether a request method mutates state and therefore needs a CSRF token. */
export const isStateChangingMethod = (method: string): boolean =>
  stateChangingMethods[method.toUpperCase()] === true;
