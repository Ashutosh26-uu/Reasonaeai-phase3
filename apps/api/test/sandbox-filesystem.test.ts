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
      "escapes the verified workspace"
    );
    await expect(filesystem.readFile("/../../host-secret")).rejects.toThrow(
      "escapes the verified workspace"
    );
    await expect(
      filesystem.readFile("/workspace/../../host-secret")
    ).rejects.toThrow("escapes the verified workspace");
  });

  it("normalizes explicit shortcut, full workspace, and Windows-style paths to the workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "reasonate-sandbox-fs-"));
    const filesystem = new SandboxFilesystem({
      id: "test-filesystem",
      root: "/workspace",
      sandbox: testSandbox(root),
    });

    // Write using explicit shortcut
    await filesystem.writeFile("@/src/index.ts", "console.log('hello');\n", {
      recursive: true,
    });

    // Read using relative path
    expect(
      await filesystem.readFile("src/index.ts", { encoding: "utf8" })
    ).toBe("console.log('hello');\n");

    // Read using full workspace path
    expect(
      await filesystem.readFile("/workspace/src/index.ts", { encoding: "utf8" })
    ).toBe("console.log('hello');\n");

    // Read using Windows backslash
    expect(
      await filesystem.readFile("src\\index.ts", { encoding: "utf8" })
    ).toBe("console.log('hello');\n");

    // Read using explicit shortcut
    expect(
      await filesystem.readFile("@/src/index.ts", { encoding: "utf8" })
    ).toBe("console.log('hello');\n");

    // Read using Windows drive letter with workspace
    expect(
      await filesystem.readFile("C:\\workspace\\src\\index.ts", {
        encoding: "utf8",
      })
    ).toBe("console.log('hello');\n");

    // Read using Windows drive letter with absolute workspace path
    expect(
      await filesystem.readFile("C:\\workspace\\src\\index.ts", {
        encoding: "utf8",
      })
    ).toBe("console.log('hello');\n");
  });
});

describe("workspace path contract across filesystem operations", () => {
  it("preserves scoped names through creation, listing, metadata, copy, move, append, and delete", async () => {
    const root = await mkdtemp(join(tmpdir(), "reasonate-sandbox-fs-"));
    const filesystem = new SandboxFilesystem({
      id: "path-contract",
      root: "/workspace",
      sandbox: testSandbox(root),
    });
    await filesystem.writeFile("scope.txt", "other", { recursive: true });
    await filesystem.writeFile("@scope.txt", "first", { recursive: true });
    await filesystem.copyFile("@/@scope.txt", "C:\\workspace\\@copy.txt");
    await filesystem.moveFile("file:///workspace/%40copy.txt", "@moved.txt");
    await filesystem.appendFile("@/@moved.txt", " second");
    expect(await filesystem.readFile("@moved.txt", { encoding: "utf8" })).toBe(
      "first second"
    );
    expect(await filesystem.stat("@/@moved.txt")).toMatchObject({
      name: "@moved.txt",
    });
    expect(await filesystem.readdir("@/")).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "@scope.txt" })])
    );
    await filesystem.deleteFile("file:///workspace/%40moved.txt");
    expect(await filesystem.exists("@moved.txt")).toBe(false);
    expect(await filesystem.readFile("scope.txt", { encoding: "utf8" })).toBe(
      "other"
    );
    expect(await filesystem.readFile("@scope.txt", { encoding: "utf8" })).toBe(
      "first"
    );
    await expect(filesystem.readFile("/scope.txt")).rejects.toThrow(
      "escapes the verified workspace"
    );
    await expect(
      filesystem.copyFile("@scope.txt", "/copy.txt")
    ).rejects.toThrow("escapes the verified workspace");
    await expect(
      filesystem.moveFile("@scope.txt", "C:\\moved.txt")
    ).rejects.toThrow("escapes the verified workspace");
    await expect(filesystem.deleteFile("/scope.txt")).rejects.toThrow(
      "escapes the verified workspace"
    );
  });
});
