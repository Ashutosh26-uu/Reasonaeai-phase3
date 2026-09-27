import { createHash, randomBytes } from "node:crypto";
import { type UserId, UserIdSchema } from "@reasonateai/contracts/identity";
import type { Pool } from "pg";

export interface IssuedMagicLink {
  /** The only moment the token exists in plaintext. Never persisted or logged. */
  expiresAt: Date;
  token: string;
}

export interface ConsumedMagicLink {
  email: string;
  expiresAt: Date;
  /**
   * The account the address already belonged to when the link was issued, or
   * `null` for an address nobody has signed in with yet. Resolving the account
   * is the caller's next step, not the link's.
   */
  userId: UserId | null;
}

export interface MagicLinkRepository {
  /**
   * Redeems a link, returning its address, or `undefined` when the token is
   * unknown, expired, or already used. The three are deliberately
   * indistinguishable to the caller.
   */
  consume: (input: { token: string }) => Promise<ConsumedMagicLink | undefined>;
  /**
   * Issues one single-use link for an address.
   *
   * The response is the same whether or not the address has an account, and it
   * is produced from one insert, so issuing a link cannot be used to enumerate
   * users and costs one round trip.
   */
  issue: (input: {
    email: string;
    ip?: string;
    ttlMs: number;
  }) => Promise<IssuedMagicLink>;
}

const TOKEN_BYTES = 32;

/**
 * A magic link is a random bearer value, so a fast digest is enough: a slow
 * password KDF would add latency to every sign-in for a token nobody can guess,
 * and the digest exists only so that a database read cannot be replayed as a
 * link.
 */
const digest = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

/**
 * The token is hashed before it is stored, and it is written with the account it
 * already resolves to — if any — in the same statement, so issuing a link needs
 * one round trip and cannot disagree with the account table.
 */
const INSERT_MAGIC_LINK_SQL = `
insert into magic_link_tokens (token_hash, email, user_id, ip, expires_at)
values ($1, $2, (select user_id from users where lower(primary_email) = lower($2)),
        $3, now() + make_interval(secs => $4::double precision))
returning expires_at
`;

/**
 * Consumption is one conditional update, which is what makes a link
 * single-use: the row is locked for the update, a concurrent redeemer blocks on
 * it, and by the time that second statement re-evaluates the predicate
 * `consumed_at` is set, so it updates nothing and sees no row. Expiry is part
 * of the same predicate, so an expired link is refused at the moment of use
 * rather than by a sweep that may not have run.
 */
const CONSUME_MAGIC_LINK_SQL = `
update magic_link_tokens
   set consumed_at = now()
 where token_hash = $1
   and consumed_at is null
   and expires_at > now()
returning email, expires_at, user_id
`;

export function createMagicLinkRepository(pool: Pool): MagicLinkRepository {
  return {
    consume: async ({ token }) => {
      const result = await pool.query<{
        email: string;
        expires_at: Date;
        user_id: string | null;
      }>(CONSUME_MAGIC_LINK_SQL, [digest(token)]);

      const [row] = result.rows;
      return row
        ? {
            email: row.email,
            expiresAt: row.expires_at,
            userId:
              row.user_id === null ? null : UserIdSchema.parse(row.user_id),
          }
        : undefined;
    },

    issue: async (input) => {
      const token = randomBytes(TOKEN_BYTES).toString("base64url");
      const result = await pool.query<{ expires_at: Date }>(
        INSERT_MAGIC_LINK_SQL,
        [digest(token), input.email, input.ip ?? null, input.ttlMs / 1000]
      );

      const [row] = result.rows;
      if (!row) {
        throw new Error("Magic link insert returned no row.");
      }

      return { expiresAt: row.expires_at, token };
    },
  };
}
