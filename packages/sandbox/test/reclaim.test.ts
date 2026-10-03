import type { BuildSessionId } from "@reasonateai/contracts/execution";
import type {
  OrganizationId,
  ProjectId,
} from "@reasonateai/contracts/identity";
import { describe, expect, it, vi } from "vitest";
import type { CheckpointStore } from "../src/checkpoint.js";
import {
  type DockerExecutor,
  inspectWorkspaceVolume,
  parseWorkspaceVolumeName,
  reclaimRetainedWorkspaceVolume,
  reclaimRetainedWorkspaceVolumes,
} from "../src/reclaim.js";

const organizationId = "11111111-1111-4111-8111-111111111111" as OrganizationId;
const projectId = "22222222-2222-4222-8222-222222222222" as ProjectId;
const buildSessionId = "33333333-3333-4333-8333-333333333333" as BuildSessionId;

const validVolumeName = `reasonate-${organizationId}-${projectId}-${buildSessionId}-workspace`;

describe("parseWorkspaceVolumeName", () => {
  it("successfully parses valid Reasonate workspace volume names", () => {
    const parsed = parseWorkspaceVolumeName(validVolumeName);
    expect(parsed).toBeDefined();
    expect(parsed?.organizationId).toBe(organizationId);
    expect(parsed?.projectId).toBe(projectId);
    expect(parsed?.buildSessionId).toBe(buildSessionId);
    expect(parsed?.volumeName).toBe(validVolumeName);
  });

  it("handles leading and trailing whitespace", () => {
    const parsed = parseWorkspaceVolumeName(`  ${validVolumeName}  \n`);
    expect(parsed).toBeDefined();
    expect(parsed?.volumeName).toBe(validVolumeName);
  });

  it("rejects non-Reasonate host volumes", () => {
    expect(parseWorkspaceVolumeName("postgres-data")).toBeUndefined();
    expect(parseWorkspaceVolumeName("redis-volume")).toBeUndefined();
    expect(parseWorkspaceVolumeName("reasonate-preview-app")).toBeUndefined();
    expect(
      parseWorkspaceVolumeName(
        `reasonate-${organizationId}-${projectId}-${buildSessionId}-other`
      )
    ).toBeUndefined();
  });

  it("rejects invalid UUID segments", () => {
    expect(
      parseWorkspaceVolumeName(
        "reasonate-invalid-uuid-22222222-2222-4222-8222-222222222222-33333333-3333-4333-8333-333333333333-workspace"
      )
    ).toBeUndefined();
  });
});

describe("inspectWorkspaceVolume", () => {
  it("extracts creation date and container bindings using mock docker executor", async () => {
    const mockExec: DockerExecutor = vi.fn(async (_file, args) => {
      await Promise.resolve();
      if (args[0] === "volume" && args[1] === "inspect") {
        return {
          stderr: "",
          stdout: JSON.stringify([
            {
              CreatedAt: new Date(Date.now() - 3_600_000).toISOString(),
              Name: validVolumeName,
            },
          ]),
        };
      }
      if (args[0] === "ps" && !args.includes("-a")) {
        return { stderr: "", stdout: "active-container-123\n" };
      }
      if (args[0] === "ps" && args.includes("-a")) {
        return {
          stderr: "",
          stdout: "active-container-123\nstopped-container-456\n",
        };
      }
      return { stderr: "", stdout: "" };
    });

    const info = await inspectWorkspaceVolume(validVolumeName, mockExec);
    expect(info).toBeDefined();
    expect(info?.volumeName).toBe(validVolumeName);
    expect(info?.activeContainers).toEqual(["active-container-123"]);
    expect(info?.stoppedContainers).toEqual(["stopped-container-456"]);
    expect(info?.ageMs).toBeGreaterThanOrEqual(3_500_000);
  });
});

describe("reclaimRetainedWorkspaceVolume", () => {
  it("skips volume when active running containers are mounting it", async () => {
    const mockExec: DockerExecutor = vi.fn(async (_file, args) => {
      await Promise.resolve();
      if (args[0] === "volume" && args[1] === "inspect") {
        return {
          stderr: "",
          stdout: JSON.stringify([
            {
              CreatedAt: new Date().toISOString(),
              Name: validVolumeName,
            },
          ]),
        };
      }
      if (args[0] === "ps") {
        return { stderr: "", stdout: "live-worker-container\n" };
      }
      return { stderr: "", stdout: "" };
    });

    const result = await reclaimRetainedWorkspaceVolume(validVolumeName, {
      execDocker: mockExec,
    });

    expect(result.status).toBe("skipped_active_container");
    expect(result.reason).toContain("mounted by 1 active container");
    expect(mockExec).not.toHaveBeenCalledWith("docker", [
      "volume",
      "rm",
      "-f",
      validVolumeName,
    ]);
  });

  it("reclaims volume when verified checkpoint exists in checkpointStore", async () => {
    const executedCommands: string[][] = [];
    const mockExec: DockerExecutor = vi.fn(async (_file, args) => {
      await Promise.resolve();
      executedCommands.push([...args]);
      if (args[0] === "volume" && args[1] === "inspect") {
        return {
          stderr: "",
          stdout: JSON.stringify([
            {
              CreatedAt: new Date().toISOString(),
              Name: validVolumeName,
            },
          ]),
        };
      }
      return { stderr: "", stdout: "" };
    });

    const mockStore: CheckpointStore = {
      latest: vi.fn(async () => ({
        checkpointId: "ckpt-verified-123",
        digest: "a".repeat(64),
      })),
      read: vi.fn(),
      write: vi.fn(),
    };

    const result = await reclaimRetainedWorkspaceVolume(validVolumeName, {
      checkpointStore: mockStore,
      execDocker: mockExec,
    });

    expect(result.status).toBe("reclaimed");
    expect(mockStore.latest).toHaveBeenCalledWith({
      organizationId,
      projectId,
    });
    expect(executedCommands).toContainEqual([
      "volume",
      "rm",
      "-f",
      validVolumeName,
    ]);
  });

  it("skips volume when no checkpoint exists and maxAgeMs has not expired", async () => {
    const mockExec: DockerExecutor = vi.fn(async (_file, args) => {
      await Promise.resolve();
      if (args[0] === "volume" && args[1] === "inspect") {
        return {
          stderr: "",
          stdout: JSON.stringify([
            {
              CreatedAt: new Date().toISOString(), // 0ms old
              Name: validVolumeName,
            },
          ]),
        };
      }
      return { stderr: "", stdout: "" };
    });

    const mockStore: CheckpointStore = {
      latest: vi.fn(async () => undefined),
      read: vi.fn(),
      write: vi.fn(),
    };

    const result = await reclaimRetainedWorkspaceVolume(validVolumeName, {
      checkpointStore: mockStore,
      execDocker: mockExec,
      maxAgeMs: 3_600_000, // 1 hour
    });

    expect(result.status).toBe("skipped_no_checkpoint");
  });

  it("reclaims volume when no checkpoint exists but maxAgeMs TTL has expired", async () => {
    const executedCommands: string[][] = [];
    const mockExec: DockerExecutor = vi.fn(async (_file, args) => {
      await Promise.resolve();
      executedCommands.push([...args]);
      if (args[0] === "volume" && args[1] === "inspect") {
        return {
          stderr: "",
          stdout: JSON.stringify([
            {
              CreatedAt: new Date(Date.now() - 7_200_000).toISOString(), // 2 hours old
              Name: validVolumeName,
            },
          ]),
        };
      }
      return { stderr: "", stdout: "" };
    });

    const mockStore: CheckpointStore = {
      latest: vi.fn(async () => undefined),
      read: vi.fn(),
      write: vi.fn(),
    };

    const result = await reclaimRetainedWorkspaceVolume(validVolumeName, {
      checkpointStore: mockStore,
      execDocker: mockExec,
      maxAgeMs: 3_600_000, // 1 hour
    });

    expect(result.status).toBe("reclaimed");
    expect(executedCommands).toContainEqual([
      "volume",
      "rm",
      "-f",
      validVolumeName,
    ]);
  });

  it("supports dryRun without deleting volumes", async () => {
    const mockExec: DockerExecutor = vi.fn(async (_file, args) => {
      await Promise.resolve();
      if (args[0] === "volume" && args[1] === "inspect") {
        return {
          stderr: "",
          stdout: JSON.stringify([
            {
              CreatedAt: new Date().toISOString(),
              Name: validVolumeName,
            },
          ]),
        };
      }
      return { stderr: "", stdout: "" };
    });

    const mockStore: CheckpointStore = {
      latest: vi.fn(async () => ({
        checkpointId: "ckpt-1",
        digest: "a".repeat(64),
      })),
      read: vi.fn(),
      write: vi.fn(),
    };

    const result = await reclaimRetainedWorkspaceVolume(validVolumeName, {
      checkpointStore: mockStore,
      dryRun: true,
      execDocker: mockExec,
    });

    expect(result.status).toBe("dry_run");
    expect(mockExec).not.toHaveBeenCalledWith("docker", [
      "volume",
      "rm",
      "-f",
      validVolumeName,
    ]);
  });
});

describe("reclaimRetainedWorkspaceVolumes sweep", () => {
  it("sweeps list of volumes and summarizes results", async () => {
    const otherSessionId =
      "44444444-4444-4444-8444-444444444444" as BuildSessionId;
    const vol1 = validVolumeName;
    const vol2 = `reasonate-${organizationId}-${projectId}-${otherSessionId}-workspace`;

    const mockExec: DockerExecutor = vi.fn(async (_file, args) => {
      await Promise.resolve();
      if (args[0] === "volume" && args[1] === "ls") {
        return {
          stderr: "",
          stdout: `${vol1}\n${vol2}\nrandom-volume\n`,
        };
      }
      if (args[0] === "volume" && args[1] === "inspect") {
        const [, , target] = args;
        return {
          stderr: "",
          stdout: JSON.stringify([
            {
              CreatedAt: new Date().toISOString(),
              Name: target,
            },
          ]),
        };
      }
      return { stderr: "", stdout: "" };
    });

    const mockStore: CheckpointStore = {
      latest: vi.fn(async () => ({
        checkpointId: "ckpt-verified",
        digest: "a".repeat(64),
      })),
      read: vi.fn(),
      write: vi.fn(),
    };

    const summary = await reclaimRetainedWorkspaceVolumes({
      checkpointStore: mockStore,
      execDocker: mockExec,
    });

    expect(summary.totalInspected).toBe(2);
    expect(summary.reclaimed).toBe(2);
    expect(summary.errors).toBe(0);
    expect(summary.skipped).toBe(0);
  });
});
