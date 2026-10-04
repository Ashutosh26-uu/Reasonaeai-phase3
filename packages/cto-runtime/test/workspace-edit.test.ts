import type {
  CopyOptions,
  FileContent,
  FileEntry,
  FileStat,
  ListOptions,
  ReadOptions,
  RemoveOptions,
  WorkspaceFilesystem,
  WriteOptions,
} from "@mastra/core/workspace";
import { describe, expect, it } from "vitest";

import { createWorkspaceEditTool } from "../src/tools/edit.js";
import { ReadSnapshotStore } from "../src/tools/read-snapshots.js";
import { createWorkspaceReadTool } from "../src/tools/workspace-read.js";
import { createWorkspaceWriteTool } from "../src/tools/write.js";

const FILE_TAG_RE = /#([0-9A-F]{4})/i;

class InMemoryWorkspaceFilesystem implements WorkspaceFilesystem {
  readonly id = "mock-workspace-fs";
  readonly name = "InMemoryWorkspaceFilesystem";
  readonly provider = "mock";
  status = "ready" as const;
  readonly files = new Map<string, string>();

  constructor(initialFiles: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initialFiles)) {
      this.files.set(key, value);
    }
  }

  readFile(path: string, _options?: ReadOptions): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      const error = new Error(
        `ENOENT: no such file or directory, open '${path}'`
      ) as Error & { code?: string };
      error.code = "ENOENT";
      return Promise.reject(error);
    }
    return Promise.resolve(content);
  }

  writeFile(
    path: string,
    content: FileContent,
    _options?: WriteOptions
  ): Promise<void> {
    this.files.set(
      path,
      typeof content === "string" ? content : content.toString()
    );
    return Promise.resolve();
  }

  deleteFile(path: string, _options?: RemoveOptions): Promise<void> {
    if (!this.files.delete(path)) {
      const error = new Error(
        `ENOENT: no such file or directory, unlink '${path}'`
      ) as Error & { code?: string };
      error.code = "ENOENT";
      return Promise.reject(error);
    }
    return Promise.resolve();
  }

  async moveFile(
    source: string,
    destination: string,
    _options?: CopyOptions
  ): Promise<void> {
    const content = await this.readFile(source);
    await this.writeFile(destination, content);
    await this.deleteFile(source);
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }

  appendFile(path: string, content: FileContent): Promise<void> {
    const existing = this.files.get(path) ?? "";
    const addition = typeof content === "string" ? content : content.toString();
    this.files.set(path, existing + addition);
    return Promise.resolve();
  }

  async copyFile(
    source: string,
    destination: string,
    _options?: CopyOptions
  ): Promise<void> {
    const content = await this.readFile(source);
    await this.writeFile(destination, content);
  }

  mkdir(): Promise<void> {
    return Promise.resolve();
  }

  rmdir(): Promise<void> {
    return Promise.resolve();
  }

  readdir(_path: string, _options?: ListOptions): Promise<FileEntry[]> {
    return Promise.resolve([]);
  }

  stat(path: string): Promise<FileStat> {
    const content = this.files.get(path);
    if (content === undefined) {
      const error = new Error(`ENOENT: '${path}'`) as Error & { code?: string };
      error.code = "ENOENT";
      return Promise.reject(error);
    }
    return Promise.resolve({
      createdAt: new Date(),
      modifiedAt: new Date(),
      name: path.split("/").pop() ?? "",
      path,
      size: content.length,
      type: "file",
    });
  }
}

describe("createWorkspaceEditTool path handling", () => {
  const dummyContext = { requestContext: {} } as never;
  const run = (
    tool: ReturnType<typeof createWorkspaceEditTool>,
    args: Parameters<NonNullable<(typeof tool)["execute"]>>[0]
  ) => {
    if (!tool.execute) {
      throw new Error("tool.execute is undefined");
    }
    return tool.execute(args, dummyContext);
  };

  it("handles relative, shortcut-relative, absolute, Windows, and scheme paths in exact mode", async () => {
    const initialText = "export const answer = 42;\n";
    const workspaceFs = new InMemoryWorkspaceFilesystem({
      "/workspace/src/app.ts": initialText,
    });
    const snapshots = new ReadSnapshotStore(undefined, async (path) => path);

    const tool = createWorkspaceEditTool({
      resolveFilesystem: async () => workspaceFs,
      resolveSnapshots: async () => snapshots,
      root: "/workspace",
    });

    // 1. Relative path: src/app.ts
    const res1 = await run(tool, {
      newString: "export const answer = 43;",
      oldString: "export const answer = 42;",
      path: "src/app.ts",
    });
    expect(res1).toContain("+export const answer = 43;");
    expect(workspaceFs.files.get("/workspace/src/app.ts")).toBe(
      "export const answer = 43;\n"
    );

    // 2. Absolute workspace path with Windows separators
    const res2 = await run(tool, {
      newString: "export const answer = 44;",
      oldString: "export const answer = 43;",
      path: "\\workspace\\src\\app.ts",
    });
    expect(res2).toContain("+export const answer = 44;");
    expect(workspaceFs.files.get("/workspace/src/app.ts")).toBe(
      "export const answer = 44;\n"
    );

    // 3. Full workspace path: /workspace/src/app.ts
    const res3 = await run(tool, {
      newString: "export const answer = 45;",
      oldString: "export const answer = 44;",
      path: "/workspace/src/app.ts",
    });
    expect(res3).toContain("+export const answer = 45;");
    expect(workspaceFs.files.get("/workspace/src/app.ts")).toBe(
      "export const answer = 45;\n"
    );

    // 4. Windows-style backslash: src\app.ts
    const res4 = await run(tool, {
      newString: "export const answer = 46;",
      oldString: "export const answer = 45;",
      path: "src\\app.ts",
    });
    expect(res4).toContain("+export const answer = 46;");
    expect(workspaceFs.files.get("/workspace/src/app.ts")).toBe(
      "export const answer = 46;\n"
    );

    // 5. Scheme prefix: @/src/app.ts
    const res5 = await run(tool, {
      newString: "export const answer = 47;",
      oldString: "export const answer = 46;",
      path: "@/src/app.ts",
    });
    expect(res5).toContain("+export const answer = 47;");
    expect(workspaceFs.files.get("/workspace/src/app.ts")).toBe(
      "export const answer = 47;\n"
    );

    // 6. file:// prefix: file:///workspace/src/app.ts
    const res6 = await run(tool, {
      newString: "export const answer = 48;",
      oldString: "export const answer = 47;",
      path: "file:///workspace/src/app.ts",
    });
    expect(res6).toContain("+export const answer = 48;");
    expect(workspaceFs.files.get("/workspace/src/app.ts")).toBe(
      "export const answer = 48;\n"
    );

    // 7. Windows drive letter with workspace root: C:\workspace\src\app.ts
    const res7 = await run(tool, {
      newString: "export const answer = 49;",
      oldString: "export const answer = 48;",
      path: "C:\\workspace\\src\\app.ts",
    });
    expect(res7).toContain("+export const answer = 49;");
    expect(workspaceFs.files.get("/workspace/src/app.ts")).toBe(
      "export const answer = 49;\n"
    );

    // 8. Windows drive-prefixed file URI
    const res8 = await run(tool, {
      newString: "export const answer = 50;",
      oldString: "export const answer = 49;",
      path: "file:///C:/workspace/src/app.ts",
    });
    expect(res8).toContain("+export const answer = 50;");
    expect(workspaceFs.files.get("/workspace/src/app.ts")).toBe(
      "export const answer = 50;\n"
    );
  });

  it("handles hashline patches with relative, shortcut, and full paths", async () => {
    const text = "first line\nsecond line\nthird line\n";
    const workspaceFs = new InMemoryWorkspaceFilesystem({
      "/workspace/src/math.ts": text,
    });
    const snapshots = new ReadSnapshotStore(undefined, async (path) => path);
    const tag = await snapshots.record(
      "/workspace/src/math.ts",
      text,
      [1, 2, 3]
    );

    const tool = createWorkspaceEditTool({
      resolveFilesystem: async () => workspaceFs,
      resolveSnapshots: async () => snapshots,
      root: "/workspace",
    });

    // Hashline patch with relative path
    const res1 = await run(tool, {
      patch: `[src/math.ts#${tag}]\nSWAP 2.=2:\n+REPLACED line\n`,
    });
    expect(res1).toContain("update");
    expect(workspaceFs.files.get("/workspace/src/math.ts")).toBe(
      "first line\nREPLACED line\nthird line\n"
    );

    // Re-record for next turn
    const updatedText = workspaceFs.files.get("/workspace/src/math.ts") ?? "";
    const tag2 = await snapshots.record(
      "/workspace/src/math.ts",
      updatedText,
      [1, 2, 3]
    );

    // Hashline patch with leading slash path
    const res2 = await run(tool, {
      patch: `[@/src/math.ts#${tag2}]\nSWAP 1.=1:\n+HEADER line\n`,
    });
    expect(res2).toContain("update");
    expect(workspaceFs.files.get("/workspace/src/math.ts")).toBe(
      "HEADER line\nREPLACED line\nthird line\n"
    );

    // Re-record for next turn
    const updatedText2 = workspaceFs.files.get("/workspace/src/math.ts") ?? "";
    const tag3 = await snapshots.record(
      "/workspace/src/math.ts",
      updatedText2,
      [1, 2, 3]
    );

    // Hashline patch with full workspace path
    const res3 = await run(tool, {
      patch: `[/workspace/src/math.ts#${tag3}]\nSWAP 3.=3:\n+FOOTER line\n`,
    });
    expect(res3).toContain("update");
    expect(workspaceFs.files.get("/workspace/src/math.ts")).toBe(
      "HEADER line\nREPLACED line\nFOOTER line\n"
    );
  });

  it("strictly rejects directory traversal and escaping paths", async () => {
    const workspaceFs = new InMemoryWorkspaceFilesystem();
    const snapshots = new ReadSnapshotStore(undefined, async (path) => path);

    const tool = createWorkspaceEditTool({
      resolveFilesystem: async () => workspaceFs,
      resolveSnapshots: async () => snapshots,
      root: "/workspace",
    });

    await expect(
      run(tool, {
        newString: "hack",
        oldString: "root",
        path: "../../etc/shadow",
      })
    ).rejects.toThrow("escapes the verified workspace");

    await expect(
      run(tool, {
        newString: "hack",
        oldString: "root",
        path: "/../../etc/shadow",
      })
    ).rejects.toThrow("escapes the verified workspace");

    await expect(
      run(tool, {
        newString: "hack",
        oldString: "root",
        path: "/workspace/../../etc/shadow",
      })
    ).rejects.toThrow("escapes the verified workspace");

    await expect(
      run(tool, {
        newString: "hack",
        oldString: "root",
        path: "~/home-secret",
      })
    ).rejects.toThrow("Home-directory paths are not available");
  });
});

describe("consistent workspace file tools", () => {
  const context = { requestContext: {} } as never;
  it.each([
    "@scope/app.ts",
    "/workspace/@scope/app.ts",
    "@/@scope/app.ts",
    "@scope\\app.ts",
    "C:\\workspace\\@scope\\app.ts",
    "file:///workspace/%40scope/app.ts",
  ])("reads, edits, and writes the same file for %s", async (path) => {
    const filesystem = new InMemoryWorkspaceFilesystem({
      "/workspace/scope/app.ts": "other file\n",
    });
    const snapshots = new ReadSnapshotStore(
      undefined,
      async (target) => target
    );
    const options = {
      resolveFilesystem: async () => filesystem,
      resolveSnapshots: async () => snapshots,
      root: "/workspace",
    };
    const read = createWorkspaceReadTool(options);
    const write = createWorkspaceWriteTool(options);
    const edit = createWorkspaceEditTool(options);
    if (!(read.execute && write.execute && edit.execute)) {
      throw new Error("Missing file tool execution");
    }
    await write.execute({ content: "before\n", path }, context);
    const first = await read.execute({ target: `${path}:1` }, context);
    expect(first).toContain("before");
    await edit.execute(
      { newString: "exact", oldString: "before", path },
      context
    );
    const [anchor] = String(
      await read.execute({ target: path }, context)
    ).split("\n");
    await edit.execute(
      { patch: `${anchor}\nSWAP 1.=1:\n+hashline\n` },
      context
    );
    const readBack = String(await read.execute({ target: path }, context));
    const expectedHash = readBack.match(FILE_TAG_RE)?.[1];
    if (!expectedHash) {
      throw new Error("Read did not mint an anchor");
    }
    await write.execute({ content: "written\n", expectedHash, path }, context);
    expect(filesystem.files.get("/workspace/@scope/app.ts")).toBe("written\n");
    expect(filesystem.files.get("/workspace/scope/app.ts")).toBe(
      "other file\n"
    );
  });

  it.each([
    "/src/app.ts",
    "C:\\src\\app.ts",
    "file:///src/app.ts",
    "../secret",
  ])("rejects the same outside path in every tool: %s", async (path) => {
    const filesystem = new InMemoryWorkspaceFilesystem();
    const snapshots = new ReadSnapshotStore(
      undefined,
      async (target) => target
    );
    const options = {
      resolveFilesystem: async () => filesystem,
      resolveSnapshots: async () => snapshots,
      root: "/workspace",
    };
    const read = createWorkspaceReadTool(options);
    const write = createWorkspaceWriteTool(options);
    const edit = createWorkspaceEditTool(options);
    if (!(read.execute && write.execute && edit.execute)) {
      throw new Error("Missing file tool execution");
    }
    await expect(read.execute({ target: path }, context)).rejects.toThrow(
      "escapes the verified workspace"
    );
    await expect(
      write.execute({ content: "bad", path }, context)
    ).rejects.toThrow("escapes the verified workspace");
    await expect(
      edit.execute({ newString: "bad", oldString: "old", path }, context)
    ).rejects.toThrow("escapes the verified workspace");
    await expect(
      edit.execute({ patch: `[${path}#ABCD]\nSWAP 1.=1:\n+bad\n` }, context)
    ).rejects.toThrow("escapes the verified workspace");
    expect(filesystem.files.size).toBe(0);
  });
});
