import { posix } from "node:path";

import type { FileContent, WorkspaceFilesystem } from "@mastra/core/workspace";
import { Filesystem, NotFoundError, type WriteResult } from "./hashline/fs.js";

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "ENOENT"
  );
}

const AT_PREFIX_RE = /^@\/?/;
const FILE_SCHEME_RE = /^file:\/\//i;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:/;

/**
 * Adapts Mastra's resolved workspace filesystem to the hashline patcher's
 * intentionally small storage contract. No Node filesystem operation is used:
 * every read and mutation remains in the verified workspace namespace.
 */
export class WorkspaceHashlineFilesystem extends Filesystem {
  readonly #filesystem: WorkspaceFilesystem;
  readonly #root: string;

  constructor(input: { filesystem: WorkspaceFilesystem; root?: string }) {
    super();
    this.#filesystem = input.filesystem;
    this.#root = posix.normalize(input.root ?? "/");
  }

  override canonicalPath(path: string): string {
    const trimmed = path
      .trim()
      .replace(AT_PREFIX_RE, "")
      .replace(FILE_SCHEME_RE, "")
      .replaceAll("\\", "/")
      .replace(WINDOWS_DRIVE_RE, "");

    if (trimmed.length === 0 || trimmed.includes("\0")) {
      throw new Error("A non-empty workspace path is required.");
    }
    if (trimmed === "~" || trimmed.startsWith("~/")) {
      throw new Error(
        "Home-directory paths are not available in the workspace."
      );
    }

    let target: string;
    if (
      this.#root === "/" ||
      trimmed === this.#root ||
      trimmed.startsWith(`${this.#root}/`)
    ) {
      target = posix.normalize(
        trimmed.startsWith("/") ? trimmed : posix.resolve(this.#root, trimmed)
      );
    } else if (trimmed.startsWith("/")) {
      target = posix.resolve(this.#root, `.${trimmed}`);
    } else {
      target = posix.resolve(this.#root, trimmed);
    }

    const relative = posix.relative(this.#root, target);

    if (relative === ".." || relative.startsWith("../")) {
      throw new Error("The patch path escapes the verified workspace.");
    }

    return target;
  }

  override async readText(path: string): Promise<string> {
    const target = this.canonicalPath(path);
    try {
      const content = await this.#filesystem.readFile(target, {
        encoding: "utf8",
      });
      return typeof content === "string" ? content : content.toString("utf8");
    } catch (error) {
      if (isMissing(error)) {
        throw new NotFoundError(target, { cause: error });
      }
      throw error;
    }
  }

  override async readBinary(path: string): Promise<Uint8Array | undefined> {
    const target = this.canonicalPath(path);
    try {
      const content = await this.#filesystem.readFile(target);
      return asBytes(content);
    } catch (error) {
      if (isMissing(error)) {
        throw new NotFoundError(target, { cause: error });
      }
      throw error;
    }
  }

  override async writeText(
    path: string,
    content: string
  ): Promise<WriteResult> {
    const target = this.canonicalPath(path);
    await this.#filesystem.writeFile(target, content, { recursive: true });
    return { text: content };
  }

  override async delete(path: string): Promise<void> {
    const target = this.canonicalPath(path);
    try {
      await this.#filesystem.deleteFile(target);
    } catch (error) {
      if (isMissing(error)) {
        throw new NotFoundError(target, { cause: error });
      }
      throw error;
    }
  }

  override async move(
    from: string,
    to: string,
    content?: string
  ): Promise<void> {
    const source = this.canonicalPath(from);
    const target = this.canonicalPath(to);

    if (content !== undefined) {
      await this.writeText(target, content);
      await this.delete(source);
      return;
    }

    try {
      await this.#filesystem.moveFile(source, target);
    } catch (error) {
      if (isMissing(error)) {
        throw new NotFoundError(source, { cause: error });
      }
      throw error;
    }
  }

  override async exists(path: string): Promise<boolean> {
    return await this.#filesystem.exists(this.canonicalPath(path));
  }

  override allowTagPathRecovery(
    _authoredPath: string,
    resolvedPath: string
  ): boolean {
    try {
      this.canonicalPath(resolvedPath);
      return true;
    } catch {
      return false;
    }
  }
}

function asBytes(content: FileContent): Uint8Array {
  if (typeof content === "string") {
    return Buffer.from(content, "utf8");
  }
  return Buffer.from(content);
}
