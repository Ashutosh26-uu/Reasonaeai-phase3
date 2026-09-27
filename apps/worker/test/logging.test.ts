import { describe, expect, it } from "vitest";
import { createLogger, type Logger } from "../src/logger.js";

function capture(level: "debug" | "info"): {
  lines: string[];
  logger: Logger;
} {
  const lines: string[] = [];
  return {
    lines,
    logger: createLogger({
      level,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      write: (line) => {
        lines.push(line);
      },
    }),
  };
}

describe("worker logging", () => {
  it("writes one structured line carrying the run's identity", () => {
    const { lines, logger } = capture("info");
    logger.info("run.claimed", {
      buildSessionId: "b",
      organizationId: "o",
      projectId: "p",
      runId: "r",
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(String(lines[0]))).toEqual({
      at: "2026-01-01T00:00:00.000Z",
      buildSessionId: "b",
      event: "run.claimed",
      level: "info",
      organizationId: "o",
      projectId: "p",
      runId: "r",
    });
  });

  it("never writes a field named after a credential", () => {
    const { lines, logger } = capture("info");
    logger.info("run.claimed", {
      apiKey: "sk-live-abc",
      authorization: "Bearer abc",
      prompt: "the user's private instruction",
      runId: "r",
      token: "t",
    });

    expect(lines[0]).not.toContain("sk-live-abc");
    expect(lines[0]).not.toContain("Bearer abc");
    expect(lines[0]).not.toContain("private instruction");
    expect(lines[0]).toContain("[redacted]");
  });

  it("bounds a logged value and drops what it cannot write", () => {
    const { lines, logger } = capture("info");
    logger.info("run.failed", { reason: "x".repeat(1000), runId: undefined });

    const parsed = JSON.parse(String(lines[0])) as Record<string, unknown>;
    expect(String(parsed.reason).length).toBeLessThanOrEqual(513);
    expect("runId" in parsed).toBe(false);
  });

  it("stays silent below its configured level", () => {
    const { lines, logger } = capture("info");
    logger.debug("run.lease.renewed", { runId: "r" });
    expect(lines).toHaveLength(0);
  });
});
