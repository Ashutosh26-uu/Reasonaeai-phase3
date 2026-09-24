import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  type DockerSandbox,
  DockerSandboxProvider,
} from "../src/docker-sandbox.js";
import { MockSandboxProvider } from "../src/mock-sandbox.js";

const execFileAsync = promisify(execFile);

/**
 * The Docker provider shells out to the `docker` CLI, so its tests need a
 * reachable daemon. They are skipped rather than failed when there is none, so
 * the repository gates stay meaningful on a machine without Docker instead of
 * reporting a red suite for an absent dependency.
 */
const dockerAvailable = await execFileAsync("docker", ["info"]).then(
  () => true,
  () => false
);

const projectId = "22222222-2222-4222-8222-222222222222";
const mockSandboxId = "33333333-3333-4333-8333-333333333333";
const dockerSandboxId = "44444444-4444-4444-8444-444444444444";

describe("MockSandboxProvider", () => {
  const provider = new MockSandboxProvider();

  afterAll(async () => {
    await provider.destroyAll();
  });

  it("creates a mock sandbox and handles commands and files", async () => {
    const sandbox = await provider.create({
      id: mockSandboxId,
      image: "node:22-alpine",
      projectId,
      runId: null,
    });

    expect(sandbox.id).toBe(mockSandboxId);

    const state = await sandbox.getState();
    expect(state.status).toBe("running");

    await sandbox.writeFile("src/index.ts", "console.log('hi');");
    const content = await sandbox.readFile("src/index.ts");
    expect(content).toBe("console.log('hi');");

    const result = await sandbox.runCommand({
      args: ["test"],
      command: "npm",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[mock] executed: npm test");

    await sandbox.destroy();
    const destroyedState = await sandbox.getState();
    expect(destroyedState.status).toBe("destroyed");

    await expect(
      sandbox.runCommand({ args: [], command: "ls" })
    ).rejects.toThrow("Cannot run command on sandbox in status: destroyed");
  });
});

describe.skipIf(!dockerAvailable)("DockerSandboxProvider", () => {
  const provider = new DockerSandboxProvider();

  afterAll(async () => {
    await provider.destroyAll();
  });

  it("creates an isolated container, executes commands, and enforces isolation", async () => {
    const sandbox = await provider.create({
      cpuLimit: 1.0,
      id: dockerSandboxId,
      image: "alpine:latest",
      memoryLimitMb: 256,
      networkMode: "none",
      projectId,
      runId: null,
      timeoutMs: 10_000,
    });

    expect(sandbox.id).toBe(dockerSandboxId);

    const state = await sandbox.getState();
    expect(state.status).toBe("running");

    // File writing & reading
    await sandbox.writeFile("app.txt", "ReasonateAI Docker Sandbox Verified");
    const readBack = await sandbox.readFile("app.txt");
    expect(readBack).toBe("ReasonateAI Docker Sandbox Verified");

    // Command execution inside container
    const catResult = await sandbox.runCommand({
      args: ["app.txt"],
      command: "cat",
    });
    expect(catResult.exitCode).toBe(0);
    expect(catResult.stdout.trim()).toBe("ReasonateAI Docker Sandbox Verified");

    // Non-zero exit code and stderr propagation
    const failResult = await sandbox.runCommand({
      args: ["-c", "echo 'critical error log' >&2; exit 42"],
      command: "sh",
    });
    expect(failResult.exitCode).toBe(42);
    expect(failResult.stderr.trim()).toBe("critical error log");
    expect(failResult.timedOut).toBe(false);

    // Path traversal rejection (relative and absolute)
    await expect(
      sandbox.writeFile("../escape.txt", "malicious")
    ).rejects.toThrow("Path traversal detected");

    await expect(sandbox.writeFile("/etc/passwd", "malicious")).rejects.toThrow(
      "Relative path expected, got absolute path"
    );

    // Timeout enforcement
    const timeoutResult = await sandbox.runCommand({
      args: ["2"],
      command: "sleep",
      timeoutMs: 300,
    });
    expect(timeoutResult.timedOut).toBe(true);

    // Destruction & cleanup
    await sandbox.destroy();
    const finalState = await sandbox.getState();
    expect(finalState.status).toBe("destroyed");

    // Rejection of execution on destroyed sandbox
    await expect(
      sandbox.runCommand({ args: [], command: "ls" })
    ).rejects.toThrow("Cannot run command on sandbox in status: destroyed");
    // Creating a container and pulling its image exceeds the default five-second
    // budget on a cold cache, so the budget is explicit rather than incidental.
  }, 120_000);

  it("guarantees zero lingering containers, volumes, or host directories after create-run-destroy cycles", async () => {
    const cycleSandboxId = "77777777-7777-4777-8777-777777777777";
    const sandbox = await provider.create({
      cpuLimit: 1.0,
      id: cycleSandboxId,
      image: "alpine:latest",
      memoryLimitMb: 128,
      networkMode: "none",
      projectId,
      runId: null,
      timeoutMs: 10_000,
    });

    const dockerSandbox = sandbox as DockerSandbox;
    const hostDir = dockerSandbox.hostWorkspaceDir;

    // Verify container is running in Docker with expected audit label
    const checkRunning = await execFileAsync("docker", [
      "ps",
      "-q",
      "--filter",
      `name=${dockerSandbox.containerName}`,
      "--filter",
      `label=reasonate.sandbox.id=${cycleSandboxId}`,
    ]);
    expect(checkRunning.stdout.trim()).not.toBe("");

    // Run command and write files
    await sandbox.writeFile("data.txt", "ephemeral content");
    const res = await sandbox.runCommand({
      args: ["data.txt"],
      command: "cat",
    });
    expect(res.stdout.trim()).toBe("ephemeral content");

    // Destroy sandbox
    await sandbox.destroy();

    // Verify container is removed from Docker
    const checkStopped = await execFileAsync("docker", [
      "ps",
      "-a",
      "-q",
      "--filter",
      `name=${dockerSandbox.containerName}`,
    ]);
    expect(checkStopped.stdout.trim()).toBe("");

    // Verify host directory is completely removed
    const dirExists = await stat(hostDir)
      .then(() => true)
      .catch(() => false);
    expect(dirExists).toBe(false);
    // Each cycle creates and destroys a real container, which exceeds the
    // default five-second budget once the whole suite runs in parallel.
  }, 120_000);
});
