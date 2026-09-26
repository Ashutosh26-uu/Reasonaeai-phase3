import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProjectIdSchema, RunIdSchema } from "@reasonateai/contracts/identity";
import type {
  ISandbox,
  ISandboxProvider,
} from "@reasonateai/contracts/sandbox";
import { SandboxIdSchema } from "@reasonateai/contracts/sandbox";
import { type DockerSandbox, DockerSandboxProvider } from "./docker-sandbox.js";
import { MockSandboxProvider } from "./mock-sandbox.js";

const execFileAsync = promisify(execFile);

export async function isDockerAvailable(): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFileAsync("docker", ["info"], {
      timeout: 10_000,
    });
    const combined = (stdout + stderr).toLowerCase();
    if (
      combined.includes("error response from daemon") ||
      combined.includes("cannot connect") ||
      combined.includes("is the docker daemon running")
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function getSandboxProvider(): Promise<ISandboxProvider> {
  const isMockExplicit =
    process.env.SANDBOX_MODE === "mock" ||
    process.env.PROJECT_STATE_MODE === "mock";

  if (isMockExplicit) {
    return new MockSandboxProvider();
  }

  const dockerOk = await isDockerAvailable();
  if (!dockerOk) {
    throw new Error(
      "Docker is required for sandbox execution, but the Docker daemon is not available or not running. Ensure Docker Desktop is running."
    );
  }

  return new DockerSandboxProvider();
}

export async function ensureSandboxContainer(input: {
  buildSessionId: string;
  organizationId: string;
  projectId: string;
  runId: string;
  sandboxEnvironmentId?: string;
  sandboxId?: string;
}): Promise<ISandbox> {
  const provider = await getSandboxProvider();

  const sanitizedBsId = input.buildSessionId.replaceAll(
    /[^a-zA-Z0-9_.-]/g,
    "-"
  );
  const sanitizedOrgId = input.organizationId.replaceAll(
    /[^a-zA-Z0-9_.-]/g,
    "-"
  );
  const sanitizedProjId = input.projectId.replaceAll(/[^a-zA-Z0-9_.-]/g, "-");

  const rawSandboxId =
    input.sandboxId ??
    `reasonate-${sanitizedOrgId}-${sanitizedProjId}-${sanitizedBsId}`;
  const sandboxId = SandboxIdSchema.parse(rawSandboxId);

  let sandbox = await provider.get(sandboxId);
  if (sandbox) {
    const state = await sandbox.getState();
    if (state.status !== "running" && "init" in sandbox) {
      await (sandbox as DockerSandbox).init();
    }
    return sandbox;
  }

  sandbox = await provider.create({
    cpuLimit: 2,
    env: {},
    id: sandboxId,
    image: "node:20-alpine",
    memoryLimitMb: 512,
    networkMode: "bridge",
    projectId: ProjectIdSchema.parse(input.projectId),
    runId: RunIdSchema.parse(input.runId),
    timeoutMs: 120_000,
    workdir: "/workspace",
  });

  return sandbox;
}
