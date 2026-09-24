import { describe, expect, it } from "vitest";
import {
  createMastraSandbox,
  MastraWorkspaceSandboxAdapter,
} from "../src/mastra-adapter.js";
import { MockSandboxProvider } from "../src/mock-sandbox.js";

const projectId = "22222222-2222-4222-8222-222222222222";
const mockSandboxId = "55555555-5555-4555-8555-555555555555";
const dockerSandboxId = "66666666-6666-4666-8666-666666666666";

describe("MastraWorkspaceSandboxAdapter with MockSandbox", () => {
  it("bridges ISandbox to Mastra WorkspaceSandbox contract seamlessly", async () => {
    const mockProvider = new MockSandboxProvider();
    const sandbox = await mockProvider.create({
      cpuLimit: 1.5,
      id: mockSandboxId,
      image: "node:22-alpine",
      memoryLimitMb: 1024,
      networkMode: "none",
      projectId,
      runId: null,
      workdir: "/workspace",
    });

    const state = await sandbox.getState();

    const adapter = new MastraWorkspaceSandboxAdapter({
      config: state.config,
      name: "TestMockAdapter",
      provider: "mock-provider",
      sandbox,
    });

    expect(adapter.id).toBe(mockSandboxId);
    expect(adapter.name).toBe("TestMockAdapter");
    expect(adapter.provider).toBe("mock-provider");
    expect(adapter.supportsCheckpoints).toBe(false);

    // Initial start
    const startResult = await adapter.start();
    expect(startResult.outcome).toBe("connected");
    expect(adapter.status).toBe("running");
    expect(await adapter.isReady()).toBe(true);

    // Accurate resource / cgroup facts reporting
    const info = await adapter.getInfo();
    expect(info.id).toBe(mockSandboxId);
    expect(info.status).toBe("running");
    expect(info.resources?.cpuCores).toBe(1.5);
    expect(info.resources?.memoryMB).toBe(1024);

    // executeCommand mapping
    let stdoutCaptured = "";
    const cmdResult = await adapter.executeCommand("npm", ["run", "build"], {
      onStdout: (data) => {
        stdoutCaptured += data;
      },
    });

    expect(cmdResult.success).toBe(true);
    expect(cmdResult.exitCode).toBe(0);
    expect(cmdResult.command).toBe("npm");
    expect(cmdResult.args).toEqual(["run", "build"]);
    expect(cmdResult.stdout).toContain("[mock] executed: npm run build");
    expect(stdoutCaptured).toContain("[mock] executed: npm run build");

    // writeFiles support
    await adapter.writeFiles([
      { content: "const a = 1;", path: "/workspace/src/app.ts" },
    ]);
    const readBack = await sandbox.readFile("src/app.ts");
    expect(readBack).toBe("const a = 1;");

    // AbortSignal handling on executeCommand
    const controller = new AbortController();
    controller.abort();
    await expect(
      adapter.executeCommand("ls", [], { abortSignal: controller.signal })
    ).rejects.toThrow("Command aborted");

    // AbortSignal handling on writeFiles
    await expect(
      adapter.writeFiles([{ content: "test", path: "test.txt" }], {
        abortSignal: controller.signal,
      })
    ).rejects.toThrow("Write files aborted");

    // Snapshot no-op
    await expect(adapter.snapshot()).resolves.toBeUndefined();

    // Lifecycle: stop and destroy
    await adapter.stop();
    expect(adapter.status).toBe("stopped");

    await adapter.destroy();
    expect(adapter.status).toBe("destroyed");
    const destroyedState = await sandbox.getState();
    expect(destroyedState.status).toBe("destroyed");
  });
});

describe("createMastraSandbox with DockerSandbox", () => {
  it("initializes, executes commands in Docker, reports cgroups, and tears down cleanly", async () => {
    const adapter = createMastraSandbox({
      cpuLimit: 1.0,
      env: { TEST_VAR: "reasonate_rocks" },
      id: dockerSandboxId,
      image: "alpine:latest",
      memoryLimitMb: 256,
      networkMode: "none",
      projectId,
      runId: null,
      timeoutMs: 15_000,
      workdir: "/workspace",
    });

    expect(adapter.id).toBe(dockerSandboxId);
    expect(adapter.supportsCheckpoints).toBe(false);

    // Lifecycle start
    const startResult = await adapter.start();
    expect(startResult.outcome).toBe("created");
    expect(adapter.status).toBe("running");

    // Check enforced capacity facts
    const info = await adapter.getInfo();
    expect(info.resources?.cpuCores).toBe(1.0);
    expect(info.resources?.memoryMB).toBe(256);

    // Verify HOME is set to /workspace inside container
    const envResult = await adapter.executeCommand("sh", ["-c", "echo $HOME"]);
    expect(envResult.success).toBe(true);
    expect(envResult.stdout.trim()).toBe("/workspace");

    // Verify custom env passed
    const customEnvResult = await adapter.executeCommand("sh", [
      "-c",
      "echo $TEST_VAR",
    ]);
    expect(customEnvResult.success).toBe(true);
    expect(customEnvResult.stdout.trim()).toBe("reasonate_rocks");

    // File writing & reading via writeFiles and executeCommand
    await adapter.writeFiles([
      { content: "Hello from Mastra Adapter", path: "test.txt" },
    ]);
    const catResult = await adapter.executeCommand("cat", ["test.txt"]);
    expect(catResult.success).toBe(true);
    expect(catResult.stdout.trim()).toBe("Hello from Mastra Adapter");

    // Destroy
    await adapter.destroy();
    expect(adapter.status).toBe("destroyed");
  });
});
