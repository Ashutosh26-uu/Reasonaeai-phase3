import { exportSchemas, PostgresStore } from "@mastra/pg";

/**
 * The durable Mastra store.
 *
 * Conversations, their threads, and their messages are agent state that has to
 * outlive the process that produced them: a browser reconnects to a project and
 * expects the whole conversation, and the worker that executes a run is a
 * different process from the API that queued it. Both therefore point at the
 * same PostgreSQL database, in their own schema so Mastra's tables are not
 * interleaved with the control plane's, and the store owns its own connection
 * pool because neither the API nor the worker may be handed the other's.
 *
 * There is no local-file fallback. A missing `DATABASE_URL` is already fatal
 * for the authoritative store, and a second, silently different place for
 * conversation history is exactly the defect this replaces.
 */
export const MASTRA_STORAGE_SCHEMA = "mastra";

/**
 * The agent platform's tables, as the DDL this repository's migration step
 * applies.
 *
 * Exported from the adapter rather than written here, so the schema is the one
 * the installed version of the store actually reads, and it is applied inside
 * the same advisory-locked, retried transaction as the control plane's schema.
 * Lazy creation on first use would instead let the API and the worker race the
 * same DDL the first time either of them touched a conversation.
 */
export const MASTRA_STORAGE_MIGRATION_SQL = exportSchemas(
  MASTRA_STORAGE_SCHEMA
);

export interface MastraStorageConfig {
  connectionString: string;
  /** Tables are created by the store on first use unless init is disabled. */
  disableInit?: boolean | undefined;
  schemaName?: string | undefined;
}

/**
 * A store whose tables are created by this repository's migration step, never
 * lazily. The default is `disableInit: true` for that reason: two processes
 * lazy-initializing one schema at the same moment is a lock conflict over DDL
 * that is not application work.
 */
export function createMastraStorage(
  config: MastraStorageConfig
): PostgresStore {
  return new PostgresStore({
    connectionString: config.connectionString,
    disableInit: config.disableInit ?? true,
    id: "reasonate-mastra-storage",
    schemaName: config.schemaName ?? MASTRA_STORAGE_SCHEMA,
  });
}
