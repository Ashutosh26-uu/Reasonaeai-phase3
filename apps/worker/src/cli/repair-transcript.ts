import { BuildSessionIdSchema } from "@reasonateai/contracts/execution";
import { RunEventEnvelopeSchema } from "@reasonateai/contracts/execution-protocol";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
} from "@reasonateai/contracts/identity";
import { createProjectStateStore } from "@reasonateai/project-state/postgres";
import { Pool } from "pg";
import { recoverTranscript } from "../transcript-recovery.js";

// Explicit scope is mandatory. Default is a read-only preview; no raw message
// content, credentials, or reasoning is written to operational logs.
const [organization, project, session, mode] = process.argv.slice(2);
const scope = {
  organizationId: OrganizationIdSchema.parse(organization),
  projectId: ProjectIdSchema.parse(project),
};
const buildSessionId = BuildSessionIdSchema.parse(session);
if (mode !== undefined && mode !== "--apply") {
  throw new Error(
    "Expected optional --apply after organization, project and session IDs"
  );
}
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}
const pool = new Pool({ connectionString });
const store = createProjectStateStore({ connectionString });
const client = await pool.connect();
try {
  await client.query(
    "select pg_advisory_lock(hashtext('reasonate-transcript-repair'), hashtext($1))",
    [buildSessionId]
  );
  const candidates = await client.query(
    `
    select e.*, m.content,
      (select coalesce(jsonb_agg(distinct t.payload->>'toolCallId'), '[]'::jsonb)
       from run_events t where t.run_id=e.run_id and t.organization_id=e.organization_id
       and t.project_id=e.project_id and t.payload->>'toolCallId' is not null) as tool_ids
    from run_events e join runs r on r.run_id=e.run_id
      and r.organization_id=e.organization_id and r.project_id=e.project_id
    join public.mastra_messages m on m.id=e.payload->>'messageId'
      and m.thread_id=r.build_session_id::text and m."resourceId"=r.project_id::text and m.role='assistant'
    where r.build_session_id=$1 and r.organization_id=$2 and r.project_id=$3
      and r.status in ('completed','failed','cancelled')
      and e.payload->>'kind'='message_end' and e.payload->>'role'='assistant'
      and not exists (select 1 from run_events s where s.run_id=e.run_id
        and s.organization_id=e.organization_id and s.project_id=e.project_id
        and s.payload->'snapshot'->>'messageId'=e.payload->>'messageId')
    order by r.created_at, e.sequence`,
    [buildSessionId, scope.organizationId, scope.projectId]
  );
  for (const row of candidates.rows) {
    const event = RunEventEnvelopeSchema.parse({
      eventId: row.event_id,
      runId: row.run_id,
      ...scope,
      occurredAt: row.occurred_at.toISOString(),
      payload: row.payload,
      schemaVersion: 1,
      sequence: Number(row.sequence),
      type: row.type,
    });
    const snapshot = recoverTranscript(
      event,
      JSON.parse(row.content),
      new Set<string>(row.tool_ids)
    );
    if (mode === "--apply") {
      // biome-ignore lint/performance/noAwaitInLoops: appends allocate ordered ledger sequences.
      await store.appendRunEvent({
        payload: {
          kind: "message_snapshot",
          messageId: snapshot.messageId,
          role: "assistant",
          snapshot,
        },
        runId: event.runId,
        scope,
        type: "agent.progress",
      });
    }
    console.log(
      JSON.stringify({
        action: mode === "--apply" ? "recovered" : "recoverable",
        eventId: event.eventId,
        parts: snapshot.parts.length,
      })
    );
  }
  console.log(
    JSON.stringify({
      applied: mode === "--apply",
      candidates: candidates.rowCount,
    })
  );
} finally {
  await client.query(
    "select pg_advisory_unlock(hashtext('reasonate-transcript-repair'), hashtext($1))",
    [buildSessionId]
  );
  client.release();
  await Promise.all([pool.end(), store.close()]);
}
