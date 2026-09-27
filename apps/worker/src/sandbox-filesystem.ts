import { posix } from "node:path";
import type {
  CopyOptions,
  FileContent,
  FileEntry,
  FileStat,
  ListOptions,
  ProviderStatus,
  ReadOptions,
  RemoveOptions,
  WorkspaceFilesystem,
  WorkspaceSandbox,
  WriteOptions,
} from "@mastra/core/workspace";

/**
 * The API process's sandbox-backed filesystem, carried into the execution
 * plane.
 *
 * A workspace's file operations must run inside the sandbox the agent's
 * commands run in, and the agent's workspace is resolved per request, so the
 * adapter is per-workspace rather than per-process. Applications compose
 * packages and never import each other, so this file mirrors
 * `apps/api/src/mastra/sandbox-filesystem.ts` instead of reaching across
 * applications; the two must stay behaviorally identical because a run's
 * workspace is the same workspace whether a person or a worker started it.
 */

type SandboxFileOperation =
  | "append"
  | "copy"
  | "delete"
  | "exists"
  | "mkdir"
  | "move"
  | "read"
  | "readdir"
  | "rmdir"
  | "stat"
  | "write";

interface SandboxFilesystemResult {
  code?: string;
  message?: string;
  ok: boolean;
  value?: unknown;
}

/**
 * A workspace filesystem whose implementation runs entirely within the
 * build-session sandbox. It is the local Docker adapter; production can replace
 * it with an object-store or remote-volume implementation without changing the
 * CTO tool boundary.
 */
export class SandboxFilesystem implements WorkspaceFilesystem {
  readonly id: string;
  readonly name = "SandboxFilesystem";
  readonly provider = "sandbox";
  status: ProviderStatus = "ready";
  readonly #root: string;
  readonly #sandbox: WorkspaceSandbox;

  constructor(input: { id: string; root: string; sandbox: WorkspaceSandbox }) {
    this.id = input.id;
    this.#root = posix.normalize(input.root);
    this.#sandbox = input.sandbox;
  }

  async appendFile(path: string, content: FileContent): Promise<void> {
    await this.#call("append", {
      content: encode(content),
      path: this.#path(path),
    });
  }

  async copyFile(
    source: string,
    destination: string,
    options?: CopyOptions
  ): Promise<void> {
    await this.#call("copy", {
      destination: this.#path(destination),
      overwrite: options?.overwrite ?? true,
      recursive: options?.recursive ?? false,
      source: this.#path(source),
    });
  }

  async deleteFile(path: string, options?: RemoveOptions): Promise<void> {
    await this.#call("delete", {
      force: options?.force ?? false,
      path: this.#path(path),
    });
  }

  async exists(path: string): Promise<boolean> {
    return Boolean(await this.#call("exists", { path: this.#path(path) }));
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.#call("mkdir", {
      path: this.#path(path),
      recursive: options?.recursive ?? false,
    });
  }

  async moveFile(
    source: string,
    destination: string,
    options?: CopyOptions
  ): Promise<void> {
    await this.#call("move", {
      destination: this.#path(destination),
      overwrite: options?.overwrite ?? true,
      source: this.#path(source),
    });
  }

  async readFile(
    path: string,
    options?: ReadOptions
  ): Promise<string | Buffer> {
    const encoded = String(
      await this.#call("read", { path: this.#path(path) })
    );
    const content = Buffer.from(encoded, "base64");
    return options?.encoding === undefined
      ? content
      : content.toString(options.encoding);
  }

  async readdir(path: string, options?: ListOptions): Promise<FileEntry[]> {
    return asEntries(
      await this.#call("readdir", {
        maxDepth: options?.maxDepth,
        path: this.#path(path),
        recursive: options?.recursive ?? false,
      })
    );
  }

  async rmdir(path: string, options?: RemoveOptions): Promise<void> {
    await this.#call("rmdir", {
      force: options?.force ?? false,
      path: this.#path(path),
      recursive: options?.recursive ?? false,
    });
  }

  async stat(path: string): Promise<FileStat> {
    return asStat(await this.#call("stat", { path: this.#path(path) }));
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteOptions
  ): Promise<void> {
    await this.#call("write", {
      content: encode(content),
      overwrite: options?.overwrite ?? true,
      path: this.#path(path),
      recursive: options?.recursive ?? false,
    });
  }

  #path(path: string): string {
    const target = path.startsWith("/")
      ? posix.normalize(path)
      : posix.resolve(this.#root, path);
    const relative = posix.relative(this.#root, target);
    if (relative === ".." || relative.startsWith("../")) {
      throw new Error("The path escapes the build-session workspace.");
    }
    return target;
  }

  async #call(
    operation: SandboxFileOperation,
    value: Record<string, unknown>
  ): Promise<unknown> {
    if (!this.#sandbox.executeCommand) {
      throw new Error(
        "The build-session sandbox cannot execute filesystem operations."
      );
    }
    const payload = Buffer.from(
      JSON.stringify({ operation, root: this.#root, value })
    ).toString("base64");
    const result = await this.#sandbox.executeCommand(
      "node",
      ["-e", SANDBOX_FILESYSTEM_PROGRAM, payload],
      {
        cwd: this.#root,
      }
    );
    let parsed: SandboxFilesystemResult;
    try {
      parsed = JSON.parse(result.stdout) as SandboxFilesystemResult;
    } catch (cause) {
      throw new Error(
        `Sandbox filesystem operation failed: ${result.stderr || result.stdout}`,
        { cause }
      );
    }
    if (!(result.success && parsed.ok)) {
      const error = new Error(
        parsed.message ||
          result.stderr ||
          "Sandbox filesystem operation failed."
      ) as Error & { code?: string };
      if (parsed.code !== undefined) {
        error.code = parsed.code;
      }
      throw error;
    }
    return parsed.value;
  }
}

function encode(content: FileContent): string {
  return Buffer.from(content).toString("base64");
}

function asEntries(value: unknown): FileEntry[] {
  if (!Array.isArray(value)) {
    throw new Error(
      "Sandbox filesystem returned an invalid directory listing."
    );
  }
  return value as FileEntry[];
}

function asStat(value: unknown): FileStat {
  if (!value || typeof value !== "object") {
    throw new Error("Sandbox filesystem returned invalid file metadata.");
  }
  const stat = value as Omit<FileStat, "createdAt" | "modifiedAt"> & {
    createdAt: string;
    modifiedAt: string;
  };
  return {
    ...stat,
    createdAt: new Date(stat.createdAt),
    modifiedAt: new Date(stat.modifiedAt),
  };
}

const SANDBOX_FILESYSTEM_PROGRAM = `
const fs = require("node:fs");
const path = require("node:path");
const input = JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8"));
const root = path.resolve(input.root);
const fail = (error) => {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }));
};
const respond = (value) => process.stdout.write(JSON.stringify({ ok: true, value }));
const safe = (target, allowMissing = false) => {
  const resolved = path.resolve(target);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw Object.assign(new Error("Path escapes workspace."), { code: "EACCES" });
  let cursor = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw Object.assign(new Error("Symbolic links are not allowed in the workspace."), { code: "ELOOP" });
    } catch (error) {
      if (allowMissing && error && error.code === "ENOENT") break;
      throw error;
    }
  }
  return resolved;
};
try {
  const { operation, value } = input;
  if (operation === "read") respond(fs.readFileSync(safe(value.path)).toString("base64"));
  else if (operation === "write" || operation === "append") {
    const target = safe(value.path, true);
    if (value.recursive) fs.mkdirSync(path.dirname(target), { recursive: true });
    if (operation === "write" && value.overwrite === false && fs.existsSync(target)) throw Object.assign(new Error("File already exists."), { code: "EEXIST" });
    fs[operation === "write" ? "writeFileSync" : "appendFileSync"](target, Buffer.from(value.content, "base64")); respond(null);
  } else if (operation === "exists") respond(fs.existsSync(safe(value.path, true)));
  else if (operation === "mkdir") { fs.mkdirSync(safe(value.path, true), { recursive: value.recursive }); respond(null); }
  else if (operation === "delete") { fs.unlinkSync(safe(value.path)); respond(null); }
  else if (operation === "rmdir") { fs.rmSync(safe(value.path), { force: value.force, recursive: value.recursive }); respond(null); }
  else if (operation === "move") { const source = safe(value.source); const destination = safe(value.destination, true); if (!value.overwrite && fs.existsSync(destination)) throw Object.assign(new Error("File already exists."), { code: "EEXIST" }); fs.renameSync(source, destination); respond(null); }
  else if (operation === "copy") { const source = safe(value.source); const destination = safe(value.destination, true); fs.cpSync(source, destination, { errorOnExist: !value.overwrite, force: value.overwrite, recursive: value.recursive }); respond(null); }
  else if (operation === "stat") { const stat = fs.statSync(safe(value.path)); respond({ name: path.basename(value.path), path: value.path, type: stat.isDirectory() ? "directory" : "file", size: stat.size, createdAt: stat.birthtime.toISOString(), modifiedAt: stat.mtime.toISOString() }); }
  else if (operation === "readdir") { const rootPath = safe(value.path); const entries = fs.readdirSync(rootPath, { withFileTypes: true }).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file", isSymlink: entry.isSymbolicLink() })); respond(entries); }
  else throw new Error("Unsupported sandbox filesystem operation.");
} catch (error) { fail(error); }
`;
