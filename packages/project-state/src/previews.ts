import type {
  BuildSessionId,
  PreviewId,
  PreviewStatus,
} from "@reasonateai/contracts/execution";
import type {
  OrganizationId,
  ProjectId,
  RunId,
} from "@reasonateai/contracts/identity";
import type { Pool } from "pg";

export interface StoredPreview {
  buildSessionId: BuildSessionId;
  containerName: string;
  createdAt: Date;
  detail: string | null;
  hostPort: number | null;
  lastUsedAt: Date;
  organizationId: OrganizationId;
  previewId: PreviewId;
  projectId: ProjectId;
  runId: RunId | null;
  sandboxId: string;
  status: PreviewStatus;
  updatedAt: Date;
}

export interface CreatePreviewRecordInput {
  buildSessionId: BuildSessionId;
  containerName: string;
  detail?: string | null | undefined;
  hostPort?: number | null | undefined;
  organizationId: OrganizationId;
  previewId: PreviewId;
  projectId: ProjectId;
  runId?: RunId | null | undefined;
  sandboxId: string;
  status?: PreviewStatus | undefined;
}

export interface UpdatePreviewRecordInput {
  detail?: string | null | undefined;
  hostPort?: number | null | undefined;
  lastUsedAt?: Date | undefined;
  status?: PreviewStatus | undefined;
}

export interface PreviewRepository {
  get: (previewId: PreviewId) => Promise<StoredPreview | undefined>;
  getByRun: (runId: RunId) => Promise<StoredPreview | undefined>;
  getBySession: (
    buildSessionId: BuildSessionId
  ) => Promise<StoredPreview | undefined>;
  listActive: () => Promise<StoredPreview[]>;
  listExpired: (cutoff: Date) => Promise<StoredPreview[]>;
  record: (input: CreatePreviewRecordInput) => Promise<StoredPreview>;
  touch: (previewId: PreviewId, now?: Date) => Promise<void>;
  update: (
    previewId: PreviewId,
    update: UpdatePreviewRecordInput
  ) => Promise<StoredPreview | undefined>;
}

function toStoredPreview(row: Record<string, unknown>): StoredPreview {
  return {
    buildSessionId: row.build_session_id as BuildSessionId,
    containerName: String(row.container_name),
    createdAt: row.created_at as Date,
    detail:
      row.detail === null ? null : ((row.detail as string | undefined) ?? null),
    hostPort: row.host_port === null ? null : Number(row.host_port) || null,
    lastUsedAt: row.last_used_at as Date,
    organizationId: row.organization_id as OrganizationId,
    previewId: row.preview_id as PreviewId,
    projectId: row.project_id as ProjectId,
    runId: (row.run_id as RunId | null | undefined) ?? null,
    sandboxId: String(row.sandbox_id),
    status: row.status as PreviewStatus,
    updatedAt: row.updated_at as Date,
  };
}

export function createPreviewRepository(pool: Pool): PreviewRepository {
  return {
    get: async (previewId: PreviewId): Promise<StoredPreview | undefined> => {
      const result = await pool.query(
        "select * from previews where preview_id = $1 limit 1;",
        [previewId]
      );
      if (result.rows.length === 0) {
        return undefined;
      }
      return toStoredPreview(result.rows[0]);
    },

    getByRun: async (runId: RunId): Promise<StoredPreview | undefined> => {
      const result = await pool.query(
        `select * from previews
         where run_id = $1 and status in ('starting', 'ready')
         order by created_at desc limit 1;`,
        [runId]
      );
      return result.rows[0] ? toStoredPreview(result.rows[0]) : undefined;
    },

    getBySession: async (
      buildSessionId: BuildSessionId
    ): Promise<StoredPreview | undefined> => {
      const result = await pool.query(
        `select * from previews
         where build_session_id = $1 and status != 'stopped'
         order by created_at desc
         limit 1;`,
        [buildSessionId]
      );
      if (result.rows.length === 0) {
        return undefined;
      }
      return toStoredPreview(result.rows[0]);
    },

    listActive: async (): Promise<StoredPreview[]> => {
      const result = await pool.query(
        `select * from previews
         where status in ('starting', 'ready')
         order by last_used_at desc;`
      );
      return result.rows.map(toStoredPreview);
    },

    listExpired: async (cutoff: Date): Promise<StoredPreview[]> => {
      const result = await pool.query(
        `select * from previews
         where status in ('starting', 'ready') and last_used_at <= $1
         order by last_used_at asc;`,
        [cutoff]
      );
      return result.rows.map(toStoredPreview);
    },

    record: async (input: CreatePreviewRecordInput): Promise<StoredPreview> => {
      const status = input.status ?? "starting";
      const hostPort = input.hostPort ?? null;
      const detail = input.detail ?? null;
      const result = await pool.query(
        `insert into previews (
           preview_id,
           build_session_id,
           run_id,
           organization_id,
           project_id,
           status,
           host_port,
           detail,
           sandbox_id,
           container_name,
           created_at,
           last_used_at,
           updated_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now(), now())
         on conflict (preview_id) do update set
           status = excluded.status,
           host_port = excluded.host_port,
           detail = excluded.detail,
           updated_at = now()
         returning *;`,
        [
          input.previewId,
          input.buildSessionId,
          input.runId ?? null,
          input.organizationId,
          input.projectId,
          status,
          hostPort,
          detail,
          input.sandboxId,
          input.containerName,
        ]
      );
      return toStoredPreview(result.rows[0]);
    },

    touch: async (previewId: PreviewId, now?: Date): Promise<void> => {
      const timestamp = now ?? new Date();
      await pool.query(
        `update previews
         set last_used_at = $2, updated_at = now()
         where preview_id = $1;`,
        [previewId, timestamp]
      );
    },

    update: async (
      previewId: PreviewId,
      update: UpdatePreviewRecordInput
    ): Promise<StoredPreview | undefined> => {
      const setParts: string[] = ["updated_at = now()"];
      const values: unknown[] = [previewId];
      let paramIndex = 2;

      if (update.status !== undefined) {
        setParts.push(`status = $${paramIndex}`);
        values.push(update.status);
        paramIndex += 1;
      }
      if (update.hostPort !== undefined) {
        setParts.push(`host_port = $${paramIndex}`);
        values.push(update.hostPort);
        paramIndex += 1;
      }
      if (update.detail !== undefined) {
        setParts.push(`detail = $${paramIndex}`);
        values.push(update.detail);
        paramIndex += 1;
      }
      if (update.lastUsedAt !== undefined) {
        setParts.push(`last_used_at = $${paramIndex}`);
        values.push(update.lastUsedAt);
        paramIndex += 1;
      }

      const sql = `update previews set ${setParts.join(", ")} where preview_id = $1 returning *;`;
      const result = await pool.query(sql, values);
      if (result.rows.length === 0) {
        return undefined;
      }
      return toStoredPreview(result.rows[0]);
    },
  };
}

export function createInMemoryPreviewRepository(): PreviewRepository {
  const store = new Map<PreviewId, StoredPreview>();

  return {
    get: (previewId: PreviewId): Promise<StoredPreview | undefined> =>
      Promise.resolve(store.get(previewId)),

    getByRun: (runId: RunId): Promise<StoredPreview | undefined> => {
      const [match] = Array.from(store.values())
        .filter(
          (preview) =>
            preview.runId === runId &&
            (preview.status === "starting" || preview.status === "ready")
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return Promise.resolve(match);
    },

    getBySession: (
      buildSessionId: BuildSessionId
    ): Promise<StoredPreview | undefined> => {
      const [match] = Array.from(store.values())
        .filter(
          (p) => p.buildSessionId === buildSessionId && p.status !== "stopped"
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return Promise.resolve(match);
    },

    listActive: (): Promise<StoredPreview[]> => {
      const active = Array.from(store.values()).filter(
        (p) => p.status === "starting" || p.status === "ready"
      );
      return Promise.resolve(active);
    },

    listExpired: (cutoff: Date): Promise<StoredPreview[]> => {
      const expired = Array.from(store.values()).filter(
        (p) =>
          (p.status === "starting" || p.status === "ready") &&
          p.lastUsedAt.getTime() <= cutoff.getTime()
      );
      return Promise.resolve(expired);
    },

    record: (input: CreatePreviewRecordInput): Promise<StoredPreview> => {
      const now = new Date();
      const existing = store.get(input.previewId);
      const record: StoredPreview = {
        buildSessionId: input.buildSessionId,
        containerName: input.containerName,
        createdAt: existing?.createdAt ?? now,
        detail: input.detail ?? existing?.detail ?? null,
        hostPort: input.hostPort ?? existing?.hostPort ?? null,
        lastUsedAt: now,
        organizationId: input.organizationId,
        previewId: input.previewId,
        projectId: input.projectId,
        runId: input.runId ?? null,
        sandboxId: input.sandboxId,
        status: input.status ?? existing?.status ?? "starting",
        updatedAt: now,
      };
      store.set(input.previewId, record);
      return Promise.resolve(record);
    },

    touch: (previewId: PreviewId, now?: Date): Promise<void> => {
      const record = store.get(previewId);
      if (record) {
        record.lastUsedAt = now ?? new Date();
        record.updatedAt = new Date();
      }
      return Promise.resolve();
    },

    update: (
      previewId: PreviewId,
      update: UpdatePreviewRecordInput
    ): Promise<StoredPreview | undefined> => {
      const record = store.get(previewId);
      if (!record) {
        return Promise.resolve(undefined);
      }
      if (update.status !== undefined) {
        record.status = update.status;
      }
      if (update.hostPort !== undefined) {
        record.hostPort = update.hostPort;
      }
      if (update.detail !== undefined) {
        record.detail = update.detail;
      }
      if (update.lastUsedAt !== undefined) {
        record.lastUsedAt = update.lastUsedAt;
      }
      record.updatedAt = new Date();
      return Promise.resolve(record);
    },
  };
}
