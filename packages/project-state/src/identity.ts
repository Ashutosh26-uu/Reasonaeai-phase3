import { createHash, randomUUID } from "node:crypto";
import { UserIdSchema } from "@reasonateai/contracts/identity";
import type { Pool, PoolClient } from "pg";

export function createIdentityRepository(
  pool: Pool,
  transaction: <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>
) {
  const digest = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  return {
    beginOidc: async (state: string) => {
      // Bounded retention, including abandoned and consumed attempts.
      await pool.query(
        "delete from identity_oidc_requests where expires_at < now()"
      );
      await pool.query(
        "insert into identity_oidc_requests(state_hash, expires_at) values ($1, now() + interval '10 minutes')",
        [digest(state)]
      );
    },
    claimGoogle: async (input: { email: string; subject: string }) =>
      transaction(async (client) => {
        // Serialize identity linking and email claims; the subject is the durable identity.
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [input.subject]
        );
        const linked = await client.query<{ user_id: string }>(
          "select user_id from identity_provider_accounts where provider = 'google' and subject = $1",
          [input.subject]
        );
        const [existing] = linked.rows;
        if (existing) {
          return {
            created: false,
            userId: UserIdSchema.parse(existing.user_id),
          };
        }
        const inserted = await client.query<{ user_id: string }>(
          `insert into users(user_id, primary_email) values ($1, $2)
           on conflict ((lower(primary_email))) where primary_email is not null do nothing returning user_id`,
          [randomUUID(), input.email]
        );
        const selected =
          inserted.rows[0] ??
          (
            await client.query<{ user_id: string }>(
              "select user_id from users where lower(primary_email) = lower($1)",
              [input.email]
            )
          ).rows[0];
        if (!selected) {
          throw new Error("Verified identity could not be claimed.");
        }
        await client.query(
          "insert into identity_provider_accounts(provider, subject, user_id) values ('google', $1, $2)",
          [input.subject, selected.user_id]
        );
        return {
          created: inserted.rowCount === 1,
          userId: UserIdSchema.parse(selected.user_id),
        };
      }),
    consumeOidc: async (state: string) => {
      const result = await pool.query(
        "update identity_oidc_requests set consumed_at = now() where state_hash = $1 and consumed_at is null and expires_at > now() returning state_hash",
        [digest(state)]
      );
      return result.rowCount === 1;
    },
  };
}
