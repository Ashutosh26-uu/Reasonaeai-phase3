/**
 * Helpers shared by the resource protocol handlers.
 *
 * Every handler reports a missing resource the same way: what was asked for, and
 * what actually exists. That consistency is the point. A model that mistypes a
 * skill name learns the real names from the error instead of issuing another
 * guess, which is the difference between one failed read and five.
 */

import { readdir, stat } from "node:fs/promises";
import { isAbsolute, normalize, sep } from "node:path";

import type { InternalResource } from "../types.js";
import { ResourceError } from "../types.js";

/** Content type for a path, by extension. */
export function contentTypeForPath(
  path: string
): InternalResource["contentType"] {
  return path.toLowerCase().endsWith(".md") ? "text/markdown" : "text/plain";
}

/**
 * A directory listing as a resource.
 *
 * Marked immutable, so the read path never mints an edit anchor against a
 * listing. An anchor on a listing would promise an edit that no scheme can
 * honour.
 */
export async function buildDirectoryResource(
  url: string,
  directoryPath: string,
  notes?: readonly string[]
): Promise<InternalResource> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  entries.sort((left, right) => {
    const directoryOrder =
      Number(right.isDirectory()) - Number(left.isDirectory());
    return directoryOrder || left.name.localeCompare(right.name);
  });

  const content =
    entries.length === 0
      ? "(empty directory)"
      : entries
          .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
          .join("\n");

  return {
    content,
    contentType: "text/plain",
    immutable: true,
    size: Buffer.byteLength(content, "utf-8"),
    sourcePath: directoryPath,
    url,
    ...(notes === undefined ? {} : { notes: [...notes] }),
  };
}

/** A text resource from a file on disk. */
export function buildTextResource(
  url: string,
  filePath: string,
  content: string,
  notes?: readonly string[]
): InternalResource {
  return {
    content,
    contentType: contentTypeForPath(filePath),
    size: Buffer.byteLength(content, "utf-8"),
    sourcePath: filePath,
    url,
    ...(notes === undefined || notes.length === 0 ? {} : { notes: [...notes] }),
  };
}

/**
 * Reject a relative path that could escape its root.
 *
 * Two checks, because either alone is insufficient: the textual check catches
 * `..` before any filesystem call, and the caller's resolved-prefix check
 * catches everything else, including a symlink or a platform-specific quirk the
 * textual check does not know about.
 */
export function assertRelativePath(relativePath: string, scheme: string): void {
  if (isAbsolute(relativePath)) {
    throw new ResourceError(
      `Absolute paths are not allowed in ${scheme}:// URLs`,
      "Use a path relative to the resource root."
    );
  }

  const normalized = normalize(relativePath);

  if (
    normalized === ".." ||
    normalized.startsWith(`..${sep}`) ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.includes(`${sep}..${sep}`)
  ) {
    throw new ResourceError(
      `Path traversal (..) is not allowed in ${scheme}:// URLs`,
      "Use a path relative to the resource root."
    );
  }
}

/** Confirm a resolved path stays inside its root, and report the resolved form. */
export function assertWithinRoot(
  resolvedPath: string,
  root: string,
  scheme: string
): void {
  const normalizedRoot = normalize(root);
  const normalizedPath = normalize(resolvedPath);

  if (
    normalizedPath !== normalizedRoot &&
    !normalizedPath.startsWith(normalizedRoot + sep)
  ) {
    throw new ResourceError(
      `Path escapes the ${scheme}:// resource root`,
      "Use a path relative to the resource root."
    );
  }
}

/**
 * The standard "not found" failure, naming what does exist.
 *
 * The available list is sorted so the same missing name always produces the same
 * message, which keeps a failure reproducible across retries.
 */
export function notFound(
  kind: string,
  name: string,
  available: readonly string[],
  hint?: string
): ResourceError {
  const listed =
    available.length === 0
      ? "none"
      : [...available]
          .sort((left, right) => left.localeCompare(right))
          .join(", ");

  return new ResourceError(
    `Unknown ${kind}: ${name}\nAvailable: ${listed}`,
    hint ?? `Read the bare scheme to list ${kind} values.`
  );
}

/** Stat a path, returning `false` when it does not exist. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
