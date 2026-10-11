import { randomUUID } from "node:crypto";
import {
  BuildSessionIdSchema,
  PreviewIdSchema,
} from "@reasonateai/contracts/execution";
import {
  IsoDateTimeSchema,
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
} from "@reasonateai/contracts/identity";
import { type ISandbox, SandboxIdSchema } from "@reasonateai/contracts/sandbox";
import { createInMemoryPreviewRepository } from "@reasonateai/project-state/previews";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPreviewService,
  PREVIEW_PUBLIC_PATH_PREFIX,
} from "../src/mastra/preview-service.js";

// Mock child_process execFile to test Docker interactions in isolation
const dockerExecMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    callback: (
      error: Error | null,
      result?: { stdout: string; stderr: string }
    ) => void
  ) => {
    dockerExecMock(cmd, args, callback);
  },
}));

describe("preview service - persistence and restart recovery", () => {
  const orgId = OrganizationIdSchema.parse(randomUUID());
  const projId = ProjectIdSchema.parse(randomUUID());
  const sessionId = BuildSessionIdSchema.parse(randomUUID());
  const runId = RunIdSchema.parse(randomUUID());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("releases the shared sandbox once when sibling previews retire concurrently", async () => {
    const store = createInMemoryPreviewRepository();
    const destroy = vi.fn().mockResolvedValue(undefined);
    const sandbox: ISandbox = {
      destroy,
      getState: vi.fn(),
      id: SandboxIdSchema.parse(`shared-${randomUUID()}`),
      readFile: vi.fn().mockResolvedValue(JSON.stringify({ port: 5173 })),
      runCommand: vi.fn(),
      writeFile: vi.fn(),
    };
    const ids = [
      PreviewIdSchema.parse(randomUUID()),
      PreviewIdSchema.parse(randomUUID()),
    ];
    await Promise.all(
      ids.map((previewId) =>
        store.record({
          buildSessionId: sessionId,
          containerName: `reasonate-sbx-${sandbox.id}`,
          hostPort: 39_002,
          organizationId: orgId,
          previewId,
          projectId: projId,
          runId,
          sandboxId: sandbox.id,
          status: "ready",
        })
      )
    );
    const service = createPreviewService({
      attachRunSandbox: async () => sandbox,
      previewStore: store,
    });
    await Promise.all(ids.map((id) => service.target(id)));
    await service.disposeAll();
    expect(await store.listActive()).toEqual([]);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(
      await Promise.all(ids.map(async (id) => (await store.get(id))?.status))
    ).toEqual(["stopped", "stopped"]);
  });

  it("records preview lifecycle transitions in the persistent store", async () => {
    const store = createInMemoryPreviewRepository();
    const service = createPreviewService({
      previewStore: store,
    });

    // Mock docker calls for initial sweep
    dockerExecMock.mockImplementation((_cmd, _args, cb) => {
      cb(null, { stderr: "", stdout: "" });
    });

    const view = await service.start({
      buildSessionId: sessionId,
      organizationId: orgId,
      projectId: projId,
      runId,
    });

    expect(view.status).toBe("starting");
    expect(view.url).toBe(`${PREVIEW_PUBLIC_PATH_PREFIX}/${view.previewId}/`);

    // Verify stored row in persistent repository
    const stored = await store.get(view.previewId);
    expect(stored).toBeDefined();
    expect(stored?.previewId).toBe(view.previewId);
    expect(stored?.buildSessionId).toBe(sessionId);
    expect(stored?.organizationId).toBe(orgId);
    expect(stored?.projectId).toBe(projId);
    expect(stored?.status).toBe("failed");
    expect(stored?.detail).toContain("sandbox is no longer available");

    // Manually mark ready in store to simulate successful container boot
    await store.update(view.previewId, {
      hostPort: 32_500,
      status: "ready",
    });

    // Target call touches and reads status
    const target = await service.target(view.previewId);
    expect(target).toBeDefined();
    expect(target?.organizationId).toBe(orgId);

    // Stopping marks stopped in store
    const stopped = await service.stop(view.previewId);
    expect(stopped?.status).toBe("stopped");

    const storedAfterStop = await store.get(view.previewId);
    expect(storedAfterStop?.status).toBe("stopped");
  });

  it("lazily hydrates preview from persistent store across cold restarts", async () => {
    const store = createInMemoryPreviewRepository();
    const previewId = PreviewIdSchema.parse(randomUUID());

    // Populate a live preview directly in the persistent store
    await store.record({
      buildSessionId: sessionId,
      containerName: `reasonate-sbx-preview-${previewId}`,
      hostPort: 39_001,
      organizationId: orgId,
      previewId,
      projectId: projId,
      runId,
      sandboxId: `preview-${previewId}`,
      status: "ready",
    });

    // Mock fetch for port probe
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input) => {
        const url = String(input);
        if (url.includes("39001")) {
          return Promise.resolve(new Response("OK", { status: 200 }));
        }
        return Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1"));
      });

    // Fresh API instance with empty in-memory maps
    const service = createPreviewService({
      previewStore: store,
    });

    // Target call hydrates from store without error
    const target = await service.target(previewId);
    expect(target).toBeDefined();
    expect(target?.organizationId).toBe(orgId);
    expect(target?.projectId).toBe(projId);
    expect(target?.hostPort).toBe(39_001);
    expect(target?.status).toBe("ready");

    // Status call also hydrates successfully
    const statusReport = await service.status(previewId);
    expect(statusReport).toBeDefined();
    expect(statusReport?.view.previewId).toBe(previewId);
    expect(statusReport?.view.port).toBeNull();
    expect(statusReport?.view.status).toBe("ready");

    fetchSpy.mockRestore();
  });

  it("lazily hydrates preview and resolves appPort from attached sandbox configuration", async () => {
    const store = createInMemoryPreviewRepository();
    const previewId = PreviewIdSchema.parse(randomUUID());

    await store.record({
      buildSessionId: sessionId,
      containerName: `reasonate-sbx-preview-${previewId}`,
      hostPort: 39_002,
      organizationId: orgId,
      previewId,
      projectId: projId,
      runId,
      sandboxId: `preview-${previewId}`,
      status: "ready",
    });

    const mockSandbox: ISandbox = {
      destroy: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn().mockResolvedValue({
        config: {
          id: SandboxIdSchema.parse(`preview-${previewId}`),
          image: "node:22",
          networkMode: "bridge",
          projectId: projId,
          runId,
        },
        createdAt: IsoDateTimeSchema.parse(new Date().toISOString()),
        id: SandboxIdSchema.parse(`preview-${previewId}`),
        status: "running",
        stoppedAt: null,
      }),
      id: SandboxIdSchema.parse(`preview-${previewId}`),
      readFile: vi
        .fn()
        .mockResolvedValue(JSON.stringify({ host: "127.0.0.1", port: 5173 })),
      runCommand: vi.fn(),
      writeFile: vi.fn(),
    };

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("OK", { status: 200 }));

    const service = createPreviewService({
      attachRunSandbox: async () => mockSandbox,
      previewStore: store,
    });

    const statusReport = await service.status(previewId);
    expect(statusReport).toBeDefined();
    expect(statusReport?.view.previewId).toBe(previewId);
    expect(statusReport?.view.port).toBe(5173);
    expect(statusReport?.view.status).toBe("ready");

    const target = await service.target(previewId);
    expect(target?.hostPort).toBe(39_002);

    const stopped = await service.stop(previewId);
    expect(stopped?.status).toBe("stopped");
    expect(stopped?.port).toBeNull();

    fetchSpy.mockRestore();
  });

  it("recovers running healthy preview and retires dead/expired previews across restart", async () => {
    const store = createInMemoryPreviewRepository();
    const livePreviewId = PreviewIdSchema.parse(randomUUID());
    const deadPreviewId = PreviewIdSchema.parse(randomUUID());
    const expiredPreviewId = PreviewIdSchema.parse(randomUUID());

    const liveContainer = `reasonate-sbx-preview-${livePreviewId}`;
    const deadContainer = `reasonate-sbx-preview-${deadPreviewId}`;
    const expiredContainer = `reasonate-sbx-preview-${expiredPreviewId}`;
    const orphanContainer = `reasonate-sbx-preview-${randomUUID()}`;

    const now = 1_000_000;

    // 1. Live preview: recent, running, serving
    await store.record({
      buildSessionId: BuildSessionIdSchema.parse(randomUUID()),
      containerName: liveContainer,
      hostPort: 34_100,
      organizationId: orgId,
      previewId: livePreviewId,
      projectId: projId,
      runId: RunIdSchema.parse(randomUUID()),
      sandboxId: `preview-${livePreviewId}`,
      status: "ready",
    });
    await store.touch(livePreviewId, new Date(now - 1000));

    // 2. Dead preview: recent, but container exited
    await store.record({
      buildSessionId: BuildSessionIdSchema.parse(randomUUID()),
      containerName: deadContainer,
      hostPort: 34_200,
      organizationId: orgId,
      previewId: deadPreviewId,
      projectId: projId,
      runId: RunIdSchema.parse(randomUUID()),
      sandboxId: `preview-${deadPreviewId}`,
      status: "ready",
    });
    await store.touch(deadPreviewId, new Date(now - 1000));

    // 3. Expired preview: idle > 15m (16 minutes ago)
    await store.record({
      buildSessionId: BuildSessionIdSchema.parse(randomUUID()),
      containerName: expiredContainer,
      hostPort: 34_300,
      organizationId: orgId,
      previewId: expiredPreviewId,
      projectId: projId,
      runId: RunIdSchema.parse(randomUUID()),
      sandboxId: `preview-${expiredPreviewId}`,
      status: "ready",
    });
    await store.touch(expiredPreviewId, new Date(now - 16 * 60 * 1000));

    const removedContainers: string[] = [];
    const recoveredPreviews: string[] = [];
    const retiredPreviews: string[] = [];

    // Mock fetch for port probe
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input) => {
        const url = String(input);
        if (url.includes("34100")) {
          return Promise.resolve(new Response("OK", { status: 200 }));
        }
        return Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1"));
      });

    // Mock Docker CLI executions
    dockerExecMock.mockImplementation((_cmd, args: string[], cb) => {
      if (args[0] === "inspect") {
        const [, , , container] = args;
        if (container === liveContainer) {
          cb(null, { stderr: "", stdout: "true\n" });
          return;
        }
        cb(null, { stderr: "", stdout: "false\n" });
        return;
      }

      if (args[0] === "port") {
        cb(null, { stderr: "", stdout: "127.0.0.1:34100\n" });
        return;
      }

      if (args[0] === "rm") {
        const name = args.at(-1);
        if (name) {
          removedContainers.push(name);
        }
        cb(null, { stderr: "", stdout: "" });
        return;
      }

      if (args[0] === "ps") {
        // Return all preview containers on the host
        const list = [
          liveContainer,
          deadContainer,
          expiredContainer,
          orphanContainer,
        ].join("\n");
        cb(null, { stderr: "", stdout: `${list}\n` });
        return;
      }

      cb(null, { stderr: "", stdout: "" });
    });

    const service = createPreviewService({
      nowMs: () => now,
      onOrphansRemoved: () => undefined,
      onPreviewRecovered: (id) => recoveredPreviews.push(id),
      onPreviewRetired: (id) => retiredPreviews.push(id),
      previewStore: store,
    });

    const result = await service.recover();

    // Verification
    expect(result.recovered).toBe(1);
    expect(recoveredPreviews).toContain(livePreviewId);

    // Dead and expired containers were removed
    expect(removedContainers).toContain(deadContainer);
    expect(removedContainers).toContain(expiredContainer);

    // True orphan container was swept
    expect(removedContainers).toContain(orphanContainer);

    // Live container was PRESERVED (never passed to docker rm)
    expect(removedContainers).not.toContain(liveContainer);

    // Store states updated
    const liveStored = await store.get(livePreviewId);
    expect(liveStored?.status).toBe("ready");

    const deadStored = await store.get(deadPreviewId);
    expect(deadStored?.status).toBe("failed");

    const expiredStored = await store.get(expiredPreviewId);
    expect(expiredStored?.status).toBe("stopped");

    fetchSpy.mockRestore();
  });
});
