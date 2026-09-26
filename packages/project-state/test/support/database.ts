import { setTimeout as wait } from "node:timers/promises";
import type { Pool } from "pg";

/** Postgres kills one side when two sessions lock shared tables in opposite orders. */
const RETRYABLE_CODES: Record<string, true> = {
  "40P01": true,
  "55P03": true,
};

const ATTEMPTS = 5;
const RETRY_DELAY_MS = 150;

function isRetryable(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  const { code } = error;
  return typeof code === "string" && RETRYABLE_CODES[code] === true;
}

async function attemptTeardown(
  run: () => Promise<void>,
  attempt: number
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (attempt >= ATTEMPTS || !isRetryable(error)) {
      throw error;
    }

    await wait(RETRY_DELAY_MS * attempt);
    await attemptTeardown(run, attempt + 1);
  }
}

/**
 * Removes fixture rows with the retry a shared database needs.
 *
 * Every file in this suite shares one database, and these deletes cascade into
 * everything the fixture owns. A file tearing its fixtures down while another
 * file — or another package's suite — is still writing, or while a concurrent
 * `migrate()` is locking the same parent and child tables, takes those tables
 * in the opposite order, which Postgres breaks by killing one of the two. The
 * teardown retries instead of failing a suite whose behaviour was correct.
 */
export async function deleteFixtures(
  pool: Pool,
  statement: string,
  parameters: readonly unknown[]
): Promise<void> {
  await attemptTeardown(async () => {
    await pool.query(statement, [...parameters]);
  }, 1);
}

/** Removes fixture organizations, which cascade into the projects they own. */
export async function deleteOrganizations(
  pool: Pool,
  organizationIds: readonly string[]
): Promise<void> {
  if (organizationIds.length === 0) {
    return;
  }

  await deleteFixtures(
    pool,
    "delete from organizations where organization_id = any($1::uuid[])",
    [organizationIds]
  );
}
