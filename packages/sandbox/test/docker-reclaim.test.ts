import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import type { CheckpointStore } from "../src/checkpoint.js";
import {
  inspectWorkspaceVolume,
  listRetainedWorkspaceVolumes,
  parseWorkspaceVolumeName,
  reclaimRetainedWorkspaceVolume,
  reclaimRetainedWorkspaceVolumes,
} from "../src/reclaim.js";

const execFileAsync = promisify(execFile);

const dockerAvailable = await execFileAsync("docker", ["info"]).then(
  () => true,
  () => false
);

const describeWithDocker = dockerAvailable ? describe : describe.skip;

describeWithDocker("Live Docker workspace volume reclamation", () => {
  const liveVolume =
    "reasonate-11111111-2222-4333-8444-555555555555-66666666-7777-4888-8999-000000000000-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee-workspace";
  const liveContainer = "reasonate-test-active-mount-c1";
  const hostGuardVolume = "host-unrelated-guard-volume";

  afterAll(async () => {
    await execFileAsync("docker", ["rm", "-f", liveContainer]).catch(() => ({
      stderr: "",
      stdout: "",
    }));
    await execFileAsync("docker", ["volume", "rm", "-f", liveVolume]).catch(
      () => ({ stderr: "", stdout: "" })
    );
    await execFileAsync("docker", [
      "volume",
      "rm",
      "-f",
      hostGuardVolume,
    ]).catch(() => ({ stderr: "", stdout: "" }));
  });

  it("protects active mounting containers and reclaims cleanly after verification", async () => {
    // 1. Create real Docker workspace volume
    await execFileAsync("docker", ["volume", "create", liveVolume]);

    // 2. Start a container mounting the volume
    await execFileAsync("docker", [
      "run",
      "-d",
      "--name",
      liveContainer,
      "-v",
      `${liveVolume}:/workspace`,
      "--network",
      "none",
      "node:22",
      "sleep",
      "60",
    ]);

    // 3. Inspect volume: verify active container detected
    const info = await inspectWorkspaceVolume(liveVolume);
    expect(info).toBeDefined();
    expect(info?.activeContainers.length).toBeGreaterThan(0);

    // 4. Attempt reclaim while container is active: MUST be rejected
    const activeResult = await reclaimRetainedWorkspaceVolume(liveVolume);
    expect(activeResult.status).toBe("skipped_active_container");

    // Verify volume still exists
    const inspectCheck = await execFileAsync("docker", [
      "volume",
      "inspect",
      liveVolume,
    ]);
    expect(inspectCheck.stdout).toContain(liveVolume);

    // 5. Tear down container (simulating container drop after failed checkpoint)
    await execFileAsync("docker", ["rm", "-f", liveContainer]);

    // 6. Inspect volume: activeContainers should now be empty
    const idleInfo = await inspectWorkspaceVolume(liveVolume);
    expect(idleInfo).toBeDefined();
    expect(idleInfo?.activeContainers).toEqual([]);

    // 7. Checkpoint store with verified reference
    const mockStore: CheckpointStore = {
      latest: async () => ({
        checkpointId: "ckpt-verified-live",
        digest: "b".repeat(64),
      }),
      read: async () => new Uint8Array(),
      write: async () => ({
        bytes: 100,
        checkpointId: "ckpt-verified-live",
        digest: "b".repeat(64),
      }),
    };

    // 8. Reclaim idle volume with verified checkpoint: MUST succeed
    const reclaimResult = await reclaimRetainedWorkspaceVolume(liveVolume, {
      checkpointStore: mockStore,
    });
    expect(reclaimResult.status).toBe("reclaimed");

    // 9. Verify volume is completely gone from Docker host
    await expect(
      execFileAsync("docker", ["volume", "inspect", liveVolume])
    ).rejects.toThrow();
  }, 120_000);

  it("ignores non-Reasonate host volumes during sweep", async () => {
    // 1. Create a non-Reasonate host volume
    await execFileAsync("docker", ["volume", "create", hostGuardVolume]);

    // 2. List retained volumes: hostGuardVolume must not be present
    const listed = await listRetainedWorkspaceVolumes();
    expect(listed.some((v) => v.volumeName === hostGuardVolume)).toBe(false);

    // 3. Run sweep with force=true
    const scope = parseWorkspaceVolumeName(liveVolume);
    if (!scope) {
      throw new Error("Invalid test volume scope");
    }
    await reclaimRetainedWorkspaceVolumes({
      force: true,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
    });

    // 4. Verify hostGuardVolume still exists completely untouched
    const guardCheck = await execFileAsync("docker", [
      "volume",
      "inspect",
      hostGuardVolume,
    ]);
    expect(guardCheck.stdout).toContain(hostGuardVolume);

    // Clean up guard volume
    await execFileAsync("docker", ["volume", "rm", "-f", hostGuardVolume]);
  }, 60_000);
});
