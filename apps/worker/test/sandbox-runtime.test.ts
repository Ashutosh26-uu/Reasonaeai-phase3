import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  SandboxConfigSchema,
  SandboxIdSchema,
} from "@reasonateai/contracts/sandbox";
import { DockerSandbox } from "@reasonateai/sandbox/docker";
import { MastraWorkspaceSandboxAdapter } from "@reasonateai/sandbox/mastra";
import { describe, expect, it } from "vitest";

const describeWithImage =
  process.env.REASONATE_TEST_BUILD_SANDBOX_IMAGE === "1"
    ? describe
    : describe.skip;
const NODE_22_VERSION_PATTERN = /v22\./;

describeWithImage("build sandbox runtimes", () => {
  it("provides Node.js, Python, Go, and the optional Next/Vitest starter", async () => {
    const workspaceVolume = `${randomUUID()}-workspace`;
    const config = SandboxConfigSchema.parse({
      cpuLimit: 1,
      env: { HOME: "/workspace" },
      id: SandboxIdSchema.parse(randomUUID()),
      image:
        process.env.REASONATE_BUILD_SANDBOX_IMAGE ??
        "reasonate-build-sandbox:node22",
      memoryLimitMb: 2048,
      mounts: [
        {
          source: workspaceVolume,
          target: "/workspace",
          type: "volume",
        },
      ],
      networkMode: "none",
      ports: [],
      projectId: randomUUID(),
      runId: randomUUID(),
      timeoutMs: 30_000,
      workdir: "/workspace",
    });
    const sandbox = new DockerSandbox(config);
    const workspaceSandbox = new MastraWorkspaceSandboxAdapter({
      config,
      sandbox,
    });

    try {
      await workspaceSandbox.start();
      const versions = await workspaceSandbox.executeCommand(
        "sh",
        [
          "-c",
          "node --version && python3 --version && python3 -c \"import fastapi,httpx,matplotlib,numpy,openpyxl,pandas,PIL,plotly,pydantic,pytest,seaborn,uvicorn; assert matplotlib.get_backend().lower() == 'agg'\" && go version && test -x /opt/reasonate/templates/next-shadcn/node_modules/.bin/vitest && test -x /opt/reasonate/templates/next-shadcn/node_modules/.bin/next",
        ],
        { cwd: "/workspace", timeout: 10_000 }
      );

      expect(versions.exitCode).toBe(0);
      expect(versions.stdout).toMatch(NODE_22_VERSION_PATTERN);
      expect(versions.stdout).toContain("Python 3.");
      expect(versions.stdout).toContain("go version go1.27.1");
      expect(versions.stderr).toBe("");
    } finally {
      try {
        await workspaceSandbox.destroy();
      } finally {
        execFileSync("docker", ["volume", "rm", workspaceVolume], {
          stdio: "ignore",
        });
      }
    }
  }, 60_000);
});
