import { setTimeout as wait } from "node:timers/promises";
import type { Pool } from "pg";

/** Postgres kills one side when two sessions lock shared tables in opposite orders. */
const RETRYABLE_CODES = new Set(["40P01", "55P03"]);

const ATTEMPTS = 5;
const RETRY_DELAY_MS = 150;

function isRetryable(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  const { code } = error;
  return typeof code === "string" && RETRYABLE_CODES.has(code);
}

async function attemptOrganizationsDelete(
  pool: Pool,
  organizationIds: readonly string[],
  attempt: number
): Promise<void> {
  try {
    await pool.query(
      "delete from organizations where organization_id = any($1::uuid[])",
      [organizationIds]
    );
  } catch (error) {
    if (attempt >= ATTEMPTS || !isRetryable(error)) {
      throw error;
    }

    await wait(RETRY_DELAY_MS * attempt);
    await attemptOrganizationsDelete(pool, organizationIds, attempt + 1);
  }
}

/**
 * Removes fixture organizations.
 *
 * Every file in this suite shares one database, and deleting an organization
 * cascades into projects, build sessions, the event ledger, the outbox and the
 * usage counters. A file tearing its fixtures down while another file — or
 * another package's suite — is still writing takes those tables in the opposite
 * order, which Postgres breaks by killing one of the two. The teardown retries
 * instead of failing a suite whose behaviour was correct.
 */
export async function deleteOrganizations(
  pool: Pool,
  organizationIds: readonly string[]
): Promise<void> {
  await attemptOrganizationsDelete(pool, organizationIds, 1);
}
