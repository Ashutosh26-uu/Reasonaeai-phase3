import { randomUUID } from "node:crypto";
import { type UserId, UserIdSchema } from "@reasonateai/contracts/identity";
import type { Pool } from "pg";

export interface UserRepository {
  /**
   * Resolves the account an email belongs to, creating it on first sight.
   *
   * `created` reports whether this call is the one that created the row, so a
   * caller can tell a first sign-in from a returning one without a second read.
   *
   * Two sign-ins racing the same address must converge on one account, so the
   * insert defers to the unique index on the lowercased address and the select
   * that follows reads whichever of the two committed first. A race that the
   * index cannot resolve — two different addresses, two different users — is
   * two inserts of two primary keys, which is why nothing here serializes.
   */
  claimByEmail: (input: {
    email: string;
  }) => Promise<{ created: boolean; userId: UserId }>;
}

const INSERT_USER_SQL = `
insert into users (user_id, primary_email)
values ($1, $2)
on conflict ((lower(primary_email))) where primary_email is not null
do nothing
returning user_id
`;

/**
 * Addresses are compared lowercased because the same person types their address
 * in whatever case they please, and the index that makes the claim idempotent
 * is on the lowercase form.
 */
const SELECT_USER_BY_EMAIL_SQL = `
select user_id from users where lower(primary_email) = lower($1)
`;

export function createUserRepository(pool: Pool): UserRepository {
  return {
    claimByEmail: async ({ email }) => {
      const inserted = await pool.query<{ user_id: string }>(INSERT_USER_SQL, [
        randomUUID(),
        email,
      ]);

      const [insertedRow] = inserted.rows;
      if (insertedRow) {
        return {
          created: true,
          userId: UserIdSchema.parse(insertedRow.user_id),
        };
      }

      const existing = await pool.query<{ user_id: string }>(
        SELECT_USER_BY_EMAIL_SQL,
        [email]
      );

      const [existingRow] = existing.rows;
      if (!existingRow) {
        throw new Error(
          "The address is claimed by a user that this connection cannot read."
        );
      }

      return {
        created: false,
        userId: UserIdSchema.parse(existingRow.user_id),
      };
    },
  };
}
