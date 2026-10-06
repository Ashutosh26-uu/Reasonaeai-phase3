import { randomUUID } from "node:crypto";
import {
  type BuildSessionId,
  BuildSessionIdSchema,
  PromptAttachmentSchema,
} from "@reasonateai/contracts/execution";
import { RunCheckpointSchema } from "@reasonateai/contracts/execution-protocol";
import {
  type AuditEvent,
  RunIdSchema,
  type SessionId,
  type UserId,
} from "@reasonateai/contracts/identity";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { recordWith } from "./audit.js";
import type { TenantScope } from "./postgres.js";

export const ConversationHeadSchema = z.strictObject({
  checkpointCommit: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .nullable(),
  checkpointEmpty: z.boolean(),
  checkpointId: z.string().min(1).max(512).nullable(),
  isolated: z.boolean(),
  threadId: z.string().uuid(),
});
export type ConversationHead = z.infer<typeof ConversationHeadSchema>;
export class ConversationHistoryError extends Error {}
export interface HistoryCommand {
  action: "branch" | "retry";
  audit: AuditEvent;
  buildSessionId: BuildSessionId;
  idempotencyKey: string;
  latestCheckpoint: () => Promise<string | undefined>;
  message?: string | undefined;
  requestedByUserId: UserId;
  runId: ReturnType<typeof RunIdSchema.parse>;
  scope: TenantScope;
  userSessionId: SessionId;
  validateCheckpoint: (checkpointId: string) => Promise<void>;
}
type CommandIdentity = Pick<
  HistoryCommand,
  "action" | "buildSessionId" | "idempotencyKey" | "message" | "runId" | "scope"
>;
interface SelectedTurn {
  baseline: string | null;
  position: string;
  status: string;
  user_attachments: unknown;
  user_message: string | null;
}
function commandFingerprint(command: CommandIdentity) {
  return JSON.stringify([
    command.action,
    command.runId,
    command.message ?? null,
  ]);
}
async function recordedCommand(
  db: Pool | PoolClient,
  command: CommandIdentity
) {
  const replay = await db.query<{
    fingerprint: string;
    result_build_session_id: string;
    result_run_id: string;
  }>(
    "select c.* from conversation_history_commands c join build_sessions b using(build_session_id) where c.build_session_id=$1 and c.idempotency_key=$2 and b.organization_id=$3 and b.project_id=$4",
    [
      command.buildSessionId,
      command.idempotencyKey,
      command.scope.organizationId,
      command.scope.projectId,
    ]
  );
  const [row] = replay.rows;
  if (!row) {
    return;
  }
  if (
    row.fingerprint !==
    JSON.stringify([command.action, command.runId, command.message ?? null])
  ) {
    throw new ConversationHistoryError(
      "This request key was already used for a different history action."
    );
  }
  return {
    buildSessionId: BuildSessionIdSchema.parse(row.result_build_session_id),
    created: false,
    runId: RunIdSchema.parse(row.result_run_id),
  };
}
async function resolveBoundary(
  client: PoolClient,
  command: HistoryCommand,
  selected: SelectedTurn
) {
  const { runId, scope } = command;
  const events = await client.query<{
    checkpoint_id: string | null;
    checkpoint: unknown;
  }>(
    `select payload->>'checkpointId' as checkpoint_id,payload->'checkpoint' as checkpoint from run_events where run_id=$1 and organization_id=$2 and project_id=$3 and type in ('run.completed','run.failed','run.cancelled') order by sequence desc limit 1`,
    [runId, scope.organizationId, scope.projectId]
  );
  const [event] = events.rows;
  if (command.action === "branch") {
    if (selected.status !== "completed" || !event?.checkpoint_id) {
      throw new ConversationHistoryError(
        "Branching requires a completed turn with a saved checkpoint."
      );
    }
    return {
      checkpointCommit: null,
      checkpointEmpty: false,
      checkpointId: event.checkpoint_id,
    };
  }
  if (selected.baseline) {
    return {
      checkpointCommit: null,
      checkpointEmpty: false,
      checkpointId: selected.baseline,
    };
  }
  const checkpoint = RunCheckpointSchema.safeParse(event?.checkpoint);
  if (!checkpoint.success || checkpoint.data.status !== "available") {
    throw new ConversationHistoryError(
      "This older turn has no verified starting checkpoint. Its history and files were left unchanged."
    );
  }
  const { baseCommit, checkpointId } = checkpoint.data;
  return {
    checkpointCommit: baseCommit,
    checkpointEmpty: baseCommit === null,
    checkpointId,
  };
}

export function createConversationHistory(input: {
  appendQueued: (
    client: PoolClient,
    runId: ReturnType<typeof RunIdSchema.parse>,
    command: HistoryCommand
  ) => Promise<void>;
  pool: Pool;
  withTransaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
}) {
  const head = async (
    scope: TenantScope,
    buildSessionId: BuildSessionId
  ): Promise<ConversationHead | undefined> => {
    const result = await input.pool.query(
      `select h.* from conversation_heads h join build_sessions b using(build_session_id)
       where b.build_session_id=$1 and b.organization_id=$2 and b.project_id=$3`,
      [buildSessionId, scope.organizationId, scope.projectId]
    );
    const [row] = result.rows;
    return row
      ? ConversationHeadSchema.parse({
          checkpointCommit: row.checkpoint_commit,
          checkpointEmpty: row.checkpoint_empty,
          checkpointId: row.checkpoint_id,
          isolated: row.isolated,
          threadId: row.thread_id,
        })
      : undefined;
  };
  const change = async (command: HistoryCommand) =>
    await input.withTransaction(async (client) => {
      const { scope, buildSessionId, runId } = command;
      await client.query(
        "select project_id from projects where organization_id=$1 and project_id=$2 for update",
        [scope.organizationId, scope.projectId]
      );
      const session = await client.query(
        "select * from build_sessions where build_session_id=$1 and organization_id=$2 and project_id=$3 for update",
        [buildSessionId, scope.organizationId, scope.projectId]
      );
      if (!session.rows[0]) {
        throw new ConversationHistoryError(
          "Conversation not found in this project."
        );
      }
      const fingerprint = commandFingerprint(command);
      const replay = await recordedCommand(client, command);
      if (replay) {
        return replay;
      }
      const busy = await client.query(
        `select 1 from runs r left join run_leases l using(run_id) where r.organization_id=$1 and r.project_id=$2 and (r.status in ('queued','running','awaiting_approval') or l.expires_at>now()) limit 1`,
        [scope.organizationId, scope.projectId]
      );
      if (busy.rowCount) {
        throw new ConversationHistoryError(
          "Wait for the project's active work to finish before changing history."
        );
      }
      const target = await client.query<SelectedTurn>(
        `select r.*, h.position, boundary.checkpoint_id as baseline from conversation_history h
       join runs r on r.run_id=h.run_id and r.organization_id=h.organization_id and r.project_id=h.project_id
       left join run_workspace_boundaries boundary on boundary.run_id=r.run_id
       where h.build_session_id=$1 and h.run_id=$2 and h.organization_id=$3 and h.project_id=$4`,
        [buildSessionId, runId, scope.organizationId, scope.projectId]
      );
      const [selected] = target.rows;
      if (!selected) {
        throw new ConversationHistoryError(
          "This turn is no longer in the active conversation."
        );
      }
      const { checkpointId, checkpointCommit, checkpointEmpty } =
        await resolveBoundary(client, command, selected);
      await command.validateCheckpoint(checkpointId);
      const projectCheckpointId = await command.latestCheckpoint();
      if (projectCheckpointId) {
        await client.query(
          "update conversation_heads h set isolated=true,checkpoint_id=$3 from build_sessions b where b.build_session_id=h.build_session_id and b.organization_id=$1 and b.project_id=$2 and not h.isolated",
          [scope.organizationId, scope.projectId, projectCheckpointId]
        );
      }
      let resultSessionId = buildSessionId;
      let resultRunId = runId;
      if (command.action === "branch") {
        resultSessionId = BuildSessionIdSchema.parse(randomUUID());
        const sandboxId = randomUUID();
        const workspaceUri = `sandbox://${sandboxId}/workspace`;
        await client.query(
          `insert into build_sessions(build_session_id,organization_id,project_id,user_session_id,run_id,sandbox_environment_id,workspace_uri,stage,status) values($1,$2,$3,$4,$5,$6,$7,$8,'ready')`,
          [
            resultSessionId,
            scope.organizationId,
            scope.projectId,
            command.userSessionId,
            runId,
            sandboxId,
            workspaceUri,
            session.rows[0].stage,
          ]
        );
        await client.query(
          `insert into sandbox_environments(sandbox_environment_id,organization_id,project_id,build_session_id,status,workspace_uri) values($1,$2,$3,$4,'allocating',$5)`,
          [
            sandboxId,
            scope.organizationId,
            scope.projectId,
            resultSessionId,
            workspaceUri,
          ]
        );
        await client.query(
          "insert into conversation_history select $2,run_id,organization_id,project_id,position from conversation_history where build_session_id=$1 and position<=$3",
          [buildSessionId, resultSessionId, selected.position]
        );
      } else {
        resultRunId = RunIdSchema.parse(randomUUID());
        const attachments = PromptAttachmentSchema.array().parse(
          selected.user_attachments
        );
        await client.query(
          "delete from conversation_history where build_session_id=$1 and position>=$2",
          [buildSessionId, selected.position]
        );
        await client.query(
          `insert into runs(run_id,organization_id,project_id,build_session_id,status,user_message,user_attachments) values($1,$2,$3,$4,'queued',$5,$6::jsonb)`,
          [
            resultRunId,
            scope.organizationId,
            scope.projectId,
            buildSessionId,
            command.message ?? selected.user_message,
            JSON.stringify(attachments),
          ]
        );
        await client.query(
          "insert into conversation_history(build_session_id,run_id,organization_id,project_id,position) values($1,$2,$3,$4,$5)",
          [
            buildSessionId,
            resultRunId,
            scope.organizationId,
            scope.projectId,
            selected.position,
          ]
        );
        await client.query(
          `update build_sessions set run_id=$2,status='ready',updated_at=now() where build_session_id=$1`,
          [buildSessionId, resultRunId]
        );
        await input.appendQueued(client, resultRunId, command);
      }
      await client.query(
        "insert into conversation_heads(build_session_id,thread_id,isolated,checkpoint_id,checkpoint_commit,source_build_session_id,source_run_id) values($1,$2,true,$3,$4,$5,$6) on conflict(build_session_id) do update set thread_id=excluded.thread_id,isolated=true,checkpoint_id=excluded.checkpoint_id,checkpoint_commit=excluded.checkpoint_commit,source_build_session_id=excluded.source_build_session_id,source_run_id=excluded.source_run_id",
        [
          resultSessionId,
          randomUUID(),
          checkpointId,
          checkpointCommit,
          buildSessionId,
          runId,
        ]
      );
      await client.query(
        "update conversation_heads set checkpoint_empty=$2 where build_session_id=$1",
        [resultSessionId, checkpointEmpty]
      );
      await client.query(
        "insert into conversation_history_commands values($1,$2,$3,$4,$5)",
        [
          buildSessionId,
          command.idempotencyKey,
          fingerprint,
          resultSessionId,
          resultRunId,
        ]
      );
      await recordWith(client, {
        ...command.audit,
        metadata: {
          checkpointId,
          resultBuildSessionId: resultSessionId,
          resultRunId,
          sourceRunId: runId,
        },
      });
      return {
        buildSessionId: resultSessionId,
        created: true,
        runId: resultRunId,
      };
    });
  const boundary = async (
    scope: TenantScope,
    runId: string,
    checkpointId: string
  ) => {
    await input.pool.query(
      "insert into run_workspace_boundaries(run_id,checkpoint_id) select run_id,$4 from runs where run_id=$1 and organization_id=$2 and project_id=$3 on conflict do nothing",
      [runId, scope.organizationId, scope.projectId, checkpointId]
    );
  };
  const publish = async (
    scope: TenantScope,
    buildSessionId: BuildSessionId,
    checkpointId: string,
    fence: { runId: string; leaseId: string }
  ) => {
    const result = await input.pool.query(
      "update conversation_heads h set checkpoint_id=$4,checkpoint_commit=null,checkpoint_empty=false,isolated=true from build_sessions b,run_leases l where h.build_session_id=b.build_session_id and b.build_session_id=$1 and b.organization_id=$2 and b.project_id=$3 and b.run_id=$5 and l.run_id=$5 and l.lease_id=$6 and l.expires_at>now()",
      [
        buildSessionId,
        scope.organizationId,
        scope.projectId,
        checkpointId,
        fence.runId,
        fence.leaseId,
      ]
    );
    if (result.rowCount !== 1) {
      throw new ConversationHistoryError(
        "Checkpoint publication was rejected because the run no longer owns this conversation."
      );
    }
  };
  const feedback = async (
    scope: TenantScope,
    buildSessionId: BuildSessionId,
    runId: string,
    userId: UserId,
    value: "positive" | "negative" | null
  ) => {
    const result = await input.pool.query(
      `insert into conversation_feedback(build_session_id,run_id,user_id,feedback) select h.build_session_id,h.run_id,$5,$6 from conversation_history h join runs r using(run_id) where h.build_session_id=$1 and h.run_id=$2 and h.organization_id=$3 and h.project_id=$4 and r.status='completed' on conflict(build_session_id,run_id,user_id) do update set feedback=excluded.feedback`,
      [
        buildSessionId,
        runId,
        scope.organizationId,
        scope.projectId,
        userId,
        value,
      ]
    );
    return result.rowCount === 1;
  };
  const contains = async (
    scope: TenantScope,
    buildSessionId: BuildSessionId,
    runId: string
  ) => {
    const result = await input.pool.query(
      "select 1 from conversation_history where build_session_id=$1 and run_id=$2 and organization_id=$3 and project_id=$4",
      [buildSessionId, runId, scope.organizationId, scope.projectId]
    );
    return result.rowCount === 1;
  };
  const retainedInputs = async (
    scope: TenantScope,
    buildSessionId: BuildSessionId
  ) => {
    const prompts = await input.pool.query<{
      run_id: string;
      user_attachments: unknown;
    }>(
      "select r.run_id,r.user_attachments from conversation_history h join runs r using(run_id) where h.build_session_id=$1 and h.organization_id=$2 and h.project_id=$3 order by h.position",
      [buildSessionId, scope.organizationId, scope.projectId]
    );
    const events = await input.pool.query<{
      run_id: string;
      occurred_at: Date;
      type: string;
      payload: Record<string, unknown>;
    }>(
      `select e.run_id,e.occurred_at,e.type,e.payload from conversation_history h join run_events e using(run_id) where h.build_session_id=$1 and h.organization_id=$2 and h.project_id=$3 and (e.type in ('run.plan_decided','approval.resolved') or (e.type='run.steering.requested' and exists(select 1 from run_events delivered where delivered.run_id=e.run_id and delivered.type='run.steering.delivered' and delivered.payload->>'steeringId'=e.payload->>'steeringId'))) order by h.position,e.sequence`,
      [buildSessionId, scope.organizationId, scope.projectId]
    );
    return {
      attachments: new Map(
        prompts.rows.map((row) => [
          row.run_id,
          PromptAttachmentSchema.array().parse(row.user_attachments),
        ])
      ),
      events: events.rows,
    };
  };
  return {
    boundary,
    change,
    contains,
    feedback,
    head,
    lookup: (command: CommandIdentity) => recordedCommand(input.pool, command),
    publish,
    retainedInputs,
  };
}
