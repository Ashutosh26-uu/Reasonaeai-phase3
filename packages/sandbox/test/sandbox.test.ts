import { afterAll, describe, expect, it } from "vitest";
import { DockerSandboxProvider } from "../src/docker-sandbox.js";
import { MockSandboxProvider } from "../src/mock-sandbox.js";

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

describe("DockerSandboxProvider", () => {
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

    // Path traversal rejection
    await expect(
      sandbox.writeFile("../escape.txt", "malicious")
    ).rejects.toThrow("Path traversal detected");

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
  });
});
