import {
  type AuditEvent,
  AuditEventSchema,
  type OrganizationId,
} from "@reasonateai/contracts/identity";
import type { Pool, PoolClient } from "pg";

export interface AuditRepository {
  /**
   * The organization's trail, most recent first. Archived rather than deleted:
   * an event that falls outside a bounded read is still there for the next one.
   */
  listForOrganization: (input: {
    limit: number;
    organizationId: OrganizationId;
  }) => Promise<AuditEvent[]>;
  record: (event: AuditEvent) => Promise<void>;
}

const INSERT_AUDIT_EVENT_SQL = `
insert into audit_events
  (event_id, organization_id, project_id, action, actor, occurred_at, metadata,
   request_id)
values ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8)
`;

const SELECT_AUDIT_EVENTS_SQL = `
select event_id, organization_id, project_id, action, actor, occurred_at,
       metadata, request_id
  from audit_events
 where organization_id = $1
 order by occurred_at desc, event_id asc
 limit $2
`;

/**
 * `schema_version` is a literal in the contract and the table stores v1 events
 * only, so the version is supplied on read rather than kept in a column that
 * could only ever hold the same value. A row that cannot be decoded as a v1
 * event is a corrupt row, and parsing it aloud is better than returning it.
 */
function toAuditEvent(row: Record<string, unknown>): AuditEvent {
  return AuditEventSchema.parse({
    action: row.action,
    actor: row.actor,
    eventId: row.event_id,
    metadata: row.metadata,
    occurredAt: (row.occurred_at as Date).toISOString(),
    organizationId: row.organization_id ?? null,
    projectId: row.project_id ?? null,
    requestId: row.request_id,
    schemaVersion: 1,
  });
}

/**
 * Writes one event through a connection the caller already has open.
 *
 * A security-relevant change and the record of it belong in one transaction:
 * the caller passes the transaction that makes the change, so an audit event
 * cannot describe a change that rolled back, and a change cannot commit
 * unrecorded. `record` is this on its own connection, for events that stand
 * alone.
 */
export async function recordWith(
  client: Pool | PoolClient,
  event: AuditEvent
): Promise<void> {
  const parsed = AuditEventSchema.parse(event);

  await client.query(INSERT_AUDIT_EVENT_SQL, [
    parsed.eventId,
    parsed.organizationId,
    parsed.projectId,
    parsed.action,
    JSON.stringify(parsed.actor),
    parsed.occurredAt,
    JSON.stringify(parsed.metadata),
    parsed.requestId,
  ]);
}

export function createAuditRepository(pool: Pool): AuditRepository {
  return {
    listForOrganization: async ({ limit, organizationId }) => {
      const result = await pool.query(SELECT_AUDIT_EVENTS_SQL, [
        organizationId,
        limit,
      ]);

      return result.rows.map((row) => toAuditEvent(row));
    },

    record: async (event) => {
      await recordWith(pool, event);
    },
  };
}
