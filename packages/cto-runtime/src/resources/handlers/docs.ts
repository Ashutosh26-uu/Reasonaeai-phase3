/**
 * `docs://` — the repository's own documentation, addressable by name.
 *
 * A software factory's agent has to know the product it is building. The
 * canonical documents already exist on disk, but a path into them is only useful
 * to someone who already knows the layout. This scheme flattens them into one
 * namespace with a listing, so the agent can ask what documentation exists and
 * then read the one it needs, instead of discovering the layout by trial.
 *
 * Roots are configured at construction and each contributes a name prefix, which
 * keeps `.context/SPEC.md` and `docs/SPEC.md` distinct rather than colliding on a
 * bare filename.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  InternalResource,
  ParsedResourceUrl,
  ProtocolHandler,
  ResolveContext,
} from "../types.js";
import { ResourceError } from "../types.js";
import {
  assertRelativePath,
  assertWithinRoot,
  buildTextResource,
  notFound,
  pathExists,
} from "./resource-helpers.js";

/** Largest number of documents enumerated for one listing. */
const DEFAULT_MAX_FILES = 500;

/** Deepest directory nesting the listing walks. */
const DEFAULT_MAX_DEPTH = 6;

const MARKDOWN_EXTENSION_RE = /\.md$/i;
const LEADING_SLASHES_RE = /^\/+/;
const LEADING_SEPARATORS_RE = /^[/\\]+/;

/** A directory of documentation, published under a name prefix. */
export interface DocsRoot {
  /** Absolute directory holding the documents. */
  directory: string;
  /** Name prefix including a trailing slash, for example `context/`. */
  prefix: string;
}

export interface DocsHandlerOptions {
  maxDepth?: number | undefined;
  maxFiles?: number | undefined;
}

export class DocsHandler implements ProtocolHandler {
  readonly scheme = "docs";
  readonly immutable = true;
  readonly description =
    "Documentation that ships with this repository, addressed by name. Read docs:// on its own to list what exists.";

  readonly #roots: readonly DocsRoot[];
  readonly #maxFiles: number;
  readonly #maxDepth: number;

  constructor(roots: readonly DocsRoot[], options: DocsHandlerOptions = {}) {
    this.#roots = roots;
    this.#maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.#maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  }

  async resolve(
    url: ParsedResourceUrl,
    _context: ResolveContext
  ): Promise<InternalResource> {
    // `docs://context/SPEC.md` parses as host `context` plus path `/SPEC.md`.
    const name = `${url.host}${url.pathname}`.replace(LEADING_SLASHES_RE, "");

    if (name === "") {
      return await this.#list(url);
    }

    assertRelativePath(name, "docs");

    // Resolve every plausible root first, then check existence concurrently, so
    // the filesystem is not walked one root at a time.
    const candidates = this.#roots
      .filter((root) => name.startsWith(root.prefix))
      .map((root) => {
        const absolute = resolve(
          root.directory,
          name.slice(root.prefix.length)
        );
        assertWithinRoot(absolute, root.directory, "docs");
        return absolute;
      });

    const resolved = await Promise.all(
      candidates.map(async (absolute) =>
        (await pathExists(absolute)) ? absolute : undefined
      )
    );
    const found = resolved.find((absolute) => absolute !== undefined);

    if (found !== undefined) {
      return buildTextResource(url.raw, found, await readFile(found, "utf-8"));
    }

    const available = await this.#names();

    if (available.length === 0) {
      throw new ResourceError(
        "No documentation is configured for this workspace.",
        "This workspace may not ship documentation."
      );
    }

    throw notFound(
      "documentation file",
      name,
      available,
      "Read docs:// to list every document."
    );
  }

  async #list(url: ParsedResourceUrl): Promise<InternalResource> {
    const names = await this.#names();

    if (names.length === 0) {
      throw new ResourceError(
        "No documentation is configured for this workspace.",
        "This workspace may not ship documentation."
      );
    }

    const listing = names
      .map((name) => `- [${name}](docs://${name})`)
      .join("\n");
    const content = `# Documentation\n\n${names.length} documents available:\n\n${listing}\n`;

    return {
      content,
      contentType: "text/markdown",
      immutable: true,
      size: Buffer.byteLength(content, "utf-8"),
      url: url.raw,
    };
  }

  /** Every document name, prefix-qualified and sorted. */
  async #names(): Promise<string[]> {
    const perRoot = await Promise.all(
      this.#roots.map(async (root) => {
        if (!(await pathExists(root.directory))) {
          return [];
        }
        const out: string[] = [];
        await collectMarkdown(
          root,
          root.directory,
          out,
          this.#maxDepth,
          this.#maxFiles
        );
        return out;
      })
    );

    return perRoot
      .flat()
      .slice(0, this.#maxFiles)
      .sort((left, right) => left.localeCompare(right));
  }
}

/**
 * Walk one documentation root for markdown files.
 *
 * Names are published as `<prefix><relative path>`, so a name is stable
 * regardless of where the root sits on disk. Depth and count are both bounded so
 * a misconfigured root cannot enumerate an entire filesystem into the prompt.
 *
 * Entries are visited concurrently and the result is capped afterwards, which is
 * what keeps this out of an await-per-entry loop without losing the bound.
 */
async function collectMarkdown(
  root: DocsRoot,
  directory: string,
  out: string[],
  maxDepth: number,
  maxFiles: number,
  depth = 0
): Promise<void> {
  if (depth > maxDepth || out.length >= maxFiles) {
    return;
  }

  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    // An unreadable subdirectory is skipped: one bad directory must not prevent
    // the rest of the documentation from being listed.
    return;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));

  const collected = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      if (entry.isDirectory()) {
        const nested: string[] = [];
        await collectMarkdown(
          root,
          resolve(directory, entry.name),
          nested,
          maxDepth,
          maxFiles,
          depth + 1
        );
        return nested;
      }

      if (!(entry.isFile() && MARKDOWN_EXTENSION_RE.test(entry.name))) {
        return [];
      }

      const relativePath = resolve(directory, entry.name)
        .slice(root.directory.length)
        .replace(LEADING_SEPARATORS_RE, "")
        .replaceAll("\\", "/");

      return [`${root.prefix}${relativePath}`];
    })
  );

  for (const names of collected) {
    if (out.length >= maxFiles) {
      return;
    }
    out.push(...names);
  }
}
