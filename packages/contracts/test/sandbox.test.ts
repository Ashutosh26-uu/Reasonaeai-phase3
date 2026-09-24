import { describe, expect, it } from "vitest";
import {
  RunCommandRequestSchema,
  RunCommandResultSchema,
  SandboxConfigSchema,
  SandboxStateSchema,
} from "../src/sandbox.js";

const sandboxId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";

describe("sandbox contracts", () => {
  it("parses valid sandbox config with defaults applied", () => {
    const parsed = SandboxConfigSchema.parse({
      id: sandboxId,
      image: "node:22-alpine",
      projectId,
      runId,
    });

    expect(parsed.id).toBe(sandboxId);
    expect(parsed.memoryLimitMb).toBe(512);
    expect(parsed.cpuLimit).toBe(1.0);
    expect(parsed.timeoutMs).toBe(30_000);
    expect(parsed.networkMode).toBe("none");
    expect(parsed.workdir).toBe("/workspace");
  });

  it("parses scoped alphanumeric sandbox IDs", () => {
    const scopedId = "reasonate-org1-proj1-session1";
    const parsed = SandboxConfigSchema.parse({
      id: scopedId,
      image: "node:22-alpine",
      projectId,
      runId,
    });
    expect(parsed.id).toBe(scopedId);
  });

  it("rejects unknown config fields due to strictObject", () => {
    const result = SandboxConfigSchema.safeParse({
      id: sandboxId,
      image: "node:22-alpine",
      projectId,
      runId,
      unauthorizedMount: "/var/run/docker.sock",
    });

    expect(result.success).toBe(false);
  });

  it("enforces memory bounds to prevent resource exhaustion", () => {
    const tooLow = SandboxConfigSchema.safeParse({
      id: sandboxId,
      image: "node:22-alpine",
      memoryLimitMb: 16,
      projectId,
      runId: null,
    });
    expect(tooLow.success).toBe(false);

    const tooHigh = SandboxConfigSchema.safeParse({
      id: sandboxId,
      image: "node:22-alpine",
      memoryLimitMb: 8192,
      projectId,
      runId: null,
    });
    expect(tooHigh.success).toBe(false);
  });

  it("parses and validates command requests", () => {
    const req = RunCommandRequestSchema.parse({
      args: ["run", "test"],
      command: "npm",
      timeoutMs: 15_000,
    });

    expect(req.command).toBe("npm");
    expect(req.args).toEqual(["run", "test"]);
    expect(req.timeoutMs).toBe(15_000);
  });

  it("validates run command results with exit codes and timings", () => {
    const res = RunCommandResultSchema.parse({
      durationMs: 450,
      exitCode: 0,
      stderr: "",
      stdout: "Tests passed: 5/5",
      timedOut: false,
    });

    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
  });

  it("validates sandbox state transitions strictly", () => {
    const state = SandboxStateSchema.parse({
      config: {
        cpuLimit: 1.0,
        env: {},
        id: sandboxId,
        image: "node:22-alpine",
        memoryLimitMb: 512,
        networkMode: "none",
        projectId,
        runId: null,
        timeoutMs: 30_000,
        workdir: "/workspace",
      },
      createdAt: "2026-09-22T12:00:00.000Z",
      id: sandboxId,
      status: "running",
      stoppedAt: null,
    });

    expect(state.status).toBe("running");
  });
});
