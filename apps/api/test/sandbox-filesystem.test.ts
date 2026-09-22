import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WorkspaceSandbox } from "@mastra/core/workspace";
import { describe, expect, it } from "vitest";
import { SandboxFilesystem } from "../src/mastra/sandbox-filesystem";

const exec = promisify(execFile);

function testSandbox(root: string): WorkspaceSandbox {
  return {
    executeCommand: async (command, args, options) => {
      try {
        const payload = args?.[2];
        const mappedArgs = payload
          ? [
              args?.[0] ?? "",
              args?.[1] ?? "",
              Buffer.from(
                Buffer.from(payload, "base64")
                  .toString("utf8")
                  .replaceAll("/workspace", root.split("\\").join("/"))
              ).toString("base64"),
            ]
          : args;
        const result = await exec(command, mappedArgs, {
          cwd: options?.cwd === "/workspace" ? root : options?.cwd,
        });
        return {
          executionTimeMs: 0,
          exitCode: 0,
          stderr: result.stderr,
          stdout: result.stdout,
          success: true,
        };
      } catch (error) {
        const failed = error as {
          code?: number;
          stderr?: string;
          stdout?: string;
        };
        return {
          executionTimeMs: 0,
          exitCode: failed.code ?? 1,
          stderr: failed.stderr ?? "",
          stdout: failed.stdout ?? "",
          success: false,
        };
      }
    },
    id: "test-sandbox",
    name: "Test sandbox",
    provider: "test",
    snapshot: async () => undefined,
    start: async () => undefined,
    status: "ready",
    stop: async () => undefined,
  } as WorkspaceSandbox;
}

describe("SandboxFilesystem", () => {
  it("keeps read, write, listing, and metadata operations in its root", async () => {
    const root = await mkdtemp(join(tmpdir(), "reasonate-sandbox-fs-"));
    const filesystem = new SandboxFilesystem({
      id: "test-filesystem",
      root: "/workspace",
      sandbox: testSandbox(root),
    });

    await filesystem.writeFile("src/app.ts", "export const answer = 42;\n", {
      recursive: true,
    });

    expect(await filesystem.readFile("src/app.ts", { encoding: "utf8" })).toBe(
      "export const answer = 42;\n"
    );
    expect(await filesystem.readdir("src")).toEqual([
      { isSymlink: false, name: "app.ts", type: "file" },
    ]);
    expect(await filesystem.stat("src/app.ts")).toMatchObject({
      path: join(root, "src", "app.ts").split("\\").join("/"),
      size: 26,
      type: "file",
    });
  });

  it("rejects paths that escape the build-session root before calling the sandbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "reasonate-sandbox-fs-"));
    const filesystem = new SandboxFilesystem({
      id: "test-filesystem",
      root: "/workspace",
      sandbox: testSandbox(root),
    });

    await expect(filesystem.readFile("../../host-secret")).rejects.toThrow(
      "escapes the build-session workspace"
    );
  });
});
