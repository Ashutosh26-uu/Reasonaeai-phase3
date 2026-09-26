import { afterEach, describe, expect, it } from "vitest";
import {
  ensureSandboxContainer,
  getSandboxProvider,
  isDockerAvailable,
} from "../src/factory.js";

describe("sandbox factory provider selection", () => {
  const originalSandboxMode = process.env.SANDBOX_MODE;
  const originalProjectStateMode = process.env.PROJECT_STATE_MODE;

  afterEach(() => {
    if (originalSandboxMode === undefined) {
      delete process.env.SANDBOX_MODE;
    } else {
      process.env.SANDBOX_MODE = originalSandboxMode;
    }

    if (originalProjectStateMode === undefined) {
      delete process.env.PROJECT_STATE_MODE;
    } else {
      process.env.PROJECT_STATE_MODE = originalProjectStateMode;
    }
  });

  it("selects MockSandboxProvider when SANDBOX_MODE=mock is explicitly set", async () => {
    process.env.SANDBOX_MODE = "mock";
    const provider = await getSandboxProvider();
    expect(provider.name).toBe("mock");
  });

  it("selects DockerSandboxProvider when Docker is available and mock mode is not enabled", async () => {
    delete process.env.SANDBOX_MODE;
    delete process.env.PROJECT_STATE_MODE;

    const dockerOk = await isDockerAvailable();
    if (dockerOk) {
      const provider = await getSandboxProvider();
      expect(provider.name).toBe("docker");
    }
  }, 15_000);

  it("ensures a real container is created for a build session", async () => {
    delete process.env.SANDBOX_MODE;
    delete process.env.PROJECT_STATE_MODE;

    const dockerOk = await isDockerAvailable();
    if (dockerOk) {
      const sandbox = await ensureSandboxContainer({
        buildSessionId: "00000000-0000-4000-8000-000000000001",
        organizationId: "00000000-0000-4000-8000-000000000002",
        projectId: "00000000-0000-4000-8000-000000000003",
        runId: "00000000-0000-4000-8000-000000000001",
      });

      expect(sandbox.id).toContain("reasonate");
      const state = await sandbox.getState();
      expect(state.status).toBe("running");

      await sandbox.destroy();
    }
  }, 30_000);
});
