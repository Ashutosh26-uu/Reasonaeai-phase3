import { randomUUID } from "node:crypto";
import {
  BuildSessionIdSchema,
  PreviewIdSchema,
} from "@reasonateai/contracts/execution";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
} from "@reasonateai/contracts/identity";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProjectStateStore } from "../src/postgres.js";
import { createInMemoryPreviewRepository } from "../src/previews.js";
import { deleteOrganizations } from "./support/database.js";

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describe("in-memory preview repository", () => {
  const repo = createInMemoryPreviewRepository();
  const orgId = OrganizationIdSchema.parse(randomUUID());
  const projId = ProjectIdSchema.parse(randomUUID());
  const sessionId = BuildSessionIdSchema.parse(randomUUID());
  const previewId = PreviewIdSchema.parse(randomUUID());

  it("records and retrieves a preview", async () => {
    const recorded = await repo.record({
      buildSessionId: sessionId,
      containerName: `reasonate-sbx-preview-${previewId}`,
      organizationId: orgId,
      previewId,
      projectId: projId,
      sandboxId: `preview-${previewId}`,
    });

    expect(recorded.previewId).toBe(previewId);
    expect(recorded.status).toBe("starting");
    expect(recorded.hostPort).toBeNull();

    const fetched = await repo.get(previewId);
    expect(fetched).toBeDefined();
    expect(fetched?.previewId).toBe(previewId);

    const bySession = await repo.getBySession(sessionId);
    expect(bySession).toBeDefined();
    expect(bySession?.previewId).toBe(previewId);
  });

  it("updates status and published host port", async () => {
    const updated = await repo.update(previewId, {
      hostPort: 32_100,
      status: "ready",
    });

    expect(updated?.status).toBe("ready");
    expect(updated?.hostPort).toBe(32_100);

    const active = await repo.listActive();
    expect(active.some((p) => p.previewId === previewId)).toBe(true);
  });

  it("filters expired previews by cutoff", async () => {
    const future = new Date(Date.now() + 60_000);
    const expired = await repo.listExpired(future);
    expect(expired.some((p) => p.previewId === previewId)).toBe(true);

    const past = new Date(Date.now() - 60_000);
    const notExpired = await repo.listExpired(past);
    expect(notExpired.some((p) => p.previewId === previewId)).toBe(false);
  });
});

describeWithDatabase("postgresql preview repository", () => {
  const pool = new Pool({ connectionString });
  const store = createProjectStateStore({
    connectionString: connectionString as string,
  });

  const orgId = OrganizationIdSchema.parse(randomUUID());
  const projId = ProjectIdSchema.parse(randomUUID());
  const sessionId = BuildSessionIdSchema.parse(randomUUID());
  const previewId = PreviewIdSchema.parse(randomUUID());
  const userSessionId = randomUUID();
  const runId = randomUUID();
  const sandboxEnvId = randomUUID();

  beforeAll(async () => {
    await store.migrate();

    // Create required foreign key records (organization, project, build_session)
    await pool.query(
      "insert into organizations (organization_id, name) values ($1, $2);",
      [orgId, "Preview Test Org"]
    );
    await pool.query(
      "insert into projects (project_id, organization_id, name) values ($1, $2, $3);",
      [projId, orgId, "Preview Test Project"]
    );
    await pool.query(
      `insert into build_sessions (
         build_session_id,
         organization_id,
         project_id,
         user_session_id,
         run_id,
         sandbox_environment_id,
         workspace_uri,
         stage,
         status
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
      [
        sessionId,
        orgId,
        projId,
        userSessionId,
        runId,
        sandboxEnvId,
        "workspace://test",
        "implementation",
        "running",
      ]
    );
  });

  afterAll(async () => {
    await deleteOrganizations(pool, [orgId]);
    await pool.end();
    await store.close();
  });

  it("persists preview and exposes via store.previews", async () => {
    const repo = store.previews;

    const recorded = await repo.record({
      buildSessionId: sessionId,
      containerName: `reasonate-sbx-preview-${previewId}`,
      organizationId: orgId,
      previewId,
      projectId: projId,
      sandboxId: `preview-${previewId}`,
    });

    expect(recorded.previewId).toBe(previewId);
    expect(recorded.status).toBe("starting");
    expect(recorded.hostPort).toBeNull();

    const fetched = await repo.get(previewId);
    expect(fetched).toBeDefined();
    expect(fetched?.organizationId).toBe(orgId);
    expect(fetched?.projectId).toBe(projId);

    const bySession = await repo.getBySession(sessionId);
    expect(bySession?.previewId).toBe(previewId);

    const updated = await repo.update(previewId, {
      detail: null,
      hostPort: 45_678,
      status: "ready",
    });
    expect(updated?.status).toBe("ready");
    expect(updated?.hostPort).toBe(45_678);

    const active = await repo.listActive();
    expect(active.some((p) => p.previewId === previewId)).toBe(true);

    await repo.touch(previewId);

    const stopped = await repo.update(previewId, {
      status: "stopped",
    });
    expect(stopped?.status).toBe("stopped");

    const activeAfterStop = await repo.listActive();
    expect(activeAfterStop.some((p) => p.previewId === previewId)).toBe(false);
  });
});
