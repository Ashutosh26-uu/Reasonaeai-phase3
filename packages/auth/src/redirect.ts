/**
 * Open-redirect policy for the post-authentication bounce.
 *
 * The only value that survives is a path this origin can serve. `//host` and
 * `/\host` are absolutes that leave the origin, a scheme changes the origin
 * outright, and a control character can split a response header. A caller may
 * pass back a value that was percent-encoded for transport, so every accepted
 * form is inspected again after decoding: `/%2f%2fevil.example` and
 * `/%252f%252fevil.example` are both refused.
 */

/** Control characters — C0, DEL, and C1 — which must never reach a header. */
const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * A leading `scheme:` addresses another origin. The absolute-path rule below
 * already excludes one, but the guard is kept explicit because this is the
 * decision the module exists to make.
 */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A percent-encoded backslash, or a percent-encoded control byte such as `%0d`
 * or `%00`. Encoding either is never meaningful in a path, so the escape itself
 * is refused even when neighbours make the value undecodable as a whole.
 */
const ENCODED_CONTROL_OR_BACKSLASH = /%(?:0[0-9a-f]|1[0-9a-f]|5c|7f)/i;

/** How many decoding rounds a target may survive before it counts as obscured. */
const MAX_DECODE_ROUNDS = 3;

/** Whether one form of the target is a path this origin can serve. */
const isSafePath = (candidate: string): boolean => {
  if (SCHEME.test(candidate)) {
    return false;
  }
  if (!candidate.startsWith("/")) {
    return false;
  }
  if (candidate.startsWith("//") || candidate.startsWith("/\\")) {
    return false;
  }
  if (candidate.includes("\\")) {
    return false;
  }
  if (CONTROL_CHARACTER.test(candidate)) {
    return false;
  }
  return !ENCODED_CONTROL_OR_BACKSLASH.test(candidate);
};

/**
 * One decoding round. `undefined` means inspection is over: the value cannot be
 * decoded at all, or decoded to itself.
 */
const decodeRound = (value: string): string | undefined => {
  try {
    const decoded = decodeURIComponent(value);
    return decoded === value ? undefined : decoded;
  } catch {
    return undefined;
  }
};

/**
 * The target when it is a verified same-origin absolute path, and the caller's
 * fallback otherwise. Every other input — absent, empty, relative, absolute,
 * escaping, or obscured by encoding — is a refusal.
 */
export const safeRedirectPath = (
  target: string | null | undefined,
  options: { fallback: string }
): string => {
  const { fallback } = options;
  if (typeof target !== "string" || target.length === 0) {
    return fallback;
  }

  let candidate = target;
  for (let round = 0; round <= MAX_DECODE_ROUNDS; round += 1) {
    if (!isSafePath(candidate)) {
      return fallback;
    }
    const decoded = decodeRound(candidate);
    if (decoded === undefined) {
      // Every layer of this value stayed a safe path; return it as received
      // rather than the decoded form, which is only inspection material.
      return target;
    }
    candidate = decoded;
  }

  // Still changing after every round: nothing a caller could legitimately have
  // encoded, so it is refused.
  return fallback;
};
